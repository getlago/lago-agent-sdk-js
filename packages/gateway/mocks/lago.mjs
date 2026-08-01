#!/usr/bin/env node
/** Mock Lago for the integration harness and demo.
 *
 * Faithful where it matters for delivery semantics:
 *   POST /api/v1/events/batch                        idempotent on transaction_id
 *   GET  /api/v1/customers/:id/current_usage         budget checks
 *
 * Test-only control surface (never part of the real API):
 *   GET    /_test/events        every stored event (deduped) + raw receipt counts
 *   PUT    /_test/spend         {customer_id, cents} sets current usage
 *   DELETE /_test/events        reset the store
 */
import http from "node:http";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;

const store = new Map(); // transaction_id -> event
const receipts = new Map(); // transaction_id -> count
const spendCents = new Map(); // customer_id -> cents

const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    const url = req.url ?? "/";

    if (req.method === "POST" && url.endsWith("/events/batch")) {
      const { events } = JSON.parse(text);
      for (const ev of events) {
        receipts.set(ev.transaction_id, (receipts.get(ev.transaction_id) ?? 0) + 1);
        if (!store.has(ev.transaction_id)) store.set(ev.transaction_id, ev);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ events: [] }));
      return;
    }

    const usageMatch = url.match(/\/customers\/([^/]+)\/current_usage/);
    if (req.method === "GET" && usageMatch) {
      const customerId = decodeURIComponent(usageMatch[1]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ customer_usage: { total_amount_cents: spendCents.get(customerId) ?? 0 } }));
      return;
    }

    if (req.method === "GET" && url === "/_test/events") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          events: [...store.values()],
          receipts: Object.fromEntries(receipts),
        }),
      );
      return;
    }
    if (req.method === "PUT" && url === "/_test/spend") {
      const { customer_id, cents } = JSON.parse(text);
      spendCents.set(customer_id, cents);
      res.writeHead(200).end();
      return;
    }
    if (req.method === "DELETE" && url === "/_test/events") {
      store.clear();
      receipts.clear();
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end();
  });
});

server.listen(PORT, () => console.log(`mock-lago listening on :${PORT}`));
