/** LagoConfig — runtime configuration for the SDK. */

export const DEFAULT_METRIC_CODES: Record<string, string> = {
  input: "llm_input_tokens",
  output: "llm_output_tokens",
  cache_read: "llm_cached_input_tokens",
  cache_write: "llm_cache_creation_tokens",
  cache_write_5m: "llm_cache_write_5m_tokens",
  cache_write_1h: "llm_cache_write_1h_tokens",
  reasoning: "llm_reasoning_tokens",
  tool_calls: "llm_tool_calls",
  image_input: "llm_image_input_tokens",
  audio_input: "llm_audio_input_tokens",
  audio_output: "llm_audio_output_tokens",
};

/** Metric code for the single per-call dollar-cost event emitted in price mode. */
export const DEFAULT_COST_METRIC_CODE = "llm_cost";

/**
 * Pricing mode: emit raw token counts (default, backward-compatible) or a single
 * computed dollar-cost event per call.
 */
export type PricingMode = "tokens" | "price";

export interface LagoConfig {
  apiKey: string;
  apiUrl: string;
  defaultSubscriptionId?: string | null;
  metricCodes: Record<string, string>;
  flushIntervalMs: number;
  maxBatchSize: number;
  maxBufferSize: number;
  requestTimeoutMs: number;
  maxRetryMs: number;
  onError?: (err: unknown, where: string) => void;
  // --- pricing (price mode) ---
  /** Global default mode. "tokens" preserves the existing behavior exactly. */
  pricingMode: PricingMode;
  /** Multiplier applied to the computed cost (1.0 = no markup, 1.2 = +20%). */
  markup: number;
  /** Metric code for the single dollar-cost event emitted in price mode. */
  costMetricCode: string;
  /** How long a fetched pricing table stays fresh before a background refresh. */
  pricingTtlMs: number;
  /** Region used for Bedrock pricing when the model id carries no region prefix. */
  bedrockDefaultRegion: string;
  /** Optional injected PricingProvider (or stub) — primarily for tests/overrides. Typed unknown to avoid a config→pricing import cycle. */
  pricingProvider?: unknown;
}

export function makeConfig(partial: Partial<LagoConfig> & { apiKey: string }): LagoConfig {
  const defaults: Omit<LagoConfig, "apiKey"> = {
    apiUrl: "https://api.getlago.com/api/v1",
    defaultSubscriptionId: null,
    metricCodes: { ...DEFAULT_METRIC_CODES },
    flushIntervalMs: 1000,
    maxBatchSize: 100,
    maxBufferSize: 10_000,
    requestTimeoutMs: 10_000,
    maxRetryMs: 60_000,
    pricingMode: "tokens",
    markup: 1.0,
    costMetricCode: DEFAULT_COST_METRIC_CODE,
    pricingTtlMs: 3_600_000,
    bedrockDefaultRegion: "us-east-1",
  };
  // Spread partial WITHOUT letting undefined values clobber defaults
  const filtered: Partial<LagoConfig> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) (filtered as Record<string, unknown>)[k] = v;
  }
  return { ...defaults, ...filtered, apiKey: partial.apiKey };
}
