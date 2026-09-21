/**
 * Workers AI client — the SDK's own, because there is no third-party one to wrap.
 *
 * Every other provider is instrumented by patching its official client in place. Workers
 * AI has no such target: the official `cloudflare` package (5.7.0, measured 2026-09-21)
 * percent-encodes the slash in every model name, so `client.ai.run("@cf/meta/...")` hits
 * `/ai/run/@cf%2Fmeta%2F...` and Cloudflare answers "No route for that URI" — for every
 * model, not just partner ones. Patching its generic `client.post(...)` instead would
 * instrument every Cloudflare API call the customer makes. So the SDK ships this client:
 * one method, two routes, chosen per model id.
 *
 * Two kinds of model, two routes — measured, not chosen:
 *
 * - `@cf/...` models go to the gateway host, `gateway.ai.cloudflare.com/v1/{acct}/{gw}/
 *   workers-ai/{model}`. That route answers with `cf-aig-cache-status` (a HIT means the
 *   model never ran and nothing is billed) and `cf-aig-log-id` (emitted as the `cf_log_id`
 *   dimension, so a Lago row can be put beside its Logs API entry — see
 *   `gateway/adapters/cloudflare_gateway.ts`). The model-in-body variant of that host,
 *   `.../workers-ai/run`, logs `model: "run"`, which is why it is not used for them.
 * - Partner models (`typesafe/jev` — no `@`) can only be reached on the *unified* path,
 *   `api.cloudflare.com/.../ai/run` with `{"model", "input"}` in the body and the gateway
 *   named in a `cf-aig-gateway-id` header. That is the one route where the partner key the
 *   customer stored under the gateway's BYOK is consulted; the gateway host answers 402
 *   "Insufficient balance" for the same call even with the key stored. The unified path
 *   returns NO `cf-aig-*` headers — a cached replay looks exactly like a fresh call — so
 *   this client sends `cf-aig-skip-cache: true` there rather than risk billing the same
 *   answer twice. Pass `extraHeaders: {"cf-aig-skip-cache": "false"}` to opt back in,
 *   knowing a replay then bills again.
 *
 * Billing is by token count from the response's own `usage` block. In price mode a
 * `@cf/...` model prices from Cloudflare's Workers AI catalog as usual; a partner model is
 * not listed there and prices from AI Gateway's own cost table instead, fetched per id on
 * the queue's next tick — so the first call to a partner model in a process bills tokens
 * and reports the miss through `onError`, and every call after it bills dollars (see
 * `parseCloudflareGatewayCost` in pricing.ts).
 */
import { extractWorkersAINative } from "./adapters/workers_ai_native.js";
import type { WrapOptions } from "./sdk.js";

const DIRECT_BASE = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
const GATEWAY_BASE = (accountId: string, gatewayId: string) =>
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai`;

/** `@cf/...` (and `@hf/...`) ids are Cloudflare-hosted; anything else is a partner model. */
function isCatalogModel(model: string): boolean {
  return model.startsWith("@");
}

export interface WorkersAIOptions {
  /** Route through this AI Gateway: cache-hit skipping and `cf_log_id` for `@cf/` models, BYOK for partner models. */
  gatewayId?: string;
  /** The gateway's `cf-aig-authorization` token, when the gateway has authentication on. */
  gatewayAuth?: string;
  timeoutMs?: number;
  /** Dimensions attached to every event this client emits. */
  dimensions?: Record<string, unknown>;
  /** Subscription for every call, below the per-call `lago.subscription` and above the SDK default. */
  subscription?: string;
}

export interface WorkersAIRunOptions {
  /** Same keys as the wrappers' per-call `lago` options: subscription, dimensions, mode, markup. */
  lago?: WrapOptions;
  /** Reaches the request as-is and wins over the client's own — e.g. `{"cf-aig-cache-ttl": "300"}`. */
  extraHeaders?: Record<string, string>;
}

/** The subset of LagoSDK this client needs — kept narrow so the module stays independent of sdk.ts internals. */
export interface WorkersAIHost {
  emit(usage: import("./canonical.js").CanonicalUsage, opts?: WrapOptions): void;
  resolveSubscription(override?: string): string | null;
  reportError(err: unknown, where: string): void;
}

/**
 * Cloudflare answered the run with an error status or `success: false`.
 *
 * Thrown *before* any instrumentation, so a 402 (partner model with no BYOK key and no
 * gateway credits), a 403 (model not on the account's Workers plan) or a 400 (no such
 * model) reaches the caller exactly as the API reported it, and nothing is billed for it.
 */
export class WorkersAIError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errors: Array<Record<string, unknown>>,
    public readonly body: Record<string, unknown>,
  ) {
    const detail = errors.length
      ? errors.map((e) => String(e.message ?? JSON.stringify(e))).join("; ")
      : "no error detail";
    super(`Workers AI HTTP ${statusCode}: ${detail}`);
    this.name = "WorkersAIError";
  }
}

/** Minimal Workers AI client with Lago instrumentation. Build one via `sdk.workersAI()`. */
export class WorkersAI {
  private readonly direct: string;
  private readonly gateway: string | null;
  private readonly gatewayId: string | null;
  private readonly auth: Record<string, string>;
  private readonly gatewayAuth: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly baseDims: Record<string, unknown>;
  private readonly baseSub?: string;

  constructor(
    private readonly sdk: WorkersAIHost,
    accountId: string,
    apiToken: string,
    opts: WorkersAIOptions = {},
  ) {
    this.direct = DIRECT_BASE(accountId);
    this.gatewayId = opts.gatewayId ?? null;
    this.gateway = opts.gatewayId ? GATEWAY_BASE(accountId, opts.gatewayId) : null;
    this.auth = { Authorization: `Bearer ${apiToken}` };
    this.gatewayAuth = opts.gatewayAuth ? { "cf-aig-authorization": `Bearer ${opts.gatewayAuth}` } : {};
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.baseDims = { ...(opts.dimensions ?? {}) };
    this.baseSub = opts.subscription;
  }

  /** The endpoint a `run(model, ...)` posts to — see the module comment for why two. */
  urlFor(model: string): string {
    if (isCatalogModel(model)) return this.gateway ? `${this.gateway}/${model}` : `${this.direct}/${model}`;
    return this.direct;
  }

  /** (headers, body) for the route `urlFor(model)` picks. */
  private requestFor(
    model: string,
    input: Record<string, unknown>,
  ): { headers: Record<string, string>; body: Record<string, unknown> } {
    if (isCatalogModel(model)) {
      // Path route: the body IS the input. Gateway auth only on the gateway host.
      return { headers: { ...this.auth, ...(this.gateway ? this.gatewayAuth : {}) }, body: input };
    }
    const headers: Record<string, string> = { ...this.auth };
    if (this.gatewayId) {
      headers["cf-aig-gateway-id"] = this.gatewayId;
      headers["cf-aig-skip-cache"] = "true"; // no cache header on this path — see module comment
    }
    return { headers, body: { model, input } };
  }

  /**
   * Run `model` on `input` and bill the response's usage.
   *
   * `input` is whatever the model takes: `{messages: [...]}` for a chat model,
   * `{state, questions}` for `typesafe/jev`. Resolves to Cloudflare's full response
   * envelope (`result`, `success`, `errors`, `messages`) unchanged.
   *
   * Streaming (`input.stream = true`) is refused up front: the body would be an SSE stream
   * this method does not parse, and mis-reading it as JSON would bill zero for a call that
   * ran. Use the OpenAI-compatible `/compat` endpoint through `sdk.wrap(new OpenAI(...))`
   * for streamed chat.
   */
  async run(
    model: string,
    input: Record<string, unknown>,
    opts: WorkersAIRunOptions = {},
  ): Promise<Record<string, unknown>> {
    if (input.stream) {
      throw new Error(
        "WorkersAI.run() does not support stream: true; for streamed chat completions wrap an " +
          "OpenAI client against the gateway's /compat endpoint instead.",
      );
    }
    const lago = opts.lago ?? {};
    const { headers, body } = this.requestFor(model, input);
    Object.assign(headers, opts.extraHeaders ?? {});
    const sub = this.sdk.resolveSubscription(lago.subscription ?? this.baseSub);
    if (this.gatewayId && sub && !("cf-aig-metadata" in headers)) {
      // Attribution travels with the call: the gateway stores this on the log entry, so the
      // Logs API backfill resolves the same subscription this emit() uses. Honoured on both
      // routes (measured on the unified path: the log row carried it).
      headers["cf-aig-metadata"] = JSON.stringify({ lago_subscription: sub });
    }

    const resp = await fetch(this.urlFor(model), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = await resp.json();
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
        payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (resp.status >= 400 || payload.success === false) {
      const errors = Array.isArray(payload.errors) ? (payload.errors as Array<Record<string, unknown>>) : [];
      throw new WorkersAIError(resp.status, errors, payload);
    }

    try {
      if (resp.headers.get("cf-aig-cache-status") === "HIT") {
        // The gateway answered from its cache; the model never ran and Cloudflare billed
        // nothing. Billing it would charge for a call that did not happen.
        return payload;
      }
      const usage = extractWorkersAINative(payload, model);
      const dimensions: Record<string, unknown> = { ...this.baseDims, ...(lago.dimensions ?? {}) };
      const logId = resp.headers.get("cf-aig-log-id");
      if (logId) dimensions.cf_log_id = logId;
      this.sdk.emit(usage, {
        subscription: sub ?? undefined,
        dimensions,
        mode: lago.mode,
        markup: lago.markup,
      });
    } catch (err) {
      // Instrumentation never breaks the customer's call.
      this.sdk.reportError(err, "emit");
    }
    return payload;
  }
}
