/** DurableEventQueue — the gateway-mode EventTransport (ADR-003).
 *
 * SQLite in WAL mode as a write-ahead outbox. `push` commits the event to
 * disk synchronously before returning: once a caller sees "accepted", the
 * event survives kill -9 and is replayed on restart with the same
 * `transaction_id` (assigned at build time), which Lago's /events/batch
 * dedupes. Delivery is at-least-once with the SDK's backoff discipline
 * (1s doubling to a 60s cap).
 *
 * Overflow is fail-closed: at `maxDepth` the push is REJECTED and the caller
 * must refuse the LLM request. Nothing accepted is ever evicted; the dropped
 * counter exists to prove it stays 0.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EventTransport, LagoEvent, PushResult } from "@getlago/agent-sdk/core";

type Sender = (batch: LagoEvent[]) => Promise<void>;

export interface DurableEventQueueOptions {
  /** Path to the SQLite outbox file. Parent directory is created. */
  path: string;
  sender: Sender;
  /** Fail-closed bound: pushes beyond this depth are rejected. */
  maxDepth?: number;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  maxRetryMs?: number;
  onError?: (err: unknown, where: string) => void;
}

export interface OutboxCounters {
  accepted: number;
  rejected: number;
  delivered: number;
  /** Accepted-then-lost events. Must be 0, always. */
  dropped: number;
}

export class DurableEventQueue implements EventTransport {
  private db: DatabaseSync;
  private stopping = false;
  private backoffMs = 0;
  private wakeResolvers: Array<() => void> = [];
  private loopPromise: Promise<void>;
  private readonly maxDepth: number;
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetryMs: number;
  private readonly sender: Sender;
  private readonly onError?: (err: unknown, where: string) => void;
  readonly counters: OutboxCounters = { accepted: 0, rejected: 0, delivered: 0, dropped: 0 };

  constructor(opts: DurableEventQueueOptions) {
    this.sender = opts.sender;
    this.maxDepth = opts.maxDepth ?? 100_000;
    this.maxBatchSize = opts.maxBatchSize ?? 100;
    this.flushIntervalMs = opts.flushIntervalMs ?? 1000;
    this.maxRetryMs = opts.maxRetryMs ?? 60_000;
    this.onError = opts.onError;
    mkdirSync(dirname(opts.path), { recursive: true });
    this.db = new DatabaseSync(opts.path);
    // WAL survives process death at any instant; NORMAL syncs the WAL enough
    // for power-loss-safe checkpoints without a full fsync per commit.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.loopPromise = this.run();
  }

  push(event: LagoEvent): PushResult {
    try {
      if (this.depth() >= this.maxDepth) {
        this.counters.rejected++;
        this.report(new Error(`outbox full at ${this.maxDepth}; rejecting (fail-closed)`), "backpressure");
        return "rejected";
      }
      // INSERT OR IGNORE: replaying the same transaction_id is a no-op, so an
      // idempotent retry by the caller cannot double-enqueue.
      const stmt = this.db.prepare(
        "INSERT OR IGNORE INTO outbox (transaction_id, event_json, enqueued_at) VALUES (?, ?, ?)",
      );
      stmt.run(event.transaction_id, JSON.stringify(event), Date.now());
      this.counters.accepted++;
      if (this.depth() >= this.maxBatchSize) this.wake();
      return "accepted";
    } catch (err) {
      // A failed durable write is a rejection, never a silent drop.
      this.counters.rejected++;
      this.report(err, "push");
      return "rejected";
    }
  }

  depth(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number };
    return Number(row.n);
  }

  lagMs(): number {
    const row = this.db.prepare("SELECT MIN(enqueued_at) AS oldest FROM outbox").get() as {
      oldest: number | null;
    };
    if (row.oldest == null) return 0;
    return Math.max(0, Date.now() - Number(row.oldest));
  }

  async flush(timeoutMs: number = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.depth() === 0) return true;
      this.wake();
      await sleep(10);
    }
    return false;
  }

  /** Tests-only: close the database without draining, as a dead process would. */
  _hardClose(): void {
    this.stopping = true;
    this.db.close();
  }

  async shutdown(timeoutMs: number = 5000): Promise<void> {
    await this.flush(timeoutMs);
    this.stopping = true;
    this.wake();
    await Promise.race([this.loopPromise, sleep(timeoutMs)]);
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---------- internal ----------
  private takeBatch(): Array<{ seq: number; event: LagoEvent }> {
    const rows = this.db
      .prepare("SELECT seq, event_json FROM outbox ORDER BY seq LIMIT ?")
      .all(this.maxBatchSize) as Array<{ seq: number; event_json: string }>;
    return rows.map((r) => ({ seq: Number(r.seq), event: JSON.parse(r.event_json) as LagoEvent }));
  }

  private deleteDelivered(seqs: number[]): void {
    const del = this.db.prepare("DELETE FROM outbox WHERE seq = ?");
    this.db.exec("BEGIN");
    try {
      for (const seq of seqs) del.run(seq);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      await this.waitWake(this.flushIntervalMs);
      while (!this.stopping) {
        let batch: Array<{ seq: number; event: LagoEvent }>;
        try {
          batch = this.takeBatch();
        } catch (err) {
          this.report(err, "read_batch");
          break;
        }
        if (batch.length === 0) break;
        if (this.backoffMs > 0) {
          await sleep(this.backoffMs);
          if (this.stopping) return;
        }
        try {
          await this.sender(batch.map((b) => b.event));
          // Crash window between the send above and the delete below re-sends
          // the batch on restart; Lago dedupes by transaction_id.
          this.deleteDelivered(batch.map((b) => b.seq));
          this.counters.delivered += batch.length;
          this.backoffMs = 0;
        } catch (err) {
          this.backoffMs = this.backoffMs === 0 ? 1000 : Math.min(this.backoffMs * 2, this.maxRetryMs);
          this.report(err, "send_batch");
          break;
        }
      }
    }
  }

  private wake(): void {
    const r = this.wakeResolvers.splice(0, this.wakeResolvers.length);
    for (const fn of r) fn();
  }

  private waitWake(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        this.wakeResolvers = this.wakeResolvers.filter((fn) => fn !== once);
        resolve();
      }, timeoutMs);
      const once = () => {
        clearTimeout(id);
        resolve();
      };
      this.wakeResolvers.push(once);
    });
  }

  private report(err: unknown, where: string): void {
    if (this.onError) {
      try {
        this.onError(err, where);
      } catch {
        /* ignore */
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
