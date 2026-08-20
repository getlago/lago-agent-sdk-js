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
