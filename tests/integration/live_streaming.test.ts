/** Live Bedrock streaming end-to-end + mock Lago. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";

const SKIP = !process.env.AWS_BEARER_TOKEN_BEDROCK;

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

describe.skipIf(SKIP)("Live Bedrock streaming", () => {
  it("ConverseStream → emits events from final metadata chunk", async () => {
    const lago = await spawnMockLago();
    try {
      const { BedrockRuntimeClient, ConverseStreamCommand } = await import("@aws-sdk/client-bedrock-runtime");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new BedrockRuntimeClient({ region: "eu-west-1" }));
      const cmd = new ConverseStreamCommand({
        modelId: "eu.amazon.nova-lite-v1:0",
        messages: [{ role: "user", content: [{ text: "Say hi" }] }],
        inferenceConfig: { maxTokens: 30 },
      });
      const resp = await client.send(cmd);
      for await (const _ of resp.stream ?? []) {
        // drain — wrapper extracts usage in the finally block
      }
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      for (const e of lago.received) expect(e.properties.api).toBe("bedrock_converse");
    } finally {
      await lago.close();
    }
  });

  it("InvokeModelWithResponseStream (Anthropic) → emits events from message_delta chunk", async () => {
    const lago = await spawnMockLago();
    try {
      const { BedrockRuntimeClient, InvokeModelWithResponseStreamCommand } =
        await import("@aws-sdk/client-bedrock-runtime");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new BedrockRuntimeClient({ region: "eu-west-1" }));
      const body = JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 40,
        messages: [{ role: "user", content: "Say hi" }],
      });
      const cmd = new InvokeModelWithResponseStreamCommand({
        modelId: "eu.anthropic.claude-sonnet-4-6",
        body,
      });
      const resp = await client.send(cmd);
      for await (const _ of resp.body ?? []) {
        // drain
      }
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      for (const e of lago.received) expect(e.properties.api).toBe("bedrock_invoke");
    } finally {
      await lago.close();
    }
  });
});
