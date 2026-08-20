/**
 * @anthropic-ai/sdk wrapper.
 *
 * Wraps `client.messages.create` (sync + streaming) and `client.messages.stream`
 * in place. Instrumentation never breaks the customer's call.
 *
 * Gateway cache-hit detection (non-streaming `create` only): peek at the raw response
 * via `.asResponse()` before emitting — same promise, no extra round-trip. A gateway
 * marking `cf-aig-cache-status: HIT` served it from its own cache, so the provider was
 * never called and it must not be billed. Absent header, or a client without
 * `.asResponse()`, degrades to always emitting. `messages.stream()` is not covered —
 * its usage comes from `finalMessage()`.
 *
 * Per-call override: pass `lago: { subscription, dimensions }` in the create() options.
 * The wrapper forwards a COPY with `lago` removed, so Anthropic's strict validator
 * doesn't reject it and the caller's own object is left intact for reuse.
 *
 * `create()` bills from whichever of `await promise` / `promise.withResponse()` the
 * caller touches first; `messages.stream()` bills from `finalMessage()`.
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

      const apiPromise = originalCreate(...forwarded) as object;

      // ONE emit per call, whichever trap the caller touches — `await p` and
      // `p.withResponse()` resolve from the SAME underlying APIPromise.
      let emitted = false;
      const emitOnce = (payload: unknown) => {
        if (emitted) return;
        emitted = true;
        emitFrom(payload, modelId, emitOpts);
      };

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
                      emitOnce(value);
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
          // `withResponse()` resolves to `{ data, response }` and is a documented public
          // API for reading rate-limit headers, but it calls `this.parse()` on the
          // TARGET, so the `then` trap never fires for it and the call went unbilled.
          // `messages.stream()` uses this path internally, hence the once-guard.
          //
          // `asResponse()` is deliberately NOT wrapped: it hands back an unparsed
          // `Response`, and reading the body to find usage would consume the stream the
          // caller is about to read. An unbillable call beats a broken one.
          const rawWithResponse = (target as { withResponse?: unknown }).withResponse;
          if (prop === "withResponse" && typeof rawWithResponse === "function") {
            const orig = (rawWithResponse as () => Promise<unknown>).bind(target);
            return async () => {
              const result = (await orig()) as { data?: unknown };
              try {
                if (looksLikeMessage(result?.data) && !(await isCacheHit(target))) {
                  emitOnce(result.data);
                }
              } catch {
                /* never break the call */
              }
              return result;
            };
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
      const caller = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (caller && (caller.lago as LagoOpts)) || {};
      const firstArg = caller === undefined ? undefined : { ...caller };
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      const modelId = String(firstArg?.model ?? "");
      const emitOpts = resolveOpts(lagoOpts);
      const forwarded = firstArg === undefined ? args : [firstArg, ...args.slice(1)];

      const inner = originalStream(...forwarded) as unknown as {
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
 * Both locations must be merged: reading only the top-level usage bills
 * `input_tokens = 0`, since a basic stream's `message_delta` is just
 * `{ output_tokens: N }`. Object.assign lets newer values win while keeping
 * `message_start`'s input counts when a delta omits them.
 *
 * `message_start.message.model` is the RESOLVED snapshot and is reported alongside;
 * the requested alias usually is not in OpenRouter's table, so dropping it makes price
 * mode miss. The caller keeps the first one it sees.
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
