/**
 * @anthropic-ai/sdk wrapper.
 *
 * Wraps `client.messages.create` (sync + streaming) and `client.messages.stream`
 * in place. Instrumentation never breaks the customer's call.
 *
 * Per-call override: pass `lago: { subscription, dimensions }` in the create()
 * options. The wrapper strips it before forwarding so Anthropic's strict
 * validator doesn't reject it.
 */
import { extractAnthropicNative } from "../adapters/anthropic_native.js";
import type { CanonicalUsage } from "../canonical.js";

const INSTRUMENTED = Symbol.for("lago_instrumented_anthropic");

interface LagoOpts {
  subscription?: string;
  dimensions?: Record<string, unknown>;
}

interface SDKLike {
  emit: (
    usage: CanonicalUsage,
    opts?: { subscription?: string; dimensions?: Record<string, unknown> },
  ) => void;
}

interface MessagesLike {
  create?: (...args: unknown[]) => unknown;
  stream?: (...args: unknown[]) => unknown;
}

interface AnthropicLike {
  messages: MessagesLike;
}

export interface WrapAnthropicOptions {
  dimensions?: Record<string, unknown>;
  subscription?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function looksLikeMessage(obj: unknown): boolean {
  // Anthropic Message objects expose `usage` and `content` at the top level.
  // Streams (Stream<RawMessageStreamEvent>) are iterables without `.usage`.
  try {
    if (isObject(obj)) return "usage" in obj;
    return obj !== null && typeof obj === "object" && "usage" in (obj as object);
  } catch {
    return false;
  }
}

export function wrapAnthropicClient<T extends AnthropicLike>(
  sdk: SDKLike,
  client: T,
  opts: WrapAnthropicOptions = {},
): T {
  const c = client as unknown as Record<symbol, unknown>;
  if (c[INSTRUMENTED]) return client;

  const baseDims = { ...(opts.dimensions || {}) };
  const baseSub = opts.subscription;
  const messages = client.messages;
  if (!messages) return client;

  const originalCreate = messages.create?.bind(messages);
  const originalStream = messages.stream?.bind(messages);

  const resolveOpts = (lagoOpts: LagoOpts) => ({
    subscription: lagoOpts.subscription || baseSub,
    dimensions: { ...baseDims, ...(lagoOpts.dimensions || {}) },
  });

  const emitFrom = (
    payload: unknown,
    modelId: string,
    sub: string | undefined,
    dims: Record<string, unknown>,
  ) => {
    try {
      const usage = extractAnthropicNative(payload, modelId);
      sdk.emit(usage, { subscription: sub, dimensions: dims });
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn("[lago] anthropic emit failed:", (err as Error).message);
      }
    }
  };

  // ---------- messages.create (sync + streaming) ----------
  //
  // Anthropic's create() returns an APIPromise<Message | Stream> — a Promise
  // that also carries extra methods like .withResponse(), .asResponse(), etc.
  // The SDK's messages.stream() helper internally calls
  // `this.create({...stream: true}).withResponse(...)`, so we MUST preserve
  // the APIPromise interface. We Proxy the APIPromise: forward everything
  // else, intercept only .then() to instrument the resolved value.
  if (originalCreate) {
    const wrappedCreate = (...args: unknown[]) => {
      const firstArg = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (firstArg && (firstArg.lago as LagoOpts)) || {};
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      const modelId = String(firstArg?.model ?? "");
      const { subscription, dimensions } = resolveOpts(lagoOpts);

      const apiPromise = originalCreate(...args) as object;

      // APIPromise relies on class-private fields (e.g. #httpResponse), so any
      // method we return from the Proxy must be invoked with `this` bound to
      // the original target — not the Proxy — or the engine throws
      // "Cannot read private member from an object whose class did not declare it".
      return new Proxy(apiPromise, {
        get(target, prop) {
          if (prop === "then") {
            const origThen = (target as { then: PromiseLike<unknown>["then"] }).then.bind(target);
            return (
              onfulfilled?: ((value: unknown) => unknown) | null,
              onrejected?: ((reason: unknown) => unknown) | null,
            ) =>
              origThen((value: unknown) => {
                let next: unknown = value;
                try {
                  if (looksLikeMessage(value)) {
                    emitFrom(value, modelId, subscription, dimensions);
                  } else if (isAsyncIterable(value)) {
                    next = wrapAsyncIterableStream(value, sdk, modelId, subscription, dimensions);
                  }
                } catch {
                  /* never break the call */
                }
                return onfulfilled ? onfulfilled(next) : next;
              }, onrejected);
          }
          // Bind methods to the underlying target so private-field access works.
          const value = Reflect.get(target, prop, target);
          if (typeof value === "function") {
            return (value as (...a: unknown[]) => unknown).bind(target);
          }
          return value;
        },
      });
    };
    messages.create = wrappedCreate as MessagesLike["create"];
  }

  // ---------- messages.stream (returns MessageStream — emits on .finalMessage()) ----------
  if (originalStream) {
    const wrappedStream = (...args: unknown[]) => {
      const firstArg = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (firstArg && (firstArg.lago as LagoOpts)) || {};
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      const modelId = String(firstArg?.model ?? "");
      const { subscription, dimensions } = resolveOpts(lagoOpts);

      const inner = originalStream(...args) as unknown as {
        finalMessage?: () => Promise<unknown>;
        on?: (event: string, cb: (...a: unknown[]) => void) => void;
      };

      // Attach a one-shot listener on the 'finalMessage' event if available;
      // also monkey-patch finalMessage() to capture on first call.
      if (inner && typeof inner === "object") {
        const origFinal = inner.finalMessage?.bind(inner);
        if (origFinal) {
          inner.finalMessage = async () => {
            const final = await origFinal();
            emitFrom(final, modelId, subscription, dimensions);
            return final;
          };
        }
        // Fallback: 'finalMessage' event fires when the stream completes.
        try {
          inner.on?.("finalMessage", (final: unknown) => {
            emitFrom(final, modelId, subscription, dimensions);
          });
        } catch {
          /* SDK version may not expose .on — ignore */
        }
      }
      return inner;
    };
    messages.stream = wrappedStream as MessagesLike["stream"];
  }

  c[INSTRUMENTED] = true;
  return client;
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  if (v === null || typeof v !== "object") return false;
  const slot = (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  return typeof slot === "function";
}

async function* wrapAsyncIterableStream(
  src: AsyncIterable<unknown>,
  sdk: SDKLike,
  modelId: string,
  sub: string | undefined,
  dims: Record<string, unknown>,
): AsyncIterable<unknown> {
  let lastUsage: Record<string, unknown> | null = null;
  try {
    for await (const event of src) {
      // Each event is a RawMessageStreamEvent — most carry a payload with snake_case fields.
      const payload = (
        isObject(event) && "model_dump" in (event as object)
          ? (event as { model_dump: () => unknown }).model_dump()
          : event
      ) as Record<string, unknown>;
      if (isObject(payload) && isObject(payload.usage)) {
        lastUsage = { usage: payload.usage };
      }
      yield event;
    }
  } finally {
    if (lastUsage) {
      try {
        const usage = extractAnthropicNative(lastUsage, modelId);
        sdk.emit(usage, { subscription: sub, dimensions: dims });
      } catch {
        /* swallow */
      }
    }
  }
}
