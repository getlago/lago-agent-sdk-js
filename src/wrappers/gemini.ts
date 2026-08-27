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
 * options. The wrapper forwards a COPY with `lago` removed, leaving the caller's own
 * object intact for reuse.
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
  /** The SDK's error channel. Wrappers report through it rather than logging, so a
   * provider whose response shape drifts surfaces on the hook customers actually watch
   * — a log line alone is a silent billing outage for that provider. */
  reportError: (err: unknown, where: string) => void;
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

/** The chunk's resolved model version, in either casing the SDK might use.
 *
 * Gemini hot-swaps "-latest" aliases server-side, so the chunk's own version is
 * what OpenRouter lists and what pricing must key off. A usage-only streaming
 * payload silently reverted to the requested alias on every call. */
function pickModelVersion(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  const mv = payload.modelVersion ?? payload.model_version;
  return typeof mv === "string" && mv ? mv : null;
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
      sdk.reportError(err, "adapter.gemini");
    }
  };

  // ---------- models.generateContent ----------
  if (originalGenerate) {
    const wrappedGenerate = async (...args: unknown[]) => {
      const caller = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (caller && (caller.lago as LagoOpts)) || {};
      // Work on a COPY: the params object belongs to the caller and may be reused
      // across calls (a retry loop, a request-scoped config). Deleting `lago` from it
      // made every later call silently fall back to the default subscription,
      // dimensions, mode and markup. Python pops from its own `**kwargs` and never
      // touches caller state; this matches.
      const firstArg = caller === undefined ? undefined : { ...caller };
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      const modelId = String(firstArg?.model ?? "");
      const emitOpts = resolveOpts(lagoOpts);
      const forwarded = firstArg === undefined ? args : [firstArg, ...args.slice(1)];

      const response = await originalGenerate(...forwarded);
      emitFrom(response, modelId, emitOpts);
      return response;
    };
    models.generateContent = wrappedGenerate as ModelsLike["generateContent"];
  }

  // ---------- models.generateContentStream ----------
  if (originalStream) {
    const wrappedStream = async (...args: unknown[]) => {
      const caller = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (caller && (caller.lago as LagoOpts)) || {};
      const firstArg = caller === undefined ? undefined : { ...caller };
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      const modelId = String(firstArg?.model ?? "");
      const emitOpts = resolveOpts(lagoOpts);
      const forwarded = firstArg === undefined ? args : [firstArg, ...args.slice(1)];

      const src = (await originalStream(...forwarded)) as AsyncIterable<unknown>;

      async function* iterate(): AsyncIterable<unknown> {
        let lastWithUsage: Record<string, unknown> | null = null;
        let resolvedModel: string | null = null;
        try {
          for await (const chunk of src) {
            resolvedModel = pickModelVersion(chunk) ?? resolvedModel;
            const usage = pickUsageMetadata(chunk);
            if (usage) {
              lastWithUsage = { usageMetadata: usage, modelVersion: resolvedModel };
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
