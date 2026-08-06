/**
 * LagoClient — verifySsl passthrough.
 *
 * A local dev Lago instance behind a self-signed certificate is a real,
 * common setup; the only alternative without this flag is routing every
 * request through a public tunnel purely to get a browser-trusted cert.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeConfig } from "../../src/config.js";
import { LagoClient } from "../../src/lago_client.js";
import { LagoSDK } from "../../src/sdk.js";

describe("LagoClient.verifySsl", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("defaults to true and passes no dispatcher to fetch", async () => {
    const client = new LagoClient("k", "https://api.getlago.com/api/v1");
    expect(client.verifySsl).toBe(true);
    await client.sendBatch([
      { transaction_id: "t1", external_subscription_id: "s", code: "c", timestamp: 0, properties: {} },
    ]);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(opts.dispatcher).toBeUndefined();
  });

  it("verifySsl=false threads an insecure dispatcher through to fetch", async () => {
    const client = new LagoClient("k", "https://api.lago.dev/api/v1", 10_000, false);
    expect(client.verifySsl).toBe(false);
    await client.sendBatch([
      { transaction_id: "t1", external_subscription_id: "s", code: "c", timestamp: 0, properties: {} },
    ]);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit & { dispatcher?: unknown };
    expect(opts.dispatcher).toBeDefined();
  });
});

describe("LagoConfig.verifySsl", () => {
  it("defaults to true", () => {
    expect(makeConfig({ apiKey: "k" }).verifySsl).toBe(true);
  });
});

describe("LagoSDK threads verifySsl from config to its internal client", () => {
  it("false in config -> false on the internal client", async () => {
    const sdk = new LagoSDK({ apiKey: "k", config: { verifySsl: false } });
    try {
      // @ts-expect-error — touch private field for test inspection
      expect((sdk.client as LagoClient).verifySsl).toBe(false);
    } finally {
      await sdk.shutdown(1000);
    }
  });

  it("default config -> verifySsl stays true on the internal client", async () => {
    const sdk = new LagoSDK({ apiKey: "k" });
    try {
      // @ts-expect-error — touch private field for test inspection
      expect((sdk.client as LagoClient).verifySsl).toBe(true);
    } finally {
      await sdk.shutdown(1000);
    }
  });
});
