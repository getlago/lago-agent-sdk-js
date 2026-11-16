/**
 * `reportError` is the wrappers' catch. It guarded `onError` and then logged with a
 * bare `console.warn`, so a logger that throws — a structured-logger shim, or a test
 * runner's "Cannot log after tests are done" — escaped the wrapper and rejected a call
 * the provider had already answered.
 */
import { describe, expect, it } from "vitest";

import { LagoSDK } from "../../src/index.js";

/** Throws on every property read, which is what a drifted provider response does. */
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

describe("reportError survives a throwing console.warn", () => {
  it("a wrapper that reports an error still resolves the customer's call", async () => {
    const result = { model: "mistral-small-latest", usage: driftedUsage() };
    class Mistral {
      _options = { apiKey: "sk-test" };
      chat = {
        complete: async () => result,
      };
    }

    const original = console.warn;
    console.warn = () => {
      throw new Error("Cannot log after tests are done");
    };
    const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: "sub_test" });
    sdk._setSender(async () => {});
    try {
      const client = sdk.wrap(new Mistral());
      const got = await client.chat.complete({ model: "mistral-small-latest", messages: [] });
      expect(got).toBe(result);
    } finally {
      console.warn = original;
      await sdk.shutdown(1000);
    }
  });
});
