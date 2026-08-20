/** LagoSDK — primary entrypoint. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { CanonicalUsage, NUMERIC_FIELDS, nonzeroNumeric } from "./canonical.js";
import { LagoConfig, PricingMode, makeConfig } from "./config.js";
import { detectClientKind } from "./detector.js";
import { PricingUnavailableError, UnknownClientError } from "./exceptions.js";
import { LagoClient, LagoEvent } from "./lago_client.js";
import {
  CostBreakdown,
  PricingProvider,
  applyMarkup,
  coerceMarkup,
  computeCost,
  computePrecomputedCost,
  deoverlappedTokenTotal,
  moneyStrToCents,
} from "./pricing.js";
import { EventQueue } from "./queue.js";
import { wrapAnthropicClient } from "./wrappers/anthropic.js";
import { wrapBedrockClient } from "./wrappers/bedrock.js";
import { wrapGeminiClient } from "./wrappers/gemini.js";
import { wrapMistralClient } from "./wrappers/mistral.js";
import { wrapOpenAIClient } from "./wrappers/openai.js";

const subscriptionStore = new AsyncLocalStorage<string>();

export interface LagoSDKOptions {
  apiKey: string;
  apiUrl?: string;
  defaultSubscriptionId?: string | null;
  /**
   * TLS certificate verification for requests to `apiUrl`. Accepted directly so a
   * local dev Lago behind a self-signed cert (Traefik's default) needs no `config`
   * object at all — `{ apiKey, apiUrl, verifySsl: false }` is enough. Mirrors the
   * Python port's `verify_ssl=` parameter.
   */
  verifySsl?: boolean;
  config?: Partial<LagoConfig>;
}

export interface WrapOptions {
  dimensions?: Record<string, unknown>;
  subscription?: string;
  /** Per-call override of the pricing mode (`tokens` | `price`). */
  mode?: PricingMode;
  /** Per-call override of the cost markup multiplier. */
  markup?: number;
  /**
   * Skip this SDK's own OpenRouter/Bedrock/Cloudflare price lookup and bill
   * this exact amount instead. For a gateway that reports its own real,
   * metered cost per call (e.g. Cloudflare AI Gateway's `cost` field on a
   * log entry), that number is more accurate than anything we'd compute
   * ourselves — this is the connector's one-call entrypoint rather than
   * hand-building a `precise_total_amount_cents` event. Only consulted
   * when the effective mode is "price"; ignored in token mode.
   */
  usdCost?: number;
  /**
   * Use this as Lago's idempotency key (`transaction_id`) instead of a
   * random UUID — pass the source log entry's own id when replaying/
   * backfilling from a gateway's logs, so re-running against the same
   * window never double-bills. A live, one-shot call has no natural id to
   * reuse and should leave this unset.
   *
   * Both multi-event paths suffix per field so they don't collide with each
   * other, and they use DIFFERENT namespaces so they can't collide across
   * modes either:
   *
   *   - token events      `${eventId}_tok_${fieldName}`
   *   - split cost events `${eventId}_cost_${fieldName}`
   *   - single cost event `eventId` (one event, nothing to disambiguate)
   *
   * The namespaces are load-bearing, because both paths are reachable for the SAME
   * `eventId`: a price lookup that misses falls back to token events, and the same
   * window re-run once the table is warm takes the cost path. Sharing one namespace
   * makes the second run a duplicate `transaction_id`, and since `/events/batch` is
   * all-or-nothing that rejection takes the whole batch with it.
   */
  eventId?: string;
}

export class LagoSDK {
  config: LagoConfig;
  private client: LagoClient;
  private queue: EventQueue;
  private pricing: PricingProvider;

  constructor(opts: LagoSDKOptions) {
    // Explicit options win over `config`. Spread order is load-bearing: with `config`
    // last, a `config.apiUrl` would beat an explicitly passed `apiUrl` and bill a
    // different Lago instance than the Python port does.
    this.config = makeConfig({
      ...(opts.config || {}),
      apiKey: opts.apiKey,
      ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
      ...(opts.defaultSubscriptionId !== undefined
        ? { defaultSubscriptionId: opts.defaultSubscriptionId }
        : {}),
      ...(opts.verifySsl !== undefined ? { verifySsl: opts.verifySsl } : {}),
    });
    this.client = new LagoClient(
      this.config.apiKey,
      this.config.apiUrl,
      this.config.requestTimeoutMs,
      this.config.verifySsl,
    );
    // Pricing provider (price mode). Default does no network until a price-mode
    // lookup flags a source stale; refreshes run on the queue loop.
    this.pricing =
      (this.config.pricingProvider as PricingProvider | undefined) ??
      new PricingProvider({
        ttlMs: this.config.pricingTtlMs,
        defaultRegion: this.config.bedrockDefaultRegion,
        onError: this.config.onError,
        cloudflareAccountId: this.config.cloudflareAccountId,
        cloudflareApiToken: this.config.cloudflareApiToken,
        mistralApiKey: this.config.mistralApiKey,
      });
    if (this.config.pricingMode === "price") this.pricing.prime(); // eager warm when price mode is the global default
    this.queue = new EventQueue(
      (batch) => this.client.sendBatch(batch),
      this.config.flushIntervalMs,
      this.config.maxBatchSize,
      this.config.maxBufferSize,
      this.config.maxRetryMs,
      this.config.onError,
      this.pricing,
    );
  }

  /** Run a callback with the given subscription bound in async-local context. */
  withSubscription<T>(subscriptionId: string, fn: () => T): T {
    return subscriptionStore.run(subscriptionId, fn);
  }

  /** One-shot setter — useful for middleware patterns where you set once per request. */
  setSubscription(subscriptionId: string): void {
    subscriptionStore.enterWith(subscriptionId);
  }

  private resolveSubscription(override?: string): string | null {
    return override || subscriptionStore.getStore() || this.config.defaultSubscriptionId || null;
  }

  /**
   * Non-blocking warm-up of the credential-gated pricing sources, triggered by `wrap()`
   * because it usually runs well before the first completion call. Price mode only.
   * `prime()`/`wake()` are pure in-memory; the HTTP fetch stays on the queue's loop.
   */
  private autoPrimePricingFor(kind: string, client: unknown): void {
    if (this.config.pricingMode !== "price") return;
    let provider: string | null = null;
    if (kind === "mistral") {
      // The client being wrapped already carries the exact Mistral API key
      // needed to call Mistral's own /v1/models for alias resolution — no
      // separate LagoConfig.mistralApiKey required.
      const key = LagoSDK.extractMistralApiKey(client);
      if (key) this.pricing.learnMistralApiKey(key);
      provider = "mistral";
    } else if (kind === "openai") {
      // An OpenAI-shaped client can point at real OpenAI or, via Cloudflare's
      // `.../compat` endpoint, at Workers AI; `baseURL` is the only signal available
      // before a response arrives. Defensive: some client variants omit it.
      let baseUrl = "";
      try {
        baseUrl = String((client as { baseURL?: unknown })?.baseURL ?? "");
      } catch {
        /* ignore */
      }
      if (baseUrl.includes("gateway.ai.cloudflare.com")) provider = "workers-ai";
    }
    if (provider) {
      this.pricing.prime([provider]);
      this.queue.wake();
    }
  }

  /**
   * `@mistralai/mistralai` keeps the constructor's key at `client._options.apiKey`. This
   * is an INTERNAL path: if a version moves it, this must degrade to "no key learned"
   * (then `LagoConfig.mistralApiKey`, then a lazy miss) rather than throw.
   */
  private static extractMistralApiKey(client: unknown): string | null {
    try {
      const key = (client as { _options?: { apiKey?: unknown } })?._options?.apiKey;
      return typeof key === "string" && key ? key : null;
    } catch {
      return null;
    }
  }

  /**
   * Block until the given price table(s) are fetched, instead of waiting
   * for the queue's background loop to pick them up on its next tick (up
   * to `flushIntervalMs` later, by default ~1s).
   *
   * Matters for a script or one-shot job, where the first call can beat that tick. A
   * miss falls back to token events — but in an `llm_cost`-only setup there is nowhere
   * to fall back to and the event is lost. OpenRouter is always warmed here.
   *
   * Workers AI and Mistral are credential-gated, so they are NOT warmed by default and
   * `wrap()` already primes them on a matching client. Name one — `["mistral"]`,
   * `["workers-ai"]` — only if you will call it WITHOUT `wrap()`.
   *
   * Resolves once the fetch was ATTEMPTED, not once it succeeded: a failure reports
   * through `onError` and leaves the table cold, same as a lazy miss.
   */
  async warmPricing(providers: string[] = []): Promise<void> {
    this.pricing.prime(providers);
    await this.pricing.maybeRefresh();
  }

  wrap<T extends object>(client: T, opts: WrapOptions = {}): T {
    const kind = detectClientKind(client);
    this.autoPrimePricingFor(kind, client);
    if (kind === "bedrock") {
      return wrapBedrockClient(this as never, client as never, opts) as T;
    }
    if (kind === "mistral") {
      return wrapMistralClient(this as never, client as never, opts) as T;
    }
    if (kind === "anthropic") {
      return wrapAnthropicClient(this as never, client as never, opts) as T;
    }
    if (kind === "openai") {
      return wrapOpenAIClient(this as never, client as never, opts) as T;
    }
    if (kind === "gemini") {
      return wrapGeminiClient(this as never, client as never, opts) as T;
    }
    if (kind === "gemini_legacy") {
      throw new UnknownClientError(
        "The legacy @google/generative-ai SDK (GoogleGenerativeAI) is not supported — " +
          "its surface differs from the unified SDK and cannot be instrumented. " +
          "Migrate to @google/genai: `npm install @google/genai`, then " +
          "`new GoogleGenAI({ apiKey })` and wrap that client. " +
          "See https://ai.google.dev/gemini-api/docs/migrate.",
      );
    }
    if (kind === "unknown") {
      throw new UnknownClientError(
        `Unknown client passed to wrap(): ${client.constructor?.name}. Supported: AWS SDK v3 BedrockRuntimeClient, @mistralai/mistralai Mistral, @anthropic-ai/sdk Anthropic, openai OpenAI, @google/genai GoogleGenAI.`,
      );
    }
    throw new UnknownClientError(
      `Client kind '${kind}' is not yet supported. Implemented: 'bedrock', 'mistral', 'anthropic', 'openai', 'gemini'.`,
    );
  }

  /**
   * Emit usage to Lago.
   *
   * In "tokens" mode (default), pushes one event per nonzero token field.
   * In "price" mode, pushes a single dollar-cost event (or one per
   * `token_type` — see `pushCostEvent`); if no price is available it falls
   * back to token events and reports via onError. Precedence for
   * mode/markup: per-call opt > config default.
   *
   * See `WrapOptions.usdCost`/`WrapOptions.eventId` for the connector-facing
   * (backfill/log-replay) use of this method.
   */
  emit(usage: CanonicalUsage, opts: WrapOptions = {}): void {
    try {
      const sub = this.resolveSubscription(opts.subscription);
      if (!sub) {
        this.reportError(new Error(`no subscription resolved for model=${usage.model}`), "emit");
        return;
      }
      const mode = opts.mode ?? this.config.pricingMode;
      if (mode !== "price") {
        if (opts.usdCost !== undefined && opts.usdCost !== null) {
          // A supplied cost that gets dropped must be reported, or a whole backfill
          // silently bills token counts only. Per occurrence, NOT deduped: the count of
          // discarded costs is what a caller reconciling on `onError` needs.
          this.reportError(
            new Error(
              `usdCost=${opts.usdCost} ignored: effective pricing mode is "${mode}", not ` +
                `"price" — emitting token counts instead. Pass mode: "price" per call, ` +
                `or set pricingMode: "price".`,
            ),
            "pricing",
          );
        }
        this.emitTokenEvents(usage, sub, opts.dimensions, opts.eventId);
        return;
      }
      const [markupScaled, ok] = coerceMarkup(opts.markup ?? this.config.markup);
      if (!ok) {
        this.reportError(
          new Error(`invalid markup ${opts.markup ?? this.config.markup}; using 1.0`),
          "pricing",
        );
      }

      let breakdown: CostBreakdown;
      // `!= null` deliberately covers BOTH undefined and null: an explicit null means
      // "no cost supplied" and must take the normal lookup path, not bill $0.00. Matches
      // Python's `usd_cost is not None`.
      if (opts.usdCost != null) {
        breakdown = computePrecomputedCost(opts.usdCost, markupScaled);
      } else {
        const price = this.pricing.lookup(usage.provider, usage.model, usage.api);
        if (price === null) {
          // Don't silently under-bill: fall back to token events + report.
          this.reportError(new PricingUnavailableError(usage.provider, usage.model, usage.api), "pricing");
          this.emitTokenEvents(usage, sub, opts.dimensions, opts.eventId);
          return;
        }
        breakdown = computeCost(usage, price, markupScaled);
      }
      this.pushCostEvent(usage, breakdown, sub, opts.dimensions, opts.eventId);
    } catch (err) {
      this.reportError(err, "emit");
    }
  }

  private emitTokenEvents(
    usage: CanonicalUsage,
    sub: string,
    dimensions?: Record<string, unknown>,
    eventId?: string,
  ): void {
    const counts = nonzeroNumeric(usage);
    const now = Math.floor(Date.now() / 1000);
    for (const field of NUMERIC_FIELDS) {
      const value = counts[field];
      if (!value) continue;
      const code = this.config.metricCodes[field];
      if (!code) continue;
      this.queue.push({
        // `_tok_` namespace — see `WrapOptions.eventId` for why it must differ from
        // the cost path's.
        transaction_id: eventId ? `${eventId}_tok_${field}` : randomUUID(),
        external_subscription_id: sub,
        code,
        timestamp: now,
        properties: {
          value: String(value),
          model: usage.model,
          provider: usage.provider,
          api: usage.api,
          ...(dimensions || {}),
        },
      });
    }
  }

  /**
   * Push one llm_cost event — or several, one per token_type, when a real
   * per-field breakdown exists.
   *
   * `breakdown.fields` exists only when WE priced per token (`computeCost`), where a
   * unit price is known per field. Then it is one event per field tagged `token_type`,
   * so Lago's `grouped_by: ["model", "token_type"]` charge can split both ways.
   *
   * A precomputed `usdCost` (e.g. the gateway's own metered cost) is one lump sum, so it
   * bills ONE event with no `token_type` — splitting it proportionally would substitute
   * a guess for the real number we took `usdCost` to avoid guessing at.
   */
  private pushCostEvent(
    usage: CanonicalUsage,
    breakdown: CostBreakdown,
    sub: string,
    dimensions: Record<string, unknown> | undefined,
    eventId: string | undefined,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    // Caller dimensions are spread LAST in each `properties` below, not here — they
    // must win over every SDK-computed key, exactly as they already do in
    // `emitTokenEvents`. Spreading them into `baseProperties` put them *before*
    // `unit`/`value`/`base_cost`/`unit_price`, so those four silently overwrote a
    // caller's same-named dimension on this path while honouring it on the token
    // path — one customer config, two different outcomes.
    const baseProperties: Record<string, unknown> = {
      model: usage.model,
      provider: usage.provider,
      api: usage.api,
      price_source: breakdown.source,
      markup: breakdown.markup,
    };

    if (Object.keys(breakdown.fields).length === 0) {
      this.queue.push({
        // Unsuffixed: this branch pushes exactly ONE event, so there is nothing
        // to disambiguate. It cannot collide with the namespaced multi-event ids.
        transaction_id: eventId || randomUUID(),
        external_subscription_id: sub,
        code: this.config.costMetricCode,
        timestamp: now,
        precise_total_amount_cents: breakdown.totalCents,
        properties: {
          ...baseProperties,
          // Same basis as the split path below (which reports the de-overlapped
          // per-field `parts.tokens`), so the two branches can't report different
          // quantities for one call. `input + output` dropped `reasoning` and
          // `cache_write` entirely — on a real captured Gemini row with 9 in /
          // 21 out / 852 reasoning it published unit="30" for a call that
          // consumed 882 — and counted a cache-inclusive provider's cached
          // tokens at full weight.
          unit: String(deoverlappedTokenTotal(usage)),
          value: breakdown.total,
          base_cost: breakdown.base,
          ...(dimensions || {}),
        },
      });
      return;
    }

    for (const [fieldName, parts] of Object.entries(breakdown.fields)) {
      // parts.cost is PRE-markup (computeCost only applies markup to the
      // summed total) — apply it here or a markup != 1.0 silently vanishes
      // from every split event.
      const billedCost = applyMarkup(parts.cost, breakdown.markup);
      this.queue.push({
        // `_cost_` namespace — see the `_tok_` note in emitTokenEvents.
        transaction_id: eventId ? `${eventId}_cost_${fieldName}` : randomUUID(),
        external_subscription_id: sub,
        code: this.config.costMetricCode,
        timestamp: now,
        precise_total_amount_cents: moneyStrToCents(billedCost),
        properties: {
          ...baseProperties,
          token_type: fieldName,
          unit: parts.tokens,
          value: billedCost,
          base_cost: parts.cost,
          unit_price: parts.unit_price,
          ...(dimensions || {}),
        },
      });
    }
  }

  private reportError(err: unknown, where: string): void {
    if (this.config.onError) {
      try {
        this.config.onError(err, where);
      } catch {
        /* ignore */
      }
    }
  }

  flush(timeoutMs: number = 5000): Promise<boolean> {
    return this.queue.flush(timeoutMs);
  }

  shutdown(timeoutMs: number = 5000): Promise<void> {
    return this.queue.shutdown(timeoutMs);
  }

  /** Tests-only: replace the queue's sender. */
  _setSender(fn: (batch: LagoEvent[]) => Promise<void>): void {
    // @ts-expect-error — touching private field for test injection
    this.queue.sender = fn;
  }

  /** Tests-only: replace the pricing provider. */
  _setPricingProvider(provider: PricingProvider): void {
    this.pricing = provider;
    // @ts-expect-error — touching private field for test injection
    this.queue.pricing = provider;
  }

  /** Tests-only: read HTTP call counter. */
  _httpCalls(): number {
    return this.queue.httpCalls;
  }
}
