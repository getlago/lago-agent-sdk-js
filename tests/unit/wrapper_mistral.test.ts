/** Mistral wrapper tests — fake client, no live API. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

class FakeChat {
  completeCalls = 0;
  streamCalls = 0;

  async complete(_args: any) {
    this.completeCalls++;
    expect("lago" in (_args || {})).toBe(false); // wrapper must strip lago opts
    return {
      model: _args?.model ?? "mistral-small-latest",
      choices: [{ message: { content: "hi", tool_calls: null } }],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    };
  }

  stream(_args: any) {
    this.streamCalls++;
    expect("lago" in (_args || {})).toBe(false);
    const chunks = [
      { data: { choices: [{ delta: { content: "hi" }, finish_reason: null }] } },
      {
        data: {
          choices: [{ delta: { content: "." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        },
      },
    ];
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  }
}

class FakeMistral {
  // The detector keys on the constructor name; "Mistral" matches.
  chat = new FakeChat();
}
Object.defineProperty(FakeMistral, "name", { value: "Mistral" });

function newSdk(defaultSub = "sub_test") {
  const received: LagoEvent[] = [];
  const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: defaultSub });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received };
}

describe("Mistral wrapper", () => {
  it("chat.complete emits llm_input_tokens + llm_output_tokens", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeMistral();
    const client = sdk.wrap(fake);
    const resp = (await client.chat.complete({ model: "mistral-small-latest", messages: [] })) as any;
    expect(resp.usage.prompt_tokens).toBe(12);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(12);
    expect(map.llm_output_tokens).toBe(7);
  });

  it("strips inline lago options + applies per-call subscription", async () => {
    const { sdk, received } = newSdk("sub_default");
    const fake = new FakeMistral();
    const client = sdk.wrap(fake);
    await client.chat.complete({
      model: "mistral-small-latest",
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
    const fake = new FakeMistral();
    sdk.wrap(fake);
    sdk.wrap(fake);
    sdk.wrap(fake);
    await fake.chat.complete({ model: "mistral-small-latest", messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2); // input + output, never 6
    expect(fake.chat.completeCalls).toBe(1);
  });

  it("chat.stream captures usage from final chunk's data.usage", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeMistral();
    const client = sdk.wrap(fake);
    const chunks: any[] = [];
    for await (const c of (await client.chat.stream({
      model: "mistral-small-latest",
      messages: [],
    })) as any) {
      chunks.push(c);
    }
    expect(chunks).toHaveLength(2);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(9);
    expect(map.llm_output_tokens).toBe(4);
  });

  it("instrumentation failure does not break the call", async () => {
    const { sdk } = newSdk();
    class BadChat {
      async complete(_args: any) {
        return {
          get usage(): any {
            throw new Error("boom");
          },
        };
      }
    }
    class BadFake {
      chat = new BadChat();
    }
    Object.defineProperty(BadFake, "name", { value: "Mistral" });
    const fake = new BadFake();
    const client = sdk.wrap(fake);
    // adapter will crash on enumeration; wrapper must still return resp
    const resp = await client.chat.complete({ model: "x", messages: [] });
    expect(resp).toBeDefined();
    await sdk.shutdown(500);
  });

  it("regression: chat.stream returning Promise<AsyncIterable> must be awaited before iterating", async () => {
    /* The real @mistralai/mistralai SDK's chat.stream is an async function that
       returns a Promise<AsyncIterable>. If the wrapper iterates without first
       awaiting the Promise, `for await (...)` would throw TypeError. Use a
       fake that explicitly returns a Promise<AsyncIterable> (not the iterable
       itself) so this code path is exercised. */
    const { sdk, received } = newSdk();
    class PromiseStreamChat {
      async complete(_args: any) {
        return null;
      }
      async stream(_args: any): Promise<AsyncIterable<unknown>> {
        const chunks = [
          { data: { choices: [{ delta: { content: "hi" }, finish_reason: null }] } },
          {
            data: {
              choices: [{ delta: { content: "." }, finish_reason: "stop" }],
              usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
            },
          },
        ];
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      }
    }
    class PromiseStreamMistral {
      chat = new PromiseStreamChat();
    }
    Object.defineProperty(PromiseStreamMistral, "name", { value: "Mistral" });

    const client = sdk.wrap(new PromiseStreamMistral() as any);
    const stream = (await client.chat.stream({
      model: "mistral-small-latest",
      messages: [],
    } as any)) as AsyncIterable<unknown>;
    const chunks: unknown[] = [];
    for await (const c of stream) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(9);
    expect(map.llm_output_tokens).toBe(4);
  });
});
