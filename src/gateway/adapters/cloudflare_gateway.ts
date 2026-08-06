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
    cache_read: safeInt(usageMeta.input_cached_tokens),
    cache_write: safeInt(usageMeta.input_cache_creation_tokens),
    reasoning: safeInt(usageMeta.reasoningTokens ?? usageMeta.reasoning_tokens),
    model: safeStr(entry.model),
    provider: safeStr(entry.provider),
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
