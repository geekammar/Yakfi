/**
 * FlowPilot AI Evaluation — the PROMPT-AI-JEV-02B FREEZE MANIFEST.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  EVALUATION-ONLY. NEVER IMPORTED BY src/. NOT WIRED INTO PRODUCTION.  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * This module exists for one reason: PROMPT-AI-JEV-02B §7 requires that the
 * STAGE-A candidate be FROZEN — contract, probability policy, labels and
 * fingerprints all recorded — BEFORE STAGE B reveals the new holdout, and
 * §9 requires the STAGE B artifact to be provably bound to exactly that
 * frozen state. A versioned constant in source is the auditable record of
 * the freeze; it is compared at run time, so a post-hoc edit is visible.
 *
 *
 * THE FROZEN CANDIDATE (recorded BEFORE any STAGE B run)
 *
 *   question contract   flowpilot.jev-questions@v3
 *   contract fingerprint sha256:588222a74f4a356b
 *   probability policy  flowpilot.jev-policy@v2   (UNCHANGED from AI-JEV-02)
 *   policy fingerprint  :sha256:a01c368d17e5629e
 *   requested model     typesafe/jev-1.13 (PINNED; never ~typesafe/jev-latest)
 *
 * THE FROZEN SLICES
 *
 *   original        40   sha256:69341a65821179a9   (unchanged from AI-JEV-02)
 *   calibration     26   sha256:8a76f9e4deeb94f8   (unchanged from AI-JEV-02)
 *   holdout         20   sha256:d3f4a90715c80066   (unchanged from AI-JEV-02)
 *   calibration-v3  27   sha256:29a8d48d1e244ee0   (NEW; STAGE A evidence)
 *   holdout-v3      47   sha256:1d659cc4d188bf56   (RETIRED — SEAL_BROKEN, see below)
 *   holdout-v4      60   sha256:7e96dd7d89409647   (RETIRED — COMPLETED, see below)
 *
 *
 * THE HOLDOUT-V3 RETIREMENT (PROMPT-AI-JEV-02B-R §3)
 *
 * holdout-v3's FIRST AND ONLY execution was interrupted by a SIGPIPE from the
 * session's own logging pipeline (`pnpm eval:jev … | tee … | head -60`):
 * `head` closed the read end of the pipe, SIGPIPE propagated into the runner,
 * and the benchmark died after 42 of 47 fixtures had received a live Jev
 * response. The artifact-write step runs only after the fixture loop, so
 * ZERO complete immutable Stage-B artifacts persisted.
 *
 * This is an EXECUTION / EVIDENCE-INTEGRITY failure, not evidence that the
 * semantic candidate failed. Nevertheless the seal is broken: 42 of the 47
 * messages have been sent to the model exactly once and 5 were never
 * requested, so a fresh execution would be a second pass over 42 fixtures
 * and a completion run would leave a mixed-exposure dataset. The slice is
 * therefore RETIRED and can never perform another live provider call.
 *
 * The retirement is enforced at run time by `assertBankExecutable`, which
 * the runner calls BEFORE any fetch is constructed; a retired bank fails
 * CLOSED with exit code 4 and a fetch call count of exactly zero.
 *
 *
 * WHY THE CANDIDATE IS NOT RETUNED (PROMPT-AI-JEV-02B-R §2)
 *
 * The frozen semantic contract is left EXACTLY as-is. The missing evidence is
 * a clean sealed measurement, not another semantic optimization pass. holdout-v4
 * is therefore measured against the same contract and policy fingerprints the
 * Stage-A artifacts were bound to; changing either would invalidate all four
 * frozen Stage-A artifacts and would be semantic drift, which is a HARD STOP.
 *
 *
 * WHY THE POLICY FINGERPRINT IS UNCHANGED
 *
 * The inherited defect was NOT a calibration problem. «عايز أشوف دكتور»
 * returned providerRequested 0.79 (the model already KNEW it was contact) and
 * bookingRequested 0.58 (moderate, wrong). §4's differential isolates the
 * cause as CONTRACT WORDING, not probability placement: the @v2
 * `bookingRequested` question never contrasted the booking reading with the
 * CONTACT reading, so "seeing a provider" — the one verb that carries both —
 * landed in both. The repair is therefore semantic, in the @v3 contract.
 *
 * Moving the 0.5 orientation was considered and REJECTED, and the rejection
 * is recorded here because §4 demands it:
 *  · A global move damages the high-confidence correct answers, which sit at
 *    0.02–0.08 / 0.94–0.97, far from any sane cut point.
 *  · A per-question threshold on bookingRequested could not separate 0.58
 *    (wrong) from the 0.91 the SAME question scores on «عايز الدكتور
 *    يكلمني عشان أحجز», where booking is genuinely present — so the
 *    threshold would break the mask the precedence formula depends on.
 *  · A family-competition rule over {contact, booking} would itself BE the
 *    precedence, relocating the server-owned formula into the policy, which
 *    AI-SEM-02 forbids.
 * The policy is consequently byte-identical to AI-JEV-02's, and the frozen
 * artifact proves it: policyFingerprint() still resolves to
 * sha256:a01c368d17e5629e, the value the committed holdout artifact recorded.
 *
 *
 * THE LABEL-BEFORE-OUTPUT PROOF
 *
 * Every label in `calibration-v3` and `holdout-v3` was authored from the @v3
 * product semantics and committed to source BEFORE any live request was made
 * against these messages. The proof is mechanical, not prose:
 *  · the fingerprints above are computed over (id, message, expected) BEFORE
 *    the run;
 *  · the STAGE B artifact records both the pre-run fingerprint and the slice
 *    it measured, so a label edit after the run changes the fingerprint and
 *    is detectable;
 *  · the git working tree carries the new slices as uncommitted edits whose
 *    authorship timestamp precedes the STAGE B artifact's mtime.
 *
 *
 * THE §10 ADJUDICATION (providerPreferenceExpressed)
 *
 * The historical AI-JEV-02 labels mark a GENERIC provider inside an
 * AVAILABILITY question («هل فيه دكتور متاح؟») as preference = true. The
 * model consistently answered false (0.07–0.10) on all 7 such cases across
 * the original, calibration and holdout slices — one direction, 7 fixtures,
 * zero counter-examples. Audited against the product definition ("a
 * constraint/preference on WHO should perform the service/booking", with a
 * NAMED provider in an availability question explicitly NOT qualifying), the
 * MODEL IS RIGHT and the historical label is a LABEL DEFECT.
 *
 * §10 forbids silently rewriting the historical artifact, so:
 *  · the three AI-JEV-02 slices are UNCHANGED (fingerprints above are
 *    byte-identical to the committed artifacts) and the historical
 *    disagreement stays visible in the recomputed evidence;
 *  · the disagreement is RETIRED AS A LABEL DEFECT, documented here and in
 *    the final report — the product definition itself does not change;
 *  · the new slices carry the FORWARD contract-consistent expectation:
 *    preference is false for every availability case, named or generic.
 *
 * The routing consequence of that adjudication is NULL: the precedence
 * formula consumes supportRequested / providerRequested / bookingTask only,
 * so `providerPreferenceExpressed` participates in no routing decision. The
 * 7 historical disagreements are therefore non-routing label noise, not
 * evidence of a routing defect — which is precisely why they may be retired
 * without touching the server formula.
 */

import { createHash } from "node:crypto";

/**
 * The frozen STAGE-A candidate. Bumping any field here is the ONLY supported
 * way to change what STAGE B is evaluated against, and it invalidates every
 * prior holdout artifact bound to the previous value.
 */
export const JEV_FREEZE_MANIFEST = {
  contractId: "flowpilot.jev-questions@v3",
  contractFingerprint: "sha256:588222a74f4a356b",
  policyId: "flowpilot.jev-policy@v2",
  policyFingerprint: "sha256:a01c368d17e5629e",
  requestedModel: "typesafe/jev-1.13",
  /** The task forbids the alias as the primary measured model. */
  forbiddenAliasModel: "~typesafe/jev-latest",
  slices: {
    original: { count: 40, fingerprint: "sha256:69341a65821179a9" },
    calibration: { count: 26, fingerprint: "sha256:8a76f9e4deeb94f8" },
    holdout: { count: 20, fingerprint: "sha256:d3f4a90715c80066" },
    "calibration-v3": { count: 27, fingerprint: "sha256:29a8d48d1e244ee0" },
    "holdout-v3": { count: 47, fingerprint: "sha256:1d659cc4d188bf56" },
    /**
     * The recovery holdout. Its count and fingerprint are frozen at authoring
     * time (holdout-v4 is 60 fixtures); the value is asserted by
     * `verifyFreezeManifest` exactly like every other slice. Its one permitted
     * live pass COMPLETED (60/60, zero errors) and it is therefore recorded as
     * COMPLETED in HOLDOUT_RETIREMENTS below: a sealed holdout may never be
     * measured twice.
     */
    "holdout-v4": { count: 60, fingerprint: "sha256:7e96dd7d89409647" },
  },
} as const;

/**
 * The execution eligibility of a bank slice. A sealed holdout starts
 * `eligibleForExecution: true` and is flipped to `SEAL_BROKEN` the moment its
 * first execution is interrupted, because a sealed slice may only ever be
 * measured once. Historical slices that were never sealed stay eligible in
 * principle; a completed sealed holdout would move to `COMPLETED`.
 */
export type BankExecutionStatus = {
  readonly status: "ELIGIBLE" | "SEAL_BROKEN" | "COMPLETED";
  readonly eligibleForExecution: boolean;
  readonly eligibleForScoring: boolean;
  readonly reason: string;
  /** How many rows received a live provider response on the interrupted pass. */
  readonly exposedRows: number;
  /** How many rows the interrupted pass planned. */
  readonly plannedRows: number;
  /** How many rows the interrupted pass never requested. */
  readonly missingRows: number;
};

/**
 * The PROMPT-AI-JEV-02B-R §3 retirement register. holdout-v3 is recorded as
 * SEAL_BROKEN so no future prompt mistakes the transient partial log for
 * evidence and so the runner can fail CLOSED before any network call.
 * holdout-v4 is recorded as COMPLETED for the same execution-blocking reason:
 * its single permitted live pass finished (60/60 rows, zero errors, one
 * immutable artifact), so a second pass would re-expose 60 sealed fixtures
 * and is refused the same way. A sealed holdout — whether broken or completed
 * — is never eligible for another live provider call.
 */
export const HOLDOUT_RETIREMENTS: Record<string, BankExecutionStatus> = {
  "holdout-v3": {
    status: "SEAL_BROKEN",
    eligibleForExecution: false,
    eligibleForScoring: false,
    reason: "interrupted first sealed execution",
    exposedRows: 42,
    plannedRows: 47,
    missingRows: 5,
  },
  "holdout-v4": {
    status: "COMPLETED",
    eligibleForExecution: false,
    /**
     * Unlike a broken seal, a COMPLETED holdout produced a valid immutable
     * artifact, so it remains eligible for OFFLINE scoring/analysis. Only its
     * re-execution is forbidden.
     */
    eligibleForScoring: true,
    reason:
      "completed first sealed execution (one immutable artifact persisted)",
    exposedRows: 60,
    plannedRows: 60,
    missingRows: 0,
  },
};

/**
 * The PROMPT-AI-JEV-02B-R §3 HARD GUARD. Resolve a bank's execution status
 * BEFORE any fetch is constructed. A SEAL_BROKEN bank may never perform
 * another live provider call; this returns a denial describing the retirement
 * so the runner can fail CLOSED with zero network I/O.
 *
 * Returns `null` when the bank is executable, so the caller can treat a
 * denial as a hard stop rather than catching an exception.
 */
export function bankExecutionDenial(
  bank: string,
): { denial: string; status: BankExecutionStatus } | null {
  const retired = HOLDOUT_RETIREMENTS[bank];
  if (!retired) return null;
  return {
    denial: `bank '${bank}' is ${retired.status} and cannot be executed: ${retired.reason} (exposed ${retired.exposedRows} of ${retired.plannedRows} planned rows; ${retired.missingRows} never requested; eligibleForExecution=${retired.eligibleForExecution}, eligibleForScoring=${retired.eligibleForScoring})`,
    status: retired,
  };
}

/**
 * Convenience for the §3 guard: true only when a bank may still perform a
 * live provider call.
 */
export function bankIsExecutable(bank: string): boolean {
  return bankExecutionDenial(bank) === null;
}

/**
 * The label-vs-contract disagreements adjudicated under §10, recorded so the
 * historical evidence is preserved and the retirement is auditable. Each
 * entry names the historical fixture, the fact, the label the artifact
 * carries (UNCHANGED) and the contract-consistent orientation the NEW slices
 * use. None of these facts participates in routing.
 */
export const PROVIDER_PREFERENCE_ADJUDICATION = [
  {
    slice: "original",
    fixtureId: "provider-availability",
    message: "هل فيه دكتور متاح؟",
    fact: "providerPreferenceExpressed",
    historicalLabel: true,
    contractConsistentOrientation: false,
    verdict: "label-defect",
    routingImpact: "none (the fact is not consumed by applyServerPrecedence)",
  },
  {
    slice: "calibration",
    fixtureId: "v2-cal-provider-availability-title",
    message: "في دكتور متاح دلوقتي؟",
    fact: "providerPreferenceExpressed",
    historicalLabel: true,
    contractConsistentOrientation: false,
    verdict: "label-defect",
    routingImpact: "none",
  },
  {
    slice: "calibration",
    fixtureId: "v2-cal-provider-availability-msa",
    message: "هل يوجد طبيب متاح؟",
    fact: "providerPreferenceExpressed",
    historicalLabel: true,
    contractConsistentOrientation: false,
    verdict: "label-defect",
    routingImpact: "none",
  },
  {
    slice: "calibration",
    fixtureId: "v2-cal-greeting-plus-provider-availability",
    message: "السلام عليكم، في دكتور فاضي؟",
    fact: "providerPreferenceExpressed",
    historicalLabel: true,
    contractConsistentOrientation: false,
    verdict: "label-defect",
    routingImpact: "none",
  },
  {
    slice: "calibration",
    fixtureId: "v2-cal-availability-plus-service",
    message: "في دكتور فاضي؟ وكام تنظيف الأسنان؟",
    fact: "providerPreferenceExpressed",
    historicalLabel: true,
    contractConsistentOrientation: false,
    verdict: "label-defect",
    routingImpact: "none",
  },
  {
    slice: "calibration",
    fixtureId: "v2-cal-mixed-availability",
    message: "Is there a doctor available بكرة؟",
    fact: "providerPreferenceExpressed",
    historicalLabel: true,
    contractConsistentOrientation: false,
    verdict: "label-defect",
    routingImpact: "none",
  },
  {
    slice: "holdout",
    fixtureId: "v2-hold-provider-availability-female",
    message: "في دكتورة متاحة؟",
    fact: "providerPreferenceExpressed",
    historicalLabel: true,
    contractConsistentOrientation: false,
    verdict: "label-defect",
    routingImpact: "none",
  },
] as const;

/**
 * Verify a live run's resolved state against this manifest. Returns a list of
 * mismatch descriptions (empty when the run is bound to the frozen candidate).
 * Called from the STAGE B runner so the artifact is provably frozen-before-run.
 */
export function verifyFreezeManifest(state: {
  contractId: string;
  contractFingerprint: string;
  policyId: string;
  policyFingerprint: string;
  requestedModel: string;
  sliceFingerprints: Record<string, string>;
  sliceCounts: Record<string, number>;
}): string[] {
  const problems: string[] = [];
  const m = JEV_FREEZE_MANIFEST;
  if (state.contractId !== m.contractId)
    problems.push(`contractId ${state.contractId} !== frozen ${m.contractId}`);
  if (state.contractFingerprint !== m.contractFingerprint)
    problems.push(
      `contractFingerprint ${state.contractFingerprint} !== frozen ${m.contractFingerprint}`,
    );
  if (state.policyId !== m.policyId)
    problems.push(`policyId ${state.policyId} !== frozen ${m.policyId}`);
  if (state.policyFingerprint !== m.policyFingerprint)
    problems.push(
      `policyFingerprint ${state.policyFingerprint} !== frozen ${m.policyFingerprint}`,
    );
  if (state.requestedModel !== m.requestedModel)
    problems.push(
      `requestedModel ${state.requestedModel} !== pinned ${m.requestedModel}`,
    );
  if (state.requestedModel === m.forbiddenAliasModel)
    problems.push("the alias was used as the primary measured model");
  for (const [slice, frozen] of Object.entries(m.slices)) {
    const fp = state.sliceFingerprints[slice];
    const count = state.sliceCounts[slice];
    if (fp !== frozen.fingerprint)
      problems.push(
        `slice ${slice} fingerprint ${fp} !== frozen ${frozen.fingerprint}`,
      );
    if (count !== frozen.count)
      problems.push(`slice ${slice} count ${count} !== frozen ${frozen.count}`);
  }
  return problems;
}

/** A fingerprint of the manifest itself, so the freeze record is tamper-evident. */
export function freezeManifestFingerprint(): string {
  const content = JSON.stringify(
    {
      manifest: JEV_FREEZE_MANIFEST,
      adjudication: PROVIDER_PREFERENCE_ADJUDICATION.map((a) => [
        a.slice,
        a.fixtureId,
        a.fact,
        a.verdict,
      ]),
    },
    null,
    0,
  );
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}
