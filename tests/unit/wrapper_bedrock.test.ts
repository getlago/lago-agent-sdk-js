/** Bedrock wrapper — fake AWS SDK v3 client; no live calls. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

// ----- Fake commands -----
class FakeConverseCommand {
  constructor(public input: { modelId: string; messages?: unknown[] }) {}
}
class FakeInvokeModelCommand {
  constructor(public input: { modelId: string; body?: string | Uint8Array }) {}
}
class FakeConverseStreamCommand {
  constructor(public input: { modelId: string }) {}
}
class FakeInvokeModelWithResponseStreamCommand {
  constructor(public input: { modelId: string }) {}
}

// Important: vitest runs ESM; we want command.constructor.name to match the real names.
Object.defineProperty(FakeConverseCommand, "name", { value: "ConverseCommand" });
Object.defineProperty(FakeInvokeModelCommand, "name", { value: "InvokeModelCommand" });
Object.defineProperty(FakeConverseStreamCommand, "name", { value: "ConverseStreamCommand" });
Object.defineProperty(FakeInvokeModelWithResponseStreamCommand, "name", {
  value: "InvokeModelWithResponseStreamCommand",
});

// ----- Fake client -----
class FakeBedrockRuntimeClient {
  config = { serviceId: "bedrock-runtime" };
  sentCount = 0;

  constructor(
    private converseUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30, serverToolUsage: {} },
  ) {}

  async send(command: any) {
    this.sentCount++;
    expect("__lago" in command).toBe(false); // wrapper must strip per-call lago opts
    if (command.constructor.name === "ConverseCommand") {
      return { usage: this.converseUsage, output: { message: { content: [] } } };
    }
    if (command.constructor.name === "ConverseStreamCommand") {
      const events: any[] = [
        { contentBlockDelta: { delta: { text: "hi" }, contentBlockIndex: 0 } },
        { messageStop: { stopReason: "end_turn" } },
        { metadata: { usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 } } },
      ];
      return {
        stream: (async function* () {
          for (const e of events) yield e;
        })(),
      };
    }
    if (command.constructor.name === "InvokeModelCommand") {
      const body = new TextEncoder().encode(
        JSON.stringify({
          usage: { input_tokens: 5, output_tokens: 7 },
          content: [{ type: "text", text: "hi" }],
        }),
      );
      return { body, contentType: "application/json" };
    }
    if (command.constructor.name === "InvokeModelWithResponseStreamCommand") {
      // Real Anthropic streams put the FINAL usage on the `message_delta` chunk
      // at top-level, with both input_tokens and output_tokens populated.
      const enc = new TextEncoder();
      const events: any[] = [
        {
          chunk: {
            bytes: enc.encode(
              JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 9 } } }),
            ),
          },
        },
        {
          chunk: {
            bytes: enc.encode(JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })),
          },
        },
        {
          chunk: {
            bytes: enc.encode(
              JSON.stringify({ type: "message_delta", usage: { input_tokens: 9, output_tokens: 14 } }),
            ),
          },
        },
        {
          chunk: {
            bytes: enc.encode(
              JSON.stringify({
                type: "message_stop",
                "amazon-bedrock-invocationMetrics": { inputTokenCount: 9, outputTokenCount: 14 },
              }),
            ),
          },
        },
      ];
      return {
        body: (async function* () {
          for (const e of events) yield e;
        })(),
      };
    }
    return {};
  }
}

function newSdk() {
  const received: LagoEvent[] = [];
  const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: "sub_test" });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received };
}

describe("Bedrock wrapper", () => {
  it("ConverseCommand emits llm_input_tokens + llm_output_tokens", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeBedrockRuntimeClient();
    const client = sdk.wrap(fake as any);
    const r = await client.send(new FakeConverseCommand({ modelId: "eu.amazon.nova-lite-v1:0" }) as any);
    expect((r as any).usage.inputTokens).toBe(10);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code).sort()).toEqual(["llm_input_tokens", "llm_output_tokens"]);
  });

  it("InvokeModelCommand parses body and emits anthropic-shape usage", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeBedrockRuntimeClient();
    const client = sdk.wrap(fake as any);
    await client.send(
      new FakeInvokeModelCommand({ modelId: "eu.anthropic.claude-sonnet-4-6", body: "{}" }) as any,
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(5);
    expect(map.llm_output_tokens).toBe(7);
  });

  it("ConverseStreamCommand captures usage from final metadata event", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeBedrockRuntimeClient();
    const client = sdk.wrap(fake as any);
    const r = (await client.send(
      new FakeConverseStreamCommand({ modelId: "eu.amazon.nova-lite-v1:0" }) as any,
    )) as any;
    const events = [];
    for await (const e of r.stream) events.push(e);
    expect(events).toHaveLength(3);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(11);
    expect(map.llm_output_tokens).toBe(22);
  });

  it("InvokeModelWithResponseStreamCommand prefers usage payload over invocation metrics", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeBedrockRuntimeClient();
    const client = sdk.wrap(fake as any);
    const r = (await client.send(
      new FakeInvokeModelWithResponseStreamCommand({ modelId: "eu.anthropic.claude-sonnet-4-6" }) as any,
    )) as any;
    const events = [];
    for await (const e of r.body) events.push(e);
    expect(events).toHaveLength(4);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(9);
    expect(map.llm_output_tokens).toBe(14);
  });

  it("strips __lago metadata from command before forwarding + applies per-call subscription", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeBedrockRuntimeClient();
    const client = sdk.wrap(fake as any);
    const cmd = new FakeConverseCommand({ modelId: "eu.amazon.nova-lite-v1:0" }) as any;
    cmd.__lago = { subscription: "sub_per_call", dimensions: { feature: "X" } };
    await client.send(cmd);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.external_subscription_id === "sub_per_call")).toBe(true);
    expect(received[0].properties.feature).toBe("X");
  });

  it("double-wrap is idempotent — emit once per call", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeBedrockRuntimeClient();
    const a = sdk.wrap(fake as any);
    const b = sdk.wrap(a as any);
    const c = sdk.wrap(b as any);
    await c.send(new FakeConverseCommand({ modelId: "eu.amazon.nova-lite-v1:0" }) as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2); // input + output, not 6
    expect(fake.sentCount).toBe(1);
  });

  it("instrumentation failure does not break the call", async () => {
    const { sdk } = newSdk();
    class BadClient {
      config = { serviceId: "bedrock-runtime" };
      async send(_cmd: any) {
        return { usage: "not-a-dict" };
      }
    }
    const client = sdk.wrap(new BadClient() as any);
    const r = (await client.send(new FakeConverseCommand({ modelId: "x" }) as any)) as any;
    expect(r.usage).toBe("not-a-dict");
    await sdk.shutdown(500);
  });
});
