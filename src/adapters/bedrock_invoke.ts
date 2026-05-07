/**
 * Bedrock InvokeModel adapters — 7 shape families.
 *
 * Dispatch by substring match on `modelId`. Verified against 39 models.
 *
 *   4.6.1 openai_compat_basic        — Gemma, Qwen, gpt-oss-120b/20b, Voxtral, MiniMax M2.5,
 *                                      Magistral, Devstral, Ministral, NVIDIA Nemotron Nano, GLM
 *   4.6.2 openai_compat_with_details — gpt-oss Safeguard 120B/20B, MiniMax M2, MiniMax M2.1
 *   4.6.3 anthropic                  — Claude Sonnet 4.5/4.6, Haiku 4.5, Opus 4.5/4.6
 *   4.6.4 anthropic_opus_4_7         — Claude Opus 4.7 (extra `service_tier` → extras)
 *   4.6.5 nova                       — Amazon Nova Pro/Lite/Micro/2-Lite
 *   4.6.6 pixtral                    — Mistral Pixtral Large
 *   4.6.7 mistral_legacy             — Mistral 7B / Mixtral 8x7B / Mistral Large 24.02
 *                                      (no usage; emit WARN, return _no_usage extras)
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";

export type InvokeFamily =
  | "openai_compat_basic"
  | "openai_compat_with_details"
  | "anthropic"
  | "opus_4_7"
  | "nova"
  | "pixtral"
  | "mistral_legacy";

// --------------------------------------------------------------------------
// Dispatch (per spec bottom block — verbatim)
// --------------------------------------------------------------------------
export function pickInvokeAdapter(modelId: string): InvokeFamily {
  const mid = (modelId || "").toLowerCase();
  if (mid.includes("anthropic")) return mid.includes("opus-4-7") ? "opus_4_7" : "anthropic";
  if (mid.includes("nova")) return "nova";
  if (mid.includes("pixtral")) return "pixtral";
  if (mid.includes("mistral") || mid.includes("mixtral")) {
    const legacy = ["mistral-7b", "mixtral-8x7b", "mistral-large-2402"];
    if (legacy.some((x) => mid.includes(x))) return "mistral_legacy";
    return "openai_compat_basic";
  }
  if (["gpt-oss-safeguard", "minimax-m2"].some((x) => mid.includes(x))) {
    return "openai_compat_with_details";
  }
  return "openai_compat_basic";
}

// --------------------------------------------------------------------------
// Shared helpers
// --------------------------------------------------------------------------
function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeUsage(resp: unknown): Record<string, unknown> {
  if (!isObject(resp)) return {};
  return isObject(resp.usage) ? resp.usage : {};
}

function providerFromModel(modelId: string): string {
  const m = (modelId || "").toLowerCase();
  if (m.includes("anthropic")) return "anthropic";
  if (m.includes("amazon") || m.includes("nova") || m.includes("titan")) return "amazon";
  if (m.includes("meta") || m.includes("llama")) return "meta";
  if (m.includes("mistral") || m.includes("mixtral") || m.includes("pixtral")) return "mistral";
  if (m.includes("cohere")) return "cohere";
  if (m.includes("openai") || m.includes("gpt-oss")) return "openai";
  if (m.includes("qwen")) return "qwen";
  if (m.includes("gemma")) return "google";
  if (m.includes("minimax")) return "minimax";
  if (m.includes("nvidia") || m.includes("nemotron")) return "nvidia";
  if (m.includes("zai") || m.includes("glm")) return "zai";
  return "bedrock";
}

// --------------------------------------------------------------------------
// Family extractors
// --------------------------------------------------------------------------
function extractOpenAICompatBasic(resp: unknown, modelId: string): CanonicalUsage {
  const usage = safeUsage(resp);
  const extras: Record<string, unknown> = {};
  const known = new Set(["prompt_tokens", "completion_tokens", "total_tokens"]);
  for (const [k, v] of Object.entries(usage)) if (!known.has(k)) extras[k] = v;
  return makeCanonicalUsage({
    input: safeInt(usage.prompt_tokens),
    output: safeInt(usage.completion_tokens),
    model: modelId,
    provider: providerFromModel(modelId),
    api: "bedrock_invoke",
    extras,
  });
}

function extractOpenAICompatWithDetails(resp: unknown, modelId: string): CanonicalUsage {
  const usage = safeUsage(resp);
  const extras: Record<string, unknown> = {};
  // completion_tokens_details is partially mapped (reasoning_tokens), so it's known.
  // prompt_tokens_details is unmapped — let it land in extras for drift detection .
  const known = new Set(["prompt_tokens", "completion_tokens", "total_tokens", "completion_tokens_details"]);
  for (const [k, v] of Object.entries(usage)) if (!known.has(k)) extras[k] = v;

  const details = isObject(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  return makeCanonicalUsage({
    input: safeInt(usage.prompt_tokens),
    output: safeInt(usage.completion_tokens),
    reasoning: safeInt(details.reasoning_tokens),
    model: modelId,
    provider: providerFromModel(modelId),
    api: "bedrock_invoke",
    extras,
  });
}

function extractAnthropic(resp: unknown, modelId: string): CanonicalUsage {
  const usage = safeUsage(resp);
  const extras: Record<string, unknown> = {};
  const knownTop = new Set([
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "cache_creation",
  ]);

  const cacheCreation = isObject(usage.cache_creation) ? usage.cache_creation : {};
  const content =
    isObject(resp) && Array.isArray((resp as Record<string, unknown>).content)
      ? ((resp as Record<string, unknown>).content as unknown[])
      : [];
  let toolCalls = 0;
  for (const b of content) if (isObject(b) && b.type === "tool_use") toolCalls++;

  for (const [k, v] of Object.entries(usage)) if (!knownTop.has(k)) extras[k] = v;

  return makeCanonicalUsage({
    input: safeInt(usage.input_tokens),
    output: safeInt(usage.output_tokens),
    cache_read: safeInt(usage.cache_read_input_tokens),
    cache_write: safeInt(usage.cache_creation_input_tokens),
    cache_write_5m: safeInt(cacheCreation.ephemeral_5m_input_tokens),
    cache_write_1h: safeInt(cacheCreation.ephemeral_1h_input_tokens),
    tool_calls: toolCalls,
    model: modelId,
    provider: "anthropic",
    api: "bedrock_invoke",
    extras,
  });
}

function extractAnthropicOpus47(resp: unknown, modelId: string): CanonicalUsage {
  const out = extractAnthropic(resp, modelId);
  const usage = safeUsage(resp);
  if ("service_tier" in usage) out.extras.service_tier = usage.service_tier;
  return out;
}

function extractNova(resp: unknown, modelId: string): CanonicalUsage {
  const usage = safeUsage(resp);
  const known = new Set([
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cacheReadInputTokenCount",
    "cacheWriteInputTokenCount",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(usage)) if (!known.has(k)) extras[k] = v;

  return makeCanonicalUsage({
    input: safeInt(usage.inputTokens),
    output: safeInt(usage.outputTokens),
    cache_read: safeInt(usage.cacheReadInputTokenCount),
    cache_write: safeInt(usage.cacheWriteInputTokenCount),
    model: modelId,
    provider: "amazon",
    api: "bedrock_invoke",
    extras,
  });
}

function extractPixtral(resp: unknown, modelId: string): CanonicalUsage {
  const out = extractOpenAICompatBasic(resp, modelId);
  const usage = safeUsage(resp);
  if ("request_count" in usage) out.extras.request_count = usage.request_count;
  return out;
}

function extractMistralLegacy(_resp: unknown, modelId: string): CanonicalUsage {
  // Spec — these models cannot be billed via InvokeModel. Emit nothing useful.
  return makeCanonicalUsage({
    model: modelId,
    provider: "mistral",
    api: "bedrock_invoke",
    extras: { _no_usage: true },
  });
}

const DISPATCH: Record<InvokeFamily, (resp: unknown, modelId: string) => CanonicalUsage> = {
  openai_compat_basic: extractOpenAICompatBasic,
  openai_compat_with_details: extractOpenAICompatWithDetails,
  anthropic: extractAnthropic,
  opus_4_7: extractAnthropicOpus47,
  nova: extractNova,
  pixtral: extractPixtral,
  mistral_legacy: extractMistralLegacy,
};

export function extractBedrockInvoke(response: unknown, modelId: string): CanonicalUsage {
  const family = pickInvokeAdapter(modelId);
  return DISPATCH[family](response ?? {}, modelId);
}
