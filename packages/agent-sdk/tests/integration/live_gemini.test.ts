/** Live Gemini end-to-end + mock Lago. Skipped unless GEMINI_API_KEY is set. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";

const SKIP = !process.env.GEMINI_API_KEY;

// Gemini free tier caps gemini-2.5-flash at 5 requests/min. Sleep between
// tests to stay under the limit on a fresh API key.
const RATE_LIMIT_PAUSE_MS = 13_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe.skipIf(SKIP)("Live Gemini", () => {
  afterEach(async () => {
    await sleep(RATE_LIMIT_PAUSE_MS);
  }, 20_000);

  it("models.generateContent — emits llm_input_tokens + llm_output_tokens", async () => {
    const lago = await spawnMockLago();
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }));
      await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "Say hi",
      });
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      for (const e of lago.received) {
        expect(e.properties.api).toBe("native");
        expect(e.properties.provider).toBe("gemini");
      }
    } finally {
      await lago.close();
    }
  });

  it("models.generateContentStream — captures usage from final chunk", async () => {
    const lago = await spawnMockLago();
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }));
      const stream = (await client.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: "Count from 1 to 3.",
      })) as AsyncIterable<unknown>;
      for await (const _ of stream) {
        /* drain */
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

  it("thinking mode — emits llm_reasoning_tokens", async () => {
    const lago = await spawnMockLago();
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }));
      await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "What is 17 * 23? Show your reasoning step by step.",
      });
      expect(await sdk.flush(15000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      expect(codes.has("llm_reasoning_tokens")).toBe(true);
    } finally {
      await lago.close();
    }
  });

  it("forced tool use — emits llm_tool_calls", async () => {
    const lago = await spawnMockLago();
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }));
      await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "What's the weather in Tokyo?",
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: "get_weather",
                  description: "Get the current weather for a city.",
                  parameters: {
                    type: "OBJECT",
                    properties: { city: { type: "STRING" } },
                    required: ["city"],
                  },
                },
              ],
            },
          ],
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
        },
      } as any);
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_tool_calls")).toBe(true);
    } finally {
      await lago.close();
    }
  });
});
