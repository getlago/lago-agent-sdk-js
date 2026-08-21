/**
 * Databricks AI Gateway usage adapter — maps a `system.ai_gateway.usage` row to CanonicalUsage.
 *
 * Verified against real rows read from a live workspace over the SQL Statement
 * Execution API (226 rows, all 36 columns; the public docs undercount at ~28 and
 * omit `service_*`, `mcp_metadata`, `routing_information`, `invocation_metadata`).
 *
 * Unlike Cloudflare, Databricks exposes no REST logs API — usage lands in a Unity
 * Catalog Delta table queried over SQL. The row reaches this function as a plain
 * object: `@databricks/sql` yields column-keyed objects natively,
 * `databricks-sql-connector` yields Row objects with `.asDict()`, and the raw
 * Statement Execution API returns columnar `data_array` the caller zips. All three
 * end up here as `{columnName: value}`.
 *
 * Field mapping (`system.ai_gateway.usage`):
 *   input_tokens                                  -> input
 *   output_tokens                                 -> output
 *   token_details.cache_read_input_tokens         -> cache_read
 *   token_details.cache_creation_input_tokens     -> cache_write
 *   token_details.output_reasoning_tokens         -> reasoning
 *   token_details.<anything else>                 -> extras["token_details.<key>"]
 *   destination_type + destination_name/_model    -> model, provider  (see below)
 *   api                                            -> hardcoded "databricks_gateway"
 *   extras                                         -> routing/identity columns
 *
 * `total_tokens` is deliberately NOT mapped: it is derived from the others and
 * mapping it would double-count. Same reason the Cloudflare adapter skips
 * `usage_metadata.total_tokens`.
 *
 * TWO MEASURED QUIRKS drive the shapes below. Both were wrong in an earlier draft
 * of this connector that reasoned from the docs alone.
 *
 * 1. `destination_name` means DIFFERENT things per destination type. For a hosted
 *    model it is the model (`system.ai.llama-4-maverick`); for BYOK it is the
 *    PROVIDER SERVICE (`workspace.default.anthropickey`) — a credential name, not
 *    a model. So a single "model, falling back to name" rule yields a credential
 *    as the model for every BYOK row.
 *
 * 2. `destination_model` is unstable for hosted models. The same
 *    `destination_name` was observed reporting both `llama-4-maverick` and
 *    `Llama 4 Maverick` — a human display label with spaces and capitals — and
 *    likewise `gpt-oss-20b` / `GPT OSS 20B`. It is clean and stable for BYOK
 *    (`claude-sonnet-4-5`, `gpt-4o`), so it is authoritative there and unusable
 *    for hosted.
 *
 * BILLING HAZARD, documented because it is the inverse of every other adapter
 * here: this table's `input_tokens` INCLUDES both cache_read and cache_write,
 * where the providers' own response bodies EXCLUDE them. Measured per row —
 * `input=1825, cache_read=1812` for a call whose response body reported
 * `input_tokens: 13`. Only one of cache_read/cache_write is ever non-zero per row,
 * so `input - cache_read - cache_write` recovers the true non-cached input exactly.
 * This adapter extracts the row FAITHFULLY and does not subtract: the intended
 * billing path takes Databricks' own metered USD from
 * `system.ai_gateway.external_model_spend` via `emit(usdCost)`, which never touches
 * token counts. Computing cost from these tokens instead would over-bill 3.04x with
 * no subtraction, or 1.40x subtracting only cache_read.
 *
 * If a computed fallback is ever added, the correction needs BOTH keys, not one.
 * `api === "databricks_gateway"` alone distinguishes a table row from a live call (a
 * `provider="anthropic"` row from this table needs correcting; a live
 * `provider="anthropic"` call must not) — but it is not sufficient, because
 * `computeCost` ALREADY subtracts cache_read for providers in
 * INPUT_INCLUDES_CACHE_READ. So an openai/gemini row must pass through untouched while
 * an anthropic row must be pre-subtracted. Measured by getting it wrong: correcting an
 * openai row double-subtracts and billed $0.00354 against a true $0.004065, a 13%
 * UNDER-bill.
 *
 * Failed calls (403/404, and every Gemini call while that connection is broken) are
 * recorded with NULL token counts. They extract to all-zero, so `nonzeroNumeric()`
 * is empty and the caller emits nothing — the same way a Cloudflare cache hit
 * extracts to zero.
 */

import { CanonicalUsage, makeCanonicalUsage } from "../../canonical.js";

// Databricks' own name for a first-party pay-per-token foundation model. Any other
// destination type (observed: "EXTERNAL_FOUNDATION_MODEL", or NULL on rows rejected
// before routing) is BYOK — the customer's own vendor credential behind a Unity
// Catalog connection.
const HOSTED_DESTINATION_TYPE = "PAY_PER_TOKEN_FOUNDATION_MODEL";

// Unity Catalog prefix on every hosted model's `destination_name`.
const HOSTED_NAME_PREFIX = "system.ai.";

// A second, INNER prefix that most hosted entities also carry:
// `system.ai.databricks-claude-sonnet-4-5`, `system.ai.databricks-qwen35-122b-a10b`.
// Measured on a live workspace: 38 of 48 distinct hosted `destination_name`s have it
// and 10 do not (`system.ai.gpt-oss-20b`, `system.ai.llama-4-maverick`, ...). It is a
// serving-endpoint naming artefact, not part of the model id — leaving it in emits
// `databricks-qwen35-122b-a10b` as the model, which both reads as a vendor prefix and
// splits one model into two rows in Lago against the live path's own name.
//
// It is NOT safe to strip unconditionally: Databricks also publishes models whose own
// names begin the same way (`databricks-dbrx-instruct`, `databricks-dolly-v2`), and no
// amount of string inspection tells the two apart. `destination_model` does — it was
// the clean name on all 38 prefixed rows — so the prefix comes off only when the two
// columns agree that it is an artefact. Disagreement keeps the raw name: a model
// emitted under a slightly ugly id is recoverable, a silently renamed one is not.
const HOSTED_ENDPOINT_PREFIX = "databricks-";

// Keys inside the `token_details` STRUCT that this adapter MAPS onto a CanonicalUsage
// field. Anything else nested there is drift and is surfaced in `extras` under a dotted
// key rather than dropped.
//
// The column is read by name, so nothing ever inspects a key the mapping below does not
// name — measured against the real table with the struct evolved by two fields
// (`cache_read_5m_input_tokens: 77`, `output_audio_tokens: 42`): they reached neither a
// numeric field nor `extras`, so 119 tokens vanished with no error and no `onError`.
// Latent today — the live struct has exactly the three fields listed here — but this
// table's schema does evolve (`service_type`, `mcp_metadata`, `invocation_metadata` are
// newer additions, and old rows still read `service_type = NULL`).
//
// Dotted key, not the object swept whole under `extras["token_details"]`, for the same
// reason as openai_native's `MAPPED_DETAIL_FIELDS`: three of the struct's keys ARE
// mapped, so emitting the container whole would re-publish counts already billed.
const MAPPED_DETAIL_FIELDS = new Set([
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_reasoning_tokens",
]);

/**
 * Coerce a STRUCT/MAP column to an object, accepting either shape it arrives in.
 *
 * The SQL drivers hand back real objects, but the raw Statement Execution API
 * serializes STRUCT and MAP columns as JSON STRINGS — measured: `token_details`
 * arrives as '{"cache_read_input_tokens":1812}'. Tolerating both means the adapter
 * works whichever access path the caller chose, rather than silently reading zeros
 * from a string it never parsed.
 */
function safeObj(v: unknown): Record<string, unknown> {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string" && v.trim().startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Coerce to a non-negative integer. Token columns arrive as STRINGS over the REST
 * API ("1825") and as NULL on failed calls; both must land on 0 rather than throw.
 */
function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Exported for `gateway/databricks.ts`, which joins the two tables on string keys and
// must coerce them identically to the adapter or every BYOK row misses its tokens.
export function safeStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Resolve [model, provider] — type-dependent, for the reasons in the module docs. */
function modelAndProvider(row: Record<string, unknown>): [string, string] {
  const destinationType = safeStr(row.destination_type);
  const destinationName = safeStr(row.destination_name);

  if (destinationType === HOSTED_DESTINATION_TYPE) {
    // `destination_name` is the stable id here; `destination_model` flips between a
    // slug and a display label for the very same model — measured,
    // `system.ai.gpt-oss-20b` reports both "gpt-oss-20b" and "GPT OSS 20B".
    let model = destinationName;
    if (model.startsWith(HOSTED_NAME_PREFIX)) model = model.slice(HOSTED_NAME_PREFIX.length);
    if (model.startsWith(HOSTED_ENDPOINT_PREFIX)) {
      const shed = model.slice(HOSTED_ENDPOINT_PREFIX.length);
      if (shed === safeStr(row.destination_model)) model = shed;
    }
    // Deliberately "databricks", which matches no vendor in pricing's VENDOR_MAP —
    // so a price lookup CANNOT hit and emit() emits token counts instead (see
    // TOKEN_BILLED_PROVIDERS — no error, since no rate exists to miss), rather than
    // silently pricing a DBU-billed model at
    // some other vendor's rate. OpenRouter does list bare `openai/gpt-oss-20b` etc.
    // at 0.2-0.4x of Databricks' own rate, so an accidental match here would
    // under-bill 2.5-5x.
    return [model, "databricks"];
  }

  // BYOK: `destination_model` is the clean requested alias, and `api_type` names the
  // native surface the call went through — "anthropic/v1/messages",
  // "openai/v1/chat/completions", "gemini/v1/generateContent". Its leading segment
  // already IS this SDK's provider vocabulary, so no alias table is needed.
  // "unmanaged" (an unrecognized path) yields "unmanaged", which no vendor matches —
  // an honest miss, and those rows carry no usage anyway.
  const provider = safeStr(row.api_type).split("/")[0] ?? "";
  return [safeStr(row.destination_model), provider];
}

/**
 * Translate one `system.ai_gateway.usage` row into CanonicalUsage.
 *
 * Missing/malformed fields degrade to zero/empty rather than throwing, matching the
 * defensive style of the other adapters — a backfill processing a batch of rows must
 * not have one malformed row take down the whole run.
 */
export function extractDatabricksLog(row: Record<string, unknown>): CanonicalUsage {
  const details = safeObj(row.token_details);
  const [model, provider] = modelAndProvider(row);

  const extras: Record<string, unknown> = {
    // `invocation_id` is per individual inference call while `request_id` is per
    // request — one request with a fallback produces several invocations, the same
    // distinction Cloudflare's `step` marks. Keep both; `invocation_id` is the
    // row's natural idempotency key.
    request_id: row.request_id,
    invocation_id: row.invocation_id,
    // A THIRD naming variant: `endpoint_name` is the requested form
    // (`databricks-llama-4-maverick`, `system.ai.gemma-3-12b`) where
    // `destination_name` is the resolved entity (`system.ai.gemma-3-12b-it`).
    // Kept for reconciliation; never price off it.
    endpoint_name: row.endpoint_name,
    endpoint_id: row.endpoint_id,
    destination_type: row.destination_type,
    destination_name: row.destination_name,
    api_type: row.api_type,
    status_code: row.status_code,
  };

  // Drift sweep one level down, into `token_details` (see MAPPED_DETAIL_FIELDS). A new
  // key there is a token count nobody has classified yet: it must not be miscounted as
  // one of the metrics above, and it must not disappear either.
  //
  // Scope, measured over the live 2026-08-06 window: it reaches every hosted event
  // (54 of 54) and no BYOK event (0 of 66), because `asBucket` strips per-request extras
  // from an hourly spend aggregate on purpose. Both tables share this struct, so a new
  // field still surfaces wherever the workspace has hosted traffic.
  for (const [k, v] of Object.entries(details)) {
    if (!MAPPED_DETAIL_FIELDS.has(k)) extras[`token_details.${k}`] = v;
  }

  return makeCanonicalUsage({
    input: safeInt(row.input_tokens),
    output: safeInt(row.output_tokens),
    cache_read: safeInt(details.cache_read_input_tokens),
    cache_write: safeInt(details.cache_creation_input_tokens),
    reasoning: safeInt(details.output_reasoning_tokens),
    model,
    provider,
    api: "databricks_gateway",
    extras,
  });
}

/**
 * Pull the Lago subscription id from the caller's `request_tags`.
 *
 * Customers set these with the `Databricks-Ai-Gateway-Request-Tags` header (a JSON
 * object of string->string), the direct analogue of Cloudflare's `cf-aig-metadata`.
 * Note they are also a first-class AGGREGATION DIMENSION on
 * `system.ai_gateway.external_model_spend`, so tagging `lago_subscription` yields
 * cost already attributed per subscription — no token-share apportioning needed for
 * BYOK.
 *
 * Returns null if the caller never set `lago_subscription` — untagged calls do
 * produce rows, with `request_tags` empty. The caller decides what to do with an
 * unattributed row (drop it, route to a default, warn); this function only reports
 * whether attribution is present.
 */
export function resolveDatabricksSubscription(row: Record<string, unknown>): string | null {
  const tags = safeObj(row.request_tags);
  const value = tags.lago_subscription;
  return typeof value === "string" && value ? value : null;
}
