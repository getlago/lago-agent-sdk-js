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
 */
export function extractOpenAINative(response: unknown, modelId: string = ""): CanonicalUsage {
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
    provider: inferProvider(resolvedModel),
    api: extracted.api,
    extras,
  });
}
