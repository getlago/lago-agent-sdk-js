/** Live Anthropic end-to-end + mock Lago. Skipped unless ANTHROPIC_API_KEY is set. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";

const SKIP = !process.env.ANTHROPIC_API_KEY;

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

describe.skipIf(SKIP)("Live Anthropic", () => {
  it("messages.create — emits llm_input_tokens + llm_output_tokens", async () => {
    const lago = await spawnMockLago();
    try {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }));
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 20,
        messages: [{ role: "user", content: "Say hi" }],
      });
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      for (const e of lago.received) {
        expect(e.properties.api).toBe("native");
        expect(e.properties.provider).toBe("anthropic");
      }
    } finally {
      await lago.close();
    }
  });

  it("messages.create with stream=true — emits from final message_delta", async () => {
    const lago = await spawnMockLago();
    try {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }));
      const stream = (await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 20,
        messages: [{ role: "user", content: "Say hi" }],
        stream: true,
      } as never)) as AsyncIterable<unknown>;
      for await (const _ of stream) {
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

  it("messages.stream — emits on finalMessage()", async () => {
    const lago = await spawnMockLago();
    try {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }));
      const stream = client.messages.stream({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 20,
        messages: [{ role: "user", content: "Say hi" }],
      }) as { finalMessage: () => Promise<unknown> };
      await stream.finalMessage();
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
