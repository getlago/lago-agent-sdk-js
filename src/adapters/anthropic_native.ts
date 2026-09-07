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
 *
 * Ramp Router's `/v1/messages` surface answers in this exact shape for EVERY vendor it
 * fronts, so the same extractor serves it — with a `providerHint` from the wrapper, since
 * nothing in the body says Router was in the path (see RAMP_ROUTER_MESSAGES_API).
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";
import { resolveModel } from "./_common.js";
import { RAMP_ROUTER_PROVIDER } from "./openai_native.js";

/**
 * `api` stamped on a Router call that arrived through `/v1/messages`.
 *
 * Distinct from the Responses surface's stamp ("ramp_router", which sits in
 * OPENAI_SHAPED_APIS) because the two surfaces report the SAME vendor's numbers under
 * DIFFERENT conventions. Measured 2026-09-04 and 2026-09-07 against a live account:
 * `/v1/messages` keeps Anthropic's additive shape for every vendor — haiku reports
 * `input_tokens: 16` beside `cache_read_input_tokens: 20113`; an xAI model reports
 * `input_tokens: 65` beside `cache_read_input_tokens: 128` and `thinking_tokens: 200`
 * INSIDE `output_tokens: 201` — while `/v1/responses` folds the cached block inside
 * `input_tokens`. Token semantics key on the surface, so this stamp must stay OUT of
 * OPENAI_SHAPED_APIS: the provider-keyed sets do not name "ramp_router", which leaves the
 * all-additive default, the measured answer here. Putting the Responses stamp on this
 * surface would subtract a cached block that was never inside `input`.
 *
 * The write count Router's Responses surface cannot report for Anthropic models IS
 * reported here (`cache_creation_input_tokens`, with the 5m/1h split), and reconciled
 * exactly against the dashboard — the reason this surface is worth detecting at all.
 */
export const RAMP_ROUTER_MESSAGES_API = "ramp_router_messages";

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
 *
 * `providerHint` is the wrapper's word that the client was pointed at a gateway; only the
 * wrapper can know, because the body never says. Today the one value it takes is
 * RAMP_ROUTER_PROVIDER, which stamps the call as Router traffic on the Messages surface.
 * The served tier needs no special handling: Router puts `service_tier` INSIDE `usage` on
 * this surface (buffered, and on both `message_start` and `message_delta` when streamed —
 * measured), so the drift sweep below already lands it in `extras.service_tier`, where the
 * price-mode tier gate reads it.
 */
export function extractAnthropicNative(
  response: unknown,
  modelId: string = "",
  providerHint: string = "",
): CanonicalUsage {
  const resp: Record<string, unknown> = isObject(response) ? response : {};
  const [provider, api] =
    providerHint === RAMP_ROUTER_PROVIDER
      ? [RAMP_ROUTER_PROVIDER, RAMP_ROUTER_MESSAGES_API]
      : ["anthropic", "native"];
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
    provider,
    api,
    extras,
  });
}
