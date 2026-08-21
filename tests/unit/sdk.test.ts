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

  // Constructor precedence. `...(opts.config || {})` used to be spread LAST, so a
  // `config.apiUrl` overrode an explicitly passed `apiUrl` — the inverse of what
  // the Python port documents, so the same call billed a different Lago instance
  // depending on which SDK you used.
  it("config-only apiUrl survives", async () => {
    const sdk = new LagoSDK({ apiKey: "k", config: { apiUrl: "http://localhost:3000/api/v1" } });
    expect(sdk.config.apiUrl).toBe("http://localhost:3000/api/v1");
    await sdk.shutdown(1000);
  });

  it("explicit apiUrl wins over config", async () => {
    const sdk = new LagoSDK({
      apiKey: "k",
      apiUrl: "http://explicit:3000/api/v1",
      config: { apiUrl: "http://fromconfig:3000/api/v1" },
    });
    expect(sdk.config.apiUrl).toBe("http://explicit:3000/api/v1");
    await sdk.shutdown(1000);
  });

  it("default apiUrl is still production when nothing is passed", async () => {
    const sdk = new LagoSDK({ apiKey: "k" });
    expect(sdk.config.apiUrl).toBe("https://api.getlago.com/api/v1");
    await sdk.shutdown(1000);
  });

  it("verifySsl needs no config object", async () => {
    // A local Lago on a self-signed cert is reachable without building a config —
    // which is what pushed callers toward the clobber, since a custom apiUrl and
    // verifySsl:false go together.
    const sdk = new LagoSDK({ apiKey: "k", apiUrl: "https://api.lago.dev/api/v1", verifySsl: false });
    expect(sdk.config.verifySsl).toBe(false);
    await sdk.shutdown(1000);
  });

  it("explicit verifySsl wins over config", async () => {
    const sdk = new LagoSDK({ apiKey: "k", verifySsl: true, config: { verifySsl: false } });
    expect(sdk.config.verifySsl).toBe(true);
    await sdk.shutdown(1000);
  });

  it("an ignored usdCost is reported, not silently dropped", async () => {
    // A caller who supplies a real metered cost while the effective mode isn't
    // "price" had it discarded with no log and no onError — so a hand-rolled
    // backfill could bill token counts only and look successful.
    const errors: Array<[string, string]> = [];
    const received: LagoEvent[] = [];
    const sdk = new LagoSDK({
      apiKey: "x",
      defaultSubscriptionId: "sub",
      config: {
        pricingMode: "tokens",
        onError: (e: unknown, where: string) => errors.push([String(e), where]),
      },
    });
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    sdk.emit(makeCanonicalUsage({ input: 10, output: 5, model: "m", provider: "anthropic", api: "native" }), {
      usdCost: 0.0123,
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0][0]).toContain("usdCost");
    expect(errors[0][0]).toContain("0.0123");
    expect(errors[0][1]).toBe("pricing");
    // And the call is still billed as token counts — reporting must not drop events.
    expect(new Set(received.map((e) => e.code))).toEqual(new Set(["llm_input_tokens", "llm_output_tokens"]));
  });

  it("no usdCost in token mode reports nothing", async () => {
    const errors: unknown[] = [];
    const sdk = new LagoSDK({
      apiKey: "x",
      defaultSubscriptionId: "sub",
      config: { pricingMode: "tokens", onError: (e: unknown) => errors.push(e) },
    });
    sdk._setSender(async () => {});
    sdk.emit(makeCanonicalUsage({ input: 10, output: 5, model: "m", provider: "anthropic", api: "native" }));
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(errors).toEqual([]);
  });

  it("an explicit usdCost: null is not billed as $0.00", async () => {
    // `!== undefined` alone let an explicit null into the precomputed branch, where
    // `parseScaled(null) ?? 0n` billed the call at $0.00 — while Python's
    // `usd_cost is not None` treated the same input as "not supplied" and priced it
    // normally. Any nullable-column or deserialized-payload caller under-billed in
    // JS only. With a cold table it must now take the lookup path and fall back to
    // token events, never push a zero-cost llm_cost event.
    const errors: unknown[] = [];
    const received: LagoEvent[] = [];
    const sdk = new LagoSDK({
      apiKey: "x",
      defaultSubscriptionId: "sub",
      config: { pricingMode: "price", onError: (e: unknown) => errors.push(e) },
    });
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    sdk.emit(
      makeCanonicalUsage({
        input: 10,
        output: 5,
        model: "nope-no-such-model",
        provider: "anthropic",
        api: "native",
      }),
      { usdCost: null as unknown as number },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    expect(received.some((e) => e.code === "llm_cost")).toBe(false);
    expect(new Set(received.map((e) => e.code))).toEqual(new Set(["llm_input_tokens", "llm_output_tokens"]));
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

// --------------------------------------------------------------------------
// Event time — a backfill must bill into the period the usage happened in
// --------------------------------------------------------------------------
describe("LagoSDK.emit — event time", () => {
  it("stamps the given instant on every event, not now", async () => {
    // Without this, a replay of last week's logs billed every call into the period
    // the script happened to run in, and nothing in Lago could tell afterwards.
    const { sdk, received } = newSdk("sub");
    const when = new Date(Date.UTC(2026, 7, 7, 14, 22, 3));
    sdk.emit(makeCanonicalUsage({ input: 10, output: 20, model: "m", provider: "p", api: "x" }), {
      timestamp: when,
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.length).toBe(2);
    // One instant for the whole call: Lago sums these into a period, so a call must
    // never straddle two of them because two clock reads disagreed.
    expect(new Set(received.map((e) => e.timestamp))).toEqual(new Set([when.getTime() / 1000]));
  });

  it("stamps a cost event too", async () => {
    // The cost path reads its own clock, so it needed threading separately from the
    // token path — and a backfill of BYOK spend goes down this one.
    const { sdk, received } = newSdk("sub");
    const when = new Date(Date.UTC(2026, 7, 7, 14, 0, 0));
    sdk.emit(
      makeCanonicalUsage({ input: 10, output: 20, model: "m", provider: "anthropic", api: "native" }),
      {
        mode: "price",
        usdCost: 0.0011187,
        timestamp: when,
      },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.map((e) => e.code)).toEqual(["llm_cost"]);
    expect(received[0].timestamp).toBe(when.getTime() / 1000);
  });

  it("accepts epoch seconds", async () => {
    const { sdk, received } = newSdk("sub");
    const u = makeCanonicalUsage({ input: 1, model: "m", provider: "p", api: "x" });
    sdk.emit(u, { timestamp: 1786112523 });
    // A fractional value is what dividing a millisecond clock hands back, so it must
    // not be refused.
    sdk.emit(u, { timestamp: 1786112523.987 });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(new Set(received.map((e) => e.timestamp))).toEqual(new Set([1786112523]));
  });

  it("reports an unreadable timestamp and still bills", async () => {
    // Never silently under-bill: a bad timestamp is a reconciliation problem the
    // operator can see and fix, while dropping the event is revenue that never
    // appears. An ISO string is the likely mistake, and is deliberately not accepted
    // — the Python port's `fromisoformat` rejects the trailing "Z" on 3.10, so a
    // string would parse in one repo and fail in the other.
    const errors: Array<[string, string]> = [];
    const received: LagoEvent[] = [];
    const sdk = new LagoSDK({
      apiKey: "x",
      defaultSubscriptionId: "sub",
      config: { onError: (e: unknown, where: string) => errors.push([String(e), where]) },
    });
    sdk._setSender(async (b) => {
      received.push(...b);
    });
    const before = Math.floor(Date.now() / 1000);
    sdk.emit(makeCanonicalUsage({ input: 1, model: "m", provider: "p", api: "x" }), {
      timestamp: "2026-08-07Z" as unknown as Date,
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0][0]).toContain("2026-08-07Z");
    expect(errors[0][1]).toBe("timestamp");
    // ...and the call is still billed, at now.
    expect(received.length).toBe(1);
    expect(received[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(received[0].timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("refuses a numeric string rather than coercing it", async () => {
    // `Number("1786112523")` would sail through where the Python port's `isinstance`
    // check rejects it — the same input must not bill in one repo and report in the
    // other.
    const errors: Array<[string, string]> = [];
    const sdk = new LagoSDK({
      apiKey: "x",
      defaultSubscriptionId: "sub",
      config: { onError: (e: unknown, where: string) => errors.push([String(e), where]) },
    });
    sdk._setSender(async () => {});
    sdk.emit(makeCanonicalUsage({ input: 1, model: "m", provider: "p", api: "x" }), {
      timestamp: "1786112523" as unknown as number,
    });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(errors.map(([, where]) => where)).toEqual(["timestamp"]);
  });

  it("stamps now when no timestamp is given", async () => {
    // The live `wrap()` path passes nothing and must be unchanged by all of this.
    const { sdk, received } = newSdk("sub");
    const before = Math.floor(Date.now() / 1000);
    sdk.emit(makeCanonicalUsage({ input: 1, model: "m", provider: "p", api: "x" }));
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(received[0].timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });
});
