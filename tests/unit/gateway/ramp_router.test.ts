/** Ramp Router live path — fake client, no live API. */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../../src/index.js";
import { extractAnthropicNative, RAMP_ROUTER_MESSAGES_API } from "../../../src/adapters/anthropic_native.js";
import { extractOpenAINative, RAMP_ROUTER_PROVIDER } from "../../../src/adapters/openai_native.js";
import { clientPointsAtRampRouter, isRampRouterBaseUrl } from "../../../src/wrappers/ramp_router.js";
import { providerHintFor } from "../../../src/wrappers/openai.js";
import type { LagoEvent } from "../../../src/lago_client.js";
import { PricingUnavailableError } from "../../../src/exceptions.js";
import {
  lookupRampRouter,
  ModelPrice,
  PricingProvider,
  parseOpenRouter,
  parseRampRouter,
  parseScaled,
  TOKEN_BILLED_PROVIDERS,
} from "../../../src/pricing.js";
import { OfflinePricingFetcher } from "../../support/offline_pricing.js";
import { KNOWN_PROVIDERS, OPENAI_SHAPED_APIS, tokenSemantics } from "../../../src/token_semantics.js";

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

// ----------------------------------------------------------------------
// Price mode. A Router call prices against Router's OWN catalog — the rate the
// gateway bills, reconciled exact against a live account's dashboard export —
// never against OpenRouter's listing for the "same" model.
//
// The Router table is built through the real parser from the REAL captured
// catalog, and an OpenRouter table listing the same model at a DIFFERENT rate
// is loaded beside it. Without that contrast a test could pass by pricing from
// the wrong table, and a table that silently failed to load would make every
// assertion below vacuous — so the control test prices the same model directly.
// ----------------------------------------------------------------------
const CATALOG_FIXTURE = path.join(
  __dirname,
  "..",
  "adapters",
  "fixtures",
  "ramp_router",
  "01_real_models_catalog.json",
);
const ROUTER_TABLE = parseRampRouter(JSON.parse(fs.readFileSync(CATALOG_FIXTURE, "utf8"))._body);
const PRICED_MODEL = "gpt-5.4-nano"; // Router's catalog: $0.20/M input, $1.25/M output, $0.02/M cached
const SERVED_MODEL = `${PRICED_MODEL}-2026-03-17`; // what Router actually answers with (fixture 02)
// OpenRouter deliberately lists it at a rate that is NOT Router's, so a cost event priced
// from the wrong table shows up in the numbers, not only in `price_source`.
const OPENROUTER_TABLE = parseOpenRouter({
  data: [{ id: `openai/${PRICED_MODEL}`, pricing: { prompt: "0.000001", completion: "0.000001" } }],
});

class StubFetcher extends OfflinePricingFetcher {
  rampRouterKeys: Array<string | null | undefined> = [];
  constructor(private readonly routerTable: Map<string, ModelPrice> = ROUTER_TABLE) {
    super();
  }
  async fetchOpenRouter() {
    return OPENROUTER_TABLE;
  }
  async fetchRampRouter(apiKey?: string | null) {
    this.rampRouterKeys.push(apiKey);
    return this.routerTable;
  }
}

async function pricedSdk(
  opts: { routerTable?: Map<string, ModelPrice>; onError?: (err: unknown, where: string) => void } = {},
) {
  const received: LagoEvent[] = [];
  const provider = new PricingProvider({ fetcher: new StubFetcher(opts.routerTable), ttlMs: 3_600_000 });
  const sdk = new LagoSDK({
    apiKey: "x",
    defaultSubscriptionId: "sub_test",
    config: {
      pricingMode: "price",
      pricingProvider: provider,
      ...(opts.onError ? { onError: opts.onError } : {}),
    },
  });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  // Both tables have to be warm before the call, or a miss under test is just a cold
  // cache. `maybeRefresh` is the queue loop's own warm-up, awaited directly.
  provider.prime(["ramp_router"]);
  await provider.maybeRefresh();
  return { sdk, received, provider };
}

/** A Router response carrying its top-level `service_tier`, as every captured one does. */
function tiered(model: string, tier: string | null = "default", usage: Record<string, unknown> = {}) {
  const body = routerResponse(model, usage);
  if (tier !== null) body.service_tier = tier;
  return body;
}

function costByType(received: LagoEvent[]): Record<string, LagoEvent> {
  return Object.fromEntries(
    received.filter((e) => e.code === "llm_cost").map((e) => [String(e.properties.token_type), e]),
  );
}

function sumValues(events: Record<string, LagoEvent>): bigint {
  return Object.values(events).reduce((acc, e) => acc + parseScaled(e.properties.value)!, 0n);
}

const LUNA_COLD_WRITE = {
  input_tokens: 4493,
  output_tokens: 5,
  total_tokens: 4498,
  input_tokens_details: { cache_write_tokens: 4490, cached_tokens: 0 },
};
const LUNA_WARM_READ = {
  input_tokens: 4493,
  output_tokens: 5,
  total_tokens: 4498,
  input_tokens_details: { cache_write_tokens: 0, cached_tokens: 4490 },
};

describe("Ramp Router — price mode bills Router's own catalog", () => {
  it("the same model priced directly comes from OpenRouter — the control", async () => {
    // If this fails, every Router assertion below proves nothing about which table won.
    const { sdk, received, provider } = await pricedSdk();
    expect(provider.lookup("openai", PRICED_MODEL, "responses")).not.toBeNull();
    const client = sdk.wrap(
      new FakeRouterClient("https://api.openai.com/v1", () => routerResponse(PRICED_MODEL)),
    );
    await client.responses.create({ model: PRICED_MODEL, input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const costs = costByType(received);
    expect(Object.keys(costs).length).toBeGreaterThan(0);
    for (const e of Object.values(costs)) expect(e.properties.price_source).toBe("openrouter");
    expect(costs.input.properties.unit_price).toBe("0.000001");
    expect(received.map((e) => e.code)).not.toContain("llm_input_tokens");
  });

  it("the identical model through Router prices from Router's own catalog", async () => {
    // Same usage, same model family — only the base URL differs — and the money comes from
    // Router's table: $0.20/M input, not OpenRouter's $1/M.
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(new FakeRouterClient(ROUTER_BASE_URL, () => tiered(SERVED_MODEL)));
    await client.responses.create({ model: PRICED_MODEL, input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const costs = costByType(received);
    expect(Object.keys(costs).sort()).toEqual(["input", "output"]);
    for (const e of Object.values(costs)) {
      expect(e.properties.price_source).toBe("ramp_router");
      expect(e.properties.provider).toBe(RAMP_ROUTER_PROVIDER);
      // Billed under the served snapshot, the same row a direct call to it reports.
      expect(e.properties.model).toBe(SERVED_MODEL);
    }
    expect(costs.input.properties.unit_price).toBe("0.0000002");
    expect(costs.input.properties.value).toBe("0.0000022"); // 11 tokens
    expect(costs.output.properties.value).toBe("0.00000375"); // 3 tokens x $1.25/M
    expect(received.map((e) => e.code)).not.toContain("llm_input_tokens");
  });

  it.each(["flex", "priority", "turbo"])(
    "a %s tier is a named miss, never a multiplied rate",
    async (tier) => {
      // flex measured 0.5x, priority 2.0x, and a tier Router adds later is unknown. None of
      // them bill at the catalog rate, and the SDK applies no factor of its own: token
      // events, plus an onError that says WHICH tier, since the same model priced fine a
      // moment ago. Decided 2026-09-07.
      const errors: Array<[unknown, string]> = [];
      const { sdk, received } = await pricedSdk({ onError: (err, where) => errors.push([err, where]) });
      const client = sdk.wrap(new FakeRouterClient(ROUTER_BASE_URL, () => tiered(SERVED_MODEL, tier)));
      await client.responses.create({ model: "x", input: "ping" });
      expect(await sdk.flush(2000)).toBe(true);
      await sdk.shutdown(1000);

      const map = byCode(received);
      expect(map.llm_cost).toBeUndefined();
      // Not a silent drop. The usage is billed, exactly, as tokens.
      expect(map.llm_input_tokens).toBe(11);
      expect(map.llm_output_tokens).toBe(3);
      const misses = errors.filter(([err]) => err instanceof PricingUnavailableError);
      expect(misses).toHaveLength(1);
      const [err, where] = misses[0] as [PricingUnavailableError, string];
      expect(where).toBe("pricing");
      expect(err.detail).toContain(tier);
      expect(String(err)).toContain(tier);
    },
  );

  it("a Router response reporting no tier bills at the base rate", async () => {
    // Sweep 2026-09-07: Router omitted `service_tier` on six `incomplete` zero-output
    // responses (both surfaces) and billed every one at standard, while flex and priority
    // were always reported explicitly. Absence means standard; only a reported non-base
    // tier is a miss.
    const errors: unknown[] = [];
    const { sdk, received } = await pricedSdk({ onError: (err) => errors.push(err) });
    const client = sdk.wrap(new FakeRouterClient(ROUTER_BASE_URL, () => tiered(SERVED_MODEL, null)));
    await client.responses.create({ model: "x", input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code)).toContain("llm_cost");
    expect(errors.some((e) => e instanceof PricingUnavailableError)).toBe(false);
  });

  it("an OpenAI-served cache write bills at the catalog write rate", async () => {
    // Reconciled against the dashboard on 2026-09-07 (gpt-5.6-luna, default tier): at the
    // published rates 3 x $0.20/M + 4490 x $0.25/M + 5 x $1.20/M = $0.0011291; Router charged
    // exactly 1.1x that, a documented per-model mismatch the SDK does not correct. What this
    // pins is the write arithmetic: the count sits INSIDE input_tokens, so it is moved out
    // before pricing — never billed at the input rate AND the write rate.
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () => tiered("gpt-5.6-luna", "default", LUNA_COLD_WRITE)),
    );
    await client.responses.create({ model: "x", input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const costs = costByType(received);
    expect(Object.keys(costs).sort()).toEqual(["cache_write", "input", "output"]);
    expect(costs.input.properties.unit).toBe("3");
    expect(costs.cache_write.properties.unit).toBe("4490");
    expect(costs.cache_write.properties.unit_price).toBe("0.00000025");
    expect(sumValues(costs)).toBe(parseScaled("0.0011291"));
  });

  it("the warm repeat bills the cached block at the cache-read rate", async () => {
    // Same prompt a second later: 4490 cached at $0.02/M: $0.0000964 at the published rates
    // (Router charged 1.1x that — the documented luna mismatch).
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () => tiered("gpt-5.6-luna", "default", LUNA_WARM_READ)),
    );
    await client.responses.create({ model: "x", input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const costs = costByType(received);
    expect(Object.keys(costs).sort()).toEqual(["cache_read", "input", "output"]);
    expect(costs.cache_read.properties.unit).toBe("4490");
    expect(sumValues(costs)).toBe(parseScaled("0.0000964"));
  });

  it("the cache-write count is mapped for Router and stays in extras for OpenAI", () => {
    // Same wire shape, two measured billing conventions: Router bills the write at its
    // catalog rate (mapped, not drift); OpenAI-native was metered at the plain input rate
    // (unmapped, surfaced in extras — see MAPPED_DETAIL_FIELDS).
    const body = tiered("gpt-5.6-luna", "default", LUNA_COLD_WRITE);
    const viaRouter = extractOpenAINative(body, "", RAMP_ROUTER_PROVIDER);
    expect(viaRouter.cache_write).toBe(4490);
    expect(viaRouter.extras).not.toHaveProperty("input_tokens_details.cache_write_tokens");
    const direct = extractOpenAINative(body);
    expect(direct.cache_write).toBe(0);
    expect(direct.extras["input_tokens_details.cache_write_tokens"]).toBe(4490);
  });

  it("a streamed Router call carries the served tier and prices", async () => {
    // The terminal `response.completed` event carries `service_tier` (fixture 04). The
    // stream wrapper used to forward usage and model only, so every streamed Router call
    // reached price mode tier-less — and a missing tier is a miss.
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterClient(ROUTER_BASE_URL, () => {
        const events = [
          { type: "response.created", response: { model: SERVED_MODEL, service_tier: "default" } },
          { type: "response.output_text.delta", delta: "po" },
          { type: "response.completed", response: tiered(SERVED_MODEL) },
        ];
        return (async function* () {
          for (const e of events) yield e;
        })();
      }),
    );
    const stream = (await client.responses.create({
      model: "x",
      input: "ping",
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const costs = costByType(received);
    expect(Object.keys(costs).sort()).toEqual(["input", "output"]);
    expect(costs.input.properties.price_source).toBe("ramp_router");
  });

  it("a pricing miss never reaches the caller as an exception", async () => {
    const { sdk } = await pricedSdk();
    const client = sdk.wrap(new FakeRouterClient(ROUTER_BASE_URL, () => tiered(SERVED_MODEL, "flex")));
    await expect(client.responses.create({ model: "x", input: "ping" })).resolves.toBeTruthy();
    await sdk.shutdown(1000);
  });

  it("a cold or empty Router table is a reported miss, not a silent token fallback", async () => {
    // Router used to sit in TOKEN_BILLED_PROVIDERS, which swallowed the miss on purpose
    // because nothing could fix it. Now a miss is actionable — no Router key learned, table
    // still cold, catalog missing the model — so it must reach onError like any other.
    expect(TOKEN_BILLED_PROVIDERS.has(RAMP_ROUTER_PROVIDER)).toBe(false);

    const errors: unknown[] = [];
    const { sdk, received } = await pricedSdk({ routerTable: new Map(), onError: (err) => errors.push(err) });
    const client = sdk.wrap(new FakeRouterClient(ROUTER_BASE_URL, () => tiered(SERVED_MODEL)));
    await client.responses.create({ model: "x", input: "ping" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code).sort()).toEqual(["llm_input_tokens", "llm_output_tokens"]);
    const misses = errors.filter((e) => e instanceof PricingUnavailableError) as PricingUnavailableError[];
    expect(misses).toHaveLength(1);
    expect(misses[0].detail).toBeUndefined();
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

// ------------------------------------------------------------------
// The recorded token-convention decision behind "ramp_router", pinned so it
// cannot be reverted silently. The generic roster tests cannot see it: the hint
// comes from the wrapper's HOST arm, not from PROVIDER_BY_BASE_URL_PATH.
// ------------------------------------------------------------------
describe("Ramp Router — recorded billing decisions", () => {
  it("ramp_router's token convention is a recorded measurement: OpenAI-shaped on every axis", () => {
    // Measured live 2026-08-28, on an Anthropic-served model — the case that would
    // diverge if anything did: a warm cache_control call reported the cached block
    // INSIDE input_tokens (06b_real_cache_control_warm.json), and reasoning came back
    // inside output (07_real_reasoning.json). Router normalizes the NUMBERS to OpenAI's
    // convention, not just the schema. The entry lives in OPENAI_SHAPED_APIS because the
    // adapter stamps api="ramp_router" and the surface wins over the vendor.
    expect(KNOWN_PROVIDERS.has(RAMP_ROUTER_PROVIDER)).toBe(true);
    expect(tokenSemantics(RAMP_ROUTER_PROVIDER, RAMP_ROUTER_PROVIDER)).toEqual([true, true, true]);
  });
});

// Router is the only surface in this tree that REASSIGNS `api` mid-extract, so the stamp
// has to land before the totalTokens guard reads it.
describe("Ramp Router — the totals guard reads the stamped api", () => {
  /**
   * A Router payload whose declared total does NOT equal input + output, with both subsets
   * non-zero. No captured fixture has this shape — all ten report total == input + output,
   * streamed included — so this is the only cover the guard's Router branch has.
   */
  const misreporting = (total: number) =>
    routerResponse("gpt-5.4-nano", {
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: total,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens_details: { reasoning_tokens: 30 },
    });

  it("folds the whole remainder, not the remainder minus the subsets", () => {
    // The guard, computeCost and deoverlappedTokenTotal must answer the overlap question
    // identically — the whole reason token_semantics.ts exists. Read before the stamp, the
    // guard sees ("ramp_router", "responses"), which is in no subset set, and so adds
    // cacheRead + reasoning to an accounted sum that already contains them.
    const u = extractOpenAINative(misreporting(1000), "", RAMP_ROUTER_PROVIDER);
    // 1000 - (100 + 50). The cached block sits INSIDE input and reasoning INSIDE output, so
    // neither is accounted twice; folding 740 would lose exactly cacheRead + reasoning.
    expect(u.extras.unaccounted_output_tokens).toBe(850);
    expect(u.output).toBe(50 + 850);
    // Read from before the stamp — moving the block above the guard must not cost this.
    expect(u.extras.router_surface).toBe("responses");
  });

  it("still folds a remainder smaller than its own subsets rather than dropping it", () => {
    // The suppression case, and the one that loses money silently rather than merely
    // under-counting: with the wrong semantics the accounted sum (260) EXCEEDS the declared
    // total, `unaccounted` goes negative, the guard never fires, and 50 generated tokens are
    // dropped with no extras key and no onError report.
    const u = extractOpenAINative(misreporting(200), "", RAMP_ROUTER_PROVIDER);
    expect(u.extras.unaccounted_output_tokens).toBe(50);
    expect(u.output).toBe(100);
  });
});

// ----------------------------------------------------------------------
// The captured responses, run through the adapter. The suites above pin the
// SDK's decisions against a hand-built shape; these pin them against what
// Router actually sent. Skips cleanly when the captures are absent, so a
// missing capture reads as "not covered" rather than as a pass.
// ----------------------------------------------------------------------
const CAPTURES = path.join(__dirname, "..", "adapters", "fixtures", "ramp_router");

/**
 * Every captured 200 that carries usage, buffered or streamed, on ONE surface.
 *
 * Router has two: `/v1/responses` (OpenAI-shaped, fixtures 01-10) and `/v1/messages`
 * (Anthropic-shaped, fixtures 11-15, named `_messages_`). They report `service_tier` in
 * different places and go through different adapters, so a test must say which it means.
 */
function capturedBodies(
  surface: "responses" | "messages" = "responses",
): Array<[string, Record<string, any>]> {
  if (!fs.existsSync(CAPTURES)) return [];
  const out: Array<[string, Record<string, any>]> = [];
  for (const name of fs.readdirSync(CAPTURES).sort()) {
    if (!name.endsWith(".json")) continue;
    if (name.includes("_messages_") !== (surface === "messages")) continue;
    const blob = JSON.parse(fs.readFileSync(path.join(CAPTURES, name), "utf8"));
    let body = blob._body;
    if (!(body && typeof body === "object" && body.usage)) {
      // The streamed capture keeps its payload under `.response` per event; the terminal
      // one is the only one carrying usage, and is what the wrapper bills.
      body = undefined;
      for (const event of blob._events ?? []) {
        const candidate = event?.response;
        if (candidate && typeof candidate === "object" && candidate.usage) body = candidate;
      }
    }
    if (body && typeof body === "object" && body.usage) out.push([name, body]);
  }
  return out;
}

const CAPTURED = capturedBodies();

describe.skipIf(CAPTURED.length === 0)("ramp router captured responses", () => {
  it.each(CAPTURED)("%s reports its served tier", (_name, body) => {
    // The regression this file previously had no way to catch. The tier was read only
    // from a `provider:model:tier` candidate suffix, a shape Router resolves away before
    // answering, so `service_tier` was dropped on 100% of live traffic while the
    // hand-built tests stayed green.
    const u = extractOpenAINative(body, "", RAMP_ROUTER_PROVIDER);
    expect(u.extras.service_tier).toBe(body.service_tier);
  });

  it.each(CAPTURED)("%s bills the bare served snapshot", (_name, body) => {
    // Router answers with a resolved vendor snapshot, never a compound candidate — the
    // reason the suffix parse is a fallback rather than the live path. Billing the model
    // verbatim is what rolls a Router-served call up against the same Lago row a direct
    // call to that model reports.
    const u = extractOpenAINative(body, "", RAMP_ROUTER_PROVIDER);
    expect(u.model).toBe(body.model);
    expect(u.model).not.toContain(":");
    expect(u.provider).toBe(RAMP_ROUTER_PROVIDER);
  });
});

describe.skipIf(CAPTURED.length === 0)("ramp router captured responses resolve in the real catalog", () => {
  it.each(CAPTURED)("%s resolves to exactly one catalog entry", (_name, body) => {
    // The served name is what price mode looks up, and it is never the catalog id: a
    // dated snapshot for OpenAI and Anthropic, the vendor's own path for Fireworks. Every
    // response Router has actually sent must land on a catalog entry.
    const u = extractOpenAINative(body, "", RAMP_ROUTER_PROVIDER);
    expect(lookupRampRouter(ROUTER_TABLE, u.model)).not.toBeNull();
  });
});

// ----------------------------------------------------------------------
// Router's SECOND surface: `POST /v1/messages`, reached with an Anthropic client.
// Same host, same catalog, same key — but Anthropic's schema and Anthropic's
// ADDITIVE convention for every vendor, and the one place an Anthropic-served
// cache WRITE is reported. Detection is the shared host helper; the wrapper
// threads a provider hint into the Anthropic adapter, which stamps a distinct
// `api` so the token semantics cannot be confused with the Responses surface.
// ----------------------------------------------------------------------
/** A Router `/v1/messages` response, in the shape fixture 11 actually carries: Anthropic's
 * schema, `service_tier` INSIDE usage. */
function messagesResponse(model: string, usage: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "pong" }],
    usage: {
      input_tokens: 16,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      service_tier: "standard",
      ...usage,
    },
  };
}

class FakeRouterAnthropicMessages {
  constructor(private readonly reply: (args: Record<string, unknown>) => unknown) {}
  async create(args: Record<string, unknown>) {
    expect("lago" in (args || {})).toBe(false);
    return this.reply(args);
  }
}

class FakeRouterAnthropicClient {
  messages: FakeRouterAnthropicMessages;
  apiKey = "sk-router-from-client";
  constructor(
    public baseURL: string,
    reply: (args: Record<string, unknown>) => unknown,
  ) {
    this.messages = new FakeRouterAnthropicMessages(reply);
  }
}
// The detector keys on the constructor name; Router's Messages surface is reached with an Anthropic client.
Object.defineProperty(FakeRouterAnthropicClient, "name", { value: "Anthropic" });

const ANTHROPIC_ROUTER_BASE_URL = "https://api.router.com";
const HAIKU_SERVED = "claude-haiku-4-5-20251001"; // what Router answers with (fixture 11)

// Fixture 12 / 13, verbatim: a 7,481-token cache_control prefix on claude-haiku-4-5.
const MESSAGES_COLD_WRITE = {
  input_tokens: 15,
  output_tokens: 5,
  cache_creation_input_tokens: 7481,
  cache_creation: { ephemeral_5m_input_tokens: 7481, ephemeral_1h_input_tokens: 0 },
};
const MESSAGES_WARM_READ = { input_tokens: 15, output_tokens: 6, cache_read_input_tokens: 7481 };

describe("Ramp Router — the /v1/messages surface", () => {
  it.each([
    ["https://api.router.com", true],
    ["https://api.router.com/v1", true],
    ["https://api-eu.router.com", true],
    ["https://api.anthropic.com", false],
    ["https://evil.example.com/api.router.com", false],
    ["https://evilrouter.com", false],
    ["/v1", false],
    [null, false],
    [42, false],
  ])("the shared host helper answers %s -> %s for both wrappers", (baseURL, expected) => {
    expect(isRampRouterBaseUrl(baseURL)).toBe(expected);
    expect(clientPointsAtRampRouter({ baseURL })).toBe(expected);
  });

  it("the OpenAI wrapper and the shared helper cannot disagree", () => {
    for (const url of [
      "https://api.router.com/v1",
      "https://api-eu.router.com/v1",
      "https://api.openai.com/v1",
    ]) {
      expect(providerHintFor({ baseURL: url }) === RAMP_ROUTER_PROVIDER).toBe(isRampRouterBaseUrl(url));
    }
  });

  it("an Anthropic client pointed at Router bills as Router on the Messages surface", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(
      new FakeRouterAnthropicClient(ANTHROPIC_ROUTER_BASE_URL, () => messagesResponse(HAIKU_SERVED)),
    );
    await client.messages.create({ model: "claude-haiku-4-5", max_tokens: 16, messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    expect(byCode(received)).toEqual({ llm_input_tokens: 16, llm_output_tokens: 5 });
    for (const e of received) {
      expect(e.properties.provider).toBe(RAMP_ROUTER_PROVIDER);
      expect(e.properties.api).toBe(RAMP_ROUTER_MESSAGES_API);
      expect(e.properties.model).toBe(HAIKU_SERVED);
    }
  });

  it("an Anthropic client pointed at Anthropic is untouched", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(
      new FakeRouterAnthropicClient("https://api.anthropic.com", () => messagesResponse(HAIKU_SERVED)),
    );
    await client.messages.create({ model: "claude-haiku-4-5", max_tokens: 16, messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(new Set(received.map((e) => `${e.properties.provider}/${e.properties.api}`))).toEqual(
      new Set(["anthropic/native"]),
    );
  });

  it("the Messages surface keeps Anthropic's additive convention for every vendor", () => {
    // Measured: haiku `input_tokens: 16` beside `cache_read_input_tokens: 20113` (2026-09-04,
    // reconciled exactly); an xAI model `input_tokens: 65` beside `cache_read_input_tokens:
    // 128` with thinking inside output (2026-09-07). The Responses stamp is in
    // OPENAI_SHAPED_APIS; this one must never be.
    expect(OPENAI_SHAPED_APIS.has(RAMP_ROUTER_MESSAGES_API)).toBe(false);
    expect(tokenSemantics(RAMP_ROUTER_PROVIDER, RAMP_ROUTER_MESSAGES_API)).toEqual([false, false, false]);
    expect(tokenSemantics(RAMP_ROUTER_PROVIDER, RAMP_ROUTER_PROVIDER)).toEqual([true, true, true]);
  });

  it("the adapter stamps Router only when the wrapper says so", () => {
    const body = messagesResponse(HAIKU_SERVED);
    const plain = extractAnthropicNative(body);
    expect([plain.provider, plain.api]).toEqual(["anthropic", "native"]);
    const hinted = extractAnthropicNative(body, "", RAMP_ROUTER_PROVIDER);
    expect([hinted.provider, hinted.api]).toEqual([RAMP_ROUTER_PROVIDER, RAMP_ROUTER_MESSAGES_API]);
    // The tier rides inside usage on this surface and lands in extras with no special code.
    expect(hinted.extras.service_tier).toBe("standard");
  });

  it("an Anthropic cache write on the Messages surface bills at the TTL write rate", async () => {
    // The gap the Responses surface cannot close. Router publishes cache_write_input_5m
    // ($1.25/M on haiku) and the Messages surface reports the written count with its TTL, so
    // the write bills at its own rate: 15 x $1/M + 7481 x $1.25/M + 5 x $5/M = $0.00939125.
    // The lump `cache_write` line is consumed entirely by the split — never billed twice.
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterAnthropicClient(ANTHROPIC_ROUTER_BASE_URL, () =>
        messagesResponse(HAIKU_SERVED, MESSAGES_COLD_WRITE),
      ),
    );
    await client.messages.create({ model: "x", max_tokens: 16, messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const costs = costByType(received);
    expect(Object.keys(costs).sort()).toEqual(["cache_write_5m", "input", "output"]);
    expect(costs.input.properties.unit).toBe("15"); // additive: NOT reduced by the write
    expect(costs.cache_write_5m.properties.unit).toBe("7481");
    expect(costs.cache_write_5m.properties.unit_price).toBe("0.00000125");
    for (const e of Object.values(costs)) expect(e.properties.api).toBe(RAMP_ROUTER_MESSAGES_API);
    expect(sumValues(costs)).toBe(parseScaled("0.00939125"));
  });

  it("the warm repeat on the Messages surface bills the read beside input", async () => {
    // Additive: 15 input tokens stay 15; the 7,481 cached bill at $0.10/M. $0.0007931.
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterAnthropicClient(ANTHROPIC_ROUTER_BASE_URL, () =>
        messagesResponse(HAIKU_SERVED, MESSAGES_WARM_READ),
      ),
    );
    await client.messages.create({ model: "x", max_tokens: 16, messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const costs = costByType(received);
    expect(Object.keys(costs).sort()).toEqual(["cache_read", "input", "output"]);
    expect(costs.input.properties.unit).toBe("15");
    expect(costs.cache_read.properties.unit).toBe("7481");
    expect(sumValues(costs)).toBe(parseScaled("0.0007931"));
  });

  it.each([
    ["standard", true],
    ["default", true],
    ["priority", false],
  ])("the tier gate reads the Messages surface's in-usage tier: %s -> priced %s", async (tier, priced) => {
    const errors: unknown[] = [];
    const { sdk, received } = await pricedSdk({ onError: (err) => errors.push(err) });
    const client = sdk.wrap(
      new FakeRouterAnthropicClient(ANTHROPIC_ROUTER_BASE_URL, () =>
        messagesResponse(HAIKU_SERVED, { service_tier: tier }),
      ),
    );
    await client.messages.create({ model: "x", max_tokens: 16, messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code).includes("llm_cost")).toBe(priced);
    expect(errors.some((e) => e instanceof PricingUnavailableError && String(e).includes(tier))).toBe(
      !priced,
    );
  });

  it("a streamed Messages call carries the tier through the merge and prices", async () => {
    // Fixture 14: `service_tier` sits inside `message_start.message.usage` AND
    // `message_delta.usage`; the wrapper's merge keeps it, so the adapter's drift sweep lands
    // it in extras and the tier gate passes.
    const events = [
      {
        type: "message_start",
        message: {
          model: HAIKU_SERVED,
          usage: { input_tokens: 16, output_tokens: 4, cache_read_input_tokens: 0, service_tier: "standard" },
        },
      },
      { type: "content_block_delta" },
      { type: "message_delta", usage: { output_tokens: 5, service_tier: "standard" } },
    ];
    const { sdk, received } = await pricedSdk();
    const client = sdk.wrap(
      new FakeRouterAnthropicClient(ANTHROPIC_ROUTER_BASE_URL, () =>
        (async function* () {
          for (const e of events) yield e;
        })(),
      ),
    );
    const stream = (await client.messages.create({
      model: "x",
      max_tokens: 16,
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    const costs = costByType(received);
    expect(Object.keys(costs).sort()).toEqual(["input", "output"]);
    expect(costs.input.properties.unit).toBe("16");
    expect(costs.output.properties.unit).toBe("5");
    expect(costs.input.properties.api).toBe(RAMP_ROUTER_MESSAGES_API);
  });
});

const CAPTURED_MESSAGES = capturedBodies("messages");

describe.skipIf(CAPTURED_MESSAGES.length === 0)("ramp router captured /v1/messages responses", () => {
  it.each(CAPTURED_MESSAGES)("%s stamps Router and resolves in the catalog", (_name, body) => {
    const u = extractAnthropicNative(body, "", RAMP_ROUTER_PROVIDER);
    expect([u.provider, u.api]).toEqual([RAMP_ROUTER_PROVIDER, RAMP_ROUTER_MESSAGES_API]);
    expect(u.model).toBe(body.model);
    // The tier is INSIDE usage on this surface — the OpenAI-served model included.
    expect(u.extras.service_tier).toBe(body.usage.service_tier);
    expect(lookupRampRouter(ROUTER_TABLE, u.model)).not.toBeNull();
    // Additive: the lump write equals the TTL split (Anthropic's contract, every capture).
    expect(u.cache_write).toBe(u.cache_write_5m + u.cache_write_1h);
  });
});
