/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import { type AiResponse } from "../src/features/conversations/server/ai-contract";
import { offerCallbackData } from "../src/features/conversations/server/booking-offer";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import { hydrateConversationState } from "../src/features/conversations/server/conversation-state";

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
  timePreference?: "morning" | "afternoon" | "evening" | null;
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

async function sendCustomer(harness: any, text: string, externalId?: string) {
  const fromHandle = harness.customer.phone.startsWith("tg:")
    ? harness.customer.phone.replace(/^tg:/, "")
    : harness.customer.phone;
  const toHandle = harness.business.whatsappNumber ?? "+201001111111";
  return receiveInboundMessage(harness.deps, {
    to: toHandle,
    from: fromHandle,
    text,
    receivedAt: harness.getVirtualNow().toISOString(),
    ...(externalId ? { externalId } : {}),
  });
}

async function loadState(harness: any) {
  const savedRow = await harness.stateStore.load(
    harness.business.id,
    harness.conversation.id,
  );
  if (!savedRow) return null;
  return hydrateConversationState(savedRow.state, {
    businessId: harness.business.id,
    conversationId: harness.conversation.id,
  });
}

async function runJourneys(): Promise<void> {
  console.log(
    "=== FlowPilot CORE-03D3 Provider Journey Acceptance Suite ===\n",
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY A & B: Provider named, service omitted, multiple services, no default
  // Followed by unique provider match and mechanical booking confirmation
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(
    "--- Journey A & B: Provider Named, Missing Service Clarification, Unique Match & Confirmation ---",
  );

  {
    // Setup harness with multiple services, no default service
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        defaultServiceBookingEnabled: false,
        defaultBookingServiceId: null,
      },
      todayRef: "2026-10-20",
    });

    // Custom eligibility: PROV_2 (Dr. Sara) is eligible for SERV_DENTAL, but NOT for SERV_CLEAN
    harness.deps.providerRepository!.listEligibleForService = async (
      _bId: string,
      sId: string,
    ) => {
      if (sId === PLAYGROUND_IDS.SERV_DENTAL) {
        return [
          {
            id: PLAYGROUND_IDS.PROV_1,
            userId: PLAYGROUND_IDS.USER_P1,
            displayName: "د. أحمد سامي",
            name: "د. أحمد سامي",
            isActive: true,
          },
          {
            id: PLAYGROUND_IDS.PROV_2,
            userId: PLAYGROUND_IDS.USER_P2,
            displayName: "د. سارة عادل",
            name: "د. سارة عادل",
            isActive: true,
          },
        ];
      }
      // For SERV_CLEAN, only Dr. Ahmed is eligible
      return [
        {
          id: PLAYGROUND_IDS.PROV_1,
          userId: PLAYGROUND_IDS.USER_P1,
          displayName: "د. أحمد سامي",
          name: "د. أحمد سامي",
          isActive: true,
        },
      ];
    };

    let modelCallCount = 0;
    harness.deps.ai = {
      providerName: "mock-model",
      respond: async () => {
        modelCallCount++;
        return mockBooking({
          content:
            "يرجى تحديد الخدمة المطلوبة لحجز موعد مع د. سارة عادل يوم الأربعاء.",
          service: null,
          provider: "د. سارة عادل",
          date: "2026-10-21",
          factUpdates: [
            { key: "provider", operation: "set", value: "د. سارة عادل" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        });
      },
    } as any;

    // Turn 1: Customer requests booking with provider & date, omitting service
    const turn1 = await sendCustomer(
      harness,
      "عايز أحجز مع دكتورة سارة يوم الأربعاء 2026-10-21",
    );

    check(
      "A1. Turn 1 returns AI_REPLY / AI_ACTIVE",
      turn1.ok && (turn1 as any).conversationStatus === "AI_ACTIVE",
    );
    check("A2. Model invoked exactly once on Turn 1", modelCallCount === 1);

    // Reload durable state before next turn
    let state = await loadState(harness);

    check(
      "A3. Turn 1 persists provider and date in durable facts",
      state?.knownFacts.provider === "د. سارة عادل" &&
        state?.knownFacts.date === "2026-10-21" &&
        state?.providerPreference === "د. سارة عادل" &&
        state?.selectedDate === "2026-10-21",
    );
    check(
      "A4. Turn 1 presents ServiceOffer choices to clarify missing service",
      state?.offer?.kind === "SERVICE" &&
        state.offer.options.length === 2 &&
        state.offer.options.some((o) => o.name === "كشف أسنان"),
    );

    // Turn 2: Customer selects Service 1 ("كشف أسنان", index 1)
    // Sara IS eligible for "كشف أسنان"
    const serviceCallback = offerCallbackData(state!.offer!, 1);
    const turn2 = await sendCustomer(harness, serviceCallback);

    check(
      "A5. Turn 2 service selection returns AI_REPLY / AI_ACTIVE",
      turn2.ok && (turn2 as any).conversationStatus === "AI_ACTIVE",
    );
    check(
      "A6. Mechanical service selection spends ZERO additional model calls",
      modelCallCount === 1,
    );

    // Reload durable state after Turn 2
    state = await loadState(harness);

    check(
      "A7. Turn 2 preserves original provider and date in durable facts",
      state?.knownFacts.provider === "د. سارة عادل" &&
        state?.knownFacts.date === "2026-10-21" &&
        state?.serviceId === PLAYGROUND_IDS.SERV_DENTAL,
    );

    // Journey B: Unique provider match
    check(
      "B1. Turn 2 resolves Dr. Sara to authoritative ID and presents SlotOffer with providerId",
      state?.offer?.kind === "SLOT" &&
        state.offer.providerId === PLAYGROUND_IDS.PROV_2 &&
        state.offer.serviceId === PLAYGROUND_IDS.SERV_DENTAL &&
        state.offer.date === "2026-10-21",
    );

    // Availability queries must have been queried with Dr. Sara's scope (USER_P2)
    const queries = harness.capturedAvailabilityQueries;
    const saraQuery = queries.find(
      (q) =>
        q.date === "2026-10-21" &&
        q.assigneeIds.includes(PLAYGROUND_IDS.USER_P2) &&
        !q.assigneeIds.includes(PLAYGROUND_IDS.USER_P1),
    );
    check(
      "B2. Availability queried with exact provider scope (Sara / USER_P2)",
      Boolean(saraQuery),
    );

    // Turn 3: Mechanical slot selection
    const slotCallback = offerCallbackData(state!.offer!, 1);
    const turn3 = await sendCustomer(harness, slotCallback);

    check(
      "B3. Turn 3 slot confirmation completes booking",
      turn3.ok && (turn3 as any).conversationStatus === "BOOKED",
    );
    check(
      "B4. Zero additional model invocations across entire mechanical path",
      modelCallCount === 1,
    );

    // Reload state after booking completion
    state = await loadState(harness);

    check(
      "B5. Completed task recorded with exact service, date, and provider",
      state?.completedTask?.kind === "BOOKING" &&
        state.completedTask.serviceId === PLAYGROUND_IDS.SERV_DENTAL &&
        state.completedTask.providerId === PLAYGROUND_IDS.PROV_2 &&
        state.completedTask.date === "2026-10-21",
    );
    check(
      "B6. Active offer consumed and booking facts cleared from state",
      state?.offer?.status === "CONSUMED" &&
        state?.bookingStage === "COMPLETED",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY C: Unknown or ambiguous provider
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Journey C: Unknown or Ambiguous Provider ---");

  {
    // C1: Unknown provider
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "mock-model",
      respond: async () => {
        modelCalls++;
        return mockBooking({
          content: "عايز تحجز مع طبيب غير معروف؟",
          service: "كشف أسنان",
          provider: "طبيب غير موجود بالعيادة",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            {
              key: "provider",
              operation: "set",
              value: "طبيب غير موجود بالعيادة",
            },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        });
      },
    } as any;

    const turn1 = await sendCustomer(
      harness,
      "عايز كشف أسنان مع طبيب غير موجود بالعيادة بكرة",
    );

    check(
      "C1a. Unknown provider turn returns AI_REPLY / AI_ACTIVE",
      turn1.ok && (turn1 as any).conversationStatus === "AI_ACTIVE",
    );

    let state = await loadState(harness);

    check(
      "C1b. Unknown provider prompts clarification with ProviderOffer from eligible catalog",
      state?.offer?.kind === "PROVIDER" &&
        state.offer.options.some((o) => o.name === "د. أحمد سامي") &&
        state.offer.options.some(
          (o) => o.providerId === null && o.name === "أي مقدم خدمة متاح",
        ),
    );
    check(
      "C1c. Unknown provider does NOT silently replace customer preference with ANY in durable state",
      state?.knownFacts.provider === "طبيب غير موجود بالعيادة" &&
        state?.providerPreference === "طبيب غير موجود بالعيادة",
    );
    check(
      "C1d. Zero appointments created before clarification",
      harness.appointments.length === 0,
    );
    check(
      "C1e. Model invoked exactly once for unknown provider",
      modelCalls === 1,
    );

    // C2: Ambiguous provider (e.g. "د. أحمد" matching multiple Ahmeds)
    const harnessAmbiguous = createPlaygroundHarness({
      channel: "TELEGRAM",
      customProviders: [
        {
          id: "p-ahmed-1",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          userId: "u-ahmed-1",
          name: "د. أحمد سامي",
          displayName: "د. أحمد سامي",
          title: "طبيب أسنان",
          isActive: true,
        },
        {
          id: "p-ahmed-2",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          userId: "u-ahmed-2",
          name: "د. أحمد علي",
          displayName: "د. أحمد علي",
          title: "طبيب أسنان",
          isActive: true,
        },
      ] as any,
      todayRef: "2026-10-20",
    });

    harnessAmbiguous.deps.ai = {
      providerName: "mock-model",
      respond: async () =>
        mockBooking({
          content: "أي دكتور أحمد تقصد؟",
          service: "كشف أسنان",
          provider: "د. أحمد",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "provider", operation: "set", value: "د. أحمد" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
    } as any;

    const turnAmbiguous = await sendCustomer(
      harnessAmbiguous,
      "عايز كشف أسنان مع دكتور أحمد بكرة",
    );

    check(
      "C2a. Ambiguous provider turn returns AI_REPLY / AI_ACTIVE",
      turnAmbiguous.ok &&
        (turnAmbiguous as any).conversationStatus === "AI_ACTIVE",
    );

    state = await loadState(harnessAmbiguous);

    check(
      "C2b. Ambiguous provider prompts clarification with ProviderOffer listing both candidates",
      state?.offer?.kind === "PROVIDER" &&
        state.offer.options.some((o) => o.name === "د. أحمد سامي") &&
        state.offer.options.some((o) => o.name === "د. أحمد علي"),
    );
    check(
      "C2c. Ambiguous provider does not store display name as providerId UUID",
      state?.offer?.kind === "PROVIDER" &&
        state.offer.options.every(
          (o) => o.providerId === null || o.providerId.startsWith("p-ahmed"),
        ),
    );
    check(
      "C2d. Conversation remains recoverable without appointments created",
      harnessAmbiguous.appointments.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY D: Explicit ANY / REMOVE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(
    "\n--- Journey D: Explicit ANY and Controlled Semantic REMOVE ---",
  );

  {
    // D1: Validated ANY button / selection
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });

    // Seed state with clarification ProviderOffer where Dr. Sara was previously held
    harness.deps.ai = {
      providerName: "mock-model",
      respond: async () =>
        mockBooking({
          content: "اختر الطبيب",
          service: "كشف أسنان",
          provider: "طبيب غير معروف",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "provider", operation: "set", value: "طبيب غير معروف" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
    } as any;

    await sendCustomer(harness, "عايز كشف أسنان مع طبيب غير معروف بكرة");

    let state = await loadState(harness);

    // Find the ANY option in ProviderOffer (option with providerId === null)
    const anyOption =
      state?.offer?.kind === "PROVIDER"
        ? state.offer.options.find((o) => o.providerId === null)
        : null;
    check(
      "D1a. ProviderOffer contains explicit ANY option",
      Boolean(anyOption),
    );

    const anyCallback = offerCallbackData(state!.offer!, anyOption!.index);
    harness.capturedAvailabilityQueries.length = 0;

    // Select ANY
    const turnAny = await sendCustomer(harness, anyCallback);

    check(
      "D1b. Selecting ANY returns AI_REPLY / AI_ACTIVE",
      turnAny.ok && (turnAny as any).conversationStatus === "AI_ACTIVE",
    );

    state = await loadState(harness);

    check(
      "D1c. Provider removed from durable facts and compatibility mirrors after ANY selection",
      state?.knownFacts.provider == null && state?.providerPreference === null,
    );
    check(
      "D1d. Service and date preserved after ANY selection",
      state?.knownFacts.service === "كشف أسنان" &&
        state?.knownFacts.date === "2026-10-21",
    );

    // Check availability query was unconstrained (all providers included)
    const unconstrainedQuery = harness.capturedAvailabilityQueries.find(
      (q) =>
        q.date === "2026-10-21" &&
        q.assigneeIds.includes(PLAYGROUND_IDS.USER_P1) &&
        q.assigneeIds.includes(PLAYGROUND_IDS.USER_P2),
    );
    check(
      "D1e. Availability queried without previous provider restriction (unconstrained)",
      Boolean(unconstrainedQuery),
    );

    // D2: Controlled semantic provider REMOVE
    const harnessRemove = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });

    let removeTurnCount = 0;
    harnessRemove.deps.ai = {
      providerName: "mock-model",
      respond: async () => {
        removeTurnCount++;
        if (removeTurnCount === 1) {
          return mockBooking({
            content: "المواعيد المتاحة مع د. سارة عادل يوم الأربعاء:",
            service: "كشف أسنان",
            provider: "د. سارة عادل",
            date: "2026-10-21",
            factUpdates: [
              { key: "service", operation: "set", value: "كشف أسنان" },
              { key: "provider", operation: "set", value: "د. سارة عادل" },
              { key: "date", operation: "set", value: "2026-10-21" },
            ],
          });
        }
        // Turn 2: Model emits REMOVE fact update
        return mockBooking({
          content: "تمام، متاح المواعيد التالية مع أي طبيب متاح:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [{ key: "provider", operation: "remove" }],
        });
      },
    } as any;

    // Turn 1: Establish Dr. Sara preference
    await sendCustomer(
      harnessRemove,
      "عايز كشف أسنان مع دكتورة سارة يوم الأربعاء",
    );

    state = await loadState(harnessRemove);
    check(
      "D2a. Specific provider preference established in state",
      state?.knownFacts.provider === "د. سارة عادل",
    );

    // Turn 2: Customer asks to remove provider preference ("خلاص أي دكتور متاح")
    harnessRemove.capturedAvailabilityQueries.length = 0;
    const turnRemove = await sendCustomer(harnessRemove, "خلاص أي دكتور متاح");

    check(
      "D2b. Controlled semantic REMOVE executes successfully",
      turnRemove.ok && (turnRemove as any).conversationStatus === "AI_ACTIVE",
    );

    state = await loadState(harnessRemove);

    check(
      "D2c. Provider removed from durable facts and compatibility mirrors on semantic REMOVE",
      state?.knownFacts.provider == null && state?.providerPreference === null,
    );
    check(
      "D2d. Service and date preserved after semantic REMOVE",
      state?.knownFacts.service === "كشف أسنان" &&
        state?.knownFacts.date === "2026-10-21",
    );

    const removeQuery = harnessRemove.capturedAvailabilityQueries.find(
      (q) =>
        q.date === "2026-10-21" &&
        q.assigneeIds.includes(PLAYGROUND_IDS.USER_P1) &&
        q.assigneeIds.includes(PLAYGROUND_IDS.USER_P2),
    );
    check(
      "D2e. Availability queried unconstrained across eligible providers",
      Boolean(removeQuery),
    );

    // Turn 3: Continuation turn (e.g. asking a question or confirming) — old preference must not be resurrected!
    harnessRemove.deps.ai = {
      providerName: "mock-model",
      respond: async () =>
        mockBooking({
          content: "المواعيد المتاحة يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [],
        }),
    } as any;

    await sendCustomer(harnessRemove, "طيب المواعيد لسه متاحة؟");

    state = await loadState(harnessRemove);

    check(
      "D2f. Old provider preference ('د. سارة عادل') is NOT resurrected on continuation",
      state?.knownFacts.provider == null && state?.providerPreference === null,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY E: Default service and service changes
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Journey E: Default Service and Service Changes ---");

  {
    // E1: Default service bypass when service is omitted
    const harnessDefault = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        defaultServiceBookingEnabled: true,
        defaultBookingServiceId: PLAYGROUND_IDS.SERV_DENTAL,
      },
      todayRef: "2026-10-20",
    });

    harnessDefault.deps.ai = {
      providerName: "mock-model",
      respond: async () =>
        mockBooking({
          content: "متاح المواعيد التالية:",
          service: null, // Service omitted by customer
          date: "2026-10-21",
          provider: "د. سارة عادل",
          factUpdates: [
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "provider", operation: "set", value: "د. سارة عادل" },
          ],
        }),
    } as any;

    const turnDefault = await sendCustomer(
      harnessDefault,
      "عايز ميعاد مع دكتورة سارة بكرة",
    );

    check(
      "E1a. Default service retains bypass when service is omitted",
      turnDefault.ok && (turnDefault as any).conversationStatus === "AI_ACTIVE",
    );

    let state = await loadState(harnessDefault);

    check(
      "E1b. Resolved service is the configured default service",
      state?.serviceId === PLAYGROUND_IDS.SERV_DENTAL &&
        state?.serviceSource === "DEFAULT",
    );

    // E2: Explicit unknown service must NOT silently become default!
    const harnessUnknownService = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        defaultServiceBookingEnabled: true,
        defaultBookingServiceId: PLAYGROUND_IDS.SERV_DENTAL,
      },
      todayRef: "2026-10-20",
    });

    harnessUnknownService.deps.ai = {
      providerName: "mock-model",
      respond: async () =>
        mockBooking({
          content: "عايز كشف عيون؟",
          service: "كشف عيون", // Explicit unknown service
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف عيون" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
    } as any;

    const turnUnknownService = await sendCustomer(
      harnessUnknownService,
      "عايز كشف عيون بكرة",
    );

    check(
      "E2a. Unknown service returns clarification reply",
      turnUnknownService.ok &&
        (turnUnknownService as any).conversationStatus === "AI_ACTIVE",
    );

    state = await loadState(harnessUnknownService);

    check(
      "E2b. Explicit unknown service does NOT silently resolve to default service",
      state?.serviceId !== PLAYGROUND_IDS.SERV_DENTAL &&
        state?.serviceSource !== "DEFAULT",
    );

    // E3: Service change revalidates provider eligibility
    // Setup where PROV_2 (Dr. Sara) is eligible for SERV_DENTAL, but NOT eligible for SERV_CLEAN
    const harnessChange = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });

    harnessChange.deps.providerRepository!.listEligibleForService = async (
      _bId: string,
      sId: string,
    ) => {
      if (sId === PLAYGROUND_IDS.SERV_DENTAL) {
        return [
          {
            id: PLAYGROUND_IDS.PROV_2,
            userId: PLAYGROUND_IDS.USER_P2,
            displayName: "د. سارة عادل",
            name: "د. سارة عادل",
            isActive: true,
          },
        ];
      }
      // For SERV_CLEAN, only Ahmed is eligible, NOT Sara
      return [
        {
          id: PLAYGROUND_IDS.PROV_1,
          userId: PLAYGROUND_IDS.USER_P1,
          displayName: "د. أحمد سامي",
          name: "د. أحمد سامي",
          isActive: true,
        },
      ];
    };

    let changeStep = 0;
    harnessChange.deps.ai = {
      providerName: "mock-model",
      respond: async () => {
        changeStep++;
        if (changeStep === 1) {
          return mockBooking({
            content: "تم اختيار كشف أسنان مع د. سارة عادل",
            service: "كشف أسنان",
            provider: "د. سارة عادل",
            date: "2026-10-21",
            factUpdates: [
              { key: "service", operation: "set", value: "كشف أسنان" },
              { key: "provider", operation: "set", value: "د. سارة عادل" },
              { key: "date", operation: "set", value: "2026-10-21" },
            ],
          });
        }
        // Step 2: Customer changes service to "تنظيف أسنان"
        return mockBooking({
          content: "غيرنا الخدمة لتنظيف أسنان",
          service: "تنظيف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
          ],
        });
      },
    } as any;

    await sendCustomer(
      harnessChange,
      "عايز كشف أسنان مع دكتورة سارة يوم الأربعاء",
    );

    state = await loadState(harnessChange);
    check(
      "E3a. Initial state has Dr. Sara for dental exam",
      state?.knownFacts.provider === "د. سارة عادل",
    );

    // Change service to "تنظيف أسنان"
    await sendCustomer(harnessChange, "لا خليها تنظيف أسنان");

    state = await loadState(harnessChange);

    check(
      "E3b. Changing service drops previously held provider that was service-dependent",
      state?.serviceId === PLAYGROUND_IDS.SERV_CLEAN &&
        state?.knownFacts.provider == null,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // JOURNEY F: Lifecycle protection
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("\n--- Journey F: Lifecycle Protection ---");

  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-model",
      respond: async () =>
        mockBooking({
          content: "المواعيد المتاحة:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
    } as any;

    // Turn 1: Present SlotOffer
    await sendCustomer(harness, "عايز كشف أسنان يوم الأربعاء");

    const state = await loadState(harness);
    check(
      "F1a. SlotOffer presented and ACTIVE",
      state?.offer?.kind === "SLOT" && state.offer.status === "ACTIVE",
    );

    const slotToken = offerCallbackData(state!.offer!, 1);

    // F1: Confirm slot -> COMPLETED
    const confirm1 = await sendCustomer(harness, slotToken);
    check(
      "F1b. First confirmation succeeds with BOOKED",
      confirm1.ok && (confirm1 as any).conversationStatus === "BOOKED",
    );
    check(
      "F1c. Exactly 1 appointment created",
      harness.appointments.length === 1,
    );

    // F2: Repeated confirmation with same token -> cannot create duplicates
    const confirm2 = await sendCustomer(harness, slotToken);
    check(
      "F2a. Repeated confirmation rejected / does not book again",
      confirm2.ok && (confirm2 as any).conversationStatus !== "BOOKED",
    );
    check(
      "F2b. Appointment count remains strictly 1 (no duplicate)",
      harness.appointments.length === 1,
    );

    // F3: Staff-owned conversation remains deferred
    const harnessStaff = createPlaygroundHarness({
      channel: "TELEGRAM",
      conversationStatus: "NEED_HUMAN",
      assignedUserId: "staff-user-1",
      todayRef: "2026-10-20",
    });

    let staffModelCalls = 0;
    harnessStaff.deps.ai = {
      providerName: "mock-model",
      respond: async () => {
        staffModelCalls++;
        return mockBooking({ content: "test" });
      },
    } as any;

    const turnStaff = await sendCustomer(
      harnessStaff,
      "عايز أحجز ميعاد دلوقتي",
    );

    check(
      "F3a. Staff-owned conversation defers to staff (DEFERRED_TO_STAFF)",
      (turnStaff as any).assistantAction === "DEFERRED_TO_STAFF",
    );
    check(
      "F3b. Zero model calls and zero appointments for staff-owned conversation",
      staffModelCalls === 0 && harnessStaff.appointments.length === 0,
    );

    // F4: Failed offer persistence (CAS conflict) suppresses actionable keyboard
    const harnessCas = createPlaygroundHarness({
      channel: "TELEGRAM",
      todayRef: "2026-10-20",
    });

    harnessCas.deps.ai = {
      providerName: "mock-model",
      respond: async () =>
        mockBooking({
          content: "المواعيد المتاحة:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
    } as any;

    // Simulate CAS failure on save
    harnessCas.stateStore.save = async () => ({ status: "conflict" });

    const turnCas = await sendCustomer(
      harnessCas,
      "عايز كشف أسنان يوم الأربعاء",
    );

    check(
      "F4a. CAS conflict returns safe retry notice",
      turnCas.ok && (turnCas as any).conversationStatus === "AI_ACTIVE",
    );
    const lastOutbound =
      harnessCas.deliveredOutbound[harnessCas.deliveredOutbound.length - 1];
    check(
      "F4b. Failed offer persistence suppresses actionable replyMarkup / buttons",
      lastOutbound?.replyMarkup == null,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(`\n========================================`);
  console.log(`Total Checks: ${totalChecks}`);
  console.log(`Passed Checks: ${passedChecks}`);
  console.log(`Failed Checks: ${failures.length}`);
  console.log(`========================================\n`);

  if (failures.length > 0) {
    console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  } else {
    console.log("All CORE-03D3 provider journey acceptance tests passed! 🚀");
  }
}

runJourneys().catch((err) => {
  console.error("Unhandled error in test runner:", err);
  process.exit(1);
});
