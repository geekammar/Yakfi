-- Readable interaction history without changing booking authority (Yakfi)
--
-- ADDITIVE ONLY: TWO new NULLABLE columns on the EXISTING `messages` table.
-- No existing column, constraint, index, or table is renamed, reinterpreted, or dropped;
-- NO data is backfilled — every pre-existing row stays valid with NULL display_text
-- and metadata. Backward-compatible by construction.
--
-- `display_text`: The human-readable snapshot text derived from validated offer
-- selections (e.g. chosen service, provider, date, or slot time) or truthful neutral
-- wording for stale/invalid interactions.
--
-- `metadata`: Structured interaction metadata (provenance, offer snapshot, action)
-- preserving raw values for audit, inspection, and verification.

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "display_text" TEXT;
ALTER TABLE "messages" ADD COLUMN "metadata" JSONB;
