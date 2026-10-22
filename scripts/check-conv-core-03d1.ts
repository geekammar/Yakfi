/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

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
  // Behavior G: No matching options
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior G: No matching options ---");
  {
    // Business working hours 09:00 to 12:00 (zero evening slots available)
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

    harness.deps.ai = {
      providerName: "mock-controlled-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
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
      },
    };

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

    check(
      "G1. With zero matching evening options, engine does NOT present morning/unrestricted slots",
      stateG?.offer === undefined || stateG?.offer === null,
    );
    check(
      "G2. Truthful no-options / handoff is triggered (DOMAIN_REQUIRES_HUMAN)",
      (res as any).assistantAction === "AI_HANDOFF" &&
        (res as any).handoffCause === "DOMAIN_REQUIRES_HUMAN",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Behavior H: Mechanical-path regression
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Behavior H: Mechanical-path regression ---");
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

    // H1. /start command
    const resStart = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "/start",
      receivedAt: harness.getVirtualNow().toISOString(),
      externalId: "msg-h-1",
    });

    check(
      "H1. /start command executes with zero model calls",
      modelCalls === 0 && (resStart as any).assistantAction === "AI_REPLY",
    );

    // H2. Numeric slot selection against an active offer
    const harness2 = createPlaygroundHarness({
      businessConfig: { workingHours: longHours },
      todayRef: "2026-10-20",
    });

    // First populate active slot offer via controlled AI
    harness2.deps.ai = {
      providerName: "seed-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        return mockBooking({
          content: "تفضل المواعيد:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "morning",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "morning" },
          ],
        });
      },
    };

    await receiveInboundMessage(harness2.deps, {
      to: harness2.business.whatsappNumber,
      from: harness2.customer.phone,
      text: "عايز كشف أسنان الصبح",
      receivedAt: harness2.getVirtualNow().toISOString(),
      externalId: "msg-h-seed",
    });

    // Reset AI to strictly fail if called on mechanical selection
    let mechanicalModelInvocations = 0;
    harness2.deps.ai = {
      providerName: "strictly-zero-ai",
      async respond(_req: AiRequest): Promise<AiResponse> {
        mechanicalModelInvocations++;
        throw new Error("MECHANICAL_SELECTION_MUST_NOT_INVOKE_MODEL");
      },
    };

    const resSelect = await receiveInboundMessage(harness2.deps, {
      to: harness2.business.whatsappNumber,
      from: harness2.customer.phone,
      text: "1",
      receivedAt: harness2.getVirtualNow().toISOString(),
      externalId: "msg-h-select",
    });

    const appointmentsAfter = harness2.appointments;
    const lastDelivered =
      harness2.deliveredOutbound[harness2.deliveredOutbound.length - 1];

    check(
      "H2a. Numeric selection '1' booked appointment with exactly zero model invocations",
      mechanicalModelInvocations === 0 && appointmentsAfter.length === 1,
    );
    check(
      "H2b. Mechanical selection response confirms booking",
      (resSelect as any).assistantAction === "AI_REPLY" &&
        (lastDelivered?.body.includes("تم تأكيد حجزك") ?? false),
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
