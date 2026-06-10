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
  lookupOpenRouter,
  type ModelPrice,
  type OpenRouterTable,
  parseBedrockOffer,
  parseBedrockRegion,
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
  constructor(
    private openrouter: OpenRouterTable = { exact: new Map(), norm: new Map() },
    private bedrock: Map<string, Map<string, ModelPrice>> = new Map(),
  ) {}
  async fetchOpenRouter(): Promise<OpenRouterTable> {
    this.openrouterCalls++;
    return this.openrouter;
  }
  async fetchBedrock(region: string): Promise<Map<string, ModelPrice>> {
    this.bedrockCalls.push(region);
    return this.bedrock.get(region) ?? new Map();
  }
}

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

describe("SDK price mode", () => {
  it("emits a single llm_cost event with breakdown", async () => {
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
    expect(received).toHaveLength(1);
    const p = received[0].properties as Record<string, unknown>;
    expect(received[0].code).toBe("llm_cost");
    // Lago dynamic charge: top-level cents amount = 0.0175 USD * 100 = 1.75
    expect(received[0].precise_total_amount_cents).toBe("1.75");
    expect(p.unit).toBe("1500"); // total tokens (1000 + 500) — sum-agg quantity
    expect(p.value).toBe("0.0175"); // 1000*5e-6 + 500*25e-6
    expect(p.price_source).toBe("openrouter");
    expect(p.input_unit_price).toBe("0.000005");
    expect(p.output_cost).toBe("0.0125");
  });

  it("markup scales the value (global + per-call override)", async () => {
    const { sdk, received } = priceSdk(await warmProvider(), { markup: 2.0 });
    const u = makeCanonicalUsage({
      input: 1000,
      output: 500,
      model: "claude-opus-4-8",
      provider: "anthropic",
      api: "native",
    });
    sdk.emit(u); // global 2x
    sdk.emit(u, { markup: 3.0 }); // per-call 3x
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const vals = received.map((e) => (e.properties as Record<string, unknown>).value);
    expect(vals).toContain("0.035"); // 0.0175 * 2
    expect(vals).toContain("0.0525"); // 0.0175 * 3
  });

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
    const p = received[0].properties as Record<string, unknown>;
    expect(p.input_tokens).toBe("200"); // 1000 - 800 cached
    expect(p.cache_read_tokens).toBe("800");
    // 200*2.5e-6 + 800*1.25e-6 + 500*1e-5 = 0.0005 + 0.001 + 0.005 = 0.0065 (bug -> 0.0085)
    expect(p.value).toBe("0.0065");
    expect(p.unit).toBe("1500"); // 200 + 800 + 500 = prompt(1000) + completion(500)
  });

  it("Gemini cache_read is a subset of input; reasoning is additive", async () => {
    const { sdk, received } = priceSdk(await warmProvider());
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
    const p = received[0].properties as Record<string, unknown>;
    expect(p.input_tokens).toBe("700"); // 1000 - 300 cached
    expect(p.cache_read_tokens).toBe("300");
    expect(p.output_tokens).toBe("400");
    expect(p.reasoning_tokens).toBe("100"); // additive for Gemini
    // 700*3e-7 + 300*7.5e-8 + 400*2.5e-6 + 100*2.5e-6 = 0.0014825
    expect(p.value).toBe("0.0014825");
    expect(p.unit).toBe("1500"); // 700+300+400+100 = prompt(1000)+candidates(400)+thoughts(100)
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
    const p = received[0].properties as Record<string, unknown>;
    expect(p.reasoning_tokens).toBeUndefined(); // folded into output
    expect(p.output_tokens).toBe("500");
    // 100*2.5e-6 + 500*1e-5 = 0.00525 (bug would add 200*1e-5 = 0.002)
    expect(p.value).toBe("0.00525");
    expect(p.unit).toBe("600"); // 100 + 500; reasoning not double-counted
  });

  it("Anthropic cache is additive (input not reduced)", async () => {
    const { sdk, received } = priceSdk(await warmProvider());
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
    const p = received[0].properties as Record<string, unknown>;
    expect(p.input_tokens).toBe("1000"); // unchanged — additive provider
    expect(p.cache_read_tokens).toBe("400");
    expect(p.cache_write_tokens).toBe("200");
    // 1000*5e-6 + 500*2.5e-5 + 400*5e-7 + 200*6.25e-6 = 0.01895
    expect(p.value).toBe("0.01895");
    expect(p.unit).toBe("2100"); // 1000+500+400+200, all additive
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
    expect(received).toHaveLength(1);
    expect(received[0].code).toBe("llm_cost");
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
});

// HttpPricingFetcher is exercised by the env-gated live test, not here.
void HttpPricingFetcher;
