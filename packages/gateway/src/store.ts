/** Key store: virtual keys and BYOK provider keys, SQLite-backed.
 *
 * Virtual keys are `lago_vk_` + 256 bits of randomness. Only the SHA-256 hash
 * is stored; the plaintext is returned exactly once, at creation. Revocation
 * is a row delete. Provider keys are stored as AES-256-GCM ciphertext only
 * and are write-only through the admin surface.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { decryptSecret, encryptSecret } from "./crypto.js";

export interface BudgetPolicy {
  /** Cap in USD for the subscription's current period. Omit for uncapped. */
  limit_usd?: number;
  /** Lago unreachable: strict keys fail closed; default keys fail open. */
  strict?: boolean;
}

export interface VirtualKeyRecord {
  id: string;
  external_subscription_id: string;
  external_customer_id: string | null;
  allowed_models: string[] | null;
  budget: BudgetPolicy | null;
  provider_key_ref: string | null;
  /** Optional Bifrost governance virtual key (sk-bf-*) forwarded as x-bf-vk
   * so the proxy's per-key rate limits apply to this Lago key. */
  bifrost_vk: string | null;
  created_at: number;
}

export interface CreateKeyInput {
  external_subscription_id: string;
  external_customer_id?: string;
  allowed_models?: string[];
  budget?: BudgetPolicy;
  provider_key_ref?: string;
  bifrost_vk?: string;
}

export class KeyStore {
  private db: DatabaseSync;

  constructor(
    path: string,
    private masterKey: Buffer,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS virtual_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        external_subscription_id TEXT NOT NULL,
        external_customer_id TEXT,
        allowed_models TEXT,
        budget TEXT,
        provider_key_ref TEXT,
        bifrost_vk TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_keys (
        ref TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  /** Returns the plaintext key exactly once. Only its hash is stored. */
  createVirtualKey(input: CreateKeyInput): { key: string; record: VirtualKeyRecord } {
    const key = `lago_vk_${randomBytes(32).toString("base64url")}`;
    const hash = sha256(key);
    const id = `vk_${hash.slice(0, 16)}`;
    const record: VirtualKeyRecord = {
      id,
      external_subscription_id: input.external_subscription_id,
      external_customer_id: input.external_customer_id ?? null,
      allowed_models: input.allowed_models ?? null,
      budget: input.budget ?? null,
      provider_key_ref: input.provider_key_ref ?? null,
      bifrost_vk: input.bifrost_vk ?? null,
      created_at: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO virtual_keys
         (id, key_hash, external_subscription_id, external_customer_id, allowed_models, budget, provider_key_ref, bifrost_vk, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        hash,
        record.external_subscription_id,
        record.external_customer_id,
        record.allowed_models ? JSON.stringify(record.allowed_models) : null,
        record.budget ? JSON.stringify(record.budget) : null,
        record.provider_key_ref,
        record.bifrost_vk,
        record.created_at,
      );
    return { key, record };
  }

  /** Hash lookup. Returns null for unknown or revoked keys. */
  resolveVirtualKey(plaintextKey: string): VirtualKeyRecord | null {
    if (!plaintextKey.startsWith("lago_vk_")) return null;
    const row = this.db
      .prepare(
        `SELECT id, external_subscription_id, external_customer_id, allowed_models, budget, provider_key_ref, bifrost_vk, created_at
         FROM virtual_keys WHERE key_hash = ?`,
      )
      .get(sha256(plaintextKey)) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      external_subscription_id: String(row.external_subscription_id),
      external_customer_id: row.external_customer_id == null ? null : String(row.external_customer_id),
      allowed_models:
        row.allowed_models == null ? null : (JSON.parse(String(row.allowed_models)) as string[]),
      budget: row.budget == null ? null : (JSON.parse(String(row.budget)) as BudgetPolicy),
      provider_key_ref: row.provider_key_ref == null ? null : String(row.provider_key_ref),
      bifrost_vk: row.bifrost_vk == null ? null : String(row.bifrost_vk),
      created_at: Number(row.created_at),
    };
  }

  /** Revocation = row delete. Subsequent resolves return null. */
  revokeVirtualKey(id: string): boolean {
    const res = this.db.prepare("DELETE FROM virtual_keys WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  listVirtualKeys(): VirtualKeyRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, external_subscription_id, external_customer_id, allowed_models, budget, provider_key_ref, bifrost_vk, created_at
         FROM virtual_keys ORDER BY created_at`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      external_subscription_id: String(row.external_subscription_id),
      external_customer_id: row.external_customer_id == null ? null : String(row.external_customer_id),
      allowed_models:
        row.allowed_models == null ? null : (JSON.parse(String(row.allowed_models)) as string[]),
      budget: row.budget == null ? null : (JSON.parse(String(row.budget)) as BudgetPolicy),
      provider_key_ref: row.provider_key_ref == null ? null : String(row.provider_key_ref),
      bifrost_vk: row.bifrost_vk == null ? null : String(row.bifrost_vk),
      created_at: Number(row.created_at),
    }));
  }

  /** Write-only from the admin surface; the plaintext is never readable back. */
  setProviderKey(ref: string, provider: string, plaintextKey: string): void {
    this.db
      .prepare(
        `INSERT INTO provider_keys (ref, provider, ciphertext, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET provider = excluded.provider, ciphertext = excluded.ciphertext`,
      )
      .run(ref, provider, encryptSecret(this.masterKey, plaintextKey), Date.now());
  }

  /** Internal use on the request path only. Never logged, never echoed. */
  getProviderKey(ref: string): { provider: string; key: string } | null {
    const row = this.db.prepare("SELECT provider, ciphertext FROM provider_keys WHERE ref = ?").get(ref) as
      { provider: string; ciphertext: string } | undefined;
    if (!row) return null;
    return { provider: row.provider, key: decryptSecret(this.masterKey, row.ciphertext) };
  }

  deleteProviderKey(ref: string): boolean {
    const res = this.db.prepare("DELETE FROM provider_keys WHERE ref = ?").run(ref);
    return Number(res.changes) > 0;
  }

  /** Tests-only: raw stored rows, to prove hashing/encryption at rest. */
  _rawRows(table: "virtual_keys" | "provider_keys"): Array<Record<string, unknown>> {
    return this.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  }

  close(): void {
    this.db.close();
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
