/**
 * Cloudflare AI Gateway log adapter — maps a Logs API entry to CanonicalUsage.
 *
 * Verified against a real captured log entry (live account, real Anthropic call
 * routed through a real gateway, real Lago rollup confirmed exact).
 *
 * Field mapping (`GET .../ai-gateway/gateways/{id}/logs` and the single-entry
 * `GET .../logs/{log_id}`):
 *   tokens_in                                       -> input
 *   tokens_out                                       -> output
 *   usage_metadata.input_cached_tokens               -> cache_read
 *   usage_metadata.input_cache_creation_tokens       -> cache_write
 *   usage_metadata.reasoningTokens/reasoning_tokens  -> reasoning
 *   model, provider                                  -> passed straight through
 *
 * `usage_metadata`'s exact key casing is NOT normalized by Cloudflare — it
 * passes through whatever convention the underlying provider's own usage
 * object used (Anthropic/OpenAI: snake_case `input_cached_tokens`; a real
 * captured Gemini entry: camelCase `reasoningTokens`). Both cases are checked
 * for every field we map; this is observed behavior across two providers,
 * not a documented guarantee, so a third provider could use a convention we
 * haven't seen yet.
 *
 * Unlike the provider-native adapters (`adapters/openai_native.ts`,
 * `adapters/anthropic_native.ts`), there is no request-side model kwarg to
 * prefer or fall back on here — a Cloudflare log entry always reports the
 * model that actually served the request. This adapter is immune, by
 * construction, to the alias-vs-resolved-model bug fixed in those two.
 *
 * Billing *policy* is deliberately not decided here — this module only
 * extracts. `cached`, `step`, and the log's own `id` land in `extras` because
 * the caller (the poller) needs them: `cached` to decide whether to skip
 * billing a request Cloudflare served for free, `id` as the idempotency key
 * against replays. `resolveSubscription()` is separate from extraction
 * because attribution can be absent, and dropping vs. warning on that is
 * also a caller policy decision.
 */

import { CanonicalUsage, makeCanonicalUsage } from "../../canonical.js";

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function safeStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * First of `names` present in `meta` with a usable value, as a number.
 *
 * The gateway does NOT normalize every key it forwards. Its own counters are
 * consistently snake_case across every captured fixture (`input_tokens`,
 * `output_tokens`, `total_tokens`, `input_cached_tokens`,
 * `input_cache_creation_tokens`), but a provider's native key can come through
 * untouched: the real Gemini entry carries `reasoningTokens`, camelCase, and an
 * unmapped `input_text_tokens` alongside it. So the spelling of a cache key on a
 * provider we have no cached capture for is genuinely unknown.
 *
 * Checking every plausible spelling is close to free and the downside is lopsided.
 * A silent 0 here does not merely lose a field — `gemini` is in
 * INPUT_INCLUDES_CACHE_READ, so `computeCost` relies on `cache_read` being
 * populated in order to SUBTRACT the cached portion out of `input`. A missed cache
 * key therefore bills those tokens at the full prompt rate instead of the cache
 * rate: an over-bill, not an omission.
 *
 * Falls through on a zero as well as on a missing key — deliberately NOT `??`,
 * which only skips null/undefined. With `??`, a provider sending both its own name
 * and the gateway's with one of them zeroed resolved to the zero and lost the real
 * count; Python's `or` chain did not, so the two repos disagreed.
 */
function firstInt(meta: Record<string, unknown>, ...names: string[]): number {
  for (const name of names) {
    const v = safeInt(meta[name]);
    if (v) return v;
  }
  return 0;
}

// Cloudflare AI Gateway logs its OWN provider vocabulary, which is not the name
// the pricing tables and token-semantics tables key off — and not always its own
// URL slug either (the logs say "workers-ai" where the endpoint path says
// "workersai"). Passed through verbatim, "google-ai-studio" matched no vendor in
// pricing's VENDOR_MAP, so every Gemini call backfilled through the gateway
// missed on price; worse, it also missed INPUT_INCLUDES_CACHE_READ, so Gemini's
// cache_read — a SUBSET of its input count, not additive — was billed twice.
//
// Only providers this SDK can actually price need an entry. Anything else passes
// through unchanged: an unrecognized provider is one we have no table for, and a
// clean miss falls back to token events, which is strictly better than inventing
// a mapping. AWS Bedrock is deliberately absent for that reason — Bedrock prices
// are keyed off `api.startsWith("bedrock")`, and this connector always sets
// api="cloudflare_gateway", so mapping its provider name would route it to
// OpenRouter under a vendor that cannot match. A miss there is honest.
const PROVIDER_ALIASES: Record<string, string> = {
  "google-ai-studio": "gemini",
  "google-vertex-ai": "gemini",
  vertex: "gemini",
  "azure-openai": "openai",
  azureopenai: "openai",
  workersai: "workers-ai",
};

/** Map Cloudflare's provider name onto the SDK's own provider vocabulary. */
function normalizeProvider(v: unknown): string {
  const p = safeStr(v).toLowerCase();
  return PROVIDER_ALIASES[p] ?? p;
}

/**
 * Translate one Cloudflare AI Gateway log entry -> CanonicalUsage.
 *
 * Accepts a single log entry object as returned by the Logs API (either the
 * list endpoint or the single-entry endpoint — same shape). Missing/malformed
 * fields degrade to zero/empty rather than throwing, matching the defensive
 * style of the other adapters — a poller processing a batch of log entries
 * must not have one malformed entry take down the whole run.
 */
export function extractCloudflareLog(entry: Record<string, unknown>): CanonicalUsage {
  const usageMeta = isObj(entry.usage_metadata) ? entry.usage_metadata : {};

  return makeCanonicalUsage({
    input: safeInt(entry.tokens_in),
    output: safeInt(entry.tokens_out),
    // Gateway's own snake_case first (present in 8 of the 14 captured fixtures),
    // then its camelCase form, then the providers' own native names — Gemini calls
    // it `cachedContentTokenCount`, Anthropic `cache_creation_input_tokens`, and the
    // `reasoningTokens` fixture proves native keys do reach us unnormalized.
    cache_read: firstInt(usageMeta, "input_cached_tokens", "inputCachedTokens", "cachedContentTokenCount"),
    cache_write: firstInt(
      usageMeta,
      "input_cache_creation_tokens",
      "inputCacheCreationTokens",
      "cache_creation_input_tokens",
    ),
    reasoning: firstInt(usageMeta, "reasoningTokens", "reasoning_tokens"),
    model: safeStr(entry.model),
    provider: normalizeProvider(entry.provider),
    api: "cloudflare_gateway",
    extras: {
      cached: entry.cached,
      step: entry.step,
      log_id: entry.id,
    },
  });
}

/**
 * Pull the Lago subscription id from the customer's `cf-aig-metadata` header.
 *
 * Returns null if the customer never set `lago_subscription` — the caller
 * decides what to do with an unattributed entry (drop it, log a warning,
 * ...); this function only reports whether attribution is present.
 */
export function resolveSubscription(entry: Record<string, unknown>): string | null {
  const metadata = isObj(entry.metadata) ? entry.metadata : {};
  const value = metadata.lago_subscription;
  return typeof value === "string" && value ? value : null;
}
