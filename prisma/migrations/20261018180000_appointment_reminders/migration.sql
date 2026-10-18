-- BOOK-REM-01: Reliable Appointment Reminders, Configurable Hours & Safe Message Customization
--
-- 1. Create ReminderStatus and ReminderChannel enums
-- 2. Add reminder configuration columns to businesses table (disabled by default)
-- 3. Create appointment_reminders table
-- 4. Add unique index for single active reminder per appointment
-- 5. Add indexes for tenant isolation, due scheduling lookup, and status filtering
-- 6. Add foreign keys

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReminderStatus') THEN
    CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'FAILED_RETRYABLE', 'FAILED_PERMANENT', 'CANCELLED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReminderChannel') THEN
    CREATE TYPE "ReminderChannel" AS ENUM ('WHATSAPP', 'TELEGRAM');
  END IF;
END $$;

-- AlterTable businesses
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "reminder_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "reminder_lead_hours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "reminder_template_id" TEXT NOT NULL DEFAULT 'standard';

-- CreateTable appointment_reminders
CREATE TABLE IF NOT EXISTS "appointment_reminders" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "channel" "ReminderChannel" NOT NULL DEFAULT 'WHATSAPP',
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "due_at" TIMESTAMP(3) NOT NULL,
    "lead_hours" INTEGER NOT NULL,
    "template_id" TEXT NOT NULL DEFAULT 'standard',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "sent_at" TIMESTAMP(3),
    "provider_message_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_reminders_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "appointment_reminders_business_id_idx" ON "appointment_reminders"("business_id");
CREATE INDEX IF NOT EXISTS "appointment_reminders_appointment_id_idx" ON "appointment_reminders"("appointment_id");
CREATE INDEX IF NOT EXISTS "appointment_reminders_status_due_at_idx" ON "appointment_reminders"("status", "due_at");
CREATE INDEX IF NOT EXISTS "appointment_reminders_business_id_status_idx" ON "appointment_reminders"("business_id", "status");

-- Partial unique index: at most one active (PENDING or CLAIMED) reminder per appointment
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_reminders_active_appointment_idx"
  ON "appointment_reminders"("appointment_id")
  WHERE "status" IN ('PENDING', 'CLAIMED');

-- Foreign keys
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointment_reminders_business_id_fkey') THEN
    ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointment_reminders_appointment_id_fkey') THEN
    ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
