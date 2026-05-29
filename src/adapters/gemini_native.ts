/**
 * Gemini native adapter — verified against real fixtures.
 *
 * Wraps the modern `@google/genai` SDK. Both `client.models.generateContent`
 * (sync + async) and `client.models.generateContentStream` (sync + async) put
 * usage in `response.usageMetadata` (final chunk for streaming).
 *
 * Field mapping (`usageMetadata.*`):
 *   promptTokenCount                                          → input
 *   candidatesTokenCount                                      → output
 *   cachedContentTokenCount                                   → cache_read
 *   thoughtsTokenCount                                        → reasoning
 *                                                               (Gemini 2.5; ADDITIVE
 *                                                               to candidates, not a subset)
 *   promptTokensDetails[modality=AUDIO].tokenCount            → audio_input
 *   promptTokensDetails[modality=IMAGE].tokenCount            → image_input
 *   candidatesTokensDetails[modality=AUDIO].tokenCount        → audio_output
 *
 * Tool calls: count of candidates[0].content.parts[] entries that have a
 * non-null `functionCall` field.
 *
 * Semantic note vs OpenAI:
 *   Gemini's `thoughtsTokenCount` is ADDITIVE to `candidatesTokenCount`
 *   (total billable output for Google = candidates + thoughts).
 *   OpenAI's `reasoning_tokens` is a SUBSET of `completion_tokens`.
 *   When a customer bills on both `llm_output_tokens` and
 *   `llm_reasoning_tokens` as separate Lago metrics, the Gemini-side sum
 *   reflects the full Google bill; the OpenAI-side `llm_output_tokens`
 *   already includes reasoning.
 *
 * Note on field naming: the @google/genai SDK uses camelCase
 * (usageMetadata, promptTokenCount, etc.); when responses are serialized to
 * JSON for fixtures we capture them as snake_case via model_dump. This
 * adapter handles both shapes.
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";

const KNOWN_USAGE_FIELDS = new Set<string>([
  // snake_case (from Python model_dump or wire JSON)
  "prompt_token_count",
  "candidates_token_count",
  "cached_content_token_count",
  "thoughts_token_count",
  "tool_use_prompt_token_count",
  "total_token_count",
  "prompt_tokens_details",
  "candidates_tokens_details",
  "cache_tokens_details",
  "tool_use_prompt_tokens_details",
  "traffic_type",
  // camelCase (from the @google/genai SDK pydantic-like objects)
  "promptTokenCount",
  "candidatesTokenCount",
  "cachedContentTokenCount",
  "thoughtsTokenCount",
  "toolUsePromptTokenCount",
  "totalTokenCount",
  "promptTokensDetails",
  "candidatesTokensDetails",
  "cacheTokensDetails",
  "toolUsePromptTokensDetails",
  "trafficType",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Read either snake_case or camelCase variant of the same field. */
function pick(obj: Record<string, unknown>, snake: string, camel: string): unknown {
  return obj[snake] !== undefined ? obj[snake] : obj[camel];
}

function modalityTokenCount(details: unknown, modality: string): number {
  if (!Array.isArray(details)) return 0;
  let total = 0;
  for (const entry of details) {
    if (isObject(entry) && entry.modality === modality) {
      const tc = pick(entry, "token_count", "tokenCount");
      total += safeInt(tc);
    }
  }
  return total;
}

function countToolCalls(resp: Record<string, unknown>): number {
  const candidates = resp.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return 0;
  const first = candidates[0];
  if (!isObject(first)) return 0;
  const content = isObject(first.content) ? first.content : {};
  const parts = content.parts;
  if (!Array.isArray(parts)) return 0;
  let n = 0;
  for (const p of parts) {
    if (!isObject(p)) continue;
    const fn = pick(p, "function_call", "functionCall");
    if (fn !== null && fn !== undefined) n++;
  }
  return n;
}

/**
 * Translate a google-genai response (GenerateContentResponse or dict) →
 * CanonicalUsage. Accepts the SDK's pydantic-like objects, dicts (e.g. captured
 * fixtures), or a synthetic `{usageMetadata: {...}}` blob from the streaming wrapper.
 */
export function extractGeminiNative(response: unknown, modelId: string = ""): CanonicalUsage {
  const resp: Record<string, unknown> = isObject(response) ? response : {};
  const usage = isObject(pick(resp, "usage_metadata", "usageMetadata"))
    ? (pick(resp, "usage_metadata", "usageMetadata") as Record<string, unknown>)
    : {};

  const promptDetails = pick(usage, "prompt_tokens_details", "promptTokensDetails");
  const candidatesDetails = pick(usage, "candidates_tokens_details", "candidatesTokensDetails");

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usage)) {
    if (!KNOWN_USAGE_FIELDS.has(k)) extras[k] = v;
  }

  const modelVersion = pick(resp, "model_version", "modelVersion");
  const model = typeof modelVersion === "string" ? modelVersion : "";

  return makeCanonicalUsage({
    input: safeInt(pick(usage, "prompt_token_count", "promptTokenCount")),
    output: safeInt(pick(usage, "candidates_token_count", "candidatesTokenCount")),
    cache_read: safeInt(pick(usage, "cached_content_token_count", "cachedContentTokenCount")),
    reasoning: safeInt(pick(usage, "thoughts_token_count", "thoughtsTokenCount")),
    audio_input: modalityTokenCount(promptDetails, "AUDIO"),
    audio_output: modalityTokenCount(candidatesDetails, "AUDIO"),
    image_input: modalityTokenCount(promptDetails, "IMAGE"),
    tool_calls: countToolCalls(resp),
    model: modelId || model,
    provider: "gemini",
    api: "native",
    extras,
  });
}
