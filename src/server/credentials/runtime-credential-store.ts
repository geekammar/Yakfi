/**
 * RUNTIME credential store — the secret backend for the `fp:<id>`
 * reference grammar (WHATSAPP-ONBOARDING-01; DECISIONS #49).
 *
 * Server-only infrastructure. This is the ONE place that knows HOW a
 * runtime secret is stored; everything above it sees only the opaque
 * reference:
 *
 *   Feature / Adapter ──stores──▶ CredentialsResolver
 *        │                              │
 *        │                              ▼
 *        │                      RuntimeCredentialStore
 *        │                              │
 *        │                              ▼
 *        └─ reference only        Postgres + AES-256-GCM
 *                                  (ciphertext only in the DB)
 *
 * Storage: existing Neon Postgres (the smallest production-capable
 * backend already provisioned for this project — no new vendor, no new
 * billing, no new deployment dependency). Raw credentials are encrypted
 * APPLICATION-SIDE before any write, so the table, its query logs, and
 * every projection can only ever contain ciphertext.
 *
 * Failure model (fail closed, and never echo the secret):
 * - an unset/malformed master key ⇒ the store is UNAVAILABLE: stores and
 *   resolves are refused; the existing ENV grammar is unaffected;
 * - a missing/unknown reference ⇒ CREDENTIAL_UNAVAILABLE;
 * - a tampered blob or a wrong master key ⇒ a GCM authentication failure
 *   ⇒ CREDENTIAL_UNAVAILABLE (never a wrong plaintext, never the value);
 * - an unsupported/invalid reference shape ⇒ INVALID_REFERENCE;
 * - errors identify the PROBLEM, never the credential.
 */

import { isRuntimeCredentialReference } from "@/lib/validation";
import {
  CREDENTIAL_CIPHER_ALGORITHM,
  CREDENTIAL_CIPHER_VERSION,
  CredentialCryptoError,
  decryptCredential,
  encryptCredential,
  resolveMasterKey,
} from "@/server/credentials/credential-crypto";
import type { RuntimeCredentialRepository } from "@/server/repositories";
import { runtimeCredentialRepository } from "@/server/repositories";

/** The store's own result codes (never carry a credential value). */
export type RuntimeCredentialResolution =
  | { ok: true; value: string }
  | {
      ok: false;
      code:
        "CREDENTIAL_UNAVAILABLE" | "STORE_UNAVAILABLE" | "INVALID_REFERENCE";
      message: string;
    };

export type RuntimeCredentialStorage =
  | { ok: true; reference: string }
  | {
      ok: false;
      code: "STORE_UNAVAILABLE" | "INVALID_REFERENCE" | "REFERENCE_COLLISION";
      message: string;
    };

export type RuntimeCredentialDeletion =
  { ok: true } | { ok: false; code: "CREDENTIAL_UNAVAILABLE"; message: string };

/**
 * The storage contract behind the `CredentialsResolver` boundary.
 * `resolve`/`store`/`delete` are keyed by the opaque `credentialsRef`
 * (the stable indirection) — never by phone number, business name,
 * email, or any provider-owned id.
 */
export interface RuntimeCredentialStore {
  store(params: {
    businessId: string;
    reference: string;
    secret: string;
  }): Promise<RuntimeCredentialStorage>;
  resolve(reference: string): Promise<RuntimeCredentialResolution>;
  delete(reference: string): Promise<RuntimeCredentialDeletion>;
}

export type RuntimeCredentialStoreDeps = {
  repository: RuntimeCredentialRepository;
  /** The configured master key (env value) — never logged. */
  masterKey: string | null | undefined;
};

export class PostgresRuntimeCredentialStore implements RuntimeCredentialStore {
  private readonly deps: RuntimeCredentialStoreDeps;

  constructor(deps: RuntimeCredentialStoreDeps = defaultStoreDeps) {
    this.deps = deps;
  }

  async store(params: {
    businessId: string;
    reference: string;
    secret: string;
  }): Promise<RuntimeCredentialStorage> {
    if (!isRuntimeCredentialReference(params.reference)) {
      return {
        ok: false,
        code: "INVALID_REFERENCE",
        message: "مرجع بيانات اعتماد غير صالح",
      };
    }
    const keyResolution = resolveMasterKey(this.deps.masterKey);
    if (!keyResolution.ok) {
      return {
        ok: false,
        code: "STORE_UNAVAILABLE",
        message: keyResolution.message,
      };
    }
    let cipherBlob: string;
    try {
      cipherBlob = encryptCredential(keyResolution.key, params.secret);
    } catch (error) {
      // CredentialCryptoError carries a safe message only; anything else
      // is reported as unavailable without rethrowing the value.
      const message =
        error instanceof CredentialCryptoError
          ? error.message
          : "تعذر تخزين بيانات الاعتماد";
      return { ok: false, code: "STORE_UNAVAILABLE", message };
    }

    const stored = await this.deps.repository.create({
      credentialsRef: params.reference,
      businessId: params.businessId,
      cipherBlob,
      algorithm: CREDENTIAL_CIPHER_ALGORITHM,
      keyVersion: 1,
    });
    if (!stored) {
      // The freshly-minted opaque id already exists (astronomically
      // unlikely) — the caller mints another; nothing is clobbered.
      return {
        ok: false,
        code: "REFERENCE_COLLISION",
        message: "تعذر تخزين بيانات الاعتماد",
      };
    }
    return { ok: true, reference: params.reference };
  }

  async resolve(reference: string): Promise<RuntimeCredentialResolution> {
    if (!isRuntimeCredentialReference(reference)) {
      return {
        ok: false,
        code: "INVALID_REFERENCE",
        message: "مرجع بيانات اعتماد غير صالح",
      };
    }
    const keyResolution = resolveMasterKey(this.deps.masterKey);
    if (!keyResolution.ok) {
      return {
        ok: false,
        code: "STORE_UNAVAILABLE",
        message: keyResolution.message,
      };
    }
    const row = await this.deps.repository.findByReference(reference);
    if (!row) {
      return {
        ok: false,
        code: "CREDENTIAL_UNAVAILABLE",
        message: "بيانات الاعتماد غير متاحة",
      };
    }
    try {
      const value = decryptCredential(keyResolution.key, row.cipherBlob);
      return { ok: true, value };
    } catch {
      // GCM auth failure: tampered blob or a rotated/incorrect master key.
      // The caller gets an honest "unavailable"; the value is never
      // reconstructed and never reported.
      return {
        ok: false,
        code: "CREDENTIAL_UNAVAILABLE",
        message: "بيانات الاعتماد غير متاحة",
      };
    }
  }

  async delete(reference: string): Promise<RuntimeCredentialDeletion> {
    // Deletion needs no master key (no plaintext is touched), so a
    // rotated key never strands an old credential row.
    const removed = await this.deps.repository.deleteByReference(reference);
    if (!removed) {
      return {
        ok: false,
        code: "CREDENTIAL_UNAVAILABLE",
        message: "بيانات الاعتماد غير متاحة",
      };
    }
    return { ok: true };
  }
}

const defaultStoreDeps: RuntimeCredentialStoreDeps = {
  repository: runtimeCredentialRepository,
  get masterKey(): string | undefined {
    // Read at call time so a rotated env value is picked up without a
    // module reload. Same boundary convention as the Meta onboarding
    // config seam: the value is never logged by anything here. Boot-time
    // presence/shape validation lives in the server env schema.
    return process.env.CREDENTIAL_MASTER_KEY;
  },
};

/**
 * Production singleton — server-only. Reads the master key from the
 * VALIDATED server environment; while it is unset the store stays
 * UNAVAILABLE and the ENV grammar carries on exactly as before.
 */
export const defaultRuntimeCredentialStore: RuntimeCredentialStore =
  new PostgresRuntimeCredentialStore();

/** Safe, loggable capability descriptor (never the key or a value). */
export type RuntimeStoreCapability = {
  available: boolean;
  algorithm: string;
  cipherVersion: string;
};

export function describeRuntimeStoreCapability(
  deps: RuntimeCredentialStoreDeps = defaultStoreDeps,
): RuntimeStoreCapability {
  return {
    available: resolveMasterKey(deps.masterKey).ok,
    algorithm: CREDENTIAL_CIPHER_ALGORITHM,
    cipherVersion: CREDENTIAL_CIPHER_VERSION,
  };
}
