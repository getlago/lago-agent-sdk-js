/**
 * Mistral native adapter — verified mappings (see docs/mistral-native-findings.md).
 *
 * Verified mappings:
 *   - cache_read = `usage.prompt_tokens_details.cached_tokens`
 *     (NOT `usage.prompt_cache_hit_tokens` — that field does not exist)
 *   - Reasoning, cache_write, image_input, audio_input not exposed by Mistral.
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";

// Both snake_case (raw JSON / Python SDK / mistralai REST) and camelCase
// (npm @mistralai/mistralai TS SDK rebrands the wire JSON) are accepted.
const KNOWN_USAGE_FIELDS = new Set<string>([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "prompt_tokens_details",
  "promptTokens",
  "completionTokens",
  "totalTokens",
  "promptTokensDetails",
]);

function pickField(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (obj[n] !== undefined) return obj[n];
  return undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Translate a Mistral chat completion response → CanonicalUsage.
 *
 * Accepts either:
 *   - a plain dict
 *   - a pydantic-like object with model_dump() (rarely used in TS, but supported)
 *   - the official @mistralai/mistralai SDK's response object (which has
 *     plain JS properties at the top level — `.usage`, `.choices`, etc.)
 */
export function extractMistralNative(response: unknown, modelId: string = ""): CanonicalUsage {
  // SDK objects in TS are plain — model_dump only matters for Python pydantic.
  // We accept either shape via duck typing.
  let resp: Record<string, unknown> = {};
  if (isObject(response)) {
    resp = response;
  } else if (response && typeof (response as { toJSON?: () => unknown }).toJSON === "function") {
    const j = (response as { toJSON: () => unknown }).toJSON();
    if (isObject(j)) resp = j;
  }

  const usage = isObject(resp.usage) ? resp.usage : {};
  // The npm SDK exposes nested fields under `additionalProperties` after the
  // rebrand — peek inside if present.
  const additional = isObject(usage.additionalProperties) ? usage.additionalProperties : {};
  const detailsCandidate = pickField(usage, "prompt_tokens_details", "promptTokensDetails");
  const promptDetails = isObject(detailsCandidate)
    ? (detailsCandidate as Record<string, unknown>)
    : isObject(additional.prompt_tokens_details)
      ? (additional.prompt_tokens_details as Record<string, unknown>)
      : {};

  const choices = Array.isArray(resp.choices) ? resp.choices : [];
  const firstChoice = isObject(choices[0]) ? (choices[0] as Record<string, unknown>) : {};
  const message = isObject(firstChoice.message) ? firstChoice.message : {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : Array.isArray(message.toolCalls)
      ? message.toolCalls
      : [];

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usage)) {
    if (!KNOWN_USAGE_FIELDS.has(k) && k !== "additionalProperties") extras[k] = v;
  }

  return makeCanonicalUsage({
    input: safeInt(pickField(usage, "prompt_tokens", "promptTokens")),
    output: safeInt(pickField(usage, "completion_tokens", "completionTokens")),
    cache_read: safeInt(promptDetails.cached_tokens ?? promptDetails.cachedTokens),
    tool_calls: toolCalls.length,
    model: modelId || (typeof resp.model === "string" ? resp.model : ""),
    provider: "mistral",
    api: "native",
    extras,
  });
}
