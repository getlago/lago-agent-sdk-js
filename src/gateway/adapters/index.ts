export { extractCloudflareLog, resolveSubscription } from "./cloudflare_gateway.js";
// `resolveSubscription` predates the second gateway and reads Cloudflare's
// `cf-aig-metadata`. Re-exported under an explicit name too, so the two gateways read
// symmetrically at the call site and neither is the implicit default.
export { resolveSubscription as resolveCloudflareSubscription } from "./cloudflare_gateway.js";
export { extractDatabricksLog, resolveDatabricksSubscription } from "./databricks_gateway.js";
export { extractSnowflakeRestLog, resolveSnowflakeSubscription } from "./snowflake_cortex.js";
export type { SnowflakeSubscriptionSource } from "./snowflake_cortex.js";
