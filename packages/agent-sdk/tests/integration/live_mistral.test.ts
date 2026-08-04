/** Live Mistral end-to-end + mock Lago. Skipped unless MISTRAL_API_KEY is set. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";

const SKIP = !process.env.MISTRAL_API_KEY;

interface MockLago {
  url: string;
  received: { code: string; properties: Record<string, unknown> }[];
  close: () => Promise<void>;
}

async function spawnMockLago(): Promise<MockLago> {
  const received: { code: string; properties: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
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
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe.skipIf(SKIP)("Live Mistral", () => {
  it("chat.complete emits llm_input_tokens + llm_output_tokens", async () => {
    const lago = await spawnMockLago();
    try {
      const { Mistral } = await import("@mistralai/mistralai");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new Mistral({ apiKey: process.env.MISTRAL_API_KEY! }));
      await client.chat.complete({
        model: "mistral-small-latest",
        messages: [{ role: "user", content: "Say hi" }],
        maxTokens: 20,
      });
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      for (const e of lago.received) {
        expect(e.properties.api).toBe("native");
        expect(e.properties.provider).toBe("mistral");
      }
    } finally {
      await lago.close();
    }
  });

  it("chat.stream emits events from final chunk", async () => {
    const lago = await spawnMockLago();
    try {
      const { Mistral } = await import("@mistralai/mistralai");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new Mistral({ apiKey: process.env.MISTRAL_API_KEY! }));
      const stream = await client.chat.stream({
        model: "mistral-small-latest",
        messages: [{ role: "user", content: "Say hi" }],
        maxTokens: 20,
      });
      for await (const _ of stream as AsyncIterable<unknown>) {
        // drain
      }
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
    } finally {
      await lago.close();
    }
  });
});
