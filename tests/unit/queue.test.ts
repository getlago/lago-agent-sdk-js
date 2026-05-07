/** Event queue — batching, retry, backoff, flush, overflow. */
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
