/** `@getlago/agent-sdk/core` — the billing engine as a consumable surface.
 *
 * Everything a gateway (or any non-wrapper consumer) needs to turn a raw
 * provider payload into delivered Lago events, without a LagoSDK instance:
 * usage extraction → CanonicalUsage → pricing (+ markup, never-under-bill)
 * → event building (transaction_id at build time) → transport.
 *
 * The wrapper-based SDK surface stays in the root export and is unchanged.
 */

// Canonical usage
export type { CanonicalUsage } from "./canonical.js";
export { makeCanonicalUsage, NUMERIC_FIELDS, nonzeroNumeric } from "./canonical.js";

// Provider usage extraction (raw payload → CanonicalUsage)
export {
  extractAnthropicNative,
  extractBedrockConverse,
  extractBedrockInvoke,
  pickInvokeAdapter,
  extractGeminiNative,
  extractMistralNative,
  extractOpenAINative,
} from "./adapters/index.js";
export type { InvokeFamily } from "./adapters/index.js";
export { detectClientKind } from "./detector.js";
export type { ClientKind } from "./detector.js";

// Pricing
export {
  HttpPricingFetcher,
  PricingProvider,
  computeCost,
  coerceMarkup,
  parseOpenRouter,
} from "./pricing.js";
export type { CostBreakdown, ModelPrice, OpenRouterTable, PricingFetcher } from "./pricing.js";

// Event building
export { buildCostEvent, buildTokenEvents } from "./events.js";
export type { BuildEventOptions } from "./events.js";

// Delivery
export type { LagoEvent } from "./lago_client.js";
export { LagoClient } from "./lago_client.js";
export { EventQueue } from "./queue.js";
export type { EventTransport, PushResult } from "./transport.js";

// Config + errors
export type { LagoConfig, PricingMode } from "./config.js";
export { DEFAULT_COST_METRIC_CODE, DEFAULT_METRIC_CODES, makeConfig } from "./config.js";
export {
  LagoApiError,
  LagoConfigError,
  LagoSDKError,
  PricingUnavailableError,
  UnknownClientError,
} from "./exceptions.js";
