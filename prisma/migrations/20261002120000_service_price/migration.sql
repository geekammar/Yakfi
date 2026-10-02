-- Service price — authoritative, OPTIONAL, per-service DOMAIN price
-- (PROMPT-AI-ARCH-13 — Slice 6: Service Pricing Foundation).
--
-- ADDITIVE ONLY: five new NULLABLE columns on the EXISTING `services` table.
-- No existing column, constraint, index, or table is renamed, reinterpreted,
-- or dropped; NO data is backfilled and NO default price is fabricated —
-- every pre-existing Service row stays valid with all five columns NULL
-- (i.e. "no price", which the assistant treats as NO_KNOWLEDGE, never an
-- invented amount). Backward-compatible by construction.
--
-- WHY: price had no authoritative production channel (ARCH-12 forensic:
-- EVAL-14 price cases were correctly NO_KNOWLEDGE because no stored price
-- existed). This establishes the smallest structured representation that can
-- carry the real discovery cases — FIXED / RANGE / STARTING_FROM /
-- CONDITIONAL — on the Service CATALOG, the canonical domain home. It is NOT
-- a pricing engine: no discounts, tax, coupons, dynamic rules, history,
-- plans, entitlements, or billing. `price_type` is a stable machine key
-- (validated by the Zod union in `lib/service-price`, no Prisma enum, so
-- extending needs no migration — the confirmationMode / vertical pattern);
-- `price_amount` / `price_max_amount` are whole currency units;
-- `price_currency` is an ISO machine key; `price_note` is the bounded
-- human-readable CONDITIONAL text. Price is NEVER duplicated into the FAQ
-- store. WhatsApp, Telegram, the Conversation Engine, booking, and every
-- other table are completely untouched.

-- AlterTable
ALTER TABLE "services" ADD COLUMN "price_type" TEXT;
ALTER TABLE "services" ADD COLUMN "price_amount" INTEGER;
ALTER TABLE "services" ADD COLUMN "price_max_amount" INTEGER;
ALTER TABLE "services" ADD COLUMN "price_currency" TEXT;
ALTER TABLE "services" ADD COLUMN "price_note" TEXT;
