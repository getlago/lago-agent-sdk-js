/** Public API — Lago Agent SDK (TypeScript). */
export { LagoSDK } from "./sdk.js";
export type { LagoSDKOptions, WrapOptions } from "./sdk.js";

export type { CanonicalUsage } from "./canonical.js";
export { makeCanonicalUsage, NUMERIC_FIELDS, nonzeroNumeric } from "./canonical.js";

export type { LagoConfig, PricingMode } from "./config.js";
export { DEFAULT_COST_METRIC_CODE, DEFAULT_METRIC_CODES, makeConfig } from "./config.js";

export {
  LagoApiError,
  LagoConfigError,
  LagoSDKError,
  PricingUnavailableError,
  UnknownClientError,
} from "./exceptions.js";

export { HttpPricingFetcher, PricingProvider, computeCost } from "./pricing.js";
export type { CostBreakdown, ModelPrice, PricingFetcher } from "./pricing.js";

export {
  extractAnthropicNative,
  extractBedrockConverse,
  extractBedrockInvoke,
  pickInvokeAdapter,
  extractMistralNative,
} from "./adapters/index.js";
export type { InvokeFamily } from "./adapters/index.js";

/** Tier-1 namespace — `lago.wrap(client, opts)` as in spec */
export const lago = {
  wrap<T extends object>(_client: T, _opts: import("./sdk.js").WrapOptions = {}): T {
    throw new Error(
      "lago.wrap() requires a LagoSDK instance — use `new LagoSDK({...}).wrap(client, opts)` instead. " +
        "The bare `lago.wrap()` shorthand from spec is reserved for a future module-level convenience.",
    );
  },
};
