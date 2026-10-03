-- AlterTable
-- PROMPT-AI-OPS-21: additive, nullable customer-facing address line on
-- `businesses`. This is the smallest provider-neutral location
-- representation the assistant needs to answer "أين موقعكم؟". No backfill
-- (a missing address means "no location knowledge" — never invented), no
-- destructive operation, no NOT NULL constraint, and no index (it is never
-- a query key — it is only read with the Business record it belongs to).
ALTER TABLE "businesses" ADD COLUMN "address" TEXT;
