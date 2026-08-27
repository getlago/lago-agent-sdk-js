/**
 * `sendBatch` must not pay a fresh TCP handshake per batch.
 *
 * The Python sibling did: it called a module-level helper that built and closed a
 * session per call, so every batch cost a new connection (and, over TLS, a new
 * handshake). Node does not inherit that — global `fetch` dispatches through undici,
 * which pools per origin — but "the runtime probably handles it" is not something a
 * billing client should rest on unpinned. Two things could take it away without any
 * test noticing: a per-request `dispatcher` on the default path, or a `Connection:
 * close` header.
 *
 * These assert CONNECTION COUNTS, never latency. A socket count is a property of the
 * code; a latency ratio is a property of whatever else the machine was doing. The
 * numbers below hold identically on a loaded laptop and an idle CI box.
 *
 * Measured shape of the pool, stable across runs and across N = 1, 2, 5, 20, 50: the
 * first send opens one socket, the second opens a second, and every send after that
 * reuses it — so the cost is **2 sockets, whatever N is**. The assertions are written
 * against that ceiling rather than against "exactly 1", because the second socket is
 * undici's own pool warming and not something this client controls. What matters, and
 * what these tests pin, is that the count does not scale with the number of batches.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { LagoClient, type LagoEvent } from "../../src/lago_client.js";

/** The production batch shape: `maxBatchSize` defaults to 100. */
function batch(size = 100): LagoEvent[] {
  return Array.from({ length: size }, (_, i) => ({
    transaction_id: `t${i}`,
    external_subscription_id: "sub",
    code: "llm_input_tokens",
    timestamp: 0,
    properties: { value: 1, model: "gpt-4o" },
  }));
}

interface Counting {
  server: Server;
  port: number;
  /** Distinct TCP connections the server accepted. */
  connections: number;
  /** Requests it answered — proves the sends really happened. */
  requests: number;
  /** Events it actually received, summed over every request. */
  events: number;
}

async function countingServer(): Promise<Counting> {
  const state = { connections: 0, requests: 0, events: 0 } as Counting;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.requests++;
      try {
        state.events += (JSON.parse(body) as { events: unknown[] }).events.length;
      } catch {
        /* a malformed body is a test bug; the count below will show it */
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  server.on("connection", () => state.connections++);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.server = server;
  state.port = (server.address() as AddressInfo).port;
  return state;
}

let open: Counting | null = null;
afterEach(() => {
  open?.server.close();
  open = null;
});

describe("LagoClient reuses one pooled connection across batches", () => {
  it("25 sequential batches of 100 events cost at most 2 connections", async () => {
    open = await countingServer();
    const client = new LagoClient("k", `http://127.0.0.1:${open.port}/api/v1`);
    const events = batch();
    for (let i = 0; i < 25; i++) await client.sendBatch(events);

    // The sends really happened, at production shape.
    expect(open.requests).toBe(25);
    expect(open.events).toBe(2500);
    // The point: 25 batches, not 25 connections.
    expect(open.connections).toBeLessThanOrEqual(2);
  });

  it("connection count does not grow with the number of batches", async () => {
    // The invariant a per-request dispatcher or a `Connection: close` header breaks.
    // Comparing two Ns catches it even if the pool's warm-up ever costs a socket or
    // two more than it does today, which a bare `<= 2` would not.
    const measure = async (batches: number) => {
      open?.server.close();
      open = await countingServer();
      const client = new LagoClient("k", `http://127.0.0.1:${open.port}/api/v1`);
      const events = batch();
      for (let i = 0; i < batches; i++) await client.sendBatch(events);
      expect(open.requests).toBe(batches);
      return open.connections;
    };

    const few = await measure(3);
    const many = await measure(30);
    // 10x the batches must not mean more connections at all.
    expect(many).toBeLessThanOrEqual(few);
  });

  it("two clients against the same origin share the pool", async () => {
    // Why this is worth a test rather than a comment: it is the reason nothing here
    // needs to own or cache a dispatcher. Pooling is per ORIGIN in the global
    // dispatcher, not per client object, so two SDKs pointed at one Lago — a
    // multi-tenant host, or a test that builds several — do not multiply sockets.
    open = await countingServer();
    const url = `http://127.0.0.1:${open.port}/api/v1`;
    const a = new LagoClient("key-a", url);
    const b = new LagoClient("key-b", url);
    const events = batch();
    for (let i = 0; i < 10; i++) {
      await a.sendBatch(events);
      await b.sendBatch(events);
    }

    expect(open.requests).toBe(20);
    expect(open.connections).toBeLessThanOrEqual(2);
  });

  it("installs no per-request dispatcher when verifySsl is on", async () => {
    // The structural half of the same guarantee, and the one that fails FIRST if
    // someone reaches for a dispatcher to set a timeout or a proxy: a fresh `Agent`
    // per send is its own pool of one, so the counts above would go to N without any
    // other symptom. `verifySsl: false` is the single intended exception and has its
    // own coverage in `lago_client.test.ts`.
    open = await countingServer();
    const client = new LagoClient("k", `http://127.0.0.1:${open.port}/api/v1`);
    const seen: Array<RequestInit & { dispatcher?: unknown }> = [];
    const real = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push((init ?? {}) as RequestInit & { dispatcher?: unknown });
      return real(input, init);
    }) as typeof fetch;
    try {
      await client.sendBatch(batch(1));
    } finally {
      globalThis.fetch = real;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].dispatcher).toBeUndefined();
  });
});
