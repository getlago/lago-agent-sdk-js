/** LagoSDK — emit, subscription resolution, error policy. */
import { describe, expect, it } from "vitest";

import { LagoSDK, makeCanonicalUsage, UnknownClientError } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

function newSdk(defaultSub: string | null = "sub_default") {
  const received: LagoEvent[] = [];
  const sdk = new LagoSDK({ apiKey: "x", defaultSubscriptionId: defaultSub });
  sdk._setSender(async (batch) => {
    received.push(...batch);
  });
  return { sdk, received };
}

describe("LagoSDK.emit", () => {
  it("emits only non-zero numeric fields with correct codes", async () => {
    const { sdk, received } = newSdk();
    sdk.emit(makeCanonicalUsage({ input: 10, output: 20, model: "m", provider: "p", api: "x" }));
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code).sort()).toEqual(["llm_input_tokens", "llm_output_tokens"]);
    for (const e of received) expect(e.external_subscription_id).toBe("sub_default");
  });

  it("per-call subscription beats contextvar and default", async () => {
    const { sdk, received } = newSdk("sub_default");
    sdk.withSubscription("sub_ctx", () => {
      sdk.emit(makeCanonicalUsage({ input: 1, model: "m", provider: "p", api: "x" }), {
        subscription: "sub_call",
      });
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.external_subscription_id === "sub_call")).toBe(true);
  });

  it("contextvar (withSubscription) beats init default", async () => {
    const { sdk, received } = newSdk("sub_default");
    sdk.withSubscription("sub_ctx", () => {
      sdk.emit(makeCanonicalUsage({ input: 1, model: "m", provider: "p", api: "x" }));
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.external_subscription_id === "sub_ctx")).toBe(true);
  });

  it("drops events when no subscription resolvable", async () => {
    const { sdk, received } = newSdk(null);
    sdk.emit(makeCanonicalUsage({ input: 1, model: "m", provider: "p", api: "x" }));
    expect(await sdk.flush(500)).toBe(true);
    await sdk.shutdown(500);
    expect(received).toHaveLength(0);
  });

  it("dimensions merge into event properties", async () => {
    const { sdk, received } = newSdk();
    sdk.emit(makeCanonicalUsage({ input: 1, model: "m", provider: "p", api: "x" }), {
      dimensions: { project: "demo", tenant: "acme" },
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received[0].properties.project).toBe("demo");
    expect(received[0].properties.tenant).toBe("acme");
  });

  it("caller dimensions win on a collision, on both emitters", async () => {
    // One rule across both paths: a caller dimension overrides every
    // SDK-computed property of the same name. The cost path used to spread
    // dimensions into `baseProperties`, i.e. BEFORE
    // `unit`/`value`/`base_cost`/`unit_price`, so those four silently overwrote
    // a same-named caller dimension there while the token path honoured it —
    // same customer config, two different outcomes depending on the mode.
    const dimensions = { unit: "seat", value: "CUSTOM", model: "my-label", team: "platform" };
    const usage = makeCanonicalUsage({
      input: 100,
      output: 50,
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      api: "native",
    });

    const tok = newSdk();
    tok.sdk.emit(usage, { dimensions, mode: "tokens" });
    expect(await tok.sdk.flush(2000)).toBe(true);
    await tok.sdk.shutdown(1000);

    // Precomputed cost, so no price table is needed.
    const cost = newSdk();
    cost.sdk.emit(usage, { dimensions, mode: "price", usdCost: 0.01 });
    expect(await cost.sdk.flush(2000)).toBe(true);
    await cost.sdk.shutdown(1000);

    expect(tok.received.length).toBeGreaterThan(0);
    expect(cost.received.length).toBeGreaterThan(0);
    for (const [label, events] of [
      ["token", tok.received],
      ["cost", cost.received],
    ] as const) {
      for (const e of events) {
        expect(e.properties.unit, `${label}: caller unit must win`).toBe("seat");
        expect(e.properties.value, `${label}: caller value must win`).toBe("CUSTOM");
        expect(e.properties.model, `${label}: caller model must win`).toBe("my-label");
        expect(e.properties.team).toBe("platform");
      }
    }

    // The accepted consequence of that rule, pinned deliberately: a dimension
    // named `value` overrides the reported quantity. It cannot touch the charged
    // amount on a cost event, because `precise_total_amount_cents` is a sibling
    // of `properties`, not a member of it.
    expect(cost.received[0].precise_total_amount_cents).toBe("1");
  });

  it("unknown client at wrap() raises UnknownClientError", () => {
    const { sdk } = newSdk();
    expect(() => sdk.wrap({ foo: 1 })).toThrow(UnknownClientError);
  });

  it("emit never throws on internal failure", async () => {
    const { sdk } = newSdk();
    // Force the queue to throw on push by replacing the buffer with a Proxy.
    // Easier: pass a CanonicalUsage with a getter that throws during enumeration — not directly possible.
    // Instead, monkey-patch nonzero numeric to throw, ensure emit catches.
    sdk.emit(undefined as any);
    await sdk.shutdown(500);
  });
});

describe("LagoSDK async-isolation", () => {
  it("withSubscription doesn't leak across parallel async tasks", async () => {
    const { sdk, received } = newSdk(null);
    const task = (sub: string, n: number) =>
      sdk.withSubscription(sub, async () => {
        for (let i = 0; i < n; i++) {
          sdk.emit(makeCanonicalUsage({ input: 1, model: sub, provider: "p", api: "x" }));
          await new Promise((r) => setTimeout(r, 0));
        }
      });
    await Promise.all([task("sub_A", 10), task("sub_B", 10), task("sub_C", 10)]);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    const counts: Record<string, number> = {};
    for (const e of received) {
      counts[e.external_subscription_id] = (counts[e.external_subscription_id] ?? 0) + 1;
    }
    expect(counts).toEqual({ sub_A: 10, sub_B: 10, sub_C: 10 });
    // Each emit also sets the model field to the sub — no event landed under wrong sub
    for (const e of received) expect(e.properties.model).toBe(e.external_subscription_id);
  });
});
