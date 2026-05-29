/** OpenAI wrapper tests — fake client, no live API. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

// ---------------------------------------------------------------------
// Fake openai SDK that mimics the surface area of `openai` v4+:
//   client.chat.completions.create(...)
//   client.responses.create(...)
// Both return Promises (the real SDK returns APIPromise<T>, a Promise
// subclass — our wrapper wraps it in a Proxy. For tests we just resolve
// a plain Promise; the Proxy's .then interception works the same way).
// ---------------------------------------------------------------------
class FakeCompletions {
  createCalls = 0;
  lastKwargs: Record<string, unknown> | null = null;

  async create(args: any) {
    this.createCalls++;
    expect("lago" in (args || {})).toBe(false); // wrapper must strip lago opts
    this.lastKwargs = { ...args };

    if (args?.stream === true) {
      // Stream yields several chunks; the LAST one carries usage (because
      // the wrapper auto-injects stream_options.include_usage:true).
      const chunks = [
        { choices: [{ delta: { content: "hi" } }], usage: null },
        {
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 22,
            prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
          },
        },
      ];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    }

    return {
      model: args?.model ?? "gpt-4o-mini",
      choices: [{ message: { role: "assistant", content: "hi", tool_calls: null } }],
      usage: {
        prompt_tokens: 8,
        completion_tokens: 16,
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
      },
    };
  }
}

class FakeChat {
  completions = new FakeCompletions();
}

class FakeResponses {
  createCalls = 0;

  async create(args: any) {
    this.createCalls++;
    expect("lago" in (args || {})).toBe(false);
    return {
      model: args?.model ?? "gpt-4o-mini",
      output: [{ type: "function_call", name: "get_weather" }],
      usage: {
        input_tokens: 53,
        output_tokens: 6,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
  }
}

class FakeOpenAI {
  chat = new FakeChat();
  responses = new FakeResponses();
}
// Detector keys on the constructor name; "OpenAI" matches.
Object.defineProperty(FakeOpenAI, "name", { value: "OpenAI" });

function newSdk(defaultSub = "sub_test") {
  const received: LagoEvent[] = [];
  const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: defaultSub });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received };
}

describe("OpenAI wrapper — Chat Completions", () => {
  it("chat.completions.create emits llm_input_tokens + llm_output_tokens", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    const resp = (await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [],
    } as any)) as any;
    expect(resp.usage.prompt_tokens).toBe(8);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(8);
    expect(map.llm_output_tokens).toBe(16);
  });

  it("strips inline lago options + applies per-call subscription", async () => {
    const { sdk, received } = newSdk("sub_default");
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    await client.chat.completions.create({
      model: "gpt-4o-mini",
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
    const fake = new FakeOpenAI();
    sdk.wrap(fake);
    sdk.wrap(fake);
    sdk.wrap(fake);
    await fake.chat.completions.create({ model: "gpt-4o-mini", messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2); // input + output, not 6
    expect(fake.chat.completions.createCalls).toBe(1);
  });

  it("stream=true captures usage from final chunk", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    const stream = (await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [],
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    const chunks: unknown[] = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(12);
    expect(map.llm_output_tokens).toBe(22);
  });

  it("auto-injects stream_options.include_usage when missing", async () => {
    const { sdk } = newSdk();
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    const stream = (await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [],
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    await sdk.shutdown(1000);
    expect(fake.chat.completions.lastKwargs?.stream_options).toEqual({ include_usage: true });
  });

  it("respects customer's explicit include_usage:false", async () => {
    const { sdk } = newSdk();
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    const stream = (await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [],
      stream: true,
      stream_options: { include_usage: false },
    } as any)) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    await sdk.shutdown(1000);
    expect(fake.chat.completions.lastKwargs?.stream_options).toEqual({ include_usage: false });
  });

  it("preserves existing stream_options keys while injecting include_usage", async () => {
    const { sdk } = newSdk();
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    const stream = (await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [],
      stream: true,
      stream_options: { some_other_option: "value" },
    } as any)) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    await sdk.shutdown(1000);
    expect(fake.chat.completions.lastKwargs?.stream_options).toEqual({
      some_other_option: "value",
      include_usage: true,
    });
  });
});

describe("OpenAI wrapper — Responses API", () => {
  it("responses.create emits input, output and tool_calls", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    const resp = (await client.responses.create({ model: "gpt-4o-mini", input: "hi" } as any)) as any;
    expect(resp.usage.input_tokens).toBe(53);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(53);
    expect(map.llm_output_tokens).toBe(6);
    expect(map.llm_tool_calls).toBe(1);
  });
});

describe("OpenAI wrapper — failure isolation", () => {
  it("instrumentation failure does not break the call", async () => {
    const { sdk } = newSdk();

    class BadCompletions {
      async create(_args: any) {
        return {
          get usage(): any {
            throw new Error("boom");
          },
        };
      }
    }
    class BadChat {
      completions = new BadCompletions();
    }
    class BadOpenAI {
      chat = new BadChat();
    }
    Object.defineProperty(BadOpenAI, "name", { value: "OpenAI" });

    const client = sdk.wrap(new BadOpenAI() as any);
    const resp = await client.chat.completions.create({ model: "x", messages: [] });
    expect(resp).toBeDefined();
    await sdk.shutdown(500);
  });
});
