-- UX001-R5: Flexible Follow-up Requests, Receptionist UX & Patient Choice Foundation
--
-- 1. Create FollowUpRequestStatus enum
-- 2. Create follow_up_requests table
-- 3. Add unique constraint on scheduled_appointment_id to prevent double-scheduling
-- 4. Add foreign keys and indexes for tenant isolation and query performance

-- CreateEnum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FollowUpRequestStatus') THEN
    CREATE TYPE "FollowUpRequestStatus" AS ENUM ('PENDING', 'SCHEDULED', 'CANCELLED');
  END IF;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "follow_up_requests" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "source_appointment_id" TEXT,
    "service_id" TEXT,
    "preferred_provider_id" TEXT,
    "created_by_id" TEXT,
    "start_date" DATE,
    "end_date" DATE,
    "status" "FollowUpRequestStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "scheduled_appointment_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "follow_up_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "follow_up_requests_scheduled_appointment_id_key" ON "follow_up_requests"("scheduled_appointment_id");
CREATE INDEX IF NOT EXISTS "follow_up_requests_business_id_idx" ON "follow_up_requests"("business_id");
CREATE INDEX IF NOT EXISTS "follow_up_requests_business_id_status_idx" ON "follow_up_requests"("business_id", "status");
CREATE INDEX IF NOT EXISTS "follow_up_requests_customer_id_idx" ON "follow_up_requests"("customer_id");
CREATE INDEX IF NOT EXISTS "follow_up_requests_source_appointment_id_idx" ON "follow_up_requests"("source_appointment_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_business_id_fkey') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_customer_id_fkey') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_source_appointment_id_fkey') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_source_appointment_id_fkey" FOREIGN KEY ("source_appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_service_id_fkey') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_preferred_provider_id_fkey') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_preferred_provider_id_fkey" FOREIGN KEY ("preferred_provider_id") REFERENCES "provider_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_created_by_id_fkey') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'follow_up_requests_scheduled_appointment_id_fkey') THEN
    ALTER TABLE "follow_up_requests" ADD CONSTRAINT "follow_up_requests_scheduled_appointment_id_fkey" FOREIGN KEY ("scheduled_appointment_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
