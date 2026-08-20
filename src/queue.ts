/** Async batched event queue.
 *
 * Async-safe in-memory buffer. Background loop flushes every `flushIntervalMs`
 * or immediately when buffer reaches `maxBatchSize`. On a TRANSIENT send
 * failure (network error, 5xx), re-prepends the batch and applies exponential
 * backoff (1s → 60s cap). Resets on next success.
 *
 * A PERMANENT failure (a Lago *validation* 4xx — e.g. a duplicate
 * `transaction_id` from replaying/backfilling the same window twice) is
 * different: retrying it will never succeed, so it is logged and dropped instead
 * of re-queued. Without this distinction, one permanently-doomed batch sits at
 * the front of the FIFO buffer and blocks every event queued behind it —
 * including brand new, perfectly valid ones — for the full backoff ceiling, over
 * and over, since a batch that can never succeed is retried exactly like one
 * that might.
 *
 * Note that "permanent" is a specific list of statuses, NOT the whole 4xx range —
 * see `PERMANENT_STATUSES`.
 *
 * Drains on `beforeExit` — keeps sending until the buffer is truly empty (not
 * just one batch's worth) or a bounded time budget is exhausted.
 */

import type { LagoEvent } from "./lago_client.js";
import { LagoApiError } from "./exceptions.js";

type Sender = (batch: LagoEvent[]) => Promise<void>;

// Statuses where re-sending the SAME batch can never succeed: the request itself is
// the problem (malformed body, bad credentials, a transaction_id Lago has already
// accepted). Deliberately an explicit list rather than the 400-499 range, because two
// 4xx statuses mean "try again, later": 429 (rate limited) and 408 (request timeout).
// Treating those as permanent dropped billable events AND fanned one throttled batch
// out into up to `maxBatchSize` extra requests aimed at the server that had just asked
// us to slow down.
// 413/402/415 are here for the OPPOSITE reason to 429: re-sending the same batch
// provably cannot succeed (too large, payment required, wrong media type), so treating
// them as transient re-prepended the identical batch at the head of the FIFO and backed
// off to 60s forever, blocking every event behind it until the buffer overflowed. Being
// "permanent" routes them to `sendIndividually`, which SPLITS the batch and delivers
// what is deliverable. 405/410 stay transient: they usually indicate a misrouted or
// retired endpoint, which a deploy can fix.
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 409, 413, 415, 422]);

/** True when re-sending this exact batch can never succeed.
 *
 * A validation 4xx (bad request, duplicate transaction_id, revoked key) will fail
 * identically forever, so it is isolated and dropped. Everything else — 5xx, a
 * network-level exception (timeout, connection error, no LagoApiError at all), and
 * the throttling 4xxs 429/408 — might succeed later and stays retryable. An
 * unrecognized 4xx is treated as transient: waiting on an event that would have been
 * dropped costs a delay, dropping one that would have been accepted costs revenue. */
function isPermanentFailure(exc: unknown): boolean {
  return exc instanceof LagoApiError && PERMANENT_STATUSES.has(exc.status);
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
    // Best effort wait for the loop to complete.
    //
    // The timeout arm MUST be both unref'd and cleared. `Promise.race` abandons the
    // loser but does not cancel it, so a plain `sleep(timeoutMs)` left a live, ref'd
    // timer behind for the FULL timeout after shutdown had already returned: a script
    // calling `await sdk.shutdown(15000)` returned in 0.2s and then sat there until
    // ~15s before the process could exit. That is the same class of bug as the
    // un-unref'd idle timer, but on the path taken by callers doing the right thing,
    // and it is why closing the undici Agent appeared to change nothing — the Agent
    // was never what held the loop open.
    await this.raceWithTimeout(this.loopPromise, timeoutMs);
  }

  /** `Promise.race` against a timer that cannot outlive the race. */
  private async raceWithTimeout(p: Promise<void>, ms: number): Promise<void> {
    let id: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<void>((resolve) => {
      id = setTimeout(resolve, ms);
      (id as unknown as { unref?: () => void }).unref?.();
    });
    try {
      await Promise.race([p, timer]);
    } finally {
      if (id !== undefined) clearTimeout(id);
    }
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
      // `unref` so an idle queue does NOT hold the event loop open. Without it the
      // loop never drains, which means `beforeExit` never fires — so a process that
      // relied on the shutdown hook instead of calling `shutdown()` neither exited
      // nor flushed, and its buffered events were lost. Python's daemon thread plus
      // `atexit` has neither problem.
      (id as unknown as { unref?: () => void }).unref?.();
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
    // Collected and re-queued ONCE at the end, not per event. `replayFailed`
    // unshifts, so calling it inside the loop reversed the survivors' relative
    // order: a 413 batch of a,b,c,d,e whose b,c,d fail transiently while isolated
    // came back as d,c,b. FIFO is the queue's contract — it is what makes the
    // oldest-dropped-first overflow policy and Lago's own event ordering
    // meaningful — so a recovery path must not silently invert it.
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
        } else {
          console.warn("[lago] send failed for isolated event, will retry:", exc);
          retry.push(event);
        }
      }
    }
    if (retry.length > 0) this.replayFailed(retry);
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
