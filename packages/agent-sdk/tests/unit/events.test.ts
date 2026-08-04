import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import { buildTokenEvents } from "../../src/events.js";
import { makeCanonicalUsage } from "../../src/canonical.js";
import { DEFAULT_METRIC_CODES } from "../../src/config.js";
import type { LagoEvent } from "../../src/lago_client.js";

const usage = makeCanonicalUsage({
  input: 100,
  output: 50,
  model: "test-model",
  provider: "openai",
  api: "chat",
});

describe("event building", () => {
  it("assigns transaction_id at build time, one per event", () => {
    const events = buildTokenEvents(usage, "sub_1", DEFAULT_METRIC_CODES);
    expect(events.length).toBe(2);
    const ids = new Set(events.map((e) => e.transaction_id));
    expect(ids.size).toBe(events.length);
    for (const e of events) {
      expect(e.transaction_id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("re-sends the SAME transaction_id when delivery is retried", async () => {
    // Idempotency contract: the id is assigned when the event is built, so a
    // failed batch that is replayed carries identical transaction_ids. Lago's
    // /events/batch dedupes on them.
    const sdk = new LagoSDK({
      apiKey: "test",
      defaultSubscriptionId: "sub_1",
      config: { flushIntervalMs: 10 },
    });
    const attempts: string[][] = [];
    let failFirst = true;
    sdk._setSender(async (batch: LagoEvent[]) => {
      attempts.push(batch.map((e) => e.transaction_id));
      if (failFirst) {
        failFirst = false;
        throw new Error("simulated 503");
      }
    });
    sdk.emit(usage);
    const deadline = Date.now() + 5000;
    while (attempts.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await sdk.shutdown(1000);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });
});
