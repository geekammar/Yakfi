-- Runtime credentials — the RUNTIME secret backend for the `fp:<id>`
-- reference grammar (WHATSAPP-ONBOARDING-01; DECISIONS #49).
--
-- ADDITIVE ONLY: a brand-new dedicated table. No existing column,
-- constraint, index, or table is altered, renamed, or reinterpreted.
-- The operational runtime gate (`whatsapp_connections.status` +
-- `is_active`) and its consumers are untouched; the ENV reference
-- grammar (an env-var NAME) keeps working exactly as before. Legacy
-- rows are unaffected — nothing is backfilled and nothing migrates.
--
-- This table holds ONLY ENCRYPTED MATERIAL + SAFE METADATA:
--   cipher_blob     `v1:` + base64(iv || ciphertext || authTag)
--                   (AES-256-GCM; unique 96-bit IV per credential; the
--                    128-bit auth tag is part of the blob — tampering or
--                    a wrong master key fails closed at decryption)
--   algorithm       cipher primitive name (rotation-safe metadata)
--   key_version     master-key version for future rotation
-- The master encryption key lives ONLY in the server environment
-- (`CREDENTIAL_MASTER_KEY`); it is never stored in the database, never
-- logged, and never projected. Prisma query logs can only ever contain
-- the ciphertext.
--
-- `credentials_ref` is BOTH the stable indirection the rest of the system
-- sees AND this table's unique key. It is derived from the opaque
-- reference only — never from a phone number, business name, email, Meta
-- Business ID, WABA ID, or phone_number_id. `business_id` gives tenant
-- isolation + cascade cleanup (a Business deletion removes its secrets).

-- CreateTable
CREATE TABLE "runtime_credentials" (
    "id" TEXT NOT NULL,
    "credentials_ref" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "cipher_blob" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'AES-256-GCM',
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "runtime_credentials_credentials_ref_key" ON "runtime_credentials"("credentials_ref");

-- CreateIndex
CREATE INDEX "runtime_credentials_business_id_idx" ON "runtime_credentials"("business_id");

-- AddForeignKey
ALTER TABLE "runtime_credentials" ADD CONSTRAINT "runtime_credentials_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
