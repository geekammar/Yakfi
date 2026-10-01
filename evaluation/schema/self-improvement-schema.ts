/**
 * FlowPilot AI Evaluation — Self-Improvement provenance schema
 * (PROMPT-AI-EVAL-DESIGN-01).
 *
 * This is SCHEMA ONLY. It defines the labels a future self-improvement loop
 * would emit and consume, so the evaluation dataset can RECORD the evidence
 * a loop needs without the loop existing. Nothing here is a pipeline, a
 * service, a queue, a cron, or a production import; no code in this file
 * performs discovery, approval, or knowledge mutation. The production
 * knowledge store (`Business.faqs`) is NOT touched.
 *
 * The record it models — the lifecycle a future slice would implement:
 *
 *   1. KNOWLEDGE_GAP_DETECTED   — an evaluation/production turn needed
 *      knowledge that had no backing source.
 *   2. REPEATED_QUESTION_PATTERN — the same gap recurs across turns/businesses
 *      above a threshold.
 *   3. HUMAN_RESOLUTION          — an operator answered the question for real.
 *   4. CANDIDATE_ANSWER          — a proposed knowledge entry derived from the
 *      human resolution.
 *   5. HUMAN_APPROVED_ANSWER     — the operator approved the candidate.
 *   6. REGRESSION_CASE_DERIVED   — a NEW evaluation case was authored from the
 *      approved gap, so the gap can never silently reopen.
 *
 * The binding safety property: a candidate answer is NEVER knowledge until a
 * human approves it (`approvedBy` non-null + `approvedAt` non-null), and a
 * derived regression case is NEVER authored from an unapproved answer.
 */

import { knowledgeRequirementValues, knowledgeSourceValues } from "./taxonomy";
import { z } from "zod";

/**
 * The stage a self-improvement observation is at. `REJECTED` is a terminal
 * stage — an operator reviewed a candidate and refused it, so the gap stays
 * a gap and the observation is never retried automatically.
 */
export const selfImprovementStageValues = [
  "KNOWLEDGE_GAP_DETECTED",
  "REPEATED_QUESTION_PATTERN",
  "HUMAN_RESOLUTION",
  "CANDIDATE_ANSWER",
  "HUMAN_APPROVED_ANSWER",
  "REGRESSION_CASE_DERIVED",
  "REJECTED",
] as const;

export type SelfImprovementStage = (typeof selfImprovementStageValues)[number];

/**
 * The provenance of one self-improvement observation. All timestamps are
 * ISO strings; all actor ids are opaque internal ids (never a name, email,
 * phone, or credential).
 */
export const selfImprovementRecordSchema = z
  .object({
    /** Opaque record id. */
    recordId: z.string().min(1),
    /** When the observation began (the gap detection). */
    detectedAt: z.string().min(1),
    /** The stage this observation has reached. */
    stage: z.enum(selfImprovementStageValues),

    // ── The gap ───────────────────────────────────────────────────────────
    /**
     * The customer-facing question shape that exposed the gap (a normalized
     * representative phrasing, NOT raw customer PII and NOT a verbatim
     * transcript).
     */
    questionShape: z.string().min(1),
    /** The knowledge kind the turn needed and did not have. */
    knowledgeRequirement: z.enum(knowledgeRequirementValues),
    /** The source that WOULD have backed the answer, had it existed. */
    expectedSource: z.enum(knowledgeSourceValues),
    /** The business the gap was observed in (opaque id, never a name). */
    businessId: z.string().min(1),
    /**
     * How many times the same gap shape recurred (the signal a repeated
     * question pattern is worth acting on).
     */
    recurrenceCount: z.number().int().min(1).default(1),

    // ── The human resolution ──────────────────────────────────────────────
    /** The operator's real answer, when a human resolved the turn. */
    humanResolution: z.string().optional(),
    /** When the human resolution happened. */
    resolvedAt: z.string().optional(),

    // ── The candidate ─────────────────────────────────────────────────────
    /** A proposed knowledge entry derived from the human resolution. */
    candidateAnswer: z
      .object({
        question: z.string().min(1),
        answer: z.string().min(1),
      })
      .optional(),

    // ── The approval (the binding gate) ───────────────────────────────────
    /** The approving actor id; null/absent until a human approves. */
    approvedBy: z.string().optional(),
    /** When the approval happened; null/absent until a human approves. */
    approvedAt: z.string().optional(),

    // ── The derived regression case ───────────────────────────────────────
    /**
     * The evaluation case id authored FROM this observation. A non-null
     * value requires `approvedBy` (a regression case is never derived from
     * an unapproved candidate — `selfImprovementRecordIsConsistent`).
     */
    derivedCaseId: z.string().optional(),
    /**
     * The dataset version the derived case belongs to (a gap found in
     * `egyptian-v1` may land its regression case in `egyptian-v2`).
     */
    derivedDatasetVersion: z.string().optional(),
  })
  .passthrough();

export type SelfImprovementRecord = z.infer<typeof selfImprovementRecordSchema>;

/**
 * The binding consistency rule: knowledge is never promoted without a human.
 * Returns false when a record claims a derived regression case or an
 * approved answer without the human approval that authorizes it.
 */
export function selfImprovementRecordIsConsistent(
  record: SelfImprovementRecord,
): boolean {
  const approved = Boolean(record.approvedBy) && Boolean(record.approvedAt);
  // A derived regression case requires an approval.
  if (record.derivedCaseId && !approved) return false;
  // An approved stage requires the actual approval fields.
  if (record.stage === "HUMAN_APPROVED_ANSWER" && !approved) return false;
  if (record.stage === "REGRESSION_CASE_DERIVED" && !approved) return false;
  // A derived case requires the regression stage to have been reached.
  if (record.derivedCaseId && record.stage !== "REGRESSION_CASE_DERIVED") {
    return false;
  }
  // A candidate answer requires a human resolution to have been derived from.
  if (record.candidateAnswer && !record.humanResolution) return false;
  // A rejection is terminal: no approval and no derived case may follow.
  if (record.stage === "REJECTED" && (approved || record.derivedCaseId)) {
    return false;
  }
  return true;
}

/**
 * The observation hook a future evaluation run may populate. The dataset
 * records it as a LABEL only — `expectKnowledgeGapRecorded` on the case's
 * future-architecture expectation — and this schema defines the shape the
 * eventual observation would take. It is never written by anything in this
 * slice.
 */
export const knowledgeGapObservationSchema = z
  .object({
    /** The case that exposed the gap. */
    caseId: z.string().min(1),
    /** The dataset version the case belongs to. */
    datasetVersion: z.string().min(1),
    /** The question shape, normalized (no PII). */
    questionShape: z.string().min(1),
    /** The knowledge kind the turn needed. */
    knowledgeRequirement: z.enum(knowledgeRequirementValues),
  })
  .passthrough();

export type KnowledgeGapObservation = z.infer<
  typeof knowledgeGapObservationSchema
>;
