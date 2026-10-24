/**
 * Clarification handler (PROMPT-AI-ARCH-06 — Slice 4, first-class CLARIFY).
 *
 * The ONE resolver-owned, deterministic place that decides whether a turn is
 * safely CLARIFIABLE and, if so, composes exactly ONE bounded, grounded
 * clarification question (docs/ai/TARGET_ARCHITECTURE.md §3.11 / §7).
 *
 * Why it exists: a genuinely ambiguous-but-clarifiable turn used to fall
 * through to a human handoff (classifier `AMBIGUOUS` → `handoffReason:
 * "AMBIGUOUS"` → NEED_HUMAN). The target makes CLARIFY a first-class decision
 * class: the engine asks ONE question and stays `AI_ACTIVE` instead of
 * escalating, and resumes the pending task on the next turn.
 *
 * Responsibility split (binding):
 * - This handler only PROPOSES a clarification (type + the facts that are
 *   missing + a fixed, knowledge-free question). The Decision/Action Resolver
 *   (`turn-planner.ts`) OWNS whether CLARIFY actually fires, applying the
 *   existing safety precedence first (control > explicit human > sensitive >
 *   domain constraint). The engine OWNS emitting the reply and recording the
 *   pending state.
 * - It NEVER resolves domain truth: it does not query availability, invent
 *   slots, choose providers, or write appointments. It asks; the DOMAIN
 *   (CORE-01/CORE-02) decides and executes. CLARIFY resolves only MISSING
 *   CONVERSATIONAL INFORMATION.
 *
 * Disclosure safety (B-03, §16): a clarification question is a KNOWLEDGE-FREE
 * protocol by explicit policy — a fixed template that names NO service, price,
 * slot, policy, provider, or any business fact the customer did not already
 * state. So it crosses the customer boundary on its DECLARED class, never by
 * inspecting business knowledge, exactly like the GREETING knowledge-free
 * intent. The question templates below satisfy that policy by construction.
 *
 * Everything here is PURE and TOTAL: no I/O, no network, no DB, no provider,
 * no `process.env`, no secret, and ZERO model inference. The clarification is
 * produced inside the existing turn with no second generative round-trip.
 */

import type {
  AiResponse,
  HandoffReason,
} from "@/features/conversations/server/ai-contract";
import type {
  ConversationFactKey,
  ConversationState,
} from "@/features/conversations/server/conversation-state";

// ─── Vocabulary (aligned by value with the evaluation ClarificationType) ─────

/**
 * The clarification types the engine may emit. The names are aligned by VALUE
 * with the evaluation `ClarificationType` vocabulary (§7) so a future
 * observable scores cleanly — production NEVER imports the evaluation module.
 * `NONE` is the "no clarification" sentinel (not emitted; present for
 * completeness/observability).
 */
export const clarificationTypeValues = [
  "CLARIFY_SERVICE",
  "CLARIFY_DATE",
  "CLARIFY_TIME",
  "CLARIFY_PROVIDER",
  "CLARIFY_INTENT",
  "CLARIFY_DISAMBIGUATE_MULTI_INTENT",
  /**
   * The bounded contact-vs-book ambiguity (PROMPT-AI-JEV-03B §9): the customer's
   * intent is plausibly to REACH a provider OR to BOOK, and the semantic model
   * could not commit to either. ONE bounded question disambiguates it instead
   * of guessing a handoff or a booking. Proposed ONLY from the semantic path —
   * never from lexical keyword/regex tables.
   */
  "CLARIFY_CONTACT_OR_BOOK",
  "CONFIRM_UNDERSTOOD_REQUEST",
  "NONE",
] as const;

export type ClarificationType = (typeof clarificationTypeValues)[number];

/**
 * One proposed clarification: WHICH type, WHICH conversation facts are missing
 * (closed `ConversationFactKey` set — never a non-fact key), and the ONE fixed
 * customer-facing question. `missingFacts` may be empty (e.g. `CLARIFY_INTENT`
 * where the whole intent is unclear and no single fact is missing).
 */
export type ClarificationPlan = {
  readonly type: ClarificationType;
  readonly missingFacts: readonly ConversationFactKey[];
  readonly question: string;
};

// ─── Fixed, knowledge-free question templates ────────────────────────────────
//
// Customer-facing reply templates (the EXISTING convention in
// `conversation-ai.ts` REPLIES / booking error messages). Each names NO
// business fact, so each is knowledge-free by construction (B-03 §16). They
// ask exactly ONE question and invite a directly-actionable answer.

/** The generic intent clarification — the smallest useful question. */
export const CLARIFY_INTENT_QUESTION =
  "لم أفهم طلبك تماماً — ممكن توضّح أكثر؟ أقدر أساعدك في حجز موعد، أو معرفة الأوقات المتاحة، أو الرد على استفساراتك.";

/**
 * The bounded CONTACT-VS-BOOK clarification question
 * (PROMPT-AI-JEV-03B §9). A fixed, knowledge-free template naming ONLY the two
 * bounded supported actions the turn is genuinely ambiguous between — reach a
 * team member, or book an appointment. It names NO service, price, slot,
 * provider, policy, or any business fact, so it crosses the customer boundary
 * on its declared knowledge-free class exactly like the other clarification
 * protocols (B-03 §16). It asks exactly ONE question. It is deliberately NOT
 * business-specific copy: the generic intent wording stays the default until a
 * Product copy decision is made.
 */
export const CLARIFY_CONTACT_OR_BOOK_QUESTION =
  "ممكن توضّح طلبك أكثر — تحب تتكلم مع أحد أعضاء الفريق مباشرة، ولا تحب نحجز لك موعد؟";

/**
 * The INTERRUPTION-RECOVERY acknowledgment (PROMPT-AI-ARCH-08). A fixed,
 * knowledge-free ack emitted when a benign non-task interruption lands during a
 * resumable booking/domain task: it keeps the thread `AI_ACTIVE`, preserves the
 * pending task, and invites the customer to continue when ready. It names NO
 * service, price, slot, policy, or any business fact — so it crosses the
 * customer boundary on its declared class, exactly like the GREETING and
 * CLARIFY knowledge-free protocols (B-03 §16).
 */
export const INTERRUPTION_ACK_QUESTION =
  "خذ وقتك — أنا في انتظارك لإكمال طلبك متى ما كنت جاهزاً.";

/** The fixed CLARIFY_DATE question (the pending-date template). */
export const CLARIFY_DATE_QUESTION =
  "يرجى تحديد التاريخ المطلوب (مثال: غداً، أو اذكر يوماً وتاريخاً محدداً).";

/**
 * The ANSWER-AND-CONTINUE invitation (PROMPT-AI-ARCH-09 — Slice 5). A fixed,
 * knowledge-free continuation line the engine APPENDS to a knowledge answer
 * when the SAME customer turn also expressed a domain/booking goal: the engine
 * answers the knowledge question and, in the SAME single send, keeps the
 * booking task alive by inviting the customer to continue. It names NO service,
 * price, slot, policy, provider, or any business fact — so it crosses the
 * customer boundary on its declared knowledge-free class, exactly like the
 * GREETING / CLARIFY / interruption-ack protocols (B-03 §16). It is ALSO the
 * migration-safe history marker the next turn reads to reconstruct the pending
 * domain goal (`derivePendingContinuation`), so no new storage is required.
 */
export const CONTINUE_DOMAIN_INVITE =
  "وبخصوص طلب الحجز، أنا جاهز أكمل معك — تحب نحجز إمتى؟";

const QUESTION_BY_TYPE: Partial<Record<ClarificationType, string>> = {
  CLARIFY_INTENT: CLARIFY_INTENT_QUESTION,
  CLARIFY_CONTACT_OR_BOOK: CLARIFY_CONTACT_OR_BOOK_QUESTION,
  CLARIFY_SERVICE:
    "يرجى تحديد الخدمة المطلوبة — أخبرنا باسم الخدمة التي ترغب بحجزها.",
  CLARIFY_DATE: CLARIFY_DATE_QUESTION,
  CONFIRM_UNDERSTOOD_REQUEST: INTERRUPTION_ACK_QUESTION,
};

// ─── Clarifiability policy ───────────────────────────────────────────────────

/**
 * Handoff reasons that are NEVER clarifiable — they require (or already are)
 * their own non-CLARIFY outcome and must keep the existing behavior:
 * - HUMAN_REQUEST → the customer explicitly asked for a human (handoff wins).
 * - SENSITIVE     → sensitive/restricted handling (safety precedence).
 * - NO_KNOWLEDGE  → a genuine knowledge gap: asking a question will not help;
 *                   it stays a handoff (knowledge gap, not clarifiable).
 */
const NON_CLARIFIABLE_REASONS: ReadonlySet<HandoffReason> =
  new Set<HandoffReason>(["HUMAN_REQUEST", "SENSITIVE", "NO_KNOWLEDGE"]);

/**
 * Decide whether an already-normalized AI decision is safely CLARIFIABLE and,
 * if so, PROPOSE the clarification. Returns `null` when the turn must NOT
 * clarify (answerable, domain-executable, sensitive, explicit human, or a
 * genuine knowledge gap). The resolver applies safety precedence BEFORE
 * calling this; this function only encodes the clarifiability of a decision
 * that reached the normal-decision space.
 *
 * Current signal: the deterministic classifier marks a turn it could not
 * understand (too-short, or unrecognized text) as `intent: "AMBIGUOUS"` with
 * `handoffReason: "AMBIGUOUS"`. That is precisely "we understood the task is
 * unclear, ask the customer to clarify" — clarifiable. SENSITIVE / NO_KNOWLEDGE
 * / HUMAN_REQUEST are explicitly excluded above. A future LLM may instead
 * PROPOSE a structured `clarification`; that is honored only when the decision
 * is not an excluded (human/sensitive/knowledge-gap) handoff.
 */
export function planClarification(
  decision: AiResponse,
  state: ConversationState,
): ClarificationPlan | null {
  // Only a HANDOFF turn is convertible to CLARIFY. A `reply` (an answer) or a
  // `booking_handoff` (a domain action) is NOT clarified — a turn that can be
  // answered or executed is never turned into a question. This also means a
  // model that proposes a `clarification` alongside a real answer keeps the
  // answer; the proposal matters only when the model could not answer and
  // chose to escalate.
  if (decision.action !== "handoff") return null;

  // Explicit human request is never clarifiable (precedence also catches it).
  if (decision.intent === "HUMAN_REQUEST") return null;

  const reason = decision.handoffReason;
  if (reason && NON_CLARIFIABLE_REASONS.has(reason)) return null;

  // A model-proposed clarification (future LLM path) — honored only when the
  // decision is a non-excluded handoff (checked above). The engine still owns
  // the final question text via the type → template mapping, so the model can
  // never smuggle customer-facing content or an unapproved fact through the
  // clarification channel.
  if (decision.clarification) {
    const type = normalizeType(decision.clarification.type);
    const missingFacts = missingFactsFrom(
      decision.clarification.missingFacts,
      state,
    );
    // ANTI-REPETITION / RESUME (PROMPT-AI-EVAL-07 §7): never re-ask a
    // fact-specific clarification whose fact the state already knows. When a
    // CLARIFY_SERVICE/DATE/TIME/PROVIDER names a fact the customer has already
    // supplied (e.g. a bare date answered the pending CLARIFY_DATE), there is
    // nothing left to clarify — the pending task RESUMES instead of asking the
    // same question again. CLARIFY_INTENT (no implied fact) is unaffected.
    const implied = impliedFactKey(type);
    if (implied && state.knownFacts[implied] != null) return null;
    if (implied && missingFacts.length === 0) return null;
    return composeClarification(type, missingFacts);
  }

  // The deterministic clarifiable signal: an AMBIGUOUS-reason handoff.
  if (reason === "AMBIGUOUS") {
    return composeClarification("CLARIFY_INTENT", []);
  }

  return null;
}

/**
 * Map a booking-seam missing-fact outcome to a first-class clarification plan.
 * The booking mapper (the DOMAIN boundary) already authors the customer
 * message and stays `AI_ACTIVE` for a missing/ambiguous service or a missing
 * date; this only LABELS that existing clarification as a first-class CLARIFY
 * for state + observability. The caller supplies the mapper's own message as
 * the question — the domain keeps authorship.
 */
export function clarificationForBookingReason(
  reason: "MISSING_SERVICE" | "AMBIGUOUS_SERVICE" | "MISSING_DATE",
  question: string,
): ClarificationPlan {
  switch (reason) {
    case "MISSING_SERVICE":
      return { type: "CLARIFY_SERVICE", missingFacts: ["service"], question };
    case "AMBIGUOUS_SERVICE":
      return { type: "CLARIFY_SERVICE", missingFacts: ["service"], question };
    case "MISSING_DATE":
      return { type: "CLARIFY_DATE", missingFacts: ["date"], question };
  }
}

/**
 * Rebuild a clarification plan from an ALREADY-RECORDED pending clarification
 * (its type + the still-missing conversation facts). Used by the resolver to
 * RE-ASK the pending question when a legitimate topic interruption must
 * preserve the pending task and stay AI_ACTIVE (PROMPT-AI-EVAL-07 interruption
 * recovery) — it never authors a NEW clarification, only re-emits the bounded,
 * knowledge-free question the engine already owns. Returns null when there is
 * no recorded pending clarification type.
 */
export function clarificationForPending(
  type: string | null | undefined,
  missingFacts: readonly ConversationFactKey[],
): ClarificationPlan | null {
  if (!type) return null;
  return composeClarification(normalizeType(type), missingFacts);
}

/**
 * Compose the INTERRUPTION-RECOVERY acknowledgment (PROMPT-AI-ARCH-08). Used by
 * the engine when a benign non-task interruption lands during a RESUMABLE
 * booking/domain task that has NO pending clarification to re-ask (e.g. a
 * presented offer). It preserves the pending task and keeps the thread
 * `AI_ACTIVE` by emitting the fixed, knowledge-free ack — it never authors a
 * new business fact, never resolves domain truth, and never escalates. The
 * pending task survives in ConversationState (INTERRUPTED), so the next turn
 * resumes it deterministically.
 */
export function clarificationForInterruption(): ClarificationPlan {
  return {
    type: "CONFIRM_UNDERSTOOD_REQUEST",
    missingFacts: [],
    question: INTERRUPTION_ACK_QUESTION,
  };
}

/**
 * Reconstruct a PENDING clarification from the already-persisted conversation
 * history (the migration-safe seam §9 — the same approach the offer seam uses:
 * state derived from history, no new storage). It recognizes the engine's OWN
 * clarification templates in the most recent assistant message, so a derived
 * pending clarification can never diverge from what the engine actually asked.
 *
 * The engine persists the CURRENT customer message BEFORE deriving state, so
 * the chronological tail is the customer's answer. This skips the trailing
 * customer/staff turns and inspects the most recent ASSISTANT message: when it
 * is one of the engine's clarification templates, THAT is the pending
 * clarification the current turn is answering — the seam the supplied-fact
 * RESUME depends on (PROMPT-AI-EVAL-07). A non-clarification last AI message
 * (an answer, options, a greeting) yields null — nothing is pending.
 *
 * Pure and deterministic; it reads only the structured template text the
 * engine authored, never the customer's words and never a model.
 */
export function derivePendingClarification(
  recentChronological: ReadonlyArray<{ senderType: string; content: string }>,
): {
  readonly type: ClarificationType;
  readonly missingFacts: readonly ConversationFactKey[];
} | null {
  // Find the most recent ASSISTANT message, skipping the trailing customer /
  // staff turns (the current answer being given this turn).
  let lastAi: string | null = null;
  for (let i = recentChronological.length - 1; i >= 0; i -= 1) {
    const entry = recentChronological[i]!;
    if (entry.senderType === "AI") {
      lastAi = entry.content;
      break;
    }
  }
  if (!lastAi) return null;

  if (lastAi.includes(CLARIFY_INTENT_QUESTION)) {
    return { type: "CLARIFY_INTENT", missingFacts: [] };
  }
  if (lastAi.includes("يرجى تحديد الخدمة المطلوبة")) {
    return { type: "CLARIFY_SERVICE", missingFacts: ["service"] };
  }
  if (lastAi.includes("هناك أكثر من خدمة تطابق")) {
    return { type: "CLARIFY_SERVICE", missingFacts: ["service"] };
  }
  if (lastAi.includes("الخدمة المطلوبة لم تعد متاحة")) {
    return { type: "CLARIFY_SERVICE", missingFacts: ["service"] };
  }
  if (lastAi.includes("الخدمات المتاحة لدينا")) {
    return { type: "CLARIFY_SERVICE", missingFacts: ["service"] };
  }
  if (lastAi.includes("يرجى تحديد التاريخ المطلوب")) {
    return { type: "CLARIFY_DATE", missingFacts: ["date"] };
  }
  // PROMPT-AI-JEV-03B §9 — the bounded contact-vs-book question is a pending
  // clarification too: recognizing it here lets the EXISTING anti-repeat +
  // resume machinery re-ask it (precedence rule 6) instead of escalating, and
  // lets a later supplied fact resume the task through the ONE merge path.
  if (lastAi.includes("تحب تتكلم مع أحد أعضاء الفريق")) {
    return { type: "CLARIFY_CONTACT_OR_BOOK", missingFacts: [] };
  }
  return null;
}

/**
 * Reconstruct a PENDING DOMAIN goal from the already-persisted history
 * (PROMPT-AI-ARCH-09 — Slice 5). When an earlier answer-and-continue turn
 * appended the knowledge-free `CONTINUE_DOMAIN_INVITE` to its answer, that line
 * is the migration-safe marker (the SAME approach `derivePendingClarification`
 * uses) that the engine still owes the customer a BOOKING continuation. It
 * inspects the most recent ASSISTANT message, skipping the trailing customer /
 * staff turns (the current answer). Returns the pending goal's intent, or null
 * when nothing is pending.
 *
 * Pure and deterministic; it reads only the structured template the engine
 * authored, never the customer's words and never a model.
 */
export function derivePendingContinuation(
  recentChronological: ReadonlyArray<{ senderType: string; content: string }>,
): { readonly intent: string } | null {
  let lastAi: string | null = null;
  for (let i = recentChronological.length - 1; i >= 0; i -= 1) {
    const entry = recentChronological[i]!;
    if (entry.senderType === "AI") {
      lastAi = entry.content;
      break;
    }
  }
  if (!lastAi) return null;
  return lastAi.includes(CONTINUE_DOMAIN_INVITE) ? { intent: "BOOKING" } : null;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

const CONVERSATION_FACT_KEYS: ReadonlySet<string> = new Set([
  "service",
  "date",
  "timePreference",
  "provider",
  "customerName",
]);

function missingFactsFrom(
  proposed: readonly string[] | undefined,
  state: ConversationState,
): ConversationFactKey[] {
  if (!proposed) return [];
  // Keep only closed conversation-fact keys, and only ones NOT already known
  // (never ask for information already supplied — §7 anti-repetition bound).
  const out: ConversationFactKey[] = [];
  for (const key of proposed) {
    if (!CONVERSATION_FACT_KEYS.has(key)) continue;
    const factKey = key as ConversationFactKey;
    if (state.knownFacts[factKey] != null) continue;
    if (!out.includes(factKey)) out.push(factKey);
  }
  return out;
}

const CLARIFICATION_TYPE_SET: ReadonlySet<string> = new Set(
  clarificationTypeValues,
);

/** The conversation fact a fact-specific clarification type asks about. */
function impliedFactKey(type: ClarificationType): ConversationFactKey | null {
  switch (type) {
    case "CLARIFY_SERVICE":
      return "service";
    case "CLARIFY_DATE":
      return "date";
    case "CLARIFY_TIME":
      return "timePreference";
    case "CLARIFY_PROVIDER":
      return "provider";
    default:
      return null;
  }
}

function normalizeType(type: string): ClarificationType {
  return CLARIFICATION_TYPE_SET.has(type)
    ? (type as ClarificationType)
    : "CLARIFY_INTENT";
}

function composeClarification(
  type: ClarificationType,
  missingFacts: readonly ConversationFactKey[],
): ClarificationPlan {
  const question = QUESTION_BY_TYPE[type] ?? CLARIFY_INTENT_QUESTION;
  return { type, missingFacts, question };
}
