/**
 * WhatsApp identity display helpers (WHATSAPP-ONBOARDING-01).
 *
 * Provider identities are provenance/reference data: the operator needs
 * enough to recognize a connection, never enough to impersonate it. The
 * full `phone_number_id` and the raw phone number never need to appear
 * in a UI, so both are masked the same way everywhere they are shown
 * (Business settings, onboarding review, platform read surface).
 */

/**
 * Mask the provider connection identity for safe display: the full
 * `phone_number_id` is never needed by a Business Admin, so only the
 * head and tail are shown.
 */
export function maskExternalId(externalId: string | null): string | null {
  if (!externalId) return null;
  const trimmed = externalId.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}••`;
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

/**
 * Mask a phone number for operator display: keeps the country prefix
 * and enough digits to recognize the line. Returns null when absent.
 */
export function maskPhoneNumber(phone: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (trimmed.length <= 6) return "••";
  return `${trimmed.slice(0, -4)}••${trimmed.slice(-2)}`;
}
