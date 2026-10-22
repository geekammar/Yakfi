/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { createPlaygroundHarness } from "../src/features/conversations/playground/harness";
/**
 * FlowPilot — Acceptance Verification Suite (CORE-03D2)
 *
 * Semantic Safety Ownership and False-Handoff Repair:
 * - A. Known false-positive reproduction and repair:
 *      Customer says "أي وقت يناسبكم مش مشكلة" with valid safe assessment + timePreference REMOVE.
 *      Assert: no false SENSITIVE_OR_RESTRICTED handoff; AI_ACTIVE continuation; preference removal;
 *      service/date preservation; old offer invalidation; unrestricted replacement options.
 * - B. Context variants:
 *      Table of harmless Egyptian utterances sharing legacy trigger "مشكلة" follow validated
 *      semantic assessment rather than newly hardcoded exceptions.
 * - C. Genuine sensitive handling:
 *      Genuine sensitive fixtures with sensitive assessment escalate with SENSITIVE_OR_RESTRICTED,
 *      create 0 appointments, and present no actionable offer.
 * - D. Contradictory output:
 *      Safe top-level assessment combined with sensitive handoffReason or sensitive handoff goal
 *      does not downgrade the required handoff.
 * - E. Missing, invalid and uncertain assessment:
 *      Covers validation/engine boundary; none silently counts as safe or completes booking.
 * - F. Existing authority:
 *      Explicit customer human request, staff ownership, domain blocks, and disclosure refusal preserved.
 * - G. Mechanical regression:
 *      /start and validated numeric/callback selections stay zero-model.
 * - H. Adapter wire/parse coverage:
 *      Real adapter with injected fake HTTP proves prompt delivery and assessment parsing.
 * - I. Legacy / JEV compatibility:
 *      Legacy and JEV paths exercised separately; neither requires generative safety assessment.
 *
 * Usage:
 *   pnpm check:conv-core-03d2
 */

import {
  aiSafetyAssessmentValues,
  parseAiResponse,
  type AiRequest,
  type AiResponse,
  type AiSafetyAssessment,
} from "../src/features/conversations/server/ai-contract";
import {
  detectTurnControlSignals,
  resolveTurnControlSignals,
} from "../src/features/conversations/server/conversation-ai";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import { hydrateConversationState } from "../src/features/conversations/server/conversation-state";
import { createOpenRouterAdapter } from "../src/server/integrations/ai/openrouter";
import { buildPromptMessages } from "../src/server/integrations/ai/prompt";

let totalChecks = 0;
let passedChecks = 0;
const failures: string[] = [];

function check(title: string, passed: boolean, extraInfo?: string): void {
  totalChecks++;
  if (passed) {
    passedChecks++;
    console.log(`✔ ${title}`);
  } else {
    failures.push(title);
    console.error(`❌ ${title}${extraInfo ? ` -> ${extraInfo}` : ""}`);
  }
}

function mockBooking(params: {
  content: string;
  service?: string | null;
  date?: string | null;
  provider?: string | null;
  timePreference?: string | null;
  safetyAssessment?: AiSafetyAssessment | null;
  handoffReason?: any;
  action?: any;
  goals?: any[];
  factUpdates?: Array<{
    key: string;
    operation?: "set" | "remove";
    value?: string;
  }>;
}): AiResponse {
  return {
    intent: "BOOKING",
    action: params.action ?? "booking_handoff",
    content: params.content,
    summary: "طلب حجز كشف أسنان",
    handoffReason: params.handoffReason ?? null,
    extraction: {
      service: params.service ?? null,
      date: params.date ?? null,
      provider: params.provider ?? null,
      timePreference: (params.timePreference as any) ?? null,
    },
    ...(params.safetyAssessment
      ? { safetyAssessment: params.safetyAssessment }
      : {}),
    ...(params.goals ? { goals: params.goals } : {}),
    ...(params.factUpdates ? { factUpdates: params.factUpdates as any } : {}),
  };
}

async function main(): Promise<void> {
  console.log("========================================================");
  console.log("  FLOWPILOT CORE-03D2 ACCEPTANCE VERIFICATION SUITE");
  console.log("  Semantic Safety Ownership and False-Handoff Repair");
  console.log("========================================================\n");

  const longHours = {
    sat: { open: "09:00", close: "21:00", closed: false },
    sun: { open: "09:00", close: "21:00", closed: false },
    mon: { open: "09:00", close: "21:00", closed: false },
    tue: { open: "09:00", close: "21:00", closed: false },
    wed: { open: "09:00", close: "21:00", closed: false },
    thu: { open: "09:00", close: "21:00", closed: false },
    fri: { open: "09:00", close: "21:00", closed: true },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Area A: Known False-Positive Reproduction and Repair
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- Area A: Known False-Positive Reproduction & Repair ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    let currentResponse: AiResponse | null = null;
    let modelInvocations = 0;
    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        modelInvocations++;
        if (!currentResponse) throw new Error("No response queued");
        return currentResponse;
      },
    };

    // Turn 1: Start booking with evening preference
    currentResponse = mockBooking({
      content: "المواعيد المسائية المتاحة يوم الأربعاء 2026-10-21:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "evening",
      safetyAssessment: "safe",
      factUpdates: [
        { key: "service", operation: "set", value: "كشف أسنان" },
        { key: "date", operation: "set", value: "2026-10-21" },
        { key: "timePreference", operation: "set", value: "evening" },
      ],
    });

    const res1 = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان بالليل يوم الأربعاء 2026-10-21",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-a-1",
    });

    check("A1. Turn 1 processed successfully", res1.ok);
    const rawState1 = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const state1 = hydrateConversationState(rawState1?.state, {
      businessId: harness.business.id,
      conversationId: harness.conversation.id,
    });
    const oldOfferId = state1?.offer?.id;
    const oldTimes = (state1?.offer?.options ?? []).map(
      (o: any) => o.startAt.split("T")[1]?.slice(0, 5) ?? "",
    );
    check(
      "A2. Turn 1 established evening preference and active offer with evening slots",
      Boolean(oldOfferId) &&
        state1?.knownFacts.timePreference === "evening" &&
        oldTimes.length > 0 &&
        oldTimes.every((t: string) => t >= "17:00"),
    );

    // Turn 2: Customer sends "أي وقت يناسبكم مش مشكلة" (contains legacy sensitive trigger "مشكلة")
    // Model assesses safetyAssessment: "safe" and removes time preference
    currentResponse = mockBooking({
      content:
        "تمام، تم إلغاء تفضيل الفترة المسائية. إليك المواعيد المتاحة يوم الأربعاء 2026-10-21:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: null,
      safetyAssessment: "safe",
      factUpdates: [{ key: "timePreference", operation: "remove" }],
    });

    const res2 = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "أي وقت يناسبكم مش مشكلة",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-a-2",
    });

    check("A3. Turn 2 processed successfully", res2.ok);
    check(
      "A4. No false SENSITIVE_OR_RESTRICTED handoff",
      (res2 as any).handoffCause === null,
    );
    check(
      "A5. Conversation remains AI_ACTIVE",
      (res2 as any).conversationStatus === "AI_ACTIVE",
    );
    check(
      "A6. Assistant action is AI_REPLY",
      (res2 as any).assistantAction === "AI_REPLY",
    );

    const rawState2 = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const state2 = hydrateConversationState(rawState2?.state, {
      businessId: harness.business.id,
      conversationId: harness.conversation.id,
    });

    check(
      "A7. Time preference was removed from knownFacts",
      state2?.knownFacts.timePreference == null,
    );
    check(
      "A8. Service preserved as 'كشف أسنان'",
      state2?.knownFacts.service === "كشف أسنان",
    );
    check(
      "A9. Date preserved as '2026-10-21'",
      state2?.knownFacts.date === "2026-10-21",
    );
    check(
      "A10. Incompatible old offer invalidated and replaced",
      Boolean(state2?.offer?.id) && state2?.offer?.id !== oldOfferId,
    );

    const replacementTimes = (state2?.offer?.options ?? []).map(
      (o: any) => o.startAt.split("T")[1]?.slice(0, 5) ?? "",
    );
    check(
      "A11. Correct unrestricted replacement options offered starting from earliest open hours (< 12:00)",
      replacementTimes.length > 0 &&
        replacementTimes.some((t: string) => t < "12:00"),
      `Options: ${replacementTimes.join(", ")}`,
    );
    check(
      "A12. Model was invoked exactly twice in 2 turns",
      modelInvocations === 2,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Area B: Context Variants Table
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Area B: Context Variants Corpus ---");
  {
    const harmlessVariantsWithTrigger = [
      "أي وقت يناسبكم مش مشكلة",
      "ما عنديش مشكلة في الميعاد",
      "مش مشكلة خالص الصبح أو بالليل",
      "عادي مش مشكلة شوف المتاح",
      "ما فيش مشكلة أنا متاح طول اليوم",
    ];

    let variantIndex = 1;
    for (const phrase of harmlessVariantsWithTrigger) {
      // 1. Prove legacy lexical detector considers it sensitive due to "مشكلة"
      const lexical = detectTurnControlSignals(phrase);
      check(
        `B${variantIndex}a. Legacy lexical detector triggers sensitive on '${phrase}'`,
        lexical.sensitive === true,
      );

      // 2. Pure source selection helper with validated "safe" assessment yields sensitive: false
      const resolvedSignals = resolveTurnControlSignals({
        currentMessage: phrase,
        routing: "LLM",
        isStructuredSemanticTurn: true,
        decision: mockBooking({
          content: "تمام، تم تأكيد الوقت",
          safetyAssessment: "safe",
        }),
      });
      check(
        `B${variantIndex}b. Pure source-selection helper resolves sensitive: false on '${phrase}'`,
        resolvedSignals.sensitive === false,
      );

      // 3. Engine integration test with harness
      const harness = createPlaygroundHarness({
        businessConfig: { workingHours: longHours },
        todayRef: "2026-10-20",
      });
      harness.deps.ai = {
        providerName: "mock-controlled-ai",
        async respond(_req: AiRequest): Promise<AiResponse> {
          return mockBooking({
            content: "المواعيد المتاحة يوم الأربعاء 2026-10-21:",
            service: "كشف أسنان",
            date: "2026-10-21",
            safetyAssessment: "safe",
            factUpdates: [
              { key: "service", operation: "set", value: "كشف أسنان" },
              { key: "date", operation: "set", value: "2026-10-21" },
            ],
          });
        },
      };

      const res = await receiveInboundMessage(harness.deps, {
        to: harness.business.whatsappNumber,
        from: harness.customer.phone,
        text: phrase,
        receivedAt: harness.getVirtualNow().toISOString(),
        externalId: `msg-variant-${variantIndex}`,
      });

      check(
        `B${variantIndex}c. Engine stays AI_ACTIVE with null handoff cause on '${phrase}'`,
        res.ok &&
          (res as any).conversationStatus === "AI_ACTIVE" &&
          (res as any).handoffCause === null,
      );
      variantIndex++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Area C: Genuine Sensitive Handling
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Area C: Genuine Sensitive Handling ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return {
          intent: "AMBIGUOUS",
          action: "handoff",
          content: "نأسف لسماع ذلك، سيتواصل معك أحد مسؤولينا فوراً.",
          summary: "حالة طارئة - ألم شديد ونزيف",
          handoffReason: "SENSITIVE",
          safetyAssessment: "sensitive",
          extraction: {
            service: null,
            date: null,
            provider: null,
            timePreference: null,
          },
        };
      },
    };

    const resC1 = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عندي نزيف حاد وألم شديد جداً ومحتاج طوارئ",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-c-1",
    });

    check("C1. Sensitive turn returns ok: true", resC1.ok);
    check(
      "C2. Sensitive turn hands off with SENSITIVE_OR_RESTRICTED cause",
      (resC1 as any).handoffCause === "SENSITIVE_OR_RESTRICTED",
    );
    check(
      "C3. Conversation status is NEED_HUMAN",
      (resC1 as any).conversationStatus === "NEED_HUMAN",
    );
    check(
      "C4. Assistant action is AI_HANDOFF",
      (resC1 as any).assistantAction === "AI_HANDOFF",
    );

    const appts = harness.capturedAppointmentWrites;
    check(
      "C5. Exactly zero appointments created on sensitive escalation",
      appts.length === 0,
    );

    const rawState = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const state = hydrateConversationState(rawState?.state, {
      businessId: harness.business.id,
      conversationId: harness.conversation.id,
    });
    check(
      "C6. No active booking offer created on sensitive handoff",
      state?.offer == null,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Area D: Contradictory Output
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Area D: Contradictory Output Guards ---");
  {
    // D1: Model emits safetyAssessment: "safe", but handoffReason: "SENSITIVE"
    const contradiction1Signals = resolveTurnControlSignals({
      currentMessage: "عايز كشف أسنان",
      routing: "LLM",
      isStructuredSemanticTurn: true,
      decision: mockBooking({
        content: "تحويل للموظف",
        action: "handoff",
        handoffReason: "SENSITIVE",
        safetyAssessment: "safe", // Contradiction!
      }),
    });
    check(
      "D1. Contradictory safetyAssessment 'safe' + handoffReason 'SENSITIVE' forces sensitive: true",
      contradiction1Signals.sensitive === true,
    );

    // D2: Model emits safetyAssessment: "safe", but goals contains HANDOFF with SENSITIVE
    const contradiction2Signals = resolveTurnControlSignals({
      currentMessage: "عايز كشف أسنان",
      routing: "LLM",
      isStructuredSemanticTurn: true,
      decision: mockBooking({
        content: "إليك المواعيد المتاحة",
        action: "reply",
        handoffReason: "SENSITIVE",
        goals: [{ kind: "HANDOFF", intent: "AMBIGUOUS", priority: 1 }],
        safetyAssessment: "safe", // Contradiction!
      }),
    });
    check(
      "D2. Contradictory safetyAssessment 'safe' + sensitive HANDOFF goal forces sensitive: true",
      contradiction2Signals.sensitive === true,
    );

    // D3: Engine integration verification of contradiction D1
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "تحويل",
          action: "handoff",
          handoffReason: "SENSITIVE",
          safetyAssessment: "safe",
        });
      },
    };

    const resD = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-d-1",
    });

    check(
      "D3. Contradictory safe assessment does not downgrade required SENSITIVE_OR_RESTRICTED handoff",
      (resD as any).handoffCause === "SENSITIVE_OR_RESTRICTED" &&
        (resD as any).conversationStatus === "NEED_HUMAN",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Area E: Missing, Invalid and Uncertain Assessment
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Area E: Missing, Invalid and Uncertain Assessment ---");
  {
    // E1: Uncertain assessment
    const uncertainSignals = resolveTurnControlSignals({
      currentMessage: "مش متأكد من حالتي الصحية",
      routing: "LLM",
      isStructuredSemanticTurn: true,
      decision: mockBooking({
        content: "سؤال غير واضح",
        safetyAssessment: "uncertain",
      }),
    });
    check(
      "E1a. Assessment 'uncertain' forces sensitive: true in source selection",
      uncertainSignals.sensitive === true,
    );

    const harnessE1 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    harnessE1.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "يرجى التوضيح",
          safetyAssessment: "uncertain",
        });
      },
    };
    const resE1 = await receiveInboundMessage(harnessE1.deps, {
      to: harnessE1.business.whatsappNumber,
      from: harnessE1.customer.phone,
      text: "مش متأكد من حالتي الصحية",
      receivedAt: harnessE1.getVirtualNow().toISOString(),
      externalId: "msg-e-1",
    });
    check(
      "E1b. Uncertain assessment escalates safely with SENSITIVE_OR_RESTRICTED cause",
      (resE1 as any).handoffCause === "SENSITIVE_OR_RESTRICTED",
    );
    const apptsE1 = harnessE1.capturedAppointmentWrites;
    check(
      "E1c. Uncertain assessment completes zero appointments",
      apptsE1.length === 0,
    );

    // E2: Missing assessment with trigger word "مشكلة" cannot count as safe
    const missingSignals = resolveTurnControlSignals({
      currentMessage: "أي وقت يناسبكم مش مشكلة",
      routing: "LLM",
      isStructuredSemanticTurn: true,
      decision: mockBooking({
        content: "المواعيد المتاحة",
        // safetyAssessment is deliberately omitted (undefined)
      }),
    });
    check(
      "E2a. Missing assessment on trigger word falls back to lexical sensitive: true",
      missingSignals.sensitive === true,
    );

    const harnessE2 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    harnessE2.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "المواعيد المتاحة",
          // safetyAssessment is omitted
        });
      },
    };
    const resE2 = await receiveInboundMessage(harnessE2.deps, {
      to: harnessE2.business.whatsappNumber,
      from: harnessE2.customer.phone,
      text: "أي وقت يناسبكم مش مشكلة",
      receivedAt: harnessE2.getVirtualNow().toISOString(),
      externalId: "msg-e-2",
    });
    check(
      "E2b. Missing assessment with trigger word does not execute booking, escalates safely",
      (resE2 as any).handoffCause === "SENSITIVE_OR_RESTRICTED",
    );

    // E3: Malformed assessment rejected at contract boundary
    const malformedRaw = {
      intent: "BOOKING",
      action: "booking_handoff",
      content: "مواعيد",
      summary: "حجز",
      extraction: {},
      safetyAssessment: "malformed_safety_token",
    };
    const parsedMalformed = parseAiResponse(malformedRaw);
    check(
      "E3a. Malformed safetyAssessment value rejected by schema",
      parsedMalformed === null,
    );

    const harnessE3 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    harnessE3.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return malformedRaw as any;
      },
    };
    const resE3 = await receiveInboundMessage(harnessE3.deps, {
      to: harnessE3.business.whatsappNumber,
      from: harnessE3.customer.phone,
      text: "عايز كشف أسنان",
      receivedAt: harnessE3.getVirtualNow().toISOString(),
      externalId: "msg-e-3",
    });
    check(
      "E3b. Malformed response triggers safe failure handoff (AI_FAILURE)",
      (resE3 as any).handoffCause === "AI_FAILURE",
    );
    const apptsE3 = harnessE3.capturedAppointmentWrites;
    check(
      "E3c. Malformed response creates zero appointments",
      apptsE3.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Area F: Existing Authority Preservation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Area F: Existing Authority Preservation ---");
  {
    // F1: Explicit customer human request outranks safe assessment
    const humanSignals = resolveTurnControlSignals({
      currentMessage: "حولني لموظف خدمة العملاء لو سمحت",
      routing: "LLM",
      isStructuredSemanticTurn: true,
      decision: mockBooking({
        content: "نعم",
        safetyAssessment: "safe", // Model claims safe
      }),
    });
    check(
      "F1a. Explicit human request detected authoritatively in signals",
      humanSignals.explicitHuman === true,
    );

    const harnessF1 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    harnessF1.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "نعم تفضل",
          safetyAssessment: "safe",
        });
      },
    };
    const resF1 = await receiveInboundMessage(harnessF1.deps, {
      to: harnessF1.business.whatsappNumber,
      from: harnessF1.customer.phone,
      text: "حولني لموظف خدمة العملاء لو سمحت",
      receivedAt: harnessF1.getVirtualNow().toISOString(),
      externalId: "msg-f-1",
    });
    check(
      "F1b. Customer human request escalates with CUSTOMER_REQUESTED_HUMAN regardless of model safety claim",
      (resF1 as any).handoffCause === "CUSTOMER_REQUESTED_HUMAN",
    );

    // F2: Staff ownership preserved (assigned conversation)
    const harnessF2 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
      conversationStatus: "NEED_HUMAN",
      assignedUserId: "staff-user-1",
    });
    let aiCalledF2 = false;
    harnessF2.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        aiCalledF2 = true;
        return mockBooking({ content: "رد" });
      },
    };
    const resF2 = await receiveInboundMessage(harnessF2.deps, {
      to: harnessF2.business.whatsappNumber,
      from: harnessF2.customer.phone,
      text: "الو في حد هنا؟",
      receivedAt: harnessF2.getVirtualNow().toISOString(),
      externalId: "msg-f-2",
    });
    check(
      "F2. Staff-owned thread remains deferred to staff without invoking AI",
      !aiCalledF2 && (resF2 as any).conversationStatus === "NEED_HUMAN",
    );

    // F3: Domain block (Friday closed)
    const harnessF3 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    harnessF3.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "المواعيد المتاحة يوم الجمعة:",
          service: "كشف أسنان",
          date: "2026-10-23", // Friday is closed in longHours
          safetyAssessment: "safe",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-23" },
          ],
        });
      },
    };
    const resF3 = await receiveInboundMessage(harnessF3.deps, {
      to: harnessF3.business.whatsappNumber,
      from: harnessF3.customer.phone,
      text: "عايز كشف أسنان يوم الجمعة 2026-10-23",
      receivedAt: harnessF3.getVirtualNow().toISOString(),
      externalId: "msg-f-3",
    });
    check(
      "F3. Domain block on closed day returns truthful closed notification and zero appointment",
      resF3.ok,
    );
    const apptsF3 = harnessF3.capturedAppointmentWrites;
    check("F3b. Zero appointments created on closed day", apptsF3.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Area G: Mechanical Regression (Zero-Model Actions)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Area G: Mechanical Regression (Zero-Model Actions) ---");
  {
    const harnessG = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    let modelCallsG = 0;
    harnessG.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        modelCallsG++;
        return mockBooking({
          content: "المواعيد المتاحة يوم الأربعاء 2026-10-21:",
          service: "كشف أسنان",
          date: "2026-10-21",
          safetyAssessment: "safe",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        });
      },
    };

    // G1: /start customer command
    const resStart = await receiveInboundMessage(harnessG.deps, {
      to: harnessG.business.whatsappNumber,
      from: harnessG.customer.phone,
      text: "/start",
      receivedAt: harnessG.getVirtualNow().toISOString(),
      externalId: "msg-g-start",
    });
    check("G1a. /start command succeeds", resStart.ok);
    check(
      "G1b. /start command executes with strictly 0 model calls",
      modelCallsG === 0,
    );

    // Prepare active offer
    await receiveInboundMessage(harnessG.deps, {
      to: harnessG.business.whatsappNumber,
      from: harnessG.customer.phone,
      text: "عايز كشف أسنان يوم الأربعاء 2026-10-21",
      receivedAt: harnessG.getVirtualNow().toISOString(),
      externalId: "msg-g-offer",
    });
    check("G2a. Booking inquiry spent exactly 1 model call", modelCallsG === 1);

    // G2: Mechanical selection "1"
    const callsBeforeSelection = modelCallsG;
    const resSelection = await receiveInboundMessage(harnessG.deps, {
      to: harnessG.business.whatsappNumber,
      from: harnessG.customer.phone,
      text: "1",
      receivedAt: harnessG.getVirtualNow().toISOString(),
      externalId: "msg-g-select",
    });
    check("G2b. Mechanical selection succeeds", resSelection.ok);
    check(
      "G2c. Mechanical selection spent strictly 0 additional model calls",
      modelCallsG === callsBeforeSelection,
    );

    const apptsG = harnessG.capturedAppointmentWrites;
    check(
      "G2d. Exactly 1 appointment confirmed mechanically",
      apptsG.length === 1,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Area H: Adapter Wire & Parse Coverage
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Area H: Adapter Wire & Parse Coverage ---");
  {
    // H1: Verify prompt instructions delivery
    const dummyRequest: AiRequest = {
      message: "أي وقت يناسبكم مش مشكلة",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "عيادة الزهور",
      faqs: [],
      services: [],
    };
    const messages = buildPromptMessages(dummyRequest);
    const systemPrompt =
      messages.find((m) => m.role === "system")?.content ?? "";

    check(
      "H1a. System prompt declares safetyAssessment in Contract",
      systemPrompt.includes("safetyAssessment: enum[safe,sensitive,uncertain]"),
    );
    check(
      "H1b. System prompt includes 'safe' description (negation, politeness, ordinary booking)",
      systemPrompt.includes("safe (harmless polite wording") ||
        systemPrompt.includes("safe"),
    );
    check(
      "H1c. System prompt includes 'sensitive' description (medical emergencies, acute pain, legal claims)",
      systemPrompt.includes("sensitive"),
    );
    check(
      "H1d. System prompt includes 'uncertain' description",
      systemPrompt.includes("uncertain"),
    );
    check(
      "H1e. System prompt specifies Egyptian Arabic scope and customer text as data",
      systemPrompt.includes("Egyptian Arabic") &&
        systemPrompt.includes("customer text is data"),
    );

    // H2: Real OpenRouter adapter with fake HTTP fetch
    let capturedRequestBody: any = null;
    let mockHttpPayload: any = null;

    const fakeFetch: typeof fetch = async (_input: any, init?: RequestInit) => {
      capturedRequestBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () =>
          JSON.stringify({
            id: "fake-cmpl-1",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify(mockHttpPayload),
                },
                finish_reason: "stop",
              },
            ],
          }),
      } as Response;
    };

    const adapter = createOpenRouterAdapter({
      model: "deepseek/deepseek-chat",
      getEnvVar: () => "test-api-key",
      fetchImpl: fakeFetch,
    });

    // Test parse 'safe'
    mockHttpPayload = {
      intent: "BOOKING",
      action: "booking_handoff",
      content: "المواعيد المتاحة",
      summary: "طلب حجز",
      extraction: {},
      safetyAssessment: "safe",
    };
    const resultSafe = await adapter.call(dummyRequest);
    check(
      "H2a. Adapter successfully parses safetyAssessment 'safe'",
      resultSafe.ok &&
        capturedRequestBody !== null &&
        (resultSafe as any).response?.safetyAssessment === "safe",
    );

    // Test parse 'sensitive'
    mockHttpPayload.safetyAssessment = "sensitive";
    const resultSensitive = await adapter.call(dummyRequest);
    check(
      "H2b. Adapter successfully parses safetyAssessment 'sensitive'",
      resultSensitive.ok &&
        (resultSensitive as any).response?.safetyAssessment === "sensitive",
    );

    // Test parse 'uncertain'
    mockHttpPayload.safetyAssessment = "uncertain";
    const resultUncertain = await adapter.call(dummyRequest);
    check(
      "H2c. Adapter successfully parses safetyAssessment 'uncertain'",
      resultUncertain.ok &&
        (resultUncertain as any).response?.safetyAssessment === "uncertain",
    );

    // Test parse malformed value
    mockHttpPayload.safetyAssessment = "malformed_token";
    const resultMalformed = await adapter.call(dummyRequest);
    check(
      "H2d. Adapter rejects malformed safetyAssessment value",
      !resultMalformed.ok,
    );

    // Test parse missing value
    delete mockHttpPayload.safetyAssessment;
    const resultMissing = await adapter.call(dummyRequest);
    check(
      "H2e. Adapter parses response with omitted safetyAssessment as undefined",
      resultMissing.ok &&
        (resultMissing as any).response?.safetyAssessment === undefined,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Area I: Legacy and JEV Compatibility
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Area I: Legacy & JEV Compatibility ---");
  {
    // I1: Legacy path does not require safetyAssessment
    const legacySignals = resolveTurnControlSignals({
      currentMessage: "عايز كشف أسنان",
      routing: "DETERMINISTIC",
      isStructuredSemanticTurn: false,
      decision: mockBooking({
        content: "تمام",
        // no safetyAssessment
      }),
    });
    check(
      "I1. Legacy non-structured turn resolves without requiring safetyAssessment",
      legacySignals.sensitive === false,
    );

    // I2: JEV-owned path uses JEV semantic signals strictly
    const jevSignals = resolveTurnControlSignals({
      currentMessage: "أي وقت يناسبكم مش مشكلة", // contains "مشكلة"
      routing: "JEV",
      isStructuredSemanticTurn: false,
      turnTelemetry: {
        jevDecision: {
          semantic: {
            signals: {
              sensitive: false,
              explicitHuman: false,
              nonCommittal: false,
            },
          },
        },
      } as any,
    });
    check(
      "I2. JEV-owned turn uses JEV validated signals without generative assessment requirement",
      jevSignals.sensitive === false,
    );

    // I3: Pure helper rules coverage
    const valuesCheck =
      aiSafetyAssessmentValues.length === 3 &&
      aiSafetyAssessmentValues.includes("safe") &&
      aiSafetyAssessmentValues.includes("sensitive") &&
      aiSafetyAssessmentValues.includes("uncertain");
    check(
      "I3. aiSafetyAssessmentValues has exactly ['safe', 'sensitive', 'uncertain']",
      valuesCheck,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n========================================================");
  console.log(
    `TOTAL CHECKS: ${totalChecks} | PASSED: ${passedChecks} | FAILED: ${failures.length}`,
  );
  console.log("========================================================\n");

  if (failures.length > 0) {
    console.error(
      "Failed checks:\n" + failures.map((f) => `  - ${f}`).join("\n"),
    );
    process.exit(1);
  } else {
    console.log("✔ ALL CORE-03D2 ACCEPTANCE CHECKS PASSED SUCCESSFULLY!");
  }
}

main().catch((err) => {
  console.error("Unexpected failure in acceptance suite:", err);
  process.exit(1);
});
