/** LagoSDK — primary entrypoint. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { CanonicalUsage, NUMERIC_FIELDS, nonzeroNumeric } from "./canonical.js";
import { LagoConfig, makeConfig } from "./config.js";
import { detectClientKind } from "./detector.js";
import { UnknownClientError } from "./exceptions.js";
import { LagoClient, LagoEvent } from "./lago_client.js";
import { EventQueue } from "./queue.js";
import { wrapBedrockClient } from "./wrappers/bedrock.js";
import { wrapMistralClient } from "./wrappers/mistral.js";

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
}

export class LagoSDK {
  config: LagoConfig;
  private client: LagoClient;
  private queue: EventQueue;

  constructor(opts: LagoSDKOptions) {
    this.config = makeConfig({
      apiKey: opts.apiKey,
      apiUrl: opts.apiUrl,
      defaultSubscriptionId: opts.defaultSubscriptionId,
      ...(opts.config || {}),
    });
    this.client = new LagoClient(this.config.apiKey, this.config.apiUrl, this.config.requestTimeoutMs);
    this.queue = new EventQueue(
      (batch) => this.client.sendBatch(batch),
      this.config.flushIntervalMs,
      this.config.maxBatchSize,
      this.config.maxBufferSize,
      this.config.maxRetryMs,
      this.config.onError,
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
    if (kind === "unknown") {
      throw new UnknownClientError(
        `Unknown client passed to wrap(): ${client.constructor?.name}. Supported: AWS SDK v3 BedrockRuntimeClient, @mistralai/mistralai Mistral.`,
      );
    }
    throw new UnknownClientError(
      `Client kind '${kind}' is not yet supported. Implemented: 'bedrock', 'mistral'.`,
    );
  }

  emit(usage: CanonicalUsage, opts: WrapOptions = {}): void {
    try {
      const sub = this.resolveSubscription(opts.subscription);
      if (!sub) {
        if (this.config.onError) {
          try {
            this.config.onError(new Error(`no subscription resolved for model=${usage.model}`), "emit");
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const counts = nonzeroNumeric(usage);
      const now = Math.floor(Date.now() / 1000);
      for (const field of NUMERIC_FIELDS) {
        const value = counts[field];
        if (!value) continue;
        const code = this.config.metricCodes[field];
        if (!code) continue;
        const event: LagoEvent = {
          transaction_id: randomUUID(),
          external_subscription_id: sub,
          code,
          timestamp: now,
          properties: {
            value: String(value),
            model: usage.model,
            provider: usage.provider,
            api: usage.api,
            ...(opts.dimensions || {}),
          },
        };
        this.queue.push(event);
      }
    } catch (err) {
      if (this.config.onError) {
        try {
          this.config.onError(err, "emit");
        } catch {
          /* ignore */
        }
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

  /** Tests-only: read HTTP call counter. */
  _httpCalls(): number {
    return this.queue.httpCalls;
  }
}
