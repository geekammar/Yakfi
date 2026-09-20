/**
 * Credential authenticated-encryption primitives
 * (WHATSAPP-ONBOARDING-01; DECISIONS #49).
 *
 * Server-only. This module converts a raw provider credential into a
 * versioned ciphertext package and back — it is the ONLY code that ever
 * holds the plaintext next to the master key, and it never persists,
 * logs, throws, or serializes either of them.
 *
 * Primitives:
 * - AES-256-GCM (an established authenticated-encryption primitive,
 *   available from Node's built-in `node:crypto` — no dependency added).
 * - a fresh 96-bit IV/nonce per credential (never reused);
 * - the 128-bit authentication tag is retained inside the blob, so
 *   tampering, truncation, or a wrong master key fails CLOSED at
 *   decryption (an authenticated failure, never a wrong plaintext).
 * - the blob is versioned (`v1:`) so a future key-rotation / primitive
 *   change is a new version, not a silent reinterpretation.
 *
 * Master key contract:
 * - comes from a server-only environment secret (`CREDENTIAL_MASTER_KEY`);
 * - is NEVER stored in the database, never returned by an API, never
 *   logged, and never included in an error message or serialized
 *   exception;
 * - must decode to EXACTLY 32 bytes (hex or base64). Anything else is a
 *   configuration error reported without echoing the value.
 *
 * Master-key rotation is a later OPERATIONAL concern: `key_version` on
 * the credential record is the hook, and this module deliberately does
 * not build key management, wrapping, or a KMS.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** The only algorithm this store accepts. */
export const CREDENTIAL_CIPHER_ALGORITHM = "AES-256-GCM";

/**
 * The lowercase primitive name passed to `node:crypto` (also the value
 * persisted as the record's safe `algorithm` metadata). Typed as a
 * literal so the `CipherGCM`/`DecipherGCM` overloads resolve and the
 * auth-tag accessors type-check.
 */
const CIPHER_PRIMITIVE = "aes-256-gcm";

/** The ciphertext package version this module writes. */
export const CREDENTIAL_CIPHER_VERSION = "v1";

/** Required master-key length in bytes (AES-256). */
const MASTER_KEY_BYTES = 32;

/** GCM nonce length (96 bits — the standard, and never reused). */
const IV_BYTES = 12;

/** GCM authentication tag length (128 bits). */
const AUTH_TAG_BYTES = 16;

/**
 * Decode a configured master key to exactly 32 bytes. Accepts hex (64
 * chars) or base64 (44 chars) — the two standard encodings of 32 random
 * bytes. NEVER returns the key to a caller; it only reports whether the
 * configured value is usable.
 */
export type MasterKeyResolution =
  | { ok: true; key: Buffer }
  | {
      ok: false;
      code: "MASTER_KEY_UNAVAILABLE" | "MASTER_KEY_INVALID";
      message: string;
    };

export function resolveMasterKey(
  configured: string | null | undefined,
): MasterKeyResolution {
  if (!configured || configured.trim().length === 0) {
    return {
      ok: false,
      code: "MASTER_KEY_UNAVAILABLE",
      message: "مفتاح تشفير بيانات الاعتماد غير مُهيأ",
    };
  }

  const trimmed = configured.trim();
  // Try hex first (the documented 64-char form), then base64. A value
  // that decodes to anything other than exactly 32 bytes is refused —
  // never padded, never truncated to fit.
  let decoded: Buffer | null = null;
  if (
    /^[0-9a-fA-F]+$/.test(trimmed) &&
    trimmed.length === MASTER_KEY_BYTES * 2
  ) {
    decoded = Buffer.from(trimmed, "hex");
  } else {
    try {
      const asBase64 = Buffer.from(trimmed, "base64");
      if (asBase64.length === MASTER_KEY_BYTES) decoded = asBase64;
    } catch {
      decoded = null;
    }
  }

  if (!decoded || decoded.length !== MASTER_KEY_BYTES) {
    return {
      ok: false,
      code: "MASTER_KEY_INVALID",
      // The value, its length, and its encoding are deliberately omitted.
      message: "مفتاح تشفير بيانات الاعتماد غير صالح",
    };
  }
  return { ok: true, key: decoded };
}

/**
 * Encrypt a credential. Throws ONLY a safe, credential-free error — the
 * plaintext and the key are never present in any thrown/serialized value.
 */
export function encryptCredential(
  masterKey: Buffer,
  plaintext: string,
): string {
  if (plaintext.length === 0) {
    throw new CredentialCryptoError("بيانات الاعتماد فارغة");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER_PRIMITIVE, masterKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    CREDENTIAL_CIPHER_VERSION,
    Buffer.concat([iv, ciphertext, authTag]).toString("base64"),
  ].join(":");
}

/**
 * Decrypt a credential package. A tag mismatch, a truncated blob, or an
 * unknown version is an authenticated failure reported WITHOUT the
 * plaintext — the caller never receives a partial or wrong secret.
 */
export function decryptCredential(masterKey: Buffer, blob: string): string {
  const separator = blob.indexOf(":");
  if (separator < 0) {
    throw new CredentialCryptoError("حزمة تشفير غير صالحة");
  }
  const version = blob.slice(0, separator);
  if (version !== CREDENTIAL_CIPHER_VERSION) {
    throw new CredentialCryptoError("إصدار تشفير غير مدعوم");
  }

  let packageBuffer: Buffer;
  try {
    packageBuffer = Buffer.from(blob.slice(separator + 1), "base64");
  } catch {
    throw new CredentialCryptoError("حزمة تشفير غير صالحة");
  }
  // Layout: iv (12) || ciphertext (>=1) || authTag (16).
  const minimumLength = IV_BYTES + AUTH_TAG_BYTES + 1;
  if (packageBuffer.length < minimumLength) {
    throw new CredentialCryptoError("حزمة تشفير غير صالحة");
  }
  const iv = packageBuffer.subarray(0, IV_BYTES);
  const authTag = packageBuffer.subarray(packageBuffer.length - AUTH_TAG_BYTES);
  const ciphertext = packageBuffer.subarray(
    IV_BYTES,
    packageBuffer.length - AUTH_TAG_BYTES,
  );

  try {
    const decipher = createDecipheriv(CIPHER_PRIMITIVE, masterKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM auth failure (tampered blob or wrong key). The plaintext is
    // never reconstructed and never reported.
    throw new CredentialCryptoError("فك التشفير فشل في التحقق");
  }
}

/**
 * The only error this module raises. Carries a safe Arabic message and
 * never the key, the blob, or the plaintext.
 */
export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}
