/**
 * FlowPilot AI Evaluation — the Jev PROBABILITY→FACT POLICY
 * (PROMPT-AI-JEV-02 §7).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  EVALUATION-ONLY. NEVER IMPORTED BY src/. NOT WIRED INTO PRODUCTION.  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Jev's Noul primitive returns a raw PROBABILITY of yes. Somewhere that
 * probability has to become a fact the server precedence can consume. This
 * module is that place, and it is deliberately EXPLICIT and AUDITABLE: every
 * rule here exists for a stated reason, backed by the recomputed AI-JEV-01
 * disagreement table. Nothing here is a production threshold and nothing here
 * is imported by src/.
 *
 *
 * THE CENTRAL DISCIPLINE (§7)
 *
 * AI-JEV-01 produced two materially different failure classes, and they need
 * opposite medicine:
 *
 *  · NEAR-THRESHOLD errors — the probability sat next to the decision point
 *    (bookingRequested 0.52 against availabilityAsked 0.82; availabilityAsked
 *    0.49 against providerRequested 0.74; bookingRequested 0.55 inside a
 *    sensitive turn). These are calibration-addressable.
 *
 *  · CONFIDENT CATEGORICAL errors — the model was sure and wrong
 *    (providerRequested 0.75 / 0.86 / 0.74 on provider-title-inside-task
 *    turns). Moving a threshold does NOT fix these: the probability is above
 *    any sane cut point, and raising the cut point would silently break
 *    genuine contact requests ("let me speak to a doctor"), which score even
 *    higher. These are fixed by REPAIRING THE QUESTION SEMANTICS
 *    (jev-question-contract @v2), never by a threshold.
 *
 * Therefore this policy does NOT globally move 0.5, does NOT set one shared
 * cut point for unrelated questions, and does NOT set a per-question
 * threshold for the provider family. It applies exactly two rules, both
 * justified by evidence, plus confidence banding for reporting.
 *
 *
 * RULE P1 — the default orientation is 0.5, and it is not moved globally
 *
 *     fact = probability >= 0.5
 *
 * Why 0.5: a Noul returns P(yes); the neutral orientation is the even point.
 * The frozen AI-JEV-01 bank gives no evidence that the neutral point should
 * shift for facts in general — the high-confidence answers in that run sat at
 * 0.02–0.08 or 0.94–0.97, far from the boundary, so a global move would
 * damage those while chasing a handful of boundary cases. A global threshold
 * is also exactly the "one number for unrelated semantic questions" §7
 * forbids. So the default stays.
 *
 *
 * RULE P2 — booking-task family competition (argmax), routing-neutral
 *
 * The four facts {bookingRequested, availabilityAsked, cancellationRequested,
 * rescheduleRequested} are one task family: the server precedence folds them
 * into a single `bookingTask` mask (`bookingTaskFromFacts`). When two or more
 * of them cross 0.5 in the same turn, the model is split between adjacent
 * readings of ONE task, not asserting two tasks. Evidence: AI-JEV-01
 * disagreement #2, «إمتى ممكن أجي؟», returned bookingRequested 0.52 against
 * availabilityAsked 0.82 — the customer asks when they may come, and the
 * model half-hears a booking commitment.
 *
 *     among family members with probability >= 0.5, keep only the argmax
 *
 * Why this is safe and why it is NOT threshold tuning:
 *  · ROUTING-NEUTRAL. `bookingTask` is true whichever member wins, so the
 *    server-precedence verdict (explicitHuman) is unchanged by the rule. It
 *    only improves the TASK LABEL the Turn Planner acts on.
 *  · LABEL-CONSISTENT. No fixture in the frozen bank asserts two members of
 *    this family simultaneously, so the rule contradicts no frozen label.
 *  · TRANSPARENT. A suppressed member is recorded in the decision log, never
 *    dropped silently.
 *  · NO NEW THRESHOLD. It reuses P1's 0.5 for membership and selects by
 *    ordering, not by a tuned cut point.
 *
 *
 * RULE P3 — confidence banding (REPORTING ONLY)
 *
 *     high     p >= 0.85  or  p <= 0.15
 *     moderate 0.60 <= p < 0.85  or  0.15 < p <= 0.40
 *     low      0.40 < p < 0.60
 *
 * This never changes a fact. It exists so the report can show the
 * probability distribution AROUND failures (§11) and so a future bounded
 * production design can route low-confidence facts to clarification rather
 * than action. The band edges are descriptive bookkeeping, not decision
 * thresholds, and no fact depends on them.
 *
 *
 * DELIBERATELY REJECTED (recorded so the reasoning is auditable)
 *
 *  · A per-question threshold on `providerRequested`. Its AI-JEV-01 failures
 *    were 0.74–0.86 (confident), so a threshold cannot separate them from
 *    genuine contact requests without causing false negatives. Repaired by
 *    contract @v2 semantics instead.
 *  · A per-question threshold on `supportRequested` / `providerPreference-
 *    Expressed`. Their failures were driven by the same provider-title
 *    confusion, not by calibration.
 *  · A rule suppressing `bookingRequested` on sensitive turns. A real "I am
 *    in severe pain and need an appointment" turn is BOTH sensitive and a
 *    booking; suppressing booking under sensitivity would break it. The
 *    AI-JEV-01 case (0.55) is near-threshold and routing-neutral, so it is
 *    left to the sharpened bookingRequested definition, not a suppression
 *    rule.
 *  · Any composition that would let a probability change the server
 *    precedence formula itself. The formula stays `supportRequest OR
 *    (providerRequest AND NOT bookingTask)`, applied to the facts this policy
 *    produces.
 */

import { createHash } from "node:crypto";

import type { JevQuestionKey } from "./jev-question-contract";

// ─── The versioned policy identity ───────────────────────────────────────────

/**
 * The versioned id of this probability policy. Bump when any rule, band edge
 * or documented rejection changes — that invalidates comparability with runs
 * under the previous revision.
 */
export const JEV_POLICY_ID = "flowpilot.jev-policy@v2";

/** RULE P1 — the default orientation. Documented above; not moved globally. */
export const JEV_DEFAULT_THRESHOLD = 0.5;

/** RULE P2 — the booking-task family, whose members compete for one task. */
export const JEV_BOOKING_TASK_FAMILY: ReadonlyArray<JevQuestionKey> = [
  "bookingRequested",
  "availabilityAsked",
  "cancellationRequested",
  "rescheduleRequested",
];

/** RULE P3 — the descriptive confidence band edges (reporting only). */
export const JEV_CONFIDENCE_BANDS = {
  highMax: 0.85,
  moderateMax: 0.6,
} as const;

export type FactConfidence = "high" | "moderate" | "low";

// ─── The decision log (auditable, one entry per question) ───────────────────

export type PolicyDecision = {
  readonly key: string;
  /** The raw probability the model returned, or null when absent. */
  readonly probability: number | null;
  /** The fact the policy derived, or null when no answer existed. */
  readonly fact: boolean | null;
  readonly confidence: FactConfidence | null;
  /** How this fact was produced. */
  readonly source: "direct" | "family-competition" | "absent";
  /** A human-readable reason, present whenever a rule other than P1 applied. */
  readonly note: string | null;
};

export type PolicyResult = {
  readonly policyId: string;
  /** The fact map the server precedence consumes. */
  readonly facts: Record<string, boolean | null>;
  /** The full decision log, so every derived fact is auditable. */
  readonly decisions: PolicyDecision[];
};

// ─── RULE P3 — banding (pure, total) ─────────────────────────────────────────

export function bandConfidence(p: number): FactConfidence {
  if (
    p >= JEV_CONFIDENCE_BANDS.highMax ||
    p <= 1 - JEV_CONFIDENCE_BANDS.highMax
  )
    return "high";
  if (
    p >= JEV_CONFIDENCE_BANDS.moderateMax ||
    p <= 1 - JEV_CONFIDENCE_BANDS.moderateMax
  )
    return "moderate";
  return "low";
}

// ─── RULE P1 + P2 — probability → fact ───────────────────────────────────────

/**
 * Apply the policy to a raw probability map. Pure and total: absent answers
 * become `null` facts (never coerced to false), so a missing answer is never
 * scored as a negative.
 */
export function applyProbabilityPolicy(
  probabilities: Partial<Record<string, number | null>>,
  keys: ReadonlyArray<string> = Object.keys(probabilities),
): PolicyResult {
  const decisions: PolicyDecision[] = [];
  const facts: Record<string, boolean | null> = {};

  // ── P1: default orientation at 0.5 for every question. ──────────────────
  for (const key of keys) {
    const p = probabilities[key] ?? null;
    if (p === null) {
      facts[key] = null;
      decisions.push({
        key,
        probability: null,
        fact: null,
        confidence: null,
        source: "absent",
        note: null,
      });
      continue;
    }
    facts[key] = p >= JEV_DEFAULT_THRESHOLD;
    decisions.push({
      key,
      probability: p,
      fact: facts[key],
      confidence: bandConfidence(p),
      source: "direct",
      note: null,
    });
  }

  // ── P2: booking-task family competition (argmax among members ≥ 0.5). ────
  const present = JEV_BOOKING_TASK_FAMILY.filter(
    (k) =>
      keys.includes(k) &&
      probabilities[k] !== undefined &&
      probabilities[k] !== null,
  );
  const overThreshold = present.filter(
    (k) => (probabilities[k] as number) >= JEV_DEFAULT_THRESHOLD,
  );
  if (overThreshold.length > 1) {
    const winner = overThreshold.reduce((a, b) =>
      (probabilities[b] as number) > (probabilities[a] as number) ? b : a,
    );
    for (const k of overThreshold) {
      if (k === winner) continue;
      const p = probabilities[k] as number;
      facts[k] = false;
      const decision = decisions.find((d) => d.key === k);
      if (decision) {
        decisions[decisions.indexOf(decision)] = {
          ...decision,
          fact: false,
          source: "family-competition",
          note: `suppressed by family competition; ${winner} scored higher (${probabilities[winner]} > ${p})`,
        };
      }
    }
  }

  return {
    policyId: JEV_POLICY_ID,
    facts,
    decisions,
  };
}

// ─── Fingerprints (frozen before STAGE B) ────────────────────────────────────

/**
 * Canonicalize a value into a stable string, so a fingerprint does not depend
 * on object key insertion order.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A content fingerprint of the policy. Frozen and recorded in the STAGE B
 * artifact so the holdout run is provably bound to the exact rules it was
 * evaluated under. Any edit to a rule changes this hash.
 */
export function policyFingerprint(): string {
  const content = canonical({
    policyId: JEV_POLICY_ID,
    defaultThreshold: JEV_DEFAULT_THRESHOLD,
    family: [...JEV_BOOKING_TASK_FAMILY],
    bands: JEV_CONFIDENCE_BANDS,
  });
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

/**
 * A content fingerprint of a question contract, so the STAGE B artifact is
 * bound to the exact semantics it was evaluated under. Passed the contract
 * module's question set.
 */
export function contractFingerprint(
  questions: Readonly<Record<string, unknown>>,
): string {
  return `sha256:${createHash("sha256")
    .update(canonical(questions))
    .digest("hex")
    .slice(0, 16)}`;
}
