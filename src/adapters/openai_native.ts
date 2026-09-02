/**
 * OpenAI native adapter — Chat Completions and the Responses API, told apart by the
 * shape of `usage` (they carry the same concepts under different field names).
 *
 * Billing semantics that are NOT visible from the field names:
 *   - For OpenAI itself, `cache_read` is counted INSIDE `input`, and `reasoning` INSIDE
 *     `output`. Summing them as separate metrics double-counts — see
 *     `INPUT_INCLUDES_CACHE_READ` / `OUTPUT_INCLUDES_REASONING` in token_semantics.ts.
 *     Other providers answer on the same wire with the OPPOSITE convention; the
 *     total_tokens reconciliation below keys off that table per provider.
 *   - No cache_write counts exist: OpenAI auto-caches without surfacing creation.
 *   - `accepted_prediction_tokens` is a subset of `completion_tokens` and is skipped to
 *     avoid double-counting. `rejected_prediction_tokens` is real extra cost we do not
 *     bill; a customer using Predicted Outputs must read it off the response.
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";
import { tokenSemantics } from "../token_semantics.js";
import { resolveModel } from "./_common.js";

// Cloudflare Workers AI names every model "@cf/<vendor>/<model>". Reaching one
// through the gateway's OpenAI-compatible `/compat` endpoint additionally requires
// the "workers-ai/" routing prefix, so the same model arrives under two spellings
// depending on which surface the customer used. `pricing.lookupCloudflareWorkersAi`
// strips the routing prefix before matching, because Cloudflare's own catalog lists
// only the bare form.
const WORKERS_AI_MODEL_PREFIX = "@cf/";
const WORKERS_AI_COMPAT_PREFIX = "workers-ai/";

/**
 * Provider stamped on any call that reached a model through Ramp Router.
 *
 * Router is an OpenAI-Responses-compatible gateway in front of OpenAI, Anthropic, Google
 * Vertex, Fireworks and xAI. It is treated as a provider in its own right here, rather
 * than resolved to the vendor that actually served the call, because Router's model ids
 * are ACCOUNT-SPECIFIC and opaque — its docs are explicit: "Valid model IDs are
 * account-specific. They come from `GET /v1/models`. Never invent one or reuse a
 * provider's public model name." So unless the caller named an explicit
 * `provider:provider-model` candidate, nothing in the response says who served it, and
 * the model-string rule `inferProvider` uses cannot see it.
 *
 * "ramp_router" is in `TOKEN_BILLED_PROVIDERS` and deliberately in neither `VENDOR_MAP`
 * nor the token-semantics subset sets. Two distinct things would otherwise go wrong at
 * once:
 *
 *   - A price lookup under a guessed vendor can be flatly wrong. Router bills at list
 *     price on its shared key but $0 for a BYOK-served request, and a non-default service
 *     tier bills at a rate its own catalog says "may differ" from the base one.
 *   - The overlap semantics belong to ROUTER, not to the served vendor. Measured
 *     2026-08-28 on an Anthropic-served model — the case that would diverge if anything
 *     did: Router normalizes the NUMBERS to OpenAI's convention, not just the schema
 *     (cached block INSIDE input, reasoning inside output; fixtures
 *     06b_real_cache_control_warm.json / 07_real_reasoning.json). So stamping the served
 *     vendor would de-overlap with the WRONG convention whenever that vendor's native
 *     one differs — "ramp_router" carries its own OPENAI_SHAPED_APIS entry instead.
 *
 * Token mode is unaffected and exact either way: it emits the counts Router reported.
 * Price mode routes to those same token events via `TOKEN_BILLED_PROVIDERS`, with no
 * per-call price-miss report — a structural, permanent miss must not cry wolf on the
 * error hook (the same decision Databricks and Snowflake got). The catalog DOES publish
 * per-model rates (`router.pricing`, 01_real_models_catalog.json), so a Router price
 * mode is buildable — but the response still cannot say whether a BYOK key served the
 *     call ($0) or which tier rate applied, so token counts stay the honest default.
 */
export const RAMP_ROUTER_PROVIDER = "ramp_router";

/**
 * Router's documented service tiers, appearing as the third segment of a REQUESTED
 * candidate id (`openai:gpt-5.4-mini:flex`). OpenAI sells `auto`/`default`/`flex`/
 * `priority`, Fireworks `default`/`priority`.
 *
 * Only used to disambiguate that candidate suffix. The tier a response actually reports
 * arrives in its own top-level `service_tier` field and is recorded verbatim.
 *
 * Matched against this set rather than read as "whatever follows the last colon": a model
 * segment may contain a colon of its own, and mistaking one for a tier would silently
 * rename the model and split it into a second row in Lago. An unrecognized trailing
 * segment therefore stays part of the model, which is recoverable; a renamed model is
 * not.
 */
const ROUTER_SERVICE_TIERS = new Set(["auto", "default", "flex", "priority"]);

/** A provider segment is a short lowercase token. Anything else is part of the model. */
const ROUTER_PROVIDER_SEGMENT = /^[a-z0-9][a-z0-9_-]{1,31}$/;

interface RouterModelParts {
  /** Router's own provider name, or "" when the id is an opaque account-specific one. */
  provider: string;
  /** The model, with the provider prefix and any service tier removed. */
  model: string;
  /** The pinned service tier, or "" when none was named. */
  tier: string;
}

/**
 * Split a Router model id into its provider, model and service-tier parts.
 *
 * Router names a model two ways, and only one of them is parseable. A plain `model` is an
 * account-specific id that reveals nothing; a `models` candidate is
 * `provider:provider-model[:service-tier]`.
 *
 * This is a FALLBACK, not the live path. Router resolves whatever was requested to a bare
 * vendor snapshot before answering — every captured response reports
 * `gpt-5.4-nano-2026-03-17` or `claude-haiku-4-5-20251001`, never a compound candidate —
 * and `resolveModel` prefers the response's model over the requested one. So this fires
 * only when the response carries no model at all and the caller's requested id falls
 * through. It is kept because that fallthrough would otherwise publish
 * `openai:gpt-5.4-mini:flex` as a Lago model name; it is not where the served tier comes
 * from. See the `service_tier` read in `extractOpenAINative`.
 *
 * Split on the FIRST colon, never on all of them: Fireworks candidates carry a path as
 * their model segment (`fireworks:accounts/fireworks/models/kimi-k2p7-code`), so a naive
 * split loses everything after the second separator.
 *
 * The model comes back BARE, provider prefix and tier stripped, so a model served through
 * Router rolls up in Lago against the same name a direct call to it reports. Leaving the
 * prefix on splits one model across two rows for no billing benefit.
 */
function parseRouterModel(id: string): RouterModelParts {
  const firstColon = id.indexOf(":");
  if (firstColon <= 0) return { provider: "", model: id, tier: "" };

  const head = id.slice(0, firstColon).toLowerCase();
  let rest = id.slice(firstColon + 1);
  // A head that is not a plausible provider token — a path, or something long — means
  // this is an opaque id that merely happens to contain a colon, not a candidate.
  if (!rest || !ROUTER_PROVIDER_SEGMENT.test(head)) return { provider: "", model: id, tier: "" };

  let tier = "";
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > 0) {
    const trailing = rest.slice(lastColon + 1).toLowerCase();
    if (ROUTER_SERVICE_TIERS.has(trailing)) {
      tier = trailing;
      rest = rest.slice(0, lastColon);
    }
  }
  return { provider: head, model: rest, tier };
}

const KNOWN_USAGE_FIELDS = new Set<string>([
  // chat completions
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_tokens_details",
  "completion_tokens_details",
  // responses API
  "input_tokens",
  "output_tokens",
  "input_tokens_details",
  "output_tokens_details",
]);

/**
 * Nested keys inside the *_tokens_details sub-objects that we actually MAP onto a
 * CanonicalUsage field. Anything nested that isn't listed here is drift and gets
 * surfaced in `extras` under a dotted key.
 *
 * Sweeping only top-level keys was a real hole: `prompt_tokens_details` is itself
 * a KNOWN top-level key, so nothing inside it was ever inspected. A live
 * gpt-5.6-sol response carries `prompt_tokens_details.cache_write_tokens: 3022`
 * and those 3022 tokens vanished with no error — a silent violation of the drift
 * contract drift.test.ts exists to pin, which passed only because it never looked
 * one level down.
 *
 * NOTE the billing subtlety: cache_write_tokens must NOT be mapped to
 * CanonicalUsage.cache_write. For OpenAI it sits INSIDE prompt_tokens (measured:
 * prompt_tokens=3025 with cache_write_tokens=3022) and bills at the plain input
 * rate — Databricks charged exactly what billing all 3025 as input produces. But
 * OpenRouter does publish a separate cache_write rate for the model, so mapping it
 * would charge those tokens twice: $0.0341 against a true $0.0152, a 2.24x
 * over-bill. Anthropic is the opposite — its cache_creation_input_tokens sits
 * OUTSIDE input_tokens, which is why mapping is correct there and wrong here.
 * Surfacing in extras keeps the field visible without touching the money.
 */
const MAPPED_DETAIL_FIELDS: Record<string, Set<string>> = {
  prompt_tokens_details: new Set(["cached_tokens", "audio_tokens"]),
  input_tokens_details: new Set(["cached_tokens", "audio_tokens"]),
  completion_tokens_details: new Set(["reasoning_tokens", "audio_tokens"]),
  // NOTE `output_tokens_details` deliberately omits `audio_tokens`: the Responses branch
  // hardcodes `audioOutput = 0` because the API does not expose it today, so listing it
  // here would exclude a real, unmapped count from `extras` — 500 audio tokens vanishing
  // with no error, the exact hole this table closes. Add it back only together with a
  // Responses branch that reads it.
  output_tokens_details: new Set(["reasoning_tokens"]),
};

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function countChatToolCalls(resp: Record<string, unknown>): number {
  const choices = resp.choices;
  if (!Array.isArray(choices) || choices.length === 0) return 0;
  const first = choices[0];
  if (!isObject(first)) return 0;
  const message = isObject(first.message) ? first.message : {};
  const tcs = message.tool_calls;
  return Array.isArray(tcs) ? tcs.length : 0;
}

function countResponsesToolCalls(resp: Record<string, unknown>): number {
  const output = resp.output;
  if (!Array.isArray(output)) return 0;
  let n = 0;
  for (const item of output) {
    if (isObject(item) && item.type === "function_call") n++;
  }
  return n;
}

/**
 * The response shape says "OpenAI-compatible", never who served it. Through a gateway's
 * compat endpoint the model string is the only signal: `@cf/...` is Workers AI naming,
 * never a real OpenAI model. `provider` is what price mode keys off, and Workers AI
 * prices against Cloudflare's catalog rather than OpenRouter, so stamping "openai" here
 * makes the call quietly unpriceable at the extraction layer.
 *
 * BOTH spellings must match: the documented form is provider-prefixed
 * (`workers-ai/@cf/...`), and that is also what a streaming call reports, since the
 * synthetic usage payload carries no model and `resolveModel` falls back to the
 * requested string verbatim.
 */
function inferProvider(resolvedModel: string): string {
  return resolvedModel.startsWith(WORKERS_AI_MODEL_PREFIX) ||
    resolvedModel.startsWith(`${WORKERS_AI_COMPAT_PREFIX}${WORKERS_AI_MODEL_PREFIX}`)
    ? "workers-ai"
    : "openai";
}

/**
 * Translate an OpenAI response (chat completion or responses API) → CanonicalUsage.
 *
 * Accepts the SDK's pydantic-like objects, dicts (e.g. captured fixtures), or
 * a synthetic `{ usage: {...} }` blob produced by the streaming wrapper.
 *
 * `providerHint` overrides the model-string inference. Only the wrapper can supply
 * it, because the only reliable signal for some gateways is the client's `baseURL`
 * — which the response never carries. Databricks is the case that forced it: a
 * Databricks-HOSTED model answers on `/ai-gateway/mlflow/v1` but echoes a
 * served-entity name ("meta-llama-4-maverick-040225") with no marker of its own, so
 * no rule based on the model string can identify it. See `wrappers/openai.ts`.
 */
export function extractOpenAINative(
  response: unknown,
  modelId: string = "",
  providerHint: string = "",
): CanonicalUsage {
  const resp: Record<string, unknown> = isObject(response) ? response : {};
  const usage: Record<string, unknown> = isObject(resp.usage) ? resp.usage : {};

  // Detect which API shape we have. Chat Completions uses prompt_tokens;
  // Responses API uses input_tokens. They never both appear.
  const isResponsesApi = "input_tokens" in usage && !("prompt_tokens" in usage);

  interface Extracted {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    // The RAW reported cache-write count, kept out of CanonicalUsage (see
    // MAPPED_DETAIL_FIELDS) and read per-branch from that branch's own details
    // container — the Responses API spells it input_tokens_details, so a single
    // prompt_tokens_details lookup would leave the Responses branch answering the
    // total_tokens reconciliation below differently from the chat branch for the
    // same convention.
    cacheWrite: number;
    reasoning: number;
    audioInput: number;
    audioOutput: number;
    toolCalls: number;
    api: string;
  }

  let extracted: Extracted;
  if (isResponsesApi) {
    const inputDetails = isObject(usage.input_tokens_details) ? usage.input_tokens_details : {};
    const outputDetails = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
    extracted = {
      inputTokens: safeInt(usage.input_tokens),
      outputTokens: safeInt(usage.output_tokens),
      cacheRead: safeInt(inputDetails.cached_tokens),
      cacheWrite: safeInt(inputDetails.cache_write_tokens),
      reasoning: safeInt(outputDetails.reasoning_tokens),
      audioInput: safeInt(inputDetails.audio_tokens),
      audioOutput: 0, // not exposed by Responses API today
      toolCalls: countResponsesToolCalls(resp),
      api: "responses",
    };
  } else {
    const promptDetails = isObject(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const completionDetails = isObject(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : {};
    extracted = {
      inputTokens: safeInt(usage.prompt_tokens),
      outputTokens: safeInt(usage.completion_tokens),
      cacheRead: safeInt(promptDetails.cached_tokens),
      cacheWrite: safeInt(promptDetails.cache_write_tokens),
      reasoning: safeInt(completionDetails.reasoning_tokens),
      audioInput: safeInt(promptDetails.audio_tokens),
      audioOutput: safeInt(completionDetails.audio_tokens),
      toolCalls: countChatToolCalls(resp),
      api: "chat_completions",
    };
  }

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usage)) {
    if (!KNOWN_USAGE_FIELDS.has(k)) extras[k] = v;
  }

  // Drift sweep one level down, into the *_tokens_details sub-objects. Without
  // this, an unrecognized nested field is silently dropped (see
  // MAPPED_DETAIL_FIELDS) because its container is a known top-level key.
  for (const [container, mapped] of Object.entries(MAPPED_DETAIL_FIELDS)) {
    const sub = usage[container];
    if (!isObject(sub)) continue;
    for (const [k, v] of Object.entries(sub)) {
      if (!mapped.has(k)) extras[`${container}.${k}`] = v;
    }
  }

  const resolvedModel = resolveModel(resp.model, modelId);
  const provider = providerHint || inferProvider(resolvedModel);

  // MUST stay ABOVE the totalTokens guard below. The guard asks
  // `tokenSemantics(provider, api)` the same convention question `computeCost` and
  // `deoverlappedTokenTotal` ask, and Router is the one surface here that REASSIGNS
  // `api` mid-function. Read before the reassignment, the guard sees
  // ("ramp_router", "responses") — all-additive — while the money paths see the stamped
  // api="ramp_router" and de-overlap as subset. That divergence is exactly what
  // token_semantics.ts exists to make impossible, and it under-folds a genuine remainder
  // by cacheRead + reasoning, or suppresses the fold entirely when the over-count exceeds
  // the declared total — silently, with no onError.
  //
  // `resolveModel` prefers the response's own model over the requested one, which is what
  // makes a Router fallback bill correctly with no extra work: a `models` request sends no
  // `model` at all, and Switchyard routing can serve a different model than the one asked
  // for, so the response is the only place the SERVED model appears.
  let model = resolvedModel;
  let api = extracted.api;
  if (providerHint === RAMP_ROUTER_PROVIDER) {
    const parts = parseRouterModel(resolvedModel);
    if (parts.provider) {
      model = parts.model;
      // Recorded, not promoted to `provider` — see RAMP_ROUTER_PROVIDER for why the
      // served vendor cannot drive pricing until Router's overlap semantics are measured.
      extras.router_provider = parts.provider;
    }
    // The tier is billing-relevant on its own: Router's catalog says tiers "may use
    // different rates" than the base ones it publishes, so a pinned non-default tier is
    // the difference between a correct price and an over-bill at the standard rate.
    //
    // It is read from the response's OWN top-level `service_tier`, which is where every
    // captured Router response actually reports it (02/04 `flex`, 03/05b/06b/07
    // `default`). The candidate suffix above is only a fallback: Router resolves `model`
    // to a bare vendor snapshot on the way back — `openai:gpt-5.4-nano` in,
    // `gpt-5.4-nano-2026-03-17` out — so on live traffic the suffix parse never fires and
    // reading only it dropped the tier on every real call. Sourcing it from the candidate
    // alone also answers the wrong question: the candidate says what was ASKED for,
    // `service_tier` says what SERVED, and a `models` fallback list can make those differ.
    //
    // NOT filtered through ROUTER_SERVICE_TIERS. That set disambiguates a colon segment
    // that might instead be part of a model name; a dedicated field has no such
    // ambiguity, so a tier Router adds later is recorded rather than dropped.
    const servedTier = resp.service_tier;
    if (typeof servedTier === "string" && servedTier) extras.service_tier = servedTier;
    else if (parts.tier) extras.service_tier = parts.tier;
    // Which of Router's two OpenAI-shaped surfaces answered. Router documents only
    // `/v1/responses` (`/v1/chat/completions` 404s), so a `chat_completions` value here is
    // drift worth seeing rather than a case to handle.
    extras.router_surface = api;
    api = RAMP_ROUTER_PROVIDER;
  }

  // Consistency guard: for genuine OpenAI, total_tokens always equals
  // prompt + completion (reasoning is a SUBSET of completion, never additive).
  // Verified across every fixture under openai_native/ — zero deltas. So a
  // POSITIVE delta means tokens exist that neither named bucket accounts for,
  // which only happens behind an OpenAI-COMPATIBLE proxy that under-reports.
  //
  // Measured on Gemini through Google's own OpenAI-compat layer:
  // prompt_tokens=57, completion_tokens=47, total_tokens=1253 — 1149 real
  // thinking tokens reported nowhere, and no completion_tokens_details to
  // recover them from. Billing prompt+completion drops 92% of the call, at the
  // output rate. Folding the remainder into `output` is the honest read: the
  // provider's own total proves those tokens were generated.
  //
  // Deliberately NOT assigned to `reasoning`: computeCost zeroes reasoning for
  // providers in OUTPUT_INCLUDES_REASONING, so for real OpenAI that would set the
  // field and immediately discard it, recovering nothing.
  //
  // WHAT COUNTS AS ACCOUNTED is a per-provider fact, not a payload fact. The
  // wire is one shape, but the convention behind it splits: OpenAI puts the
  // cache and reasoning counts INSIDE prompt/completion, while Snowflake Cortex
  // answers on the same wire with Anthropic's ADDITIVE convention — measured
  // 2026-08-25, prompt_tokens=7, cached_tokens=4805, completion_tokens=6,
  // total_tokens=4818: the cached block sits OUTSIDE prompt_tokens and INSIDE
  // total_tokens. Accounting for input+output only made those 4,805 cached
  // tokens look unaccounted, so they were folded into `output` — 4,811 reported
  // for a call that generated 6, while the same tokens also shipped as
  // cache_read. 2.0x on the call, 800x on the output line. See
  // 12_snowflake_cortex_cache_chat.json.
  //
  // So the accounted sum adds each subset field exactly when the provider
  // reports it OUTSIDE its parent count, read from the same tokenSemantics
  // table computeCost and deoverlappedTokenTotal bill from — the guard and the
  // money paths cannot answer the convention question differently. It cannot be
  // decided from the payload instead: `accounted <= total` admits a small
  // subtractive cache (folds too little), `cacheRead > inputTokens` rejects a
  // small additive one (folds tokens never generated) — both were tried against
  // real shapes and both leak. And subtracting unconditionally disarms the
  // guard where it is load-bearing: on a SUBSET surface the cache is already
  // inside `input`, so also adding it to the accounted sum eats a genuine
  // remainder — Gemini-compat's own cached+thinking payload would under-fold by
  // exactly the cached count, silently, with no onError.
  //
  // `cacheWrite` is the raw prompt/input_tokens_details count because it is
  // deliberately NOT mapped to CanonicalUsage.cache_write (for OpenAI it sits
  // inside prompt_tokens and billing it separately over-charges 2.24x — see
  // MAPPED_DETAIL_FIELDS), yet an additive cache WRITE would inflate `output`
  // exactly the way the read did. `cache_write_tokens` is the only spelling
  // accounted for — an OpenAI-compat proxy re-reporting Anthropic's
  // `cache_creation_input_tokens` (or `cache_creation.*`) inside a details
  // block would still fold. Known limit: those spellings land in `extras` via
  // the drift sweep, which is the signal to add them HERE, deliberately —
  // deriving the accounting from the sweep itself would assume every unmapped
  // count is additive, the same payload-only guess ruled out above.
  //
  // The residual: an UNRECOGNIZED additive proxy arrives as provider="openai"
  // and folds its cached block, exactly as Cortex did before its baseURL rule
  // existed. The payload carries no convention, so identification (a
  // providerHintFor entry) is the fix — not loosening this arithmetic.
  //
  // A no-op for real OpenAI either way: total always equals prompt + completion.
  const declaredTotal = safeInt(usage.total_tokens);
  if (declaredTotal) {
    // `api`, not `extracted.api` — the latter keeps the pre-Router surface value and would
    // re-open the divergence the block above was moved to close.
    const [incCacheRead, incCacheWrite, incReasoning] = tokenSemantics(provider, api);
    let accounted = extracted.inputTokens + extracted.outputTokens;
    if (!incReasoning) accounted += extracted.reasoning;
    if (!incCacheRead) accounted += extracted.cacheRead;
    if (!incCacheWrite) accounted += extracted.cacheWrite;
    const unaccounted = declaredTotal - accounted;
    if (unaccounted > 0) {
      extracted.outputTokens += unaccounted;
      extras.unaccounted_output_tokens = unaccounted;
    }
  }

  return makeCanonicalUsage({
    input: extracted.inputTokens,
    output: extracted.outputTokens,
    cache_read: extracted.cacheRead,
    reasoning: extracted.reasoning,
    audio_input: extracted.audioInput,
    audio_output: extracted.audioOutput,
    tool_calls: extracted.toolCalls,
    model,
    provider,
    api,
    extras,
  });
}
