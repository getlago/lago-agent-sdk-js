/**
 * Cloudflare AI Gateway log adapter — maps a Logs API entry to CanonicalUsage.
 *
 * Reads both the list and single-entry Logs API shapes. No request-side model kwarg to
 * reconcile: a log entry always names the model that actually served the request.
 *
 * Cloudflare reports its OWN counter vocabulary here, not the provider's, and the set of
 * keys it sends is a moving target: a live Logs API pull returned `units`, which appears
 * in none of the captured fixtures. So the alias lists below are illustrative, not
 * exhaustive — `MAPPED_USAGE_KEYS` plus the drift sweep into `extras.usage_metadata` is
 * what actually keeps an unrecognized counter from being lost, with no re-audit needed.
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

/**
 * Every `usage_metadata` spelling this adapter accounts for: the ones `firstInt`
 * consults, plus the three that are redundant with the top-level `tokens_in` /
 * `tokens_out` read directly. Anything NOT in here is swept into
 * `extras.usage_metadata` rather than dropped — see the drift note on `extras`.
 *
 * Keep in sync with the `firstInt` calls. It is the mechanism that keeps the key list
 * self-maintaining instead of a hand-audited snapshot: a spelling nobody has seen shows
 * up in `extras` on its own.
 */
export const MAPPED_USAGE_KEYS: ReadonlySet<string> = new Set([
  // cache_read
  "input_cached_tokens",
  "inputCachedTokens",
  "cachedContentTokenCount",
  "cache_read_input_tokens",
  // cache_write
  "input_cache_creation_tokens",
  "inputCacheCreationTokens",
  "cache_creation_input_tokens",
  // reasoning
  "reasoningTokens",
  "reasoning_tokens",
  "thoughtsTokenCount",
  // Read from the top level instead, so not drift when they appear here.
  "input_tokens",
  "output_tokens",
  "total_tokens",
]);

/**
 * Any `usage_metadata` key this adapter does not account for, wrapped for `extras`.
 *
 * Returns an empty object when everything was recognized, so the key is absent rather
 * than present-and-empty in the overwhelmingly common case.
 */
function unmappedUsage(usageMeta: Record<string, unknown>): Record<string, unknown> {
  const unmapped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usageMeta)) {
    if (!MAPPED_USAGE_KEYS.has(k)) unmapped[k] = v;
  }
  return Object.keys(unmapped).length ? { usage_metadata: unmapped } : {};
}

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
    //
    // `cache_read_input_tokens` and `thoughtsTokenCount` were missing here while Python
    // consulted both, so the ports disagreed about the same entry: a Gemini native
    // thoughts count read as 0 reasoning in JS and as the real figure in Python. That
    // also has to be fixed before the drift sweep below can mean anything — an alias one
    // port maps and the other sweeps would put the same counter in `extras` on one side
    // and in a canonical field on the other.
    cache_read: firstInt(
      usageMeta,
      "input_cached_tokens",
      "inputCachedTokens",
      "cachedContentTokenCount",
      "cache_read_input_tokens",
    ),
    cache_write: firstInt(
      usageMeta,
      "input_cache_creation_tokens",
      "inputCacheCreationTokens",
      "cache_creation_input_tokens",
    ),
    reasoning: firstInt(usageMeta, "reasoningTokens", "reasoning_tokens", "thoughtsTokenCount"),
    model: safeStr(entry.model),
    provider: normalizeProvider(entry.provider),
    api: "cloudflare_gateway",
    extras: {
      cached: entry.cached,
      step: entry.step,
      log_id: entry.id,
      // Drift sweep — the same contract `drift.test.ts` pins for the native adapters,
      // and for the same reason: a counter this adapter does not map must not vanish
      // without an error or an onError. `extras` used to be exactly the three keys
      // above, so `usage_metadata` got no sweep at all, and that was not hypothetical —
      // replaying the captured fixtures dropped `neurons` (Cloudflare's Workers AI
      // billing unit) and `input_text_tokens`, and a live Logs API pull also returns
      // `units`, a cost quantity present in no fixture. A money-relevant counter going
      // missing this way surfaces first as a reconciliation gap, not as a failure.
      //
      // NESTED, not merged flat into `extras`: the poller reads `extras.cached` to
      // decide whether to skip billing a request Cloudflare served for free, so a future
      // `usage_metadata` key called `cached` or `step` must not be able to shadow it.
      // Omitted entirely when there is no drift, to keep the common case identical to
      // what callers already see.
      ...unmappedUsage(usageMeta),
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
