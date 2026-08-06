/** Pricing — matching, money math, provider cache, and SDK price mode. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { LagoSDK, makeCanonicalUsage } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";
import {
  bedrockModelKey,
  coerceMarkup,
  computeCost,
  HttpPricingFetcher,
  lookupBedrock,
  lookupCloudflareWorkersAi,
  lookupOpenRouter,
  type ModelPrice,
  type OpenRouterTable,
  parseBedrockOffer,
  parseBedrockRegion,
  parseCloudflareWorkersAi,
  parseMistralAliases,
  parseOpenRouter,
  parseScaled,
  PricingProvider,
} from "../../src/pricing.js";

const GOLDEN = JSON.parse(
  readFileSync(new URL("./fixtures/pricing/money_golden.json", import.meta.url), "utf8"),
) as { cases: Array<Record<string, any>> };

// ---------- stub fetcher (no network) ----------
class StubFetcher {
  openrouterCalls = 0;
  bedrockCalls: string[] = [];
  cloudflareWorkersAiCalls = 0;
  mistralAliasesCalls = 0;
  lastMistralApiKey: string | null | undefined = undefined;
  constructor(
    private openrouter: OpenRouterTable = { exact: new Map(), norm: new Map() },
    private bedrock: Map<string, Map<string, ModelPrice>> = new Map(),
    private cloudflareWorkersAi: Map<string, ModelPrice> = new Map(),
    private mistralAliases: Map<string, string> = new Map(),
  ) {}
  async fetchOpenRouter(): Promise<OpenRouterTable> {
    this.openrouterCalls++;
    return this.openrouter;
  }
  async fetchBedrock(region: string): Promise<Map<string, ModelPrice>> {
    this.bedrockCalls.push(region);
    return this.bedrock.get(region) ?? new Map();
  }
  async fetchCloudflareWorkersAi(): Promise<Map<string, ModelPrice>> {
    this.cloudflareWorkersAiCalls++;
    return this.cloudflareWorkersAi;
  }
  async fetchMistralAliases(apiKey?: string | null): Promise<Map<string, string>> {
    this.mistralAliasesCalls++;
    this.lastMistralApiKey = apiKey;
    return this.mistralAliases;
  }
}

// Real data, captured live from /accounts/{id}/ai/models/search — this
// exact shape (including the non-token unit types and the no-price model)
// is what's actually in the catalog, not a synthetic guess at its structure.
const CLOUDFLARE_MODELS_RAW = [
  {
    name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    properties: [
      { property_id: "context_window", value: "24000" },
      {
        property_id: "price",
        value: [
          { unit: "per M input tokens", price: 0.293, currency: "USD" },
          { unit: "per M output tokens", price: 2.253, currency: "USD" },
        ],
      },
    ],
  },
  {
    name: "@cf/moonshotai/kimi-k2.7-code",
    properties: [
      {
        property_id: "price",
        value: [
          { unit: "per M input tokens", price: 0.95, currency: "USD" },
          { unit: "per M output tokens", price: 4, currency: "USD" },
          { unit: "per M cached input tokens", price: 0.19, currency: "USD" },
        ],
      },
    ],
  },
  {
    // Real non-token-priced model — must be skipped entirely, not stored
    // with a bogus/zero token price.
    name: "@cf/pipecat-ai/smart-turn-v2",
    properties: [
      { property_id: "price", value: [{ unit: "per audio minute", price: 0.000338, currency: "USD" }] },
    ],
  },
  {
    // Real case: some models have no `price` property at all.
    name: "@cf/some/unpriced-model",
    properties: [{ property_id: "context_window", value: "8192" }],
  },
];

// Real data, captured live from Mistral's own /v1/models — "mistral-small-2603"
// is the dated snapshot that actually answers; "mistral-small-latest" (what a
// customer requests) is one of several aliases pointing at it.
const MISTRAL_MODELS_RAW = {
  data: [
    {
      id: "mistral-small-2603",
      aliases: ["mistral-small-latest", "mistral-vibe-cli-fast", "magistral-small-latest"],
    },
    { id: "mistral-large-2411", aliases: ["mistral-large-latest"] },
    { id: "codestral-2508", aliases: [] },
  ],
};

// Real data, captured live — the messy shape that actually broke this
// feature in production. Mistral's real /v1/models does NOT have one clean
// canonical entry with pure aliases: "mistral-small-2603",
// "mistral-small-latest", AND "magistral-small-latest" each appear as their
// OWN top-level `id`, each listing the other two as `aliases`. A naive "map
// each alias -> this entry's id" parser resolves "mistral-small-latest" to
// whichever of these three entries happens to be processed last — here,
// "magistral-small-latest" — instead of the real dated snapshot OpenRouter
// lists.
const MISTRAL_MODELS_RAW_MUTUAL_ALIASING = {
  data: [
    {
      id: "mistral-small-2603",
      aliases: ["mistral-small-latest", "mistral-vibe-cli-fast", "magistral-small-latest"],
    },
    {
      id: "mistral-small-latest",
      aliases: ["mistral-small-2603", "mistral-vibe-cli-fast", "magistral-small-latest"],
    },
    { id: "mistral-vibe-cli-fast", aliases: ["mistral-small-2603"] },
    {
      id: "magistral-small-latest",
      aliases: ["mistral-small-2603", "mistral-small-latest", "mistral-vibe-cli-fast"],
    },
    { id: "voxtral-small-2507", aliases: ["voxtral-small-latest"] },
    { id: "voxtral-small-latest", aliases: ["voxtral-small-2507"] },
  ],
};

const OPENROUTER_RAW = {
  data: [
    {
      id: "anthropic/claude-opus-4.8",
      pricing: {
        prompt: "0.000005",
        completion: "0.000025",
        input_cache_read: "0.0000005",
        input_cache_write: "0.00000625",
        internal_reasoning: "0.000025",
      },
    },
    {
      id: "openai/gpt-4o",
      pricing: {
        prompt: "0.0000025",
        completion: "0.00001",
        input_cache_read: "0.00000125",
        internal_reasoning: "0.00001",
      },
    },
    { id: "mistralai/mistral-large", pricing: { prompt: "0.000002", completion: "0.000006" } },
    // Real case: OpenRouter lists the dated snapshot, never the "-latest"
    // alias a customer actually requests.
    {
      id: "mistralai/mistral-small-2603",
      pricing: {
        prompt: "0.00000015",
        completion: "0.0000006",
        input_cache_read: "0.000000015",
      },
    },
    {
      id: "google/gemini-2.5-flash",
      pricing: {
        prompt: "0.0000003",
        completion: "0.0000025",
        input_cache_read: "0.000000075",
        internal_reasoning: "0.0000025",
      },
    },
  ],
};

function modelPrice(prices: Record<string, string>): ModelPrice {
  return {
    source: "openrouter",
    input: prices.input !== undefined ? parseScaled(prices.input) : null,
    output: prices.output !== undefined ? parseScaled(prices.output) : null,
    cache_read: prices.cache_read !== undefined ? parseScaled(prices.cache_read) : null,
    cache_write: prices.cache_write !== undefined ? parseScaled(prices.cache_write) : null,
    reasoning: prices.reasoning !== undefined ? parseScaled(prices.reasoning) : null,
  };
}

function awsProduct(model: string, inferenceType: string, usd: string, unit = "1K tokens") {
  const sku = `${model}:${inferenceType}`.replace(/\s/g, "");
  return {
    product: {
      [sku]: {
        attributes: {
          model,
          usagetype: `USE1-${model.replace(/\s/g, "")}-${inferenceType.replace(/\s/g, "-")}`,
          inferenceType,
          feature: "On-demand Inference",
        },
      },
    },
    term: { [sku]: { off: { priceDimensions: { d: { pricePerUnit: { USD: usd }, unit } } } } },
  };
}

// ---------- OpenRouter matching ----------
describe("OpenRouter matching", () => {
  it("exact + normalized (. <-> -) match, vendor-gated", () => {
    const t = parseOpenRouter(OPENROUTER_RAW);
    const mp = lookupOpenRouter(t, "anthropic", "claude-opus-4-8");
    expect(mp).not.toBeNull();
    expect(mp!.input).toBe(parseScaled("0.000005"));
    expect(mp!.cache_read).toBe(parseScaled("0.0000005"));
    expect(mp!.source).toBe("openrouter");
  });

  it("vendor map: mistral -> mistralai, gemini -> google", () => {
    const t = parseOpenRouter(OPENROUTER_RAW);
    expect(lookupOpenRouter(t, "mistral", "mistral-large")).not.toBeNull();
    expect(lookupOpenRouter(t, "gemini", "gemini-2.5-flash")).not.toBeNull();
  });

  it("strips date/version suffix", () => {
    const t = parseOpenRouter({
      data: [{ id: "anthropic/claude-haiku-4.5", pricing: { prompt: "0.000001" } }],
    });
    expect(lookupOpenRouter(t, "anthropic", "claude-haiku-4-5-20251001")).not.toBeNull();
  });

  it("miss returns null (incl. wrong vendor)", () => {
    const t = parseOpenRouter(OPENROUTER_RAW);
    expect(lookupOpenRouter(t, "anthropic", "totally-made-up")).toBeNull();
    expect(lookupOpenRouter(t, "openai", "claude-opus-4-8")).toBeNull();
  });
});

// ---------- Bedrock ----------
describe("Bedrock matching", () => {
  it.each([
    ["eu.anthropic.claude-sonnet-4-6", "eu-west-1"],
    ["us.anthropic.claude-sonnet-4-6", "us-east-1"],
    ["apac.anthropic.claude-sonnet-4-6", "ap-southeast-1"],
    ["anthropic.claude-haiku-4-5-20251001-v1:0", "us-east-1"],
  ])("region of %s -> %s", (model, expected) => {
    expect(parseBedrockRegion(model, "us-east-1")).toBe(expected);
  });

  it.each([
    ["eu.anthropic.claude-sonnet-4-6", "claudesonnet46"],
    ["anthropic.claude-haiku-4-5-20251001-v1:0", "claudehaiku45"],
    ["mistral.mixtral-8x7b-instruct-v0:1", "mixtral8x7binstruct"],
  ])("key of %s -> %s", (model, key) => {
    expect(bedrockModelKey(model)).toBe(key);
  });

  it("parses input+output via inferenceType, scales per-1K", () => {
    const i = awsProduct("Claude Sonnet 4.6", "Input tokens", "0.003");
    const o = awsProduct("Claude Sonnet 4.6", "Output tokens", "0.015");
    const offer = {
      products: { ...i.product, ...o.product },
      terms: { OnDemand: { ...i.term, ...o.term } },
    };
    const table = parseBedrockOffer(offer, "us-east-1");
    const mp = lookupBedrock(table, "us.anthropic.claude-sonnet-4-6");
    expect(mp).not.toBeNull();
    expect(mp!.input).toBe(parseScaled("0.000003")); // 0.003/1K
    expect(mp!.output).toBe(parseScaled("0.000015"));
    expect(mp!.source).toBe("aws_bedrock");
  });

  it("rejects priority/flex tier variants, keeps standard", () => {
    const std = awsProduct("Claude Sonnet 4.6", "Input tokens", "0.003");
    const pri = awsProduct("Claude Sonnet 4.6", "Input tokens priority", "0.006");
    const flex = awsProduct("Claude Sonnet 4.6", "Input tokens flex", "0.0015");
    const offer = {
      products: { ...std.product, ...pri.product, ...flex.product },
      terms: { OnDemand: { ...std.term, ...pri.term, ...flex.term } },
    };
    const table = parseBedrockOffer(offer, "us-east-1");
    const mp = lookupBedrock(table, "anthropic.claude-sonnet-4-6");
    expect(mp!.input).toBe(parseScaled("0.000003"));
  });
});

// ---------- Cloudflare Workers AI parsing + matching ----------
describe("Cloudflare Workers AI matching", () => {
  it("parses the real price shape", () => {
    const table = parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW);
    const mp = lookupCloudflareWorkersAi(table, "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(mp).not.toBeNull();
    expect(mp!.source).toBe("cloudflare_workers_ai");
    // $0.293/M input -> $0.000000293/token; $2.253/M output -> $0.000002253/token
    expect(mp!.input).toBe(parseScaled("0.000000293"));
    expect(mp!.output).toBe(parseScaled("0.000002253"));
    expect(mp!.cache_read).toBeNull(); // this model has no cached-input price
  });

  it("maps cached input tokens to cache_read", () => {
    const table = parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW);
    const mp = lookupCloudflareWorkersAi(table, "@cf/moonshotai/kimi-k2.7-code");
    expect(mp).not.toBeNull();
    expect(mp!.input).toBe(parseScaled("0.00000095"));
    expect(mp!.output).toBe(parseScaled("0.000004"));
    expect(mp!.cache_read).toBe(parseScaled("0.00000019"));
  });

  it("skips a real model priced only in a non-token unit (per audio minute)", () => {
    const table = parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW);
    expect(table.has("@cf/pipecat-ai/smart-turn-v2")).toBe(false);
  });

  it("skips a model with no price property at all", () => {
    const table = parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW);
    expect(table.has("@cf/some/unpriced-model")).toBe(false);
  });

  it("lookup miss returns null", () => {
    const table = parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW);
    expect(lookupCloudflareWorkersAi(table, "@cf/totally/made-up-model")).toBeNull();
  });

  it("version-suffix fallback — real drift observed live", () => {
    // A live response naming a model with a trailing "-v2" the catalog
    // itself doesn't have listed separately.
    const table = parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW);
    const mp = lookupCloudflareWorkersAi(table, "@cf/meta/llama-3.3-70b-instruct-fp8-fast-v2");
    expect(mp).not.toBeNull();
    expect(mp!.input).toBe(parseScaled("0.000000293"));
  });

  it("fetcher returns empty without credentials — never makes a request", async () => {
    const fetcher = new HttpPricingFetcher();
    expect((await fetcher.fetchCloudflareWorkersAi()).size).toBe(0);
  });
});

// ---------- Mistral alias resolution ----------
describe("Mistral alias resolution", () => {
  it("parses the real alias shape", () => {
    const aliases = parseMistralAliases(MISTRAL_MODELS_RAW);
    expect(aliases.get("mistral-small-latest")).toBe("mistral-small-2603");
    expect(aliases.get("mistral-vibe-cli-fast")).toBe("mistral-small-2603");
    expect(aliases.get("magistral-small-latest")).toBe("mistral-small-2603");
    expect(aliases.get("mistral-large-latest")).toBe("mistral-large-2411");
  });

  it("a model with no aliases contributes nothing", () => {
    const aliases = parseMistralAliases(MISTRAL_MODELS_RAW);
    expect(aliases.has("codestral-2508")).toBe(false); // it's an id, never requested as an alias
  });

  it("the resolved id isn't a dead end — OpenRouter lists it", () => {
    const aliases = parseMistralAliases(MISTRAL_MODELS_RAW);
    const table = parseOpenRouter(OPENROUTER_RAW);
    const resolved = aliases.get("mistral-small-latest")!;
    const mp = lookupOpenRouter(table, "mistral", resolved);
    expect(mp).not.toBeNull();
    expect(mp!.input).toBe(parseScaled("0.00000015"));
    expect(mp!.output).toBe(parseScaled("0.0000006"));
    expect(mp!.cache_read).toBe(parseScaled("0.000000015"));
  });

  it("fetcher returns empty without credentials — never makes a request", async () => {
    const fetcher = new HttpPricingFetcher();
    expect((await fetcher.fetchMistralAliases()).size).toBe(0);
  });

  it("mutual aliasing resolves to the dated snapshot, not another alias", () => {
    // Real bug, found live: naively mapping "each alias -> this entry's id"
    // is order-dependent when Mistral lists a "-latest" moniker as its OWN
    // top-level `id` too (it does, for every alias in this real shape) — it
    // resolved "mistral-small-latest" to "magistral-small-latest"
    // (whichever entry got processed last), not "mistral-small-2603".
    // OpenRouter lists the dated snapshot, never the sibling alias, so that
    // resolution was a dead end in production. Every one of the 4
    // mutually-aliasing names must land on the single dated snapshot,
    // regardless of which entry mentions which or what order they're
    // processed in.
    const aliases = parseMistralAliases(MISTRAL_MODELS_RAW_MUTUAL_ALIASING);
    expect(aliases.get("mistral-small-latest")).toBe("mistral-small-2603");
    expect(aliases.get("mistral-vibe-cli-fast")).toBe("mistral-small-2603");
    expect(aliases.get("magistral-small-latest")).toBe("mistral-small-2603");
    // The canonical name itself is never a key — nothing should "resolve" it
    // to something else.
    expect(aliases.has("mistral-small-2603")).toBe(false);
  });

  it("mutual aliasing gives the same result regardless of input order", () => {
    // The result must not depend on which entry the source API happens to
    // list first — that's exactly the bug this replaced (last-write-wins).
    const reversed = { data: [...MISTRAL_MODELS_RAW_MUTUAL_ALIASING.data].reverse() };
    const aliases = parseMistralAliases(reversed);
    expect(aliases.get("mistral-small-latest")).toBe("mistral-small-2603");
    expect(aliases.get("magistral-small-latest")).toBe("mistral-small-2603");
  });

  it("the simplest two-way mutual case also converges on the dated one", () => {
    const aliases = parseMistralAliases(MISTRAL_MODELS_RAW_MUTUAL_ALIASING);
    expect(aliases.get("voxtral-small-latest")).toBe("voxtral-small-2507");
    expect(aliases.has("voxtral-small-2507")).toBe(false);
  });
});

// ---------- money + golden parity ----------
describe("computeCost / money", () => {
  it("excludes unpriced fields", () => {
    const price = modelPrice({ input: "0.000003", output: "0.000015" });
    const usage = makeCanonicalUsage({ input: 1000, output: 500, tool_calls: 3, image_input: 50 });
    const b = computeCost(usage, price, parseScaled("1")!);
    expect(Object.keys(b.fields).sort()).toEqual(["input", "output"]);
    expect(b.base).toBe("0.0105");
    expect(b.total).toBe("0.0105");
  });

  it("only-unpriced-fields yields zero", () => {
    const price = modelPrice({ input: "0.000003" });
    const usage = makeCanonicalUsage({ tool_calls: 5 });
    expect(computeCost(usage, price, parseScaled("1")!).total).toBe("0");
  });

  it("matches the cross-repo golden fixtures", () => {
    for (const c of GOLDEN.cases) {
      const price = modelPrice(c.prices);
      const usage = makeCanonicalUsage(c.counts);
      const b = computeCost(usage, price, parseScaled(c.markup)!);
      expect(b.base, `${c.name}: base`).toBe(c.base);
      expect(b.total, `${c.name}: total`).toBe(c.total);
      expect(b.totalCents, `${c.name}: cents`).toBe(c.total_cents);
    }
  });

  it("coerceMarkup falls back to 1.0 on invalid/non-positive", () => {
    expect(coerceMarkup("2")).toEqual([parseScaled("2"), true]);
    expect(coerceMarkup(0)).toEqual([parseScaled("1"), false]);
    expect(coerceMarkup(-1)).toEqual([parseScaled("1"), false]);
    expect(coerceMarkup("nope")).toEqual([parseScaled("1"), false]);
  });
});

// ---------- PricingProvider ----------
describe("PricingProvider", () => {
  it("cold lookup returns null + flags stale; refresh warms it", async () => {
    const fetcher = new StubFetcher(parseOpenRouter(OPENROUTER_RAW));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    expect(p.lookup("anthropic", "claude-opus-4-8", "native")).toBeNull();
    expect(fetcher.openrouterCalls).toBe(0);
    await p.maybeRefresh();
    expect(fetcher.openrouterCalls).toBe(1);
    expect(p.lookup("anthropic", "claude-opus-4-8", "native")).not.toBeNull();
  });

  it("token mode does no fetch (nothing flagged stale)", async () => {
    const fetcher = new StubFetcher(parseOpenRouter(OPENROUTER_RAW));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    await p.maybeRefresh();
    expect(fetcher.openrouterCalls).toBe(0);
  });

  it("routes bedrock api to the right region", async () => {
    const i = awsProduct("Claude Sonnet 4.6", "Input tokens", "0.003");
    const table = parseBedrockOffer({ products: i.product, terms: { OnDemand: i.term } }, "eu-west-1");
    const fetcher = new StubFetcher(undefined, new Map([["eu-west-1", table]]));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000, defaultRegion: "us-east-1" });
    expect(p.lookup("anthropic", "eu.anthropic.claude-sonnet-4-6", "bedrock_converse")).toBeNull();
    await p.maybeRefresh();
    expect(fetcher.bedrockCalls).toEqual(["eu-west-1"]);
    expect(p.lookup("anthropic", "eu.anthropic.claude-sonnet-4-6", "bedrock_converse")).not.toBeNull();
  });

  it("Cloudflare Workers AI: cold miss then warm resolves", async () => {
    const cfTable = parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW);
    const fetcher = new StubFetcher(undefined, undefined, cfTable);
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    expect(
      p.lookup("workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "cloudflare_gateway"),
    ).toBeNull();
    expect(fetcher.cloudflareWorkersAiCalls).toBe(0);
    await p.maybeRefresh();
    expect(fetcher.cloudflareWorkersAiCalls).toBe(1);
    const mp = p.lookup("workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "cloudflare_gateway");
    expect(mp).not.toBeNull();
    expect(mp!.input).toBe(parseScaled("0.000000293"));
  });

  it("Cloudflare Workers AI is only fetched for the workers-ai provider", async () => {
    const fetcher = new StubFetcher(parseOpenRouter(OPENROUTER_RAW));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    p.lookup("anthropic", "claude-opus-4-8", "native");
    await p.maybeRefresh();
    expect(fetcher.cloudflareWorkersAiCalls).toBe(0);
  });

  it("Mistral alias: cold miss then warm resolves", async () => {
    const fetcher = new StubFetcher(
      parseOpenRouter(OPENROUTER_RAW),
      undefined,
      undefined,
      parseMistralAliases(MISTRAL_MODELS_RAW),
    );
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    // cold: openrouter table is ALSO cold here, exercising both misses at
    // once — the important thing is a clean null, not an exception.
    expect(p.lookup("mistral", "mistral-small-latest", "native")).toBeNull();
    await p.maybeRefresh();
    expect(fetcher.mistralAliasesCalls).toBe(1);
    expect(fetcher.openrouterCalls).toBe(1);
    const mp = p.lookup("mistral", "mistral-small-latest", "native");
    expect(mp).not.toBeNull();
    expect(mp!.input).toBe(parseScaled("0.00000015"));
    expect(mp!.output).toBe(parseScaled("0.0000006"));
  });

  it("Mistral alias is only fetched for the mistral provider", async () => {
    const fetcher = new StubFetcher(parseOpenRouter(OPENROUTER_RAW));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    p.lookup("anthropic", "claude-opus-4-8", "native");
    await p.maybeRefresh();
    expect(fetcher.mistralAliasesCalls).toBe(0);
    expect(fetcher.openrouterCalls).toBe(1);
  });

  it("prime() only eagerly warms OpenRouter, not Cloudflare or Mistral", async () => {
    const fetcher = new StubFetcher(
      parseOpenRouter(OPENROUTER_RAW),
      undefined,
      parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW),
      parseMistralAliases(MISTRAL_MODELS_RAW),
    );
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    p.prime();
    await p.maybeRefresh();
    expect(fetcher.openrouterCalls).toBe(1);
    expect(fetcher.cloudflareWorkersAiCalls).toBe(0);
    expect(fetcher.mistralAliasesCalls).toBe(0);
    // Confirms it's not just "hasn't fetched yet" — a real lookup for
    // either provider afterward still works, fetching lazily on its own trigger.
    expect(
      p.lookup("workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "cloudflare_gateway"),
    ).toBeNull();
    await p.maybeRefresh();
    expect(fetcher.cloudflareWorkersAiCalls).toBe(1);
    expect(
      p.lookup("workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "cloudflare_gateway"),
    ).not.toBeNull();
  });

  it("prime(providers) eagerly warms the named ones too", async () => {
    // Opt-in escape hatch: a caller who already knows they're about to
    // call Mistral and/or Workers AI this session can say so up front and
    // skip the one-time lazy cold-start cost for THAT provider's first
    // call too — without going back to unconditionally warming both for
    // every customer.
    const fetcher = new StubFetcher(
      parseOpenRouter(OPENROUTER_RAW),
      undefined,
      parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW),
      parseMistralAliases(MISTRAL_MODELS_RAW),
    );
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    p.prime(["mistral", "workers-ai"]);
    await p.maybeRefresh();
    expect(fetcher.openrouterCalls).toBe(1);
    expect(fetcher.cloudflareWorkersAiCalls).toBe(1);
    expect(fetcher.mistralAliasesCalls).toBe(1);
    // Both now resolve correctly on their very first real lookup — no cold miss.
    expect(p.lookup("mistral", "mistral-small-latest", "native")).not.toBeNull();
    expect(
      p.lookup("workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "cloudflare_gateway"),
    ).not.toBeNull();
  });

  it("prime() with an unknown provider name is ignored, not an error", async () => {
    const fetcher = new StubFetcher(parseOpenRouter(OPENROUTER_RAW));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    p.prime(["totally-made-up-provider"]);
    await p.maybeRefresh();
    expect(fetcher.openrouterCalls).toBe(1);
    expect(fetcher.cloudflareWorkersAiCalls).toBe(0);
    expect(fetcher.mistralAliasesCalls).toBe(0);
  });

  it("learnMistralApiKey is used on the next fetch", async () => {
    // No LagoConfig.mistralApiKey was ever configured — the key is learned
    // instead (e.g. from a wrapped client) and still reaches the fetcher on
    // the next refresh.
    const fetcher = new StubFetcher(undefined, undefined, undefined, parseMistralAliases(MISTRAL_MODELS_RAW));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    p.learnMistralApiKey("learned-from-client-key");
    p.prime(["mistral"]);
    await p.maybeRefresh();
    expect(fetcher.mistralAliasesCalls).toBe(1);
    expect(fetcher.lastMistralApiKey).toBe("learned-from-client-key");
  });

  it("learnMistralApiKey does not overwrite an already-learned key", async () => {
    const fetcher = new StubFetcher(undefined, undefined, undefined, parseMistralAliases(MISTRAL_MODELS_RAW));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    p.learnMistralApiKey("first-key");
    p.learnMistralApiKey("second-key");
    p.prime(["mistral"]);
    await p.maybeRefresh();
    expect(fetcher.lastMistralApiKey).toBe("first-key");
  });

  it("learnMistralApiKey ignores an empty string", async () => {
    const fetcher = new StubFetcher(undefined, undefined, undefined, parseMistralAliases(MISTRAL_MODELS_RAW));
    const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    p.learnMistralApiKey("");
    p.prime(["mistral"]);
    await p.maybeRefresh();
    expect(fetcher.lastMistralApiKey).toBeNull();
  });
});

// ---------- SDK price mode ----------
async function warmProvider(): Promise<PricingProvider> {
  const p = new PricingProvider({
    fetcher: new StubFetcher(parseOpenRouter(OPENROUTER_RAW)),
    ttlMs: 3_600_000,
  });
  p.prime();
  await p.maybeRefresh();
  return p;
}

async function warmCloudflareProvider(): Promise<PricingProvider> {
  const cfTable = parseCloudflareWorkersAi(CLOUDFLARE_MODELS_RAW);
  const fetcher = new StubFetcher(undefined, undefined, cfTable);
  const p = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
  // prime() doesn't eagerly warm Cloudflare (it's credential-gated and
  // provider-specific) — a real first lookup for this provider is what
  // flags it stale, same as production.
  p.lookup("workers-ai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "cloudflare_gateway");
  await p.maybeRefresh();
  return p;
}

function priceSdk(provider: PricingProvider, opts: { markup?: number } = {}) {
  const received: LagoEvent[] = [];
  const sdk = new LagoSDK({
    apiKey: "x",
    defaultSubscriptionId: "sub_default",
    config: { pricingMode: "price", markup: opts.markup ?? 1.0 },
  });
  sdk._setPricingProvider(provider);
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received };
}

/** Groups a flush's flat received events by their `token_type` property —
 * every event in price mode's per-field split shares `code: "llm_cost"`. */
function byTokenType(received: LagoEvent[]): Record<string, LagoEvent> {
  for (const e of received) expect(e.code).toBe("llm_cost");
  const out: Record<string, LagoEvent> = {};
  for (const e of received) {
    const tt = (e.properties as Record<string, unknown>).token_type as string;
    out[tt] = e;
  }
  return out;
}

describe("SDK price mode", () => {
  it("emits one llm_cost event per token_type, not one summed event", async () => {
    // A real per-field breakdown (OpenRouter has both input/output prices
    // for this model) splits into one llm_cost event per token_type, so
    // Lago's `grouped_by: ["model", "token_type"]` charge can break it down
    // by both — not one summed event that hides the split.
    const { sdk, received } = priceSdk(await warmProvider());
    sdk.emit(
      makeCanonicalUsage({
        input: 1000,
        output: 500,
        model: "claude-opus-4-8",
        provider: "anthropic",
        api: "native",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const byType = byTokenType(received);
    expect(new Set(Object.keys(byType))).toEqual(new Set(["input", "output"]));

    const inp = byType.input.properties as Record<string, unknown>;
    expect(inp.unit).toBe("1000");
    expect(inp.value).toBe("0.005"); // 1000 * 0.000005
    expect(inp.unit_price).toBe("0.000005");
    expect(inp.model).toBe("claude-opus-4-8");
    expect(inp.price_source).toBe("openrouter");
    // Lago dynamic charge cents = 0.005 USD * 100 = 0.5
    expect(byType.input.precise_total_amount_cents).toBe("0.5");

    const out = byType.output.properties as Record<string, unknown>;
    expect(out.unit).toBe("500");
    expect(out.value).toBe("0.0125"); // 500 * 0.000025
    expect(byType.output.precise_total_amount_cents).toBe("1.25");

    // Same call's split transaction ids don't collide with each other.
    expect(byType.input.transaction_id).not.toBe(byType.output.transaction_id);
  });

  it("workers-ai uses the Cloudflare catalog, not OpenRouter", async () => {
    // Real captured shape: 38 input / 2 output tokens through
    // "@cf/meta/llama-3.3-70b-instruct-fp8-fast" — same call this catalog
    // price was verified against live (predicted $0.00001564 vs
    // Cloudflare's own real-charged $0.00001552; the ~0.8% gap is the
    // catalog's own displayed rate rounding to 3dp, not our computation).
    const { sdk, received } = priceSdk(await warmCloudflareProvider());
    sdk.emit(
      makeCanonicalUsage({
        input: 38,
        output: 2,
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        provider: "workers-ai",
        api: "cloudflare_gateway",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const byType = byTokenType(received);
    expect((byType.input.properties as Record<string, unknown>).price_source).toBe("cloudflare_workers_ai");
    // 38 * 0.000000293 + 2 * 0.000002253 = 0.000011134 + 0.000004506 = 0.00001564
    expect((byType.input.properties as Record<string, unknown>).value).toBe("0.000011134");
    expect((byType.output.properties as Record<string, unknown>).value).toBe("0.000004506");
  });

  it("markup scales the value of each token_type event", async () => {
    const { sdk, received } = priceSdk(await warmProvider(), { markup: 2.0 });
    const u = makeCanonicalUsage({
      input: 1000,
      output: 500,
      model: "claude-opus-4-8",
      provider: "anthropic",
      api: "native",
    });
    sdk.emit(u);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const byType = byTokenType(received);
    expect((byType.input.properties as Record<string, unknown>).base_cost).toBe("0.005");
    expect((byType.input.properties as Record<string, unknown>).value).toBe("0.01"); // 0.005 * 2
    expect((byType.input.properties as Record<string, unknown>).markup).toBe("2");
    expect((byType.output.properties as Record<string, unknown>).value).toBe("0.025"); // 0.0125 * 2
  });

  it("per-call markup overrides global", async () => {
    const { sdk, received } = priceSdk(await warmProvider(), { markup: 1.0 });
    const u = makeCanonicalUsage({
      input: 1000,
      output: 500,
      model: "claude-opus-4-8",
      provider: "anthropic",
      api: "native",
    });
    sdk.emit(u, { markup: 3.0 });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const byType = byTokenType(received);
    expect((byType.input.properties as Record<string, unknown>).value).toBe("0.015"); // 0.005 * 3
    expect((byType.output.properties as Record<string, unknown>).value).toBe("0.0375"); // 0.0125 * 3
  });

  // ----------------------------------------------------------------------
  // Subset semantics: some providers report `input` INCLUSIVE of cache_read
  // and `output` INCLUSIVE of reasoning. Pricing the parent at full count
  // AND the subset separately would double-bill — these tests lock the
  // de-overlap.
  // ----------------------------------------------------------------------
  it("OpenAI cache_read (subset of input) is not double-billed", async () => {
    const { sdk, received } = priceSdk(await warmProvider());
    // OpenAI: input (prompt_tokens)=1000 ALREADY includes cache_read=800.
    sdk.emit(
      makeCanonicalUsage({
        input: 1000,
        output: 500,
        cache_read: 800,
        model: "gpt-4o",
        provider: "openai",
        api: "native",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const byType = byTokenType(received);
    expect(new Set(Object.keys(byType))).toEqual(new Set(["input", "cache_read", "output"]));
    // input billed for only the non-cached portion (1000 - 800); cache billed at cache rate
    expect((byType.input.properties as Record<string, unknown>).unit).toBe("200");
    expect((byType.cache_read.properties as Record<string, unknown>).unit).toBe("800");
    // 200*0.0000025=0.0005, 800*0.00000125=0.001, 500*0.00001=0.005 (bug would bill input at full 1000)
    expect((byType.input.properties as Record<string, unknown>).value).toBe("0.0005");
    expect((byType.cache_read.properties as Record<string, unknown>).value).toBe("0.001");
    expect((byType.output.properties as Record<string, unknown>).value).toBe("0.005");
  });

  it("Gemini cache_read is a subset of input; reasoning is additive", async () => {
    const { sdk, received } = priceSdk(await warmProvider());
    // Gemini: input=1000 INCLUDES cache_read=300; reasoning(thoughts)=100 is ADDITIVE.
    sdk.emit(
      makeCanonicalUsage({
        input: 1000,
        output: 400,
        cache_read: 300,
        reasoning: 100,
        model: "gemini-2.5-flash",
        provider: "gemini",
        api: "native",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const byType = byTokenType(received);
    expect(new Set(Object.keys(byType))).toEqual(new Set(["input", "cache_read", "output", "reasoning"]));
    expect((byType.input.properties as Record<string, unknown>).unit).toBe("700"); // 1000 - 300 cached
    expect((byType.cache_read.properties as Record<string, unknown>).unit).toBe("300");
    expect((byType.output.properties as Record<string, unknown>).unit).toBe("400");
    expect((byType.reasoning.properties as Record<string, unknown>).unit).toBe("100"); // billed separately (additive)
    // 700*3e-7=0.00021, 300*7.5e-8=0.0000225, 400*2.5e-6=0.001, 100*2.5e-6=0.00025
    expect((byType.input.properties as Record<string, unknown>).value).toBe("0.00021");
    expect((byType.cache_read.properties as Record<string, unknown>).value).toBe("0.0000225");
    expect((byType.output.properties as Record<string, unknown>).value).toBe("0.001");
    expect((byType.reasoning.properties as Record<string, unknown>).value).toBe("0.00025");
  });

  it("OpenAI reasoning (subset of output) is not double-billed", async () => {
    const { sdk, received } = priceSdk(await warmProvider());
    // OpenAI o-series: output (completion_tokens)=500 ALREADY includes reasoning=200.
    sdk.emit(
      makeCanonicalUsage({
        input: 100,
        output: 500,
        reasoning: 200,
        model: "gpt-4o",
        provider: "openai",
        api: "native",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const byType = byTokenType(received);
    // reasoning folded into output — no separate reasoning event, output billed in full
    expect(new Set(Object.keys(byType))).toEqual(new Set(["input", "output"]));
    expect((byType.output.properties as Record<string, unknown>).unit).toBe("500");
    // 100*0.0000025=0.00025, 500*0.00001=0.005 (bug would add a separate 200*1e-5=0.002 reasoning event)
    expect((byType.input.properties as Record<string, unknown>).value).toBe("0.00025");
    expect((byType.output.properties as Record<string, unknown>).value).toBe("0.005");
  });

  it("Anthropic cache is additive (input not reduced)", async () => {
    const { sdk, received } = priceSdk(await warmProvider());
    // Anthropic: input EXCLUDES cache; cache_read/cache_write are additive (no subtraction).
    sdk.emit(
      makeCanonicalUsage({
        input: 1000,
        output: 500,
        cache_read: 400,
        cache_write: 200,
        model: "claude-opus-4-8",
        provider: "anthropic",
        api: "native",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const byType = byTokenType(received);
    expect(new Set(Object.keys(byType))).toEqual(new Set(["input", "output", "cache_read", "cache_write"]));
    expect((byType.input.properties as Record<string, unknown>).unit).toBe("1000"); // unchanged — additive provider
    expect((byType.cache_read.properties as Record<string, unknown>).unit).toBe("400");
    expect((byType.cache_write.properties as Record<string, unknown>).unit).toBe("200");
    // 1000*5e-6=0.005, 500*25e-6=0.0125, 400*5e-7=0.0002, 200*6.25e-6=0.00125
    expect((byType.input.properties as Record<string, unknown>).value).toBe("0.005");
    expect((byType.output.properties as Record<string, unknown>).value).toBe("0.0125");
    expect((byType.cache_read.properties as Record<string, unknown>).value).toBe("0.0002");
    expect((byType.cache_write.properties as Record<string, unknown>).value).toBe("0.00125");
  });

  it("unknown price falls back to token events + onError", async () => {
    const errors: string[] = [];
    const received: LagoEvent[] = [];
    const sdk = new LagoSDK({
      apiKey: "x",
      defaultSubscriptionId: "sub_default",
      config: { pricingMode: "price", onError: (e) => errors.push((e as Error).constructor.name) },
    });
    sdk._setPricingProvider(await warmProvider());
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    sdk.emit(
      makeCanonicalUsage({
        input: 10,
        output: 20,
        model: "unknown-xyz",
        provider: "anthropic",
        api: "native",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code).sort()).toEqual(["llm_input_tokens", "llm_output_tokens"]);
    expect(errors).toContain("PricingUnavailableError");
  });

  it("per-call mode='price' overrides global tokens default", async () => {
    const received: LagoEvent[] = [];
    const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: "sub_default" }); // global tokens
    sdk._setPricingProvider(await warmProvider());
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    sdk.emit(
      makeCanonicalUsage({
        input: 1000,
        output: 500,
        model: "claude-opus-4-8",
        provider: "anthropic",
        api: "native",
      }),
      {
        mode: "price",
      },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2); // one per token_type (input, output)
    expect(received.every((e) => e.code === "llm_cost")).toBe(true);
  });

  it("default mode stays tokens (backward compatible)", async () => {
    const received: LagoEvent[] = [];
    const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: "sub_default" });
    sdk._setPricingProvider(await warmProvider());
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    sdk.emit(
      makeCanonicalUsage({
        input: 1000,
        output: 500,
        model: "claude-opus-4-8",
        provider: "anthropic",
        api: "native",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code).sort()).toEqual(["llm_input_tokens", "llm_output_tokens"]);
  });

  // ----------------------------------------------------------------------
  // usdCost — the gateway-connector entrypoint: skip our own price lookup
  // entirely and bill the caller's already-known real cost.
  // ----------------------------------------------------------------------
  it("usdCost skips the pricing lookup entirely", async () => {
    // A COLD, never-warmed provider — if this passed, emit() would have
    // had to fall back to token events (no price available). It doesn't:
    // usdCost bypasses pricing.lookup altogether, so a cold provider is
    // irrelevant.
    const coldProvider = new PricingProvider({ fetcher: new StubFetcher(), ttlMs: 3_600_000 });
    const { sdk, received } = priceSdk(coldProvider);
    sdk.emit(
      makeCanonicalUsage({
        input: 38,
        output: 41,
        model: "@cf/meta/llama-3.3-70b",
        provider: "workers-ai",
        api: "cloudflare_gateway",
      }),
      { usdCost: 0.00010472 },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(1);
    const ev = received[0];
    expect(ev.code).toBe("llm_cost");
    expect(ev.precise_total_amount_cents).toBe("0.010472");
    const props = ev.properties as Record<string, unknown>;
    expect(props.price_source).toBe("precomputed");
    expect(props.value).toBe("0.00010472");
    // No per-field breakdown available — unit falls back to raw input+output.
    expect(props.unit).toBe("79");
    expect(props.input_tokens).toBeUndefined();
  });

  it("usdCost applies markup the same way a looked-up price would", async () => {
    const coldProvider = new PricingProvider({ fetcher: new StubFetcher(), ttlMs: 3_600_000 });
    const { sdk, received } = priceSdk(coldProvider, { markup: 1.5 });
    sdk.emit(
      makeCanonicalUsage({
        input: 10,
        output: 5,
        model: "m",
        provider: "workers-ai",
        api: "cloudflare_gateway",
      }),
      {
        usdCost: 0.0001,
      },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const props = received[0].properties as Record<string, unknown>;
    expect(props.base_cost).toBe("0.0001");
    expect(props.value).toBe("0.00015");
  });

  it("usdCost is ignored in token mode — the call still emits ordinary token events", async () => {
    const coldProvider = new PricingProvider({ fetcher: new StubFetcher(), ttlMs: 3_600_000 });
    const received: LagoEvent[] = [];
    const sdk = new LagoSDK({
      apiKey: "x",
      defaultSubscriptionId: "sub_default",
      config: { pricingProvider: coldProvider },
    });
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    sdk.emit(
      makeCanonicalUsage({
        input: 10,
        output: 5,
        model: "m",
        provider: "workers-ai",
        api: "cloudflare_gateway",
      }),
      { usdCost: 0.0001 },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(new Set(received.map((e) => e.code))).toEqual(new Set(["llm_input_tokens", "llm_output_tokens"]));
  });

  // ----------------------------------------------------------------------
  // eventId — Lago's idempotency key, for replaying/backfilling a gateway's
  // logs without ever double-billing.
  // ----------------------------------------------------------------------
  it("eventId is used as the transaction_id in price mode", async () => {
    const coldProvider = new PricingProvider({ fetcher: new StubFetcher(), ttlMs: 3_600_000 });
    const { sdk, received } = priceSdk(coldProvider);
    sdk.emit(
      makeCanonicalUsage({
        input: 10,
        output: 5,
        model: "m",
        provider: "workers-ai",
        api: "cloudflare_gateway",
      }),
      { usdCost: 0.0001, eventId: "backfill_01ABC" },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received[0].transaction_id).toBe("backfill_01ABC");
  });

  it("eventId is suffixed per field in token mode", async () => {
    // Token mode can push several events from one call (input, output,
    // ...); reusing the same eventId verbatim for all of them would
    // collide, so each field gets its own suffix off the same base id.
    const received: LagoEvent[] = [];
    const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: "sub_default" });
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    sdk.emit(
      makeCanonicalUsage({
        input: 10,
        output: 5,
        model: "m",
        provider: "workers-ai",
        api: "cloudflare_gateway",
      }),
      { eventId: "backfill_01ABC" },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(new Set(received.map((e) => e.transaction_id))).toEqual(
      new Set(["backfill_01ABC_input", "backfill_01ABC_output"]),
    );
  });

  it("no eventId still falls back to a random id — works exactly as before this option existed", async () => {
    const coldProvider = new PricingProvider({ fetcher: new StubFetcher(), ttlMs: 3_600_000 });
    const { sdk, received } = priceSdk(coldProvider);
    sdk.emit(
      makeCanonicalUsage({
        input: 10,
        output: 5,
        model: "m",
        provider: "workers-ai",
        api: "cloudflare_gateway",
      }),
      { usdCost: 0.0001 },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received[0].transaction_id).toBeTruthy();
  });

  // ----------------------------------------------------------------------
  // warmPricing()
  // ----------------------------------------------------------------------
  it("warmPricing() closes the cold-start race for OpenRouter", async () => {
    // Without warmPricing(), a call made immediately after construction
    // hits a cold table and emit() falls back to token events (or, with no
    // token metric configured, loses the event entirely). warmPricing()
    // blocks until the table is fetched, so the very first call in price
    // mode prices correctly instead of racing the background loop's first tick.
    const fetcher = new StubFetcher(parseOpenRouter(OPENROUTER_RAW));
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = new LagoSDK({
      apiKey: "dummy",
      defaultSubscriptionId: "sub_default",
      config: { pricingMode: "price", pricingProvider: provider },
    });
    const received: LagoEvent[] = [];
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    expect(provider.lookup("anthropic", "claude-opus-4-8", "native")).toBeNull(); // genuinely cold
    await sdk.warmPricing();
    expect(provider.lookup("anthropic", "claude-opus-4-8", "native")).not.toBeNull(); // now warm
    sdk.emit(
      makeCanonicalUsage({
        input: 1000,
        output: 500,
        model: "claude-opus-4-8",
        provider: "anthropic",
        api: "native",
      }),
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.code === "llm_cost")).toBe(true); // priced, not a token-event fallback
  });

  it("warmPricing(providers) also eagerly warms Cloudflare/Mistral when named", async () => {
    const fetcher = new StubFetcher(
      parseOpenRouter(OPENROUTER_RAW),
      undefined,
      undefined,
      parseMistralAliases(MISTRAL_MODELS_RAW),
    );
    const provider = new PricingProvider({ fetcher, ttlMs: 3_600_000 });
    const sdk = new LagoSDK({
      apiKey: "dummy",
      defaultSubscriptionId: "sub_default",
      config: { pricingMode: "price", pricingProvider: provider },
    });
    sdk._setSender(async () => {});
    await sdk.warmPricing(["mistral"]);
    expect(fetcher.mistralAliasesCalls).toBe(1);
    expect(provider.lookup("mistral", "mistral-small-latest", "native")).not.toBeNull();
    await sdk.shutdown(1000);
  });
});
