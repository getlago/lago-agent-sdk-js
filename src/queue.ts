/** Async batched event queue.
 *
 * In-memory buffer; a background loop flushes every `flushIntervalMs`, or at once when
 * the buffer reaches `maxBatchSize`.
 *
 * A TRANSIENT failure (network error, 5xx, throttling) re-prepends the batch and backs
 * off exponentially (1s → 60s cap), resetting on the next success. A PERMANENT failure
 * is one only a different payload could fix, so retrying it forever would head-of-line
 * block the whole FIFO; it is isolated one event at a time and the bad events dropped.
 * "Permanent" is a specific list of statuses, not the whole 4xx range — see
 * `PERMANENT_STATUSES`.
 *
 * Drains on exit until the buffer is empty or a bounded time budget is spent; whatever
 * is left is reported, never dropped in silence.
 */

import type { LagoEvent } from "./lago_client.js";
import { LagoApiError } from "./exceptions.js";

type Sender = (batch: LagoEvent[]) => Promise<void>;

// Statuses where re-sending the SAME batch can never succeed, because the BATCH is
// what is wrong: a malformed body, or a transaction_id Lago has already accepted.
//
// Deliberately an explicit list, not the 400-499 range. The test is "is this a property
// of the batch?" If an out-of-band change fixes it rather than a different payload, the
// events are still billable and must be HELD, not dropped. So this excludes:
//   429/408  throttling — fanning a batch into N isolated sends aims more traffic at a
//            server that just asked us to slow down
//   401/403  a rotated or revoked key — held, it blocks at the 60s ceiling until
//            `maxBufferSize` overflows: bounded, oldest-first, reported, recoverable
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 404, 409, 422]);

/** True when re-sending this exact batch can never succeed.
 *
 * Anything not on the list — 5xx, a network-level exception with no LagoApiError at
 * all, an unrecognized 4xx — is transient: waiting on an event that would have been
 * dropped costs a delay, dropping one that would have been accepted costs revenue. */
function isPermanentFailure(exc: unknown): boolean {
  return exc instanceof LagoApiError && PERMANENT_STATUSES.has(exc.status);
}

export class EventQueue {
  private buffer: LagoEvent[] = [];
  private wakeResolvers: Array<() => void> = [];
  private stopResolvers: Array<() => void> = [];
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
    // Release anything parked in a backoff sleep, so shutdown reaches the exit drain
    // instead of waiting out a backoff that can be a full minute long.
    for (const fn of this.stopResolvers.splice(0, this.stopResolvers.length)) fn();
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
      // `unref` so an idle queue never holds the event loop open: `beforeExit` only
      // fires once the loop drains, and that is what triggers the shutdown hook. A
      // ref'd timer here means a process that relies on the hook neither exits nor
      // flushes. Python's daemon thread plus `atexit` has neither problem.
      (id as unknown as { unref?: () => void }).unref?.();
      const once = () => {
        clearTimeout(id);
        resolve();
      };
      this.wakeResolvers.push(once);
    });
  }

  /** Backoff sleep that returns early once shutdown begins — Python's
   * `self._stopping.wait(timeout=...)`. It must be interruptible, or a backoff at the
   * 60s ceiling outlives the shutdown window and the exit drain never runs. NOT
   * `waitWake`: that is also woken by `flush()` and `push()`, which would cut short the
   * very pause a 429 asked us to take. */
  private sleepUnlessStopping(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(id);
        this.stopResolvers = this.stopResolvers.filter((fn) => fn !== done);
        resolve();
      };
      const id = setTimeout(done, ms);
      // Same reasoning as `waitWake`: never hold the event loop open on our own.
      (id as unknown as { unref?: () => void }).unref?.();
      this.stopResolvers.push(done);
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

  /** Recovery path for a batch that failed with a permanent error.
   *
   * Each event is sent alone: one that individually fails permanently is dropped for
   * good; one that succeeds is done; one that hits a TRANSIENT error is re-queued for
   * the normal backoff-and-retry path. Reports once via onError for the batch as a
   * whole, so a caller isn't flooded with N callbacks for one root cause.
   *
   * Returns the number of events put back on the buffer — the caller needs it to know
   * whether the buffer actually shrank, and so whether draining on can make progress.
   *
   * `requeueTransient: false` is for the exit drain, where no later retry exists: an
   * event put back there is re-taken on the next iteration with no delay, so a batch
   * that keeps failing is a hot loop for the whole drain budget. Reported as lost
   * instead — which is already what the drain does with a transient batch failure. */
  private async sendIndividually(
    batch: LagoEvent[],
    batchExc: unknown,
    requeueTransient: boolean = true,
  ): Promise<number> {
    this.reportError(batchExc);
    const retry: LagoEvent[] = [];
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
        } else if (requeueTransient) {
          console.warn("[lago] send failed for isolated event, will retry:", exc);
          retry.push(event);
        } else {
          this.reportError(exc, "shutdown_drain");
          console.warn(
            `[lago] event LOST on shutdown — no retry left: transaction_id=${event.transaction_id}:`,
            exc,
          );
        }
      }
    }
    // Collected and re-queued in ONE call, never one per event: `replayFailed`
    // prepends, so N separate calls invert the batch and Lago receives descending
    // timestamps for the same subscription. Reachable whenever a batch 4xxs on one bad
    // row and then hits throttling partway through the isolation walk.
    if (retry.length > 0) this.replayFailed(retry);
    return retry.length;
  }

  /** 1s → 2s → 4s → … → `maxRetryMs`. */
  private nextBackoff(): number {
    return this.backoffMs === 0 ? 1000 : Math.min(this.backoffMs * 2, this.maxRetryMs);
  }

  /** Send everything buffered, one batch at a time, until the buffer is empty or a
   * failure hands the batch to the retry backoff. Returns rather than looping on a
   * failure: the caller waits out `flushIntervalMs` and comes back. */
  private async drainBuffer(): Promise<void> {
    while (true) {
      const batch = this.takeBatch();
      if (batch.length === 0) return;
      // Re-checked every iteration, not only when backing off. `return`, never a
      // path that abandons the batch: the exit drain is what reports whatever it
      // cannot send, so the events must be back on the buffer before leaving.
      if (this.stopping) {
        this.replayFailed(batch);
        return;
      }
      if (this.backoffMs > 0) {
        await this.sleepUnlessStopping(this.backoffMs);
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
          // Lago's batch endpoint is all-or-nothing: one bad transaction_id fails the
          // WHOLE batch. Re-queuing as-is would re-fail forever; dropping outright
          // would lose the valid events with it. Isolate one-by-one, this batch only.
          const requeued = await this.sendIndividually(batch, exc);
          if (requeued === 0) {
            // Batch fully resolved — the buffer shrank, so keep draining immediately.
            this.backoffMs = 0;
            continue;
          }
          // Some isolated sends failed transiently and went back on the buffer.
          // `continue` here re-takes them with no delay and re-fails at the speed of
          // the failure — an unbounded spin that starves the event loop. They must go
          // through the normal backoff path.
          this.backoffMs = this.nextBackoff();
          return;
        }
        this.replayFailed(batch);
        this.reportError(exc);
        console.warn("[lago] send_batch failed:", exc);
        this.backoffMs = this.nextBackoff();
        return;
      }
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      await this.waitWake(this.flushIntervalMs);

      // Drain BEFORE refreshing pricing, not after. `maybeRefresh()` does HTTP — up to
      // a 10s timeout per source — and refreshing first put that latency in front of
      // every queued billable event, on every tick; a source that kept failing repeated
      // it indefinitely. Nothing in the drain depends on it: an event's price was
      // already resolved at emit() time, so a fresh table only ever matters to the NEXT
      // call.
      await this.drainBuffer();

      // Refresh pricing tables on this background loop (off the hot path). Skipped
      // once shutting down: a fetch here can take the full HTTP timeout, and it would
      // spend the caller's shutdown budget on a table nothing will ever read.
      if (this.pricing && !this.stopping) {
        try {
          await this.pricing.maybeRefresh();
        } catch {
          /* pricing must never break the queue */
        }
      }

      // Anything pushed while the refresh was in flight would otherwise wait out a
      // whole flush interval on top of it.
      if (!this.stopping) await this.drainBuffer();
    }
    // Drain on exit until the buffer is truly empty, not just one batch's worth. No
    // retry is possible past this point, so a transient failure here is ALSO final and
    // must be reported rather than swallowed — an unreported drop is what loses events,
    // not the network blip. `sendIndividually` re-queues transient sub-failures, which
    // is right for the main loop but could spin forever in an exiting process, so the
    // whole drain is bounded by wall-clock time and the remainder reported as lost.
    const drainDeadline = Date.now() + Math.min(this.maxRetryMs, 10_000);
    while (Date.now() < drainDeadline) {
      const batch = this.takeBatch();
      if (batch.length === 0) break;
      try {
        await this.sender(batch);
      } catch (exc) {
        if (isPermanentFailure(exc)) {
          await this.sendIndividually(batch, exc, false);
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
      let ran = false;
      const drain = async () => {
        if (ran) return;
        ran = true;
        try {
          await this.shutdown(2000);
        } catch {
          /* ignore */
        }
      };
      // `beforeExit` alone was not enough: it does not fire on SIGINT, SIGTERM or
      // an explicit `process.exit()` — i.e. the normal ways a containerized poller
      // dies — so buffered events were silently lost in exactly those cases, where
      // Python's `atexit` drained them. Signals re-raise after draining so the
      // caller's own handlers and the process's exit code are unaffected.
      process.once("beforeExit", drain);
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.once(sig, async () => {
          await drain();
          if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
        });
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
