/** OpenAI wrapper tests — fake client, no live API. */
import { describe, expect, it } from "vitest";
import { PROVIDER_BY_BASE_URL_PATH, providerHintFor } from "../../src/wrappers/openai.js";
import { TOKEN_BILLED_PROVIDERS } from "../../src/pricing.js";

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

/**
 * Minimal fake reproducing Databricks' streaming convention, which differs from
 * OpenAI's in two measured ways: usage is on EVERY frame and is CUMULATIVE, and there
 * is no final usage-only frame — the last frame is an ordinary delta.
 */
class DbxStreamCompletions {
  constructor(private cumulative: number[]) {}

  async create(args: any) {
    expect(args?.stream).toBe(true);
    const frames = this.cumulative;
    return (async function* () {
      for (const n of frames) {
        yield {
          model: "meta-llama-4-maverick-040225",
          choices: [
            {
              index: 0,
              delta: { content: "a" },
              finish_reason: n === frames[frames.length - 1] ? "stop" : null,
            },
          ],
          usage: { prompt_tokens: 14, completion_tokens: n, total_tokens: 14 + n },
        };
      }
    })();
  }
}

class DbxStreamOpenAI {
  chat: { completions: DbxStreamCompletions };
  baseURL = "https://dbc-0223ef70-2638.cloud.databricks.com/ai-gateway/mlflow/v1";

  constructor(cumulative: number[]) {
    this.chat = { completions: new DbxStreamCompletions(cumulative) };
  }
}
Object.defineProperty(DbxStreamOpenAI, "name", { value: "OpenAI" });

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

  it("bills once when the caller uses BOTH await and withResponse()", async () => {
    // Both traps hang off the SAME APIPromise, so a caller reading usage and then
    // reading rate-limit headers billed one call twice.
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
    await promise;
    await promise.withResponse();
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.filter((e) => e.code === "llm_input_tokens").length).toBe(1);
    expect(received.filter((e) => e.code === "llm_output_tokens").length).toBe(1);
  });

  it("does not consume the caller's params — a reused object still bills per-call opts", async () => {
    // The params object belongs to the caller and may be reused across calls. Deleting
    // `lago` from it made every later call fall back to the default subscription.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new FakeOpenAI());
    const params: any = {
      model: "gpt-4o-mini",
      messages: [],
      lago: { subscription: "sub_per_call", dimensions: { feature: "X" } },
    };
    await client.chat.completions.create(params);
    expect("lago" in params).toBe(true);
    await client.chat.completions.create(params);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.length).toBeGreaterThan(2);
    expect(received.every((e) => e.external_subscription_id === "sub_per_call")).toBe(true);
    expect(received.every((e) => e.properties.feature === "X")).toBe(true);
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

describe("Databricks: baseURL decides the provider", () => {
  const DBX = "https://dbc-0223ef70-2638.cloud.databricks.com";

  it.each([
    // Hosted foundation models — DBU-billed, must NOT reach a vendor price table.
    [`${DBX}/ai-gateway/mlflow/v1`, "databricks"],
    [`${DBX}/ai-gateway/mlflow/v1/`, "databricks"],
    // BYOK surfaces keep their real vendor so they price against OpenRouter.
    [`${DBX}/ai-gateway/openai/v1`, ""],
    [`${DBX}/ai-gateway/anthropic`, ""],
    // Unrelated clients are untouched.
    ["https://api.openai.com/v1", ""],
    ["https://gateway.ai.cloudflare.com/v1/acct/gw/compat", ""],
    ["", ""],
  ])("providerHintFor(%s) -> %s", (baseURL, expected) => {
    // Two of Databricks' four surfaces use the SAME OpenAI class, and the response
    // body cannot tell them apart — a hosted call echoes a served-entity name with
    // no marker. baseURL is the only signal. Matching `/ai-gateway/mlflow/` and not
    // `/ai-gateway/` is load-bearing: the BYOK surfaces share that prefix and must
    // keep their vendor provider or they stop being priceable.
    expect(providerHintFor({ baseURL })).toBe(expected);
  });

  it("survives a client without baseURL", () => {
    // Instrumentation must never break the customer's call over a missing attribute.
    expect(providerHintFor({})).toBe("");
    expect(providerHintFor(null)).toBe("");
    expect(
      providerHintFor(
        Object.defineProperty({}, "baseURL", {
          get() {
            throw new Error("boom");
          },
        }),
      ),
    ).toBe("");
  });

  it("stamps a hosted call databricks end to end", async () => {
    // Through the real wrapper: a hosted model must come out as provider="databricks"
    // so the price lookup cannot hit. OpenRouter lists bare `openai/gpt-oss-20b` at
    // ~0.4x of Databricks' own DBU rate, so being stamped "openai" would silently
    // under-bill 2.5-5x the moment a served-entity rename let stripVersion match it.
    const { sdk, received } = newSdk();
    const fake = new FakeOpenAI() as any;
    fake.baseURL = `${DBX}/ai-gateway/mlflow/v1`;
    const client = sdk.wrap(fake);
    await client.chat.completions.create({ model: "system.ai.llama-4-maverick", messages: [] } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((e) => e.properties.provider === "databricks")).toBe(true);
  });

  it("keeps its vendor provider on a BYOK call", async () => {
    // The mirror: the same client class against the OpenAI BYOK surface must stay
    // "openai", because that path IS priceable and was verified exact against
    // Databricks' own metered spend on 38 of 38 buckets.
    const { sdk, received } = newSdk();
    const fake = new FakeOpenAI() as any;
    fake.baseURL = `${DBX}/ai-gateway/openai/v1`;
    const client = sdk.wrap(fake);
    await client.chat.completions.create({ model: "gpt-4o", messages: [] } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.properties.provider === "openai")).toBe(true);
  });

  it("takes the last frame of a cumulative usage stream", async () => {
    // last-usage-wins lands on the correct total by construction. This pins it,
    // because a "sum the frames" implementation would bill 1+7+15=23 instead of 15,
    // and a "first frame wins" one would bill 1.
    //
    // It also pins the STREAMING half of the provider stamp. The hint reaches the
    // non-streaming path through a closure but the stream path through an argument,
    // so the two can disagree — and only this assertion would notice.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new DbxStreamOpenAI([1, 7, 15]) as any);
    const stream = (await client.chat.completions.create({
      model: "system.ai.llama-4-maverick",
      messages: [],
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(14); // cumulative input must not be summed
    expect(map.llm_output_tokens).toBe(15); // final cumulative value, not 1+7+15
    expect(received.every((e) => e.properties.provider === "databricks")).toBe(true);
  });

  it("bills the partial total of an abandoned stream", async () => {
    // A behavioral divergence worth pinning rather than discovering later.
    //
    // Against real OpenAI, abandoning a stream yields no usage at all — it only
    // arrives on a final usage-only chunk — so nothing is billed. Databricks puts a
    // cumulative usage on every frame, so the generator's `finally` emit bills whatever
    // had been generated when the consumer walked away. Arguably better (it bills real
    // work), but NOT what the OpenAI path does.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new DbxStreamOpenAI([1, 7, 15]) as any);
    const stream = (await client.chat.completions.create({
      model: "system.ai.llama-4-maverick",
      messages: [],
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    let i = 0;
    for await (const _ of stream) {
      if (i++ === 1) break; // abandon after the second frame
    }
    // `break` runs the generator's return path, which is where the emit lives.
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_output_tokens).toBe(7); // partial cumulative count at abandonment
  });
});

// ---------------------------------------------------------------------
// Snowflake Cortex: an OpenAI-WIRE endpoint that is not OpenAI
//
// Cortex answers chat completions at
// `https://<account>.snowflakecomputing.com/api/v2/cortex/v1/chat/completions`, so a
// customer reaches it with the ordinary OpenAI client and a baseURL. The response body
// is an ordinary chat completion — nothing in it names Snowflake — so baseURL is again
// the only signal.
// ---------------------------------------------------------------------
const SNOW = "https://example-account.snowflakecomputing.com";
const SNOW_CORTEX = `${SNOW}/api/v2/cortex/v1`;

/**
 * A Cortex chat-completions endpoint. Streaming and non-streaming report the SAME usage
 * on purpose — the QA scenario is that the two paths agree — and the numbers are an
 * UNCACHED call so they read the same whether or not the additive-cache fix for
 * `total_tokens` is on the branch. The cached shape is pinned by that fix's own adapter
 * fixtures (11/12_snowflake_cortex_*.json), not here.
 */
const CORTEX_USAGE = {
  prompt_tokens: 42,
  completion_tokens: 7,
  total_tokens: 49,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0 },
};

class CortexCompletions {
  lastKwargs: Record<string, unknown> | null = null;

  async create(args: any) {
    this.lastKwargs = { ...args };
    // Note it is Anthropic's model name arriving on an OpenAI wire.
    const model = args?.model ?? "claude-sonnet-4-5";
    if (args?.stream === true) {
      const chunks = [
        { model, choices: [{ delta: { content: "hi" } }], usage: null },
        { model, choices: [], usage: { ...CORTEX_USAGE } },
      ];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    }
    return {
      model,
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: { ...CORTEX_USAGE },
    };
  }
}

class CortexOpenAI {
  chat: { completions: CortexCompletions };
  baseURL: string;

  constructor(baseURL: string = SNOW_CORTEX) {
    this.chat = { completions: new CortexCompletions() };
    this.baseURL = baseURL;
  }
}
Object.defineProperty(CortexOpenAI, "name", { value: "OpenAI" });

describe("Snowflake Cortex: baseURL decides the provider", () => {
  it.each([
    // The OpenAI-compatible wire, i.e. what a wrapped client is actually pointed at.
    [SNOW_CORTEX, "snowflake"],
    [`${SNOW_CORTEX}/`, "snowflake"],
    // The Anthropic wire and the native inference endpoint live under the same path,
    // and both are model inference billed in credits.
    [`${SNOW}/api/v2/cortex/v1/messages`, "snowflake"],
    [`${SNOW}/api/v2/cortex/inference:complete`, "snowflake"],
    // NOT the host: the SQL API on the same host is what this SDK's own gateway reader
    // drives, and a warehouse query is not model inference.
    [`${SNOW}/api/v2/statements`, ""],
    [SNOW, ""],
    [`${SNOW}/`, ""],
    // No segment after `cortex` is not a reachable OpenAI baseURL — the client would
    // POST `/api/v2/cortex/chat/completions`, which Cortex does not serve. Requiring the
    // trailing slash is what keeps `/api/v2/cortexsomething` out.
    [`${SNOW}/api/v2/cortex`, ""],
  ])("providerHintFor(%s) -> %s", (baseURL, expected) => {
    expect(providerHintFor({ baseURL })).toBe(expected);
  });

  it("resolves the first matching row, and every row it can produce bills as tokens", () => {
    // The shape, not the rows: a baseURL matching two entries resolves to the first, so
    // entries stay ordered most-specific-first. Pinned because the next row (Ramp) is
    // added by someone reading the table, not this test.
    expect(
      providerHintFor({
        baseURL: "https://dbc-0223ef70-2638.cloud.databricks.com/ai-gateway/mlflow/v1/api/v2/cortex/v1",
      }),
    ).toBe("databricks");
    // Every provider a hint can produce must be one `emit()` bills as token counts, or
    // the hint silently turns a priceable call into a permanent price miss.
    for (const [, provider] of PROVIDER_BY_BASE_URL_PATH) {
      expect(TOKEN_BILLED_PROVIDERS.has(provider)).toBe(true);
    }
  });

  it("stamps a Cortex call snowflake end to end", async () => {
    // The stamp asserted on a WRAPPED call, not on providerHintFor in isolation: the
    // stream-hint bug survived a green suite precisely because this repo only pinned the
    // helper. Without the hint every one of these events says provider="openai" for usage
    // Snowflake billed in credits.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new CortexOpenAI() as any);
    await client.chat.completions.create({ model: "claude-sonnet-4-5", messages: [] } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.length).toBeGreaterThan(0);
    expect(received.every((e) => e.properties.provider === "snowflake")).toBe(true);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map).toEqual({ llm_input_tokens: 42, llm_output_tokens: 7 });
  });

  it("streams the same usage and the same stamp as the non-streaming call", async () => {
    // Same usage, same stamp, and the model comes from the response rather than the
    // requested string — the streaming path takes the hint as an ARGUMENT rather than
    // through a closure, so it needs its own assertion.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new CortexOpenAI() as any);
    const stream = (await client.chat.completions.create({
      model: "claude-sonnet-4-5",
      messages: [],
      stream: true,
    } as any)) as AsyncIterable<unknown>;
    for await (const _ of stream) {
      /* drain */
    }
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map).toEqual({ llm_input_tokens: 42, llm_output_tokens: 7 });
    expect(received.every((e) => e.properties.provider === "snowflake")).toBe(true);
    expect(received.every((e) => e.properties.model === "claude-sonnet-4-5")).toBe(true);
  });

  it("does not stamp a Snowflake host that is not Cortex", async () => {
    // The mirror of the BYOK case: same host, same client class, not model inference. A
    // host-only match would stamp "snowflake" on it and make it unpriceable forever.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new CortexOpenAI(`${SNOW}/api/v2/statements`) as any);
    await client.chat.completions.create({ model: "gpt-4o", messages: [] } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.properties.provider === "openai")).toBe(true);
  });

  it("leaves a plain OpenAI client behaviourally unchanged", async () => {
    // The regression the table refactor could break: no row matches api.openai.com, so
    // an ordinary client must emit exactly what it emitted before.
    const { sdk, received } = newSdk();
    const fake = new FakeOpenAI() as any;
    fake.baseURL = "https://api.openai.com/v1";
    const client = sdk.wrap(fake);
    await client.chat.completions.create({ model: "gpt-4o-mini", messages: [] } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map).toEqual({ llm_input_tokens: 8, llm_output_tokens: 16 });
    expect(received.every((e) => e.properties.provider === "openai")).toBe(true);
  });

  it("does not mutate the caller's params across calls", async () => {
    // `stream_options` is the one nested object the wrapper writes to. Mutating the
    // caller's copy would leak `include_usage` into a later non-streaming call and, worse,
    // make a params dict reused across two clients carry the first one's settings.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new CortexOpenAI() as any);
    const params: Record<string, unknown> = {
      model: "claude-sonnet-4-5",
      messages: [],
      stream: true,
      stream_options: {},
    };
    for (let i = 0; i < 2; i++) {
      const stream = (await client.chat.completions.create(params as any)) as AsyncIterable<unknown>;
      for await (const _ of stream) {
        /* drain */
      }
    }
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(params.stream_options).toEqual({}); // the caller's nested object must be untouched
    expect(received.every((e) => e.properties.provider === "snowflake")).toBe(true);
    expect(received.filter((e) => e.code === "llm_input_tokens")).toHaveLength(2);
  });

  it("keeps the customer's spelling of a fully-qualified Cortex model", async () => {
    // A fine-tuned Cortex model is named `database.schema.model`. CanonicalUsage.model
    // reports it verbatim — normalizing it here would misreport what the customer ran, and
    // there is nothing to normalize it FOR: "snowflake" reaches no price table at all.
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new CortexOpenAI() as any);
    await client.chat.completions.create({
      model: "LAGO_DB.CORTEX.my_tuned_mistral7b",
      messages: [],
    } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.properties.model === "LAGO_DB.CORTEX.my_tuned_mistral7b")).toBe(true);
    expect(received.every((e) => e.properties.provider === "snowflake")).toBe(true);
  });
});
