-- CreateTable (UX-LAB-01C)
-- ONE platform-wide published override per canonical conversation-copy key.
-- There is deliberately NO business_id / tenant scoping anywhere in this
-- migration: overrides are PLATFORM-level only, so no tenant-scoped
-- override behavior can ever exist. Absence of a row IS the documented
-- "use the code default" state; RESET is a row removal. The stored text is
-- the founder-edited template (placeholders preserved), validated by the
-- UX-LAB-01B contract at the service layer before any write reaches here.
CREATE TABLE "platform_copy_overrides" (
    "id" TEXT NOT NULL,
    "copy_key" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "updated_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_copy_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_copy_overrides_copy_key_key" ON "platform_copy_overrides"("copy_key");

-- CreateTable
-- Bounded, append-only audit/history for ONE copy key (Founder-Lab
-- rollback support only — not a version-control system). previousText is
-- what was effective before the change (null ⇒ code default); resultText
-- is what became effective after (null ⇒ override removed). Either side is
-- enough to undo/redo. Retention is capped per key by the repository.
CREATE TABLE "platform_copy_override_history" (
    "id" TEXT NOT NULL,
    "copy_key" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "previous_text" TEXT,
    "result_text" TEXT,
    "actor_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_copy_override_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_copy_override_history_copy_key_created_at_idx" ON "platform_copy_override_history"("copy_key", "created_at");

-- AddForeignKey
ALTER TABLE "platform_copy_overrides" ADD CONSTRAINT "platform_copy_overrides_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_copy_override_history" ADD CONSTRAINT "platform_copy_override_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
