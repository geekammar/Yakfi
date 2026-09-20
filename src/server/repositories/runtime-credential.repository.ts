import { db } from "@/server/db";
import type { RuntimeCredential } from "@/types/domain";

/**
 * RuntimeCredential data primitives (WHATSAPP-ONBOARDING-01; DECISIONS #49).
 *
 * The ONLY repository that touches the runtime-credential table. It is a
 * deliberately thin, CIPHERTEXT-ONLY surface: it stores and reads the
 * encrypted package + safe metadata (algorithm, key version) and NEVER
 * the plaintext credential. Decryption happens one layer up, inside the
 * credential store — so this layer, its query logs, and any error it
 * raises can only ever contain ciphertext and references.
 *
 * `credentialsRef` (the opaque `fp:<id>` handle) is the unique key and the
 * stable indirection the rest of the system sees. It is never derived
 * from a phone number, business name, email, or any provider-owned id.
 * `businessId` carries tenant isolation and cascade cleanup.
 *
 * Lifecycle: one row per stored credential. A re-authorization mints a
 * NEW reference (the old row is removed explicitly, never overwritten in
 * place — there is no cross-tenant replace path here at all).
 */
export class RuntimeCredentialRepository {
  /**
   * Insert an encrypted credential package. Refuses to overwrite an
   * existing reference (a collision means the freshly-minted opaque id
   * collided — the caller mints another; a foreign credential is never
   * clobbered).
   */
  async create(params: {
    credentialsRef: string;
    businessId: string;
    cipherBlob: string;
    algorithm: string;
    keyVersion: number;
  }): Promise<RuntimeCredential | null> {
    try {
      return await db.runtimeCredential.create({ data: params });
    } catch {
      // Unique-constraint / FK failure: report as "not stored" and let
      // the caller mint a fresh reference. Nothing credential-shaped is
      // included here.
      return null;
    }
  }

  /** Read the encrypted package for an opaque reference (ciphertext only). */
  async findByReference(
    credentialsRef: string,
  ): Promise<RuntimeCredential | null> {
    return db.runtimeCredential.findUnique({
      where: { credentialsRef },
    });
  }

  /** Remove a stored credential by its opaque reference. */
  async deleteByReference(credentialsRef: string): Promise<boolean> {
    try {
      const deleted = await db.runtimeCredential.deleteMany({
        where: { credentialsRef },
      });
      return deleted.count > 0;
    } catch {
      return false;
    }
  }
}
