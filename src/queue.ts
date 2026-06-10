/** Async batched event queue.
 *
 * Async-safe in-memory buffer. Background loop flushes every `flushIntervalMs`
 * or immediately when buffer reaches `maxBatchSize`. On send failure,
 * re-prepends the batch and applies exponential backoff (1s → 60s cap).
 * Drains on `beforeExit`.
 */

import type { LagoEvent } from "./lago_client.js";

type Sender = (batch: LagoEvent[]) => Promise<void>;

export class EventQueue {
  private buffer: LagoEvent[] = [];
  private wakeResolvers: Array<() => void> = [];
  private stopping = false;
  private backoffMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void>;
  /** for tests */
  public httpCalls = 0;

  constructor(
    private sender: Sender,
    private flushIntervalMs: number = 1000,
    private maxBatchSize: number = 100,
    private maxBufferSize: number = 10_000,
    private maxRetryMs: number = 60_000,
    private onError?: (err: unknown, where: string) => void,
    // Optional PricingProvider — its (async) HTTP refresh runs on this loop so
    // the customer's call is never blocked on pricing.
    private pricing?: { maybeRefresh(): Promise<void> },
  ) {
    this.loopPromise = this.run();
    this.installShutdownHook();
  }

  push(event: LagoEvent): void {
    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
      if (this.onError) {
        try {
          this.onError(new Error(`queue overflow at ${this.maxBufferSize}`), "overflow");
        } catch {
          /* ignore */
        }
      }
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatchSize) this.wake();
  }

  async flush(timeoutMs: number = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.buffer.length === 0) return true;
      this.wake();
      await sleep(10);
    }
    return false;
  }

  async shutdown(timeoutMs: number = 5000): Promise<void> {
    await this.flush(timeoutMs);
    this.stopping = true;
    this.wake();
    // Best effort wait for the loop to complete
    await Promise.race([this.loopPromise, sleep(timeoutMs)]);
  }

  // ---------- internal ----------
  private wake(): void {
    const r = this.wakeResolvers.splice(0, this.wakeResolvers.length);
    for (const fn of r) fn();
  }

  private waitWake(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        this.wakeResolvers = this.wakeResolvers.filter((fn) => fn !== once);
        resolve();
      }, timeoutMs);
      const once = () => {
        clearTimeout(id);
        resolve();
      };
      this.wakeResolvers.push(once);
    });
  }

  private takeBatch(): LagoEvent[] {
    if (this.buffer.length === 0) return [];
    const n = Math.min(this.maxBatchSize, this.buffer.length);
    return this.buffer.splice(0, n);
  }

  private replayFailed(batch: LagoEvent[]): void {
    this.buffer.unshift(...batch);
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      await this.waitWake(this.flushIntervalMs);

      // Refresh pricing tables on this background loop (off the hot path).
      if (this.pricing) {
        try {
          await this.pricing.maybeRefresh();
        } catch {
          /* pricing must never break the queue */
        }
      }

      while (true) {
        const batch = this.takeBatch();
        if (batch.length === 0) break;
        if (this.backoffMs > 0) {
          await sleep(this.backoffMs);
          if (this.stopping) {
            this.replayFailed(batch);
            return;
          }
        }
        try {
          this.httpCalls++;
          await this.sender(batch);
          this.backoffMs = 0;
        } catch (exc) {
          this.replayFailed(batch);
          this.backoffMs = this.backoffMs === 0 ? 1000 : Math.min(this.backoffMs * 2, this.maxRetryMs);
          if (this.onError) {
            try {
              this.onError(exc, "send_batch");
            } catch {
              /* ignore */
            }
          }
          break;
        }
      }
    }
    // drain
    const last = this.takeBatch();
    if (last.length > 0) {
      try {
        await this.sender(last);
      } catch {
        /* ignore on shutdown */
      }
    }
  }

  private installShutdownHook(): void {
    if (typeof process !== "undefined" && typeof process.on === "function") {
      const handler = async () => {
        try {
          await this.shutdown(2000);
        } catch {
          /* ignore */
        }
      };
      process.once("beforeExit", handler);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
