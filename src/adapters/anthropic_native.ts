/**
 * Anthropic native adapter — verified against real fixtures.
 *
 * Field mapping (snake_case in both wire JSON and the npm @anthropic-ai/sdk):
 *   usage.input_tokens                                 → input
 *   usage.output_tokens                                → output
 *   usage.cache_read_input_tokens                      → cache_read
 *   usage.cache_creation_input_tokens                  → cache_write
 *   usage.cache_creation.ephemeral_5m_input_tokens     → cache_write_5m
 *   usage.cache_creation.ephemeral_1h_input_tokens     → cache_write_1h
 *   count of content[].type == "tool_use"              → tool_calls
 *
 * Not exposed by Anthropic (folded into output_tokens):
 *   reasoning_tokens — even with extended thinking enabled
 *
 * Unknown usage fields (service_tier, inference_geo, server_tool_use, …) land in extras.
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";

const KNOWN_USAGE_FIELDS = new Set<string>([
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "cache_creation",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Translate an Anthropic native response (`Message` object, dict, or a
 * synthetic `{usage: {...}}` blob from the streaming wrapper) → CanonicalUsage.
 */
export function extractAnthropicNative(response: unknown, modelId: string = ""): CanonicalUsage {
  const resp: Record<string, unknown> = isObject(response) ? response : {};
  const usage = isObject(resp.usage) ? resp.usage : {};
  const cacheCreation = isObject(usage.cache_creation) ? usage.cache_creation : {};
  const content = Array.isArray(resp.content) ? resp.content : [];
  let toolCalls = 0;
  for (const b of content) {
    if (isObject(b) && b.type === "tool_use") toolCalls++;
  }

  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usage)) {
    if (!KNOWN_USAGE_FIELDS.has(k)) extras[k] = v;
  }

  const model = typeof resp.model === "string" ? resp.model : "";

  return makeCanonicalUsage({
    input: safeInt(usage.input_tokens),
    output: safeInt(usage.output_tokens),
    cache_read: safeInt(usage.cache_read_input_tokens),
    cache_write: safeInt(usage.cache_creation_input_tokens),
    cache_write_5m: safeInt(cacheCreation.ephemeral_5m_input_tokens),
    cache_write_1h: safeInt(cacheCreation.ephemeral_1h_input_tokens),
    tool_calls: toolCalls,
    model: modelId || model,
    provider: "anthropic",
    api: "native",
    extras,
  });
}
