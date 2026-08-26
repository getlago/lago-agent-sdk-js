/**
 * openai SDK wrapper.
 *
 * Wraps the public methods of an `OpenAI` client (npm `openai` v4+) in place:
 *   - client.chat.completions.create(...)   — sync + streaming
 *   - client.responses.create(...)          — Responses API, sync + streaming
 *
 * Instrumentation never breaks the customer's call.
 *
 * `create()` returns an APIPromise, so the return value is a Proxy that preserves that
 * interface (`.withResponse()`, `.asResponse()`) while intercepting the resolved value.
 * Class-private fields mean every method must be bound to the target, not the Proxy.
 *
 * `stream: true` without `stream_options.include_usage` is injected, because OpenAI's
 * stream otherwise reports no usage at all — silent under-billing.
 *
 * Gateway cache hits (non-streaming only): `cf-aig-cache-status: HIT` means the provider
 * was never called, so it must not be billed. Read via `.asResponse()` on the same
 * promise — no extra round-trip. A client without `.asResponse()` always emits.
 *
 * Per-call `lago: { subscription, dimensions }` is forwarded as a COPY with the key
 * removed: the provider's validator rejects it, and the caller may reuse the object.
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

// Provider overrides implied by the client's `baseURL`, in match order — the first
// substring found wins. A TABLE rather than a chain of `if`s: this is the second
// surface to need the mechanism and a third (Ramp) is already coming, and each extra
// `if` is one more place to get the try/catch and the ordering wrong. Order matters
// only where one entry's substring is a prefix of another's; keep the more specific
// entry first.
//
// Every entry matches a PATH, never a host, and that is the whole design: both of
// these vendors serve plenty of non-inference APIs from the very same host.
export const PROVIDER_BY_BASE_URL_PATH: ReadonlyArray<readonly [string, string]> = [
  // A Databricks-HOSTED foundation model answers on the unified mlflow surface. It
  // has to be told apart from an OpenAI-BYOK call, which uses the SAME OpenAI class
  // against `/ai-gateway/openai/v1` — and the response gives no clue: a hosted call
  // echoes a served-entity name ("meta-llama-4-maverick-040225") with no
  // distinguishing marker, so inferProvider's model-string rule cannot see it.
  // Matching `/ai-gateway/mlflow/`, NOT `/ai-gateway/`, is the point: the openai and
  // anthropic BYOK surfaces live under that same prefix and must keep their real
  // vendor provider so they price against OpenRouter.
  ["/ai-gateway/mlflow/", "databricks"],
  // Snowflake Cortex is OpenAI-WIRE-compatible, so customers reach it with the OpenAI
  // client pointed at `https://<account>.snowflakecomputing.com/api/v2/cortex/…`. The
  // response is an ordinary OpenAI chat completion naming `claude-sonnet-4-5` or
  // `openai-gpt-5`, so without this row inferProvider reads the model string and
  // answers "openai" — and every event for the call goes out labelled as OpenAI usage.
  // Measured against the live OpenRouter catalogue on 2026-08-25, none of the ids this
  // surface actually serves match a price key, so today the mislabelling also costs a
  // permanent price-miss report on every single request. Both halves are fixed by
  // stamping the provider that really served the call: "snowflake" is absent from
  // VENDOR_MAP by design, so it cannot match a price at all, and TOKEN_BILLED_PROVIDERS
  // carries it to token events with no error. That also forecloses the accident the
  // docstring below describes — Snowflake renaming a model to a bare `gpt-4.1` would
  // otherwise let it match OpenAI's own rate while Snowflake bills in credits.
  //
  // `/api/v2/cortex/` and not the `snowflakecomputing.com` host: the host also serves
  // `/api/v2/statements` (the SQL API this SDK's own gateway reader drives) and every
  // other Snowflake API, none of which is model inference.
  ["/api/v2/cortex/", "snowflake"],
];

/**
 * Return a provider override implied by the client's baseURL, or "".
 *
 * Every provider named in the table above is deliberately ABSENT from pricing's
 * VENDOR_MAP, so a hinted call CANNOT hit a price table. `emit()` then emits token
 * counts via TOKEN_BILLED_PROVIDERS with no error reported — that is the complete
 * answer for these models, not a fallback.
 *
 * Deliberate, and the reason a hint exists at all: Databricks bills hosted models in
 * DBUs against a rate card published only as HTML and present in no system table, and
 * Snowflake bills Cortex in credits at an edition/region/contract rate that is
 * machine-readable nowhere — while OpenRouter DOES list bare `openai/gpt-oss-20b` and
 * `meta-llama/llama-4-maverick` at 0.2-0.4x of Databricks' real rate. Left as
 * "openai", a rename of the served entity to an 8-digit date suffix would let
 * stripVersion strip it into a match and silently under-bill 2.5-5x. Stamping the real
 * provider turns that accident into a guaranteed honest miss.
 */
export function providerHintFor(client: unknown): string {
  try {
    const url = String((client as { baseURL?: unknown })?.baseURL ?? "");
    for (const [path, provider] of PROVIDER_BY_BASE_URL_PATH) {
      if (url.includes(path)) return provider;
    }
    return "";
  } catch {
    return "";
  }
}

export function wrapOpenAIClient<T extends OpenAILike>(
  sdk: SDKLike,
  client: T,
  opts: WrapOpenAIOptions = {},
): T {
  const c = client as unknown as Record<symbol, unknown>;
  const providerHint = providerHintFor(client);
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
      const usage = extractOpenAINative(payload, modelId, providerHint);
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
                    next = wrapAsyncIterableStream(value, sdk, modelId, emitOpts, providerHint);
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
 * The chunk's own `model` is carried through with the usage: it is the RESOLVED
 * snapshot, and the requested alias usually is not in OpenRouter's table, so dropping
 * it makes price mode miss and degrade to token events.
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
  // Deliberately NOT defaulted. "" is a legitimate value here — it is what every
  // non-Databricks client resolves to — so a forgotten argument is indistinguishable
  // at runtime from a real answer: the stream silently emits provider="openai" for a
  // Databricks-HOSTED model, which drops it out of TOKEN_BILLED_PROVIDERS and lets a
  // served-entity rename strip into OpenRouter's price for the same open-weight model
  // (measured at 0.2-0.4x of the DBU rate). Requiring it makes a second stream surface
  // a compile error instead of a wrong invoice. The Python port gets the same guarantee
  // for free: its stream wrapper is nested inside `wrap_openai_client` and closes over
  // `provider_hint`, so there is no argument to forget.
  providerHint: string,
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
        const usage = extractOpenAINative(lastUsage, modelId, providerHint);
        sdk.emit(usage, opts);
      } catch {
        /* swallow */
      }
    }
  }
}
