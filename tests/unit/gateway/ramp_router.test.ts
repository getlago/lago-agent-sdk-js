/** Ramp Router live path — fake client, no live API. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../../src/index.js";
import { extractOpenAINative, RAMP_ROUTER_PROVIDER } from "../../../src/adapters/openai_native.js";
import { providerHintFor } from "../../../src/wrappers/openai.js";
import type { LagoEvent } from "../../../src/lago_client.js";
import { HttpPricingFetcher, ModelPrice, PricingProvider, parseOpenRouter } from "../../../src/pricing.js";

const ROUTER_BASE_URL = "https://api.router.com/v1";

/**
 * A Router response, in the shape its docs specify: "Every request and response uses the
 * OpenAI Responses schema, whichever provider serves it."
 *
 * Hand-built rather than captured, and deliberately so for now: these tests pin the
 * SDK's own decisions — detection, candidate parsing, which field becomes the model —
 * none of which depend on Router's exact numbers. The assertions that need real numbers
 * live with the captured fixtures.
 */
function routerResponse(model: string, usage: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "resp_test",
    object: "response",
    model,
    output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }],
    usage: {
      input_tokens: 11,
      output_tokens: 3,
      total_tokens: 14,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      ...usage,
    },
  };
}

class FakeRouterResponses {
  createCalls = 0;
  lastKwargs: Record<string, unknown> | null = null;
  constructor(private readonly reply: (args: Record<string, unknown>) => unknown) {}
  async create(args: Record<string, unknown>) {
    this.createCalls++;
    expect("lago" in (args || {})).toBe(false); // wrapper must strip lago opts
    this.lastKwargs = { ...args };
    return this.reply(args);
  }
}

class FakeRouterClient {
  responses: FakeRouterResponses;
  constructor(
    public baseURL: string,
    reply: (args: Record<string, unknown>) => unknown,
  ) {
    this.responses = new FakeRouterResponses(reply);
  }
}
// The detector keys on the constructor name; Router is reached with an OpenAI client.
Object.defineProperty(FakeRouterClient, "name", { value: "OpenAI" });

function newSdk(defaultSub = "sub_test", config: Record<string, unknown> = {}) {
  const received: LagoEvent[] = [];
  const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: defaultSub, ...config });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received };
}

/** code -> numeric value, the reduction every wrapper test in this repo uses. */
function byCode(received: LagoEvent[]): Record<string, number> {
  return Object.fromEntries(received.map((e) => [e.code, Number(e.properties.value)]));
}

// ------------------------------------------------------------------
// Detection. `baseURL` is the ONLY signal: Router's model ids are
// account-specific and opaque, and an Anthropic-served response arrives in
// OpenAI's schema, so nothing in the response body distinguishes the two.
// ------------------------------------------------------------------
describe("Ramp Router detection — baseURL is the only signal", () => {
  const cases: Array<[string, string]> = [
    ["https://api.router.com/v1", RAMP_ROUTER_PROVIDER],
    ["https://api.router.com/v1/", RAMP_ROUTER_PROVIDER],
    ["https://API.Router.COM/v1", RAMP_ROUTER_PROVIDER],
    // A regional or staging host under the same domain still bills as Router.
    ["https://api-eu.router.com/v1", RAMP_ROUTER_PROVIDER],
    // Direct providers and other gateways must be untouched.
    ["https://api.openai.com/v1", ""],
    ["https://gateway.ai.cloudflare.com/v1/acct/gw/compat", ""],
  ];
  for (const [baseURL, expected] of cases) {
    it(`${baseURL || "(empty)"} -> ${expected || "(no hint)"}`, () => {
      expect(providerHintFor({ baseURL }), baseURL).toBe(expected);
    });
  }

  it("a lookalike host that merely contains the router path is not Router", () => {
    // The reason detection parses the host instead of calling `url.includes()`: a
    // substring test stamps this unrelated endpoint's traffic as Router-served.
    expect(providerHintFor({ baseURL: "https://evil.example.com/api.router.com/v1" })).toBe("");
    expect(providerHintFor({ baseURL: "https://evilrouter.com/v1" })).toBe("");
  });

  it("a missing, malformed or exotic baseURL never throws out of wrap()", () => {
    expect(providerHintFor({})).toBe("");
    expect(providerHintFor(null)).toBe("");
    expect(providerHintFor(undefined)).toBe("");
    expect(providerHintFor({ baseURL: "/v1" })).toBe("");
    expect(providerHintFor({ baseURL: 42 })).toBe("");
    expect(
      providerHintFor({
        get baseURL() {
          throw new Error("client blew up");
        },
      }),
    ).toBe("");
  });
});

// ------------------------------------------------------------------
// Candidate parsing. Router names a model two ways and both arrive in the
// same response field: an opaque account-specific id, or an explicit
// `provider:provider-model[:service-tier]` candidate.
// ------------------------------------------------------------------
describe("Ramp Router model resolution", () => {
  const extract = (model: string) => extractOpenAINative(routerResponse(model), "", RAMP_ROUTER_PROVIDER);

  it("stamps api and provider as ramp_router, keeping the surface in extras", () => {
    const u = extract("gpt-5.4-nano");
    expect(u.api).toBe(RAMP_ROUTER_PROVIDER);
    // The provider is NOT the vendor that served the call. It cannot be until Router's
    // cache/reasoning overlap semantics are measured — see RAMP_ROUTER_PROVIDER.
    expect(u.provider).toBe(RAMP_ROUTER_PROVIDER);
    expect(u.extras.router_surface).toBe("responses");
  });

  it("leaves an opaque account-specific id exactly as reported", () => {
    // "Valid model IDs are account-specific... Never invent one or reuse a provider's
    // public model name." So there is nothing to parse and nothing to strip.
    const u = extract("my-org-fast-tier-7");
    expect(u.model).toBe("my-org-fast-tier-7");
    expect(u.extras.router_provider).toBeUndefined();
    expect(u.extras.service_tier).toBeUndefined();
  });

  it("splits an explicit candidate into a bare model plus the provider", () => {
    const u = extract("openai:gpt-5.4-mini");
    // Bare, so a Router-served model rolls up in Lago against the same name a direct
    // call to it reports rather than splitting into a second row.
    expect(u.model).toBe("gpt-5.4-mini");
    expect(u.extras.router_provider).toBe("openai");
  });

  it("keeps a Fireworks model's whole path, which contains slashes", () => {
    // The reason the split is on the FIRST colon only. A naive split on every colon
    // would keep "accounts" and lose the rest of the id.
    const u = extract("fireworks:accounts/fireworks/models/kimi-k2p7-code");
    expect(u.model).toBe("accounts/fireworks/models/kimi-k2p7-code");
    expect(u.extras.router_provider).toBe("fireworks");
  });

  it("pulls a pinned service tier out into extras", () => {
    // Billing-relevant on its own: Router's catalog says tiers "may use different rates"
    // than the base ones it publishes, so pricing must be able to see this.
    const u = extract("openai:gpt-5.4-mini:flex");
    expect(u.model).toBe("gpt-5.4-mini");
    expect(u.extras.router_provider).toBe("openai");
    expect(u.extras.service_tier).toBe("flex");
  });

  it.each(["auto", "default", "flex", "priority"])("recognizes the %s tier", (tier) => {
    const u = extract(`openai:gpt-5.4-mini:${tier}`);
    expect(u.extras.service_tier).toBe(tier);
    expect(u.model).toBe("gpt-5.4-mini");
  });

  it("treats an unrecognized trailing segment as part of the model, not a tier", () => {
    // A wrongly-stripped segment silently renames the model and splits it into a second
    // row in Lago. Keeping it is recoverable; renaming is not.
    const u = extract("openai:gpt-5.4-mini:turbo");
    expect(u.model).toBe("gpt-5.4-mini:turbo");
    expect(u.extras.service_tier).toBeUndefined();
  });

  it("does not read a path-shaped prefix as a provider", () => {
    const u = extract("accounts/fireworks/models/foo:bar");
    expect(u.model).toBe("accounts/fireworks/models/foo:bar");
    expect(u.extras.router_provider).toBeUndefined();
  });

  it("bills the served model, not the requested one", () => {
    // Two ways requested and served diverge on Router: a `models` fallback list sends no
    // `model` field at all, and Switchyard routing can serve a different model than the
    // one asked for. The response is the only place the served model appears.
    const u = extractOpenAINative(
      routerResponse("anthropic:claude-haiku-4-5"),
      "openai:gpt-5.4-mini",
      RAMP_ROUTER_PROVIDER,
    );
    expect(u.model).toBe("claude-haiku-4-5");
    expect(u.extras.router_provider).toBe("anthropic");
  });

  it("leaves a non-Router client's provider inference alone", () => {
    const u = extractOpenAINative(routerResponse("gpt-4o-mini-2024-07-18"), "");
    expect(u.provider).toBe("openai");
    expect(u.api).toBe("responses");
    expect(u.extras.router_surface).toBeUndefined();
  });
});

// ------------------------------------------------------------------
// Token mode is the default and must be exact: the counts Router reported,
// no field invented, none derived.
// ------------------------------------------------------------------
describe("Ramp Router — token mode", () => {
  it("a Router-pointed client bills with no code change but baseURL", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () => routerResponse("openai:gpt-5.4-mini")),
    );
    await client.responses.create({ model: "gpt-5.4-mini", input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const map = byCode(received);
    expect(map.llm_input_tokens).toBe(11);
    expect(map.llm_output_tokens).toBe(3);
    expect(received).toHaveLength(2); // input + output only — total_tokens is derived
    expect(received.every((e) => e.properties.model === "gpt-5.4-mini")).toBe(true);
  });

  it("emits the same fields a direct provider call would", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () =>
        routerResponse("anthropic:claude-haiku-4-5", {
          input_tokens: 1200,
          output_tokens: 40,
          total_tokens: 1240,
          input_tokens_details: { cached_tokens: 900 },
          output_tokens_details: { reasoning_tokens: 25 },
        }),
      ),
    );
    await client.responses.create({ model: "x", input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const map = byCode(received);
    // Faithful extraction. Whether cache_read sits inside input is a PRICING question,
    // not an extraction one — token mode reports what Router reported either way.
    expect(map.llm_input_tokens).toBe(1200);
    expect(map.llm_output_tokens).toBe(40);
    expect(map.llm_cached_input_tokens).toBe(900);
    expect(map.llm_reasoning_tokens).toBe(25);
    // Exactly four events. `total_tokens` is derived from the others, so mapping it would
    // double-count — a fifth event here would mean it had been.
    expect(received).toHaveLength(4);
  });

  it("a streamed call bills exactly once, from the terminal event", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, (args) => {
        if (args.stream !== true) return routerResponse("openai:gpt-5.4-mini");
        // Router returns "OpenAI Responses server-sent events", which nest both usage
        // and the resolved model under `.response`.
        const events = [
          { type: "response.created", response: { id: "resp_1", model: "openai:gpt-5.4-mini" } },
          { type: "response.output_text.delta", delta: "po" },
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              model: "openai:gpt-5.4-mini",
              usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
            },
          },
        ];
        return (async function* () {
          for (const e of events) yield e;
        })();
      }),
    );
    const stream = (await client.responses.create({
      model: "gpt-5.4-mini",
      input: "ping",
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    expect(received).toHaveLength(2); // one input + one output, not two of each
    expect(byCode(received).llm_input_tokens).toBe(11);
    // The stream carries the served candidate too, parsed the same way.
    expect(received.every((e) => e.properties.model === "gpt-5.4-mini")).toBe(true);
  });

  it("a `models` fallback request bills the candidate that answered", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () =>
        // Second candidate served it. Billing the requested list would bill the wrong
        // model, and the request carried no `model` field to fall back on anyway.
        routerResponse("fireworks:accounts/fireworks/models/kimi-k2p7-code"),
      ),
    );
    await client.responses.create({
      models: ["openai:gpt-5.4-mini", "fireworks:accounts/fireworks/models/kimi-k2p7-code"],
      input: "ping",
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    expect(received).toHaveLength(2);
    expect(received[0]!.properties.model).toBe("accounts/fireworks/models/kimi-k2p7-code");
  });
});

// ------------------------------------------------------------------
// A failure must never bill, and a malformed payload must never throw on the
// customer's call path.
// ------------------------------------------------------------------
describe("Ramp Router — failures and malformed payloads never bill", () => {
  // Every status Router's errors-and-limits page documents, with its code.
  const errors: Array<[number, string]> = [
    [400, "invalid_request"],
    [401, "invalid_api_key"],
    [401, "api_key_deactivated"],
    [402, "insufficient_credits"],
    [403, "provider_unavailable"],
    [404, "model_not_found"],
    [413, "request_too_large"],
    [429, "rate_limit_exceeded"],
    [500, "internal_error"],
    [501, "not_implemented_error"],
    [502, "provider_request_failed"],
    [502, "all_candidates_failed"],
    [503, "service_unavailable"],
    [504, "provider_request_failed"],
  ];
  for (const [status, code] of errors) {
    it(`${status} ${code} emits nothing`, async () => {
      void code;
      const { sdk, received } = newSdk();
      const client = sdk.wrap(
        new FakeRouterClient(ROUTER_BASE_URL, () => {
          const err = new Error(`router ${status}`) as Error & { status: number };
          err.status = status;
          throw err;
        }),
      );
      await expect(client.responses.create({ model: "x", input: "ping", _code: code })).rejects.toThrow();
      expect(await sdk.flush(2000)).toBe(true);
      await sdk.shutdown(1000);
      expect(received).toHaveLength(0);
    });
  }

  it("a zero-usage response emits nothing rather than a zero-valued event", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () =>
        routerResponse("openai:gpt-5.4-mini", { input_tokens: 0, output_tokens: 0, total_tokens: 0 }),
      ),
    );
    await client.responses.create({ model: "x", input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(0);
  });

  it.each([
    ["a non-JSON body", "<!DOCTYPE html><title>Attention Required! | Cloudflare</title>"],
    ["null", null],
    ["a bare number", 7],
    ["no usage object", { id: "resp_1", model: "openai:gpt-5.4-mini" }],
    ["a null usage object", { id: "resp_1", model: "openai:gpt-5.4-mini", usage: null }],
    ["string token counts", { model: "openai:gpt-5.4-mini", usage: { input_tokens: "nope" } }],
    ["negative token counts", { model: "openai:gpt-5.4-mini", usage: { input_tokens: -5 } }],
    ["a null model", { model: null, usage: { input_tokens: 4, output_tokens: 1 } }],
  ])("degrades to zero rather than throwing on %s", (_label, payload) => {
    // api.router.com sits behind Cloudflare bot management, so a non-2xx can genuinely be
    // an HTML challenge page rather than Router's documented JSON envelope.
    const u = extractOpenAINative(payload, "", RAMP_ROUTER_PROVIDER);
    expect(u.api).toBe(RAMP_ROUTER_PROVIDER);
    expect(u.input).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(u.input)).toBe(true);
  });
});

// ------------------------------------------------------------------
// Price mode. Every Router call currently takes a clean pricing MISS and falls
// back to token events, because no vendor can be assigned to it safely yet.
//
// A real price table is loaded for these tests, and the same model is billed
// both directly and through Router. Without that contrast the tests would pass
// on an empty table, proving nothing: everything misses when nothing is priced.
// ------------------------------------------------------------------
const PRICED_MODEL = "gpt-5.4-mini";
// Built through the real parser from a real-shaped OpenRouter payload, not from a
// hand-written key. Hand-writing one was wrong on the first try — `norm()` rewrites "."
// to "-", so `openai\ngpt-5.4-mini` never matched `openai\ngpt-5-4-mini` — and a test
// whose table silently fails to load proves nothing about a miss.
//
// $0.75/M input and $4.50/M output are Router's own published base rates for this model.
const OPENROUTER_TABLE = parseOpenRouter({
  data: [
    {
      id: `openai/${PRICED_MODEL}`,
      pricing: { prompt: "0.00000075", completion: "0.0000045" },
    },
  ],
});

class StubFetcher extends HttpPricingFetcher {
  async fetchOpenRouter() {
    return OPENROUTER_TABLE;
  }
  async fetchBedrock() {
    return new Map<string, ModelPrice>();
  }
  async fetchCloudflareWorkersAi() {
    return new Map<string, ModelPrice>();
  }
  async fetchMistralAliases() {
    return new Map<string, string>();
  }
}

async function pricedSdk() {
  const received: LagoEvent[] = [];
  const provider = new PricingProvider({ fetcher: new StubFetcher(), ttlMs: 3_600_000 });
  const sdk = new LagoSDK({
    apiKey: "x",
    defaultSubscriptionId: "sub_test",
    config: { pricingMode: "price", pricingProvider: provider },
  });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  // The table has to be warm before the call, or the miss under test is just a cold
  // cache. Poll rather than sleep: prime() runs on the queue's own loop.
  for (let i = 0; i < 200; i++) {
    if (provider.lookup("openai", PRICED_MODEL, "responses") !== null) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { sdk, received, provider };
}

describe("Ramp Router — price mode misses honestly", () => {
  it("the same model DOES price when called directly — the table is real", async () => {
    // The control. If this fails, every "misses" assertion below is vacuous.
    const { sdk, received, provider } = await pricedSdk();
    expect(provider.lookup("openai", PRICED_MODEL, "responses")).not.toBeNull();
    const client = sdk.wrap(
      new FakeRouterClient("https://api.openai.com/v1", () => routerResponse(PRICED_MODEL)),
    );
    await client.responses.create({ model: PRICED_MODEL, input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const codes = received.map((e) => e.code);
    expect(codes).toContain("llm_cost");
    expect(codes).not.toContain("llm_input_tokens");
  });

  it("the identical model through Router misses and falls back to token events", async () => {
    // Same table, same model, same usage — only the base URL differs. The miss is caused
    // by the Router provider vocabulary, which is the decision under test: Router bills
    // $0 for a BYOK-served request and a non-default tier at a rate its catalog says
    // "may differ", so a list-price lookup can be flatly wrong.
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () => routerResponse(`openai:${PRICED_MODEL}`)),
    );
    await client.responses.create({ model: PRICED_MODEL, input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const map = byCode(received);
    expect(map.llm_cost).toBeUndefined();
    // Not a silent drop. The usage is billed, exactly, as tokens.
    expect(map.llm_input_tokens).toBe(11);
    expect(map.llm_output_tokens).toBe(3);
  });

  it("a flex-tier call is never billed at the base rate", async () => {
    // supported-models: "Service tiers, long contexts, caching, and other features may
    // use different rates." Billing flex at the standard rate over-bills.
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () => routerResponse(`openai:${PRICED_MODEL}:flex`)),
    );
    await client.responses.create({ model: "x", input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code)).not.toContain("llm_cost");
  });

  it("a pricing miss never reaches the caller as an exception", async () => {
    const { sdk } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () => routerResponse(`openai:${PRICED_MODEL}`)),
    );
    await expect(client.responses.create({ model: "x", input: "ping" })).resolves.toBeTruthy();
    await sdk.shutdown(1000);
  });
});

// ------------------------------------------------------------------
// The hot path. Billing is enqueue-only, so concurrency must not lose or
// duplicate an event, and detection must not add per-call work.
// ------------------------------------------------------------------
describe("Ramp Router — concurrency", () => {
  it("200 concurrent calls bill exactly 200 input events", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () => routerResponse("openai:gpt-5.4-mini")),
    );
    await Promise.all(
      Array.from({ length: 200 }, () => client.responses.create({ model: "x", input: "ping" })),
    );
    expect(await sdk.flush(5000)).toBe(true);
    await sdk.shutdown(2000);

    const inputs = received.filter((e) => e.code === "llm_input_tokens");
    expect(inputs).toHaveLength(200);
    expect(new Set(received.map((e) => e.transaction_id)).size).toBe(received.length);
  });
});
