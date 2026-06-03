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
 * Per-call override: pass `lago: { subscription, dimensions }` in the args
 * object. The wrapper strips it before forwarding so OpenAI's strict validator
 * doesn't reject it.
 */
import { extractOpenAINative } from "../adapters/openai_native.js";
import type { CanonicalUsage } from "../canonical.js";

const INSTRUMENTED = Symbol.for("lago_instrumented_openai");

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
      const usage = extractOpenAINative(payload, modelId);
      sdk.emit(usage, { subscription: sub, dimensions: dims });
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
      const firstArg = args[0] as Record<string, unknown> | undefined;
      const lagoOpts: LagoOpts = (firstArg && (firstArg.lago as LagoOpts)) || {};
      if (firstArg && "lago" in firstArg) delete firstArg.lago;
      if (autoIncludeUsage) ensureStreamOptionsIncludeUsage(firstArg);
      const modelId = String(firstArg?.model ?? "");
      const { subscription, dimensions } = resolveOpts(lagoOpts);

      const apiPromise = original(...args) as object;

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
              origThen((value: unknown) => {
                let next: unknown = value;
                try {
                  if (looksLikeResponse(value)) {
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
 */
function extractStreamUsage(payload: unknown): Record<string, unknown> | null {
  if (!isObject(payload)) return null;
  if (isObject(payload.usage)) {
    return { usage: payload.usage };
  }
  const response = payload.response;
  if (isObject(response) && isObject(response.usage)) {
    return { usage: response.usage };
  }
  return null;
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
        sdk.emit(usage, { subscription: sub, dimensions: dims });
      } catch {
        /* swallow */
      }
    }
  }
}
