/**
 * wrap()-triggered automatic, non-blocking pricing warm-up.
 *
 * Covers LagoSDK's private `autoPrimePricingFor`/`extractMistralApiKey`: the
 * customer calls `sdk.wrap(client)` (already part of their normal flow, no
 * new function to remember) and that alone should be enough for the
 * session's FIRST Mistral/Workers AI call to have a real shot at pricing
 * correctly, without ever declaring `LagoConfig.mistralApiKey` separately —
 * the client being wrapped already carries the exact credential needed.
 */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";
import { ModelPrice, PricingProvider, parseMistralAliases } from "../../src/pricing.js";
import { OfflinePricingFetcher } from "../support/offline_pricing.js";

const MISTRAL_ALIASES = parseMistralAliases({
  data: [{ id: "mistral-small-2603", aliases: ["mistral-small-latest"] }],
});
const OPENROUTER = {
  exact: new Map<string, ModelPrice>(),
  norm: new Map<string, ModelPrice>([
    [
      "mistralai\nmistral-small-2603",
      {
        source: "openrouter",
        input: 150_000_000n, // 0.00000015 scaled by 1e12
        output: 600_000_000n, // 0.0000006 scaled by 1e12
        cache_read: null,
        cache_write: null,
        reasoning: null,
      },
    ],
  ]),
};

class FakeMistralClient {
  _options = { apiKey: "" };
  constructor(apiKey: string) {
    this._options.apiKey = apiKey;
  }
}
Object.defineProperty(FakeMistralClient, "name", { value: "Mistral" });

class FakeAnthropicClient {
  baseURL: string;
  apiKey?: string;
  messages = { create: async () => ({ usage: { input_tokens: 1, output_tokens: 1 } }) };
  constructor(baseURL: string, apiKey?: string) {
    this.baseURL = baseURL;
    if (apiKey !== undefined) this.apiKey = apiKey;
  }
}
Object.defineProperty(FakeAnthropicClient, "name", { value: "Anthropic" });

class FakeOpenAIClient {
  baseURL: string;
  // `new OpenAI({ apiKey })` exposes the key as `.apiKey` (verified on 4.104); left
  // undefined here to model a client variant without it.
  apiKey?: string;
  constructor(baseURL: string, apiKey?: string) {
    this.baseURL = baseURL;
    if (apiKey !== undefined) this.apiKey = apiKey;
  }
}
Object.defineProperty(FakeOpenAIClient, "name", { value: "OpenAI" });

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  // sdk.wrap() wakes the REAL background queue loop (see EventQueue.wake()),
  // which races any direct provider.maybeRefresh() call in the test's own
  // context — both are legitimate, concurrent triggers. Poll instead of
  // asserting immediately after one call.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

function sdkWithProvider(provider: PricingProvider): LagoSDK {
  const sdk = new LagoSDK({
    apiKey: "dummy",
    defaultSubscriptionId: "sub_test",
    config: { pricingMode: "price", pricingProvider: provider },
  });
  sdk._setSender(async (_b: LagoEvent[]) => {});
  return sdk;
}

describe("wrap()-triggered auto-prime pricing", () => {
  it("wrap(mistral client) learns the key and primes without a config key", async () => {
    // The whole point: no LagoConfig.mistralApiKey anywhere, and the
    // session's first Mistral lookup still resolves correctly because
    // wrap() learned the key from the client and kicked off the fetch.
    const seenKeys: Array<string | null | undefined> = [];
    class StubFetcher extends OfflinePricingFetcher {
      async fetchMistralAliases(apiKey?: string | null) {
        seenKeys.push(apiKey);
        return MISTRAL_ALIASES;
      }
      async fetchOpenRouter() {
        return OPENROUTER;
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = sdkWithProvider(provider);

    const client = new FakeMistralClient("sk-from-client");
    sdk.wrap(client); // <-- the only thing the customer does

    expect(await waitUntil(() => seenKeys.includes("sk-from-client"))).toBe(true);
    const mp = provider.lookup("mistral", "mistral-small-latest", "native");
    expect(mp).not.toBeNull();
    expect(mp!.input).toBe(150_000_000n);
    await sdk.shutdown(1000);
  });

  it("wrap(openai client pointed at Cloudflare's gateway) primes workers-ai", async () => {
    let cloudflareCalls = 0;
    class StubFetcher extends OfflinePricingFetcher {
      async fetchCloudflareWorkersAi() {
        cloudflareCalls++;
        return new Map<string, ModelPrice>();
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = sdkWithProvider(provider);

    const client = new FakeOpenAIClient("https://gateway.ai.cloudflare.com/v1/acct/gw/compat");
    sdk.wrap(client);

    expect(await waitUntil(() => cloudflareCalls === 1)).toBe(true);
    await sdk.shutdown(1000);
  });

  it("wrap(openai client pointed at real OpenAI) does NOT prime workers-ai", async () => {
    // A generic OpenAI client NOT pointed at Cloudflare must not trigger
    // the Workers AI fetch — only the baseURL signal should do that.
    let cloudflareCalls = 0;
    class StubFetcher extends OfflinePricingFetcher {
      async fetchCloudflareWorkersAi() {
        cloudflareCalls++;
        return new Map<string, ModelPrice>();
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = sdkWithProvider(provider);

    const client = new FakeOpenAIClient("https://api.openai.com/v1");
    sdk.wrap(client);
    await provider.maybeRefresh();

    expect(cloudflareCalls).toBe(0);
    await sdk.shutdown(1000);
  });

  it("auto-prime is a no-op in token mode", async () => {
    // No point flagging anything stale for a customer who never opted
    // into price mode — the credential-gated sources should stay
    // completely untouched.
    let mistralCalls = 0;
    class StubFetcher extends OfflinePricingFetcher {
      async fetchMistralAliases() {
        mistralCalls++;
        return new Map<string, string>();
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = new LagoSDK({
      apiKey: "dummy",
      defaultSubscriptionId: "sub_test",
      config: { pricingProvider: provider }, // tokens (default)
    });
    sdk._setSender(async () => {});

    sdk.wrap(new FakeMistralClient("sk-from-client"));
    await provider.maybeRefresh();

    expect(mistralCalls).toBe(0);
    await sdk.shutdown(1000);
  });
  it("wrap(openai client pointed at Ramp Router) learns the key and primes the catalog", async () => {
    // Router's catalog is account-scoped, so the key the client already carries is the
    // one that unlocks it — no LagoConfig.rampRouterApiKey required.
    const seenKeys: Array<string | null | undefined> = [];
    class StubFetcher extends OfflinePricingFetcher {
      async fetchRampRouter(apiKey?: string | null) {
        seenKeys.push(apiKey);
        return new Map<string, ModelPrice>();
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = sdkWithProvider(provider);

    sdk.wrap(new FakeOpenAIClient("https://api.router.com/v1", "sk-router-abc"));

    expect(await waitUntil(() => seenKeys.includes("sk-router-abc"))).toBe(true);
    expect(seenKeys).toEqual(["sk-router-abc"]);
    await sdk.shutdown(1000);
  });

  it("wrap(openai client pointed at Router) without a readable key still primes", async () => {
    // A client variant with no `.apiKey` degrades to "no key learned": the fetch runs with
    // null (then LagoConfig.rampRouterApiKey, then an empty table and a reported miss)
    // rather than throwing out of wrap().
    const seenKeys: Array<string | null | undefined> = [];
    class StubFetcher extends OfflinePricingFetcher {
      async fetchRampRouter(apiKey?: string | null) {
        seenKeys.push(apiKey);
        return new Map<string, ModelPrice>();
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = sdkWithProvider(provider);

    sdk.wrap(new FakeOpenAIClient("https://api.router.com/v1"));

    expect(await waitUntil(() => seenKeys.length === 1)).toBe(true);
    expect(seenKeys).toEqual([null]);
    await sdk.shutdown(1000);
  });

  it("wrap(openai client pointed at real OpenAI) does NOT prime Router", async () => {
    let routerCalls = 0;
    class StubFetcher extends OfflinePricingFetcher {
      async fetchRampRouter() {
        routerCalls++;
        return new Map<string, ModelPrice>();
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = sdkWithProvider(provider);

    sdk.wrap(new FakeOpenAIClient("https://api.openai.com/v1", "sk-openai"));
    await provider.maybeRefresh();

    expect(routerCalls).toBe(0);
    await sdk.shutdown(1000);
  });
  it("wrap(anthropic client pointed at Router) learns the key and primes the catalog", async () => {
    // Router's second surface. The Anthropic client carries the same Router key, read the
    // same way — one helper, so the two wrappers cannot learn it differently.
    const seenKeys: Array<string | null | undefined> = [];
    class StubFetcher extends OfflinePricingFetcher {
      async fetchRampRouter(apiKey?: string | null) {
        seenKeys.push(apiKey);
        return new Map<string, ModelPrice>();
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = sdkWithProvider(provider);

    sdk.wrap(new FakeAnthropicClient("https://api.router.com", "sk-router-via-anthropic"));

    expect(await waitUntil(() => seenKeys.includes("sk-router-via-anthropic"))).toBe(true);
    await sdk.shutdown(1000);
  });

  it("wrap(anthropic client pointed at Anthropic) does NOT prime Router", async () => {
    let routerCalls = 0;
    class StubFetcher extends OfflinePricingFetcher {
      async fetchRampRouter() {
        routerCalls++;
        return new Map<string, ModelPrice>();
      }
    }
    const fetcher = new StubFetcher();
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = sdkWithProvider(provider);

    sdk.wrap(new FakeAnthropicClient("https://api.anthropic.com", "sk-ant"));
    await provider.maybeRefresh();

    expect(routerCalls).toBe(0);
    await sdk.shutdown(1000);
  });
});
