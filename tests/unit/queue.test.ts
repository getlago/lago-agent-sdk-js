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
