-- STAFF-PROVIDER-01: Independent Provider Identity, All-Services Eligibility & Minimal Staff Management
--
-- 1. provider_profiles:
--    - user_id becomes NULLABLE (providers exist without an auth account)
--    - name column added (default '')
--    - service_policy column added (default 'ALL_SERVICES')
--    - backfill name from display_name or user.name
--    - backfill service_policy to 'SPECIFIC_SERVICES' for legacy providers with provider_services rows
--    - update FK constraint on user_id to ON DELETE SET NULL
--
-- 2. appointments:
--    - provider_id column added (nullable)
--    - backfill provider_id from assigned_user_id matching provider_profiles(user_id, business_id)
--    - add FK constraint to provider_profiles(id) ON DELETE SET NULL
--    - add indexes on provider_id and (business_id, provider_id)
--
-- 3. provider_service_exclusions:
--    - explicit exclusions table for ALL_SERVICES providers
--    - unique on (provider_id, service_id)

-- ─── 1. ProviderProfile evolution ──────────────────────────────────────────

-- Alter user_id to be nullable
ALTER TABLE "provider_profiles" ALTER COLUMN "user_id" DROP NOT NULL;

-- Add name column (idempotent)
ALTER TABLE "provider_profiles" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT '';

-- Add service_policy column (idempotent)
ALTER TABLE "provider_profiles" ADD COLUMN IF NOT EXISTS "service_policy" TEXT NOT NULL DEFAULT 'ALL_SERVICES';

-- Backfill name from display_name or user.name
UPDATE "provider_profiles" p
SET "name" = COALESCE(NULLIF(p."display_name", ''), u."name", 'مقدم خدمة')
FROM "users" u
WHERE p."user_id" = u."id" AND (p."name" = '' OR p."name" IS NULL);

UPDATE "provider_profiles"
SET "name" = COALESCE(NULLIF("display_name", ''), 'مقدم خدمة')
WHERE "name" = '' OR "name" IS NULL;

-- Backfill existing providers with configured provider_services to 'SPECIFIC_SERVICES'
-- to preserve exact historical positive-inclusion semantics
UPDATE "provider_profiles"
SET "service_policy" = 'SPECIFIC_SERVICES'
WHERE "id" IN (SELECT DISTINCT "provider_id" FROM "provider_services");

-- Update foreign key on user_id to ON DELETE SET NULL
ALTER TABLE "provider_profiles" DROP CONSTRAINT IF EXISTS "provider_profiles_user_id_fkey";
ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Index on (business_id, isActive)
CREATE INDEX IF NOT EXISTS "provider_profiles_business_id_isActive_idx" ON "provider_profiles"("business_id", "isActive");

-- ─── 2. Appointments evolution ─────────────────────────────────────────────

-- Add provider_id column (idempotent)
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "provider_id" TEXT;

-- Backfill provider_id from assigned_user_id where provider profile exists
UPDATE "appointments" a
SET "provider_id" = p."id"
FROM "provider_profiles" p
WHERE a."assigned_user_id" = p."user_id"
  AND a."business_id" = p."business_id"
  AND a."provider_id" IS NULL;

-- Add foreign key constraint (idempotent)
ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_provider_id_fkey";
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Add indexes
CREATE INDEX IF NOT EXISTS "appointments_provider_id_idx" ON "appointments"("provider_id");
CREATE INDEX IF NOT EXISTS "appointments_business_id_provider_id_idx" ON "appointments"("business_id", "provider_id");

-- ─── 3. Provider service exclusions ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "provider_service_exclusions" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "service_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_service_exclusions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "provider_service_exclusions_provider_id_service_id_key" ON "provider_service_exclusions"("provider_id", "service_id");
CREATE INDEX IF NOT EXISTS "provider_service_exclusions_service_id_idx" ON "provider_service_exclusions"("service_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_service_exclusions_provider_id_fkey'
  ) THEN
    ALTER TABLE "provider_service_exclusions" ADD CONSTRAINT "provider_service_exclusions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'provider_service_exclusions_service_id_fkey'
  ) THEN
    ALTER TABLE "provider_service_exclusions" ADD CONSTRAINT "provider_service_exclusions_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
