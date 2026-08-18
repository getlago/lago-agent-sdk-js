/** Anthropic wrapper tests — fake client, no live API. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

// What Anthropic resolves the requested "claude-sonnet-4-6" alias to. Only
// `message_start` reports it, so the wrapper has to keep it across the whole
// stream or pricing looks up an alias OpenRouter doesn't list.
const RESOLVED_STREAM_MODEL = "claude-sonnet-4-6-20260214";

class FakeMessages {
  createCalls = 0;
  streamCalls = 0;

  async create(args: any) {
    this.createCalls++;
    expect("lago" in (args || {})).toBe(false);
    if (args?.stream === true) {
      // Mirrors the real wire shape: message_start carries authoritative
      // input/cache (output only primed to 1) nested under message.usage;
      // message_delta carries ONLY cumulative output at the top level — it does
      // NOT echo input_tokens. A wrapper reading only top-level usage bills
      // input_tokens=0.
      const events = [
        {
          type: "message_start",
          message: {
            // message_start is also where the RESOLVED snapshot arrives — the
            // requested alias never appears again.
            model: RESOLVED_STREAM_MODEL,
            usage: {
              input_tokens: 12,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 1,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 22 },
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

  it("stream attributes the resolved model, not the requested alias", async () => {
    // Only `message_start` carries the resolved snapshot, and the wrapper
    // accumulates usage across several events before emitting — so the model has
    // to survive the whole stream. Rebuilding a usage-only payload reverted the
    // attribution to the requested alias, which OpenRouter doesn't list.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new FakeAnthropic());
    const stream = (await client.messages.create({
      model: "claude-sonnet-4-6",
      messages: [],
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(new Set(received.map((e) => e.properties.model))).toEqual(new Set([RESOLVED_STREAM_MODEL]));
  });

  it("messages.create with stream=true merges message_start + message_delta usage", async () => {
    // Regression: input/cache come from message_start, output from message_delta.
    // message_delta does not echo input_tokens, so the stream wrapper must merge
    // message_start's nested message.usage with the delta — reading only
    // top-level usage would bill input_tokens=0.
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

  it("regression: messages.stream's finalMessage() must await origFinal before emitting", async () => {
    /* If the wrapper's monkey-patched finalMessage doesn't await the underlying
       async function, emitFrom receives an un-awaited Promise object — the
       adapter sees no .usage attribute, nothing gets billed, and the customer
       silently under-bills. Track invocation explicitly via a counter so the
       test fails if a refactor accidentally drops the `await`. */
    const { sdk, received } = newSdk();
    let asyncCallsAwaited = 0;
    class CountingAsyncMessages {
      async create() {
        return null;
      }
      stream(_args: any) {
        return {
          finalMessage: async () => {
            asyncCallsAwaited++;
            return {
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "hi" }],
              usage: { input_tokens: 5, output_tokens: 11 },
            };
          },
        };
      }
    }
    class CountingAnthropic {
      messages = new CountingAsyncMessages();
    }
    Object.defineProperty(CountingAnthropic, "name", { value: "Anthropic" });

    const client = sdk.wrap(new CountingAnthropic());
    const stream = (client as any).messages.stream({
      model: "claude-sonnet-4-6",
      messages: [],
    });
    await stream.finalMessage();
    expect(asyncCallsAwaited).toBe(1);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(5);
    expect(map.llm_output_tokens).toBe(11);
  });
});

// ---------------------------------------------------------------------
// Gateway cache-hit detection. The real APIPromise exposes `.asResponse()`
// alongside normal `.then()`/await — this fake mimics exactly that dual
// surface (a thenable that ALSO has `.asResponse()`), the shape our
// wrapper's cache-hit check actually depends on.
// ---------------------------------------------------------------------
function fakeApiPromise(resolvedValue: unknown, cacheStatus?: string) {
  const promise = Promise.resolve(resolvedValue);
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
    asResponse: async () =>
      new Response(null, cacheStatus ? { headers: { "cf-aig-cache-status": cacheStatus } } : {}),
  };
}

describe("Anthropic wrapper — gateway cache-hit detection", () => {
  it("skips billing when cf-aig-cache-status: HIT", async () => {
    const { sdk, received } = newSdk();

    class CachedMessages {
      create(_args: any) {
        return fakeApiPromise(
          {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 8, output_tokens: 16 },
          },
          "HIT",
        );
      }
    }
    class CachedAnthropic {
      messages = new CachedMessages();
    }
    Object.defineProperty(CachedAnthropic, "name", { value: "Anthropic" });

    const client = sdk.wrap(new CachedAnthropic() as any);
    const resp: any = await client.messages.create({ model: "claude-sonnet-4-6", messages: [] });
    expect(resp.usage.input_tokens).toBe(8); // customer still sees the real response
    await sdk.flush(500);
    await sdk.shutdown(500);
    expect(received).toHaveLength(0); // a real cache HIT cost nothing — must not be billed
  });

  it("still bills normally when the header is absent (no gateway in the path)", async () => {
    const { sdk, received } = newSdk();

    class UncachedMessages {
      create(_args: any) {
        return fakeApiPromise({
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 8, output_tokens: 16 },
        });
      }
    }
    class UncachedAnthropic {
      messages = new UncachedMessages();
    }
    Object.defineProperty(UncachedAnthropic, "name", { value: "Anthropic" });

    const client = sdk.wrap(new UncachedAnthropic() as any);
    await client.messages.create({ model: "claude-sonnet-4-6", messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2); // input + output — billed as usual
  });

  it("still bills normally when cf-aig-cache-status is MISS", async () => {
    const { sdk, received } = newSdk();

    class MissMessages {
      create(_args: any) {
        return fakeApiPromise(
          {
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 8, output_tokens: 16 },
          },
          "MISS",
        );
      }
    }
    class MissAnthropic {
      messages = new MissMessages();
    }
    Object.defineProperty(MissAnthropic, "name", { value: "Anthropic" });

    const client = sdk.wrap(new MissAnthropic() as any);
    await client.messages.create({ model: "claude-sonnet-4-6", messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2);
  });
});
