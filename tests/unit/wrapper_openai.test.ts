/** OpenAI wrapper tests — fake client, no live API. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

// What OpenAI resolves the requested "gpt-4o-mini" alias to. Streaming chunks
// report it on every frame; the wrapper must carry it through to the event, or
// pricing looks up an alias OpenRouter doesn't list.
const RESOLVED_STREAM_MODEL = "gpt-4o-mini-2024-07-18";

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
      // Every real chunk carries the RESOLVED model — a short alias like
      // "gpt-4o-mini" comes back as a dated snapshot. Pricing keys off it.
      const chunks = [
        { choices: [{ delta: { content: "hi" } }], usage: null, model: RESOLVED_STREAM_MODEL },
        {
          choices: [],
          model: RESOLVED_STREAM_MODEL,
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
  lastKwargs: Record<string, unknown> | null = null;

  async create(args: any) {
    this.createCalls++;
    expect("lago" in (args || {})).toBe(false);
    this.lastKwargs = { ...args };

    if (args?.stream === true) {
      // Responses API stream — yields response.* events; the final
      // `response.completed` event carries usage on the response payload.
      const chunks = [
        { type: "response.created", response: { id: "resp_x" } },
        { type: "response.output_text.delta", delta: "hi" },
        {
          type: "response.completed",
          response: {
            id: "resp_x",
            usage: {
              input_tokens: 53,
              output_tokens: 6,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    }

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

  it("stream attributes the resolved model, not the requested alias", async () => {
    // The model-attribution fix has to reach the streaming path too. The wrapper
    // rebuilds a synthetic usage payload from the chunks, and dropping the
    // chunk's own `model` made `resolveModel` fall back to the requested alias —
    // so a streamed call was attributed (and priced) as "gpt-4o-mini" while the
    // identical non-streaming call correctly resolved to the dated snapshot. In
    // price mode that means the OpenRouter lookup misses and silently degrades
    // to token events.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new FakeOpenAI());
    const stream = (await client.chat.completions.create({
      model: "gpt-4o-mini",
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

  it("does not mutate the caller's params object", async () => {
    // `delete firstArg.lago` and the stream_options injection both mutated the
    // object the customer handed us, so a params object reused across calls — a
    // retry loop, or a request-scoped config — lost its `lago` key after the first
    // call, and every later one silently fell back to the default subscription,
    // dimensions, mode and markup.
    const { sdk, received } = newSdk("sub_default");
    const client = sdk.wrap(new FakeOpenAI());
    const params: any = {
      model: "gpt-4o-mini",
      messages: [],
      lago: { subscription: "sub_per_call" },
    };
    await client.chat.completions.create(params);
    await client.chat.completions.create(params); // same object, second time
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    expect(params.lago).toEqual({ subscription: "sub_per_call" }); // untouched
    expect(params.stream_options).toBeUndefined(); // no injection into caller state
    // BOTH calls must be attributed to the per-call subscription.
    expect(received.length).toBe(4); // 2 calls x (input + output)
    expect(received.every((e) => e.external_subscription_id === "sub_per_call")).toBe(true);
  });

  it("withResponse() is billed, not silently skipped", async () => {
    // `withResponse()` resolves to { data, response } and is a documented public
    // API for reading rate-limit headers — but it calls `this.parse()` on the
    // target, so the Proxy's `then` trap never fired and the call was never billed.
    const { sdk, received } = newSdk();
    class WrCompletions {
      create(_args: any) {
        return fakeApiPromise({
          model: "gpt-4o-mini",
          choices: [{ message: { role: "assistant", content: "hi", tool_calls: null } }],
          usage: { prompt_tokens: 8, completion_tokens: 16 },
        });
      }
    }
    class WrClient {
      chat = { completions: new WrCompletions() };
    }
    Object.defineProperty(WrClient, "name", { value: "OpenAI" });
    const client2 = sdk.wrap(new WrClient() as any);
    const promise: any = client2.chat.completions.create({ model: "gpt-4o-mini", messages: [] } as any);
    const result = await promise.withResponse();
    expect(result.data).toBeDefined();
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(8);
    expect(map.llm_output_tokens).toBe(16);
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

  it("responses.create with stream:true does NOT inject stream_options", async () => {
    /* Regression test: the Responses API does not accept the `stream_options`
       parameter — injecting it would cause TypeError / HTTP 400 and break the
       customer's call. The wrapper must only inject on chat.completions. */
    const { sdk } = newSdk();
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    const stream = (await client.responses.create({
      model: "gpt-4o-mini",
      input: "hi",
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    await sdk.shutdown(1000);
    expect(fake.responses.lastKwargs).toBeDefined();
    expect("stream_options" in (fake.responses.lastKwargs ?? {})).toBe(false);
  });

  it("responses.create with stream:true emits usage from final response.completed event", async () => {
    /* The Responses API emits a terminal `response.completed` event whose
       `response.usage` carries the totals. Wrapper must capture from that
       event. */
    const { sdk, received } = newSdk();
    const fake = new FakeOpenAI();
    const client = sdk.wrap(fake);
    const stream = (await client.responses.create({
      model: "gpt-4o-mini",
      input: "hi",
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    const events: unknown[] = [];
    for await (const e of stream) events.push(e);
    expect(events).toHaveLength(3);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(53);
    expect(map.llm_output_tokens).toBe(6);
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
    // The real APIPromise resolves `withResponse()` via `this.parse()`, so it never
    // passes through a `then` interceptor — which is what left that path unbilled.
    withResponse: async () => ({
      data: await promise,
      response: new Response(null, cacheStatus ? { headers: { "cf-aig-cache-status": cacheStatus } } : {}),
    }),
  };
}

describe("OpenAI wrapper — gateway cache-hit detection", () => {
  it("skips billing when cf-aig-cache-status: HIT", async () => {
    const { sdk, received } = newSdk();

    class CachedCompletions {
      create(_args: any) {
        return fakeApiPromise(
          {
            model: "gpt-4o-mini",
            choices: [{ message: { role: "assistant", content: "hi", tool_calls: null } }],
            usage: { prompt_tokens: 8, completion_tokens: 16 },
          },
          "HIT",
        );
      }
    }
    class CachedChat {
      completions = new CachedCompletions();
    }
    class CachedOpenAI {
      chat = new CachedChat();
    }
    Object.defineProperty(CachedOpenAI, "name", { value: "OpenAI" });

    const client = sdk.wrap(new CachedOpenAI() as any);
    const resp: any = await client.chat.completions.create({ model: "gpt-4o-mini", messages: [] });
    expect(resp.usage.prompt_tokens).toBe(8); // customer still sees the real response
    await sdk.flush(500);
    await sdk.shutdown(500);
    expect(received).toHaveLength(0); // a real cache HIT cost nothing — must not be billed
  });

  it("still bills normally when the header is absent (no gateway in the path)", async () => {
    const { sdk, received } = newSdk();

    class UncachedCompletions {
      create(_args: any) {
        return fakeApiPromise({
          model: "gpt-4o-mini",
          choices: [{ message: { role: "assistant", content: "hi", tool_calls: null } }],
          usage: { prompt_tokens: 8, completion_tokens: 16 },
        });
      }
    }
    class UncachedChat {
      completions = new UncachedCompletions();
    }
    class UncachedOpenAI {
      chat = new UncachedChat();
    }
    Object.defineProperty(UncachedOpenAI, "name", { value: "OpenAI" });

    const client = sdk.wrap(new UncachedOpenAI() as any);
    await client.chat.completions.create({ model: "gpt-4o-mini", messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2); // input + output — billed as usual
  });

  it("still bills normally when cf-aig-cache-status is MISS", async () => {
    const { sdk, received } = newSdk();

    class MissCompletions {
      create(_args: any) {
        return fakeApiPromise(
          {
            model: "gpt-4o-mini",
            choices: [{ message: { role: "assistant", content: "hi", tool_calls: null } }],
            usage: { prompt_tokens: 8, completion_tokens: 16 },
          },
          "MISS",
        );
      }
    }
    class MissChat {
      completions = new MissCompletions();
    }
    class MissOpenAI {
      chat = new MissChat();
    }
    Object.defineProperty(MissOpenAI, "name", { value: "OpenAI" });

    const client = sdk.wrap(new MissOpenAI() as any);
    await client.chat.completions.create({ model: "gpt-4o-mini", messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2);
  });
});
