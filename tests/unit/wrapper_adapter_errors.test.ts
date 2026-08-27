/**
 * A provider whose response shape drifts must surface on `config.onError`.
 *
 * The adapter that parses a provider response runs inside the WRAPPER, which sat outside
 * the SDK's own error reporting. So when a provider changed a usage field, the wrapper
 * caught it, wrote a `console.warn`, and stopped — a total billing outage for that
 * provider, invisible on the channel customers actually watch. The streaming paths were
 * worse: they swallowed without even the log, so there was no signal anywhere at all.
 *
 * Measured on `main` with the drifted shape below: the non-streaming OpenAI path
 * produced 1 log line and 0 `onError` calls; the streaming path produced 0 and 0. Both
 * emitted nothing.
 *
 * Every case here asserts the same three things — no event billed, `onError` called
 * once, and the customer's own call still returning its value — because "never break the
 * customer's call" is the constraint that made silence tempting in the first place.
 */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

/**
 * A usage container that passes for an object until anything is read off it.
 *
 * This is what real drift looks like through a typed SDK: the field is gone, and the
 * access throws rather than returning undefined. Verified to make all six adapters throw
 * — each on a DIFFERENT field (`prompt_tokens_details`, `cache_creation`,
 * `additionalProperties`, `serverToolUsage`, …), which is why the trap is generic rather
 * than a per-provider fixture that would go stale as the adapters grow.
 */
function driftedUsage(): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      throw new TypeError(`provider drift: usage.${String(prop)} is gone`);
    },
    has: () => true,
    ownKeys: () => ["prompt_tokens"],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
}

interface Harness {
  sdk: LagoSDK;
  received: LagoEvent[];
  errors: Array<{ where: string; message: string }>;
}

function newSdk(): Harness {
  const received: LagoEvent[] = [];
  const errors: Array<{ where: string; message: string }> = [];
  const sdk = new LagoSDK({
    apiKey: "x",
    defaultSubscriptionId: "sub_test",
    config: {
      onError: (err, where) => errors.push({ where, message: (err as Error).message }),
    },
  });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received, errors };
}

/** Every case ends the same way: nothing billed, exactly one report, naming the stage. */
async function expectReported(h: Harness, where: string): Promise<void> {
  expect(await h.sdk.flush(2000)).toBe(true);
  await h.sdk.shutdown(1000);
  expect(h.received).toEqual([]);
  expect(h.errors.map((e) => e.where)).toEqual([where]);
  expect(h.errors[0].message).toMatch(/provider drift/);
}

async function drain(stream: AsyncIterable<unknown>): Promise<number> {
  let n = 0;
  for await (const _chunk of stream) n++;
  return n;
}

// ---------------------------------------------------------------------- openai
class OpenAI {
  baseURL = "https://api.openai.com/v1";
  chat = {
    completions: {
      create: async (params: Record<string, unknown>) => {
        if (params.stream) {
          return (async function* () {
            yield { choices: [{ delta: { content: "hi" } }] };
            yield { model: "gpt-4o", usage: driftedUsage() };
          })();
        }
        return { model: "gpt-4o", usage: driftedUsage() };
      },
    },
  };
}

// ------------------------------------------------------------------- anthropic
class Anthropic {
  messages = {
    create: async (params: Record<string, unknown>) => {
      if (params.stream) {
        return (async function* () {
          yield { type: "message_start", message: { model: "claude-sonnet-4-6", usage: driftedUsage() } };
          yield { type: "message_stop" };
        })();
      }
      return { model: "claude-sonnet-4-6", content: [], usage: driftedUsage() };
    },
  };
}

// --------------------------------------------------------------------- mistral
class Mistral {
  _options = { apiKey: "sk-test" };
  chat = {
    complete: async () => ({ model: "mistral-small-latest", usage: driftedUsage() }),
    stream: async () =>
      (async function* () {
        yield { data: { model: "mistral-small-latest", usage: driftedUsage() } };
      })(),
  };
}

// ---------------------------------------------------------------------- gemini
class GoogleGenAI {
  models = {
    generateContent: async () => ({ modelVersion: "gemini-2.5-flash", usageMetadata: driftedUsage() }),
    generateContentStream: async () =>
      (async function* () {
        yield { modelVersion: "gemini-2.5-flash", usageMetadata: driftedUsage() };
      })(),
  };
}

// --------------------------------------------------------------------- bedrock
class ConverseCommand {
  constructor(public input: { modelId: string }) {}
}
class ConverseStreamCommand {
  constructor(public input: { modelId: string }) {}
}
class InvokeModelWithResponseStreamCommand {
  constructor(public input: { modelId: string }) {}
}

class BedrockRuntimeClient {
  config = { serviceId: "bedrock-runtime" };
  async send(command: { constructor: { name: string } }) {
    switch (command.constructor.name) {
      case "ConverseCommand":
        return { usage: driftedUsage(), output: { message: { content: [] } } };
      case "ConverseStreamCommand":
        return {
          stream: (async function* () {
            yield { metadata: { usage: driftedUsage() } };
          })(),
        };
      default: {
        const enc = new TextEncoder();
        return {
          body: (async function* () {
            yield { chunk: { bytes: enc.encode(JSON.stringify({ usage: { input_tokens: 5 } })) } };
          })(),
        };
      }
    }
  }
}

describe("a drifted provider response reaches onError", () => {
  it("openai — chat.completions.create", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new OpenAI());
    const resp = (await client.chat.completions.create({ model: "gpt-4o" })) as { model: string };
    expect(resp.model).toBe("gpt-4o"); // the customer's call is untouched
    await expectReported(h, "adapter.openai");
  });

  it("openai — streaming chat.completions.create", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new OpenAI());
    const stream = (await client.chat.completions.create({
      model: "gpt-4o",
      stream: true,
    })) as AsyncIterable<unknown>;
    expect(await drain(stream)).toBe(2); // every chunk still reaches the caller
    await expectReported(h, "adapter.openai");
  });

  it("anthropic — messages.create", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new Anthropic());
    await client.messages.create({ model: "claude-sonnet-4-6" });
    await expectReported(h, "adapter.anthropic");
  });

  it("anthropic — streaming messages.create", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new Anthropic());
    const stream = (await client.messages.create({
      model: "claude-sonnet-4-6",
      stream: true,
    })) as AsyncIterable<unknown>;
    expect(await drain(stream)).toBe(2);
    await expectReported(h, "adapter.anthropic");
  });

  it("mistral — chat.complete", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new Mistral());
    await client.chat.complete({ model: "mistral-small-latest", messages: [] });
    await expectReported(h, "adapter.mistral");
  });

  it("mistral — chat.stream", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new Mistral());
    const stream = (await client.chat.stream({
      model: "mistral-small-latest",
      messages: [],
    })) as AsyncIterable<unknown>;
    expect(await drain(stream)).toBe(1);
    await expectReported(h, "adapter.mistral");
  });

  it("gemini — models.generateContent", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new GoogleGenAI());
    await client.models.generateContent({ model: "gemini-2.5-flash", contents: "hi" });
    await expectReported(h, "adapter.gemini");
  });

  it("gemini — models.generateContentStream", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new GoogleGenAI());
    const stream = (await client.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: "hi",
    })) as AsyncIterable<unknown>;
    expect(await drain(stream)).toBe(1);
    await expectReported(h, "adapter.gemini");
  });

  it("bedrock — ConverseCommand", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new BedrockRuntimeClient());
    await client.send(new ConverseCommand({ modelId: "amazon.nova-lite-v1:0" }) as never);
    // Bedrock extracts on the synchronous path inside `send`, so this one surfaces at
    // the wrapper boundary rather than in a stream's `finally`.
    await expectReported(h, "wrapper.bedrock");
  });

  it("bedrock — ConverseStreamCommand", async () => {
    const h = newSdk();
    const client = h.sdk.wrap(new BedrockRuntimeClient());
    const resp = (await client.send(
      new ConverseStreamCommand({ modelId: "amazon.nova-lite-v1:0" }) as never,
    )) as { stream: AsyncIterable<unknown> };
    expect(await drain(resp.stream)).toBe(1);
    await expectReported(h, "adapter.bedrock_converse");
  });
});
