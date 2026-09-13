-- PROMPT-ARCH-02: architecture-hardening P0 foundations
-- (DECISIONS #30–#36 implementation; bridge: ARCHITECTURE_RECONCILIATION.md).
--
-- Adds, in ONE coherent migration:
--   1. Branch (DECISIONS #30) + Business.defaultBranchId pointer, with a
--      safe backfill: exactly one Default Branch per existing Business
--      (including soft-deleted Businesses — their rows need valid
--      branch references), then branch_id on conversations and
--      appointments (backfilled to the Business's Default Branch, then
--      NOT NULL — the strongest tenant+branch invariant).
--   2. WhatsAppConnection (DECISIONS #31): Business-owned, optional
--      Branch scope, provider-neutral external identity, machine-key
--      status, secret REFERENCE column (never raw credentials).
--   3. ProviderProfile / ProviderService / ProviderBranch (DECISIONS #32):
--      bookable capability relations, NOT authorization roles.
--   4. users.account_type (DECISIONS #22): explicit PLATFORM/BUSINESS
--      marker, default BUSINESS — platform access is never inferred
--      from businessId = null.
--   5. inbound_message_dedupe (DECISIONS #34): durable, tenant-scoped
--      webhook idempotency ledger (unique business + external key).
--   6. usage_records (DECISIONS #36): append-only raw usage facts —
--      no pricing, no billing, no message content, no secrets.
--
-- Non-destructive: every new column is additive with a DEFAULT or is
-- backfilled before NOT NULL; no existing row changes meaning. Existing
-- businesses/tenants keep their data semantics (single-Branch = the
-- new Default Branch).
--
-- Apply from desktop/CI: pnpm db:deploy (Termux cannot run the Prisma
-- schema engine).
--
-- PROMPT-ARCH-03 alignment note: this migration was authored but NEVER
-- applied to any database, so its SQL was aligned in-place with
-- prisma/schema.prisma (schema-deployed equality is the binding
-- invariant): isActive columns (was: is_active — the schema and the
-- generated client expect the unmapped camelCase name), DEFAULT
-- CURRENT_TIMESTAMP on every updated_at (@default(now()) @updatedAt),
-- and the redundant non-unique default_branch_id index was dropped
-- (only the @unique pointer index is modeled).

-- ─── 1. Branch (DECISIONS #30) ───────────────────────────────────────

-- CreateTable
CREATE TABLE "branches" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branches_business_id_idx" ON "branches"("business_id");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: exactly ONE Default Branch per Business (all businesses,
-- including soft-deleted ones). Arabic-first default name.
INSERT INTO "branches" ("id", "business_id", "name", "isActive", "created_at", "updated_at")
SELECT gen_random_uuid(), "id", 'الفرع الرئيسي', true, now(), now()
FROM "businesses";

-- The Default Branch pointer on the Business itself (structural
-- one-default invariant: a Business points at exactly one Branch).
ALTER TABLE "businesses" ADD COLUMN "default_branch_id" TEXT;

-- Backfill the pointer for every Business.
UPDATE "businesses" b
SET "default_branch_id" = branch."id"
FROM "branches" branch
WHERE branch."business_id" = b."id";

-- CreateIndex
-- Unique: one-to-one pointer — a Branch is the Default Branch of at
-- most ONE Business, and a Business points to at most one Branch.
-- (PROMPT-ARCH-03: the earlier additional non-unique index on
-- default_branch_id was removed — schema.prisma models only the @unique
-- pointer; the unique index covers every lookup the non-unique one did.)
CREATE UNIQUE INDEX "businesses_default_branch_id_key" ON "businesses"("default_branch_id");

-- AddForeignKey
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_default_branch_id_fkey" FOREIGN KEY ("default_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Branch scoping for conversations: add, backfill to the Business's
-- Default Branch, then make it required.
ALTER TABLE "conversations" ADD COLUMN "branch_id" TEXT;

UPDATE "conversations" c
SET "branch_id" = b."default_branch_id"
FROM "businesses" b
WHERE b."id" = c."business_id" AND b."default_branch_id" IS NOT NULL;

ALTER TABLE "conversations" ALTER COLUMN "branch_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "conversations_branch_id_idx" ON "conversations"("branch_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Branch scoping for appointments: same pattern.
ALTER TABLE "appointments" ADD COLUMN "branch_id" TEXT;

UPDATE "appointments" a
SET "branch_id" = b."default_branch_id"
FROM "businesses" b
WHERE b."id" = a."business_id" AND b."default_branch_id" IS NOT NULL;

ALTER TABLE "appointments" ALTER COLUMN "branch_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "appointments_branch_id_date_idx" ON "appointments"("branch_id", "date");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 2. WhatsAppConnection (DECISIONS #31) ───────────────────────────

-- CreateTable
CREATE TABLE "whatsapp_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "display_name" TEXT,
    "phone_number" TEXT NOT NULL,
    "provider" TEXT,
    "external_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "credentials_ref" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_connections_business_id_phone_number_key" ON "whatsapp_connections"("business_id", "phone_number");

-- CreateIndex
CREATE INDEX "whatsapp_connections_business_id_idx" ON "whatsapp_connections"("business_id");

-- CreateIndex
CREATE INDEX "whatsapp_connections_branch_id_idx" ON "whatsapp_connections"("branch_id");

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_connections" ADD CONSTRAINT "whatsapp_connections_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 3. Provider model (DECISIONS #32) ───────────────────────────────

-- CreateTable
CREATE TABLE "provider_profiles" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "display_name" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_profiles_user_id_key" ON "provider_profiles"("user_id");

-- CreateIndex
CREATE INDEX "provider_profiles_business_id_idx" ON "provider_profiles"("business_id");

-- AddForeignKey
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "provider_services" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_services_provider_id_service_id_key" ON "provider_services"("provider_id", "service_id");

-- CreateIndex
CREATE INDEX "provider_services_service_id_idx" ON "provider_services"("service_id");

-- AddForeignKey
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_services" ADD CONSTRAINT "provider_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "provider_branches" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "branch_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_branches_provider_id_branch_id_key" ON "provider_branches"("provider_id", "branch_id");

-- CreateIndex
CREATE INDEX "provider_branches_branch_id_idx" ON "provider_branches"("branch_id");

-- AddForeignKey
ALTER TABLE "provider_branches" ADD CONSTRAINT "provider_branches_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_branches" ADD CONSTRAINT "provider_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 4. users.account_type (DECISIONS #22) ───────────────────────────

-- Machine key with DEFAULT so existing rows are BUSINESS accounts and
-- behavior is unchanged; validated at the boundary by a Zod union.
ALTER TABLE "users" ADD COLUMN "account_type" TEXT NOT NULL DEFAULT 'BUSINESS';

-- CreateIndex
CREATE INDEX "users_account_type_idx" ON "users"("account_type");

-- ─── 5. Inbound webhook idempotency (DECISIONS #34) ──────────────────

-- CreateTable
CREATE TABLE "inbound_message_dedupe" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "external_key" TEXT NOT NULL,
    "conversation_id" TEXT,
    "customer_message_id" TEXT,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_message_dedupe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_message_dedupe_business_id_external_key_key" ON "inbound_message_dedupe"("business_id", "external_key");

-- CreateIndex
CREATE INDEX "inbound_message_dedupe_business_id_idx" ON "inbound_message_dedupe"("business_id");

-- AddForeignKey
ALTER TABLE "inbound_message_dedupe" ADD CONSTRAINT "inbound_message_dedupe_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 6. Usage telemetry (DECISIONS #36) ──────────────────────────────

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "whatsapp_connection_id" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "estimated_cost_micros" INTEGER,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_records_business_id_occurred_at_idx" ON "usage_records"("business_id", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_records_business_id_kind_occurred_at_idx" ON "usage_records"("business_id", "kind", "occurred_at");

-- CreateIndex
CREATE INDEX "usage_records_conversation_id_idx" ON "usage_records"("conversation_id");

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
