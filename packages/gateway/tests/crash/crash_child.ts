/** Crash-test producer. Run under tsx as a real child process.
 *
 * Pushes events into a DurableEventQueue as fast as it can, appending each
 * accepted transaction_id to an accepted-log file AFTER push() returns
 * "accepted" (the durability point). The parent kill -9s this process at
 * arbitrary moments; on restart it resumes the same outbox and keeps going
 * until TOTAL events have been accepted, then drains and exits 0.
 *
 * argv: <outboxPath> <lagoUrl> <acceptedLog> <total>
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { LagoClient, type LagoEvent } from "@getlago/agent-sdk/core";
import { DurableEventQueue } from "../../src/outbox.js";

const [outboxPath, lagoUrl, acceptedLog, totalStr] = process.argv.slice(2);
const total = Number(totalStr);

const alreadyAccepted = existsSync(acceptedLog)
  ? readFileSync(acceptedLog, "utf8").split("\n").filter(Boolean).length
  : 0;

const client = new LagoClient("test-key", lagoUrl, 2000);
const queue = new DurableEventQueue({
  path: outboxPath,
  sender: (b: LagoEvent[]) => client.sendBatch(b),
  flushIntervalMs: 10,
  maxBatchSize: 20,
});

let accepted = alreadyAccepted;
while (accepted < total) {
  const id = randomUUID();
  const result = queue.push({
    transaction_id: id,
    external_subscription_id: "sub_crash",
    code: "llm_cost",
    timestamp: Math.floor(Date.now() / 1000),
    properties: { value: "1" },
  });
  if (result === "accepted") {
    appendFileSync(acceptedLog, id + "\n");
    accepted++;
  }
  // Yield so delivery interleaves with production and the kill lands
  // mid-traffic, not after an instant burst.
  await new Promise((r) => setTimeout(r, 2));
}

const drained = await queue.flush(30_000);
await queue.shutdown(5_000);
if (!drained) {
  console.error("child: failed to drain outbox");
  process.exit(2);
}
process.exit(0);
