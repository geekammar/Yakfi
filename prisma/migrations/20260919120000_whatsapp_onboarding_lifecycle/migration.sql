-- WhatsApp onboarding lifecycle (WHATSAPP-ONBOARDING-01; DECISIONS #31/#47):
-- a SEPARATE onboarding lifecycle surface on `whatsapp_connections` plus
-- the server-persisted authorization ledger that makes the provider
-- callback server-resolved, single-use, and tenant-safe.
--
-- ADDITIVE ONLY: no existing column is altered, renamed, or reinterpreted.
-- The operational runtime gate (`status` + `is_active`) keeps its exact
-- meaning and its exact consumers (`resolveConnectionForSend`,
-- `resolveInboundConnection`). Legacy rows receive the DEFAULT
-- `onboarding_state = 'NOT_STARTED'` / `onboarding_actor = 'NONE'` and a
-- NULL credential kind (= ENV, the existing behavior) — no existing row
-- can claim onboarding READY.
--
-- Machine keys (no Prisma enums — extending the lists needs no migration,
-- the confirmation_mode / vertical pattern):
--   onboarding_state: NOT_STARTED | AUTHORIZING | PROVISIONING | ACTION_REQUIRED | READY | FAILED
--   onboarding_actor: CUSTOMER | META | FLOWPILOT | NONE
--   credential_kind:  ENV | RUNTIME
--
-- All new columns are nullable or carry a safe DEFAULT, so the migration
-- is instant and reversible on a live table.

-- Onboarding lifecycle (separate from the operational status)
ALTER TABLE "whatsapp_connections" ADD COLUMN "onboarding_state" TEXT NOT NULL DEFAULT 'NOT_STARTED';
ALTER TABLE "whatsapp_connections" ADD COLUMN "onboarding_actor" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "whatsapp_connections" ADD COLUMN "onboarding_reason_code" TEXT;
ALTER TABLE "whatsapp_connections" ADD COLUMN "onboarding_reason_summary" TEXT;
ALTER TABLE "whatsapp_connections" ADD COLUMN "onboarding_retryable" BOOLEAN;
ALTER TABLE "whatsapp_connections" ADD COLUMN "onboarding_state_changed_at" TIMESTAMP(3);
ALTER TABLE "whatsapp_connections" ADD COLUMN "onboarding_completed_at" TIMESTAMP(3);
ALTER TABLE "whatsapp_connections" ADD COLUMN "onboarding_failed_at" TIMESTAMP(3);

-- Credential reference kind (NULL = ENV, the existing reference grammar)
ALTER TABLE "whatsapp_connections" ADD COLUMN "credential_kind" TEXT;

-- Meta provenance — non-secret provider-reported REFERENCE data only
ALTER TABLE "whatsapp_connections" ADD COLUMN "meta_business_id" TEXT;
ALTER TABLE "whatsapp_connections" ADD COLUMN "waba_id" TEXT;
ALTER TABLE "whatsapp_connections" ADD COLUMN "display_phone_number" TEXT;
ALTER TABLE "whatsapp_connections" ADD COLUMN "verified_name" TEXT;
ALTER TABLE "whatsapp_connections" ADD COLUMN "meta_review_status" TEXT;

-- Operational read surface for the platform operator
CREATE INDEX "whatsapp_connections_onboarding_state_idx" ON "whatsapp_connections"("onboarding_state");

-- Authorization ledger: one row per launched provider authorization
-- attempt. `state_ref` is the ONLY thing a provider callback may carry;
-- the Business + connection are resolved from THIS row server-side.
CREATE TABLE "whatsapp_onboarding_authorizations" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "state_ref" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_onboarding_authorizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "whatsapp_onboarding_authorizations_state_ref_key" ON "whatsapp_onboarding_authorizations"("state_ref");
CREATE INDEX "whatsapp_onboarding_authorizations_business_id_idx" ON "whatsapp_onboarding_authorizations"("business_id");
CREATE INDEX "whatsapp_onboarding_authorizations_connection_id_idx" ON "whatsapp_onboarding_authorizations"("connection_id");

ALTER TABLE "whatsapp_onboarding_authorizations" ADD CONSTRAINT "whatsapp_onboarding_authorizations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "whatsapp_onboarding_authorizations" ADD CONSTRAINT "whatsapp_onboarding_authorizations_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "whatsapp_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
