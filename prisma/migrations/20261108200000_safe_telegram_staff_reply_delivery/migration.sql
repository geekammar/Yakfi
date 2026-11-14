-- ISS-018: Safe Telegram Staff Reply Delivery
-- ADDITIVE ONLY: two new tables, indices, and foreign keys.
-- Zero ALTERs on existing tables; no destructive backfills.

-- CreateTable
CREATE TABLE IF NOT EXISTS "conversation_delivery_routes" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'telegram',
    "connection_id" TEXT NOT NULL,
    "bot_external_id" TEXT NOT NULL,
    "recipient_external_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_delivery_routes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "staff_reply_submissions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "submission_key" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "staff_message_id" TEXT,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_reply_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_delivery_routes_conversation_id_key" ON "conversation_delivery_routes"("conversation_id");
CREATE INDEX IF NOT EXISTS "conversation_delivery_routes_business_id_idx" ON "conversation_delivery_routes"("business_id");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "staff_reply_submissions_business_id_conversation_id_submission_key" ON "staff_reply_submissions"("business_id", "conversation_id", "submission_key");
CREATE INDEX IF NOT EXISTS "staff_reply_submissions_business_id_conversation_id_idx" ON "staff_reply_submissions"("business_id", "conversation_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_delivery_routes_business_id_fkey'
  ) THEN
    ALTER TABLE "conversation_delivery_routes" ADD CONSTRAINT "conversation_delivery_routes_business_id_fkey"
      FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversation_delivery_routes_conversation_id_fkey'
  ) THEN
    ALTER TABLE "conversation_delivery_routes" ADD CONSTRAINT "conversation_delivery_routes_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_reply_submissions_business_id_fkey'
  ) THEN
    ALTER TABLE "staff_reply_submissions" ADD CONSTRAINT "staff_reply_submissions_business_id_fkey"
      FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'staff_reply_submissions_conversation_id_fkey'
  ) THEN
    ALTER TABLE "staff_reply_submissions" ADD CONSTRAINT "staff_reply_submissions_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
