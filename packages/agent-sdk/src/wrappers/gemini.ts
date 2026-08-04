/**
 * @google/genai SDK wrapper.
 *
 * Wraps:
 *   - client.models.generateContent(...)       — returns Promise<GenerateContentResponse>
 *   - client.models.generateContentStream(...) — returns Promise<AsyncIterable<chunk>>
 *
 * Instrumentation never breaks the customer's call.
 *
 * Unlike OpenAI/Anthropic, `@google/genai` returns regular Promises (no
 * APIPromise subclass with bolted-on methods), so no Proxy gymnastics needed
 * here — we await and emit, or wrap the async iterable to capture the final
 * chunk's usage.
 *
 * Per-call override: pass `lago: { subscription, dimensions }` in the request
 * options. The wrapper strips it before forwarding.
 */
import { extractGeminiNative } from "../adapters/gemini_native.js";
import type { CanonicalUsage } from "../canonical.js";

const INSTRUMENTED = Symbol.for("lago_instrumented_gemini");

interface LagoOpts {
  subscription?: string;
  dimensions?: Record<string, unknown>;
  mode?: "tokens" | "price";
  markup?: number;
}

interface EmitOpts {
  subscription?: string;
  dimensions?: Record<string, unknown>;
  mode?: "tokens" | "price";
  markup?: number;
}

interface SDKLike {
  emit: (usage: CanonicalUsage, opts?: EmitOpts) => void;
}

interface ModelsLike {
  generateContent?: (...args: unknown[]) => unknown;
  generateContentStream?: (...args: unknown[]) => unknown;
}

interface GoogleGenAILike {
  models?: ModelsLike;
}

export interface WrapGeminiOptions {
  dimensions?: Record<string, unknown>;
  subscription?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pickUsageMetadata(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload)) return null;
  const um = payload.usageMetadata ?? payload.usage_metadata;
  return isObject(um) ? um : null;
}

export function wrapGeminiClient<T extends GoogleGenAILike>(
  sdk: SDKLike,
  client: T,
  opts: WrapGeminiOptions = {},
): T {
  const c = client as unknown as Record<symbol, unknown>;
  if (c[INSTRUMENTED]) return client;

  const baseDims = { ...(opts.dimensions || {}) };
  const baseSub = opts.subscription;
  const models = client.models;
  if (!models) return client;

  const originalGenerate = models.generateContent?.bind(models);
  const originalStream = models.generateContentStream?.bind(models);

  const resolveOpts = (lagoOpts: LagoOpts): EmitOpts => ({
    subscription: lagoOpts.subscription || baseSub,
    dimensions: { ...baseDims, ...(lagoOpts.dimensions || {}) },
    mode: lagoOpts.mode,
    markup: lagoOpts.markup,
  });

  const emitFrom = (payload: unknown, modelId: string, emitOpts: EmitOpts) => {
    try {
      const usage = extractGeminiNative(payload, modelId);
      sdk.emit(usage, emitOpts);
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn("[lago] gemini emit failed:", (err as Error).message);
      }
    }
  };

  // ---------- models.generateContent ----------
  if (originalGenerate) {
    const wrappedGenerate = async (...args: unknown[]) => {
      const firstArg = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (firstArg && (firstArg.lago as LagoOpts)) || {};
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      const modelId = String(firstArg?.model ?? "");
      const emitOpts = resolveOpts(lagoOpts);

      const response = await originalGenerate(...args);
      emitFrom(response, modelId, emitOpts);
      return response;
    };
    models.generateContent = wrappedGenerate as ModelsLike["generateContent"];
  }

  // ---------- models.generateContentStream ----------
  if (originalStream) {
    const wrappedStream = async (...args: unknown[]) => {
      const firstArg = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (firstArg && (firstArg.lago as LagoOpts)) || {};
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      const modelId = String(firstArg?.model ?? "");
      const emitOpts = resolveOpts(lagoOpts);

      const src = (await originalStream(...args)) as AsyncIterable<unknown>;

      async function* iterate(): AsyncIterable<unknown> {
        let lastWithUsage: Record<string, unknown> | null = null;
        try {
          for await (const chunk of src) {
            const usage = pickUsageMetadata(chunk);
            if (usage) {
              lastWithUsage = { usageMetadata: usage };
            }
            yield chunk;
          }
        } finally {
          if (lastWithUsage) {
            emitFrom(lastWithUsage, modelId, emitOpts);
          }
        }
      }
      return iterate();
    };
    models.generateContentStream = wrappedStream as ModelsLike["generateContentStream"];
  }

  c[INSTRUMENTED] = true;
  return client;
}
