/** In-process mock of Lago's /events/batch, faithful to the property that
 * matters for delivery semantics: idempotency on `transaction_id`.
 *
 * Records every raw receipt (for duplicate accounting) and a deduped store
 * (what "landed in Lago"). Failure modes are switchable per test.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockLago {
  url: string;
  /** transaction_id -> event, deduped like the real API. */
  store: Map<string, unknown>;
  /** transaction_id -> number of raw receipts (>= 1 means delivered). */
  receipts: Map<string, number>;
  /** while > 0, respond 503 to that many batch calls. */
  failNext: (n: number) => void;
  /** hang requests without responding (backpressure tests). */
  setHanging: (hanging: boolean) => void;
  /** artificial per-request latency in ms. */
  setLatencyMs: (ms: number) => void;
  /** current-usage spend served to budget checks, in cents per customer. */
  setSpendCents: (customerId: string, cents: number) => void;
  /** number of current_usage GETs received (TTL-cache assertions). */
  usageCalls: () => number;
  close: () => Promise<void>;
}

export async function startMockLago(): Promise<MockLago> {
  const store = new Map<string, unknown>();
  const receipts = new Map<string, number>();
  const spendCents = new Map<string, number>();
  let usageCallCount = 0;
  let failRemaining = 0;
  let hanging = false;
  let latencyMs = 0;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (hanging) return; // never respond
      const usageMatch = req.url?.match(/\/customers\/([^/]+)\/current_usage/);
      if (req.method === "GET" && usageMatch) {
        usageCallCount++;
        const customerId = decodeURIComponent(usageMatch[1]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ customer_usage: { total_amount_cents: spendCents.get(customerId) ?? 0 } }));
        return;
      }
      if (!req.url?.endsWith("/events/batch")) {
        res.writeHead(404).end();
        return;
      }
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      if (failRemaining > 0) {
        failRemaining--;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "induced failure" }));
        return;
      }
      const { events } = JSON.parse(body) as { events: Array<{ transaction_id: string }> };
      for (const ev of events) {
        receipts.set(ev.transaction_id, (receipts.get(ev.transaction_id) ?? 0) + 1);
        if (!store.has(ev.transaction_id)) store.set(ev.transaction_id, ev);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: [] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    store,
    receipts,
    failNext: (n) => (failRemaining = n),
    setHanging: (h) => (hanging = h),
    setLatencyMs: (ms) => (latencyMs = ms),
    setSpendCents: (customerId, cents) => void spendCents.set(customerId, cents),
    usageCalls: () => usageCallCount,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
