/**
 * Customer disclosure boundary — public surface (PROMPT-B03).
 *
 * The enforcement gate between an assistant result and a customer-visible
 * reply. It consumes the B-02 disclosure ledger and the B-01 visibility
 * verdicts recorded in it, and decides per turn whether the assistant's
 * reply may reach the customer or must defer to the existing human handoff.
 *
 * Canonical documentation: `docs/ai/ARCHITECTURE.md → Customer disclosure
 * boundary`. Decision record: DECISIONS #52.
 */

export {
  DISCLOSURE_DECISION_VALUES,
  DISCLOSURE_GATE_NEVER_HOLDS_SECRETS,
  DISCLOSURE_REFUSAL_REASONS,
  KNOWLEDGE_FREE_REPLY_INTENTS,
  TASK_SUPPORT_FAMILIES,
  channelCarried,
  enforceDisclosure,
  isExplicitIdentityGoal,
  isExplicitIdentityResponse,
  resolveKnowledgeProposal,
  buildBusinessAboutContent,
  buildBusinessAddressContent,
  buildBusinessIdentityContent,
  buildServiceCatalogContent,
  buildServiceDescriptionContent,
  buildServicePriceContent,
  type DisclosureDecision,
  type DisclosureInput,
  type DisclosureRefusalReason,
  type DisclosureResult,
  type ResolvedKnowledgeProposal,
  type SupportChannel,
  type TaskSupportFamily,
} from "./disclosure-gate";
