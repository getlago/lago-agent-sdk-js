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

// Statuses where re-sending the SAME batch can never succeed, because the BATCH is what
// is wrong. Deliberately an explicit list, not the 400-499 range.
//
// The test is: **is what makes this fail a property of the batch?** If a DIFFERENT
// PAYLOAD is what it takes to succeed, the batch is doomed and belongs here, where
// `sendIndividually` splits it and delivers whatever is deliverable. If an OUT-OF-BAND
// change fixes it — someone rotates a key back, pays an invoice, corrects a URL, fixes a
// proxy — the events are still perfectly billable and must be HELD, because dropping
// them is unrecoverable while holding them is bounded (`maxBufferSize`, oldest-first,
// reported through `onError`).
//
// Every line below was measured by driving this queue over a real socket at a server
// returning that status, counting events actually delivered (`probes/t11_status_matrix`):
//
//   400  malformed body — a different payload is the only fix. PERMANENT.
//   413  too large — the size IS the batch. Isolating it is a real recovery, not a
//        formality: against an nginx-style server answering 413 over a byte limit and
//        200 under it, the split path delivered 5 of 5. Held instead, it delivered 0 and
//        stalled at the backoff ceiling forever. Not reachable from Lago itself — an
//        oversized batch there answers 422 `too_many_events` (probed live, 20k events /
//        3.5 MiB) — so this exists for `client_max_body_size` in front of Lago.
//   409  a conflicting id. Lago answers 422 for a replayed `transaction_id`, not 409
//        (probed live); 409 stays as defence against an intermediary that uses it.
//   422  Lago's real answer for a duplicate id, an oversized batch and a bad
//        content-type. PERMANENT — but note it reaches `sendIndividually`, which is
//        what lets the valid events in a batch survive one bad transaction_id.
//
// Everything else is transient, including these, which used to be here and lost money:
//
//   401/403  a rotated or revoked key. Measured with a server that healed after 3s —
//            i.e. the key put back — classified permanent this destroyed all 5 events
//            inside the first second, and none of them ever reached Lago. Held, all 5
//            were delivered when it healed.
//   402      payment required — a property of the ACCOUNT; it stops being true the
//            moment someone pays. Measured against a 402 server: 5 events in, 6 HTTP
//            calls out, 0 recoverable, one `onError` for the lot.
//   404      the endpoint, not the events: Lago answers 404 `resource_not_found` for a
//            wrong PATH (probed live), which is a mistyped `apiUrl` — fixed out-of-band
//            like a rotated key, and the same class as the 405/410 that were already
//            transient here for exactly that reason. It was destroying every event.
//   415      a wrong media type comes from a proxy, and splitting cannot help: this
//            client always sends `application/json`, so every isolated send fails the
//            same way — measured, all 5 dropped. Held, they survive the proxy being
//            fixed. (Lago itself answers 422 to a bad content-type, probed live.)
//   429/408  throttling — fanning a batch into N isolated sends aims more traffic at a
//            server that just asked us to slow down.
//
// An unrecognized 4xx is transient too: waiting on an event that would have been dropped
// costs a delay, dropping one that would have been accepted costs revenue.
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 409, 413, 422]);

// While the buffer stays full, at most one overflow report per this interval. A sustained
// overload must keep saying so — a single report at the start would go stale — but it
// must not say so once per dropped event.
const OVERFLOW_REPORT_INTERVAL_MS = 1000;

/** True when re-sending this exact batch can never succeed.
 *
 * Only a malformed or unacceptable BATCH qualifies — see `PERMANENT_STATUSES` for the
 * test and for what each status cost when it was on the wrong side of it. Everything
 * else (5xx, a network-level exception with no LagoApiError at all, a credential or
 * account or endpoint 4xx, an unrecognized 4xx) might succeed later and stays
 * retryable. */
function isPermanentFailure(exc: unknown): boolean {
  return exc instanceof LagoApiError && PERMANENT_STATUSES.has(exc.status);
}

export class EventQueue {
  private buffer: LagoEvent[] = [];
  /** Events that have left `buffer` but are not yet delivered — in flight, or parked in
   * a retry backoff waiting to be. Without this they are counted nowhere, and `flush()`
   * reads an empty buffer as "everything arrived". */
  private inFlight = 0;
  private wakeResolvers: Array<() => void> = [];
  private stopResolvers: Array<() => void> = [];
  private stopping = false;
  private backoffMs = 0;
  private loopPromise: Promise<void>;
  /** Detaches this queue's `process` listeners. Set by `installShutdownHook`. */
  private releaseShutdownHook: () => void = () => {};
  /** for tests */
  public httpCalls = 0;
  /** Events dropped to buffer overflow over this queue's life. Cumulative, never reset. */
  public droppedEvents = 0;
  /** Dropped but not yet named in a report — see `reportOverflow`. */
  private droppedSinceReport = 0;
  /** True while the buffer is full and dropping, so the next report is a continuation
   * rather than a fresh episode. */
  private inOverflow = false;
  private lastOverflowReportAt = 0;

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
    // `.catch` here is not bookkeeping. Nothing awaits `loopPromise` until `shutdown()`
    // does, and under Node's default `--unhandled-rejections=throw` an unhandled
    // rejection TERMINATES the host process — measured: a throw inside the loop killed
    // it with exit code 1, no `onError`, nothing naming billing as the cause. An
    // instrumentation SDK taking down the customer's application is the one failure it
    // must never cause, and the asymmetry settles it: one line here against a process
    // kill.
    //
    // The loop does not resume, and cannot do so silently: the buffer keeps filling and
    // starts reporting overflow on top of this report. Restarting it is a separate
    // decision — one that keeps dying for the same reason would spin — and not one to
    // take implicitly here.
    this.loopPromise = this.run().catch((err) => {
      this.reportError(err, "queue_loop");
      warn("[lago] event queue loop stopped — events will stop being delivered:", err);
    });
    this.installShutdownHook();
  }

  push(event: LagoEvent): void {
    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
      this.droppedEvents++;
      this.droppedSinceReport++;
      const now = Date.now();
      // Reported at once when the buffer first fills — an operator needs to know while
      // it still is — and then at most once per second for as long as it stays full.
      // Everything in between is counted, not reported; see `reportOverflow`.
      if (!this.inOverflow || now - this.lastOverflowReportAt >= OVERFLOW_REPORT_INTERVAL_MS) {
        this.inOverflow = true;
        this.reportOverflow(false);
      }
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBatchSize) this.wake();
  }

  /** Name the events dropped since the last report, if any.
   *
   * Coalescing is the whole point. This used to call `onError` once PER DROPPED EVENT:
   * measured, a 50,000-event burst against the default 10,000 buffer produced **40,000
   * separate callbacks** for one root cause — a thundering herd aimed at whatever the
   * customer wired up, which is usually an error tracker. The queue already refuses to
   * do this for a failed batch, for exactly this reason; see `sendIndividually`.
   *
   * It also LOGS now, which it never did. Coalescing is what makes that affordable, and
   * without it a customer who set no `onError` got no signal at all for a dropped event
   * — while the two other places this queue drops one, `sendIndividually` and the exit
   * drain, both log.
   *
   * `endEpisode` marks the buffer as no longer overflowing, so the next drop counts as a
   * fresh episode and is reported immediately rather than waiting out the interval. */
  private reportOverflow(endEpisode: boolean): void {
    if (endEpisode) this.inOverflow = false;
    const dropped = this.droppedSinceReport;
    if (dropped === 0) return;
    this.droppedSinceReport = 0;
    this.lastOverflowReportAt = Date.now();
    this.reportError(
      new Error(
        `queue overflow: dropped ${dropped} oldest event(s), buffer is full at ${this.maxBufferSize}`,
      ),
      "overflow",
    );
    warn(
      `[lago] ${dropped} event(s) DROPPED — buffer full at ${this.maxBufferSize}. ` +
        `Events are arriving faster than they can be delivered; raise maxBufferSize or lower the emit rate.`,
    );
  }

  /** Wait until every event pushed so far has actually reached Lago.
   *
   * `true` means delivered. It must not mean "the buffer looks empty": `takeBatch`
   * removes a batch from `buffer` BEFORE the send is attempted, so for the duration of
   * a send — and for the whole of a retry backoff, which reaches 60s — the events are
   * in neither `buffer` nor Lago. Reading `buffer.length` alone therefore reported
   * success on events that had not been sent yet, and on events whose send then failed.
   *
   * `outstanding()` closes that window. A batch put back by `replayFailed` is briefly
   * counted twice, in `buffer` and in `inFlight`; over-counting only ever makes this
   * wait longer, which is the safe direction for a caller that is about to exit. */
  async flush(timeoutMs: number = 5000): Promise<boolean> {
    // The running overflow total is named before returning, whichever way this goes: a
    // caller that flushes is asking what happened, and the tail of an episode would
    // otherwise wait on a drop that may never come.
    try {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (this.outstanding() === 0) return true;
        this.wake();
        await sleep(10);
      }
      // Re-checked rather than a bare `false`: the last sleep can straddle the deadline
      // and the delivery it was waiting for may have landed inside it.
      return this.outstanding() === 0;
    } finally {
      this.reportOverflow(true);
    }
  }

  /** Events pushed but not yet delivered — buffered plus in flight. */
  private outstanding(): number {
    return this.buffer.length + this.inFlight;
  }

  async shutdown(timeoutMs: number = 5000): Promise<void> {
    await this.flush(timeoutMs);
    this.stopping = true;
    this.wake();
    // Release anything parked in a backoff sleep, so shutdown reaches the exit drain
    // instead of waiting out a backoff that can be a full minute long.
    for (const fn of this.stopResolvers.splice(0, this.stopResolvers.length)) fn();
    await this.awaitLoop(timeoutMs);
    // This queue is finished, so its `process` listeners must go. Left attached they
    // did two things: kept every dead queue (and its buffer) reachable for the life of
    // the process, and let `beforeExit` run a SECOND full shutdown after an explicit
    // one had already completed.
    this.releaseShutdownHook();
  }

  /** Wait for the background loop to finish, giving up after `timeoutMs`.
   *
   * Deliberately not `Promise.race([this.loopPromise, sleep(timeoutMs)])`. The loser of
   * a race keeps running, and that `sleep` was a REF'D timer, so `await shutdown()`
   * resolved immediately and then held the event loop open for the whole budget —
   * measured on the defaults, `shutdown()` resolved in 0ms and the process exited
   * 7003ms later: 5000ms for this timer, then `beforeExit` firing a second
   * `shutdown(2000)` for the rest. The loop's own timers were already `unref`'d for
   * exactly this reason; these two were missed.
   *
   * Cleared when the loop finishes, and `unref`'d as well so it cannot hold the loop
   * open even in the branch where the timeout is the one that wins. */
  private awaitLoop(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, timeoutMs);
      (id as unknown as { unref?: () => void }).unref?.();
      const done = () => {
        clearTimeout(id);
        resolve();
      };
      this.loopPromise.then(done, done);
    });
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
          warn(
            `[lago] dropping event (permanent failure, will not retry): transaction_id=${event.transaction_id}:`,
            exc,
          );
        } else if (requeueTransient) {
          warn("[lago] send failed for isolated event, will retry:", exc);
          retry.push(event);
        } else {
          this.reportError(exc, "shutdown_drain");
          warn(`[lago] event LOST on shutdown — no retry left: transaction_id=${event.transaction_id}:`, exc);
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
      if (batch.length === 0) {
        // Caught up: the buffer has room again, so whatever was dropped is now a closed
        // episode with a final count. Reported here rather than only on `flush()`,
        // because a producer that stops pushing would otherwise leave the tail unnamed.
        this.reportOverflow(true);
        return;
      }
      // Counted from the instant the batch leaves the buffer, not from the instant the
      // send starts. The gap between the two is the backoff sleep below, which reaches
      // a full minute — the longest stretch over which these events used to exist
      // nowhere `flush()` could see them.
      this.inFlight += batch.length;
      try {
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
          warn("[lago] send_batch failed:", exc);
          this.backoffMs = this.nextBackoff();
          return;
        }
      } finally {
        this.inFlight -= batch.length;
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
      // Same accounting as the main drain: `shutdown()` calls `flush()` first, so the
      // two can overlap and a flush must not read this batch as delivered.
      this.inFlight += batch.length;
      try {
        await this.sender(batch);
      } catch (exc) {
        if (isPermanentFailure(exc)) {
          await this.sendIndividually(batch, exc, false);
        } else {
          this.reportError(exc);
          warn(
            `[lago] ${batch.length} event(s) LOST on shutdown — final drain failed with no more retries possible:`,
            exc,
          );
        }
      } finally {
        this.inFlight -= batch.length;
      }
    }
    if (this.buffer.length > 0) {
      warn(`[lago] ${this.buffer.length} event(s) LOST on shutdown — drain time budget exhausted`);
    }
  }

  private installShutdownHook(): void {
    if (typeof process === "undefined" || typeof process.on !== "function") return;
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
    // `beforeExit` alone was not enough: it does not fire on a signal or on an explicit
    // `process.exit()` — i.e. the normal ways a containerized poller dies — so buffered
    // events were silently lost in exactly those cases, where Python's `atexit` drained
    // them. Signals re-raise after draining so the caller's own handlers and the
    // process's exit code are unaffected.
    //
    // What this covers and what it cannot, measured route by route: natural exit,
    // SIGINT, SIGTERM and SIGHUP drain; `process.exit()`, an uncaught exception, an
    // unhandled rejection and SIGQUIT do not. `process.exit()` is synchronous, so no
    // async drain can exist there. The two error routes are deliberate: a library that
    // installs `uncaughtException` or `unhandledRejection` SUPPRESSES the host's own
    // crash, and no billing SDK should change that. SIGQUIT's default is an immediate
    // core dump and is meant not to be intercepted.
    const onBeforeExit = () => void drain();
    const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
    process.once("beforeExit", onBeforeExit);
    // SIGHUP is what a closing terminal and a detaching container send; it was dropping
    // every buffered event, and it takes the same treatment as its two neighbours.
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = async () => {
        await drain();
        if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
      };
      signalHandlers.push([sig, handler]);
      process.once(sig, handler);
    }
    this.releaseShutdownHook = () => {
      process.removeListener("beforeExit", onBeforeExit);
      for (const [sig, handler] of signalHandlers) process.removeListener(sig, handler);
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `console.warn` that cannot itself break the send/retry loop.
 *
 * The queue logged directly, on paths with no `try` around them — `sendIndividually`,
 * the drain's failure branch, the exit drain. A `console` that throws is not exotic: a
 * structured-logger shim can, and a test runner's console throws by design once the test
 * that owns it has finished ("Cannot log after tests are done"). Any of those turned a
 * retryable network blip into a rejected background loop, which is what used to take the
 * host process down with it. */
function warn(...args: unknown[]): void {
  try {
    console.warn(...args);
  } catch {
    /* a logger that fails must not cost billing */
  }
}
