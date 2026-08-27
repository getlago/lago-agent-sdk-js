/** Buffer-overflow boundary — exactly at the cap, the OLDEST is dropped. */
import { describe, expect, it } from "vitest";

import { EventQueue } from "../../src/queue.js";
import type { LagoEvent } from "../../src/lago_client.js";

function ev(i: number): LagoEvent {
  return {
    transaction_id: `t${i}`,
    external_subscription_id: "sub",
    code: "llm_input_tokens",
    timestamp: 0,
    properties: { i },
  };
}

describe("EventQueue — buffer overflow", () => {
  it("at the exact boundary, oldest is dropped, newest kept", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    // maxBatchSize must stay ABOVE maxBufferSize. `push` sets the wake signal whenever
    // `buffer.length >= maxBatchSize`, so with the two equal the overflowing push below
    // both drops i=0 AND wakes the worker, which then drains all 10,000. This repo gets
    // away with it only because the buffer read below is synchronous — there is no await
    // in that window for the worker to interleave at. The Python twin, with a real
    // background thread, failed in CI on exactly this (`assert 0 == 10000`). Kept in step
    // so the two files stay mirrored and so inserting an await here cannot resurrect it.
    //
    // Nothing here depends on batch size — every assertion is about buffer CONTENTS.
    const q = new EventQueue(
      async () => {
        await blocked;
      },
      10_000, // never timer-flush
      20_000, // batch above the cap, so push never wakes the worker
      10_000, // buffer cap
    );
    try {
      // Fill to capacity
      for (let i = 0; i < 10_000; i++) q.push(ev(i));
      // @ts-expect-error — accessing private buffer for test
      expect(q.buffer.length).toBe(10_000);

      // One more — should drop event 0, keep 1..10_000
      q.push(ev(10_000));
      // @ts-expect-error — accessing private buffer for test
      const buf = (q.buffer as LagoEvent[]).slice();
      expect(buf.length).toBe(10_000);
      expect((buf[0].properties as any).i).toBe(1);
      expect((buf[buf.length - 1].properties as any).i).toBe(10_000);
    } finally {
      release();
      await q.shutdown(2000);
    }
  });

  it("repeated overflow keeps the window sliding to the most recent N", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const q = new EventQueue(
      async () => {
        await blocked;
      },
      10_000,
      100,
      100,
    );
    try {
      for (let i = 0; i < 250; i++) q.push(ev(i));
      // @ts-expect-error — accessing private buffer for test
      const buf = (q.buffer as LagoEvent[]).slice();
      expect(buf.map((e) => (e.properties as any).i)).toEqual(Array.from({ length: 100 }, (_, k) => 150 + k));
    } finally {
      release();
      await q.shutdown(2000);
    }
  });
});

// ----------------------------------------------------------------------
// One root cause must not become N callbacks.
//
// `push()` reported through `onError` once per DROPPED EVENT. Measured on the shape that
// produces it — `backfillDatabricks` loops `emit()` over a window with no pacing — a
// 50,000-event burst against the default 10,000 buffer delivered 10,000, dropped 40,000,
// and fired **40,000 separate `onError` calls**. Whatever the customer wired that hook to
// is usually an error tracker. The queue already refuses to do this for a failed batch,
// for the same stated reason; see `sendIndividually`.
//
// The count still has to be exact — it is how much revenue went unbilled — so the tests
// below pin both halves: few reports, and the right total inside them.
// ----------------------------------------------------------------------
describe("EventQueue — overflow reports are coalesced", () => {
  /** `maxBatchSize` above the cap, so `push` never wakes the worker and the whole burst
   * lands synchronously — the same reason the boundary test above does it. */
  function overflowing(onError: (err: unknown, where: string) => void) {
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const q = new EventQueue(
      async () => {
        await blocked;
      },
      10_000, // never timer-flush
      5_000, // batch above the cap
      100, // buffer cap
      60_000,
      onError,
    );
    return { q, release: () => release() };
  }

  /** The dropped count each report names. */
  function reportedCounts(errors: unknown[]): number[] {
    return errors.map((e) => {
      const m = /dropped (\d+) oldest/.exec((e as Error).message);
      expect(m).not.toBeNull();
      return Number(m![1]);
    });
  }

  it("a 5,000-event burst produces a handful of reports, not 4,900", async () => {
    const errors: unknown[] = [];
    const { q, release } = overflowing((err, where) => {
      if (where === "overflow") errors.push(err);
    });
    try {
      for (let i = 0; i < 5_000; i++) q.push(ev(i));
      // Asserted FIRST, and deliberately: this is the behaviour under test, so it is the
      // assertion that has to fail on the old code. On `main` this reads 4,900 — one
      // callback per dropped event. The burst is synchronous, so it is a single episode:
      // the first drop reports and the per-second interval cannot elapse inside it.
      expect(errors.length).toBe(1);
      // 5,000 pushed into a 100-slot buffer: 4,900 dropped.
      expect(q.droppedEvents).toBe(4_900);
      // `flush()` names the tail — a caller that flushes is asking what happened.
      await q.flush(50);
      expect(errors.length).toBe(2);
      // Between them they account for every dropped event, exactly once.
      expect(reportedCounts(errors).reduce((a, b) => a + b, 0)).toBe(4_900);
    } finally {
      release();
      await q.shutdown(500);
    }
  });

  it("still reports the very first drop immediately", async () => {
    // Coalescing must not delay the signal. An operator needs to know the buffer is
    // full while it still is, not after the episode closes.
    const errors: unknown[] = [];
    const { q, release } = overflowing((err, where) => {
      if (where === "overflow") errors.push(err);
    });
    try {
      for (let i = 0; i < 100; i++) q.push(ev(i)); // exactly full, nothing dropped
      expect(errors.length).toBe(0);
      q.push(ev(100)); // the first drop
      expect(errors.length).toBe(1);
      // The message has to carry the count, or coalescing loses the number that says how
      // much revenue went unbilled. On `main` there is no count in it at all.
      expect(reportedCounts(errors)).toEqual([1]);
      expect(q.droppedEvents).toBe(1);
    } finally {
      release();
      await q.shutdown(500);
    }
  });

  it("a later burst reports again rather than staying quiet after the first episode", async () => {
    // The episode has to actually close, or a queue that overflowed once would never
    // report a second, unrelated overload.
    const errors: unknown[] = [];
    let blocked = true;
    let delivered = 0;
    const q = new EventQueue(
      async (b) => {
        while (blocked) await new Promise((r) => setTimeout(r, 5));
        delivered += b.length;
      },
      20,
      5_000,
      100,
      60_000,
      (err, where) => {
        if (where === "overflow") errors.push(err);
      },
    );
    try {
      for (let i = 0; i < 300; i++) q.push(ev(i));
      // 300 into a 100-slot buffer drops 200, so `main` reports 200 times here.
      expect(errors.length).toBeLessThanOrEqual(2);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(q.droppedEvents).toBe(200);

      // Let it catch up: the drain empties the buffer and closes the episode.
      blocked = false;
      expect(await q.flush(4000)).toBe(true);
      expect(delivered).toBeGreaterThan(0);
      const afterDrain = errors.length;

      // A fresh overload must speak up straight away, not wait out an interval.
      blocked = true;
      for (let i = 0; i < 300; i++) q.push(ev(1000 + i));
      expect(errors.length).toBeGreaterThan(afterDrain);
      expect(errors.length).toBeLessThanOrEqual(afterDrain + 2);
      expect(q.droppedEvents).toBeGreaterThan(200);
    } finally {
      blocked = false;
      await q.shutdown(1000);
    }
  });
});
