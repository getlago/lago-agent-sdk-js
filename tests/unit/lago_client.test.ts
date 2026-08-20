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

  // undici is imported lazily so this package can load in a runtime that has global
  // fetch but not Node's socket internals — a Worker, an edge function, a browser
  // bundle. A value import at module scope foreclosed that for a flag most consumers
  // never set, which matters because the headline gateway connector here is Cloudflare.
  it("verifySsl=true never constructs the undici Agent at all", async () => {
    const client = new LagoClient("k", "https://api.getlago.com/api/v1", 10_000, true);
    await client.sendBatch([
      { transaction_id: "t1", external_subscription_id: "s", code: "c", timestamp: 0, properties: {} },
    ]);
    expect((client as unknown as { insecureAgent?: unknown }).insecureAgent).toBeUndefined();
    await client.close(); // must tolerate never having built one
  });

  it("verifySsl=false builds the Agent on first send, not in the constructor", async () => {
    const client = new LagoClient("k", "https://api.lago.dev/api/v1", 10_000, false);
    const peek = client as unknown as { insecureAgent?: unknown };
    expect(peek.insecureAgent).toBeUndefined(); // constructor cannot await, and must not import
    await client.sendBatch([
      { transaction_id: "t1", external_subscription_id: "s", code: "c", timestamp: 0, properties: {} },
    ]);
    expect(peek.insecureAgent).toBeDefined();
    await client.close();
    expect(peek.insecureAgent).toBeUndefined();
  });

  it("concurrent first sends share ONE Agent", async () => {
    // Memoized on the promise, not the agent — otherwise a burst of first sends each
    // builds its own connection pool and only the last one is ever released.
    const client = new LagoClient("k", "https://api.lago.dev/api/v1", 10_000, false);
    const ev = {
      transaction_id: "t1",
      external_subscription_id: "s",
      code: "c",
      timestamp: 0,
      properties: {},
    };
    await Promise.all([client.sendBatch([ev]), client.sendBatch([ev]), client.sendBatch([ev])]);
    const dispatchers = fetchSpy.mock.calls.map(
      (c) => (c[1] as RequestInit & { dispatcher?: unknown }).dispatcher,
    );
    expect(new Set(dispatchers).size).toBe(1);
    await client.close();
  });
});

describe("undici is not a load-time dependency", () => {
  it("is declared optional, not required", async () => {
    // The packaging half of the lazy import: a bundler for a non-Node target has to be
    // able to leave undici out entirely.
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies?.undici).toBeUndefined();
    expect(pkg.optionalDependencies?.undici).toBeDefined();
  });

  it("src/lago_client.ts imports undici as a TYPE only", async () => {
    // `import type` is erased by tsc, so the emitted JS carries no top-level require.
    // Asserted on source rather than dist so it fails in CI before a build exists.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/lago_client.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import type \{ Agent \} from "undici"/);
    expect(src).not.toMatch(/^import \{ Agent \} from "undici"/m);
    expect(src).toMatch(/await import\("undici"\)|import\("undici"\)/);
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
