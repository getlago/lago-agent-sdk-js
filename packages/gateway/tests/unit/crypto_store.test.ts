import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, safeEqual } from "../../src/crypto.js";
import { KeyStore } from "../../src/store.js";

describe("crypto", () => {
  const master = randomBytes(32);

  it("round-trips a secret", () => {
    const blob = encryptSecret(master, "sk-super-secret-provider-key");
    expect(blob.startsWith("v1:")).toBe(true);
    expect(blob).not.toContain("sk-super-secret");
    expect(decryptSecret(master, blob)).toBe("sk-super-secret-provider-key");
  });

  it("rejects tampered ciphertext and wrong keys", () => {
    const blob = encryptSecret(master, "payload");
    const parts = blob.split(":");
    const tampered = [parts[0], parts[1], parts[2], Buffer.from("xxxx").toString("base64")].join(":");
    expect(() => decryptSecret(master, tampered)).toThrow();
    expect(() => decryptSecret(randomBytes(32), blob)).toThrow();
  });

  it("safeEqual compares without throwing on length mismatch", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("KeyStore", () => {
  let dir: string;
  let store: KeyStore;
  const master = randomBytes(32);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keys-"));
    store = new KeyStore(join(dir, "keys.db"), master);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates keys with lago_vk_ prefix and 256-bit entropy, resolves by hash", () => {
    const { key, record } = store.createVirtualKey({
      external_subscription_id: "sub_acme",
      external_customer_id: "cust_acme",
      allowed_models: ["openai/*"],
      budget: { limit_usd: 100, strict: true },
    });
    expect(key.startsWith("lago_vk_")).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual("lago_vk_".length + 43); // 32 bytes base64url
    const resolved = store.resolveVirtualKey(key);
    expect(resolved).not.toBeNull();
    expect(resolved!.external_subscription_id).toBe("sub_acme");
    expect(resolved!.budget).toEqual({ limit_usd: 100, strict: true });
    expect(resolved!.id).toBe(record.id);
  });

  it("stores only the hash: plaintext key appears nowhere at rest", () => {
    const { key } = store.createVirtualKey({ external_subscription_id: "sub_1" });
    for (const row of store._rawRows("virtual_keys")) {
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain(key.slice("lago_vk_".length));
    }
  });

  it("revocation is immediate and permanent", () => {
    const { key, record } = store.createVirtualKey({ external_subscription_id: "sub_1" });
    expect(store.resolveVirtualKey(key)).not.toBeNull();
    expect(store.revokeVirtualKey(record.id)).toBe(true);
    expect(store.resolveVirtualKey(key)).toBeNull();
    expect(store.revokeVirtualKey(record.id)).toBe(false);
  });

  it("provider keys are ciphertext-only at rest and decrypt on demand", () => {
    store.setProviderKey("acme-openai", "openai", "sk-tenant-key-123");
    for (const row of store._rawRows("provider_keys")) {
      expect(JSON.stringify(row)).not.toContain("sk-tenant-key-123");
    }
    expect(store.getProviderKey("acme-openai")).toEqual({ provider: "openai", key: "sk-tenant-key-123" });
    expect(store.deleteProviderKey("acme-openai")).toBe(true);
    expect(store.getProviderKey("acme-openai")).toBeNull();
  });

  it("rejects non-lago_vk tokens without touching the database", () => {
    expect(store.resolveVirtualKey("sk-not-a-virtual-key")).toBeNull();
  });
});
