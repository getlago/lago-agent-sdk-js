/**
 * OpenAI native adapter — verified against real fixtures.
 *
 * Handles both Chat Completions API (`client.chat.completions.create`) and
 * the Responses API (`client.responses.create`). They share a similar
 * concept but use different field names — we detect which by looking at
 * the usage shape.
 *
 * CHAT COMPLETIONS field mapping (`usage.*`):
 *   prompt_tokens                                    → input
 *   completion_tokens                                → output
 *   prompt_tokens_details.cached_tokens              → cache_read
 *   prompt_tokens_details.audio_tokens               → audio_input
 *   completion_tokens_details.reasoning_tokens       → reasoning   (o-series models)
 *   completion_tokens_details.audio_tokens           → audio_output (GPT-4o-audio output)
 *   count of choices[0].message.tool_calls           → tool_calls
 *
 * RESPONSES API field mapping (`usage.*`):
 *   input_tokens                                     → input
 *   output_tokens                                    → output
 *   input_tokens_details.cached_tokens               → cache_read
 *   output_tokens_details.reasoning_tokens           → reasoning
 *   count of output[].type == "function_call"        → tool_calls
 *
 * Not exposed by either API:
 *   cache_write, cache_write_5m, cache_write_1h — OpenAI auto-caches without
 *   surfacing creation counts.
 *
 * Known gaps (intentional, documented):
 *   - completion_tokens_details.accepted_prediction_tokens — Predicted Outputs
 *     feature: subset of completion_tokens. Skipped to avoid double-counting.
 *   - completion_tokens_details.rejected_prediction_tokens — Predicted Outputs:
 *     extra cost beyond completion_tokens. Skipped for v1 — customers using
 *     the feature can access via the openai response object directly.
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";

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

  const model = typeof resp.model === "string" ? resp.model : "";

  return makeCanonicalUsage({
    input: extracted.inputTokens,
    output: extracted.outputTokens,
    cache_read: extracted.cacheRead,
    reasoning: extracted.reasoning,
    audio_input: extracted.audioInput,
    audio_output: extracted.audioOutput,
    tool_calls: extracted.toolCalls,
    model: modelId || model,
    provider: "openai",
    api: extracted.api,
    extras,
  });
}
