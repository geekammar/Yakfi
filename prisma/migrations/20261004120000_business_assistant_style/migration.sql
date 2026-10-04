-- AlterTable
-- PROMPT-AI-UX-01: additive, nullable assistant-configuration columns on
-- `businesses`. Two columns only:
--  * `assistant_name` — optional customer-facing display name for the
--    assistant. Display copy only; it never reaches the AI request.
--  * `assistant_style` — optional JSON holding the CLOSED, bounded style
--    subset the Business ADMIN owns (language / tone / detail / emoji).
--    Validated by Zod on every read; an absent/partial/unknown value
--    degrades to the resident default (never throws, never widens the
--    closed enums).
-- No backfill (absent = the resident default applies), no destructive
-- operation, no NOT NULL constraint, and no index (read only with the
-- Business record it belongs to). Dimensions the business does not own
-- (arabicStyle, role) are deliberately NOT stored.
ALTER TABLE "businesses" ADD COLUMN "assistant_name" TEXT;
ALTER TABLE "businesses" ADD COLUMN "assistant_style" JSONB;
