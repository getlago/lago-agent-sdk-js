/**
 * `withSubscription()` must still own a call whose RESULT is consumed elsewhere.
 *
 * The subscription used to be resolved inside `emit()`, which runs when the provider
 * answers. `withSubscription()` binds the id in `AsyncLocalStorage`, and that store is
 * only readable inside the `run()` callback — so a promise or a stream created inside
 * `withSubscription()` and consumed OUTSIDE it read no subscription at all, and the event
 * was dropped with a "no subscription resolved" report. Measured on `main`: 0 events for
 * both shapes.
 *
 * It is an ordinary way to write it:
 *
 *   async function ask(p) { return sdk.withSubscription(sub, () => client.chat.completions.create(p)); }
 *   const stream = await ask(...);
 *   for await (const chunk of stream) { ... }   // <- the run() frame is long gone
 *
 * The wrappers now resolve it while the customer's own call frame is still on the stack.
 * That is the better rule regardless: the subscription that owns a call is the one active
 * when the call was MADE, not whichever happens to be active when the provider replies.
 */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OpenAI-shaped: the detector keys on the constructor name. */
class OpenAI {
  baseURL = "https://api.openai.com/v1";
  chat = {
    completions: {
      create: async (params: Record<string, unknown>) => {
        // A real await, so the response resolves in a different async frame from the
        // call — without it there is nothing for the async-local store to lose.
        await sleep(20);
        if (params.stream) {
          return (async function* () {
            yield { choices: [{ delta: { content: "hi" } }] };
            yield { model: "gpt-4o", usage: { prompt_tokens: 7, completion_tokens: 3 } };
          })();
        }
        return { model: "gpt-4o", usage: { prompt_tokens: 7, completion_tokens: 3 } };
      },
    },
  };
}

/** Mistral-shaped. Its wrapper built the emit options AFTER its await, so it needed the
 * options hoisted as well as the resolution moved — worth its own coverage. */
class Mistral {
  _options = { apiKey: "sk-test" };
  chat = {
    complete: async () => {
      await sleep(20);
      return { model: "mistral-small-latest", usage: { prompt_tokens: 4, completion_tokens: 2 } };
    },
    stream: async () => {
      await sleep(20);
      return (async function* () {
        yield { data: { model: "mistral-small-latest", usage: { prompt_tokens: 4, completion_tokens: 2 } } };
      })();
    },
  };
}

/** Anthropic-shaped. Like OpenAI's, `create()` returns a thenable the wrapper proxies,
 * so the emit continuation runs in whatever context the CONSUMER awaits from. */
class Anthropic {
  messages = {
    create: async (params: Record<string, unknown>) => {
      await sleep(20);
      if (params.stream) {
        return (async function* () {
          yield {
            type: "message_start",
            message: { model: "claude-sonnet-4-6", usage: { input_tokens: 9, output_tokens: 1 } },
          };
          yield { type: "message_delta", usage: { output_tokens: 5 } };
        })();
      }
      return { model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 9, output_tokens: 5 } };
    },
  };
}

/** Gemini-shaped. */
class GoogleGenAI {
  models = {
    generateContentStream: async () => {
      await sleep(20);
      return (async function* () {
        yield {
          modelVersion: "gemini-2.5-flash",
          usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
        };
      })();
    },
  };
}

/** Bedrock-shaped, streaming only — the sync path builds its options before the await
 * and so was never affected. */
class ConverseStreamCommand {
  constructor(public input: { modelId: string }) {}
}
class BedrockRuntimeClient {
  config = { serviceId: "bedrock-runtime" };
  async send(_command: unknown) {
    await sleep(20);
    return {
      stream: (async function* () {
        yield { metadata: { usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } } };
      })(),
    };
  }
}

function newSdk(defaultSub: string | null = null) {
  const received: LagoEvent[] = [];
  const errors: string[] = [];
  const sdk = new LagoSDK({
    apiKey: "x",
    defaultSubscriptionId: defaultSub,
    config: { onError: (_e, where) => errors.push(where) },
  });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received, errors };
}

/** The distinct subscriptions the delivered events were billed to. */
const billedTo = (received: LagoEvent[]) =>
  [...new Set(received.map((e) => e.external_subscription_id))].sort();

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    /* consume */
  }
}

describe("withSubscription survives the result leaving its scope", () => {
  it("openai — a promise awaited outside the run is still billed to it", async () => {
    const { sdk, received, errors } = newSdk();
    const client = sdk.wrap(new OpenAI());
    let pending: Promise<unknown> | null = null;
    sdk.withSubscription("cust_await_outside", () => {
      pending = client.chat.completions.create({ model: "gpt-4o" }) as Promise<unknown>;
    });
    await pending!; // resolves well outside the run()
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_await_outside"]);
    expect(errors).toEqual([]);
  });

  it("openai — a stream consumed outside the run is still billed to it", async () => {
    // The worst of the two: a stream emits in the generator's `finally`, which runs
    // whenever the CONSUMER stops iterating — arbitrarily far from the call.
    const { sdk, received, errors } = newSdk();
    const client = sdk.wrap(new OpenAI());
    let handle: AsyncIterable<unknown> | null = null;
    await sdk.withSubscription("cust_stream_outside", async () => {
      handle = (await client.chat.completions.create({
        model: "gpt-4o",
        stream: true,
      })) as AsyncIterable<unknown>;
    });
    await drain(handle!);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_stream_outside"]);
    expect(errors).toEqual([]);
  });

  it("anthropic — a stream consumed outside the run is still billed to it", async () => {
    const { sdk, received, errors } = newSdk();
    const client = sdk.wrap(new Anthropic());
    let handle: AsyncIterable<unknown> | null = null;
    await sdk.withSubscription("cust_anthropic", async () => {
      handle = (await client.messages.create({
        model: "claude-sonnet-4-6",
        stream: true,
      })) as AsyncIterable<unknown>;
    });
    await drain(handle!);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_anthropic"]);
    expect(errors).toEqual([]);
  });

  it("gemini — a stream consumed outside the run is still billed to it", async () => {
    const { sdk, received, errors } = newSdk();
    const client = sdk.wrap(new GoogleGenAI());
    let handle: AsyncIterable<unknown> | null = null;
    await sdk.withSubscription("cust_gemini", async () => {
      handle = (await client.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: "hi",
      })) as AsyncIterable<unknown>;
    });
    await drain(handle!);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_gemini"]);
    expect(errors).toEqual([]);
  });

  it("bedrock — a stream consumed outside the run is still billed to it", async () => {
    const { sdk, received, errors } = newSdk();
    const client = sdk.wrap(new BedrockRuntimeClient());
    let handle: AsyncIterable<unknown> | null = null;
    await sdk.withSubscription("cust_bedrock", async () => {
      const resp = (await client.send(
        new ConverseStreamCommand({ modelId: "amazon.nova-lite-v1:0" }) as never,
      )) as { stream: AsyncIterable<unknown> };
      handle = resp.stream;
    });
    await drain(handle!);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_bedrock"]);
    expect(errors).toEqual([]);
  });

  it("mistral — chat.stream consumed outside the run", async () => {
    const { sdk, received, errors } = newSdk();
    const client = sdk.wrap(new Mistral());
    let handle: AsyncIterable<unknown> | null = null;
    await sdk.withSubscription("cust_mistral_stream", async () => {
      handle = (await client.chat.stream({
        model: "mistral-small-latest",
        messages: [],
      })) as AsyncIterable<unknown>;
    });
    await drain(handle!);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_mistral_stream"]);
    expect(errors).toEqual([]);
  });
});

describe("capturing at call time does not weaken what already worked", () => {
  // These pass on the old code too, and are here for that reason: resolving earlier
  // must not collapse concurrent scopes into one, override an explicit choice, or break
  // a path that was already correct. They guard the fix rather than pin the bug.

  it("mistral — chat.complete awaited outside the run (already worked)", async () => {
    // Worth its own case because it explains WHICH paths were broken and why. An `async`
    // function entered inside `run()` keeps the async-local store across its OWN awaits,
    // and `chat.complete`'s wrapper is one — so this path resolved correctly even though
    // it built its emit options after the await. The broken paths were the ones whose
    // emit continuation runs in the CONSUMER's context instead: every stream's `finally`,
    // and the thenable proxies OpenAI and Anthropic hand back.
    //
    // The fix hoisted `resolveOpts` above this wrapper's await to match its siblings.
    // This pins that the hoist did not change the answer.
    const { sdk, received, errors } = newSdk();
    const client = sdk.wrap(new Mistral());
    let pending: Promise<unknown> | null = null;
    sdk.withSubscription("cust_mistral", () => {
      pending = client.chat.complete({ model: "mistral-small-latest", messages: [] }) as Promise<unknown>;
    });
    await pending!;
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_mistral"]);
    expect(errors).toEqual([]);
  });

  it("two concurrent calls keep their own subscriptions across awaits", async () => {
    const { sdk, received } = newSdk();
    const client = sdk.wrap(new OpenAI());
    await Promise.all([
      sdk.withSubscription("cust_A", async () => {
        await client.chat.completions.create({ model: "gpt-4o" });
      }),
      sdk.withSubscription("cust_B", async () => {
        await client.chat.completions.create({ model: "gpt-4o" });
      }),
    ]);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_A", "cust_B"]);
    // Two events each (input + output), neither leaking into the other's scope.
    expect(received.filter((e) => e.external_subscription_id === "cust_A")).toHaveLength(2);
    expect(received.filter((e) => e.external_subscription_id === "cust_B")).toHaveLength(2);
  });

  it("a per-call lago.subscription still beats the async-local one", async () => {
    const { sdk, received } = newSdk("cust_default");
    const client = sdk.wrap(new OpenAI());
    await sdk.withSubscription("cust_ctx", async () => {
      await client.chat.completions.create({ model: "gpt-4o", lago: { subscription: "cust_call" } });
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_call"]);
  });

  it("falls back to the configured default when no scope is bound", async () => {
    const { sdk, received } = newSdk("cust_default");
    const client = sdk.wrap(new OpenAI());
    await client.chat.completions.create({ model: "gpt-4o" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(billedTo(received)).toEqual(["cust_default"]);
  });
});
