/**
 * CanonicalUsage — normalized usage shape emitted to Lago.
 *
 * Numeric fields default to 0 (never undefined). The emitter only sends events
 * for non-zero numeric fields. Unknown provider fields land in `extras`.
 */

/**
 * The routing prefix Cloudflare's OpenAI-compatible `/compat` endpoint requires:
 * "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast". The same model therefore
 * arrives under two spellings depending on which surface the customer used, and two
 * unrelated layers need to agree on this string — `adapters/openai_native` decides
 * the PROVIDER from it, and `pricing.lookupCloudflareWorkersAi` strips it before
 * matching, because Cloudflare's own catalog lists only the bare "@cf/..." form.
 *
 * It lives here rather than in either of them because they must never import each
 * other (an adapter is a pure function of a provider response; pricing is SDK state),
 * and because a drift between two copies is a silent unpriced call, not a crash. This
 * module is the natural shared floor: it imports nothing from the package, so there is
 * no cycle in either direction, and depending on it does not pull `pricing`'s ~50KB
 * into a lightweight adapter.
 */
export const WORKERS_AI_COMPAT_PREFIX = "workers-ai/";

export const NUMERIC_FIELDS = [
  "input",
  "output",
  "cache_read",
  "cache_write",
  "cache_write_5m",
  "cache_write_1h",
  "reasoning",
  "tool_calls",
  "image_input",
  "audio_input",
  "audio_output",
] as const;

export type NumericField = (typeof NUMERIC_FIELDS)[number];

export interface CanonicalUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cache_write_5m: number;
  cache_write_1h: number;
  reasoning: number;
  tool_calls: number;
  image_input: number;
  audio_input: number;
  audio_output: number;
  model: string;
  provider: string;
  api: string;
  extras: Record<string, unknown>;
}

export function makeCanonicalUsage(partial: Partial<CanonicalUsage> = {}): CanonicalUsage {
  return {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    reasoning: 0,
    tool_calls: 0,
    image_input: 0,
    audio_input: 0,
    audio_output: 0,
    model: "",
    provider: "",
    api: "",
    extras: {},
    ...partial,
  };
}

export function nonzeroNumeric(u: CanonicalUsage): Record<NumericField, number> {
  const out = {} as Record<NumericField, number>;
  for (const f of NUMERIC_FIELDS) {
    if (u[f] && u[f] > 0) out[f] = u[f];
  }
  return out;
}

/**
 * Fields `nonzeroNumeric` DROPPED for being negative, so the caller can report them.
 *
 * Reachable, unlike most defensive paths here: `CanonicalUsage` is exported and
 * `emit()` takes one directly, which is the documented way to backfill usage the SDK
 * did not intercept. A caller computing a delta wrongly can hand us a negative, and
 * silently dropping it is the one drop path that never reached `onError` — the same
 * gap that was closed for queue overflow and for an unresolvable subscription. Kept
 * as a separate pure query so `CanonicalUsage` stays a dumb shape with no
 * notification channel of its own.
 */
export function negativeNumeric(u: CanonicalUsage): Record<NumericField, number> {
  const out = {} as Record<NumericField, number>;
  for (const f of NUMERIC_FIELDS) {
    if (u[f] && u[f] < 0) out[f] = u[f];
  }
  return out;
}
