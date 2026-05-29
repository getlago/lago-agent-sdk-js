/**
 * CanonicalUsage — normalized usage shape emitted to Lago.
 *
 * Numeric fields default to 0 (never undefined). The emitter only sends events
 * for non-zero numeric fields. Unknown provider fields land in `extras`.
 */

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
