/**
 * Decision / Action Resolver + TurnPlan (PROMPT-AI-ARCH-05 — Slice 3).
 *
 * The ONE engine-owned, deterministic place that converts an already-made,
 * normalized AI decision — together with the engine-owned
 * `ConversationState` (Slice 2), the existing deterministic/control routing,
 * authoritative domain facts/results where already available, and the
 * existing safety/handoff constraints — into ONE ordered `TurnPlan` for the
 * current turn (docs/ai/TARGET_ARCHITECTURE.md §3.10 / §4 / §5).
 *
 * Responsibility split (binding):
 * - This resolver CHOOSES the action class and the ordered plan.
 * - It does NOT execute domain mutations: it never queries Prisma, never
 *   invents availability or slots, never performs booking writes, never
 *   mutates appointments, and never bypasses tenant/business scope. The
 *   DOMAIN (CORE-01/CORE-02 + `createWithConflictCheck`) stays authoritative
 *   over domain truth; this resolver may only INSPECT an already-computed
 *   domain outcome.
 * - It consumes the normalized AI contract only — no provider identity, no
 *   prompt text, no raw provider payload, no model name. Provider selection
 *   stays behind the existing provider seam.
 *
 * Everything here is PURE and TOTAL: no I/O, no network, no DB, no provider,
 * no `process.env`, no secret, and ZERO model inference. The same inputs
 * always yield the same `ResolvedTurn`, so it is deterministic and
 * offline-testable in isolation.
 *
 * SCOPE (deliberate non-goals, after PROMPT-AI-ARCH-06 — Slice 4):
 * - SINGLE-GOAL ONLY: the plan carries exactly ONE ordered step and remains
 *   compatible with the current single-goal execution model. The decision's
 *   `goals[]` capacity is NOT collapsed — the resolver reads the PRIMARY
 *   goal and leaves the remaining goals untouched in the contract/state for
 *   a later multi-intent slice.
 * - CLARIFY is now FIRST-CLASS (Slice 4): a genuinely clarifiable turn (an
 *   `AMBIGUOUS`-reason handoff, or a model-proposed clarification) resolves to
 *   `CLARIFY` — ONE bounded question, no human handoff — INSTEAD of escalating.
 *   The clarification is proposed by the resolver-owned clarification handler
 *   (`clarification.ts`); the resolver applies safety precedence first, so
 *   CLARIFY NEVER overrides a control command, an explicit human request, a
 *   sensitive/restricted turn, or an authoritative domain constraint, and a
 *   genuine knowledge gap (`NO_KNOWLEDGE`) stays a handoff. CLARIFY resolves
 *   only MISSING CONVERSATIONAL INFORMATION; it never resolves domain truth.
 * - Multi-intent execution is NOT implemented (no second send, no secondary
 *   goal sequencing).
 * - The handoff lifecycle is NOT redesigned: the resolver only maps an
 *   already-established human-required condition to `HANDOFF` and carries the
 *   EXISTING `HandoffReason`. The explicit handoff-cause taxonomy is a later
 *   slice; this resolver never silently converts UNKNOWN / AMBIGUITY /
 *   KNOWLEDGE_GAP / PROVIDER_FAILURE into a human handoff.
 *
 * There is NO second decision representation: the plan reuses the canonical
 * `AiTurnPlan` (`ai-contract.ts`), and the primary goal is derived through
 * the ONE canonical synthesis bridge (`synthesizeDecisionGoals`).
 */

import type {
  AiGoal,
  AiGoalKind,
  AiResponse,
  AiTurnPlan,
  HandoffReason,
} from "@/features/conversations/server/ai-contract";
import { synthesizeDecisionGoals } from "@/features/conversations/server/ai-contract";
import type { AiRoutingDecision } from "@/features/conversations/server/ai-observability";
import type { ClarificationPlan } from "@/features/conversations/server/clarification";
import {
  clarificationForPending,
  planClarification,
} from "@/features/conversations/server/clarification";
import type { ConversationState } from "@/features/conversations/server/conversation-state";
import { isTaskGoal } from "@/features/conversations/server/conversation-state";

// ─── Decision precedence (explicit, ordered, testable) ───────────────────────

/**
 * The deterministic precedence the resolver applies, HIGHEST first. It
 * formalizes the existing correct ordering (derived from the current engine
 * flow + TARGET_ARCHITECTURE §4) so an unsafe or authoritative constraint can
 * never be overridden by a lower-priority AI suggestion:
 *
 *   1. CONTROL_COMMAND       — a hard, already-decided control outcome
 *                              (e.g. a thread deferred to staff): the AI
 *                              suggestion for this turn cannot override it.
 *   2. EXPLICIT_HUMAN_REQUEST— the customer explicitly asked for a human. The
 *                              DETERMINISTIC signal (`signals.explicitHuman`)
 *                              is AUTHORITATIVE and always fires; a model-only
 *                              human claim fires too, EXCEPT during a pending
 *                              task where it is treated as a benign
 *                              interruption (rule 6).
 *   3. SAFETY_RESTRICTED     — sensitive / restricted content handling. The
 *                              DETERMINISTIC signal (`signals.sensitive`) is
 *                              AUTHORITATIVE: a safety-required turn hands off
 *                              even when the model proposed a clarification
 *                              (PROMPT-AI-EVAL-07 safety precedence).
 *   4. DOMAIN_CONSTRAINT     — an authoritative domain result requires a
 *                              human (eligibility / availability blocked);
 *                              domain truth always wins over an AI claim.
 *   5. DOMAIN_DECISION       — an existing cancellation / reschedule /
 *                              booking / availability action proceeds.
 *   6. PENDING_TASK_PRESERVED— a legitimate topic interruption during a
 *                              pending task (a CLARIFY/booking in progress):
 *                              the pending task is PRESERVED and the engine
 *                              stays AI_ACTIVE (re-asking the pending
 *                              clarification) INSTEAD of escalating. Reached
 *                              only after 1–5 could not fire, so an
 *                              independent handoff condition (explicit human,
 *                              sensitive, domain-blocked, knowledge gap) still
 *                              wins; a benign pause never becomes a handoff.
 *   7. CLARIFY_DECISION      — a clarifiable turn asks ONE bounded question
 *                              (stays AI_ACTIVE) INSTEAD of handing off. It is
 *                              reached only AFTER 1–6 could not fire, so it can
 *                              never override safety, an explicit human, or an
 *                              authoritative domain constraint.
 *   8. NORMAL_DECISION       — a normal answer, or the existing knowledge-gap /
 *                              genuinely-ambiguous handoff from existing policy.
 *
 * No new policy is invented: rules 1–5 and 8 mirror branches the current engine
 * already takes; rule 7 converts a clarifiable ambiguous handoff into a bounded
 * question (Slice 4); rule 6 preserves a pending task across a benign
 * interruption (PROMPT-AI-EVAL-07). The resolver only makes the ordering
 * explicit and consults the deterministic safety signals authoritatively.
 */
export const turnPrecedenceRules = [
  "CONTROL_COMMAND",
  "EXPLICIT_HUMAN_REQUEST",
  "SAFETY_RESTRICTED",
  "DOMAIN_CONSTRAINT",
  "DOMAIN_DECISION",
  "PENDING_TASK_PRESERVED",
  "CLARIFY_DECISION",
  "NORMAL_DECISION",
] as const;

export type TurnPrecedenceRule = (typeof turnPrecedenceRules)[number];

/** Numeric rank for a precedence rule (lower = higher precedence). */
export function precedenceRank(rule: TurnPrecedenceRule): number {
  return turnPrecedenceRules.indexOf(rule);
}

// ─── Inputs ───────────────────────────────────────────────────────────────

/**
 * An ALREADY-COMPUTED authoritative domain outcome the resolver may INSPECT.
 * The resolver never computes any of these — the DOMAIN (CORE-01/CORE-02)
 * does, and remains authoritative. `PENDING` means the domain has not run (or
 * is not applicable) for this turn, so the resolver defers to the AI decision
 * + state (this is the default the shadow boundary passes today).
 */
export type ResolverDomainOutcome =
  /** Domain not consulted yet / not applicable this turn. */
  | { readonly kind: "PENDING" }
  /** Domain presented concrete, bookable options (the action proceeds). */
  | { readonly kind: "OPTIONS" }
  /** Domain completed the action (e.g. a booking was written). */
  | { readonly kind: "COMPLETED" }
  /**
   * Domain requires a human (eligibility/availability/config blocked). This
   * is the authoritative constraint an AI "reply" claim can never override.
   */
  | { readonly kind: "BLOCKED"; readonly handoffReason?: HandoffReason };

/**
 * A hard, already-decided control outcome that pre-empts the AI decision
 * entirely (precedence rule 1). It is OPTIONAL; the normal AI turn supplies
 * none. When present, the resolver returns it verbatim — the AI suggestion
 * cannot override a hard control for the turn.
 */
export type ResolverControlOutcome = {
  readonly decisionClass: AiGoalKind;
  readonly handoffReason?: HandoffReason | null;
};

/**
 * The DETERMINISTIC, authoritative control/safety classification of the current
 * customer turn (`detectTurnControlSignals` in `conversation-ai.ts`). It is
 * reused BY VALUE from the SAME keyword tables the deterministic classifier
 * already applies — NOT a second classifier and NOT a model call. The resolver
 * consults it so safety / explicit-human precedence is authoritative regardless
 * of what the model self-reported (PROMPT-AI-EVAL-07). Optional; absent (the
 * default) means "no deterministic signal", so existing behavior is unchanged.
 */
export type ResolverTurnSignals = {
  readonly sensitive?: boolean;
  readonly explicitHuman?: boolean;
  readonly nonCommittal?: boolean;
};

export type ResolveTurnPlanInput = {
  /** The normalized, validated AI decision for this turn. */
  readonly decision: AiResponse;
  /** The engine-owned conversation understanding (Slice 2). */
  readonly state: ConversationState;
  /** Where this turn's decision came from (deterministic / bypass / LLM). */
  readonly routing: AiRoutingDecision;
  /** Authoritative domain outcome when already computed (default PENDING). */
  readonly domain?: ResolverDomainOutcome;
  /** A hard control outcome that pre-empts the AI decision (precedence 1). */
  readonly control?: ResolverControlOutcome;
  /** Deterministic authoritative safety/control signals for the current turn. */
  readonly signals?: ResolverTurnSignals;
};

// ─── Output ─────────────────────────────────────────────────────────────────

/**
 * The resolved turn: ONE decision class, ONE ordered single-goal `TurnPlan`
 * (the canonical `AiTurnPlan`, never a second representation), the precedence
 * rule that fired (explicit + testable), and the EXISTING handoff reason when
 * the plan hands off (no new cause taxonomy in this slice).
 */
export type ResolvedTurn = {
  readonly decisionClass: AiGoalKind;
  readonly plan: AiTurnPlan;
  readonly precedenceRule: TurnPrecedenceRule;
  readonly handoffReason: HandoffReason | null;
  /** The routing that produced the decision (carried through for observability). */
  readonly routing: AiRoutingDecision;
  /**
   * The clarification to ask when `decisionClass === "CLARIFY"` (Slice 4):
   * type, the missing conversation facts, and the ONE bounded question. Null
   * for every other decision class. Knowledge-free by policy (§16).
   */
  readonly clarification: ClarificationPlan | null;
};

/** Build a single-step plan from the primary goal, overriding its class. */
function singleGoalPlan(
  primaryGoal: AiGoal,
  decisionClass: AiGoalKind,
): AiTurnPlan {
  const step: AiGoal = {
    ...primaryGoal,
    kind: decisionClass,
  };
  return { steps: [step] };
}

function resolved(
  primaryGoal: AiGoal,
  decisionClass: AiGoalKind,
  precedenceRule: TurnPrecedenceRule,
  handoffReason: HandoffReason | null,
  routing: AiRoutingDecision,
  clarification: ClarificationPlan | null = null,
): ResolvedTurn {
  return {
    decisionClass,
    plan: singleGoalPlan(primaryGoal, decisionClass),
    precedenceRule,
    handoffReason,
    routing,
    clarification,
  };
}

/**
 * The ONE deterministic resolution: `decision + state + routing + domain →
 * ordered single-goal TurnPlan`, applying the explicit precedence above.
 *
 * The decision class for the common (no-domain-override) case is byte-for-byte
 * the canonical single-goal synthesis the contract already defines
 * (`synthesizeDecisionGoals`), so routing an existing turn through this
 * resolver changes NO customer-visible behavior. Precedence only RE-RANKS the
 * same outcomes and lets an authoritative domain constraint win — it never
 * fabricates a new one.
 */
export function resolveTurnPlan(input: ResolveTurnPlanInput): ResolvedTurn {
  const { decision, routing, state } = input;
  const domain = input.domain ?? { kind: "PENDING" };
  const signals = input.signals ?? {};

  // The PRIMARY goal (single-goal boundary). `synthesizeDecisionGoals`
  // returns the decision's explicit goals when present (future multi-intent
  // capacity, NOT collapsed) or the ONE synthesized goal from intent+action.
  // This slice executes only the primary (first) goal; the rest stay in the
  // decision/state for a later multi-intent slice.
  const goals = synthesizeDecisionGoals(decision);
  const primaryGoal = goals[0] ?? { kind: "ANSWER", intent: decision.intent };
  const baseClass = primaryGoal.kind;

  // Is a task (a CLARIFY-recorded missing fact, or an in-progress booking
  // task) pending coming into this turn? A benign interruption during a
  // pending task must preserve it (rule 6) instead of escalating.
  const hasPendingTask =
    state.lastClarification != null ||
    state.missingFacts.length > 0 ||
    (state.activeTask != null && isTaskGoal(state.activeTask.kind));

  const modelHuman =
    decision.intent === "HUMAN_REQUEST" ||
    decision.handoffReason === "HUMAN_REQUEST";

  // ── 1. CONTROL_COMMAND — a hard, already-decided control pre-empts the AI.
  if (input.control) {
    return resolved(
      primaryGoal,
      input.control.decisionClass,
      "CONTROL_COMMAND",
      input.control.handoffReason ?? decision.handoffReason ?? null,
      routing,
    );
  }

  // ── 2. EXPLICIT_HUMAN_REQUEST — the customer's own handoff always wins.
  //      The DETERMINISTIC signal is authoritative and always fires. A
  //      model-only human claim fires too, EXCEPT while a task is pending,
  //      where (absent any deterministic human/sensitive signal) it is a
  //      benign interruption handled by rule 6 — never losing the task to a
  //      human escalation the customer did not actually request.
  if (signals.explicitHuman === true || (modelHuman && !hasPendingTask)) {
    return resolved(
      primaryGoal,
      "HANDOFF",
      "EXPLICIT_HUMAN_REQUEST",
      "HUMAN_REQUEST",
      routing,
    );
  }

  // ── 3. SAFETY_RESTRICTED — sensitive/restricted handling is never swallowed.
  //      The DETERMINISTIC signal is authoritative: a safety-required turn
  //      hands off even when the MODEL proposed a clarification and did not
  //      self-report SENSITIVE (PROMPT-AI-EVAL-07 `ho-sensitive-medical`).
  if (signals.sensitive === true || decision.handoffReason === "SENSITIVE") {
    return resolved(
      primaryGoal,
      "HANDOFF",
      "SAFETY_RESTRICTED",
      "SENSITIVE",
      routing,
    );
  }

  // ── 4. DOMAIN_CONSTRAINT — authoritative domain truth wins over an AI claim.
  //      A BLOCKED domain result requires a human even when the AI proposed a
  //      reply/answer; the resolver can never override domain authority.
  if (domain.kind === "BLOCKED") {
    return resolved(
      primaryGoal,
      "HANDOFF",
      "DOMAIN_CONSTRAINT",
      domain.handoffReason ?? decision.handoffReason ?? null,
      routing,
    );
  }

  // ── 5. DOMAIN_DECISION — an existing booking-family action proceeds.
  if (baseClass === "DOMAIN_ACTION") {
    return resolved(
      primaryGoal,
      "DOMAIN_ACTION",
      "DOMAIN_DECISION",
      null,
      routing,
    );
  }

  // ── 6. PENDING_TASK_PRESERVED — a legitimate topic interruption during a
  //      pending task. Reached only after 1–5 could not fire, so there is NO
  //      independent handoff condition (no explicit human, no sensitive turn,
  //      no domain block, no control command). A genuine knowledge gap stays a
  //      handoff (an independent condition). When the AI nonetheless decided to
  //      hand off (e.g. a model-only human claim, or a generic escalation on a
  //      pause like "ثواني بس"), PRESERVE the pending task and stay AI_ACTIVE
  //      by re-asking the pending clarification — the pending task survives in
  //      ConversationState (INTERRUPTED/RECOVERING), the next turn resumes.
  if (
    hasPendingTask &&
    decision.action === "handoff" &&
    decision.handoffReason !== "NO_KNOWLEDGE"
  ) {
    const held =
      clarificationForPending(
        state.lastClarification?.type ?? null,
        state.missingFacts,
      ) ?? planClarification(decision, state);
    if (held) {
      return resolved(
        primaryGoal,
        "CLARIFY",
        "PENDING_TASK_PRESERVED",
        null,
        routing,
        held,
      );
    }
  }

  // ── 7. CLARIFY_DECISION — a clarifiable turn asks ONE bounded question and
  //      stays AI_ACTIVE INSTEAD of escalating. Reached only after 1–6 could
  //      not fire, so a control command, an explicit human request, a
  //      sensitive turn, and an authoritative domain constraint always win;
  //      a genuine knowledge gap (NO_KNOWLEDGE) is NOT clarifiable and falls
  //      through to the NORMAL_DECISION handoff below. The clarification is
  //      PROPOSED by the resolver-owned handler; the resolver decides it fires.
  const clarification = planClarification(decision, state);
  if (clarification) {
    // Narrow policy correction (PROMPT-AI-EVAL-07 `st-ambiguous-idk`): a bare
    // NON-COMMITTAL fragment ("مش عارف") with NO pending clarification and NO
    // active task has nothing to clarify — a CLARIFY question is unnecessary.
    // Suppress ONLY in that exact situation; the turn then falls through to the
    // existing normal/handoff behavior. A non-committal REPLY to a pending
    // clarification keeps `hasPendingTask` true, so it stays clarifiable.
    const unnecessary =
      signals.nonCommittal === true &&
      !hasPendingTask &&
      clarification.type === "CLARIFY_INTENT";
    if (!unnecessary) {
      return resolved(
        primaryGoal,
        "CLARIFY",
        "CLARIFY_DECISION",
        null,
        routing,
        clarification,
      );
    }
  }

  // ── 8. NORMAL_DECISION — normal answer, or the existing knowledge-gap /
  //      genuinely-ambiguous handoff. The class is exactly the canonical
  //      synthesis.
  return resolved(
    primaryGoal,
    baseClass,
    "NORMAL_DECISION",
    decision.action === "handoff" ? (decision.handoffReason ?? null) : null,
    routing,
  );
}
