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

class FakeOpenAIClient {
  baseURL: string;
  constructor(baseURL: string) {
    this.baseURL = baseURL;
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
});
