/** Cloudflare AI Gateway log adapter — verified against real captured log entries. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { nonzeroNumeric } from "../../../../src/canonical.js";
import { extractCloudflareLog, resolveSubscription } from "../../../../src/gateway/adapters/index.js";

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
    expect(u.provider).toBe("google-ai-studio");
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
