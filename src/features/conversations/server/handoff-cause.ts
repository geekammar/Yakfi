/**
 * Typed handoff cause taxonomy + operator mapping (PROMPT-AI-ARCH-16 — Slice 7).
 *
 * PURPOSE — make the already-existing `NEED_HUMAN` behavior typed, explicit,
 * explainable and useful to the operator end-to-end. This module does NOT
 * decide whether a handoff occurs: the authoritative decision stays with the
 * existing Conversation Engine branches and the deterministic resolver /
 * safety precedence. It only types and explains an ALREADY-DECIDED handoff:
 *
 *     resolver / engine decides  →  this module derives the cause  →
 *     the operator mapping explains it
 *
 * The taxonomy is the one the project already committed to
 * (`docs/ai/TARGET_ARCHITECTURE.md §8` + the `aiHandoffCauseSchema` comment in
 * `ai-contract.ts`). It is deliberately MINIMAL and stable — it describes WHY
 * human attention is required, never implementation details, and it is a
 * separate dimension from intent (`intent = FAQ, cause = KNOWLEDGE_GAP`) and
 * from the coarse operator-attention `reason`.
 *
 * Binding rules:
 *  - The cause is SERVER-AUTHORITATIVE. The model's own bounded
 *    `AiResponse.handoffReason` (a closed 4-value enum) is one INPUT; the
 *    model's free-form `handoffCause` string is NEVER trusted as the canonical
 *    cause. The AI is never the authority for safety, human precedence,
 *    domain constraints or missing authoritative knowledge.
 *  - Derivation runs AFTER the authoritative resolver/safety decision, so it
 *    can never change a turn's outcome — a safety-required handoff can never
 *    be downgraded because another cause exists.
 *  - No chain-of-thought, no hidden model reasoning, no resolver internals,
 *    no stack traces, no provider identity and no secrets ever reach the
 *    operator — only plain operational language.
 *  - No second resolver / state model / planner / classifier / engine. The
 *    mappers below are pure functions over already-decided signals.
 */
import type { HandoffReason as ContractHandoffReason } from "@/features/conversations/server/ai-contract";
import type { HandoffReason as ControlHandoffReason } from "@/server/integrations/ai/conversation-control/types";

import { z } from "zod";

// ─── Canonical taxonomy ─────────────────────────────────────────────────────
/**
 * The canonical, stable set of reasons a conversation leaves the AI thread.
 * Each answers "why does this conversation need me?" from deterministic
 * product state. Values are machine keys (the codebase pattern — no Prisma
 * enum, so extending the list needs no data migration).
 */
export const handoffCauseValues = [
  /** The customer explicitly asked for a human (deterministic match). */
  "CUSTOMER_REQUESTED_HUMAN",
  /** A sensitive / restricted topic the assistant must not handle alone. */
  "SENSITIVE_OR_RESTRICTED",
  /** An authoritative domain result routed the task to staff (policy/availability). */
  "DOMAIN_REQUIRES_HUMAN",
  /** Answerable-by-human knowledge is missing after exposure + clarify attempts. */
  "KNOWLEDGE_GAP_UNRESOLVED",
  /** Genuinely ambiguous after a safe clarify attempt. */
  "AMBIGUITY_UNRESOLVED",
  /** The disclosure gate refused an unbacked self-authored reply (B-03). */
  "POLICY_REFUSED",
  /** A provider/runtime failure after the bounded attempts (Conversation Control). */
  "PROVIDER_FAILURE",
  /** The assistant's structured output was absent or invalid. */
  "AI_FAILURE",
  /** Business / branch / service misconfiguration blocks the task. */
  "TENANT_CONFIGURATION",
  /** The bounded retry / fallback budget was spent. */
  "RETRY_EXHAUSTED",
] as const;

export type HandoffCause = (typeof handoffCauseValues)[number];

export const handoffCauseSchema = z.enum(handoffCauseValues);

/**
 * Parse an arbitrary stored value into a canonical cause. FAILS SAFE: an
 * unknown / legacy / malformed value yields `null` — it can never silently
 * become a misleading cause (and `null` simply means "no typed cause
 * recorded", which renders as the existing coarse attention reason).
 */
export function parseHandoffCause(value: unknown): HandoffCause | null {
  return handoffCauseSchema.safeParse(value).success
    ? (value as HandoffCause)
    : null;
}

// ─── Operator mapping (deterministic + centralized) ─────────────────────────
/**
 * The ONE operator-facing presentation for a canonical cause. Arabic-first,
 * plain operational language, implementation-independent: no AI internals, no
 * disclosure-policy names, no provider identity, no resolver jargon. The
 * operator sees what they need to act, nothing more.
 */
export type HandoffCausePresentation = {
  /** Short stable label (operator UI chip). */
  readonly label: string;
  /** Bounded human-readable explanation ("why does this need me?"). */
  readonly description: string;
};

export const HANDOFF_CAUSE_PRESENTATIONS: Readonly<
  Record<HandoffCause, HandoffCausePresentation>
> = {
  CUSTOMER_REQUESTED_HUMAN: {
    label: "العميل طلب مسؤولاً",
    description: "طلب العميل صراحةً التحدث إلى أحد أعضاء الفريق.",
  },
  SENSITIVE_OR_RESTRICTED: {
    label: "طلب حسّاس",
    description: "طبيعة هذا الطلب تتطلّب تدخلاً بشرياً مباشراً.",
  },
  DOMAIN_REQUIRES_HUMAN: {
    label: "يتطلّب قراراً بشرياً",
    description:
      "تعذّر إتمام هذا الطلب تلقائياً وفقاً لقواعد المنشأة، ويحتاج إلى قرار من الفريق.",
  },
  KNOWLEDGE_GAP_UNRESOLVED: {
    label: "المعلومات غير متوفرة",
    description: "لا يملك المساعد المعلومات اللازمة للرد على هذا الطلب.",
  },
  AMBIGUITY_UNRESOLVED: {
    label: "الطلب غير واضح",
    description: "لم يتّضح قصد العميل رغم طلب التوضيح من المساعد.",
  },
  POLICY_REFUSED: {
    label: "تعذّر تأكيد الرد",
    description: "لم يستطع المساعد تأكيد الرد من المصادر الموثوقة للمنشأة.",
  },
  PROVIDER_FAILURE: {
    label: "مشكلة مؤقتة",
    description: "واجه المساعد صعوبة فنية مؤقتة أثناء الرد.",
  },
  AI_FAILURE: {
    label: "رد غير صالح",
    description: "جاء رد المساعد بصيغة لا يمكن اعتمادها بأمان.",
  },
  TENANT_CONFIGURATION: {
    label: "إعداد ناقص",
    description:
      "يحتاج إعداد المنشأة أو الفرع أو الخدمة إلى مراجعة قبل إتمام هذا الطلب.",
  },
  RETRY_EXHAUSTED: {
    label: "استنفاد المحاولات",
    description: "حاول المساعد الرد عدة مرات دون نجاح.",
  },
};

/** The stable operator label for a canonical cause. */
export function handoffCauseLabel(cause: HandoffCause): string {
  return HANDOFF_CAUSE_PRESENTATIONS[cause].label;
}

/** The bounded operator explanation for a canonical cause. */
export function describeHandoffCause(cause: HandoffCause): string {
  return HANDOFF_CAUSE_PRESENTATIONS[cause].description;
}

// ─── Cause derivation (pure mappers over already-decided signals) ───────────

/**
 * Map the EXISTING AI-contract handoff reasons (`ai-contract.ts`, a closed
 * 4-value Zod enum the model emits) onto the canonical cause taxonomy. The
 * contract is NOT changed. `null` in → `null` out (a reply turn has no cause).
 */
export function contractHandoffReasonToCause(
  reason: ContractHandoffReason | null,
): HandoffCause | null {
  if (reason === null) return null;
  switch (reason) {
    case "HUMAN_REQUEST":
      return "CUSTOMER_REQUESTED_HUMAN";
    case "SENSITIVE":
      return "SENSITIVE_OR_RESTRICTED";
    case "NO_KNOWLEDGE":
      return "KNOWLEDGE_GAP_UNRESOLVED";
    case "AMBIGUOUS":
      return "AMBIGUITY_UNRESOLVED";
    default:
      // Exhaustiveness guard — any future contract reason stays safe (no
      // silent mislabeling).
      return null;
  }
}

/**
 * Map the Conversation Control layer's provider-neutral handoff reasons onto
 * the canonical cause taxonomy. The control layer's taxonomy is NOT changed.
 * This is the seam that keeps a provider/runtime failure distinguishable from
 * a knowledge gap — the existing architecture already separates them, this
 * only types the distinction for the operator.
 */
export function controlHandoffReasonToCause(
  reason: ControlHandoffReason | null,
): HandoffCause | null {
  if (reason === null) return null;
  switch (reason) {
    case "CUSTOMER_REQUESTED_HUMAN":
      return "CUSTOMER_REQUESTED_HUMAN";
    case "SENSITIVE_OR_RESTRICTED_REQUEST":
      return "SENSITIVE_OR_RESTRICTED";
    case "RETRY_EXHAUSTED":
      return "RETRY_EXHAUSTED";
    case "PROVIDER_UNAVAILABLE":
    case "QUOTA_EXHAUSTED":
    case "AUTH_OR_CONFIGURATION_FAILURE":
      return "PROVIDER_FAILURE";
    case "UNSUPPORTED_REQUEST":
      // The provider answered in a shape the contract rejects — the
      // assistant's output was invalid, not a provider outage.
      return "AI_FAILURE";
    case "AI_REQUESTED_HANDOFF":
      // The model asked staff to take over a task the engine could not
      // classify further (a booking/domain escalation) — the safest
      // operational reading is a domain task needing a human.
      return "DOMAIN_REQUIRES_HUMAN";
    default:
      // Exhaustiveness guard — any future control reason stays safe.
      return null;
  }
}

/**
 * Map a booking-eligibility failure code (CORE-01, the authoritative domain
 * source of truth) onto the canonical cause. Configuration-shaped failures
 * (missing business / branch / service) are a TENANT_CONFIGURATION cause —
 * the operator can actually fix those — while the rest are domain constraints
 * that need a human decision.
 */
export function eligibilityFailureCodeToCause(code: string): HandoffCause {
  switch (code) {
    case "NO_BUSINESS":
    case "BRANCH_NOT_FOUND":
    case "SERVICE_NOT_FOUND":
    case "SERVICE_INACTIVE":
      return "TENANT_CONFIGURATION";
    default:
      return "DOMAIN_REQUIRES_HUMAN";
  }
}
