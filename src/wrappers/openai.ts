/**
 * openai SDK wrapper.
 *
 * Wraps the public methods of an `OpenAI` client (npm `openai` v4+) in place:
 *   - client.chat.completions.create(...)   — sync + streaming
 *   - client.responses.create(...)          — Responses API, sync + streaming
 *
 * Instrumentation never breaks the customer's call.
 *
 * APIPromise plumbing: OpenAI's create() returns an APIPromise<T> — a Promise
 * subclass with extra methods (.withResponse(), .asResponse()). To preserve
 * that interface while intercepting the resolved value, we wrap the returned
 * APIPromise in a Proxy. Class-private fields force us to bind methods to the
 * underlying target rather than the Proxy.
 *
 * Streaming usage: when `stream: true` is passed without
 * `stream_options.include_usage`, we inject it so the final chunk carries the
 * usage payload. Without this, OpenAI's stream returns no usage at all —
 * silent under-billing for the customer.
 *
 * Gateway cache-hit detection (non-streaming only): peek at the raw response via
 * `.asResponse()` before emitting — same promise, no extra round-trip. A gateway
 * marking `cf-aig-cache-status: HIT` served it from its own cache, so the provider was
 * never called and it must not be billed. Absent header, or a client without
 * `.asResponse()`, degrades to always emitting. Streaming is not covered.
 *
 * Per-call override: pass `lago: { subscription, dimensions }` in the args object. The
 * wrapper forwards a COPY with `lago` removed, so OpenAI's strict validator doesn't
 * reject it and the caller's own object is left intact for reuse.
 */
import { extractOpenAINative } from "../adapters/openai_native.js";
import type { CanonicalUsage } from "../canonical.js";

const INSTRUMENTED = Symbol.for("lago_instrumented_openai");

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

interface CompletionsLike {
  create?: (...args: unknown[]) => unknown;
}

interface ChatLike {
  completions?: CompletionsLike;
}

interface ResponsesLike {
  create?: (...args: unknown[]) => unknown;
}

interface OpenAILike {
  chat?: ChatLike;
  responses?: ResponsesLike;
}

export interface WrapOpenAIOptions {
  dimensions?: Record<string, unknown>;
  subscription?: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  if (v === null || typeof v !== "object") return false;
  const slot = (v as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  return typeof slot === "function";
}

function looksLikeResponse(obj: unknown): boolean {
  // Real OpenAI responses (ChatCompletion / Response) expose `usage` at the top level.
  // Streams (Stream<...>) are async-iterables without `.usage`.
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
 * our Proxy) — `.asResponse()` is one of OpenAI's own documented ways to
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

/**
 * If the customer set `stream: true` without `stream_options.include_usage`,
 * inject it so the final chunk carries usage. No-op otherwise.
 *
 * Only meaningful for Chat Completions. The Responses API exposes usage on
 * its final event by default.
 */
function ensureStreamOptionsIncludeUsage(opts: Record<string, unknown> | undefined): void {
  if (!opts || !opts.stream) return;
  const so = opts.stream_options;
  if (isObject(so)) {
    if ("include_usage" in so) return; // respect customer's explicit choice
    opts.stream_options = { ...so, include_usage: true };
  } else {
    opts.stream_options = { include_usage: true };
  }
}

export function wrapOpenAIClient<T extends OpenAILike>(
  sdk: SDKLike,
  client: T,
  opts: WrapOpenAIOptions = {},
): T {
  const c = client as unknown as Record<symbol, unknown>;
  if (c[INSTRUMENTED]) return client;

  const baseDims = { ...(opts.dimensions || {}) };
  const baseSub = opts.subscription;

  const resolveOpts = (lagoOpts: LagoOpts): EmitOpts => ({
    subscription: lagoOpts.subscription || baseSub,
    dimensions: { ...baseDims, ...(lagoOpts.dimensions || {}) },
    mode: lagoOpts.mode,
    markup: lagoOpts.markup,
  });

  const emitFrom = (payload: unknown, modelId: string, emitOpts: EmitOpts) => {
    try {
      const usage = extractOpenAINative(payload, modelId);
      sdk.emit(usage, emitOpts);
    } catch (err) {
      if (typeof console !== "undefined") {
        console.warn("[lago] openai emit failed:", (err as Error).message);
      }
    }
  };

  /**
   * Wrap a `.create` method that returns an APIPromise. Returns the same Proxy
   * shape so the SDK's internal helpers (.withResponse, .asResponse, etc.)
   * keep working.
   */
  const makeWrappedCreate = (original: (...args: unknown[]) => unknown, autoIncludeUsage: boolean) => {
    return (...args: unknown[]) => {
      const caller = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (caller && (caller.lago as LagoOpts)) || {};
      // Work on a COPY. `delete caller.lago` and the stream_options injection both
      // mutated the object the customer handed us, so a params object reused across
      // calls — a retry loop, or a request-scoped config — lost its `lago` key after
      // the first call and every later one silently fell back to the default
      // subscription, dimensions, mode and markup. Python pops from its own per-call
      // `**kwargs` dict and never touches caller state; this now matches.
      const firstArg = caller === undefined ? undefined : { ...caller };
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      if (autoIncludeUsage) ensureStreamOptionsIncludeUsage(firstArg);
      const modelId = String(firstArg?.model ?? "");
      const emitOpts = resolveOpts(lagoOpts);

      const forwarded = firstArg === undefined ? args : [firstArg, ...args.slice(1)];
      const apiPromise = original(...forwarded) as object;

      // ONE emit per call, whichever trap the caller touches. `await p` and
      // `p.withResponse()` are both instrumented below and both resolve from the SAME
      // underlying APIPromise, so doing both — a caller reading usage, then reading
      // rate-limit headers — billed the call twice.
      let emitted = false;
      const emitOnce = (payload: unknown) => {
        if (emitted) return;
        emitted = true;
        emitFrom(payload, modelId, emitOpts);
      };

      // APIPromise has class-private fields (#httpResponse). Methods accessed
      // through the Proxy must be bound to the underlying target — not the
      // Proxy — or the engine throws on private-field access.
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
                  if (looksLikeResponse(value)) {
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
          // TARGET, so the `then` trap never fires for it. Bill from its parsed `data`,
          // with the same cache-hit suppression and the same once-guard.
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
                if (looksLikeResponse(result?.data) && !(await isCacheHit(target))) {
                  emitOnce(result.data);
                }
              } catch {
                /* never break the call */
              }
              return result;
            };
          }
          const value = Reflect.get(target, prop, target);
          if (typeof value === "function") {
            return (value as (...a: unknown[]) => unknown).bind(target);
          }
          return value;
        },
      });
    };
  };

  // ---------- chat.completions.create ----------
  const completions = client.chat?.completions;
  if (completions?.create) {
    const original = completions.create.bind(completions);
    completions.create = makeWrappedCreate(original, true) as CompletionsLike["create"];
  }

  // ---------- responses.create ----------
  const responses = client.responses;
  if (responses?.create) {
    const original = responses.create.bind(responses);
    responses.create = makeWrappedCreate(original, false) as ResponsesLike["create"];
  }

  c[INSTRUMENTED] = true;
  return client;
}

/**
 * Pull usage out of a stream event, handling both API shapes.
 *
 * Chat Completions: usage sits at the top of the final chunk
 *   `{ usage: {...} }`
 * Responses API:    usage sits under `event.response.usage` on the terminal
 *   `response.completed` event:
 *   `{ type: "response.completed", response: { usage: {...} } }`
 *
 * Carries the chunk's own `model` through alongside the usage. Rebuilding a
 * usage-ONLY payload made `resolveModel` fall back to the requested alias on every
 * streaming call, which is precisely the attribution bug the non-streaming path was
 * fixed for: a streamed `gpt-5-chat-latest` stayed `gpt-5-chat-latest` instead of
 * resolving to the dated snapshot OpenRouter lists, so price mode missed and
 * silently degraded to token events. It matters most on a gateway, where the
 * resolved name is what decides which price table the call is even looked up in.
 */
function extractStreamUsage(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload)) return null;
  if (isObject(payload.usage)) {
    return { usage: payload.usage, model: payload.model };
  }
  // Responses API stream events nest usage under `.response.usage` — and the
  // resolved model under `.response.model`, not at the event's top level.
  const response = payload.response;
  if (isObject(response) && isObject(response.usage)) {
    return { usage: response.usage, model: response.model };
  }
  return null;
}

async function* wrapAsyncIterableStream(
  src: AsyncIterable<unknown>,
  sdk: SDKLike,
  modelId: string,
  opts: EmitOpts,
): AsyncIterable<unknown> {
  let lastUsage: Record<string, unknown> | null = null;
  try {
    for await (const event of src) {
      // Each chunk is a ChatCompletionChunk (Chat Completions API) or a
      // typed event (Responses API). Usage location differs per API.
      const payload = (
        isObject(event) && typeof (event as { model_dump?: unknown }).model_dump === "function"
          ? (event as { model_dump: () => unknown }).model_dump()
          : event
      ) as Record<string, unknown>;
      const extracted = extractStreamUsage(payload);
      if (extracted !== null) {
        lastUsage = extracted;
      }
      yield event;
    }
  } finally {
    if (lastUsage) {
      try {
        const usage = extractOpenAINative(lastUsage, modelId);
        sdk.emit(usage, opts);
      } catch {
        /* swallow */
      }
    }
  }
}
