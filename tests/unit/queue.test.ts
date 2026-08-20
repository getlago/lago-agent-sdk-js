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
describe("EventQueue — throttling 4xx is transient", () => {
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

  it.each([401, 403])("holds rather than drops a %i — credentials are not the batch", async (status) => {
    // A rotated or revoked key is fixed out-of-band, so the events are still billable.
    // Dropping them one-by-one discarded every event for the whole outage.
    let attempts = 0;
    const delivered: string[] = [];
    const sender = async (batch: LagoEvent[]) => {
      attempts++;
      if (attempts === 1) throw new LagoApiError(status, '{"error":"unauthorized"}');
      for (const e of batch) delivered.push(e.transaction_id);
    };

    const q = new EventQueue(sender, 50, 10, 10_000, 500);
    try {
      q.push(evId("a"));
      q.push(evId("b"));
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && delivered.length === 0) await sleep(50);
      expect(delivered).toEqual(["a", "b"]);
      // Retried as one batch — never fanned out into per-event requests.
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

  it.each([400, 404, 409, 422])("still isolates and drops on a %i", async (status) => {
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
