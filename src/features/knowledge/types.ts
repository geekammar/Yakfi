/**
 * Business Knowledge feature types (PROMPT-18, Spec A §6).
 *
 * Entries are the plain-text question/answer records the future AI
 * assistant will use when replying to customers — stored as JSON in
 * the canonical `Business.faqs` field (DECISIONS #13). No AI, no RAG,
 * no embeddings: content management only.
 */

/** Serializable knowledge entry view used by the management UI. */
export type KnowledgeEntryView = {
  question: string;
  answer: string;
};

/**
 * Static starter suggestions shown in the authoring UI (B-05). The
 * vertical label is display only; every suggestion is an editable
 * DRAFT that becomes stored knowledge only through the explicit create
 * path — it is never an automatically verified business fact.
 */
export type KnowledgeSuggestionView = {
  verticalLabel: string;
  suggestions: Array<{ question: string; answer: string }>;
};

export type KnowledgeActionResult =
  | { success: true; entries: KnowledgeEntryView[] }
  | { success: false; message: string };
