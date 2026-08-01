import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LagoEvent } from "@getlago/agent-sdk/core";
import { LagoClient } from "@getlago/agent-sdk/core";
import { DurableEventQueue } from "../../src/outbox.js";
import { startMockLago, type MockLago } from "../helpers/mock_lago.js";

let dir: string;
let lago: MockLago;
let queue: DurableEventQueue | null;

function ev(id: string): LagoEvent {
  return {
    transaction_id: id,
    external_subscription_id: "sub_1",
    code: "llm_cost",
    timestamp: Math.floor(Date.now() / 1000),
    properties: { value: "1" },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "outbox-"));
  lago = await startMockLago();
  queue = null;
});

afterEach(async () => {
  await queue?.shutdown(2000);
  await lago.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("DurableEventQueue", () => {
  it("delivers accepted events to /events/batch", async () => {
    const client = new LagoClient("key", lago.url);
    queue = new DurableEventQueue({
      path: join(dir, "outbox.db"),
      sender: (b) => client.sendBatch(b),
      flushIntervalMs: 20,
    });
    for (let i = 0; i < 25; i++) expect(queue.push(ev(`tx-${i}`))).toBe("accepted");
    expect(await queue.flush(5000)).toBe(true);
    expect(lago.store.size).toBe(25);
    expect(queue.counters.dropped).toBe(0);
  });

  it("survives close + reopen without losing undelivered events (crash-safe resume)", async () => {
    const path = join(dir, "outbox.db");
    lago.setHanging(true);
    queue = new DurableEventQueue({ path, sender: senderTo(lago), flushIntervalMs: 20 });
    for (let i = 0; i < 10; i++) queue.push(ev(`tx-${i}`));
    expect(queue.depth()).toBe(10);
    // Simulate a dead process: no flush, no graceful shutdown.
    queue._hardClose();
    queue = null;

    lago.setHanging(false);
    queue = new DurableEventQueue({ path, sender: senderTo(lago), flushIntervalMs: 20 });
    expect(queue.depth()).toBe(10);
    expect(await queue.flush(5000)).toBe(true);
    expect(lago.store.size).toBe(10);
  });

  it("re-sends the same transaction_id after a 503 (at-least-once, Lago dedupes)", async () => {
    lago.failNext(1);
    queue = new DurableEventQueue({
      path: join(dir, "outbox.db"),
      sender: senderTo(lago),
      flushIntervalMs: 20,
      maxRetryMs: 50,
    });
    queue.push(ev("tx-retry"));
    expect(await queue.flush(10_000)).toBe(true);
    expect(lago.store.size).toBe(1);
    expect(lago.receipts.get("tx-retry")).toBeGreaterThanOrEqual(1);
  });

  it("deduplicates a replayed transaction_id at the outbox (INSERT OR IGNORE)", async () => {
    lago.setLatencyMs(30);
    queue = new DurableEventQueue({
      path: join(dir, "outbox.db"),
      sender: senderTo(lago),
      flushIntervalMs: 20,
    });
    const e = ev("tx-same");
    expect(queue.push(e)).toBe("accepted");
    expect(queue.push(e)).toBe("accepted");
    expect(queue.depth()).toBe(1);
    await queue.flush(5000);
    expect(lago.store.size).toBe(1);
    expect(lago.receipts.get("tx-same")).toBe(1);
  });

  it("fail-closed backpressure: rejects pushes at maxDepth, drops nothing", async () => {
    lago.setHanging(true);
    queue = new DurableEventQueue({
      path: join(dir, "outbox.db"),
      sender: senderTo(lago),
      maxDepth: 5,
      flushIntervalMs: 20,
    });
    for (let i = 0; i < 5; i++) expect(queue.push(ev(`tx-${i}`))).toBe("accepted");
    expect(queue.push(ev("tx-overflow"))).toBe("rejected");
    expect(queue.depth()).toBe(5);
    expect(queue.counters.rejected).toBe(1);
    expect(queue.counters.dropped).toBe(0);
    // Every accepted event is still there; nothing was evicted to make room.
    lago.setHanging(false);
    // The hung request holds the first batch in flight; wait out its timeout.
    expect(await queue.flush(15_000)).toBe(true);
    expect(lago.store.size).toBe(5);
    expect(lago.store.has("tx-overflow")).toBe(false);
  }, 30_000);

  it("reports depth and lag", async () => {
    lago.setHanging(true);
    queue = new DurableEventQueue({
      path: join(dir, "outbox.db"),
      sender: senderTo(lago),
      flushIntervalMs: 20,
    });
    expect(queue.depth()).toBe(0);
    expect(queue.lagMs()).toBe(0);
    queue.push(ev("tx-lag"));
    await new Promise((r) => setTimeout(r, 50));
    expect(queue.depth()).toBe(1);
    expect(queue.lagMs()).toBeGreaterThanOrEqual(40);
  });
});

function senderTo(l: MockLago) {
  const client = new LagoClient("key", l.url, 2000);
  return (b: LagoEvent[]) => client.sendBatch(b);
}
