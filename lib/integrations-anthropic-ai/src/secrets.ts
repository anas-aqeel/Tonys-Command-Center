// AES-256-GCM encryption for stored provider API keys.
// Master key is read from SETTINGS_ENCRYPTION_KEY env var (32-byte hex string,
// 64 hex chars). Each ciphertext stores its own random 12-byte IV plus the
// 16-byte GCM auth tag.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

let _masterKey: Buffer | null = null;
function getMasterKey(): Buffer {
  if (_masterKey) return _masterKey;
  const k = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!k) {
    throw new Error(
      "SETTINGS_ENCRYPTION_KEY env var is required to encrypt/decrypt provider API keys. " +
      "Generate one with: openssl rand -hex 32",
    );
  }
  if (k.length !== 64 || !/^[0-9a-fA-F]+$/.test(k)) {
    throw new Error("SETTINGS_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  }
  _masterKey = Buffer.from(k, "hex");
  return _masterKey;
}

export interface EncryptedSecret {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptKey(plaintext: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { cipher: ct, iv, tag: cipher.getAuthTag() };
}

export function decryptKey(blob: EncryptedSecret): string {
  const decipher = createDecipheriv(ALGO, getMasterKey(), blob.iv);
  decipher.setAuthTag(blob.tag);
  return Buffer.concat([decipher.update(blob.cipher), decipher.final()]).toString("utf8");
}

// Convenience: returns true when the encryption key is configured (so the
// settings UI can skip re-encrypting unchanged values silently).
export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.SETTINGS_ENCRYPTION_KEY);
}

// ─── Single-column packed format (iv_b64:tag_b64:cipher_b64) ────────────────
// Used by agent_skills.api_key_cipher (a plain `text` column) so we don't have
// to add three bytea columns just to mirror ai_provider_settings. The packed
// blob still goes through encryptKey/decryptKey — same algo, same master key.

/** Encrypt a plaintext API key into a single colon-separated base64 blob. */
export function encryptKeyToString(plaintext: string): string {
  const enc = encryptKey(plaintext);
  return [
    enc.iv.toString("base64"),
    enc.tag.toString("base64"),
    enc.cipher.toString("base64"),
  ].join(":");
}

/** Decrypt a colon-separated base64 blob produced by encryptKeyToString. */
export function decryptKeyFromString(blob: string): string {
  const parts = blob.split(":");
  if (parts.length !== 3) {
    throw new Error("decryptKeyFromString: expected iv:tag:cipher base64 blob");
  }
  return decryptKey({
    iv: Buffer.from(parts[0], "base64"),
    tag: Buffer.from(parts[1], "base64"),
    cipher: Buffer.from(parts[2], "base64"),
  });
}
