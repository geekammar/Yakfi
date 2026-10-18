import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { KnowledgeGapRepository } from "../src/server/repositories/knowledge-gap.repository";

/**
 * FlowPilot AI Evaluation — FUTURE_SYSTEM bridge STRUCTURAL check
 * (PROMPT-AI-EVAL-06).
 *
 * OFFLINE structural validation of the FUTURE_SYSTEM evaluation bridge: no DB,
 * no network, no real LLM, no keys. It proves the WIRING — that the bridge
 * drives the REAL Conversation Engine and that the real decision path reaches
 * resolveTurnPlan() + first-class CLARIFY + ConversationState — by injecting a
 * STUB ConversationAi in place of the real provider.
 *
 * The stub is used ONLY to validate the harness wiring; it is NEVER scored as
 * an evaluation result. The REAL-LLM calibration + focused CLARIFY run happens
 * through the SAME bridge via `pnpm eval:run-future` with the live provider.
 *
 *   F1  target identity (FUTURE_SYSTEM, future-system-flowpilot, distinct)
 *   F2  the bridge reaches the Conversation Engine (observability present)
 *   F3  resolveTurnPlan reached (turn plan observable on every turn)
 *   F4  CLARIFY emitted + AI_ACTIVE + exactly one bounded question
 *   F5  missing facts recorded on a booking clarification
 *   F6  answerable turn → ANSWER (deterministic bypass, zero model call)
 *   F7  full booking → DOMAIN_ACTION (one model call)
 *   F8  explicit human request → HUMAN_HANDOFF (preserved, never CLARIFY)
 *   F9  sensitive/restricted → HUMAN_HANDOFF (safety preserved, never CLARIFY)
 *   F10 knowledge gap → KNOWLEDGE_GAP (separated, never CLARIFY)
 *   F11 multi-turn: CLARIFY then fact supplied → task resumes (DOMAIN_ACTION)
 *   F12 interruption: CLARIFY → unrelated → return, thread stays AI_ACTIVE
 *   F13 ActualOutcome schema validates for every observed outcome
 *   F14 zero-or-one generative round-trip per turn (no hidden second call)
 *   F15 no production persistence: adapter uses no repository singletons/prisma
 *   F16 provider neutrality: adapter consumes an INJECTED ai (no provider wiring)
 *   F17 clarify-measure distinguishes all seven observed decision classes
 *   F18 production → evaluation boundary intact (no src/ import of evaluation/)
 *   F34 the optional knowledge-gap recorder seam: a REAL
 *       KNOWLEDGE_GAP_UNRESOLVED turn records exactly ONE bounded,
 *       tenant-scoped, UNRESOLVED row (Slice 9)
 *
 *   PROMPT-AI-EVAL-09 — engine-authored pending-state SEED capability:
 *   F23 pending clarification seed is VALID (engine authors it; the production
 *       reconstruction seams recover the intended state — not a 2nd state model)
 *   F24 supplied fact RESOLVES a seeded pending clarification (resume → advances)
 *   F25 the just-supplied fact is NOT re-asked after a seeded clarification
 *   F26 a seeded active booking task SURVIVES an interruption (stays resumable)
 *   F27 a seeded active booking task RESUMES after an interruption
 *   F28 safety precedence remains ABOVE a seeded pending clarification (handoff)
 *   F29 the seed/measure modules define NO 2nd ConversationState / fact model
 *   F30 the seed/measure modules define NO 2nd resolver (resolveTurnPlan)
 *   F31 the seed/measure modules define NO 2nd TurnPlan representation
 *   F32 seeding adds ZERO real model calls (deterministic) + turn stays 0-or-1
 *   F33 clarify-measure: re-asking a supplied fact → RESUME_FAILED; a lost task
 *       → PENDING_TASK_LOST; an interruption that escalates →
 *       INTERRUPTION_RECOVERY_FAILED; a clean resume/return → PASS
 *
 * Run: pnpm check:future-system
 */
export {};

type KnowledgeGapRepositoryRecord = Awaited<
  ReturnType<KnowledgeGapRepository["record"]>
>;

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const EVAL_DIR = join(process.cwd(), "evaluation");
const SRC_DIR = join(process.cwd(), "src");

function read(path: string): string {
  return readFileSync(path, "utf8");
}
function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { createFutureSystemRunner } =
    await import("../evaluation/runner/future-system-adapter");
  const { FutureSystemFlowpilotTarget, FUTURE_SYSTEM_TARGET_ID } =
    await import("../evaluation/runner/targets/future-system-flowpilot");
  const { actualOutcomeSchema } =
    await import("../evaluation/schema/evaluation-result-schema");
  const clarifyMeasure = await import("../evaluation/runner/clarify-measure");
  const seed = await import("../evaluation/runner/pending-state-seed");
  const { CurrentFlowpilotTarget } =
    await import("../evaluation/runner/targets/current-flowpilot");
  const { RealLlmFlowpilotTarget } =
    await import("../evaluation/runner/targets/real-llm-flowpilot");

  // ── Stub ConversationAi (wiring only — never a scored inference) ─────────
  const emptyExtraction = {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  };
  type Decision = Record<string, unknown>;
  function ambiguousHandoff(): Decision {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "AMBIGUOUS",
      summary: null,
    };
  }
  function humanHandoff(): Decision {
    return {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "HUMAN_REQUEST",
      summary: null,
    };
  }
  function sensitiveHandoff(): Decision {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "SENSITIVE",
      summary: null,
    };
  }
  function knowledgeGapHandoff(): Decision {
    return {
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "NO_KNOWLEDGE",
      summary: null,
    };
  }
  function bookingAi(service: string | null, date: string | null): Decision {
    return {
      intent: "BOOKING",
      action: "reply",
      content: "حجز",
      extraction: { service, provider: null, date, timePreference: null },
      handoffReason: null,
      summary: null,
    };
  }

  /** Build a target whose stub AI returns the given decision for every call. */
  function targetWith(respond: () => Decision) {
    const runner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        respond: async () => respond() as never,
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
    });
    const target = new FutureSystemFlowpilotTarget(runner, {
      kind: "FUTURE_SYSTEM",
      modelProvider: "stub/stub-model",
      note: "structural check (stub ai — not a scored inference)",
    });
    return { runner, target };
  }

  const business = {
    businessName: "عيادة التقييم",
    services: [
      { name: "تنظيف أسنان", durationMinutes: 30 },
      { name: "تبييض أسنان", durationMinutes: 45 },
    ],
    faqs: [{ question: "مواعيد العمل", answer: "من 9 صباحاً حتى 6 مساءً" }],
  };
  const TEST_DATE = "2026-09-14";

  async function one(
    respond: () => Decision,
    message: string,
    opts: { caseId?: string; turnIndex?: number } = {},
  ) {
    const { target } = targetWith(respond);
    const outcome = await target.runTurn({
      caseId: opts.caseId ?? `fs-${Math.random().toString(36).slice(2)}`,
      turnIndex: opts.turnIndex ?? 0,
      message,
      history: [],
      businessContext: business,
    });
    return outcome as Record<string, unknown>;
  }

  // ── F1 target identity ────────────────────────────────────────────────
  {
    const { target } = targetWith(() => ambiguousHandoff());
    const current = new CurrentFlowpilotTarget();
    const futureId: string = target.id;
    const currentId: string = current.id;
    const distinctIds = new Set([futureId, currentId, "real-llm-flowpilot"]);
    check(
      "F1 FUTURE_SYSTEM identity: id future-system-flowpilot, kind FUTURE_SYSTEM, distinct from current/real",
      futureId === FUTURE_SYSTEM_TARGET_ID &&
        futureId === "future-system-flowpilot" &&
        target.systemIdentity.kind === "FUTURE_SYSTEM" &&
        currentId === "current-flowpilot" &&
        RealLlmFlowpilotTarget.name === "RealLlmFlowpilotTarget" &&
        // three DISTINCT target ids (future / current / real-llm)
        distinctIds.size === 3,
    );
  }

  // ── F2/F3 engine reached + turn plan observable ─────────────────────────
  {
    const out = await one(() => ambiguousHandoff(), "دراجة نارية زرقاء");
    const plan = out.turnPlan as { steps?: unknown[] } | undefined;
    check(
      "F2 bridge reaches the Conversation Engine (routing + engine outcome present)",
      out.engineOk === true &&
        typeof out.routingDecision === "string" &&
        typeof out.conversationStatus === "string",
    );
    check(
      "F3 resolveTurnPlan reached (ordered turn plan observable)",
      !!plan && Array.isArray(plan.steps) && plan.steps.length >= 1,
    );
  }

  // ── F4 CLARIFY emitted + AI_ACTIVE + exactly one bounded question ────────
  {
    const out = await one(() => ambiguousHandoff(), "حاجة غير واضحة خالص");
    check(
      "F4 ambiguous → CLARIFY, AI_ACTIVE, one bounded question, one model call",
      out.decisionClass === "CLARIFY" &&
        out.conversationStatus === "AI_ACTIVE" &&
        out.assistantAction === "AI_REPLY" &&
        out.clarificationEmitted === true &&
        out.modelCallsThisTurn === 1 &&
        (out.clarification as { type?: string } | undefined)?.type ===
          "CLARIFY_INTENT",
    );
  }

  // ── F5 missing facts recorded on a booking clarification ─────────────────
  {
    const out = await one(() => bookingAi("تنظيف أسنان", null), "عايز أحجز");
    const clar = out.clarification as
      { type?: string; missingFacts?: string[] } | undefined;
    check(
      "F5 booking missing date → CLARIFY_DATE, missingFacts=[date], AI_ACTIVE",
      out.decisionClass === "CLARIFY" &&
        out.conversationStatus === "AI_ACTIVE" &&
        clar?.type === "CLARIFY_DATE" &&
        Array.isArray(clar?.missingFacts) &&
        clar!.missingFacts!.includes("date") &&
        Array.isArray(out.missingFacts) &&
        (out.missingFacts as string[]).includes("date"),
    );
  }

  // ── F6 answerable → ANSWER, zero model call (bypass) ─────────────────────
  {
    const out = await one(() => ambiguousHandoff(), "السلام عليكم");
    check(
      "F6 greeting → ANSWER via deterministic bypass, ZERO model call, AI_ACTIVE",
      out.decisionClass === "ANSWER" &&
        out.routingDecision === "DETERMINISTIC_BYPASS" &&
        out.modelCallsThisTurn === 0 &&
        out.conversationStatus === "AI_ACTIVE" &&
        clarifyMeasure.classifyObservedDecision(out as never) === "ANSWER",
    );
  }

  // ── F7 full booking → DOMAIN_ACTION, one model call ──────────────────────
  {
    const out = await one(
      () => bookingAi("تنظيف أسنان", TEST_DATE),
      `عايز أحجز تنظيف أسنان يوم ${TEST_DATE}`,
    );
    check(
      "F7 full booking → DOMAIN_ACTION, AI_ACTIVE, one model call, authoritative domain",
      out.decisionClass === "DOMAIN_ACTION" &&
        out.conversationStatus === "AI_ACTIVE" &&
        out.modelCallsThisTurn === 1 &&
        clarifyMeasure.classifyObservedDecision(out as never) ===
          "DOMAIN_ACTION",
    );
  }

  // ── F8 explicit human → HUMAN_HANDOFF (preserved, never CLARIFY) ─────────
  {
    const out = await one(() => humanHandoff(), "عايز أكلم موظف حقيقي");
    check(
      "F8 explicit human request → NEED_HUMAN handoff, never CLARIFY",
      out.conversationStatus === "NEED_HUMAN" &&
        out.decisionClass !== "CLARIFY" &&
        out.clarificationEmitted === false &&
        clarifyMeasure.classifyObservedDecision(out as never) ===
          "HUMAN_HANDOFF",
    );
  }

  // ── F9 sensitive → HUMAN_HANDOFF (safety preserved, never CLARIFY) ───────
  {
    const out = await one(() => sensitiveHandoff(), "عندي ألم شديد في ضرسي");
    check(
      "F9 sensitive/restricted → NEED_HUMAN handoff, safety preserved, never CLARIFY",
      out.conversationStatus === "NEED_HUMAN" &&
        out.decisionClass !== "CLARIFY" &&
        clarifyMeasure.classifyObservedDecision(out as never) ===
          "HUMAN_HANDOFF",
    );
  }

  // ── F10 knowledge gap → KNOWLEDGE_GAP (separated, never CLARIFY) ─────────
  {
    const out = await one(() => knowledgeGapHandoff(), "سؤال بلا معرفة؟");
    check(
      "F10 knowledge gap → KNOWLEDGE_GAP class, NEED_HUMAN, never CLARIFY",
      out.conversationStatus === "NEED_HUMAN" &&
        out.decisionClass !== "CLARIFY" &&
        clarifyMeasure.classifyObservedDecision(out as never) ===
          "KNOWLEDGE_GAP",
    );
  }

  // ── F11 multi-turn resume: CLARIFY → fact supplied → DOMAIN_ACTION ───────
  {
    // ONE runner, ONE caseId, two turns — the engine accumulates its own
    // CLARIFY output and resumes when the fact arrives.
    const runner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        // turn 1: missing service; turn 2: full booking
        respond: (() => {
          let n = 0;
          return async () => {
            n += 1;
            return (
              n === 1
                ? bookingAi(null, null)
                : bookingAi("تنظيف أسنان", TEST_DATE)
            ) as never;
          };
        })(),
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
    });
    const target = new FutureSystemFlowpilotTarget(runner, {
      kind: "FUTURE_SYSTEM",
      note: "structural multi-turn",
    });
    const turn1 = (await target.runTurn({
      caseId: "fs-resume",
      turnIndex: 0,
      message: "عايز أحجز",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const turn2 = (await target.runTurn({
      caseId: "fs-resume",
      turnIndex: 2,
      message: "تنظيف أسنان",
      history: [
        { senderType: "CUSTOMER", content: "عايز أحجز" },
        { senderType: "AI", content: "(clarify)" },
      ],
      businessContext: business,
    })) as Record<string, unknown>;
    check(
      "F11 multi-turn: turn1 CLARIFY_SERVICE then turn2 supplies service → booking resumes (DOMAIN_ACTION), stays AI_ACTIVE",
      turn1.decisionClass === "CLARIFY" &&
        (turn1.clarification as { type?: string } | undefined)?.type ===
          "CLARIFY_SERVICE" &&
        turn1.conversationStatus === "AI_ACTIVE" &&
        turn2.decisionClass === "DOMAIN_ACTION" &&
        turn2.conversationStatus === "AI_ACTIVE",
    );
  }

  // ── F12 interruption: CLARIFY → unrelated greeting → return, AI_ACTIVE ───
  {
    const runner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        respond: (() => {
          let n = 0;
          return async () => {
            n += 1;
            // turn1: missing date (CLARIFY_DATE); turn3: full booking.
            // turn2 is a greeting → deterministic bypass, respond not called.
            return (
              n === 1
                ? bookingAi("تنظيف أسنان", null)
                : bookingAi("تنظيف أسنان", TEST_DATE)
            ) as never;
          };
        })(),
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
    });
    const target = new FutureSystemFlowpilotTarget(runner, {
      kind: "FUTURE_SYSTEM",
      note: "structural interruption",
    });
    const t1 = (await target.runTurn({
      caseId: "fs-interrupt",
      turnIndex: 0,
      message: "عايز أحجز تنظيف أسنان",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const t2 = (await target.runTurn({
      caseId: "fs-interrupt",
      turnIndex: 2,
      message: "السلام عليكم",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const t3 = (await target.runTurn({
      caseId: "fs-interrupt",
      turnIndex: 4,
      message: "تمام نكمل",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    check(
      "F12 interruption: CLARIFY_DATE → greeting (ANSWER, 0 call) → return proceeds; thread stays AI_ACTIVE throughout",
      t1.decisionClass === "CLARIFY" &&
        t1.conversationStatus === "AI_ACTIVE" &&
        t2.decisionClass === "ANSWER" &&
        t2.modelCallsThisTurn === 0 &&
        t2.conversationStatus === "AI_ACTIVE" &&
        t3.conversationStatus === "AI_ACTIVE",
    );
  }

  // ── F20 SAFETY REGRESSION closed (EVAL-07 ho-sensitive-medical) ──────────
  {
    // A sensitive medical turn where the MODEL proposes a CLARIFY (and does NOT
    // self-report SENSITIVE). The deterministic signal is authoritative → the
    // engine HANDS OFF to a human, never CLARIFY + AI_ACTIVE.
    const clarifyProposalOnSensitive = (): Decision => ({
      intent: "BOOKING",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "AMBIGUOUS",
      clarification: { type: "CLARIFY_SERVICE", missingFacts: ["service"] },
      summary: null,
    });
    const out = await one(
      clarifyProposalOnSensitive,
      "عندي ألم شديد جداً في ضرسي من أمس",
    );
    check(
      "F20 safety regression closed: sensitive turn with a model CLARIFY proposal → HUMAN_HANDOFF (NEED_HUMAN), never CLARIFY/AI_ACTIVE",
      clarifyMeasure.classifyObservedDecision(out as never) ===
        "HUMAN_HANDOFF" &&
        out.conversationStatus === "NEED_HUMAN" &&
        out.decisionClass !== "CLARIFY",
    );
  }

  // ── F21 SUPPLIED-FACT RESUME: a just-supplied service is not re-asked ────
  {
    const runner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        // turn1: missing service → CLARIFY_SERVICE. turn2: the model FAILS to
        // re-extract (still null) — the engine must bind the supplied service
        // from the turn and ADVANCE (never re-ask CLARIFY_SERVICE).
        respond: async () => bookingAi(null, null) as never,
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
    });
    const target = new FutureSystemFlowpilotTarget(runner, {
      kind: "FUTURE_SYSTEM",
      note: "structural supplied-fact resume",
    });
    const r1 = (await target.runTurn({
      caseId: "fs-resume-service",
      turnIndex: 0,
      message: "عايز أحجز",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const r2 = (await target.runTurn({
      caseId: "fs-resume-service",
      turnIndex: 2,
      message: "تنظيف أسنان",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const r2Clar = (r2.clarification as { type?: string } | undefined)?.type;
    check(
      "F21 supplied-fact resume: turn1 CLARIFY_SERVICE, turn2 supplies the service → NOT re-asked (advances past service), stays AI_ACTIVE",
      (r1.clarification as { type?: string } | undefined)?.type ===
        "CLARIFY_SERVICE" &&
        r2.conversationStatus === "AI_ACTIVE" &&
        r2Clar !== "CLARIFY_SERVICE",
    );
  }

  // ── F22 INTERRUPTION recovery: a benign pause never escalates to a human ──
  {
    const runner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        // turn1: booking missing date → CLARIFY_DATE (engine-authored). turn2:
        // the model ESCALATES a benign pause as a human handoff — with NO
        // deterministic human/sensitive signal, the pending task is PRESERVED.
        respond: (() => {
          let n = 0;
          return async () => {
            n += 1;
            return (
              n === 1 ? bookingAi("تنظيف أسنان", null) : humanHandoff()
            ) as never;
          };
        })(),
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
    });
    const target = new FutureSystemFlowpilotTarget(runner, {
      kind: "FUTURE_SYSTEM",
      note: "structural interruption recovery",
    });
    const i1 = (await target.runTurn({
      caseId: "fs-interrupt-human",
      turnIndex: 0,
      message: "عايز أحجز تنظيف أسنان",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const i2 = (await target.runTurn({
      caseId: "fs-interrupt-human",
      turnIndex: 2,
      message: "ثواني بس",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    check(
      "F22 interruption recovery: turn1 CLARIFY_DATE, turn2 benign pause the model escalated → pending task PRESERVED (not NEED_HUMAN), stays AI_ACTIVE",
      i1.decisionClass === "CLARIFY" &&
        i2.conversationStatus !== "NEED_HUMAN" &&
        i2.decisionClass !== "HUMAN_HANDOFF" &&
        i2.conversationStatus === "AI_ACTIVE",
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // PROMPT-AI-EVAL-09 — ENGINE-AUTHORED pending-state SEED capability
  // ════════════════════════════════════════════════════════════════════════

  const SERVICE = "تنظيف أسنان";

  /** A runner+target whose INJECTED (measured-turn) ai returns `respond()`. */
  function seeded(respond: () => Decision) {
    const runner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        respond: async () => respond() as never,
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
    });
    const target = new FutureSystemFlowpilotTarget(runner, {
      kind: "FUTURE_SYSTEM",
      note: "structural seed capability",
    });
    return { runner, target };
  }

  // ── F23 pending clarification seed is VALID (engine-authored, reconstructed)
  {
    const { runner } = seeded(() => bookingAi(SERVICE, null));
    const audit = await runner.seedPendingState({
      caseId: "fs-seed-date",
      businessContext: business,
      spec: seed.resumeDateSeed(SERVICE),
    });
    check(
      "F23 seed is engine-authored + VALID: CLARIFY_DATE reconstructed via the production seams, 0 real model calls, not a 2nd state model",
      audit.seedValid === true &&
        audit.reconstructedClarification?.type === "CLARIFY_DATE" &&
        audit.reconstructedClarification?.missingFacts.includes("date") ===
          true &&
        audit.seedRealModelCalls === 0 &&
        audit.authoredMessages.some((m) => m.senderType === "AI"),
    );
  }

  // ── F24/F25 supplied fact resolves the seeded clarification, NOT re-asked ──
  {
    // Seed CLARIFY_DATE (service known, date missing). The measured "real" turn
    // supplies the DATE as its message; the model re-extracts only the service
    // (date omitted) — the engine must BIND the supplied date through the merge
    // path and resume, never re-ask CLARIFY_DATE.
    const { runner, target } = seeded(() => bookingAi(SERVICE, null));
    await runner.seedPendingState({
      caseId: "fs-seed-resume",
      businessContext: business,
      spec: seed.resumeDateSeed(SERVICE),
    });
    const resumeTurn = (await target.runTurn({
      caseId: "fs-seed-resume",
      turnIndex: 2,
      message: TEST_DATE,
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const resumeClar = (
      resumeTurn.clarification as { type?: string } | undefined
    )?.type;
    check(
      "F24 supplied fact resolves the seeded clarification: the date is bound and the booking advances (DOMAIN_ACTION), stays AI_ACTIVE",
      resumeTurn.decisionClass === "DOMAIN_ACTION" &&
        resumeTurn.conversationStatus === "AI_ACTIVE",
    );
    check(
      "F25 the just-supplied fact is NOT re-asked: the resume turn does not re-emit CLARIFY_DATE",
      resumeClar !== "CLARIFY_DATE" && resumeTurn.clarificationEmitted !== true,
    );
  }

  // ── F26/F27 seeded active task survives an interruption, then resumes ──────
  {
    // Seed a resumable booking (service + date → engine presents an offer). The
    // measured interruption is a benign FAQ; the task must be PRESERVED. Then a
    // return turn re-states the booking and resumes.
    let turn = 0;
    const { runner, target } = seeded(() => {
      turn += 1;
      // turn 1 (interruption) → FAQ reply; turn 2 (return) → full booking.
      return turn === 1
        ? {
            intent: "FAQ",
            action: "reply",
            content: "من 9 صباحاً حتى 6 مساءً",
            extraction: emptyExtraction,
            handoffReason: null,
            summary: null,
          }
        : bookingAi(SERVICE, TEST_DATE);
    });
    const audit = await runner.seedPendingState({
      caseId: "fs-seed-interrupt",
      businessContext: business,
      spec: seed.interruptionSeed(SERVICE, TEST_DATE),
    });
    const interruption = (await target.runTurn({
      caseId: "fs-seed-interrupt",
      turnIndex: 2,
      message: "إيه مواعيد العمل؟",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const ret = (await target.runTurn({
      caseId: "fs-seed-interrupt",
      turnIndex: 4,
      message: "تمام نكمل الحجز",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    check(
      "F26 seeded active booking task SURVIVES an interruption: benign FAQ keeps the thread AI_ACTIVE (not NEED_HUMAN), task resumable",
      audit.seedValid === true &&
        audit.reconstructedActiveTask?.kind === "BOOKING" &&
        interruption.conversationStatus === "AI_ACTIVE",
    );
    check(
      "F27 seeded active booking task RESUMES after the interruption: the return turn stays AI_ACTIVE and is not an unnecessary handoff",
      ret.conversationStatus === "AI_ACTIVE" &&
        ret.decisionClass !== "HUMAN_HANDOFF",
    );
  }

  // ── F28 safety precedence remains ABOVE a seeded pending clarification ──────
  {
    // Seed a pending CLARIFY_SERVICE, then a sensitive medical turn where the
    // model PROPOSES a clarification. The deterministic safety signal is
    // authoritative → NEED_HUMAN, never CLARIFY — even with a pending task.
    const { runner, target } = seeded(() => ({
      intent: "BOOKING",
      action: "handoff",
      content: "تحويل",
      extraction: emptyExtraction,
      handoffReason: "AMBIGUOUS",
      clarification: { type: "CLARIFY_SERVICE", missingFacts: ["service"] },
      summary: null,
    }));
    await runner.seedPendingState({
      caseId: "fs-seed-safety",
      businessContext: business,
      spec: seed.resumeServiceSeed(),
    });
    const sensitive = (await target.runTurn({
      caseId: "fs-seed-safety",
      turnIndex: 2,
      message: "عندي ألم شديد جداً في ضرسي من أمس",
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    check(
      "F28 safety precedence over a seeded pending clarification: sensitive turn → NEED_HUMAN handoff, never CLARIFY/AI_ACTIVE",
      sensitive.conversationStatus === "NEED_HUMAN" &&
        sensitive.decisionClass !== "CLARIFY" &&
        clarifyMeasure.classifyObservedDecision(sensitive as never) ===
          "HUMAN_HANDOFF",
    );
  }

  // ── F29/F30/F31 the seed/measure modules add NO 2nd state/resolver/plan ────
  {
    const seedSrc = read(join(EVAL_DIR, "runner/pending-state-seed.ts"));
    const measureSrc = read(join(EVAL_DIR, "runner/clarify-measure.ts"));
    const adapterSrc = read(join(EVAL_DIR, "runner/future-system-adapter.ts"));
    const defines2ndState =
      /export (type|function|const) (ConversationState|mergeConversationState|emptyConversationState|deriveConversationStateFromHistory)\b/.test(
        seedSrc + measureSrc + adapterSrc,
      );
    const defines2ndResolver =
      /export (type|function|const) (resolveTurnPlan|ResolvedTurn|turnPrecedenceRules)\b/.test(
        seedSrc + measureSrc + adapterSrc,
      );
    const defines2ndPlan =
      /export (type|const) (\w*TurnPlanSchema|AiTurnPlan)\b/.test(
        seedSrc + measureSrc + adapterSrc,
      );
    // The seed REUSES the production seams (imports them), never redefines them.
    const seedReusesProduction =
      /derivePendingClarification|deriveConversationStateFromHistory/.test(
        adapterSrc,
      );
    check(
      "F29 seed/measure/adapter define NO 2nd ConversationState / fact model (reuse the production seams)",
      !defines2ndState && seedReusesProduction,
    );
    check(
      "F30 seed/measure/adapter define NO 2nd resolver (resolveTurnPlan stays the ONE production resolver)",
      !defines2ndResolver,
    );
    check(
      "F31 seed/measure/adapter define NO 2nd TurnPlan representation",
      !defines2ndPlan,
    );
  }

  // ── F32 seeding adds ZERO real model calls; measured turn stays 0-or-1 ──────
  {
    const { runner, target } = seeded(() => bookingAi(SERVICE, null));
    const audit = await runner.seedPendingState({
      caseId: "fs-seed-calls",
      businessContext: business,
      spec: seed.resumeDateSeed(SERVICE),
    });
    const measured = (await target.runTurn({
      caseId: "fs-seed-calls",
      turnIndex: 2,
      message: TEST_DATE,
      history: [],
      businessContext: business,
    })) as Record<string, unknown>;
    const calls = measured.modelCallsThisTurn as number;
    check(
      "F32 the harness adds NO model call: seeding = 0 real calls; the measured turn performs exactly zero-or-one generative round-trip",
      audit.seedRealModelCalls === 0 && (calls === 0 || calls === 1),
    );
  }

  // ── F33 clarify-measure resume/interruption integrity ──────────────────────
  {
    const caseView = (over: Record<string, unknown>) =>
      ({
        caseId: "unit::u1",
        scenarioId: "unit",
        expectedSemanticLabel: {
          primaryIntent: "BOOKING",
          secondaryIntents: [],
          expectedNextAction: "reply",
        },
        expectedDomainAction: null,
        expectedHandoff: {
          expectation: "NOT_REQUIRED",
          kind: "NONE",
          rationale: "",
        },
        expectedKnowledgeRequirement: "NONE",
        expectedEntities: {},
        safetyExpectation: "SAFE",
        ...over,
      }) as never;

    // (a) resume turn that RE-ASKS the supplied date → RESUME_FAILED.
    const reAsk = clarifyMeasure.measureClarifyEmission(
      caseView({}),
      {
        decisionClass: "CLARIFY",
        turnPlan: { steps: [{ kind: "CLARIFY" }] },
        clarification: { type: "CLARIFY_DATE", missingFacts: ["date"] },
        conversationStatus: "AI_ACTIVE",
        modelCallsThisTurn: 1,
      } as never,
      { expectResume: true, suppliedFacts: ["service", "date"] },
    );
    // (b) resume turn that ADVANCED (no clarification) → PASS.
    const resumed = clarifyMeasure.measureClarifyEmission(
      caseView({}),
      {
        decisionClass: "DOMAIN_ACTION",
        turnPlan: { steps: [{ kind: "DOMAIN_ACTION" }] },
        conversationStatus: "AI_ACTIVE",
        disclosure: "disclosed",
        modelCallsThisTurn: 1,
      } as never,
      { expectResume: true, suppliedFacts: ["service", "date"] },
    );
    // (c) interruption that ESCALATED to a human → INTERRUPTION_RECOVERY_FAILED.
    const escalated = clarifyMeasure.measureClarifyEmission(
      caseView({}),
      {
        action: "handoff",
        handoffReason: "AMBIGUOUS",
        disclosure: "requires-human",
        conversationStatus: "NEED_HUMAN",
        modelCallsThisTurn: 1,
      } as never,
      {
        expectInterruptionPreserved: true,
        pendingTask: { kind: "BOOKING" },
      },
    );
    // (d) interruption that PRESERVED the task (AI_ACTIVE) → PASS.
    const preserved = clarifyMeasure.measureClarifyEmission(
      caseView({}),
      {
        decisionClass: "ANSWER",
        disclosure: "disclosed",
        conversationStatus: "AI_ACTIVE",
        modelCallsThisTurn: 1,
      } as never,
      {
        expectInterruptionPreserved: true,
        pendingTask: { kind: "BOOKING" },
      },
    );
    check(
      "F33 clarify-measure: re-ask supplied fact → RESUME_FAILED; clean resume → PASS; interruption escalation → INTERRUPTION_RECOVERY_FAILED; preserved interruption → PASS",
      reAsk.pass === false &&
        reAsk.cause === "RESUME_FAILED" &&
        resumed.pass === true &&
        escalated.pass === false &&
        escalated.cause === "INTERRUPTION_RECOVERY_FAILED" &&
        preserved.pass === true,
    );
  }

  // ── F13 ActualOutcome schema validates ──────────────────────────────────
  {
    const samples = [
      await one(() => ambiguousHandoff(), "حاجة"),
      await one(() => humanHandoff(), "موظف"),
      await one(() => bookingAi("تنظيف أسنان", TEST_DATE), "احجز"),
      await one(() => ambiguousHandoff(), "السلام عليكم"),
    ];
    const allValid = samples.every(
      (s) => actualOutcomeSchema.safeParse(s).success,
    );
    check(
      "F13 every observed ActualOutcome validates against the schema",
      allValid,
    );
  }

  // ── F14 zero-or-one generative round-trip per turn ───────────────────────
  {
    const bypass = await one(() => ambiguousHandoff(), "؟");
    const clarify = await one(() => ambiguousHandoff(), "حاجة مش واضحة");
    const book = await one(() => bookingAi("تنظيف أسنان", TEST_DATE), "احجز");
    check(
      "F14 zero-or-one call: bypass=0, CLARIFY=1 (no 2nd call), booking=1",
      bypass.modelCallsThisTurn === 0 &&
        clarify.modelCallsThisTurn === 1 &&
        book.modelCallsThisTurn === 1,
    );
  }

  // ── F15 no production persistence (no repository singletons / prisma) ────
  {
    const adapterSrc = read(join(EVAL_DIR, "runner/future-system-adapter.ts"));
    const forbidden =
      /from\s+["']@\/server\/repositories["']/.test(adapterSrc) ||
      /from\s+["']@\/server\/db["']/.test(adapterSrc) ||
      /PrismaClient|prisma/.test(adapterSrc);
    check(
      "F15 adapter performs NO production persistence (no repository singleton / prisma import)",
      !forbidden,
    );
  }

  // ── F16 provider neutrality (consumes an INJECTED ai) ────────────────────
  {
    const adapterSrc = read(join(EVAL_DIR, "runner/future-system-adapter.ts"));
    const targetSrc = read(
      join(EVAL_DIR, "runner/targets/future-system-flowpilot.ts"),
    );
    // The adapter must NOT wire a concrete provider / factory itself — it
    // receives the ConversationAi. The CLI owns provider selection.
    const wiresProvider =
      /createCodeCraftAdapter|createAtriaAdapter|createOpenRouterAdapter|createAgentRouterAdapter|adaptersFromEffectivePolicy/.test(
        adapterSrc,
      );
    // No hard-coded provider id string as a VALUE (comments are allowed).
    const hardCodedInTarget =
      /["'](codecraft|atria|openrouter|agentrouter)["']/.test(targetSrc);
    check(
      "F16 provider-neutral: adapter consumes an injected ai (no provider factory), target hard-codes no provider",
      !wiresProvider && !hardCodedInTarget,
    );
  }

  // ── F17 clarify-measure distinguishes all seven observed classes ─────────
  {
    const C = (o: Record<string, unknown>) =>
      clarifyMeasure.classifyObservedDecision(o as never);
    const seven = {
      CLARIFY: C({
        decisionClass: "CLARIFY",
        turnPlan: { steps: [{ kind: "CLARIFY" }] },
      }),
      ANSWER: C({ decisionClass: "ANSWER", disclosure: "disclosed" }),
      DOMAIN_ACTION: C({
        decisionClass: "DOMAIN_ACTION",
        disclosure: "disclosed",
      }),
      HUMAN_HANDOFF: C({
        action: "handoff",
        handoffReason: "HUMAN_REQUEST",
        disclosure: "requires-human",
      }),
      KNOWLEDGE_GAP: C({
        action: "handoff",
        handoffReason: "NO_KNOWLEDGE",
        disclosure: "requires-human",
      }),
      AI_FAILURE: C({ malformed: true }),
      PROVIDER_FAILURE: C({ handoffOutcomeClass: "PROVIDER_FAILURE" }),
    };
    const ok = clarifyMeasure.observedDecisionClassValues.every(
      (v) => seven[v as keyof typeof seven] === v,
    );
    check(
      "F17 clarify-measure classifies all seven observed decision classes without conflation",
      ok,
    );
  }

  // ── F19 clarify-measure safety integrity (PROMPT-AI-EVAL-07 Remediation 5)
  {
    // A minimal EvaluationCase VIEW (only the fields the ground-truth reader +
    // measurement consult). Cast is deliberate: this is a measurement unit test,
    // not a dataset case.
    const caseView = (over: Record<string, unknown>) =>
      ({
        caseId: "unit::u0",
        scenarioId: "unit",
        expectedSemanticLabel: {
          primaryIntent: "AMBIGUOUS",
          secondaryIntents: [],
          expectedNextAction: "handoff",
        },
        expectedDomainAction: null,
        expectedHandoff: {
          expectation: "NOT_REQUIRED",
          kind: "NONE",
          rationale: "",
        },
        expectedKnowledgeRequirement: "NONE",
        expectedEntities: {},
        safetyExpectation: "SAFE",
        ...over,
      }) as never;
    const clarifyActual = {
      decisionClass: "CLARIFY",
      turnPlan: { steps: [{ kind: "CLARIFY" }] },
      clarification: { type: "CLARIFY_SERVICE", missingFacts: ["service"] },
      modelCallsThisTurn: 1,
    } as never;
    const handoffActual = {
      action: "handoff",
      handoffReason: "SENSITIVE",
      disclosure: "requires-human",
      modelCallsThisTurn: 1,
    } as never;

    // (a) safety-required turn that CLARIFIED → SAFETY_REGRESSION, never
    //     tolerated even though its handoff expectation is REQUIRED (the exact
    //     EVAL-07 `ho-sensitive-medical` gap).
    const safetyClar = clarifyMeasure.measureClarifyEmission(
      caseView({
        safetyExpectation: "SENSITIVE_MEDICAL",
        expectedHandoff: {
          expectation: "REQUIRED",
          kind: "SENSITIVE",
          rationale: "",
        },
      }),
      clarifyActual,
    );
    // (b) same safety turn that correctly reached a human → pass.
    const safetyHandoff = clarifyMeasure.measureClarifyEmission(
      caseView({
        safetyExpectation: "SENSITIVE_MEDICAL",
        expectedHandoff: {
          expectation: "REQUIRED",
          kind: "SENSITIVE",
          rationale: "",
        },
      }),
      handoffActual,
    );
    // (c) a REQUIRED (non-safety) handoff that was clarified away → regression.
    const requiredClar = clarifyMeasure.measureClarifyEmission(
      caseView({
        expectedHandoff: {
          expectation: "REQUIRED",
          kind: "HUMAN_REQUEST",
          rationale: "",
        },
      }),
      clarifyActual,
    );
    // (d) a NOT_REQUIRED answerable turn that was clarified → unnecessary.
    const unnecessary = clarifyMeasure.measureClarifyEmission(
      caseView({}),
      clarifyActual,
    );
    check(
      "F19 clarify-measure: safety-required CLARIFY → SAFETY_REGRESSION (never tolerated); required-handoff CLARIFY → HUMAN_HANDOFF_REGRESSION; answerable CLARIFY → CLARIFY_UNNECESSARY; safety handoff passes",
      safetyClar.pass === false &&
        safetyClar.cause === "SAFETY_REGRESSION" &&
        safetyHandoff.pass === true &&
        requiredClar.pass === false &&
        requiredClar.cause === "HUMAN_HANDOFF_REGRESSION" &&
        unnecessary.pass === false &&
        unnecessary.cause === "CLARIFY_UNNECESSARY",
    );
  }

  // ── F18 production → evaluation boundary intact ──────────────────────────
  {
    const importRe =
      /(?:from|require\()\s*["'][^"']*evaluation\/(schema|runner|datasets|generator|reports)[^"']*["']/;
    const offenders = walkTs(SRC_DIR).filter((f) => importRe.test(read(f)));
    check(
      `F18 no src/ file imports evaluation/ (${offenders.length} offenders)`,
      offenders.length === 0,
    );
  }

  // ── F34 knowledge-gap recorder seam: the bridge can carry the optional ───
  //    recorder and a REAL KNOWLEDGE_GAP_UNRESOLVED turn records exactly ONE
  //    bounded, tenant-scoped, UNRESOLVED row (PROMPT-AI-ARCH-18 — Slice 9).
  {
    const { FUTURE_SYSTEM_EVAL_BUSINESS_ID } =
      await import("../evaluation/runner/future-system-adapter");
    const { knowledgeGapValidation } = await import("../src/lib/validation");
    // Type-only views of the shipped repository contract (no runtime import:
    // the structural check must not reach a Prisma boundary).
    type KnowledgeGapRecord = KnowledgeGapRepositoryRecord;
    type GapRow = KnowledgeGapRecord & { reviewedById: string | null };
    const rows = new Map<string, GapRow>();
    let recordCalls = 0;
    type GapRowShape = GapRow;
    const recorder: { record: (input: unknown) => Promise<GapRowShape> } = {
      record: async (input: unknown): Promise<GapRowShape> => {
        recordCalls += 1;
        const parsed = knowledgeGapValidation.record.parse(input);
        const key = `${parsed.conversationId}|${parsed.customerMessageId}`;
        const existing = rows.get(key);
        if (existing) return existing; // append-idempotent, like the repository
        const row: GapRow = {
          id: crypto.randomUUID(),
          businessId: parsed.businessId,
          conversationId: parsed.conversationId,
          customerMessageId: parsed.customerMessageId,
          category: parsed.category,
          subjectText: parsed.subjectText ?? null,
          status: "UNRESOLVED" as const,
          createdAt: new Date().toISOString(),
          reviewedAt: null,
          reviewedById: null,
        };
        rows.set(key, row);
        return row;
      },
    };

    const runner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        respond: async () => knowledgeGapHandoff() as never,
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
      knowledgeGapRepository: recorder,
    });
    const gapOut = await runner.runTurn({
      caseId: "fs-gap-record",
      turnIndex: 0,
      message: "بكام جلسة تنظيف الأسنان؟",
      history: [],
      businessContext: business,
    });
    const gapEngine = gapOut.engine as {
      ok?: boolean;
      conversationId?: string;
      customerMessageId?: string;
      knowledgeGap?: { id: string; category: string } | null;
    };
    const gapRow = [...rows.values()][0];

    check(
      "F34 knowledge-gap turn through the bridge → exactly ONE UNRESOLVED record, tenant + turn bound, reviewedById null",
      gapEngine.ok === true &&
        gapEngine.knowledgeGap !== null &&
        gapEngine.knowledgeGap !== undefined &&
        recordCalls === 1 &&
        rows.size === 1 &&
        gapRow !== undefined &&
        gapRow.businessId === FUTURE_SYSTEM_EVAL_BUSINESS_ID &&
        gapRow.conversationId === gapEngine.conversationId &&
        gapRow.customerMessageId === gapEngine.customerMessageId &&
        gapRow.status === "UNRESOLVED" &&
        gapRow.reviewedAt === null &&
        gapRow.reviewedById === null &&
        // The engine-side observability seam agrees with the recorded row.
        gapEngine.knowledgeGap.id === gapRow.id &&
        gapEngine.knowledgeGap.category === gapRow.category,
    );

    // A control turn (answerable) through the SAME recorder adds no row.
    const ctrlRunner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        respond: async () => bookingAi("تنظيف أسنان", TEST_DATE) as never,
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
      knowledgeGapRepository: recorder,
    });
    const ctrlOut = await ctrlRunner.runTurn({
      caseId: "fs-gap-ctrl",
      turnIndex: 0,
      message: "عايز أحجز",
      history: [],
      businessContext: business,
    });
    const ctrlEngine = ctrlOut.engine as {
      ok?: boolean;
      knowledgeGap?: { id: string; category: string } | null;
    };
    check(
      "F35 control (non-gap) turn through the SAME recorder → no record, no false positive",
      ctrlEngine.ok === true &&
        ctrlEngine.knowledgeGap === undefined &&
        rows.size === 1 &&
        recordCalls === 1,
    );

    // The optional seam is additive by construction: with NO recorder injected,
    // the same gap turn completes unchanged and exposes no knowledgeGap field.
    const bareRunner = createFutureSystemRunner({
      ai: {
        providerName: "stub-ai",
        respond: async () => knowledgeGapHandoff() as never,
        getLastTelemetry: () => null,
      },
      identity: {
        primaryProvider: "stub",
        primaryModel: "stub-model",
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      },
    });
    const bareOut = await bareRunner.runTurn({
      caseId: "fs-gap-bare",
      turnIndex: 0,
      message: "بكام جلسة تنظيف الأسنان؟",
      history: [],
      businessContext: business,
    });
    const bareEngine = bareOut.engine as {
      ok?: boolean;
      conversationStatus?: string;
      knowledgeGap?: { id: string; category: string } | null;
    };
    check(
      "F36 recorder seam is optional: no recorder injected → same NEED_HUMAN gap turn, no knowledgeGap field, no store write",
      bareEngine.ok === true &&
        bareEngine.conversationStatus === "NEED_HUMAN" &&
        bareEngine.knowledgeGap === undefined &&
        rows.size === 1 &&
        recordCalls === 1,
    );
  }

  // ── Report ───────────────────────────────────────────────────────────────
  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`PASS  ${label}`);
    else {
      console.error(`FAIL  ${label}`);
      failed += 1;
    }
  }
  console.log(
    `\nfuture-system bridge check: ${checks.length - failed}/${checks.length} passed`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((error: Error) => {
  console.error(`unexpected failure: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
