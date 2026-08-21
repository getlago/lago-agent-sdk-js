/**
 * Anthropic native adapter.
 *
 * Billing semantics that are NOT visible from the field names:
 *   - `cache_read` and `cache_write` are ADDITIVE to `input`, unlike OpenAI/Gemini where
 *     the cached tokens sit inside it. This is why anthropic is absent from
 *     `INPUT_INCLUDES_CACHE_READ`.
 *   - No reasoning count exists; it is folded into `output_tokens` even with extended
 *     thinking on.
 *   - `cache_write_5m`/`_1h` are a breakdown OF `cache_write`, not additions to it.
 *
 * Unrecognized usage fields land in `extras` — see the drift test.
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";
import { resolveModel } from "./_common.js";

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

  return makeCanonicalUsage({
    input: safeInt(usage.input_tokens),
    output: safeInt(usage.output_tokens),
    cache_read: safeInt(usage.cache_read_input_tokens),
    cache_write: safeInt(usage.cache_creation_input_tokens),
    cache_write_5m: safeInt(cacheCreation.ephemeral_5m_input_tokens),
    cache_write_1h: safeInt(cacheCreation.ephemeral_1h_input_tokens),
    tool_calls: toolCalls,
    model: resolveModel(resp.model, modelId),
    provider: "anthropic",
    api: "native",
    extras,
  });
}
