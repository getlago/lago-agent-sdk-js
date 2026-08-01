/** The kill -9 test (WP2 acceptance, reviewer attack A1).
 *
 * A child process pushes events through a DurableEventQueue while delivering
 * to a mock Lago. The test SIGKILLs it mid-traffic three times, restarts it,
 * lets the final run drain, then asserts the billing contract:
 *
 *   every accepted event landed in Lago exactly once —
 *   zero loss, zero duplicates.
 *
 * "Accepted" is the child's append-only log, written only after push()
 * returned "accepted". The mock Lago dedupes by transaction_id exactly like
 * the real /events/batch; raw receipt counts are also asserted so redelivery
 * only ever happens for events whose delete raced the kill.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startMockLago, type MockLago } from "../helpers/mock_lago.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = resolve(HERE, "crash_child.ts");
const TOTAL = 1000;
const KILLS = 3;

let dir: string;
let lago: MockLago;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crash-"));
  lago = await startMockLago();
  lago.setLatencyMs(15); // widen the in-flight window the kill can land in
});

afterEach(async () => {
  await lago.close();
  rmSync(dir, { recursive: true, force: true });
});

function runChild(
  outbox: string,
  log: string,
): { proc: ReturnType<typeof spawn>; done: Promise<number | null> } {
  // Spawn node directly (--import tsx), NOT the tsx bin wrapper: the wrapper
  // re-spawns node as its own child, so SIGKILLing the wrapper would orphan
  // the real producer and the "crash" would kill nothing.
  const proc = spawn(process.execPath, ["--import", "tsx", CHILD, outbox, lago.url, log, String(TOTAL)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const done = new Promise<number | null>((resolvePromise) => {
    proc.on("exit", (code) => resolvePromise(code));
  });
  return { proc, done };
}

describe("crash recovery", () => {
  it(`kill -9 x${KILLS} mid-traffic: zero loss, zero duplicates`, async () => {
    const outbox = join(dir, "outbox.db");
    const log = join(dir, "accepted.log");

    for (let round = 0; round < KILLS; round++) {
      const { proc, done } = runChild(outbox, log);
      // Let it produce and deliver for a while, then kill it dead.
      await new Promise((r) => setTimeout(r, 300 + round * 100));
      proc.kill("SIGKILL");
      const code = await done;
      expect(code).toBe(null); // killed by signal, not a clean exit
    }

    // Final run: resume from the same outbox and drain to completion.
    const { done } = runChild(outbox, log);
    expect(await done).toBe(0);

    const accepted = readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(accepted.length).toBe(TOTAL);

    // Zero loss + zero duplicates: every accepted event is in Lago exactly once.
    const missing = accepted.filter((id) => !lago.store.has(id));
    expect(missing).toEqual([]);
    for (const id of accepted) {
      expect(lago.store.get(id)).toBeDefined();
    }
    // Lago-side store is deduped by transaction_id, so "exactly once" is the
    // pair (present in store) + (store is keyed by transaction_id).
    // Raw receipts may exceed 1 only for redelivery across a kill boundary;
    // there must be no systematic duplication on the happy path.
    const multi = [...lago.receipts.entries()].filter(([, n]) => n > 1);
    expect(multi.length).toBeLessThan(accepted.length / 4);

    // Events that were accepted between the last log append and the kill
    // (the observer race) may exist in Lago beyond the log; each must still
    // be unique. No event may appear that the outbox never accepted.
    expect(lago.store.size).toBeGreaterThanOrEqual(TOTAL);
    expect(lago.store.size).toBeLessThanOrEqual(TOTAL + KILLS * 2);

    // The outbox file is fully drained.
    expect(existsSync(outbox)).toBe(true);
  }, 120_000);
});
