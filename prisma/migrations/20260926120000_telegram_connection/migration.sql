-- Telegram second channel — the connection + provisioning-ledger
-- foundation (DECISIONS #63/#64; Telegram Managed Bots).
--
-- ADDITIVE ONLY: two brand-new dedicated tables. No existing column,
-- constraint, index, or table is altered, renamed, or reinterpreted;
-- WhatsApp, the Conversation Engine, the AI boundary, and the customer
-- model are completely untouched. Existing rows are unaffected — nothing
-- is backfilled and nothing migrates.
--
-- `telegram_connections` is a TRANSPORT SIBLING of
-- `whatsapp_connections`, deliberately NOT a polymorphic `connections`
-- table and NOT a column on `whatsapp_connections` (the WhatsApp
-- identity is a required phone number with Meta-specific provenance;
-- generalizing either would be premature omnichannel infrastructure,
-- which ARCHITECTURE.md forbids). It mirrors the SAME two-surface
-- lifecycle (operational `status`/`isActive` gate + a separate onboarding
-- lifecycle) and the SAME credential-reference discipline
-- (`credentialsRef` = an opaque `fp:<id>` RUNTIME handle resolved only
-- inside the Telegram adapter — NEVER the raw bot token).
--
-- `webhook_secret_hash` is a NON-SECRET, non-reversible SHA-256 digest:
-- inbound webhook routing resolves the connection server-side from the
-- digest of the `X-Telegram-Bot-Api-Secret-Token` header. The plaintext
-- secret is generated at provisioning, handed to Telegram once via
-- `setWebhook`, and never persisted anywhere.
--
-- `telegram_provisioning_ledgers` is the single-use provisioning ledger —
-- the exact analogue of `whatsapp_onboarding_authorizations`. The
-- customer-facing deep link carries ONLY the opaque `start_token`; the
-- target Business and the bound creator are resolved from THIS
-- server-persisted row, never from a client payload or the webhook body.
-- `creator_telegram_user_id` binds the Admin who STARTed the Manager Bot
-- so a forged `managed_bot` callback cannot attach a bot to another
-- Business, and `consumedAt` makes the token single-use (replay proof).

-- CreateTable
CREATE TABLE "telegram_connections" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "display_name" TEXT,
    "bot_external_id" TEXT NOT NULL,
    "bot_username" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'telegram_managed',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "credentials_ref" TEXT,
    "credential_kind" TEXT,
    "webhook_secret_hash" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "onboarding_state" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "onboarding_actor" TEXT NOT NULL DEFAULT 'NONE',
    "onboarding_reason_code" TEXT,
    "onboarding_reason_summary" TEXT,
    "onboarding_retryable" BOOLEAN,
    "onboarding_state_changed_at" TIMESTAMP(3),
    "onboarding_completed_at" TIMESTAMP(3),
    "onboarding_failed_at" TIMESTAMP(3),
    "manager_bot_id" TEXT,
    "creator_telegram_user_id" TEXT,

    CONSTRAINT "telegram_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_provisioning_ledgers" (
    "id" TEXT NOT NULL,
    "business_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "start_token" TEXT NOT NULL,
    "creator_telegram_user_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_provisioning_ledgers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_connections_webhook_secret_hash_key" ON "telegram_connections"("webhook_secret_hash");

-- CreateIndex
CREATE INDEX "telegram_connections_business_id_idx" ON "telegram_connections"("business_id");

-- CreateIndex
CREATE INDEX "telegram_connections_branch_id_idx" ON "telegram_connections"("branch_id");

-- CreateIndex
CREATE INDEX "telegram_connections_onboarding_state_idx" ON "telegram_connections"("onboarding_state");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_connections_business_id_bot_external_id_key" ON "telegram_connections"("business_id", "bot_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_provisioning_ledgers_start_token_key" ON "telegram_provisioning_ledgers"("start_token");

-- CreateIndex
CREATE INDEX "telegram_provisioning_ledgers_business_id_idx" ON "telegram_provisioning_ledgers"("business_id");

-- CreateIndex
CREATE INDEX "telegram_provisioning_ledgers_connection_id_idx" ON "telegram_provisioning_ledgers"("connection_id");

-- AddForeignKey
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_connections" ADD CONSTRAINT "telegram_connections_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_provisioning_ledgers" ADD CONSTRAINT "telegram_provisioning_ledgers_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_provisioning_ledgers" ADD CONSTRAINT "telegram_provisioning_ledgers_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "telegram_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
