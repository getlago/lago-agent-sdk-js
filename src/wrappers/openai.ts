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
import { RAMP_ROUTER_PROVIDER, extractOpenAINative } from "../adapters/openai_native.js";
import type { CanonicalUsage } from "../canonical.js";
// The one import a wrapper takes from gateway code, and it is load-bearing: the REST-view
// dedup only works if this wrapper and `gateway/snowflake.ts` compute the IDENTICAL
// transaction id, so both call one helper instead of keeping two copies of a string
// format that would drift without an error. The module is pure (canonical-only imports,
// no I/O, no node built-ins), so this pulls nothing heavy into the wrap() path.
import { SNOWFLAKE_EVENT_ID_PREFIX, snowflakeEventId } from "../gateway/adapters/snowflake_cortex.js";

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
  /** Idempotency key for this call's events — set only on the Snowflake path, where the
   * response header supplies the id the REST-view backfill would also derive. */
  eventId?: string;
}

interface SDKLike {
  emit: (usage: CanonicalUsage, opts?: EmitOpts) => void;
  /** Reads the subscription bound by `withSubscription()` / `setSubscription()`, falling
   * back to the configured default. Wrappers call it while the customer's own call frame
   * is still on the stack, which is the only place the async-local store is readable. */
  resolveSubscription: (override?: string) => string | null;
  /** The SDK's error channel. Wrappers report through it rather than logging, so a
   * provider whose response shape drifts surfaces on the hook customers actually watch
   * — a log line alone is a silent billing outage for that provider. */
  reportError: (err: unknown, where: string) => void;
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
 * The Snowflake-side id of a Cortex call, read off the raw response.
 *
 * `x-snowflake-request-id` IS the `REQUEST_ID` the call lands under in
 * `CORTEX_REST_API_USAGE_HISTORY` (measured byte-identical, 2026-08-26), which is what
 * lets the live path and a REST-view backfill produce one transaction id — see
 * `snowflakeEventId`. The response BODY is not a route in: Cortex returns `"id": ""`.
 *
 * Same shape and same defensiveness as `isCacheHit`: `.asResponse()` on the real
 * APIPromise, resolved from the same underlying response, headers only — for a stream it
 * resolves once headers arrive, without touching the body the caller is about to read.
 * A client without `.asResponse()`, or a response without the header, yields "" and the
 * event keeps its UUID — never breaks the customer's call.
 */
async function snowflakeRequestId(target: unknown): Promise<string> {
  try {
    const asResponse = (target as { asResponse?: () => Promise<Response> }).asResponse;
    if (typeof asResponse !== "function") return "";
    const raw = await asResponse.call(target);
    return raw?.headers?.get?.("x-snowflake-request-id") ?? "";
  } catch {
    return "";
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
// Ramp Router cannot be a row in the path table above: it serves every provider it
// fronts through one dedicated host with no distinguishing path, so the HOST is the
// signal — and it must be the PARSED host, never a substring test. A substring row
// ("api.router.com") also matches `https://evil.example.com/api.router.com/v1`, which
// would stamp an unrelated endpoint's traffic as Router-served. The `.router.com`
// suffix arm covers a regional or staging host without widening to arbitrary domains —
// `evilrouter.com` does not end in `.router.com`. The path table keeps first say: its
// rows are more specific, and no Snowflake or Databricks URL lives under router.com.
const RAMP_ROUTER_HOST = "api.router.com";
const RAMP_ROUTER_DOMAIN = ".router.com";

export function providerHintFor(client: unknown): string {
  try {
    const url = String((client as { baseURL?: unknown })?.baseURL ?? "");
    for (const [path, provider] of PROVIDER_BY_BASE_URL_PATH) {
      if (url.includes(path)) return provider;
    }
    const host = new URL(url).host.toLowerCase();
    if (host === RAMP_ROUTER_HOST || host.endsWith(RAMP_ROUTER_DOMAIN)) return RAMP_ROUTER_PROVIDER;
    return "";
  } catch {
    // A relative or malformed baseURL is not a gateway. Never throw out of wrap().
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
    // Resolved HERE, at the moment the customer makes the call, rather than left to
    // `emit()` once the response comes back. `withSubscription()` binds the id in
    // `AsyncLocalStorage`, and the store is only readable INSIDE the `run()` callback —
    // so a promise or a stream created inside `withSubscription()` and consumed outside
    // it read no subscription at all and the event was dropped. Measured: 0 events for
    // both shapes, and `const s = await helper()` — where the helper wraps the call in
    // `withSubscription` — then iterating `s` is an ordinary way to write it.
    //
    // Capturing at call time is also the more defensible rule on its own: the
    // subscription that owns a call is the one that was active when the call was made,
    // not whatever happens to be active whenever the provider answers.
    subscription: lagoOpts.subscription || baseSub || sdk.resolveSubscription() || undefined,
    dimensions: { ...baseDims, ...(lagoOpts.dimensions || {}) },
    mode: lagoOpts.mode,
    markup: lagoOpts.markup,
  });

  const emitFrom = (payload: unknown, modelId: string, emitOpts: EmitOpts) => {
    try {
      const usage = extractOpenAINative(payload, modelId, providerHint);
      sdk.emit(usage, emitOpts);
    } catch (err) {
      // A drifted response shape is a total billing outage for this provider, so it goes
      // to `onError`, not just to a log. `reportError` logs as well, so this is one line
      // per gap rather than two.
      sdk.reportError(err, "adapter.openai");
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

      // The idempotency key that makes a REST-view backfill of this same call a
      // duplicate Lago rejects, in the EXACT shape the reader builds. Gated on the
      // provider hint rather than on the header existing: real OpenAI never sends the
      // header today, but the gate makes that a property of this code instead of the
      // provider's behaviour — a proxy injecting the header at an OpenAI baseURL must
      // not change that call's transaction_id shape. Keyed off the subscription
      // resolved at call time, which is the value `emit()` will bill. No header (or no
      // `.asResponse()`) → undefined → `emit()` keeps its per-event UUID fallback; an
      // extra guard here would be redundant with that, and a constant fallback would
      // collide every call in the window onto one id.
      const restEventId = async (target: unknown): Promise<string | undefined> => {
        if (providerHint !== "snowflake") return undefined;
        const requestId = await snowflakeRequestId(target);
        if (!requestId) return undefined;
        return snowflakeEventId(SNOWFLAKE_EVENT_ID_PREFIX, "rest", emitOpts.subscription, requestId);
      };

      // ONE emit per call, whichever trap the caller touches. `await p` and
      // `p.withResponse()` are both instrumented below and both resolve from the SAME
      // underlying APIPromise, so doing both — a caller reading usage, then reading
      // rate-limit headers — billed the call twice.
      let emitted = false;
      const emitOnce = (payload: unknown, eventId?: string) => {
        if (emitted) return;
        emitted = true;
        emitFrom(payload, modelId, eventId ? { ...emitOpts, eventId } : emitOpts);
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
                      emitOnce(value, await restEventId(target));
                    }
                  } else if (isAsyncIterable(value)) {
                    // Streaming reaches the header the same way: by the time the
                    // APIPromise has resolved to an iterable, the response headers have
                    // arrived, and `.asResponse()` reads them without consuming the body
                    // (verified live on a streamed Cortex call). The keyed opts ride into
                    // the stream wrapper, whose final-usage emit carries them.
                    const eventId = await restEventId(target);
                    next = wrapAsyncIterableStream(
                      value,
                      sdk,
                      modelId,
                      eventId ? { ...emitOpts, eventId } : emitOpts,
                      providerHint,
                    );
                  }
                } catch (err) {
                  // Never break the call — but reaching here means the call went
                  // uninstrumented, which is the same lost revenue as a failed extract.
                  sdk.reportError(err, "wrapper.openai");
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
                  emitOnce(result.data, await restEventId(target));
                }
              } catch (err) {
                sdk.reportError(err, "wrapper.openai");
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
      } catch (err) {
        // The streaming paths were the worst of the set: they swallowed without even a
        // log, so a drifted stream shape produced no signal anywhere at all.
        sdk.reportError(err, "adapter.openai");
      }
    }
  }
}
