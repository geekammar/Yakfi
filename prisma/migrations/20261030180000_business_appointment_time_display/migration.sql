-- Customer appointment time display preference (START_ONLY vs FULL_RANGE).
-- Presentation-only: controls how appointment times are displayed to customers
-- in slot buttons, textual booking offers, and confirmations.
-- Defaults to 'START_ONLY' (البداية فقط) for existing and new businesses.

ALTER TABLE "businesses"
  ADD COLUMN "appointment_time_display" TEXT NOT NULL DEFAULT 'START_ONLY';
