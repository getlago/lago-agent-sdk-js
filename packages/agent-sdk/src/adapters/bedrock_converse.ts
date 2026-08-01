/**
 * Bedrock Converse adapter — single function, 3 shape families.
 *
 * Verified against 39 models in eu-west-1.
 *
 * Families:
 *   - standard         : just inputTokens / outputTokens.
 *   - cache-read-only  : adds cacheReadInputTokens (Claude Opus 4.7).
 *   - full-cache       : adds cacheReadInputTokens + cacheWriteInputTokens
 *                        (Claude Sonnet 4.5/4.6, Haiku 4.5, Opus 4.5/4.6).
 */
import { CanonicalUsage, makeCanonicalUsage } from "../canonical.js";

const KNOWN_USAGE_FIELDS = new Set<string>([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadInputTokens",
  "cacheWriteInputTokens",
  "cacheReadInputTokenCount", // alias — duplicate, ignored
  "cacheWriteInputTokenCount", // alias — duplicate, ignored
  "serverToolUsage",
]);

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

function safeInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function extractBedrockConverse(response: unknown, modelId: string = ""): CanonicalUsage {
  const resp = isObject(response) ? response : {};
  const usage = isObject(resp.usage) ? resp.usage : {};
  const extras: Record<string, unknown> = {};

  let toolCalls = 0;
  const stu = usage.serverToolUsage;
  if (isObject(stu) && Object.keys(stu).length > 0) {
    for (const v of Object.values(stu)) toolCalls += safeInt(v);
    extras.serverToolUsage = stu;
  }

  for (const [k, v] of Object.entries(usage)) {
    if (!KNOWN_USAGE_FIELDS.has(k)) extras[k] = v;
  }

  return makeCanonicalUsage({
    input: safeInt(usage.inputTokens),
    output: safeInt(usage.outputTokens),
    cache_read: safeInt(usage.cacheReadInputTokens),
    cache_write: safeInt(usage.cacheWriteInputTokens),
    tool_calls: toolCalls,
    model: modelId,
    provider: providerFromModel(modelId),
    api: "bedrock_converse",
    extras,
  });
}
