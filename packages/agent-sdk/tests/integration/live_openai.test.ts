/** Live OpenAI end-to-end + mock Lago. Skipped unless OPENAI_API_KEY is set. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";

const SKIP = !process.env.OPENAI_API_KEY;

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

describe.skipIf(SKIP)("Live OpenAI", () => {
  it("chat.completions.create — emits llm_input_tokens + llm_output_tokens", async () => {
    const lago = await spawnMockLago();
    try {
      const OpenAIMod = await import("openai");
      const OpenAI = OpenAIMod.default;
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }));
      await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hi" }],
        max_completion_tokens: 20,
      });
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      for (const e of lago.received) {
        expect(e.properties.api).toBe("chat_completions");
        expect(e.properties.provider).toBe("openai");
      }
    } finally {
      await lago.close();
    }
  });

  it("chat.completions.create with stream:true — emits from final chunk (auto-inject include_usage)", async () => {
    const lago = await spawnMockLago();
    try {
      const OpenAIMod = await import("openai");
      const OpenAI = OpenAIMod.default;
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }));
      // No stream_options passed — the wrapper auto-injects include_usage:true
      const stream = (await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Say hi" }],
        max_completion_tokens: 20,
        stream: true,
      } as never)) as AsyncIterable<unknown>;
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

  it("chat.completions.create with forced tool use — emits llm_tool_calls", async () => {
    const lago = await spawnMockLago();
    try {
      const OpenAIMod = await import("openai");
      const OpenAI = OpenAIMod.default;
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }));
      await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get the current weather for a city.",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "get_weather" } },
        max_completion_tokens: 200,
      });
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_tool_calls")).toBe(true);
    } finally {
      await lago.close();
    }
  });

  it("o-series reasoning model — emits llm_reasoning_tokens", async () => {
    const lago = await spawnMockLago();
    try {
      const OpenAIMod = await import("openai");
      const OpenAI = OpenAIMod.default;
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }));
      await client.chat.completions.create({
        model: "o4-mini",
        messages: [{ role: "user", content: "What is 17 * 23? Just the number." }],
        max_completion_tokens: 2000,
      });
      expect(await sdk.flush(30000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      expect(codes.has("llm_reasoning_tokens")).toBe(true);
    } finally {
      await lago.close();
    }
  });

  it("responses.create — emits llm_input_tokens + llm_output_tokens with api=responses", async () => {
    const lago = await spawnMockLago();
    try {
      const OpenAIMod = await import("openai");
      const OpenAI = OpenAIMod.default;
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }));
      await client.responses.create({
        model: "gpt-4o-mini",
        input: "Say hi",
        max_output_tokens: 20,
      });
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      for (const e of lago.received) {
        expect(e.properties.api).toBe("responses");
        expect(e.properties.provider).toBe("openai");
      }
    } finally {
      await lago.close();
    }
  });
});
