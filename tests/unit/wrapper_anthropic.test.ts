/** Anthropic wrapper tests — fake client, no live API. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

class FakeMessages {
  createCalls = 0;
  streamCalls = 0;

  async create(args: any) {
    this.createCalls++;
    expect("lago" in (args || {})).toBe(false);
    if (args?.stream === true) {
      const events = [
        { type: "message_start", message: { usage: { input_tokens: 12 } } },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 12, output_tokens: 22 },
        },
        { type: "message_stop" },
      ];
      return (async function* () {
        for (const e of events) yield e;
      })();
    }
    return {
      model: args?.model ?? "claude-sonnet-4-6",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 8,
        output_tokens: 16,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    };
  }

  stream(args: any) {
    this.streamCalls++;
    expect("lago" in (args || {})).toBe(false);
    const finalMessage = {
      model: args?.model ?? "claude-sonnet-4-6",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 5, output_tokens: 11 },
    };
    return {
      finalMessage: async () => finalMessage,
    };
  }
}

class FakeAnthropic {
  messages = new FakeMessages();
}
Object.defineProperty(FakeAnthropic, "name", { value: "Anthropic" });

function newSdk(defaultSub = "sub_test") {
  const received: LagoEvent[] = [];
  const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: defaultSub });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received };
}

describe("Anthropic wrapper", () => {
  it("messages.create — emits input + output", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeAnthropic();
    const client = sdk.wrap(fake);
    const resp = (await client.messages.create({
      model: "claude-sonnet-4-6",
      messages: [],
    })) as any;
    expect(resp.usage.input_tokens).toBe(8);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(8);
    expect(map.llm_output_tokens).toBe(16);
  });

  it("strips inline lago options + applies per-call subscription", async () => {
    const { sdk, received } = newSdk("sub_default");
    const fake = new FakeAnthropic();
    const client = sdk.wrap(fake);
    await client.messages.create({
      model: "claude-sonnet-4-6",
      messages: [],
      lago: { subscription: "sub_per_call", dimensions: { feature: "X" } },
    } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.external_subscription_id === "sub_per_call")).toBe(true);
    expect(received[0].properties.feature).toBe("X");
  });

  it("double-wrap is idempotent — emit once per call", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeAnthropic();
    sdk.wrap(fake);
    sdk.wrap(fake);
    sdk.wrap(fake);
    await fake.messages.create({ model: "claude-sonnet-4-6", messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2);
    expect(fake.messages.createCalls).toBe(1);
  });

  it("messages.create with stream=true emits from message_delta event", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeAnthropic();
    const client = sdk.wrap(fake);
    const stream = (await client.messages.create({
      model: "claude-sonnet-4-6",
      messages: [],
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const e of stream) events.push(e);
    expect(events).toHaveLength(3);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(12);
    expect(map.llm_output_tokens).toBe(22);
  });

  it("messages.stream — emits when finalMessage() resolves", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeAnthropic();
    const client = sdk.wrap(fake);
    const stream = client.messages.stream({ model: "claude-sonnet-4-6", messages: [] }) as any;
    await stream.finalMessage();
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(5);
    expect(map.llm_output_tokens).toBe(11);
  });

  it("instrumentation failure does not break the call", async () => {
    const { sdk } = newSdk();

    class BadAnthropic {
      messages = {
        async create() {
          return {
            get usage(): any {
              throw new Error("boom");
            },
            content: [],
          };
        },
      };
    }
    Object.defineProperty(BadAnthropic, "name", { value: "Anthropic" });

    const client = sdk.wrap(new BadAnthropic());
    const resp = await client.messages.create({ model: "x", messages: [] });
    expect(resp).toBeDefined();
    await sdk.shutdown(500);
  });
});
