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
// Snowflake is the same situation as Databricks and for the same reason: no logs API,
// only ACCOUNT_USAGE views over the SQL Statement Execution API. Its window helpers are
// deliberately NOT re-exported under the Databricks names — `floorHour` above is
// Databricks', and one shared spelling would hide which reader's rules apply.
export {
  FUNCTIONS_COLUMNS,
  REST_COLUMNS,
  SnowflakeSource,
  SnowflakeUsageRow,
  floorHour as snowflakeFloorHour,
  timestampSql as snowflakeTimestampSql,
  windowBounds as snowflakeWindowBounds,
} from "./snowflake.js";
export type { DeferredRow, ReadUsageOptions, SnowflakeSourceOptions, SnowflakeView } from "./snowflake.js";

// NO RAMP ROUTER ADAPTER, deliberately, and this is the note saying so rather than an
// omission to rediscover later.
//
// Router is the first gateway this SDK supports that exposes no programmatic usage
// surface at all. Checked against every page of its documentation: the only routes are
// `GET /v1/models`, `POST /v1/responses`, `POST /v1/messages` and
// `POST /v1/messages/count_tokens`. Usage lives in the dashboard's Logs view, and
// `guides/monitor` describes what that view DISPLAYS — model, provider, status, tokens,
// cost, latency, ids, API key, token breakdown, metadata, service tier, fallback
// candidates — without offering any way to fetch it.
//
// An "analytics API" is referenced exactly once in the whole corpus, in the limits table
// on `api/errors-and-limits` ("the analytics API accepts at most 93 days"), with no path,
// no auth and no record shape. That is not enough to build against: an adapter written
// over guessed field names would have tests proving only that it matches the guess, and
// the fixtures behind it would not be captures of anything.
//
// So Router's live `wrap()` path is the whole integration for now. When the analytics API
// is published, the adapter goes here as `extractRampRouterLog` /
// `resolveRampRouterSubscription` alongside the Cloudflare pair, keyed for idempotent
// replay off whatever per-record id it exposes. Tracked as LAGO-1853, which also carries
// the questions to ask Router.
