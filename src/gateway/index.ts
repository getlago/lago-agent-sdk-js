/**
 * Gateway connector code — a second front door into the same billing kernel.
 *
 * Maps a third-party gateway's own usage-reporting surface (Cloudflare's Logs API, …)
 * into `CanonicalUsage`. Consumed by a poller, not by `wrap()` — there is no client to
 * patch here.
 *
 * Deliberately separate from the top-level `adapters/`, which extracts usage from a
 * provider-native response inside a wrapped call. The two never import from each other;
 * both target `CanonicalUsage`.
 */
export * from "./adapters/index.js";
// The Databricks reader is the one piece of gateway code that DOES do I/O: Databricks
// exposes no logs API, only Delta tables over the SQL Statement Execution API, and
// hand-rolling that read is ~100 lines with several money-losing traps in it. The
// adapters stay pure; this is their sibling, not their replacement.
export { DatabricksSource, DatabricksUsageRow, floorHour, timestampSql, windowBounds } from "./databricks.js";
export type { DatabricksSourceOptions } from "./databricks.js";
