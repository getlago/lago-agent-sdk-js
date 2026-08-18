/**
 * @anthropic-ai/sdk wrapper.
 *
 * Wraps `client.messages.create` (sync + streaming) and `client.messages.stream`
 * in place. Instrumentation never breaks the customer's call.
 *
 * Gateway cache-hit detection (non-streaming `create` only): before emitting,
 * peek at the raw response via `.asResponse()` (an APIPromise method
 * Anthropic's SDK already exposes for exactly this — safe to call alongside
 * `.then()`/await on the same promise, no extra network round-trip). If a
 * gateway in front of the provider (e.g. Cloudflare AI Gateway) marks the
 * response `cf-aig-cache-status: HIT`, the provider served it from cache at
 * zero cost to the customer — we skip billing it. No-op with no gateway in
 * the path (the header is simply absent) or with a simplified/custom client
 * that doesn't expose `.asResponse()` (degrades to the pre-existing
 * behavior: always emit). `messages.stream()` is NOT covered — its usage
 * comes from `finalMessage()`/the `finalMessage` event, not this path.
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

/**
 * True if a gateway in front of the provider served this from cache.
 *
 * A cache hit (Cloudflare AI Gateway: `cf-aig-cache-status: HIT`) costs the
 * provider — and the customer — nothing. Billing it would overcharge for a
 * call that never actually happened. `target` is the real APIPromise (not
 * our Proxy) — `.asResponse()` is one of Anthropic's own documented ways to
 * consume it, safe to call alongside the normal resolution path. Defensive:
 * a simplified/custom client without `.asResponse()` (e.g. a hand-rolled
 * fake) simply never reports a hit — never breaks the customer's call.
 */
async function isCacheHit(target: unknown): Promise<boolean> {
  try {
    const asResponse = (target as { asResponse?: () => Promise<Response> }).asResponse;
    if (typeof asResponse !== "function") return false;
    const raw = await asResponse.call(target);
    return raw?.headers?.get?.("cf-aig-cache-status") === "HIT";
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

  const resolveOpts = (lagoOpts: LagoOpts): EmitOpts => ({
    subscription: lagoOpts.subscription || baseSub,
    dimensions: { ...baseDims, ...(lagoOpts.dimensions || {}) },
    mode: lagoOpts.mode,
    markup: lagoOpts.markup,
  });

  const emitFrom = (payload: unknown, modelId: string, opts: EmitOpts) => {
    try {
      const usage = extractAnthropicNative(payload, modelId);
      sdk.emit(usage, opts);
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
      const emitOpts = resolveOpts(lagoOpts);

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
              origThen(async (value: unknown) => {
                let next: unknown = value;
                try {
                  if (looksLikeMessage(value)) {
                    // Peek at the raw response's headers via the SAME
                    // underlying promise before emitting — see
                    // isCacheHit()'s docstring for why this is safe.
                    if (!(await isCacheHit(target))) {
                      emitFrom(value, modelId, emitOpts);
                    }
                  } else if (isAsyncIterable(value)) {
                    next = wrapAsyncIterableStream(value, sdk, modelId, emitOpts);
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
      const emitOpts = resolveOpts(lagoOpts);

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
            emitFrom(final, modelId, emitOpts);
            return final;
          };
        }
        // Fallback: 'finalMessage' event fires when the stream completes.
        try {
          inner.on?.("finalMessage", (final: unknown) => {
            emitFrom(final, modelId, emitOpts);
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

/**
 * Fold one streaming event's usage into the running accumulator.
 *
 * Anthropic splits authoritative usage across two events:
 *   - `message_start` carries the input/cache counts nested under
 *     `message.usage` (with `output_tokens` only primed to 1).
 *   - `message_delta` carries the *cumulative* `output_tokens` at the top level
 *     (and, in some API shapes, echoes input/cache there too).
 *
 * Reading only the top-level usage misses `message_start`'s input/cache, so a
 * basic stream — whose `message_delta` is just `{ output_tokens: N }` — would
 * bill `input_tokens = 0`. Merge both locations; Object.assign lets the more
 * complete / more recent values win while preserving the input counts from
 * `message_start` when a delta omits them.
 *
 * Also reports the model this event carried. `message_start` holds the RESOLVED
 * snapshot under `message.model` — e.g. "claude-sonnet-4-5-20250929" for a
 * requested "claude-sonnet-4-5" — and discarding it made every streaming call
 * attribute (and price) the alias instead, the same bug the non-streaming path was
 * fixed for. The caller keeps the first one it sees.
 */
function mergeStreamUsage(
  accumulated: Record<string, unknown>,
  payload: unknown,
): { merged: boolean; model: string | null } {
  if (!isObject(payload)) return { merged: false, model: null };
  let merged = false;
  let model: string | null = null;
  // message_start: input/cache live under message.usage, resolved model alongside
  const message = payload.message;
  if (isObject(message)) {
    if (isObject(message.usage)) {
      Object.assign(accumulated, message.usage);
      merged = true;
    }
    if (typeof message.model === "string" && message.model) model = message.model;
  }
  // message_delta (and others): cumulative usage at the top level
  if (isObject(payload.usage)) {
    Object.assign(accumulated, payload.usage);
    merged = true;
  }
  return { merged, model };
}

async function* wrapAsyncIterableStream(
  src: AsyncIterable<unknown>,
  sdk: SDKLike,
  modelId: string,
  opts: EmitOpts,
): AsyncIterable<unknown> {
  const accumulated: Record<string, unknown> = {};
  let sawUsage = false;
  let resolvedModel: string | null = null;
  try {
    for await (const event of src) {
      // Each event is a RawMessageStreamEvent — most carry a payload with snake_case fields.
      const payload =
        isObject(event) && "model_dump" in (event as object)
          ? (event as { model_dump: () => unknown }).model_dump()
          : event;
      const { merged, model } = mergeStreamUsage(accumulated, payload);
      if (merged) sawUsage = true;
      resolvedModel = model ?? resolvedModel;
      yield event;
    }
  } finally {
    if (sawUsage) {
      try {
        const usage = extractAnthropicNative({ usage: accumulated, model: resolvedModel }, modelId);
        sdk.emit(usage, opts);
      } catch {
        /* swallow */
      }
    }
  }
}
