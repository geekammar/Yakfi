/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { resolveBookingOptions } from "../src/features/appointments/server/booking-options-service";
import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
/**
 * FlowPilot — Acceptance Verification Suite (CORE-03D1)
 *
 * Canonical Time Preferences and Reliable Removal on the Existing Engine:
 * - A. Canonical SET: controlled morning preference filters to morning options (< 12:00); afternoon/evening excluded; facts & mirrors agree.
 * - B. Replacement: morning -> evening replaces state; returns evening options; prior offer invalidated.
 * - C. REMOVE continuation: explicit remove clears facts & mirrors; date/service/provider preserved; options unconstrained; not resurrected on continuation.
 * - D. No-change / FAQ interruption: unrelated FAQ preserves preference; resume booking still applies filter.
 * - E. Invalid model value: noncanonical string (e.g. "الصبح", "10:30") causes validation rejection; durable booking facts untouched.
 * - F. Fact-update precedence: explicit factUpdate overrides conflicting extraction (including REMOVE).
 * - G. No matching options: explicit preference with 0 matching options does not silently return unrestricted options (hands off truthfully).
 * - H. Mechanical-path regression: /start and numeric selections execute with 0 model calls.
 *
 * Usage:
 *   pnpm check:conv-core-03d1
 */

import {
  aiExtractionSchema,
  aiFactUpdateSchema,
  aiResponseSchema,
  canonicalTimePreferenceValues,
  type AiRequest,
  type AiResponse,
  type CanonicalTimePreference,
} from "../src/features/conversations/server/ai-contract";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import { hydrateConversationState } from "../src/features/conversations/server/conversation-state";
import { reconcileTurnSemanticFacts } from "../src/features/conversations/server/semantic-facts";

let totalChecks = 0;
let passedChecks = 0;
const failures: string[] = [];

function makeBookingDeps(harnessDeps: any) {
  return {
    eligibility: {
      businessRepository: harnessDeps.businessRepository,
      serviceRepository: harnessDeps.serviceRepository,
      branchRepository: harnessDeps.branchRepository,
      providerRepository: harnessDeps.providerRepository,
    },
    businessRepository: harnessDeps.businessRepository,
    serviceRepository: harnessDeps.serviceRepository,
    providerRepository: harnessDeps.providerRepository,
    appointmentRepository: harnessDeps.appointmentRepository,
  };
}

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
  timePreference?: CanonicalTimePreference | null;
  safetyAssessment?: "safe" | "sensitive" | "uncertain" | null;
  factUpdates?: Array<{
    key: string;
    operation?: "set" | "remove";
    value?: string;
  }>;
}): AiResponse {
  return {
    intent: "BOOKING",
    action: "booking_handoff",
    content: params.content,
    summary: "طلب حجز كشف أسنان",
    handoffReason: null,
    safetyAssessment: (params.safetyAssessment ?? "safe") as any,
    extraction: {
      service: params.service ?? null,
      date: params.date ?? null,
      provider: params.provider ?? null,
      timePreference: params.timePreference ?? null,
    },
    ...(params.factUpdates ? { factUpdates: params.factUpdates as any } : {}),
  };
}

function mockFaq(content: string): AiResponse {
  return {
    intent: "FAQ",
    action: "reply",
    content,
    summary: null,
    handoffReason: null,
    extraction: {
      service: null,
      date: null,
      provider: null,
      timePreference: null,
    },
    factUpdates: [],
  };
}

async function main(): Promise<void> {
  console.log("========================================================");
  console.log("  FLOWPILOT CORE-03D1 ACCEPTANCE VERIFICATION SUITE");
  console.log("  Canonical Time Preferences & Reliable Removal on Engine");
  console.log("========================================================\n");

  const longHours = {
    sat: { open: "09:00", close: "21:00", closed: false },
    sun: { open: "09:00", close: "21:00", closed: false },
    mon: { open: "09:00", close: "21:00", closed: false },
    tue: { open: "09:00", close: "21:00", closed: false },
    wed: { open: "09:00", close: "21:00", closed: false },
    thu: { open: "09:00", close: "21:00", closed: false },
    fri: { open: "09:00", close: "21:00", closed: false },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior A: Canonical SET
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- Behavior A: Canonical SET ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    let modelCalls = 0;
    const queuedResponse: AiResponse = mockBooking({
      content: "المواعيد الصباحية المتاحة يوم الأربعاء 2026-10-21:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "morning",
      factUpdates: [
        { key: "service", operation: "set", value: "كشف أسنان" },
        { key: "date", operation: "set", value: "2026-10-21" },
        { key: "timePreference", operation: "set", value: "morning" },
      ],
    });

    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        modelCalls++;
        return queuedResponse;
      },
    };

    const resA = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان الصبح يوم الأربعاء 2026-10-21",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-a-1",
    });

    const rawState = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const state = rawState
      ? hydrateConversationState(rawState.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    check("A0. Turn processed successfully", resA.ok);

    check("A1. Model was invoked exactly once", modelCalls === 1);
    check(
      "A2. Durable knownFacts and compatibility mirror agree on 'morning'",
      state?.knownFacts.timePreference === "morning" &&
        state?.selectedTimePref === "morning",
    );

    const offer = state?.offer;
    check("A3. Active offer is a SLOT offer", offer?.kind === "SLOT");

    const optionTimes = (offer?.options ?? []).map(
      (o: any) => o.startAt.split("T")[1]?.slice(0, 5) ?? "",
    );

    check(
      "A4. Slot options obey morning boundary (< 12:00)",
      optionTimes.length > 0 && optionTimes.every((t: string) => t < "12:00"),
      `Found times: ${optionTimes.join(", ")}`,
    );

    check(
      "A5. Afternoon and evening options are strictly excluded from offer",
      optionTimes.every((t: string) => t < "12:00") &&
        !optionTimes.some((t: string) => t >= "12:00"),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior B: Replacement
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior B: Replacement ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    let currentResponse: AiResponse | null = null;
    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        if (!currentResponse) throw new Error("No response");
        return currentResponse;
      },
    };

    // Turn 1: morning
    currentResponse = mockBooking({
      content: "المواعيد الصباحية:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "morning",
      factUpdates: [
        { key: "service", operation: "set", value: "كشف أسنان" },
        { key: "date", operation: "set", value: "2026-10-21" },
        { key: "timePreference", operation: "set", value: "morning" },
      ],
    });

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان الصبح يوم الأربعاء",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-b-1",
    });

    const raw1 = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const state1 = raw1
      ? hydrateConversationState(raw1.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;
    const oldOfferId = state1?.offer?.id;

    // Turn 2: replacement to evening
    currentResponse = mockBooking({
      content: "المواعيد المسائية:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "evening",
      factUpdates: [
        { key: "timePreference", operation: "set", value: "evening" },
      ],
    });

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "لا خليها بالليل",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-b-2",
    });

    const raw2 = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const state2 = raw2
      ? hydrateConversationState(raw2.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    check(
      "B1. Evening replaces morning in durable knownFacts and mirror",
      state2?.knownFacts.timePreference === "evening" &&
        state2?.selectedTimePref === "evening",
    );

    const eveningOptionTimes = (state2?.offer?.options ?? []).map(
      (o: any) => o.startAt.split("T")[1]?.slice(0, 5) ?? "",
    );

    check(
      "B2. Returned options are strictly evening options (>= 17:00)",
      eveningOptionTimes.length > 0 &&
        eveningOptionTimes.every((t: string) => t >= "17:00"),
      `Found times: ${eveningOptionTimes.join(", ")}`,
    );

    check(
      "B3. Previous offer was superseded / replaced by a new offer identity",
      state2?.offer?.id !== oldOfferId && state2?.offer?.kind === "SLOT",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior C: REMOVE continuation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior C: REMOVE continuation ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
      initialAppointments: [
        // Block 09:00 to 11:30 for both providers on 2026-10-21 so morning only has 11:30,
        // while unrestricted has both 11:30 (morning) and 12:00 (afternoon).
        {
          id: "block-p1",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          branchId: PLAYGROUND_IDS.BRANCH_ID,
          customerId: "cust-block",
          serviceId: PLAYGROUND_IDS.SERV_DENTAL,
          assignedUserId: PLAYGROUND_IDS.USER_P1,
          providerId: PLAYGROUND_IDS.PROV_1,
          date: "2026-10-21",
          startTime: "09:00",
          endTime: "11:30",
          status: "CONFIRMED",
        },
        {
          id: "block-p2",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          branchId: PLAYGROUND_IDS.BRANCH_ID,
          customerId: "cust-block",
          serviceId: PLAYGROUND_IDS.SERV_DENTAL,
          assignedUserId: PLAYGROUND_IDS.USER_P2,
          providerId: PLAYGROUND_IDS.PROV_2,
          date: "2026-10-21",
          startTime: "09:00",
          endTime: "11:30",
          status: "CONFIRMED",
        },
      ],
    });

    let currentResponse: AiResponse | null = null;
    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        if (!currentResponse) throw new Error("No response");
        return currentResponse;
      },
    };

    // Turn 1: morning preference
    currentResponse = mockBooking({
      content: "المواعيد الصباحية:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "morning",
      factUpdates: [
        { key: "service", operation: "set", value: "كشف أسنان" },
        { key: "date", operation: "set", value: "2026-10-21" },
        { key: "timePreference", operation: "set", value: "morning" },
      ],
    });

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان الصبح يوم الأربعاء",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-c-1",
    });

    // Turn 2: controlled explicit REMOVE
    currentResponse = mockBooking({
      content: "تمام إليك جميع المواعيد المتاحة على مدار اليوم:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: null,
      factUpdates: [{ key: "timePreference", operation: "remove" }],
    });

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "أي وقت مناسب",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-c-2",
    });

    // Reload state directly from persistent store before asserting
    const rawReloaded = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const reloadedState = rawReloaded
      ? hydrateConversationState(rawReloaded.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    check(
      "C1. Preference is removed from durable knownFacts",
      reloadedState?.knownFacts.timePreference === undefined,
    );
    check(
      "C2. Preference is removed from compatibility mirror",
      reloadedState?.selectedTimePref === null,
    );
    check(
      "C3. Service and date remain intact after timePreference removal",
      reloadedState?.knownFacts.service === "كشف أسنان" &&
        reloadedState?.knownFacts.date === "2026-10-21",
    );

    const allTimes = (reloadedState?.offer?.options ?? []).map(
      (o: any) => o.startAt.split("T")[1]?.slice(0, 5) ?? "",
    );
    const hasMorning = allTimes.some((t: string) => t < "12:00");
    const hasAfternoonOrEvening = allTimes.some((t: string) => t >= "12:00");

    check(
      "C4. Available options span both morning and afternoon/evening (no longer restricted)",
      hasMorning && hasAfternoonOrEvening,
      `All times: ${allTimes.join(", ")}`,
    );

    // Turn 3: Continuation turn without time preference
    currentResponse = mockBooking({
      content: "متاح أيضاً مواعيد إضافية لو تفضل:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: null,
      factUpdates: [],
    });

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "طب ممكن توضحلي المواعيد تاني؟",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-c-3",
    });

    const rawContinuation = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const continuationState = rawContinuation
      ? hydrateConversationState(rawContinuation.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    check(
      "C5. Prior time preference is not resurrected on continuation",
      continuationState?.knownFacts.timePreference === undefined &&
        continuationState?.selectedTimePref === null,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior D: No-change / FAQ interruption
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior D: No-change / FAQ interruption ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    let currentResponse: AiResponse | null = null;
    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        if (!currentResponse) throw new Error("No response");
        return currentResponse;
      },
    };

    // Turn 1: morning preference
    currentResponse = mockBooking({
      content: "المواعيد الصباحية:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "morning",
      factUpdates: [
        { key: "service", operation: "set", value: "كشف أسنان" },
        { key: "date", operation: "set", value: "2026-10-21" },
        { key: "timePreference", operation: "set", value: "morning" },
      ],
    });

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان الصبح يوم الأربعاء",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-d-1",
    });

    // Turn 2: FAQ interruption with no time update
    currentResponse = mockFaq(
      "عنوان العيادة: 12 شارع النصر، المعادي، القاهرة.",
    );

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عنوان العيادة فين؟",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-d-2",
    });

    const rawFaq = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const faqState = rawFaq
      ? hydrateConversationState(rawFaq.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    check(
      "D1. Time preference preserved across FAQ inquiry",
      faqState?.knownFacts.timePreference === "morning" &&
        faqState?.selectedTimePref === "morning",
    );
    check(
      "D2. Slot offer is preserved during FAQ interruption",
      faqState?.offer?.kind === "SLOT" && faqState?.offer?.status === "ACTIVE",
    );

    // Turn 3: Resume booking
    currentResponse = mockBooking({
      content: "تمام، نرجع لحجز كشف الأسنان يوم الأربعاء صباحاً:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: null,
      factUpdates: [],
    });

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "تمام وريني المواعيد تاني",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-d-3",
    });

    const rawResume = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const resumeState = rawResume
      ? hydrateConversationState(rawResume.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    const resumeTimes = (resumeState?.offer?.options ?? []).map(
      (o: any) => o.startAt.split("T")[1]?.slice(0, 5) ?? "",
    );

    check(
      "D3. Resumed slot options still strictly obey morning preference (< 12:00)",
      resumeTimes.length > 0 && resumeTimes.every((t: string) => t < "12:00"),
      `Resume times: ${resumeTimes.join(", ")}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior E: Invalid model value
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior E: Invalid model value ---");
  {
    // E1. Contract schema tests
    const arabicExtraction = aiExtractionSchema.safeParse({
      service: null,
      provider: null,
      date: null,
      timePreference: "الصبح",
    });
    check(
      "E1a. Noncanonical Arabic string 'الصبح' in extraction is rejected by schema",
      !arabicExtraction.success,
    );

    const exactExtraction = aiExtractionSchema.safeParse({
      service: null,
      provider: null,
      date: null,
      timePreference: "10:30",
    });
    check(
      "E1b. Exact time '10:30' in extraction is rejected by schema",
      !exactExtraction.success,
    );

    const arabicSetUpdate = aiFactUpdateSchema.safeParse({
      key: "timePreference",
      operation: "set",
      value: "الصبح",
    });
    check(
      "E1c. Noncanonical Arabic string 'الصبح' in SET factUpdate is rejected by schema",
      !arabicSetUpdate.success,
    );

    const exactSetUpdate = aiFactUpdateSchema.safeParse({
      key: "timePreference",
      operation: "set",
      value: "10:30",
    });
    check(
      "E1d. Exact time string '10:30' in SET factUpdate is rejected by schema",
      !exactSetUpdate.success,
    );

    for (const validVal of canonicalTimePreferenceValues) {
      const validSet = aiFactUpdateSchema.safeParse({
        key: "timePreference",
        operation: "set",
        value: validVal,
      });
      check(
        `E1e. Canonical value '${validVal}' is accepted in SET factUpdate`,
        validSet.success,
      );
    }

    // E2. Full engine turn with noncanonical model output (safe failure / handoff, durable state intact)
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-failing-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        // AI returns an object that fails schema parse
        const rawInvalid = {
          intent: "BOOKING",
          action: "booking_handoff",
          content: "تمام الصبح",
          summary: "حجز الصبح",
          handoffReason: null,
          extraction: {
            service: "كشف أسنان",
            date: "2026-10-21",
            provider: null,
            timePreference: "الصبح",
          },
          factUpdates: [
            { key: "timePreference", operation: "set", value: "الصبح" },
          ],
        };
        const parsed = aiResponseSchema.parse(rawInvalid);
        return parsed;
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان الصبح",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-e-1",
    });

    const rawE = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const stateE = rawE
      ? hydrateConversationState(rawE.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    check(
      "E2a. Engine safely catches invalid model output and triggers AI_HANDOFF",
      (res as any).assistantAction === "AI_HANDOFF",
    );
    check(
      "E2b. Durable booking facts remain untouched (no corrupted or noncanonical timePreference)",
      !stateE ||
        (stateE.knownFacts.timePreference === undefined &&
          stateE.selectedTimePref === null),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior F: Fact-update precedence
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior F: Fact-update precedence ---");
  {
    // F1. Conflicting extraction (morning) vs explicit REMOVE factUpdate
    const recRemove = reconcileTurnSemanticFacts(
      {
        service: "كشف أسنان",
        date: "2026-10-21",
        provider: null,
        timePreference: "morning",
      },
      [{ key: "timePreference", operation: "remove" }],
    );

    check(
      "F1. Explicit REMOVE wins over conflicting extraction (morning)",
      recRemove.removedKeys.has("timePreference") &&
        !recRemove.setFacts.has("timePreference") &&
        recRemove.normalizedExtraction.timePreference === null,
    );

    // F2. Conflicting extraction (morning) vs explicit SET factUpdate (evening)
    const recSet = reconcileTurnSemanticFacts(
      {
        service: "كشف أسنان",
        date: "2026-10-21",
        provider: null,
        timePreference: "morning",
      },
      [{ key: "timePreference", operation: "set", value: "evening" }],
    );

    check(
      "F2. Explicit SET (evening) wins over conflicting extraction (morning)",
      recSet.setFacts.get("timePreference")?.value === "evening",
    );

    // F3. In engine turn, explicit update takes precedence over extraction
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "المواعيد المسائية:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "morning", // Conflicts with factUpdates
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "evening" },
          ],
        });
      },
    };

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان بالليل",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-f-1",
    });

    const rawF = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const stateF = rawF
      ? hydrateConversationState(rawF.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    check(
      "F3. Durable state reflects explicit SET 'evening', ignoring conflicting extraction 'morning'",
      stateF?.knownFacts.timePreference === "evening" &&
        stateF?.selectedTimePref === "evening",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior G: Period-empty outcome vs FULLY_BOOKED truthfulness
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior G: Period-empty outcome vs FULLY_BOOKED ---");
  {
    // Business working hours 09:00 to 12:00 (morning slots exist; zero evening slots)
    const morningOnlyHours = {
      sat: { open: "09:00", close: "12:00", closed: false },
      sun: { open: "09:00", close: "12:00", closed: false },
      mon: { open: "09:00", close: "12:00", closed: false },
      tue: { open: "09:00", close: "12:00", closed: false },
      wed: { open: "09:00", close: "12:00", closed: false },
      thu: { open: "09:00", close: "12:00", closed: false },
      fri: { open: "09:00", close: "12:00", closed: false },
    };

    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: morningOnlyHours },
      todayRef: "2026-10-20",
    });

    // 1. Prove fixture has available slots outside the requested period (unfiltered options > 0)
    const unfilteredBooking = await resolveBookingOptions(
      makeBookingDeps(harness.deps),
      { userId: harness.customer.id, businessId: harness.business.id },
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        date: "2026-10-21",
      },
    );
    check(
      "G1. Prove fixture has available slots outside requested period (> 0 morning slots exist)",
      unfilteredBooking.success && unfilteredBooking.data.options.length > 0,
    );

    let currentResponse: AiResponse | null = null;
    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        if (!currentResponse) {
          throw new Error("UNEXPECTED_AI_CALL");
        }
        return currentResponse;
      },
    };

    currentResponse = mockBooking({
      content: "جاري البحث عن مواعيد مسائية:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "evening",
      factUpdates: [
        { key: "service", operation: "set", value: "كشف أسنان" },
        { key: "date", operation: "set", value: "2026-10-21" },
        { key: "timePreference", operation: "set", value: "evening" },
      ],
    });

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان بالليل يوم الأربعاء",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-g-1",
    });

    const rawG = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const stateG = rawG
      ? hydrateConversationState(rawG.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    const lastDelivered =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];

    check(
      "G2. Truthful outbound wording explains no slots match requested period (not entire day booked)",
      (lastDelivered?.body.includes("لا تتوفر مواعيد في الفترة المسائية") ??
        false) &&
        !lastDelivered?.body.includes("جميع المواعيد محجوزة"),
    );

    check(
      "G3. Conversation outcome remains AI_ACTIVE without premature staff handoff",
      (res as any).assistantAction === "AI_REPLY" &&
        (res as any).conversationStatus === "AI_ACTIVE" &&
        (res as any).handoffCause === null,
    );

    check(
      "G4. Preference remains durable in state alongside other booking facts",
      stateG?.knownFacts.timePreference === "evening" &&
        stateG?.knownFacts.service === "كشف أسنان" &&
        stateG?.knownFacts.date === "2026-10-21",
    );

    check(
      "G5. No incorrect slot offer or appointment is created",
      (stateG?.offer === undefined || stateG?.offer === null) &&
        harness.appointments.length === 0,
    );

    // Continuation 1: Customer explicitly changes preference to morning
    currentResponse = mockBooking({
      content: "تفضل المواعيد الصباحية المتاحة:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "morning",
      factUpdates: [
        { key: "timePreference", operation: "set", value: "morning" },
      ],
    });

    const resChange = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "لا خلاص خليها الصبح",
      receivedAt: new Date("2026-10-20T10:05:00Z").toISOString(),
      externalId: "msg-g-change",
    });

    const rawGChange = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const stateGChange = rawGChange
      ? hydrateConversationState(rawGChange.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    check(
      "G6. Explicit change to morning presents morning slot offer successfully",
      (resChange as any).assistantAction === "AI_REPLY" &&
        stateGChange?.offer?.kind === "SLOT" &&
        stateGChange?.knownFacts.timePreference === "morning",
    );

    // Continuation 2: Another harness testing explicit REMOVE from period-empty
    const harnessRem = createPlaygroundHarness({
      businessConfig: { workingHours: morningOnlyHours },
      todayRef: "2026-10-20",
    });
    harnessRem.deps.ai = {
      providerName: "mock-controlled-ai-rem",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return currentResponse!;
      },
    };

    currentResponse = mockBooking({
      content: "جاري البحث عن مواعيد مسائية:",
      service: "كشف أسنان",
      date: "2026-10-21",
      timePreference: "evening",
      factUpdates: [
        { key: "service", operation: "set", value: "كشف أسنان" },
        { key: "date", operation: "set", value: "2026-10-21" },
        { key: "timePreference", operation: "set", value: "evening" },
      ],
    });
    await receiveInboundMessage(harnessRem.deps, {
      to: harnessRem.business.whatsappNumber,
      from: harnessRem.customer.phone,
      text: "عايز كشف أسنان بالليل",
      receivedAt: harnessRem.getVirtualNow().toISOString(),
      externalId: "msg-g-rem-1",
    });

    currentResponse = mockBooking({
      content: "تفضل المواعيد المتاحة:",
      service: "كشف أسنان",
      date: "2026-10-21",
      factUpdates: [{ key: "timePreference", operation: "remove" }],
    });
    const resRemove = await receiveInboundMessage(harnessRem.deps, {
      to: harnessRem.business.whatsappNumber,
      from: harnessRem.customer.phone,
      text: "أي وقت مناسب مش فارقة",
      receivedAt: new Date("2026-10-20T10:05:00Z").toISOString(),
      externalId: "msg-g-rem-2",
    });

    const rawGRem = await harnessRem.stateStore.load(
      harnessRem.business.id,
      harnessRem.conversation.id,
    );
    const stateGRem = rawGRem
      ? hydrateConversationState(rawGRem.state, {
          businessId: harnessRem.business.id,
          conversationId: harnessRem.conversation.id,
        })
      : null;

    check(
      "G7. Explicit REMOVE broadens options and presents available slots",
      (resRemove as any).assistantAction === "AI_REPLY" &&
        stateGRem?.offer?.kind === "SLOT" &&
        stateGRem?.knownFacts.timePreference === undefined,
    );

    // G8. Genuinely closed / fully booked / no-provider outcomes remain distinguishable
    const closedHarness = createPlaygroundHarness({
      businessConfig: {
        workingHours: {
          ...morningOnlyHours,
          fri: { open: "09:00", close: "12:00", closed: true },
        },
      },
      todayRef: "2026-10-20",
    });
    const closedRes = await resolveBookingOptions(
      makeBookingDeps(closedHarness.deps),
      {
        userId: closedHarness.customer.id,
        businessId: closedHarness.business.id,
      },
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        date: "2026-10-23", // Friday closed
      },
    );
    check(
      "G8a. Genuinely closed day returns BUSINESS_CLOSED",
      closedRes.success && closedRes.reason === "BUSINESS_CLOSED",
    );

    // Fully booked day: mock blocking appointments covering 09:00-12:00
    const fullHarness = createPlaygroundHarness({
      businessConfig: { workingHours: morningOnlyHours },
      todayRef: "2026-10-20",
      initialAppointments: [
        {
          id: "appt-block-1",
          businessId: harness.business.id,
          branchId: harness.business.defaultBranchId,
          customerId: "c-other-1",
          serviceId: PLAYGROUND_IDS.SERV_DENTAL,
          providerId: PLAYGROUND_IDS.PROV_1,
          assignedUserId: PLAYGROUND_IDS.USER_P1,
          date: new Date("2026-10-21T00:00:00Z"),
          startTime: "09:00",
          endTime: "12:00",
          status: "CONFIRMED",
        },
        {
          id: "appt-block-2",
          businessId: harness.business.id,
          branchId: harness.business.defaultBranchId,
          customerId: "c-other-2",
          serviceId: PLAYGROUND_IDS.SERV_DENTAL,
          providerId: PLAYGROUND_IDS.PROV_2,
          assignedUserId: PLAYGROUND_IDS.USER_P2,
          date: new Date("2026-10-21T00:00:00Z"),
          startTime: "09:00",
          endTime: "12:00",
          status: "CONFIRMED",
        },
      ],
    });
    const fullRes = await resolveBookingOptions(
      makeBookingDeps(fullHarness.deps),
      { userId: fullHarness.customer.id, businessId: fullHarness.business.id },
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        date: "2026-10-21",
      },
    );
    check(
      "G8b. Genuinely full day returns FULLY_BOOKED",
      fullRes.success && fullRes.reason === "FULLY_BOOKED",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior H: Real-Engine Evening Booking Lifecycle (A–H)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior H: Real-Engine Evening Booking Lifecycle ---");
  {
    // A. A business has available morning and evening slots
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "lifecycle-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        modelCalls++;
        return mockBooking({
          content: "تفضل المواعيد المسائية المتاحة:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "evening",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "evening" },
          ],
        });
      },
    };

    // B. Request evening through a controlled canonical AI response
    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز كشف أسنان بالليل يوم الأربعاء",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-life-1",
    });

    const rawState = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const stateAfterOffer = rawState
      ? hydrateConversationState(rawState.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    // C. Receive an evening offer
    const offer = stateAfterOffer?.offer;
    check(
      "H-C. Receive an evening offer with slots strictly in evening period (>= 17:00)",
      offer !== undefined &&
        offer !== null &&
        offer.kind === "SLOT" &&
        offer.options.length > 0 &&
        offer.options.every((opt) => {
          const hh = parseInt(opt.startAt.slice(11, 13), 10);
          return hh >= 17;
        }),
    );

    const firstSlot = offer?.kind === "SLOT" ? offer.options[0] : null;

    // Disallow model invocation during mechanical selection
    harness.deps.ai = {
      providerName: "zero-call-guard",
      async respond(_req: AiRequest): Promise<AiResponse> {
        modelCalls++;
        throw new Error("MODEL_MUST_NOT_BE_INVOKED_DURING_SELECTION");
      },
    };

    const modelCallsBeforeSelection = modelCalls;

    // D. Select numeric index "1"
    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "1",
      receivedAt: new Date("2026-10-20T10:02:00Z").toISOString(),
      externalId: "msg-life-sel",
    });

    // F. Assert zero model invocations during selection
    check(
      "H-F. Assert zero model invocations during selection",
      modelCalls === modelCallsBeforeSelection,
    );

    // E. Assert exactly one appointment with the exact offered date, time, service, and provider
    const appts = harness.appointments;
    check(
      "H-E. Assert exactly one appointment created with exact date, time, service, and provider",
      appts.length === 1 &&
        appts[0].date.toISOString().slice(0, 10) === "2026-10-21" &&
        appts[0].startTime === firstSlot?.startAt.slice(11, 16) &&
        appts[0].serviceId === PLAYGROUND_IDS.SERV_DENTAL &&
        appts[0].providerId === firstSlot?.providerId,
    );

    // G. Repeat selection and prove no duplicate appointment (idempotency)
    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "1",
      receivedAt: new Date("2026-10-20T10:03:00Z").toISOString(),
      externalId: "msg-life-repeat",
    });
    check(
      "H-G. Repeat selection proves no duplicate appointment is created",
      harness.appointments.length === 1,
    );

    // Separate case for D: Select by validated Telegram callback
    const harnessTg = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    let tgModelCalls = 0;
    harnessTg.deps.ai = {
      providerName: "tg-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        tgModelCalls++;
        return mockBooking({
          content: "تفضل المواعيد المسائية:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "evening",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "evening" },
          ],
        });
      },
    };

    await receiveInboundMessage(harnessTg.deps, {
      to: harnessTg.business.whatsappNumber,
      from: "998877",
      text: "عايز كشف أسنان بالليل",
      receivedAt: harnessTg.getVirtualNow().toISOString(),
      externalId: "msg-tg-1",
    });

    const rawTg = await harnessTg.stateStore.load(
      harnessTg.business.id,
      harnessTg.conversation.id,
    );
    const tgState = rawTg
      ? hydrateConversationState(rawTg.state, {
          businessId: harnessTg.business.id,
          conversationId: harnessTg.conversation.id,
        })
      : null;

    const tgOffer = tgState?.offer;
    const tgFirstSlot = tgOffer?.kind === "SLOT" ? tgOffer.options[0] : null;

    harnessTg.deps.ai = {
      providerName: "tg-zero-guard",
      async respond(_req: AiRequest): Promise<AiResponse> {
        tgModelCalls++;
        throw new Error("TG_MODEL_MUST_NOT_BE_INVOKED_ON_CALLBACK");
      },
    };

    const tgCallsBeforeCallback = tgModelCalls;

    // Send validated callback token
    const callbackData = `fp:${tgOffer?.token}:1`;
    await receiveInboundMessage(harnessTg.deps, {
      to: harnessTg.business.whatsappNumber,
      from: "998877",
      text: callbackData,
      receivedAt: new Date("2026-10-20T10:02:00Z").toISOString(),
      externalId: "msg-tg-cb",
    });

    check(
      "H-D(cb). Validated callback creates exactly one appointment with zero model calls",
      tgModelCalls === tgCallsBeforeCallback &&
        harnessTg.appointments.length === 1 &&
        harnessTg.appointments[0].startTime ===
          tgFirstSlot?.startAt.slice(11, 16),
    );

    // H. Force slot-write conflict seam and verify refreshed offer retains evening & provider restrictions
    const harnessConflict = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    harnessConflict.deps.ai = {
      providerName: "conflict-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "تفضل المواعيد:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "evening",
          provider: "د. سارة عادل",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "evening" },
            { key: "provider", operation: "set", value: "د. سارة عادل" },
          ],
        });
      },
    };

    await receiveInboundMessage(harnessConflict.deps, {
      to: harnessConflict.business.whatsappNumber,
      from: harnessConflict.customer.phone,
      text: "عايز كشف أسنان بالليل مع د. سارة",
      receivedAt: harnessConflict.getVirtualNow().toISOString(),
      externalId: "msg-conf-init",
    });

    // Mock createWithConflictCheck to return null on the first write attempt
    let conflictSimulated = false;
    const apptRepo = harnessConflict.deps.appointmentRepository!;
    const realCreate = apptRepo.createWithConflictCheck!;
    apptRepo.createWithConflictCheck = async (dto: any) => {
      if (!conflictSimulated) {
        conflictSimulated = true;
        return null; // simulate concurrent slot conflict!
      }
      return realCreate.call(apptRepo, dto);
    };

    await receiveInboundMessage(harnessConflict.deps, {
      to: harnessConflict.business.whatsappNumber,
      from: harnessConflict.customer.phone,
      text: "1",
      receivedAt: new Date("2026-10-20T10:02:00Z").toISOString(),
      externalId: "msg-conf-select",
    });

    const rawConflictState = await harnessConflict.stateStore.load(
      harnessConflict.business.id,
      harnessConflict.conversation.id,
    );
    const stateConflict = rawConflictState
      ? hydrateConversationState(rawConflictState.state, {
          businessId: harnessConflict.business.id,
          conversationId: harnessConflict.conversation.id,
        })
      : null;

    const refreshedOffer = stateConflict?.offer;
    check(
      "H-H1. Conflict seam triggers re-offer instead of failed appointment",
      harnessConflict.appointments.length === 0 &&
        refreshedOffer !== undefined &&
        refreshedOffer !== null &&
        refreshedOffer.kind === "SLOT",
    );

    check(
      "H-H2. Refreshed offer retains evening restriction (options >= 17:00)",
      refreshedOffer?.kind === "SLOT" &&
        refreshedOffer.options.every((opt) => {
          const hh = parseInt(opt.startAt.slice(11, 13), 10);
          return hh >= 17;
        }),
    );

    check(
      "H-H3. Refreshed offer retains provider restriction",
      refreshedOffer?.kind === "SLOT" &&
        refreshedOffer.options.every(
          (opt) => opt.providerId === PLAYGROUND_IDS.PROV_2,
        ),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior I: Persisted Noncanonical State Handling ("الصبح")
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior I: Persisted Noncanonical State Handling ---");
  {
    // I1. Reload followed by a semantic booking continuation with NO time update
    const harness1 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    const seededState1 = {
      version: 1,
      currentGoal: "BOOKING",
      activeTask: { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" },
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-21",
        timePreference: "الصبح", // Noncanonical persisted value!
      },
      missingFacts: [],
      bookingStage: "AVAILABILITY_RESOLVED",
      pendingGoals: [],
      lastClarification: null,
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      serviceSource: "CUSTOMER",
      offer: null,
      suspendedOffer: null,
      completedTask: null,
    };
    await harness1.stateStore.save(
      harness1.business.id,
      harness1.conversation.id,
      null,
      seededState1,
    );

    harness1.deps.ai = {
      providerName: "legacy-guard-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "تمام، دعنا نتابع حجزك.",
          service: "كشف أسنان",
          date: "2026-10-21",
          // Notice: NO timePreference fact update or extraction!
        });
      },
    };

    const resContinuation = await receiveInboundMessage(harness1.deps, {
      to: harness1.business.whatsappNumber,
      from: harness1.customer.phone,
      text: "تمام أنا جاهز للحجز",
      receivedAt: harness1.getVirtualNow().toISOString(),
      externalId: "msg-i-cont",
    });

    const rawAfter1 = await harness1.stateStore.load(
      harness1.business.id,
      harness1.conversation.id,
    );
    const stateAfter1 = rawAfter1
      ? hydrateConversationState(rawAfter1.state, {
          businessId: harness1.business.id,
          conversationId: harness1.conversation.id,
        })
      : null;

    const lastDelivered1 =
      harness1.deliveredOutbound[harness1.deliveredOutbound.length - 1];

    check(
      "I1a. Saved noncanonical preference prompts clarification without silently treating as unrestricted",
      lastDelivered1?.body.includes("يرجى تحديد وقت الحجز المفضل") ?? false,
    );
    check(
      "I1b. Conversation remains AI_ACTIVE and zero appointments are created",
      (resContinuation as any).conversationStatus === "AI_ACTIVE" &&
        harness1.appointments.length === 0,
    );
    check(
      "I1c. Saved value and unrelated booking facts are preserved in durable state",
      stateAfter1?.knownFacts.timePreference === "الصبح" &&
        stateAfter1?.knownFacts.service === "كشف أسنان" &&
        stateAfter1?.knownFacts.date === "2026-10-21",
    );

    // I2. /start or guided continuation with saved noncanonical preference
    const harness2 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    await harness2.stateStore.save(
      harness2.business.id,
      harness2.conversation.id,
      null,
      seededState1,
    );

    harness2.deps.ai = {
      providerName: "zero-call-for-start",
      async respond(_req: AiRequest): Promise<AiResponse> {
        throw new Error("START_MUST_NOT_INVOKE_MODEL");
      },
    };

    await receiveInboundMessage(harness2.deps, {
      to: harness2.business.whatsappNumber,
      from: harness2.customer.phone,
      text: "/start",
      receivedAt: harness2.getVirtualNow().toISOString(),
      externalId: "msg-i-start",
    });

    const lastDelivered2 =
      harness2.deliveredOutbound[harness2.deliveredOutbound.length - 1];

    check(
      "I2. /start with saved noncanonical preference asks for clarification and prevents unrestricted slot presentation",
      (lastDelivered2?.body.includes("يرجى تحديد وقت الحجز المفضل") ?? false) &&
        harness2.appointments.length === 0,
    );

    // I3. Recovery with canonical SET
    const harness3 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    await harness3.stateStore.save(
      harness3.business.id,
      harness3.conversation.id,
      null,
      seededState1,
    );

    harness3.deps.ai = {
      providerName: "recovery-set-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "تفضل المواعيد الصباحية المتاحة:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "morning",
          factUpdates: [
            { key: "timePreference", operation: "set", value: "morning" },
          ],
        });
      },
    };

    const resSetRecovery = await receiveInboundMessage(harness3.deps, {
      to: harness3.business.whatsappNumber,
      from: harness3.customer.phone,
      text: "عايزها الصبح بدري",
      receivedAt: harness3.getVirtualNow().toISOString(),
      externalId: "msg-i-set",
    });

    const rawAfter3 = await harness3.stateStore.load(
      harness3.business.id,
      harness3.conversation.id,
    );
    const stateAfter3 = rawAfter3
      ? hydrateConversationState(rawAfter3.state, {
          businessId: harness3.business.id,
          conversationId: harness3.conversation.id,
        })
      : null;

    check(
      "I3. Recovery via canonical SET updates state to 'morning' and presents morning options",
      stateAfter3?.knownFacts.timePreference === "morning" &&
        stateAfter3?.offer?.kind === "SLOT" &&
        (resSetRecovery as any).conversationStatus === "AI_ACTIVE",
    );

    // I4. Recovery with explicit REMOVE
    const harness4 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });
    await harness4.stateStore.save(
      harness4.business.id,
      harness4.conversation.id,
      null,
      seededState1,
    );

    harness4.deps.ai = {
      providerName: "recovery-remove-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "تفضل المواعيد المتاحة على مدار اليوم:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [{ key: "timePreference", operation: "remove" }],
        });
      },
    };

    const resRemRecovery = await receiveInboundMessage(harness4.deps, {
      to: harness4.business.whatsappNumber,
      from: harness4.customer.phone,
      text: "أي وقت مناسب",
      receivedAt: harness4.getVirtualNow().toISOString(),
      externalId: "msg-i-rem",
    });

    const rawAfter4 = await harness4.stateStore.load(
      harness4.business.id,
      harness4.conversation.id,
    );
    const stateAfter4 = rawAfter4
      ? hydrateConversationState(rawAfter4.state, {
          businessId: harness4.business.id,
          conversationId: harness4.conversation.id,
        })
      : null;

    check(
      "I4. Recovery via explicit REMOVE removes preference and presents unconstrained options",
      stateAfter4?.knownFacts.timePreference === undefined &&
        stateAfter4?.offer?.kind === "SLOT" &&
        (resRemRecovery as any).conversationStatus === "AI_ACTIVE",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior J: Mechanical-path regression
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior J: Mechanical-path regression ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        modelCalls++;
        throw new Error("MODEL_SHOULD_NOT_BE_INVOKED_ON_MECHANICAL_PATHS");
      },
    };

    // J1. /start command with clean state
    const resStart = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "/start",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-j-start-clean",
    });

    check(
      "J1. /start command executes with zero model calls on clean state",
      modelCalls === 0 && (resStart as any).assistantAction === "AI_REPLY",
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
    console.error("FAILURES:");
    for (const f of failures) {
      console.error(`- ${f}`);
    }
    process.exit(1);
  }

  console.log("✔ ALL CORE-03D1 ACCEPTANCE CHECKS PASSED SUCCESSFULLY!");
}

main().catch((err) => {
  console.error("Fatal error in acceptance suite:", err);
  process.exit(1);
});
