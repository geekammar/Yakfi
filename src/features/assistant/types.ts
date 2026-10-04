/**
 * Assistant Settings feature types (PROMPT-AI-UX-01).
 *
 * The Business-facing "how does my assistant talk?" surface. Every field here
 * is a bounded communication choice — never a prompt, never a provider/model
 * reference, never a safety toggle.
 */

export type AssistantSettingsActionResult =
  { success: true } | { success: false; message: string };

/**
 * Serializable view of the business-owned assistant configuration. Every
 * field is a closed-enum value or optional display text; `name` is DISPLAY
 * copy only and never reaches the AI request. A null enum value means "no
 * business preference saved for this dimension" — the resident default
 * applies.
 */
export type AssistantSettingsView = {
  /** Display name; "" when the business has not set one (fallback applies). */
  name: string;
  language: string | null;
  tone: string | null;
  detail: string | null;
  emoji: string | null;
};

/**
 * The read-only handoff behaviors shown to the owner (SECTION F). These are
 * PLATFORM-enforced safety boundaries: they are surfaced as explained,
 * non-switchable behavior so the owner understands when the assistant hands
 * a conversation to a human, and a Business Admin can never disable them.
 */
export type HandoffBehavior = {
  /** Stable machine key (test assertions only, never customer-visible). */
  readonly key: string;
  /** Arabic heading the owner sees. */
  readonly label: string;
  /** Arabic explanation. */
  readonly description: string;
};

/**
 * One unresolved knowledge-gap review item (§13). The bounded slice of the
 * customer's own question plus the ONE authoritative editor it routes to.
 */
export type KnowledgeGapReviewItem = {
  id: string;
  /** The bounded slice of the customer's own question, when recorded. */
  subject: string;
  /** Arabic label for the missing knowledge family. */
  categoryLabel: string;
  /** The business-language explanation of what is missing. */
  title: string;
  /** The CTA label. */
  action: string;
  /** The EXISTING authoritative editor to jump to. */
  href: string;
};
