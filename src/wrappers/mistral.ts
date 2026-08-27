/**
 * Mistral SDK wrapper.
 *
 * Wraps `client.chat.complete` and `.stream` (the @mistralai/mistralai npm SDK).
 * Streaming captures usage from the final chunk.
 *
 * Per-call override pattern:
 *   await client.chat.complete({...}, { lago: { subscription: "sub_x", dimensions: {...} } })
 * The wrapper forwards a COPY with `lago` removed, leaving the caller's own object
 * intact for reuse.
 */
import { extractMistralNative } from "../adapters/mistral_native.js";
import type { CanonicalUsage } from "../canonical.js";

const INSTRUMENTED = Symbol.for("lago_instrumented_mistral");

interface LagoOpts {
  subscription?: string;
  dimensions?: Record<string, unknown>;
  mode?: "tokens" | "price";
  markup?: number;
}

interface SDKLike {
  emit: (
    usage: CanonicalUsage,
    opts?: {
      subscription?: string;
      dimensions?: Record<string, unknown>;
      mode?: "tokens" | "price";
      markup?: number;
    },
  ) => void;
  /** The SDK's error channel. Wrappers report through it rather than logging, so a
   * provider whose response shape drifts surfaces on the hook customers actually watch
   * — a log line alone is a silent billing outage for that provider. */
  reportError: (err: unknown, where: string) => void;
}

export interface WrapMistralOptions {
  dimensions?: Record<string, unknown>;
  subscription?: string;
}

interface ChatLike {
  complete?: (...args: unknown[]) => unknown;
  stream?: (...args: unknown[]) => unknown;
  completeAsync?: (...args: unknown[]) => unknown;
  streamAsync?: (...args: unknown[]) => unknown;
}

interface MistralLike {
  chat: ChatLike;
}

export function wrapMistralClient<T extends MistralLike>(
  sdk: SDKLike,
  client: T,
  opts: WrapMistralOptions = {},
): T {
  const c = client as unknown as Record<symbol, unknown>;
  if (c[INSTRUMENTED]) return client;

  const baseDims = { ...(opts.dimensions || {}) };
  const baseSub = opts.subscription;
  const chat = client.chat;
  if (!chat) return client;

  const originalComplete = chat.complete?.bind(chat);
  const originalStream = chat.stream?.bind(chat);

  const resolveOpts = (lagoOpts: LagoOpts) => ({
    subscription: lagoOpts.subscription || baseSub,
    dimensions: { ...baseDims, ...(lagoOpts.dimensions || {}) },
    mode: lagoOpts.mode,
    markup: lagoOpts.markup,
  });

  // ---------- chat.complete ----------
  if (originalComplete) {
    const wrappedComplete = async (...args: unknown[]) => {
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
      const forwarded = firstArg === undefined ? args : [firstArg, ...args.slice(1)];
      const response = await originalComplete(...forwarded);
      try {
        const usage = extractMistralNative(response, modelId);
        sdk.emit(usage, resolveOpts(lagoOpts));
      } catch (err) {
        sdk.reportError(err, "adapter.mistral");
      }
      return response;
    };
    chat.complete = wrappedComplete as ChatLike["complete"];
  }

  // ---------- chat.stream ----------
  //
  // Real `@mistralai/mistralai` `chat.stream` is an AsyncFunction:
  //   async stream(...) -> Promise<AsyncIterable>
  // The wrapper preserves that shape (async function returning Promise),
  // so `result instanceof Promise === true` and `.then(...)` works just
  // like with the unwrapped client. Returning the async generator
  // synchronously would "work" via await's no-op pass-through but would
  // silently break customer code that uses .then() or instanceof Promise.
  if (originalStream) {
    const wrappedStream = async (...args: unknown[]) => {
      const caller = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (caller && (caller.lago as LagoOpts)) || {};
      const firstArg = caller === undefined ? undefined : { ...caller };
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      const modelId = String(firstArg?.model ?? "");
      const forwarded = firstArg === undefined ? args : [firstArg, ...args.slice(1)];
      const source = (await originalStream(...forwarded)) as AsyncIterable<unknown>;

      async function* iterate() {
        let lastUsage: Record<string, unknown> | null = null;
        try {
          for await (const event of source) {
            const ev = event as Record<string, unknown>;
            // Mistral streaming yields wrapper objects; usage lives at `data.usage`
            // on the final chunk (finish_reason: "stop").
            const inner = (ev?.data ?? ev) as Record<string, unknown>;
            if (isObject(inner) && isObject(inner.usage)) {
              lastUsage = { usage: inner.usage, model: inner.model ?? modelId };
            }
            yield event;
          }
        } finally {
          if (lastUsage) {
            try {
              const usage = extractMistralNative(lastUsage, modelId);
              sdk.emit(usage, resolveOpts(lagoOpts));
            } catch (err) {
              sdk.reportError(err, "adapter.mistral");
            }
          }
        }
      }
      return iterate();
    };
    chat.stream = wrappedStream as ChatLike["stream"];
  }

  c[INSTRUMENTED] = true;
  return client;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
