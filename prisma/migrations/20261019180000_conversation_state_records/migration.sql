-- CONV-CORE-01: Durable conversation state + typed booking offers.
--
-- ADDITIVE ONLY: one new table, one index, two foreign keys.
-- Zero ALTERs on existing tables; no data backfill. Idempotent
-- (IF NOT EXISTS / guarded constraints) so a re-run is a no-op.
-- Until this migration is applied, the engine degrades to the legacy
-- history-derived path (load/save failures are caught), so the code
-- is safe to deploy before or after the migration.

-- CreateTable
CREATE TABLE IF NOT EXISTS "conversation_state_records" (
    "conversation_id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "state" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_state_records_pkey" PRIMARY KEY ("conversation_id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "conversation_state_records_business_id_idx" ON "conversation_state_records"("business_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_state_records_business_id_fkey'
  ) THEN
    ALTER TABLE "conversation_state_records" ADD CONSTRAINT "conversation_state_records_business_id_fkey"
      FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_state_records_conversation_id_fkey'
  ) THEN
    ALTER TABLE "conversation_state_records" ADD CONSTRAINT "conversation_state_records_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
