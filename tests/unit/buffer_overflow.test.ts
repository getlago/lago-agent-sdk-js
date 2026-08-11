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
