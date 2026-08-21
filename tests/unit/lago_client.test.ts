/**
 * LagoClient — verifySsl passthrough.
 *
 * A local dev Lago instance behind a self-signed certificate is a real,
 * common setup; the only alternative without this flag is routing every
 * request through a public tunnel purely to get a browser-trusted cert.
 */
import { readFileSync } from "node:fs";

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

// ----------------------------------------------------------------------
// `undici` is needed only for verifySsl:false, so it must not be a load-time
// requirement: a static import makes the whole SDK unloadable wherever the package
// cannot be resolved — a non-Node runtime (Workers, edge, a browser bundle) where
// global `fetch` alone is enough.
// ----------------------------------------------------------------------
describe("undici is an optional, lazily-imported dependency", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("is never imported at module load", () => {
    const src = readFileSync(new URL("../../src/lago_client.ts", import.meta.url), "utf8");
    // A static VALUE import is the thing that must not exist; `import type` is erased
    // at compile time and so costs nothing at runtime.
    expect(src).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+"undici"/m);
    expect(src).toMatch(/^\s*import\s+type\s+\{[^}]*\}\s+from\s+"undici"/m);
    expect(src).toContain('import("undici")');
  });

  it("is not a hard dependency of the published package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies?.undici).toBeUndefined();
    expect(pkg.peerDependenciesMeta?.undici?.optional).toBe(true);
  });

  it("builds the agent only on the first verifySsl:false send, and reuses it", async () => {
    const client = new LagoClient("k", "https://api.lago.dev/api/v1", 10_000, false);
    // @ts-expect-error — private: nothing imported yet, purely from the constructor.
    expect(client.insecureAgent).toBeUndefined();
    const send = async () =>
      client.sendBatch([
        { transaction_id: "t1", external_subscription_id: "s", code: "c", timestamp: 0, properties: {} },
      ]);
    await send();
    // @ts-expect-error — private
    const first = client.insecureAgent;
    expect(first).toBeDefined();
    await send();
    // @ts-expect-error — private
    expect(client.insecureAgent).toBe(first);
  });
});
