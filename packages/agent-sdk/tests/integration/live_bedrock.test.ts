/** Live Bedrock end-to-end + mock Lago.
 *
 * Skipped unless AWS_BEARER_TOKEN_BEDROCK is set. The wrapper runs against the
 * real AWS SDK v3 BedrockRuntimeClient; events flow into a local mock Lago
 * server we spin up per test.
 */
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
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    for (const e of body.events ?? []) received.push(e);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe.skipIf(SKIP)("Live Bedrock — non-streaming", () => {
  it("real Converse call → mock Lago receives both metrics", async () => {
    const lago = await spawnMockLago();
    try {
      const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
      const sdk = new LagoSDK({ apiKey: "x", apiUrl: lago.url, defaultSubscriptionId: "sub_int" });
      const client = sdk.wrap(new BedrockRuntimeClient({ region: "eu-west-1" }));
      const cmd = new ConverseCommand({
        modelId: "eu.amazon.nova-lite-v1:0",
        messages: [{ role: "user", content: [{ text: "Say hi" }] }],
        inferenceConfig: { maxTokens: 30 },
      });
      await client.send(cmd);
      expect(await sdk.flush(10000)).toBe(true);
      await sdk.shutdown(2000);
      const codes = new Set(lago.received.map((e) => e.code));
      expect(codes.has("llm_input_tokens")).toBe(true);
      expect(codes.has("llm_output_tokens")).toBe(true);
      for (const e of lago.received) {
        expect(e.properties.api).toBe("bedrock_converse");
        expect(e.properties.provider).toBe("amazon");
      }
    } finally {
      await lago.close();
    }
  });
});
