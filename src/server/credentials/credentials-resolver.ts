/**
 * Provider-neutral credentials REFERENCE boundary
 * (WHATSAPP-ONBOARDING-01; DECISIONS #31/#47).
 *
 * `WhatsAppConnection.credentialsRef` is a REFERENCE, never a credential
 * value. This module owns the reference GRAMMAR and the single place a
 * reference is turned back into a usable value — adapter-side only:
 *
 *   feature ──writes──▶ reference + kind (never the value)
 *   adapter ──reads──▶  resolve(reference) ──▶ value (never persisted)
 *
 * Two reference kinds:
 * - ENV     the existing grammar: an environment-variable NAME. The
 *           current production/test behavior is unchanged — the Meta
 *           verifier keeps reading `process.env[credentialsRef]`.
 * - RUNTIME an opaque `fp:<random-id>` handle for a future runtime
 *           secret store. ONLY the boundary exists today: the runtime
 *           backend itself is deferred, so a RUNTIME reference resolves
 *           to a typed, honest "not available" instead of a fake value.
 *
 * Nothing here stores a secret: `resolve` returns the value to the
 * caller (an adapter) and nothing is persisted, logged, or projected.
 */

import {
  CREDENTIAL_RUNTIME_REFERENCE_PREFIX,
  isEnvCredentialReference,
  isRuntimeCredentialReference,
  type CredentialKind,
} from "@/lib/validation";
import type { RuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import { defaultRuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";

export { CREDENTIAL_RUNTIME_REFERENCE_PREFIX };
export type { CredentialKind };

/**
 * Classify a stored reference by its grammar. A NULL/legacy reference
 * is ENV (the pre-existing behavior: `WHATSAPP_META_ACCESS_TOKEN` and
 * every existing row).
 */
export function classifyCredentialReference(
  reference: string | null | undefined,
): CredentialKind {
  if (!reference) return "ENV";
  return reference.startsWith(CREDENTIAL_RUNTIME_REFERENCE_PREFIX)
    ? "RUNTIME"
    : "ENV";
}

/** Is this reference an opaque runtime handle (`fp:<random-id>`)? */
export { isRuntimeCredentialReference };

/** Is this reference an ENV-var NAME (the existing grammar)? */
export { isEnvCredentialReference };

/**
 * Mint an opaque RUNTIME reference handle. The handle is the ONLY thing
 * that would be persisted; the raw credential goes to the runtime store
 * (deferred) and never crosses this boundary.
 */
export function buildRuntimeCredentialReference(seed: string): string {
  return `${CREDENTIAL_RUNTIME_REFERENCE_PREFIX}${seed}`;
}

/**
 * Mint a fresh, opaque RUNTIME reference handle (`fp:<random-id>`). The
 * handle is the ONLY thing the caller persists; the raw credential goes
 * to the runtime store and never crosses this boundary back. The handle
 * contains no token text, no phone number, no business name, no email,
 * and no provider-owned id — only unpredictable entropy.
 */
export function mintRuntimeCredentialReference(): string {
  return `${CREDENTIAL_RUNTIME_REFERENCE_PREFIX}${crypto.randomUUID()}`;
}

export type ResolvedCredential =
  | {
      ok: true;
      kind: CredentialKind;
      /** The same reference that was resolved (never the value). */
      reference: string;
      /** The usable value — adapter-side only, never persisted/logged. */
      value: string;
    }
  | {
      ok: false;
      code: "UNRESOLVED_REFERENCE" | "UNSUPPORTED_KIND";
      message: string;
    };

export type StoredCredential =
  | { ok: true; reference: string }
  | {
      ok: false;
      code:
        | "UNSUPPORTED_KIND"
        | "STORE_UNAVAILABLE"
        | "INVALID_REFERENCE"
        | "REFERENCE_COLLISION";
      message: string;
    };

export type DeletedCredential =
  | { ok: true }
  | {
      ok: false;
      code: "UNSUPPORTED_KIND" | "CREDENTIAL_UNAVAILABLE";
      message: string;
    };

/**
 * The resolve boundary. Adapters depend on this; features depend only on
 * the grammar helpers above.
 *
 * - `resolve` turns a REFERENCE into a usable VALUE at the adapter
 *   boundary (ENV today; RUNTIME via the runtime store). The value is
 *   returned to the caller and never persisted, logged, or projected.
 * - `store` puts a runtime-obtained secret AWAY and hands back an opaque
 *   `fp:<id>` reference. The secret is never returned to the caller.
 * - `delete` removes a stored runtime credential by its reference.
 *
 * The ENV grammar cannot `store`/`delete` (an operator owns env vars);
 * those return a typed, honest UNSUPPORTED_KIND.
 */
export interface CredentialsResolver {
  resolve(reference: string): Promise<ResolvedCredential>;
  store(params: {
    businessId: string;
    reference: string;
    secret: string;
  }): Promise<StoredCredential>;
  delete(reference: string): Promise<DeletedCredential>;
}

export type EnvCredentialsResolverDeps = {
  getEnvVar(name: string): string | undefined;
};

export class EnvCredentialsResolver implements CredentialsResolver {
  private readonly deps: EnvCredentialsResolverDeps;

  constructor(deps: EnvCredentialsResolverDeps = defaultEnvDeps) {
    this.deps = deps;
  }

  async resolve(reference: string): Promise<ResolvedCredential> {
    if (isRuntimeCredentialReference(reference)) {
      return {
        ok: false,
        code: "UNSUPPORTED_KIND",
        message: "مرجع بيانات اعتماد RUNTIME غير مُفعّل بعد",
      };
    }
    if (!isEnvCredentialReference(reference)) {
      return {
        ok: false,
        code: "UNRESOLVED_REFERENCE",
        message: "مرجع بيانات اعتماد غير صالح",
      };
    }
    const value = this.deps.getEnvVar(reference);
    if (!value) {
      return {
        ok: false,
        code: "UNRESOLVED_REFERENCE",
        message: "مرجع بيانات اعتماد غير مُهيأ",
      };
    }
    return { ok: true, kind: "ENV", reference, value };
  }

  /**
   * ENV references are operator-owned environment variables: storing a
   * runtime secret under this grammar is impossible, and the honest
   * answer is UNSUPPORTED_KIND (never a fake success).
   */
  async store(_params: {
    businessId: string;
    reference: string;
    secret: string;
  }): Promise<StoredCredential> {
    return {
      ok: false,
      code: "UNSUPPORTED_KIND",
      message: "تخزين بيانات اعتماد ENV غير مدعوم",
    };
  }

  async delete(_reference: string): Promise<DeletedCredential> {
    return {
      ok: false,
      code: "UNSUPPORTED_KIND",
      message: "حذف بيانات اعتماد ENV غير مدعوم",
    };
  }
}

const defaultEnvDeps: EnvCredentialsResolverDeps = {
  getEnvVar: (name) => process.env[name],
};

/**
 * The RUNTIME leg: every `fp:<id>` reference routes to the runtime
 * credential store. ENV references are not this resolver's business.
 */
export class RuntimeCredentialsResolver implements CredentialsResolver {
  private readonly credentialStore: RuntimeCredentialStore;

  constructor(store: RuntimeCredentialStore = defaultRuntimeCredentialStore) {
    this.credentialStore = store;
  }

  async resolve(reference: string): Promise<ResolvedCredential> {
    if (!isRuntimeCredentialReference(reference)) {
      return {
        ok: false,
        code: "UNSUPPORTED_KIND",
        message: "مرجع بيانات اعتماد RUNTIME غير مُفعّل بعد",
      };
    }
    const resolved = await this.credentialStore.resolve(reference);
    if (!resolved.ok) {
      return {
        ok: false,
        code: "UNRESOLVED_REFERENCE",
        message: resolved.message,
      };
    }
    return { ok: true, kind: "RUNTIME", reference, value: resolved.value };
  }

  async store(params: {
    businessId: string;
    reference: string;
    secret: string;
  }): Promise<StoredCredential> {
    const stored = await this.credentialStore.store(params);
    if (!stored.ok) return stored;
    return { ok: true, reference: stored.reference };
  }

  async delete(reference: string): Promise<DeletedCredential> {
    return this.credentialStore.delete(reference);
  }
}

/**
 * The production boundary: one resolver covering BOTH grammars, so a
 * caller hands over a reference and gets a value back without knowing
 * which backend serves it.
 *
 * - ENV (a legacy row, or an operator-managed env-var name) → the
 *   existing environment lookup, behavior UNCHANGED.
 * - RUNTIME (`fp:<id>`) → the encrypted runtime store.
 *
 * `store`/`delete` always route to the runtime store (an ENV reference
 * cannot be stored).
 */
export class DefaultCredentialsResolver implements CredentialsResolver {
  private readonly envResolver: EnvCredentialsResolver;
  private readonly runtimeResolver: RuntimeCredentialsResolver;

  constructor(
    params: {
      envResolver?: EnvCredentialsResolver;
      runtimeResolver?: RuntimeCredentialsResolver;
    } = {},
  ) {
    this.envResolver = params.envResolver ?? new EnvCredentialsResolver();
    this.runtimeResolver =
      params.runtimeResolver ?? new RuntimeCredentialsResolver();
  }

  async resolve(reference: string): Promise<ResolvedCredential> {
    return isRuntimeCredentialReference(reference)
      ? this.runtimeResolver.resolve(reference)
      : this.envResolver.resolve(reference);
  }

  async store(params: {
    businessId: string;
    reference: string;
    secret: string;
  }): Promise<StoredCredential> {
    return this.runtimeResolver.store(params);
  }

  async delete(reference: string): Promise<DeletedCredential> {
    return this.runtimeResolver.delete(reference);
  }
}

/**
 * Production singleton — both grammars, server-side only. ENV stays
 * exactly as before; RUNTIME resolves through the encrypted store.
 */
export const defaultCredentialsResolver: CredentialsResolver =
  new DefaultCredentialsResolver();
