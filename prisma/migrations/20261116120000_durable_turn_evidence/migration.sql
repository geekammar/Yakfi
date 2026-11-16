-- Durable turn usage/cost evidence (flowpilot.turn.evidence.durable@v1).
--
-- ADDITIVE ONLY: two new tables, indexes and foreign keys. Zero ALTERs on
-- existing tables; no historical backfill and no invented cost. Historical
-- `usage_records` rows remain unchanged and explicitly unresolved.
--
-- Costs are IEEE-754 USD doubles copied from the existing cost engine. They
-- are deliberately NOT integer micro-units: no premature rounding.

-- CreateTable
CREATE TABLE IF NOT EXISTS "turn_evidence_records" (
    "id" TEXT NOT NULL,
    "schema_version" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "customer_message_id" TEXT NOT NULL,
    "trace_id" TEXT,
    "traffic_pool" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "app_version" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "intent" TEXT,
    "assistant_action" TEXT NOT NULL,
    "conversation_status" TEXT NOT NULL,
    "handoff_cause" TEXT,
    "routing_decision" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "provider_status" TEXT,
    "stop_reason" TEXT,
    "final_outcome" TEXT NOT NULL,
    "outbound_send_attempted" BOOLEAN NOT NULL,
    "outbound_send_delivered" BOOLEAN,
    "outbound_delivery_error_code" TEXT,
    "total_cost_usd" DOUBLE PRECISION,
    "known_cost_subtotal_usd" DOUBLE PRECISION,
    "cost_completeness" TEXT,
    "cost_currency" TEXT,
    "fact_fingerprint" TEXT NOT NULL,
    "replay_count" INTEGER NOT NULL DEFAULT 0,
    "conflict_count" INTEGER NOT NULL DEFAULT 0,
    "last_conflict_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turn_evidence_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "turn_evidence_attempts" (
    "id" TEXT NOT NULL,
    "turn_evidence_id" TEXT NOT NULL,
    "attempt_index" INTEGER NOT NULL,
    "attempt_identity" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "dispatch_state" TEXT NOT NULL,
    "http_attempts" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DOUBLE PRECISION,
    "cost_currency" TEXT,
    "cost_provenance" TEXT NOT NULL,
    "cost_completeness" TEXT NOT NULL,
    "error_code" TEXT,
    "http_status" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "turn_evidence_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "turn_evidence_records_business_id_customer_message_id_key"
  ON "turn_evidence_records"("business_id", "customer_message_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "turn_evidence_records_business_id_occurred_at_idx"
  ON "turn_evidence_records"("business_id", "occurred_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "turn_evidence_records_conversation_id_occurred_at_idx"
  ON "turn_evidence_records"("conversation_id", "occurred_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "turn_evidence_records_business_id_conversation_id_occurred_at_idx"
  ON "turn_evidence_records"("business_id", "conversation_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "turn_evidence_attempts_turn_evidence_id_attempt_index_key"
  ON "turn_evidence_attempts"("turn_evidence_id", "attempt_index");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "turn_evidence_attempts_turn_evidence_id_idx"
  ON "turn_evidence_attempts"("turn_evidence_id");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turn_evidence_records_business_id_fkey'
  ) THEN
    ALTER TABLE "turn_evidence_records" ADD CONSTRAINT "turn_evidence_records_business_id_fkey"
      FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turn_evidence_records_conversation_id_fkey'
  ) THEN
    ALTER TABLE "turn_evidence_records" ADD CONSTRAINT "turn_evidence_records_conversation_id_fkey"
      FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'turn_evidence_attempts_turn_evidence_id_fkey'
  ) THEN
    ALTER TABLE "turn_evidence_attempts" ADD CONSTRAINT "turn_evidence_attempts_turn_evidence_id_fkey"
      FOREIGN KEY ("turn_evidence_id") REFERENCES "turn_evidence_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
