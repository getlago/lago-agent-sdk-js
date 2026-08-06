/** Async batched event queue.
 *
 * Async-safe in-memory buffer. Background loop flushes every `flushIntervalMs`
 * or immediately when buffer reaches `maxBatchSize`. On a TRANSIENT send
 * failure (network error, 5xx), re-prepends the batch and applies exponential
 * backoff (1s → 60s cap). Resets on next success.
 *
 * A PERMANENT failure (Lago 4xx — e.g. a duplicate `transaction_id` from
 * replaying/backfilling the same window twice) is different: retrying it will
 * never succeed, so it is logged and dropped instead of re-queued. Without this
 * distinction, one permanently-doomed batch sits at the front of the FIFO
 * buffer and blocks every event queued behind it — including brand new,
 * perfectly valid ones — for the full backoff ceiling, over and over, since a
 * batch that can never succeed is retried exactly like one that might.
 *
 * Drains on `beforeExit` — keeps sending until the buffer is truly empty (not
 * just one batch's worth) or a bounded time budget is exhausted.
 */

import type { LagoEvent } from "./lago_client.js";
import { LagoApiError } from "./exceptions.js";

type Sender = (batch: LagoEvent[]) => Promise<void>;

/** A Lago 4xx (bad request, validation error, duplicate transaction_id, ...)
 * will never succeed by retrying the exact same batch. A 5xx or a
 * network-level exception (timeout, connection error, no LagoApiError at
 * all) might — those stay retryable. */
function isPermanentFailure(exc: unknown): boolean {
  return exc instanceof LagoApiError && exc.status >= 400 && exc.status < 500;
}

export class EventQueue {
  private buffer: LagoEvent[] = [];
  private wakeResolvers: Array<() => void> = [];
  private stopping = false;
  private backoffMs = 0;
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

  /** Nudge the background loop to run its tick (drain + pricing
   * `maybeRefresh()`) right now instead of waiting up to `flushIntervalMs`
   * for its next scheduled tick. Just resolves pending waiters — never
   * blocks, never does I/O on the caller's side. */
  wake(): void {
    const r = this.wakeResolvers.splice(0, this.wakeResolvers.length);
    for (const fn of r) fn();
  }

  // ---------- internal ----------
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

  /** Best-effort `onError` callback — a customer's own callback must never
   * be allowed to break the queue's send/retry loop. */
  private reportError(exc: unknown, where: string = "send_batch"): void {
    if (this.onError) {
      try {
        this.onError(exc, where);
      } catch {
        /* ignore */
      }
    }
  }

  /** Recovery path for a batch that failed with a permanent (4xx) error.
   *
   * Each event is sent alone: one that individually 4xxs (e.g. its own
   * transaction_id really is a duplicate) is logged and dropped for good;
   * one that succeeds alone is done; one that hits a TRANSIENT error while
   * isolated is re-queued for the normal backoff-and-retry path, same as any
   * other event. Reports once via onError for the batch as a whole (the
   * original exception) so a caller isn't flooded with N callbacks for
   * what's really one root cause. */
  private async sendIndividually(batch: LagoEvent[], batchExc: unknown): Promise<void> {
    this.reportError(batchExc);
    for (const event of batch) {
      try {
        this.httpCalls++;
        await this.sender([event]);
      } catch (exc) {
        if (isPermanentFailure(exc)) {
          console.warn(
            `[lago] dropping event (permanent failure, will not retry): transaction_id=${event.transaction_id}:`,
            exc,
          );
        } else {
          console.warn("[lago] send failed for isolated event, will retry:", exc);
          this.replayFailed([event]);
        }
      }
    }
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
          if (isPermanentFailure(exc)) {
            // Lago's batch endpoint is all-or-nothing: a single bad
            // transaction_id fails the WHOLE batch, even if the rest are
            // perfectly valid — re-queuing the batch as-is would retry (and
            // re-fail) forever, but dropping it outright would silently
            // lose those valid events too. Isolate by falling back to
            // one-by-one for this batch only; only the events that
            // individually 4xx get dropped.
            await this.sendIndividually(batch, exc);
            this.backoffMs = 0;
            continue;
          }
          this.replayFailed(batch);
          this.reportError(exc);
          console.warn("[lago] send_batch failed:", exc);
          this.backoffMs = this.backoffMs === 0 ? 1000 : Math.min(this.backoffMs * 2, this.maxRetryMs);
          break;
        }
      }
    }
    // Drain on exit — keep sending until the buffer is truly empty, not just
    // one batch's worth (a buffer holding more than maxBatchSize events at
    // shutdown previously left the rest never even attempted). No more
    // retries are possible once this loop exits, so unlike the main loop, a
    // transient failure here is ALSO final: it must be logged, never
    // silently swallowed the way a bare `catch { /* ignore */ }` previously
    // did — that's what actually lost events, not the network blip itself,
    // which by itself is recoverable if it's just reported. `sendIndividually`
    // re-queues transient sub-failures for retry — appropriate for the main
    // loop, which lives on, but during this exit drain that could spin
    // forever against a persistently-down network. Bound the whole drain by
    // wall-clock time; whatever's still in the buffer once the budget is
    // spent is logged as lost, not retried forever in an exiting process.
    const drainDeadline = Date.now() + Math.min(this.maxRetryMs, 10_000);
    while (Date.now() < drainDeadline) {
      const batch = this.takeBatch();
      if (batch.length === 0) break;
      try {
        await this.sender(batch);
      } catch (exc) {
        if (isPermanentFailure(exc)) {
          await this.sendIndividually(batch, exc);
        } else {
          this.reportError(exc);
          console.warn(
            `[lago] ${batch.length} event(s) LOST on shutdown — final drain failed with no more retries possible:`,
            exc,
          );
        }
      }
    }
    if (this.buffer.length > 0) {
      console.warn(`[lago] ${this.buffer.length} event(s) LOST on shutdown — drain time budget exhausted`);
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
