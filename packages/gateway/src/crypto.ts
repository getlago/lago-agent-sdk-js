/** AES-256-GCM envelope encryption for BYOK provider keys.
 *
 * Blob format: v1:<iv b64>:<auth tag b64>:<ciphertext b64>. The master key
 * comes from env/KMS (GW_MASTER_KEY); plaintext provider keys exist only in
 * memory for the duration of a request and are never logged or echoed.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

export function encryptSecret(masterKey: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptSecret(masterKey: Buffer, blob: string): string {
  const [version, ivB64, tagB64, ctB64] = blob.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
    throw new Error("malformed secret blob");
  }
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Constant-time string comparison for bearer tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
