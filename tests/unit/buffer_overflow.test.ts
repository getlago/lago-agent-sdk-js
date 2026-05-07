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
    const q = new EventQueue(
      async () => {
        await blocked;
      },
      10_000, // never timer-flush
      10_000, // batch == cap so worker takes the lot once unpaused
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
