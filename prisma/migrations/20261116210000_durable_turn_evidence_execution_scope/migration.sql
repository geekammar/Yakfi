-- Durable turn evidence: execution-proof scope and operational-pool index.
--
-- ADDITIVE ONLY. The base tables are created by the preceding durable-turn
-- migration in this same unmerged PR. No existing product table is altered.
--
-- `execution_evidence` distinguishes a PROVEN_NO_CALL turn from a turn whose
-- execution telemetry is UNAVAILABLE — absence of telemetry is never treated
-- as proof that no model call happened. The derived counters keep confirmed
-- HTTP dispatches separate from logical attempt records, unknown dispatch
-- quantities and proven local prevention.

ALTER TABLE "turn_evidence_records"
  ADD COLUMN IF NOT EXISTS "execution_evidence" TEXT NOT NULL DEFAULT 'UNAVAILABLE',
  ADD COLUMN IF NOT EXISTS "logical_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "confirmed_http_dispatches" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "unknown_dispatch_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "prevented_attempt_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "turn_evidence_records_business_id_traffic_pool_occurred_at_idx"
  ON "turn_evidence_records"("business_id", "traffic_pool", "occurred_at");
