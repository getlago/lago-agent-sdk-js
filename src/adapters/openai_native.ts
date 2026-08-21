/**
 * OpenAI native adapter — Chat Completions and the Responses API, told apart by the
 * shape of `usage` (they carry the same concepts under different field names).
 *
 * Billing semantics that are NOT visible from the field names:
 *   - `cache_read` is counted INSIDE `input`, and `reasoning` INSIDE `output`. Summing
 *     them as separate metrics double-counts — see `_INPUT_INCLUDES_CACHE_READ` /
 *     `_OUTPUT_INCLUDES_REASONING` in pricing.
 *   - No cache_write counts exist: OpenAI auto-caches without surfacing creation.
 *   - `accepted_prediction_tokens` is a subset of `completion_tokens` and is skipped to
 *     avoid double-counting. `rejected_prediction_tokens` is real extra cost we do not
 *     bill; a customer using Predicted Outputs must read it off the response.
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";
import { resolveModel } from "./_common.js";

// Cloudflare Workers AI names every model "@cf/<vendor>/<model>". Reaching one
// through the gateway's OpenAI-compatible `/compat` endpoint additionally requires
// the "workers-ai/" routing prefix, so the same model arrives under two spellings
// depending on which surface the customer used. `pricing.lookupCloudflareWorkersAi`
// strips the routing prefix before matching, because Cloudflare's own catalog lists
// only the bare form.
const WORKERS_AI_MODEL_PREFIX = "@cf/";
const WORKERS_AI_COMPAT_PREFIX = "workers-ai/";

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

  // Consistency guard: for genuine OpenAI, total_tokens always equals
  // prompt + completion (reasoning is a SUBSET of completion, never additive).
  // Verified across every captured real OpenAI-shaped response — zero deltas.
  // So a POSITIVE delta means tokens exist that neither named bucket accounts
  // for, which only happens behind an OpenAI-COMPATIBLE proxy that under-reports.
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
  // `reasoning` is subtracted from the accounted total, and that subtraction is
  // load-bearing rather than cosmetic. This adapter no longer only ever emits
  // provider="openai" — it also emits "workers-ai" (Cloudflare `/compat`) and
  // "databricks" (via providerHint), and for those computeCost bills reasoning
  // ADDITIVELY. A payload reporting both `reasoning_tokens` and an inflated
  // `total_tokens` would then be charged for them twice: once inside the grown
  // `output` and again as a separate reasoning line. Subtracting first means a
  // provider that already broke reasoning out gets no second bill, while the case
  // this guard exists for — a thinking model behind a proxy that reports NO
  // breakdown at all (measured: prompt 57, completion 47, total 1253) — still
  // recovers its 1,149 tokens, because reasoning is 0 there.
  //
  // A no-op for real OpenAI either way: total always equals prompt + completion.
  const declaredTotal = safeInt(usage.total_tokens);
  if (declaredTotal) {
    const unaccounted =
      declaredTotal - (extracted.inputTokens + extracted.outputTokens + extracted.reasoning);
    if (unaccounted > 0) {
      extracted.outputTokens += unaccounted;
      extras.unaccounted_output_tokens = unaccounted;
    }
  }

  const resolvedModel = resolveModel(resp.model, modelId);

  return makeCanonicalUsage({
    input: extracted.inputTokens,
    output: extracted.outputTokens,
    cache_read: extracted.cacheRead,
    reasoning: extracted.reasoning,
    audio_input: extracted.audioInput,
    audio_output: extracted.audioOutput,
    tool_calls: extracted.toolCalls,
    model: resolvedModel,
    provider: providerHint || inferProvider(resolvedModel),
    api: extracted.api,
    extras,
  });
}
