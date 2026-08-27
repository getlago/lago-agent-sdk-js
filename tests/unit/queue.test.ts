/** Event queue — batching, retry, backoff, flush, overflow. */
import { describe, expect, it } from "vitest";

import { EventQueue } from "../../src/queue.js";
import type { LagoEvent } from "../../src/lago_client.js";
import { LagoApiError } from "../../src/exceptions.js";

function ev(i: number): LagoEvent {
  return {
    transaction_id: `t${i}`,
    external_subscription_id: "sub",
    code: "llm_input_tokens",
    timestamp: 0,
    properties: { i },
  };
}

function evId(id: string): LagoEvent {
  return {
    transaction_id: id,
    external_subscription_id: "sub",
    code: "llm_input_tokens",
    timestamp: 0,
    properties: { id },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("EventQueue", () => {
  it("100 pushes produce ≤ 3 batched HTTP calls", async () => {
    const sent: LagoEvent[][] = [];
    const q = new EventQueue(
      async (b) => {
        sent.push(b);
      },
      50,
      100,
    );
    for (let i = 0; i < 100; i++) q.push(ev(i));
    expect(await q.flush(2000)).toBe(true);
    await q.shutdown(1000);
    expect(q.httpCalls).toBeLessThanOrEqual(3);
    expect(sent.flat()).toHaveLength(100);
  });

  it("retries on failure with exponential backoff", async () => {
    let calls = 0;
    const q = new EventQueue(
      async () => {
        calls++;
        if (calls <= 2) throw new Error("boom");
      },
      50,
      10,
      10_000,
      500,
    );
    for (let i = 0; i < 5; i++) q.push(ev(i));
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && calls <= 2) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(calls).toBeGreaterThanOrEqual(3);
    await q.shutdown(1000);
  });

  it("buffer overflow drops oldest", async () => {
    let resolveRelease: () => void = () => {};
    const release = new Promise<void>((r) => {
      resolveRelease = r;
    });
    const q = new EventQueue(
      async () => {
        await release;
      },
      10_000,
      1,
      5,
    );
    for (let i = 0; i < 10; i++) q.push(ev(i));
    // Buffer is capped at 5 — we may be sending one batch already, so length ≤ 5
    // @ts-expect-error — touch private buffer for test
    expect(q.buffer.length).toBeLessThanOrEqual(5);
    resolveRelease();
    await q.shutdown(2000);
  });

  it("flush returns false on timeout", async () => {
    let resolveRelease: () => void = () => {};
    const release = new Promise<void>((r) => {
      resolveRelease = r;
    });
    const q = new EventQueue(
      async () => {
        await release;
      },
      50,
      1,
    );
    for (let i = 0; i < 5; i++) q.push(ev(i));
    await new Promise((r) => setTimeout(r, 50));
    const ok = await q.flush(50);
    expect(ok).toBe(false);
    resolveRelease();
    await q.shutdown(2000);
  });
});

// ----------------------------------------------------------------------
// Permanent (4xx) vs transient failures. A duplicate transaction_id from
// replaying/backfilling the same window twice will NEVER succeed by
// retrying the same batch — it must be isolated and dropped, not block real
// events queued behind it forever the same way a genuine transient failure
// would.
// ----------------------------------------------------------------------
describe("EventQueue — permanent vs transient failures", () => {
  it("isolates bad events from good ones in the same batch", async () => {
    // Lago's batch endpoint is all-or-nothing: one duplicate transaction_id
    // fails the WHOLE batch even though the other events are perfectly
    // valid. Naively dropping the batch would silently lose those valid
    // events too — the queue must fall back to one-by-one to tell them apart.
    const sentIndividually: string[] = [];
    const errors: Array<[unknown, string]> = [];

    const sender = async (batch: LagoEvent[]) => {
      if (batch.length > 1) {
        throw new LagoApiError(422, '{"error_details":{"transaction_id":["value_already_exist"]}}');
      }
      const event = batch[0];
      sentIndividually.push(event.transaction_id);
      if (event.transaction_id === "dup_1" || event.transaction_id === "dup_2") {
        throw new LagoApiError(422, '{"error_details":{"transaction_id":["value_already_exist"]}}');
      }
      // "good_*" events succeed alone.
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 60_000, (exc, where) => errors.push([exc, where]));
    try {
      for (const id of ["dup_1", "good_1", "dup_2", "good_2"]) q.push(evId(id));
      expect(await q.flush(2000)).toBe(true);
    } finally {
      await q.shutdown(1000);
    }

    // All four were tried individually — the two "good" ones weren't
    // silently dropped along with the two duplicates just because they
    // shared a batch.
    expect(new Set(sentIndividually)).toEqual(new Set(["dup_1", "good_1", "dup_2", "good_2"]));
    // onError fires once for the batch-level failure, not once per dropped item.
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toBe("send_batch");
  });

  it("does not apply backoff after a permanent failure", async () => {
    // Retrying a permanently-doomed batch with exponential backoff is
    // pointless — the isolate-and-drop path must not slow down subsequent
    // genuinely-transient failures by leaving a stale backoff in place.
    const sender = async (batch: LagoEvent[]) => {
      throw new LagoApiError(422, "duplicate"); // every isolated event is also a dup here
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      q.push(evId("dup_1"));
      q.push(evId("dup_2"));
      expect(await q.flush(2000)).toBe(true); // drains fast — no backoff wait, unlike a transient failure
      // @ts-expect-error — touch private backoffMs for test
      expect(q.backoffMs).toBe(0);
    } finally {
      await q.shutdown(1000);
    }
  });

  it("still retries a transient failure that happens during isolation", async () => {
    // An event that hits a network-level (non-4xx) error while being sent
    // individually is a real transient failure — it must still go through
    // the normal re-queue-and-retry path, not get treated as permanent.
    let flakyAttempts = 0;

    const sender = async (batch: LagoEvent[]) => {
      if (batch.length > 1) throw new LagoApiError(422, "duplicate"); // forces the isolate-one-by-one path
      const event = batch[0];
      if (event.transaction_id === "flaky") {
        flakyAttempts++;
        if (flakyAttempts === 1) throw new Error("transient network blip"); // not a LagoApiError at all
        return; // succeeds on the retried attempt
      }
      if (event.transaction_id === "dup") throw new LagoApiError(422, "duplicate");
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      q.push(evId("dup"));
      q.push(evId("flaky"));
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && flakyAttempts < 2) {
        await sleep(50);
      }
      expect(flakyAttempts).toBeGreaterThanOrEqual(2);
    } finally {
      await q.shutdown(2000);
    }
  });
});

// ----------------------------------------------------------------------
// The throttling 4xxs. 429 and 408 sit inside the 400-499 range but mean "try
// again, later" — classifying them as permanent dropped billable events and
// aimed `maxBatchSize` extra requests at a server that had just asked us to
// slow down.
// ----------------------------------------------------------------------
// Which side of the permanent/transient line each 4xx belongs on. The test is whether a
// DIFFERENT PAYLOAD is what it would take to succeed (permanent, so `sendIndividually`
// can split the batch and save what is savable) or whether an OUT-OF-BAND change fixes
// it (transient, so the events must be held — dropping them is unrecoverable, holding
// them is bounded by `maxBufferSize`). See `PERMANENT_STATUSES` for what each status
// cost when it was on the wrong side, measured over a real socket.
describe("EventQueue — which 4xx is permanent", () => {
  it.each([429, 408])("retries rather than drops a %i", async (status) => {
    // Dropping loses revenue, and isolating one-by-one multiplies the load on
    // a server that is already shedding it.
    let attempts = 0;
    const delivered: string[] = [];

    const sender = async (batch: LagoEvent[]) => {
      attempts++;
      if (attempts === 1) throw new LagoApiError(status, '{"error":"too many requests"}');
      for (const e of batch) delivered.push(e.transaction_id);
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      q.push(evId("a"));
      q.push(evId("b"));
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && delivered.length === 0) await sleep(50);
      expect(delivered).toEqual(["a", "b"]);
      // Delivered as one batch, i.e. never fanned out into per-event requests.
      expect(attempts).toBe(2);
    } finally {
      await q.shutdown(2000);
    }
  });

  it.each([429, 408])("applies backoff on a %i", async (status) => {
    // The inverse of "does not apply backoff after a permanent failure": a
    // throttling failure is transient, so it MUST leave a backoff in place —
    // that pause is the whole point of respecting a rate limit.
    const sender = async () => {
      throw new LagoApiError(status, "slow down");
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      q.push(evId("a"));
      const deadline = Date.now() + 2000;
      // @ts-expect-error — touch private backoffMs for test
      while (Date.now() < deadline && q.backoffMs === 0) await sleep(50);
      // @ts-expect-error — touch private backoffMs for test
      expect(q.backoffMs).toBeGreaterThan(0);
    } finally {
      await q.shutdown(1000);
    }
  });

  it.each([
    [401, "a rotated or revoked key"],
    [403, "a key that lost its scope"],
    [402, "an unpaid account"],
    [404, "a mistyped apiUrl"],
    [415, "a proxy rejecting the media type"],
  ])("holds rather than drops a %i — %s is not the batch", async (status, cause) => {
    // None of these is a property of the BATCH, so dropping the events is unrecoverable
    // while holding them is not. Each was in PERMANENT_STATUSES, which routes to
    // sendIndividually: the batch fails, every isolated send fails the same way, and
    // each event is logged and dropped for good. Measured over a real socket at a server
    // returning 401 for 3s and then 200 — the shape of a key being put back — all 5
    // events were destroyed inside the first second and none ever reached Lago. Held,
    // all 5 were delivered when it healed. So this asserts recovery, not merely
    // "not dropped".
    let attempts = 0;
    const delivered: string[] = [];
    const sender = async (batch: LagoEvent[]) => {
      attempts++;
      if (attempts === 1) throw new LagoApiError(status as number, String(cause));
      for (const e of batch) delivered.push(e.transaction_id); // the out-of-band fix lands
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      q.push(evId("a"));
      q.push(evId("b"));
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && delivered.length === 0) await sleep(50);
      expect(delivered).toEqual(["a", "b"]);
      // Held as one batch — never fanned out into per-event requests.
      expect(attempts).toBe(2);
    } finally {
      await q.shutdown(2000);
    }
  });

  it("treats an unrecognized 4xx as transient", async () => {
    // Only the enumerated validation statuses are permanent. An unfamiliar 4xx
    // errs toward retrying: a needless delay costs latency, a wrong drop costs
    // revenue.
    let attempts = 0;
    const delivered: string[] = [];

    const sender = async (batch: LagoEvent[]) => {
      attempts++;
      if (attempts === 1) throw new LagoApiError(418, "i am a teapot");
      for (const e of batch) delivered.push(e.transaction_id);
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      q.push(evId("a"));
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && delivered.length === 0) await sleep(50);
      expect(delivered).toEqual(["a"]);
    } finally {
      await q.shutdown(2000);
    }
  });

  it.each([413])("splits a batch-only %i instead of head-of-line blocking", async (status) => {
    // 413 is the one status where the SAME batch can never succeed but its events can
    // individually, so isolating it is a real recovery rather than a formality.
    // Measured over a real socket at an nginx-style server answering 413 above a byte
    // limit and 200 below it: routed here, the split path delivered 5 of 5. Classified
    // transient, it delivered 0 and stalled at the backoff ceiling forever.
    const sentIndividually: number[] = [];
    const sender = async (batch: LagoEvent[]) => {
      if (batch.length > 1) throw new LagoApiError(status, "batch too large as-is");
      sentIndividually.push(Number(batch[0].transaction_id)); // each event succeeds alone
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      for (let i = 0; i < 4; i++) q.push(evId(String(i)));
      expect(await q.flush(3000)).toBe(true);
      expect(sentIndividually.sort()).toEqual([0, 1, 2, 3]);
      // Splitting must not leave a stale backoff behind.
      expect((q as unknown as { backoffMs: number }).backoffMs).toBe(0);
    } finally {
      await q.shutdown(1000);
    }
  });

  it.each([400, 409, 413, 422])("still isolates and drops on a %i", async (status) => {
    // The statuses that genuinely cannot succeed on a re-send keep the
    // isolate-one-by-one behaviour, so a single bad transaction_id still
    // doesn't take the rest of its batch down with it.
    const sentIndividually: string[] = [];

    const sender = async (batch: LagoEvent[]) => {
      if (batch.length > 1) throw new LagoApiError(status, "batch rejected");
      const event = batch[0];
      sentIndividually.push(event.transaction_id);
      if (event.transaction_id.startsWith("bad")) {
        throw new LagoApiError(status, "this one really is invalid");
      }
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      q.push(evId("bad_1"));
      q.push(evId("good_1"));
      expect(await q.flush(2000)).toBe(true);
      expect(new Set(sentIndividually)).toEqual(new Set(["bad_1", "good_1"]));
      // @ts-expect-error — touch private backoffMs for test
      expect(q.backoffMs).toBe(0);
    } finally {
      await q.shutdown(1000);
    }
  });
});

// ----------------------------------------------------------------------
// Shutdown's final drain. Previously: a single best-effort attempt at a
// single batch, with any failure silently swallowed — a buffer holding
// more than one batch's worth of events at shutdown time left the rest
// never even attempted.
// ----------------------------------------------------------------------
describe("EventQueue — shutdown drain", () => {
  it("drains more than one batch", async () => {
    // Buffer holds 3 batches' worth of events right as shutdown starts —
    // every one of them must be attempted, not just the first.
    const sent: LagoEvent[] = [];
    const q = new EventQueue(
      async (b) => {
        sent.push(...b);
      },
      10_000,
      5,
    );
    for (let i = 0; i < 15; i++) q.push(ev(i)); // 3 full batches of 5, loop hasn't had a flush tick yet
    await q.shutdown(2000);
    expect(sent).toHaveLength(15);
  });

  it("reports a transient failure instead of silently swallowing it", async () => {
    // A persistently-failing sender at shutdown time must surface via
    // onError — not vanish behind a bare swallowed catch the way it used to.
    const errors: Array<[unknown, string]> = [];
    const alwaysFails = async () => {
      throw new Error("network still down");
    };

    const q = new EventQueue(alwaysFails, 10_000, 10, 10_000, 1000, (exc, where) =>
      errors.push([exc, where]),
    );
    q.push(ev(1));
    await q.shutdown(3000);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0][1]).toBe("send_batch");
    expect(String(errors[0][0])).toContain("network still down");
  });
});

// ----------------------------------------------------------------------
// A permanent batch failure whose isolated sends fail TRANSIENTLY puts those
// events back on the buffer. Retrying them with no delay is an unbounded spin
// at the speed of the failure, which also starves the event loop and never
// re-checks `stopping`.
// ----------------------------------------------------------------------
describe("EventQueue — no unbounded respin after isolating a batch", () => {
  it("paces re-queued events instead of spinning", async () => {
    let calls = 0;
    const sender = async (batch: LagoEvent[]) => {
      calls++;
      // Permanent on the batch, transient on every isolated send: the exact pair
      // that used to loop with zero delay.
      throw new LagoApiError(batch.length > 1 ? 422 : 429, "x");
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 60_000);
    try {
      for (const id of ["a", "b", "c"]) q.push(evId(id));
      // A plain timer must still get a turn — the spin starved the event loop
      // entirely, so this never resolved.
      let timerFired = false;
      setTimeout(() => (timerFired = true), 300);
      await sleep(1200);
      expect(timerFired).toBe(true);
      // 1 batch + 3 isolated + at most a couple of paced retries. The spin did
      // hundreds of thousands in this window.
      expect(calls).toBeLessThan(40);
      // @ts-expect-error — touch private backoffMs for test
      expect(q.backoffMs).toBeGreaterThan(0);
    } finally {
      await q.shutdown(500);
    }
  });

  it("does not respin during the exit drain either", async () => {
    // The drain has no later retry, so re-queuing a transient sub-failure there means
    // re-taking it immediately — a hot loop for the whole drain budget. Those events
    // must be reported as lost instead.
    let calls = 0;
    const lost: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => {
      const s = a.map(String).join(" ");
      if (s.includes("LOST")) lost.push(s);
    };
    const sender = async (batch: LagoEvent[]) => {
      calls++;
      throw new LagoApiError(batch.length > 1 ? 422 : 429, "x");
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 60_000);
    try {
      for (const id of ["a", "b", "c"]) q.push(evId(id));
      await sleep(400);
      const before = calls;
      await q.shutdown(1500);
      // 1 batch + 3 isolated sends per pass, not thousands.
      expect(calls - before).toBeLessThan(20);
      expect(lost.length).toBeGreaterThan(0);
    } finally {
      console.warn = origWarn;
    }
  });

  it("keeps draining when isolation fully resolves the batch", async () => {
    // The counterpart: nothing re-queued means the buffer shrank, so the loop
    // should keep going immediately rather than waiting for the next tick.
    const delivered: string[] = [];
    const sender = async (batch: LagoEvent[]) => {
      if (batch.length > 1) throw new LagoApiError(422, "batch rejected");
      delivered.push(batch[0].transaction_id);
    };

    const q = new EventQueue(sender, 50, 2, 10_000, 500);
    try {
      for (const id of ["a", "b", "c", "d"]) q.push(evId(id));
      expect(await q.flush(3000)).toBe(true);
      expect(new Set(delivered)).toEqual(new Set(["a", "b", "c", "d"]));
    } finally {
      await q.shutdown(1000);
    }
  });
});

// ----------------------------------------------------------------------
// Shutting down while the loop sits in its backoff sleep must still reach the
// exit drain. Returning early skipped both the drain and its warning, so the
// buffered events were abandoned with nothing logged.
// ----------------------------------------------------------------------
describe("EventQueue — shutdown during backoff", () => {
  it("reports what it could not send instead of abandoning it silently", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(" "));
    const sender = async () => {
      throw new Error("network down");
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 60_000);
    try {
      q.push(evId("a"));
      // Wait until the loop has actually entered backoff.
      const deadline = Date.now() + 2000;
      // @ts-expect-error — touch private backoffMs for test
      while (Date.now() < deadline && q.backoffMs === 0) await sleep(25);
      await q.shutdown(300);
      expect(warnings.some((w) => w.includes("LOST"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });
});

// ----------------------------------------------------------------------
// FIFO across an isolation walk. `replayFailed` PREPENDS, so re-queuing the
// transient sub-failures one at a time inverts them and Lago receives descending
// timestamps for one subscription. Reachable whenever a batch 4xxs on one bad row
// and then hits throttling partway through the walk.
// ----------------------------------------------------------------------
describe("EventQueue — arrival order survives an isolation walk", () => {
  it("re-queues transient sub-failures in arrival order, not reversed", async () => {
    const sends: string[][] = [];
    let isolating = true;
    const sender = async (batch: LagoEvent[]) => {
      sends.push(batch.map((e) => e.transaction_id));
      if (!isolating) return;
      // Permanent on the batch -> isolate; t1 is the genuinely bad row, the rest are
      // throttled mid-recovery.
      if (batch.length > 1) throw new LagoApiError(422, "one bad row");
      if (batch[0].transaction_id === "t1") throw new LagoApiError(422, "duplicate");
      throw new LagoApiError(503, "throttled");
    };

    const q = new EventQueue(sender, 25, 100, 10_000, 60_000, () => {});
    for (let i = 1; i <= 5; i++) q.push(ev(i));

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && sends.length < 6) await sleep(25);
    isolating = false;

    const requeued = await (async () => {
      const stop = Date.now() + 4000;
      while (Date.now() < stop) {
        const later = sends.slice(6).find((s) => s.length > 1);
        if (later) return later;
        await sleep(25);
      }
      return undefined;
    })();

    await q.shutdown(500);
    expect(requeued).toEqual(["t2", "t3", "t4", "t5"]);
  });
});

// ----------------------------------------------------------------------
// Pricing refresh must not sit in front of the drain. maybeRefresh() does HTTP with a
// 10s timeout per source; refreshing first made every queued billable event wait
// behind it on every tick, and a source that kept failing repeated that forever.
// ----------------------------------------------------------------------
describe("EventQueue — a slow pricing refresh does not delay event delivery", () => {
  it("delivers the batch before the refresh completes", async () => {
    const REFRESH_MS = 600;
    let refreshDone = false;
    const pricing = {
      async maybeRefresh() {
        await sleep(REFRESH_MS);
        refreshDone = true;
        throw new Error("bad credential"); // the failing case, which used to repeat every tick
      },
    };

    let deliveredBeforeRefresh: boolean | undefined;
    const q = new EventQueue(
      async () => {
        deliveredBeforeRefresh ??= !refreshDone;
      },
      25,
      100,
      10_000,
      60_000,
      () => {},
      pricing,
    );

    q.push(ev(1));
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && deliveredBeforeRefresh === undefined) await sleep(10);
    await q.shutdown(500);

    expect(deliveredBeforeRefresh).toBe(true);
  });
});

// ----------------------------------------------------------------------
// A queue that has been shut down must let the process go.
//
// `flush()` and `shutdown()` used the module-level `sleep()`, whose timer is NOT
// `unref`'d — unlike the loop's own `waitWake` and `sleepUnlessStopping`, which are,
// with a comment saying exactly why. `Promise.race([loopPromise, sleep(timeoutMs)])`
// leaves the loser running, so `await shutdown()` resolved and then held the event loop
// open for the whole budget. And the `beforeExit`/signal listeners were never removed,
// so exit ran a SECOND full shutdown on top.
//
// Measured on the defaults before the fix: `await sdk.shutdown()` resolved in 0ms and
// the process exited 7003ms later (5000 for the timer, then `beforeExit` firing
// `shutdown(2000)`). After: 2ms.
//
// The assertions here are handle and listener counts, not elapsed time — both are
// properties of the code rather than of the machine the suite runs on.
// ----------------------------------------------------------------------
describe("EventQueue — shutdown releases the process", () => {
  /** Resources currently keeping the event loop alive; `unref`'d ones do not appear. */
  const liveTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

  const hookCounts = () => ({
    beforeExit: process.listenerCount("beforeExit"),
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGHUP: process.listenerCount("SIGHUP"),
  });

  it("leaves no timer holding the event loop open", async () => {
    // Relative to the ambient baseline, since the test runner has timers of its own.
    //
    // This is the branch where the LOOP finishes first, and it is the only one a test
    // can catch: when the timeout wins instead, its timer has by definition already
    // fired, so the old code left nothing behind there either. The timeout's timer is
    // `unref`'d as well, but that belt is not observable as a regression and is not
    // pinned here rather than pinned by a case that would pass either way.
    const before = liveTimers();
    const q = new EventQueue(async () => {}, 1000, 100);
    await q.shutdown(1000);
    expect(liveTimers()).toBe(before);
  });

  it("removes its process listeners", async () => {
    const before = hookCounts();
    const q = new EventQueue(async () => {}, 1000, 100);
    const during = hookCounts();
    // Registered on construction — each one is a route that would otherwise lose
    // buffered events.
    expect(during.beforeExit).toBe(before.beforeExit + 1);
    expect(during.SIGINT).toBe(before.SIGINT + 1);
    expect(during.SIGTERM).toBe(before.SIGTERM + 1);
    // SIGHUP is what a closing terminal and a detaching container send. Measured
    // before it was added: every buffered event lost on that route.
    expect(during.SIGHUP).toBe(before.SIGHUP + 1);

    await q.shutdown(1000);
    expect(hookCounts()).toEqual(before);
  });

  it("does not leak a listener set per queue", async () => {
    // The shape a per-request SDK produces. Each surviving listener also keeps its
    // queue — and its whole buffer — reachable for the life of the process, and lets
    // `beforeExit` re-drain a queue that was already shut down.
    const before = hookCounts();
    const queues = Array.from({ length: 12 }, () => new EventQueue(async () => {}, 1000, 100));
    expect(hookCounts().SIGTERM).toBe(before.SIGTERM + 12);
    await Promise.all(queues.map((q) => q.shutdown(500)));
    expect(hookCounts()).toEqual(before);
  });

  it("stays idempotent across a second shutdown", async () => {
    const before = hookCounts();
    const q = new EventQueue(async () => {}, 1000, 100);
    await q.shutdown(500);
    await q.shutdown(500);
    expect(hookCounts()).toEqual(before);
  });
});
