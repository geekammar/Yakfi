-- CONV-PLAY-01: Default Service Booking Mode and Retrospective Performed Service Correction
--
-- 1. Add default service booking configuration columns to businesses table (disabled by default)
-- 2. Add performed service and correction tracking columns to appointments table
-- 3. Add indexes and foreign keys

-- AlterTable businesses
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "default_service_booking_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "default_booking_service_id" TEXT;

-- CreateIndex on businesses
CREATE INDEX IF NOT EXISTS "businesses_default_booking_service_id_idx" ON "businesses"("default_booking_service_id");

-- Foreign key for default_booking_service_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'businesses_default_booking_service_id_fkey'
  ) THEN
    ALTER TABLE "businesses" ADD CONSTRAINT "businesses_default_booking_service_id_fkey"
      FOREIGN KEY ("default_booking_service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- AlterTable appointments
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "performed_service_id" TEXT;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "service_corrected_at" TIMESTAMP(3);
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "service_corrected_by_id" TEXT;
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "service_correction_history" JSONB;

-- CreateIndex on appointments
CREATE INDEX IF NOT EXISTS "appointments_performed_service_id_idx" ON "appointments"("performed_service_id");

-- Foreign keys for performed_service_id and service_corrected_by_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_performed_service_id_fkey'
  ) THEN
    ALTER TABLE "appointments" ADD CONSTRAINT "appointments_performed_service_id_fkey"
      FOREIGN KEY ("performed_service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_service_corrected_by_id_fkey'
  ) THEN
    ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_corrected_by_id_fkey"
      FOREIGN KEY ("service_corrected_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
