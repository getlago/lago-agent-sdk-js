/** Gemini wrapper tests — fake client, no live API. */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

class FakeModels {
  generateCalls = 0;
  streamCalls = 0;

  async generateContent(args: any) {
    this.generateCalls++;
    expect("lago" in (args || {})).toBe(false);
    return {
      model_version: args?.model ?? "gemini-2.5-flash",
      candidates: [{ content: { parts: [{ text: "hi" }] }, finish_reason: "STOP" }],
      usage_metadata: {
        prompt_token_count: 7,
        candidates_token_count: 23,
        thoughts_token_count: 0,
        total_token_count: 30,
      },
    };
  }

  async generateContentStream(args: any) {
    this.streamCalls++;
    expect("lago" in (args || {})).toBe(false);
    const chunks = [
      {
        candidates: [{ content: { parts: [{ text: "hi" }] } }],
        usage_metadata: null,
      },
      {
        candidates: [{ content: { parts: [{ text: "." }] }, finish_reason: "STOP" }],
        usage_metadata: {
          prompt_token_count: 9,
          candidates_token_count: 4,
          thoughts_token_count: 0,
          total_token_count: 13,
        },
      },
    ];
    return (async function* () {
      for (const c of chunks) yield c;
    })();
  }
}

class FakeGoogleGenAI {
  models = new FakeModels();
}
// Detector keys on the constructor name; "GoogleGenAI" matches.
Object.defineProperty(FakeGoogleGenAI, "name", { value: "GoogleGenAI" });

function newSdk(defaultSub = "sub_test") {
  const received: LagoEvent[] = [];
  const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: defaultSub });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received };
}

describe("Gemini wrapper", () => {
  it("models.generateContent emits llm_input_tokens + llm_output_tokens", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeGoogleGenAI();
    const client = sdk.wrap(fake);
    const resp = (await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "hi",
    } as any)) as any;
    expect(resp.usage_metadata.prompt_token_count).toBe(7);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(7);
    expect(map.llm_output_tokens).toBe(23);
  });

  it("strips inline lago options + applies per-call subscription", async () => {
    const { sdk, received } = newSdk("sub_default");
    const fake = new FakeGoogleGenAI();
    const client = sdk.wrap(fake);
    await client.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "hi",
      lago: { subscription: "sub_per_call", dimensions: { feature: "X" } },
    } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.external_subscription_id === "sub_per_call")).toBe(true);
    expect(received[0].properties.feature).toBe("X");
  });

  it("double-wrap is idempotent — emit once per call", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeGoogleGenAI();
    sdk.wrap(fake);
    sdk.wrap(fake);
    sdk.wrap(fake);
    await fake.models.generateContent({ model: "gemini-2.5-flash", contents: "hi" });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received).toHaveLength(2); // input + output, not 6
    expect(fake.models.generateCalls).toBe(1);
  });

  it("generateContentStream captures usage from final chunk", async () => {
    const { sdk, received } = newSdk();
    const fake = new FakeGoogleGenAI();
    const client = sdk.wrap(fake);
    const stream = (await client.models.generateContentStream({
      model: "gemini-2.5-flash",
      contents: "hi",
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

  it("thinking mode emits llm_reasoning_tokens separately", async () => {
    const { sdk, received } = newSdk();
    class ThinkingModels {
      async generateContent(_args: any) {
        return {
          usage_metadata: {
            prompt_token_count: 10,
            candidates_token_count: 50,
            thoughts_token_count: 200,
          },
        };
      }
    }
    class ThinkingClient {
      models = new ThinkingModels();
    }
    Object.defineProperty(ThinkingClient, "name", { value: "GoogleGenAI" });

    const client = sdk.wrap(new ThinkingClient() as any);
    await client.models.generateContent({ model: "gemini-2.5-flash", contents: "hi" } as any);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const map = Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
    expect(map.llm_input_tokens).toBe(10);
    expect(map.llm_output_tokens).toBe(50);
    expect(map.llm_reasoning_tokens).toBe(200);
  });

  it("instrumentation failure does not break the call", async () => {
    const { sdk } = newSdk();
    class BadModels {
      async generateContent(_args: any) {
        return {
          get usage_metadata(): any {
            throw new Error("boom");
          },
        };
      }
    }
    class BadClient {
      models = new BadModels();
    }
    Object.defineProperty(BadClient, "name", { value: "GoogleGenAI" });

    const client = sdk.wrap(new BadClient() as any);
    const resp = await client.models.generateContent({ model: "x", contents: "hi" });
    expect(resp).toBeDefined();
    await sdk.shutdown(500);
  });
});
