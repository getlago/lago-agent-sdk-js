/** Cloudflare AI Gateway log adapter — verified against real captured log entries. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { makeCanonicalUsage, nonzeroNumeric } from "../../../../src/canonical.js";
import { extractCloudflareLog, resolveSubscription } from "../../../../src/gateway/adapters/index.js";
import { computeCost, lookupOpenRouter, parseOpenRouter, parseScaled } from "../../../../src/pricing.js";

const FIX = join(__dirname, "fixtures", "cloudflare_gateway");

function load(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIX, name), "utf8"));
}

describe("Cloudflare gateway log adapter — real fixtures", () => {
  it("real Anthropic call", () => {
    // The exact log entry captured against a live Cloudflare account + real
    // Anthropic call. These numbers were independently confirmed to roll up
    // correctly in a real Lago instance (16.0 / 7.0 units billed, exact match).
    const entry = load("01_real_anthropic_call.json");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(16);
    expect(u.output).toBe(7);
    expect(u.cache_read).toBe(0);
    expect(u.cache_write).toBe(0);
    expect(u.model).toBe("claude-sonnet-4-5-20250929");
    expect(u.provider).toBe("anthropic");
    expect(u.api).toBe("cloudflare_gateway");
    expect(u.extras.cached).toBe(false);
    expect(u.extras.step).toBe(0);
    expect(u.extras.log_id).toBe("01KZ3Y993DV0Z5CAQCA4CJ3GRD");
    expect(resolveSubscription(entry)).toBe("cf_gateway_test_sub");
  });

  it("wholesale credits failure (402) has zero usage", () => {
    // A 402 (Unified Billing out of credits) never reaches the provider —
    // tokens_in/out are 0 and usage_metadata is null. Must not throw, must
    // not fabricate nonzero usage.
    const entry = load("02_real_wholesale_credits_failure.json");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(Object.keys(nonzeroNumeric(u))).toHaveLength(0);
    expect(resolveSubscription(entry)).toBeNull(); // metadata is null on this entry
  });

  it("workers-ai provider and model pass through", () => {
    // A different provider entirely — confirms the mapping isn't
    // Anthropic/OpenAI-specific; provider/model pass through verbatim
    // regardless of which one it is.
    const entry = load("03_real_workers_ai_failed.json");
    const u = extractCloudflareLog(entry);
    expect(u.provider).toBe("workers-ai");
    expect(u.model).toBe("@cf/moonshotai/kimi-k2.7-code");
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
  });

  // ------------------------------------------------------------------
  // Three separate ingress methods into the same gateway. extractCloudflareLog()
  // never sees how the call was made (curl, the real OpenAI SDK, or a Workers
  // AI binding) — only Cloudflare's own normalized log entry. These fixtures
  // prove that holds across every ingress method.
  // ------------------------------------------------------------------
  it("REST API, bare model string, success", () => {
    const entry = load("09_real_rest_bare_model_success.json");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(38);
    expect(u.output).toBe(8);
    expect(u.provider).toBe("workers-ai");
    expect(u.model).toBe("@cf/meta/llama-3.2-3b-instruct");
    expect(resolveSubscription(entry)).toBeNull(); // no metadata sent on this call
  });

  it("REST API Anthropic 402 is provider-agnostic", () => {
    const entry = load("07_real_rest_anthropic_402.json");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(u.provider).toBe("anthropic");
    expect(u.model).toBe("anthropic/claude-opus-4.8");
    expect(resolveSubscription(entry)).toBeNull();
  });

  it("Unified/compat API success", () => {
    // Called with the real openai client pointed at Cloudflare's compat
    // endpoint, routed to a Workers AI model — proves the log schema is
    // identical regardless of which client library made the request.
    const entry = load("08_real_unified_compat_success.json");
    expect(entry.path).toBe("chat/completions");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(43);
    expect(u.output).toBe(41);
    expect(u.provider).toBe("workers-ai");
    expect(u.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
  });

  it("moderation model has an unusual token shape", () => {
    // A moderation/classifier model, not a chat model — confirms extraction
    // doesn't assume a "normal" chat-shaped input/output ratio.
    const entry = load("10_real_llama_guard_moderation.json");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(203);
    expect(u.output).toBe(3);
    expect(u.provider).toBe("workers-ai");
    expect(u.model).toBe("@cf/meta/llama-guard-3-8b");
  });

  it("403 paid-plan-required is distinct from the 402 funding failure", () => {
    const entry = load("11_real_paid_plan_required_403.json");
    expect(entry.status_code).toBe(403);
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(Object.keys(nonzeroNumeric(u))).toHaveLength(0);
    expect(resolveSubscription(entry)).toBeNull();
  });

  it("real Mistral via the dedicated passthrough endpoint", () => {
    const entry = load("15_real_mistral_via_dedicated_endpoint.json");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(23);
    expect(u.output).toBe(30);
    expect(u.provider).toBe("mistral");
    expect(u.model).toBe("mistral-small-latest");
  });

  it("Gemini reasoning tokens mapped from the camelCase field", () => {
    // This is the fixture that caught a real gap: Cloudflare's log for
    // this call has usage_metadata.reasoningTokens (camelCase, unlike
    // Anthropic's snake_case input_cached_tokens).
    const entry = load("16_real_gemini_via_dedicated_endpoint.json");
    expect((entry.usage_metadata as Record<string, unknown>).reasoningTokens).toBe(852);
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(9);
    expect(u.output).toBe(21);
    expect(u.reasoning).toBe(852);
    // Cloudflare logs this as "google-ai-studio"; the SDK's own vocabulary
    // calls it "gemini", which is what the price and token-semantics tables
    // key off.
    expect(entry.provider).toBe("google-ai-studio");
    expect(u.provider).toBe("gemini");
    expect(u.model).toBe("gemini-2.5-flash");
  });

  it("native/binding method with metadata resolves subscription", () => {
    const entry = load("06_real_native_binding_with_metadata.json");
    expect(entry.user_agent).toBe("cloudflare-worker");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(19);
    expect(u.output).toBe(35);
    expect(u.provider).toBe("workers-ai");
    expect(u.model).toBe("@cf/meta/llama-3.2-1b-instruct");
    expect(resolveSubscription(entry)).toBe("cf_gateway_test_sub");
  });

  // ------------------------------------------------------------------
  // Two DIFFERENT "cache" concepts, both verified live — don't conflate them:
  //   1. Gateway-level response cache (`cached` boolean).
  //   2. Provider-level PROMPT cache (Anthropic cache_control).
  // ------------------------------------------------------------------
  it("gateway cache hit has zero tokens", () => {
    // Correction from an earlier assumption: a gateway cache HIT does NOT
    // report the token counts the call "would have" cost — Cloudflare's own
    // log already reports tokens_in/tokens_out as 0.
    const entry = load("14_real_gateway_cache_hit.json");
    const u = extractCloudflareLog(entry);
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(u.extras.cached).toBe(true);
  });

  it("Anthropic prompt-cache write then read", () => {
    const writeEntry = load("13_real_cache_write.json");
    const readEntry = load("12_real_cache_read.json");

    const w = extractCloudflareLog(writeEntry);
    expect(w.input).toBe(9);
    expect(w.output).toBe(5);
    expect(w.cache_write).toBe(3429);
    expect(w.cache_read).toBe(0);

    const r = extractCloudflareLog(readEntry);
    expect(r.input).toBe(10);
    expect(r.output).toBe(4);
    expect(r.cache_write).toBe(0);
    expect(r.cache_read).toBe(3429);
  });
});

describe("resolveSubscription — attribution", () => {
  it("missing metadata key returns null", () => {
    expect(resolveSubscription({ metadata: { some_other_key: "x" } })).toBeNull();
  });

  it("empty string returns null — not real attribution", () => {
    expect(resolveSubscription({ metadata: { lago_subscription: "" } })).toBeNull();
  });

  it("non-object metadata returns null", () => {
    expect(resolveSubscription({ metadata: "not-an-object" })).toBeNull();
    expect(resolveSubscription({ metadata: null })).toBeNull();
    expect(resolveSubscription({})).toBeNull();
  });
});

describe("robustness — a poller processes entries in a batch", () => {
  it("survives missing fields", () => {
    const u = extractCloudflareLog({});
    expect(u.input).toBe(0);
    expect(u.output).toBe(0);
    expect(u.model).toBe("");
    expect(u.provider).toBe("");
    expect(Object.keys(nonzeroNumeric(u))).toHaveLength(0);
  });

  it("survives non-object usage_metadata", () => {
    const u = extractCloudflareLog({ tokens_in: 5, tokens_out: 3, usage_metadata: "bogus" });
    expect(u.input).toBe(5);
    expect(u.output).toBe(3);
    expect(u.cache_read).toBe(0);
    expect(u.cache_write).toBe(0);
  });

  it("survives non-string model and provider", () => {
    const u = extractCloudflareLog({ model: 123, provider: null, tokens_in: 1, tokens_out: 1 });
    expect(u.model).toBe("");
    expect(u.provider).toBe("");
  });

  it("survives negative and non-numeric tokens", () => {
    expect(extractCloudflareLog({ tokens_in: -5 }).input).toBe(0);
    expect(extractCloudflareLog({ tokens_out: "bogus" }).output).toBe(0);
  });
});

// --------------------------------------------------------------------------
// Provider vocabulary — Cloudflare's names are not the SDK's names
// --------------------------------------------------------------------------
describe("Cloudflare gateway provider normalization", () => {
  // Verified live: lookupOpenRouter with provider="google-ai-studio" missed
  // against the real 400-model OpenRouter table and hit as "gemini".
  it("maps Cloudflare's vocabulary onto the SDK's", () => {
    const cases: Array<[string, string]> = [
      ["google-ai-studio", "gemini"],
      ["google-vertex-ai", "gemini"],
      ["vertex", "gemini"],
      ["azure-openai", "openai"],
      ["azureopenai", "openai"],
      ["workersai", "workers-ai"],
    ];
    for (const [raw, expected] of cases) {
      expect(extractCloudflareLog({ provider: raw, tokens_in: 1 }).provider, raw).toBe(expected);
    }
  });

  it("passes through names we already agree on", () => {
    for (const raw of ["anthropic", "openai", "mistral", "workers-ai"]) {
      expect(extractCloudflareLog({ provider: raw, tokens_in: 1 }).provider).toBe(raw);
    }
  });

  it("passes an unknown provider through untouched", () => {
    // An unrecognized provider is one we have no price table for; a clean miss
    // falls back to token events, which beats inventing a mapping.
    expect(extractCloudflareLog({ provider: "perplexity", tokens_in: 1 }).provider).toBe("perplexity");
    // AWS Bedrock is deliberately NOT aliased — its prices key off the `api`
    // field, which this connector always sets to "cloudflare_gateway".
    expect(extractCloudflareLog({ provider: "bedrock", tokens_in: 1 }).provider).toBe("bedrock");
  });

  it("normalized gemini provider prices, and bills cache as a subset", () => {
    // The two downstream consequences of the alias, end to end: the Gemini
    // price is now findable, and cache_read is treated as a SUBSET of input
    // (Gemini's semantics) instead of being billed on top of it.
    const entry = load("16_real_gemini_via_dedicated_endpoint.json");
    const u = extractCloudflareLog(entry);
    const table = parseOpenRouter({
      data: [
        {
          id: "google/gemini-2.5-flash",
          pricing: {
            prompt: "0.0000003",
            completion: "0.0000025",
            input_cache_read: "0.000000075",
          },
        },
      ],
    });
    const price = lookupOpenRouter(table, u.provider, u.model);
    expect(price, "gemini price must resolve after normalization").not.toBeNull();

    const cached = makeCanonicalUsage({
      model: u.model,
      provider: u.provider,
      api: u.api,
      input: 1000,
      cache_read: 800,
    });
    const b = computeCost(cached, price!, parseScaled("1")!);
    expect(b.fields.input.tokens).toBe("200"); // 1000 - 800, not 1000
    expect(b.fields.cache_read.tokens).toBe("800");
  });

  it("lookupOpenRouter strips a redundant vendor prefix", () => {
    // Real fixture 07 reports model="anthropic/claude-opus-4.8" alongside
    // provider="anthropic"; unstripped that built "anthropic/anthropic/..."
    // and never matched.
    const table = parseOpenRouter({
      data: [{ id: "anthropic/claude-opus-4.8", pricing: { prompt: "0.000005" } }],
    });
    expect(lookupOpenRouter(table, "anthropic", "anthropic/claude-opus-4.8")).not.toBeNull();
    expect(lookupOpenRouter(table, "anthropic", "claude-opus-4.8")).not.toBeNull();
    // Still vendor-gated: a model claiming a different vendor must not match.
    expect(lookupOpenRouter(table, "openai", "anthropic/claude-opus-4.8")).toBeNull();
  });
});

// ----------------------------------------------------------------------
// Cache-key casing. The gateway forwards some provider keys unnormalized — the
// real Gemini fixture carries camelCase `reasoningTokens` — and a missed cache key
// does not merely lose a field: `gemini` is in INPUT_INCLUDES_CACHE_READ, so
// computeCost needs `cache_read` populated to SUBTRACT the cached portion out of
// `input`. A silent 0 bills those tokens at the full prompt rate.
// ----------------------------------------------------------------------
describe("Cloudflare gateway — cache key casing", () => {
  it.each(["input_cached_tokens", "inputCachedTokens", "cachedContentTokenCount"])(
    "cache_read resolves under %s",
    (key) => {
      const u = extractCloudflareLog({
        tokens_in: 100,
        tokens_out: 10,
        provider: "google-ai-studio",
        usage_metadata: { [key]: 90 },
      });
      expect(u.cache_read).toBe(90);
    },
  );

  it.each(["input_cache_creation_tokens", "inputCacheCreationTokens", "cache_creation_input_tokens"])(
    "cache_write resolves under %s",
    (key) => {
      const u = extractCloudflareLog({
        tokens_in: 100,
        tokens_out: 10,
        provider: "anthropic",
        usage_metadata: { [key]: 40 },
      });
      expect(u.cache_write).toBe(40);
    },
  );

  it("a zeroed alias falls through to the real count", () => {
    // Fallthrough is on a falsy value, not just a missing key. `??` only skips
    // null/undefined, so a provider sending both its own name and the gateway's
    // with one zeroed resolved to the ZERO and lost the real count — while
    // Python's `or` chain did not, so the two repos disagreed on live money.
    const u = extractCloudflareLog({
      tokens_in: 100,
      tokens_out: 10,
      provider: "google-ai-studio",
      usage_metadata: { input_cached_tokens: 0, cachedContentTokenCount: 77 },
    });
    expect(u.cache_read).toBe(77);
  });

  it("stays zero when genuinely absent", () => {
    const u = extractCloudflareLog({
      tokens_in: 100,
      tokens_out: 10,
      provider: "anthropic",
      usage_metadata: {},
    });
    expect(u.cache_read).toBe(0);
    expect(u.cache_write).toBe(0);
  });

  it("accepts provider-native cache and reasoning spellings", () => {
    // SYNTHETIC entries — no provider-native key appears in ANY of the 14 captured
    // fixtures (they carry only Cloudflare's own vocabulary). These pin the
    // unobserved insurance spellings so the fallthrough list cannot be trimmed by
    // accident. The direction of the harm differs by provider, which is why both
    // matter: Anthropic's cache_read is ADDITIVE, so a missed key means those tokens
    // are never billed (under-bill); Gemini's is SUBTRACTIVE, so a missed key bills
    // them at the full prompt rate (over-bill).
    expect(
      extractCloudflareLog({
        tokens_in: 100,
        tokens_out: 10,
        provider: "anthropic",
        usage_metadata: { cache_read_input_tokens: 4242 },
      }).cache_read,
    ).toBe(4242);

    expect(
      extractCloudflareLog({
        tokens_in: 100,
        tokens_out: 10,
        provider: "google-ai-studio",
        usage_metadata: { thoughtsTokenCount: 852 },
      }).reasoning,
    ).toBe(852);

    // Cloudflare's own spelling still wins when both are present
    expect(
      extractCloudflareLog({
        tokens_in: 100,
        tokens_out: 10,
        provider: "anthropic",
        usage_metadata: { input_cached_tokens: 11, cache_read_input_tokens: 4242 },
      }).cache_read,
    ).toBe(11);
  });
});
