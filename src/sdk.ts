/** LagoSDK — primary entrypoint. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { CanonicalUsage, NUMERIC_FIELDS, nonzeroNumeric } from "./canonical.js";
import { LagoConfig, PricingMode, makeConfig } from "./config.js";
import { detectClientKind } from "./detector.js";
import { PricingUnavailableError, UnknownClientError } from "./exceptions.js";
import { LagoClient, LagoEvent } from "./lago_client.js";
import { ModelPrice, PricingProvider, coerceMarkup, computeCost } from "./pricing.js";
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
  config?: Partial<LagoConfig>;
}

export interface WrapOptions {
  dimensions?: Record<string, unknown>;
  subscription?: string;
  /** Per-call override of the pricing mode (`tokens` | `price`). */
  mode?: PricingMode;
  /** Per-call override of the cost markup multiplier. */
  markup?: number;
}

export class LagoSDK {
  config: LagoConfig;
  private client: LagoClient;
  private queue: EventQueue;
  private pricing: PricingProvider;

  constructor(opts: LagoSDKOptions) {
    this.config = makeConfig({
      apiKey: opts.apiKey,
      apiUrl: opts.apiUrl,
      defaultSubscriptionId: opts.defaultSubscriptionId,
      ...(opts.config || {}),
    });
    this.client = new LagoClient(this.config.apiKey, this.config.apiUrl, this.config.requestTimeoutMs);
    // Pricing provider (price mode). Default does no network until a price-mode
    // lookup flags a source stale; refreshes run on the queue loop.
    this.pricing =
      (this.config.pricingProvider as PricingProvider | undefined) ??
      new PricingProvider({
        ttlMs: this.config.pricingTtlMs,
        defaultRegion: this.config.bedrockDefaultRegion,
        onError: this.config.onError,
      });
    if (this.config.pricingMode === "price") this.pricing.prime();
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

  wrap<T extends object>(client: T, opts: WrapOptions = {}): T {
    const kind = detectClientKind(client);
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

  emit(usage: CanonicalUsage, opts: WrapOptions = {}): void {
    try {
      const sub = this.resolveSubscription(opts.subscription);
      if (!sub) {
        this.reportError(new Error(`no subscription resolved for model=${usage.model}`), "emit");
        return;
      }
      const mode = opts.mode ?? this.config.pricingMode;
      if (mode !== "price") {
        this.emitTokenEvents(usage, sub, opts.dimensions);
        return;
      }
      const price = this.pricing.lookup(usage.provider, usage.model, usage.api);
      if (price === null) {
        // Don't silently under-bill: fall back to token events + report.
        this.reportError(new PricingUnavailableError(usage.provider, usage.model, usage.api), "pricing");
        this.emitTokenEvents(usage, sub, opts.dimensions);
        return;
      }
      const [markupScaled, ok] = coerceMarkup(opts.markup ?? this.config.markup);
      if (!ok) {
        this.reportError(
          new Error(`invalid markup ${opts.markup ?? this.config.markup}; using 1.0`),
          "pricing",
        );
      }
      this.emitCostEvent(usage, price, markupScaled, sub, opts.dimensions);
    } catch (err) {
      this.reportError(err, "emit");
    }
  }

  private emitTokenEvents(usage: CanonicalUsage, sub: string, dimensions?: Record<string, unknown>): void {
    const counts = nonzeroNumeric(usage);
    const now = Math.floor(Date.now() / 1000);
    for (const field of NUMERIC_FIELDS) {
      const value = counts[field];
      if (!value) continue;
      const code = this.config.metricCodes[field];
      if (!code) continue;
      this.queue.push({
        transaction_id: randomUUID(),
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

  private emitCostEvent(
    usage: CanonicalUsage,
    price: ModelPrice,
    markupScaled: bigint,
    sub: string,
    dimensions?: Record<string, unknown>,
  ): void {
    const breakdown = computeCost(usage, price, markupScaled);
    // `unit` = total tokens for the call — the quantity the sum-aggregation
    // billable metric sums (the dynamic charge's fee comes from
    // precise_total_amount_cents; unit is the displayed usage quantity).
    // Sum the *billed* per-field counts from the breakdown, which computeCost has
    // already de-overlapped (e.g. cache_read carved out of input), so subset
    // fields aren't double-counted in the displayed total.
    const unit = Object.values(breakdown.fields).reduce((s, p) => s + Number(p.tokens), 0);
    const properties: Record<string, unknown> = {
      unit: String(unit),
      value: breakdown.total,
      base_cost: breakdown.base,
      markup: breakdown.markup,
      model: usage.model,
      provider: usage.provider,
      api: usage.api,
      price_source: breakdown.source,
    };
    for (const [field, parts] of Object.entries(breakdown.fields)) {
      properties[`${field}_tokens`] = parts.tokens;
      properties[`${field}_unit_price`] = parts.unit_price;
      properties[`${field}_cost`] = parts.cost;
    }
    Object.assign(properties, dimensions || {});
    this.queue.push({
      transaction_id: randomUUID(),
      external_subscription_id: sub,
      code: this.config.costMetricCode,
      timestamp: Math.floor(Date.now() / 1000),
      // Top-level amount (in cents) for Lago's dynamic charge model — the charge
      // sums these into a single fee.
      precise_total_amount_cents: breakdown.totalCents,
      properties,
    });
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
