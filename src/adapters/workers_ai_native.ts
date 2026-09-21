/**
 * Workers AI `/ai/run` adapter — maps a run response to CanonicalUsage.
 *
 * Verified against real captures (fixtures/workers_ai/, 2026-09-21) of the model-in-body
 * route `POST /accounts/{id}/ai/run {"model": ..., "input": {...}}`. That route matters
 * because it is the only one that reaches every Workers AI model: partner models such as
 * `typesafe/jev` have no `@cf/` prefix and the path-style `/ai/run/{model}` answers "No
 * route for that URI" for them, as does the gateway's `/compat` endpoint, which requires
 * a `messages` array the model rejects.
 *
 * Two usage vocabularies come back from the one endpoint:
 *
 *   chat models    result.usage.prompt_tokens / completion_tokens / total_tokens
 *                  result.usage.prompt_tokens_details.cached_tokens
 *                  result.usage.neurons                               (01-04, 06, 07)
 *   typesafe/jev   result.result.usage.input_tokens / output_tokens   (05: one level
 *                  deeper — a partner model's answer is wrapped as
 *                  `result: {state, result: {model, answers, usage}, gatewayMetadata}`;
 *                  08 is the same object straight from TypeSafe's API, unwrapped)
 *
 * The REQUESTED model id is the one carried, not the served name — the opposite of the
 * native adapters' rule, for a measured reason. Cloudflare's price catalog is keyed by the
 * id you request, and the served name drifts from it in ways the catalog's version-strip
 * fallback does not cover: `@cf/mistralai/mistral-small-3.1-24b-instruct` answers as
 * `...-24b-v2` (04) and that name MISSES the catalog while the requested id prices;
 * `typesafe/jev` answers as `jev-1.13.0` (05, 08). The served name is kept in
 * `extras.served_model` when it differs, so nothing is lost — only the billing key stays
 * the one Cloudflare itself bills by.
 *
 * `neurons` is Cloudflare's own billing unit, not a token count: it lands in `extras`
 * and is never a metric. `gatewayMetadata` (`keySource: "BYOK"` on 05) says whose key paid
 * for the call and lands in `extras` too — under BYOK Cloudflare charged nothing and the
 * partner bills the customer directly, which matters to anyone reconciling against the
 * Cloudflare dashboard. A reasoning model (02, deepseek-r1-distill) bundles its thinking
 * into `completion_tokens` with no separate field, so `reasoning` stays 0 — the same
 * shape Magistral has on Mistral. `cached_tokens` is a subset of `prompt_tokens`, which
 * is why "workers-ai" sits in `INPUT_INCLUDES_CACHE_READ`.
 *
 * A failure body (402 no credits / 403 not on plan / 400 no such model — seen live, not
 * kept as fixtures) carries `result: {}` and `errors: [...]`. The adapter yields an all-zero
 * usage for it rather than throwing — it is a pure function and cannot know the HTTP status;
 * the client decides what a failure means.
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";

// Every `usage` key this adapter maps or deliberately ignores. Anything else is drift
// and is swept into `extras.usage` — never silently dropped, never miscounted.
const KNOWN_USAGE_KEYS = new Set<string>([
  // chat models
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_tokens_details",
  // typesafe/jev
  "input_tokens",
  "output_tokens",
  // Cloudflare's billing unit — kept in extras, not a metric
  "neurons",
]);
const KNOWN_DETAIL_KEYS = new Set<string>(["cached_tokens"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeDict(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Translate a Workers AI `/ai/run` response body → CanonicalUsage.
 *
 * Accepts the full envelope (`{result: {...}, success: true, ...}`) or the bare `result`
 * object. `modelId` is the model the caller requested and is the id carried (see the
 * module comment); the served name, when it differs, lands in `extras.served_model`.
 */
export function extractWorkersAINative(response: unknown, modelId: string = ""): CanonicalUsage {
  const payload = safeDict(response);
  let result = Object.keys(safeDict(payload.result)).length ? safeDict(payload.result) : payload;
  const gatewayMeta = safeDict(result.gatewayMetadata);
  const inner = safeDict(result.result);
  if (Object.keys(inner).length && ("usage" in inner || "answers" in inner)) {
    // Partner-model envelope (05): the model's own object sits one level down.
    result = inner;
  }
  // The envelope may also carry `usage` at the top level; check both so a shape change
  // moves nothing to zero.
  const usage = Object.keys(safeDict(result.usage)).length ? safeDict(result.usage) : safeDict(payload.usage);
  const details = safeDict(usage.prompt_tokens_details);

  const extras: Record<string, unknown> = {};
  if (Object.keys(gatewayMeta).length) extras.gateway_metadata = gatewayMeta;
  const served = result.model;
  if (typeof served === "string" && served && served !== modelId) extras.served_model = served;
  if ("neurons" in usage) extras.neurons = usage.neurons;
  const drift: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usage)) if (!KNOWN_USAGE_KEYS.has(k)) drift[k] = v;
  const detailDrift: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) if (!KNOWN_DETAIL_KEYS.has(k)) detailDrift[k] = v;
  if (Object.keys(detailDrift).length) drift.prompt_tokens_details = detailDrift;
  if (Object.keys(drift).length) extras.usage = drift;

  return makeCanonicalUsage({
    input: safeInt(usage.prompt_tokens) || safeInt(usage.input_tokens),
    output: safeInt(usage.completion_tokens) || safeInt(usage.output_tokens),
    cache_read: safeInt(details.cached_tokens),
    model: modelId || (typeof served === "string" ? served : ""),
    provider: "workers-ai",
    api: "workers_ai_run",
    extras,
  });
}
