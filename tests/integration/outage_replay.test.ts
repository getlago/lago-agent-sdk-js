/** Outage replay — Lago fails for N seconds; events buffer and arrive in order on recovery. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { LagoSDK, makeCanonicalUsage } from "../../src/index.js";

interface ToggleableLago {
  url: string;
  received: { code: string; properties: Record<string, unknown> }[];
  setFailing: (b: boolean) => void;
  close: () => Promise<void>;
}

async function spawn(): Promise<ToggleableLago> {
  let failing = false;
  const received: { code: string; properties: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (failing) {
      res.writeHead(503);
      res.end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    for (const e of body.events ?? []) received.push(e);
    res.writeHead(200);
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    setFailing: (b) => {
      failing = b;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("Outage replay", () => {
  it("preserves order and count after a recovery", async () => {
    const lago = await spawn();
    try {
      const sdk = new LagoSDK({
        apiKey: "x",
        apiUrl: lago.url,
        defaultSubscriptionId: "sub_test",
        config: { maxRetryMs: 1000 },
      });

      // 1. Lago down — push 200 events
      lago.setFailing(true);
      for (let i = 0; i < 200; i++) {
        sdk.emit(
          makeCanonicalUsage({
            input: 1,
            model: `m${String(i).padStart(3, "0")}`,
            provider: "p",
            api: "bedrock_invoke",
          }),
        );
      }
      // Let the queue accumulate / fail a few times
      await new Promise((r) => setTimeout(r, 2000));

      // 2. Lago recovers
      lago.setFailing(false);
      expect(await sdk.flush(15000)).toBe(true);
      await sdk.shutdown(2000);

      expect(lago.received).toHaveLength(200);
      const models = lago.received.map((e) => e.properties.model as string);
      expect(models).toEqual(Array.from({ length: 200 }, (_, i) => `m${String(i).padStart(3, "0")}`));
    } finally {
      await lago.close();
    }
  }, 30_000);

  it("long outage at buffer cap drops oldest, then drains", async () => {
    const lago = await spawn();
    try {
      const sdk = new LagoSDK({
        apiKey: "x",
        apiUrl: lago.url,
        defaultSubscriptionId: "sub_test",
        config: { maxRetryMs: 500, maxBufferSize: 30 },
      });

      lago.setFailing(true);
      for (let i = 0; i < 50; i++) {
        sdk.emit(
          makeCanonicalUsage({
            input: 1,
            model: `m${String(i).padStart(2, "0")}`,
            provider: "p",
            api: "bedrock_invoke",
          }),
        );
      }
      await new Promise((r) => setTimeout(r, 500));

      lago.setFailing(false);
      expect(await sdk.flush(15000)).toBe(true);
      await sdk.shutdown(2000);

      expect(lago.received).toHaveLength(30);
      const models = new Set(lago.received.map((e) => e.properties.model as string));
      // Most recent 30 should remain — m20..m49
      const expected = new Set(Array.from({ length: 30 }, (_, i) => `m${String(20 + i).padStart(2, "0")}`));
      expect(models).toEqual(expected);
    } finally {
      await lago.close();
    }
  }, 30_000);
});
