-- Operator attention — the notification layer on top of the EXISTING
-- NEED_HUMAN / AI_HANDOFF handoff (PROMPT-B04).
--
-- ADDITIVE ONLY: a brand-new dedicated table. No existing column,
-- constraint, index, or table is altered, renamed, or reinterpreted. The
-- authoritative handoff lifecycle (`conversations.status` =
-- NEED_HUMAN / AI_HANDOFF) and every one of its consumers are untouched;
-- the staff workspace queue, the inbox, the dashboard count and the
-- conversation engine all keep working exactly as before. Existing rows
-- are unaffected — nothing is backfilled and nothing migrates.
--
-- This table holds ONLY safe operational metadata:
--   reason         a COARSE stable machine key (validated by the Zod union
--                  `attentionReasonValues` in lib/validation). It is never
--                  a prompt, never chain-of-thought, never a provider
--                  payload, never a disclosure-policy name — the operator
--                  sees the operational consequence, not AI internals.
--   resolved_at    NULL while the alert is OPEN (unacknowledged); set when
--                  the operator acknowledges the thread or it leaves
--                  NEED_HUMAN.
--   resolved_by_id the operator who acknowledged (provenance only — never
--                  authorization; server-derived from the session).
--
-- `conversation_id` is UNIQUE: ONE attention row per conversation. Opening
-- attention on an already-open handoff refreshes the same row; re-opening
-- a resolved one resets it. This makes the open idempotent at the database
-- level — a message storm on a stuck thread can never become a
-- notification storm. `business_id` gives tenant isolation + cascade
-- cleanup (a Business deletion removes its attentions).

-- CreateTable
CREATE TABLE "operator_attentions" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_attentions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_attentions_conversation_id_key" ON "operator_attentions"("conversation_id");

-- CreateIndex
CREATE INDEX "operator_attentions_business_id_idx" ON "operator_attentions"("business_id");

-- CreateIndex
CREATE INDEX "operator_attentions_business_id_resolved_at_idx" ON "operator_attentions"("business_id", "resolved_at");

-- AddForeignKey
ALTER TABLE "operator_attentions" ADD CONSTRAINT "operator_attentions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_attentions" ADD CONSTRAINT "operator_attentions_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operator_attentions" ADD CONSTRAINT "operator_attentions_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
