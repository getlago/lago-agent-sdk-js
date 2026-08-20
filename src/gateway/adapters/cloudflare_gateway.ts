/**
 * Cloudflare AI Gateway log adapter — maps a Logs API entry to CanonicalUsage.
 *
 * Reads both the list and single-entry Logs API shapes. No request-side model kwarg to
 * reconcile: a log entry always names the model that actually served the request.
 *
 * Billing *policy* is deliberately not decided here; this module only extracts. `cached`,
 * `step` and the log's own `id` land in `extras` because the caller needs them — `cached`
 * to skip a request Cloudflare served for free, `id` as the idempotency key against
 * replays. `resolveSubscription()` is separate because attribution can be absent, and
 * dropping vs. warning on that is the caller's policy too.
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
 * The gateway does NOT normalize every key it forwards: its own counters are
 * snake_case, but a provider's native key passes through untouched (the real Gemini
 * entry carries camelCase `reasoningTokens`), so a cache key's spelling on a provider
 * we have no capture for is unknown. Hence every plausible spelling is checked.
 *
 * A silent 0 here OVER-bills, it does not merely lose a field: `gemini` is in
 * INPUT_INCLUDES_CACHE_READ, so `computeCost` needs `cache_read` populated in order to
 * subtract the cached portion out of `input`.
 *
 * Falls through on zero as well as on a missing key — NOT `??`, which skips only
 * null/undefined and would resolve to a zeroed duplicate key, losing the real count and
 * disagreeing with Python's `or` chain.
 */
function firstInt(meta: Record<string, unknown>, ...names: string[]): number {
  for (const name of names) {
    const v = safeInt(meta[name]);
    if (v) return v;
  }
  return 0;
}

// The gateway logs its OWN provider vocabulary, which is neither the name the pricing
// and token-semantics tables key off nor even its own URL slug (logs say "workers-ai",
// the endpoint path says "workersai"). An unmapped name misses VENDOR_MAP *and*
// INPUT_INCLUDES_CACHE_READ — so it does not just fail to price, it double-bills the
// cache overlap for a cache-inclusive provider.
//
// Only providers this SDK can price need an entry; anything else passes through and
// takes a clean miss to token events, which beats inventing a mapping. Bedrock is
// deliberately absent: its prices key off `api.startsWith("bedrock")` and this
// connector always sets api="cloudflare_gateway", so a mapping would route it to
// OpenRouter under a vendor that cannot match.
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
    // Gateway snake_case, then its camelCase, then the provider's own native name.
    // See `firstNumber` for why all three are required.
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
