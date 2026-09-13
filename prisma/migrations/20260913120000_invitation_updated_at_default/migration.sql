-- PROMPT-ARCH-03: align the migration-chain end-state with prisma/schema.prisma.
--
-- The committed 20260902120000_invitation_model migration (hand-authored
-- in the pre-baseline era) created invitations.updated_at without the
-- DEFAULT CURRENT_TIMESTAMP that Invitation.updatedAt
-- @default(now()) @updatedAt implies. This repair is additive and
-- idempotent: SET DEFAULT never rewrites rows, and on databases that
-- already carry the default (the db-push-era Demo database) it is a no-op.
ALTER TABLE "invitations" ALTER COLUMN "updated_at" SET DEFAULT CURRENT_TIMESTAMP;
