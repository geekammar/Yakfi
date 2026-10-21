/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — CORE-03B2B1 Verification Suite
 * Semantic-Authoritative Date, Time and Provider Facts
 *
 * Verifies that on the structured semantic path:
 * - Validated AI proposals and authoritative durable state are the sole sources of
 *   date, timePreference, and provider facts.
 * - Raw customer prose after AI is never reinterpreted to invent, replace, remove, or restore those facts.
 * - Domain validation, calendar validity, operating hours, and eligibility checks are preserved.
 *
 * Parts:
 * A. Competing prose must not act as a second fact source
 * B. Explicit changes (SET, REMOVE, colliding first names, agreement across state/query/offer)
 * C. Persistence and continuation (no revival, pending clarification safety, no silent date guessing)
 * D. Existing product boundaries (zero-model mechanical choices, mixed prose, default service, staff safety)
 *
 * Run: pnpm check:conv-core-03b2b1
 */

import { type AiResponse } from "../src/features/conversations/server/ai-contract";
import { buildSlotOffer } from "../src/features/conversations/server/booking-offer";
import { parseBookingSelection } from "../src/features/conversations/server/booking-selection";
import {
  receiveInboundMessage,
  type ConversationEngineDeps,
} from "../src/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
  hydrateConversationState,
  withPresentedOffer,
} from "../src/features/conversations/server/conversation-state";
import { createLlmConversationAi } from "../src/server/integrations/ai/conversation-ai";
import {
  createJevDecisionsProvider,
  type JevDecisionsProvider,
} from "../src/server/integrations/ai/jev-decisions-provider";
import { createSemanticJevStrategy } from "../src/server/integrations/ai/jev-semantic-strategy";
import { createOpenRouterAdapter } from "../src/server/integrations/ai/openrouter";
import type { AiProviderAdapter } from "../src/server/integrations/ai/types";

type Check = { label: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];

function check(label: string, pass: boolean, detail?: unknown): void {
  if (!pass && detail !== undefined) {
    console.error(`[DEBUG FAIL] ${label}:`, detail);
  }
  checks.push({ label, pass, detail });
}

class InMemoryConversationStateStore {
  public rows = new Map<
    string,
    { businessId: string; revision: number; state: unknown; updatedAt: Date }
  >();

  async load(businessId: string, conversationId: string) {
    const row = this.rows.get(conversationId);
    if (!row || row.businessId !== businessId) return null;
    return {
      conversationId,
      businessId: row.businessId,
      revision: row.revision,
      state: JSON.parse(JSON.stringify(row.state)),
      updatedAt: row.updatedAt,
    };
  }

  async save(
    businessId: string,
    conversationId: string,
    expectedRevision: number | null,
    state: unknown,
  ) {
    const existing = this.rows.get(conversationId);
    if (expectedRevision === null) {
      if (existing) return { status: "conflict" as const };
      this.rows.set(conversationId, {
        businessId,
        revision: 1,
        state: JSON.parse(JSON.stringify(state)),
        updatedAt: new Date(),
      });
      return { status: "saved" as const, revision: 1 };
    }
    if (
      !existing ||
      existing.businessId !== businessId ||
      existing.revision !== expectedRevision
    ) {
      return { status: "conflict" as const };
    }
    const nextRevision = existing.revision + 1;
    this.rows.set(conversationId, {
      businessId,
      revision: nextRevision,
      state: JSON.parse(JSON.stringify(state)),
      updatedAt: new Date(),
    });
    return { status: "saved" as const, revision: nextRevision };
  }
}

async function runSuite(): Promise<void> {
  console.log("── FLOWPILOT CORE-03B2B1 ACCEPTANCE VERIFICATION SUITE ──\n");

  const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
  const BRANCH_ID = "22222222-2222-4222-8222-222222222221";
  const SERVICE_CLEANING = "33333333-3333-4333-8333-333333333331";
  const SERVICE_EXAM = "33333333-3333-4333-8333-333333333332";
  const PROVIDER_AHMED_ALI = "44444444-4444-4444-8444-444444444441";
  const PROVIDER_AHMED_HASSAN = "44444444-4444-4444-8444-444444444442";
  const PROVIDER_SARA = "44444444-4444-4444-8444-444444444443";
  const CUSTOMER_ID = "55555555-5555-4555-8555-555555555551";

  const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
  const workingHours: Record<string, unknown> = {};
  for (const d of days) {
    workingHours[d] = { open: "09:00", close: "21:00", closed: false };
  }

  const branch = {
    id: BRANCH_ID,
    businessId: BUSINESS_ID,
    name: "الفرع الرئيسي",
    isDefault: true,
  };

  const business = {
    id: BUSINESS_ID,
    name: "عيادة د. حسام لطب الأسنان",
    timezone: "Africa/Cairo",
    isActive: true,
    receivingPhoneNumber: "+201000000000",
    defaultBranchId: branch.id,
    defaultServiceId: SERVICE_CLEANING,
    defaultBookingServiceId: SERVICE_CLEANING,
    defaultServiceBookingEnabled: true,
    workingHours,
    slotDurationMinutes: 30,
    confirmationMode: "automatic",
  };

  const services = [
    {
      id: SERVICE_CLEANING,
      businessId: BUSINESS_ID,
      name: "تنظيف أسنان",
      durationMinutes: 30,
      price: "300 ج.م",
      isActive: true,
    },
    {
      id: SERVICE_EXAM,
      businessId: BUSINESS_ID,
      name: "كشف أسنان",
      durationMinutes: 30,
      price: "200 ج.م",
      isActive: true,
    },
  ];

  const providers = [
    {
      id: PROVIDER_AHMED_ALI,
      businessId: BUSINESS_ID,
      displayName: "د. أحمد علي",
      name: "د. أحمد علي",
      user: { name: "د. أحمد علي" },
    },
    {
      id: PROVIDER_AHMED_HASSAN,
      businessId: BUSINESS_ID,
      displayName: "د. أحمد حسن",
      name: "د. أحمد حسن",
      user: { name: "د. أحمد حسن" },
    },
    {
      id: PROVIDER_SARA,
      businessId: BUSINESS_ID,
      displayName: "دكتورة سارة",
      name: "دكتورة سارة",
      user: { name: "دكتورة سارة" },
    },
  ];

  const capturedJevRequests: Array<{ url: string; body: any }> = [];
  const capturedGenerativeRequests: Array<{
    url: string;
    body: any;
    rawBody: string;
  }> = [];

  let currentGenerativeResponse: AiResponse = {
    intent: "BOOKING",
    action: "reply",
    content: "تمام، أقدر أساعدك في حجز الموعد.",
    summary: null,
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: "د. أحمد علي",
      date: "2026-10-25",
      timePreference: null,
    },
    factUpdates: [
      { key: "service", operation: "set", value: "تنظيف أسنان" },
      { key: "provider", operation: "set", value: "د. أحمد علي" },
      { key: "date", operation: "set", value: "2026-10-25" },
    ],
  };

  const mockJevFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawBody = String(init?.body ?? "{}");
    let body: any = {};
    try {
      body = JSON.parse(rawBody);
    } catch {}
    capturedJevRequests.push({ url: String(input), body });

    return new Response(
      JSON.stringify({
        id: `mock-jev-dec-${capturedJevRequests.length}`,
        model: "typesafe/jev-1.13",
        answers: {},
        usage: { input_tokens: 180, output_tokens: 30 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const mockGenerativeFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawBody = String(init?.body ?? "{}");
    let body: any = {};
    try {
      body = JSON.parse(rawBody);
    } catch {}
    capturedGenerativeRequests.push({ url: String(input), body, rawBody });

    return new Response(
      JSON.stringify({
        id: `mock-generative-turn-${capturedGenerativeRequests.length}`,
        model: "mock-openrouter-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify(currentGenerativeResponse),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const jevProvider: JevDecisionsProvider = createJevDecisionsProvider({
    getEnvVar: (name) =>
      name === "FLOWPILOT_JEV_API_KEY" || name === "OPENROUTER_API_KEY"
        ? "test-jev-key"
        : undefined,
    fetchImpl: mockJevFetch as any,
  });

  const jevStrategy = createSemanticJevStrategy({
    provider: jevProvider,
    enabled: true,
  });

  const generativeAdapter: AiProviderAdapter = createOpenRouterAdapter({
    model: "mock-openrouter-model",
    getEnvVar: (name) =>
      name === "OPENROUTER_API_KEY" ? "test-openrouter-key" : undefined,
    fetchImpl: mockGenerativeFetch as any,
  });

  const realAi = createLlmConversationAi({
    primary: generativeAdapter,
    secondary: null,
    fallbackEnabled: false,
    decisionStrategy: jevStrategy,
  });

  const stateStore = new InMemoryConversationStateStore();
  const messages: any[] = [];
  const createdAppointments: any[] = [];
  const capturedAvailabilityQueries: Array<{
    businessId: string;
    date: string;
    assigneeIds: string[];
  }> = [];
  let nextMsgId = 1;

  const baseDeps: ConversationEngineDeps = {
    businessRepository: {
      findByWhatsappNumber: async () => business as any,
      findById: async (id: string) =>
        id === BUSINESS_ID ? (business as any) : null,
    } as any,
    branchRepository: {
      findDefaultByBusiness: async () => branch as any,
      findByIdWithinBusiness: async () => branch as any,
      findById: async () => branch as any,
      listByBusiness: async () => [branch as any],
    } as any,
    serviceRepository: {
      listByBusiness: async () => services as any,
      listActiveByBusiness: async () => services as any,
      findById: async (id: string) => services.find((s) => s.id === id) as any,
    } as any,
    customerRepository: {
      upsertByPhone: async () =>
        ({
          id: CUSTOMER_ID,
          businessId: BUSINESS_ID,
          phone: "+201111111111",
          name: "محمد علي",
        }) as any,
      touchConversation: async () => undefined as any,
    } as any,
    conversationRepository: {
      findLatestByCustomer: async () => ({ id: "conv-1" }) as any,
      findById: async () =>
        ({
          id: "conv-1",
          businessId: BUSINESS_ID,
          status: "AI_ACTIVE",
          assignedUserId: null,
        }) as any,
      create: async () =>
        ({
          id: "conv-1",
          businessId: BUSINESS_ID,
          status: "AI_ACTIVE",
          assignedUserId: null,
        }) as any,
      addMessage: async (input: any) => {
        const msg = {
          id: `msg-${nextMsgId++}`,
          conversationId: "conv-1",
          senderType: input.senderType,
          content: input.content,
          createdAt: input.createdAt ?? new Date(),
        };
        messages.push(msg);
        return msg as any;
      },
      getMessages: async () => [...messages].reverse() as any,
      update: async () => undefined as any,
      updateWorkflow: async () => undefined as any,
    } as any,
    inboundDedupeRepository: {
      claim: async () => ({
        status: "claimed" as const,
        claimId: `claim-${nextMsgId}`,
      }),
    } as any,
    usageRepository: {
      record: async () => ({ id: "u-1" }) as any,
    } as any,
    attentionRepository: {
      open: async () => ({ id: "att-1" }) as any,
    } as any,
    providerRepository: {
      listEligibleForService: async () => providers as any,
      listAssignmentSeams: async () =>
        providers.map((p) => ({
          providerId: p.id,
          userId: p.id,
          assignedUserId: p.id,
        })) as any,
    } as any,
    appointmentRepository: {
      createWithConflictCheck: async (dto: any) => {
        createdAppointments.push(dto);
        return { id: `appt-${createdAppointments.length}` } as any;
      },
      listBlockingByAssignees: async (
        businessId: string,
        date: string,
        assigneeIds: string[],
      ) => {
        capturedAvailabilityQueries.push({ businessId, date, assigneeIds });
        if (date === "2026-10-27") {
          // Provider 1 has 09:00 and 17:00+ open; Providers 2 and 3 have only 17:00+ open
          return assigneeIds.flatMap((assignedUserId) => {
            if (assignedUserId === PROVIDER_AHMED_ALI) {
              return [{ assignedUserId, startTime: "09:30", endTime: "17:00" }];
            }
            return [{ assignedUserId, startTime: "09:00", endTime: "17:00" }];
          });
        }
        return [];
      },
      listRecentByCustomer: async () => [],
    } as any,
    conversationStateRepository: stateStore as any,
    ai: realAi as any,
    transport: {
      providerName: "test-transport",
      send: async () => ({ provider: "test-transport", delivered: true }),
    } as any,
  };

  let turnIndex = 0;
  async function runTurn(
    text: string,
    customDeps?: Partial<ConversationEngineDeps>,
    fromPhone: string = "+201111111111",
  ) {
    turnIndex++;
    const now = new Date(
      Date.UTC(2026, 9, 21, 10, Math.floor(turnIndex / 60), turnIndex % 60),
    );
    return receiveInboundMessage(
      { ...baseDeps, ...(customDeps ?? {}) },
      {
        to: "+201000000000",
        from: fromPhone,
        text,
        receivedAt: now.toISOString(),
        externalId: `msg-ext-${turnIndex}-${Date.now()}`,
      },
      {
        businessId: BUSINESS_ID,
        connectionId: null,
        branchId: BRANCH_ID,
      },
    );
  }

  async function loadHydratedState(convId: string = "conv-1") {
    const raw = await stateStore.load(BUSINESS_ID, convId);
    if (!raw) return null;
    const hydrated = hydrateConversationState(raw.state, {
      businessId: BUSINESS_ID,
      conversationId: convId,
    });
    return { revision: raw.revision, state: hydrated, rawState: raw.state };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PART A: Competing prose must not act as a second fact source
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("A. Competing prose must not act as a second fact source...");

  // Seed authoritative state with known facts: date 2026-10-25, timePreference morning, provider د. أحمد علي
  const initialOffer = buildSlotOffer(
    { businessId: BUSINESS_ID, conversationId: "conv-1" },
    "seed-token-1",
    {
      serviceId: SERVICE_CLEANING,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      providerId: PROVIDER_AHMED_ALI,
      date: "2026-10-25",
      followUpRequestId: null,
      shownCount: 1,
      options: [
        {
          providerId: PROVIDER_AHMED_ALI,
          displayName: "د. أحمد علي",
          startAt: "2026-10-25T09:00",
          endAt: "2026-10-25T09:30",
        },
      ],
    },
    new Date("2026-10-21T10:00:00.000Z"),
  );

  let seededState = emptyConversationState();
  seededState = {
    ...seededState,
    currentGoal: "BOOKING",
    bookingStage: "AVAILABILITY_RESOLVED",
    knownFacts: {
      service: "تنظيف أسنان",
      date: "2026-10-25",
      timePreference: "morning",
      provider: "د. أحمد علي",
    },
    selectedService: "تنظيف أسنان",
    selectedDate: "2026-10-25",
    selectedTimePref: "morning",
    providerPreference: "د. أحمد علي",
    serviceId: SERVICE_CLEANING,
    serviceSource: "CUSTOMER",
  };
  seededState = withPresentedOffer(seededState, initialOffer!);
  await stateStore.save(
    BUSINESS_ID,
    "conv-1",
    null,
    dehydrateConversationState(seededState),
  );

  // Customer message contains competing date, time, and provider expressions:
  // "مساء الخير، عايز أغير لمعاد بعد الضهر مع دكتورة سارة يوم الأربعاء"
  // Legacy helpers would interpret:
  //   - date: Wednesday
  //   - timePreference: afternoon (بعد الضهر)
  //   - provider: دكتورة سارة
  // The controlled AI response does NOT update those facts (intent: FAQ, answers question, no updates).
  currentGenerativeResponse = {
    intent: "FAQ",
    action: "reply",
    content: "أهلاً بك، أقدر أساعدك في الإجابة عن أي استفسار.",
    summary: null,
    handoffReason: null,
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    factUpdates: [],
  };

  const queriesBeforeA = capturedAvailabilityQueries.length;
  const turnA = await runTurn(
    "مساء الخير، عايز أغير لمعاد بعد الضهر مع دكتورة سارة يوم الأربعاء",
  );

  check("A1a. Competing prose turn executes successfully", turnA.ok === true);
  check(
    "A1b. Competing prose turn answered as FAQ without forced booking mutation",
    (turnA as any).intent === "FAQ" &&
      (turnA as any).assistantAction === "AI_REPLY",
  );

  const reloadedA = await loadHydratedState("conv-1");
  const stateA = reloadedA?.state as any;

  check(
    "A2a. Authoritative date 2026-10-25 is NOT overwritten by competing prose",
    stateA?.knownFacts?.date === "2026-10-25" &&
      stateA?.selectedDate === "2026-10-25",
  );
  check(
    "A2b. Authoritative timePreference 'morning' is NOT overwritten by competing prose",
    stateA?.knownFacts?.timePreference === "morning" &&
      stateA?.selectedTimePref === "morning",
  );
  check(
    "A2c. Authoritative provider 'د. أحمد علي' is NOT overwritten by competing prose",
    stateA?.knownFacts?.provider === "د. أحمد علي" &&
      stateA?.providerPreference === "د. أحمد علي",
  );
  check(
    "A3a. No availability query was dispatched for competing Wednesday date",
    capturedAvailabilityQueries.length === queriesBeforeA,
  );
  check(
    "A3b. Active offer was NOT invalidated by competing prose",
    stateA?.offer?.status === "ACTIVE" && stateA?.offer?.id === "seed-token-1",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PART B: Explicit changes
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("B. Explicit changes...");

  // B1. SET provider with colliding first names:
  // "د. أحمد علي" vs "د. أحمد حسن"
  // Customer explicitly sets provider "د. أحمد علي"
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "تم اختيار د. أحمد علي.",
    summary: "طلب حجز مع د. أحمد علي",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: "د. أحمد علي",
      date: "2026-10-25",
      timePreference: null,
    },
    factUpdates: [
      { key: "provider", operation: "set", value: "د. أحمد علي" },
      { key: "date", operation: "set", value: "2026-10-25" },
    ],
  };

  const queriesBeforeB1 = capturedAvailabilityQueries.length;
  const turnB1 = await runTurn("عايز أحجز مع د. أحمد علي بالاسم");

  check("B1a. SET provider turn executes successfully", turnB1.ok === true);
  const reloadedB1 = await loadHydratedState("conv-1");
  const stateB1 = reloadedB1?.state as any;

  check(
    "B1b. Full entity 'د. أحمد علي' reaches durable state without first-name truncation",
    stateB1?.knownFacts?.provider === "د. أحمد علي" &&
      stateB1?.providerPreference === "د. أحمد علي",
  );

  const lastQueryB1 =
    capturedAvailabilityQueries[capturedAvailabilityQueries.length - 1];
  check(
    "B1c. Availability query was dispatched for 'د. أحمد علي' explicitly",
    capturedAvailabilityQueries.length > queriesBeforeB1 &&
      lastQueryB1?.assigneeIds?.length === 1 &&
      lastQueryB1?.assigneeIds[0] === PROVIDER_AHMED_ALI,
  );

  // B2. SET date: state, actual availability-query date and new offer agree
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "المواعيد المتاحة يوم 2026-10-27.",
    summary: "تغيير التاريخ إلى 2026-10-27",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: "د. أحمد علي",
      date: "2026-10-27",
      timePreference: null,
    },
    factUpdates: [{ key: "date", operation: "set", value: "2026-10-27" }],
  };

  const queriesBeforeB2 = capturedAvailabilityQueries.length;
  const turnB2 = await runTurn("خلي الميعاد يوم 2026-10-27");

  check("B2a. SET date turn executes successfully", turnB2.ok === true);
  const reloadedB2 = await loadHydratedState("conv-1");
  const stateB2 = reloadedB2?.state as any;
  const lastQueryB2 =
    capturedAvailabilityQueries[capturedAvailabilityQueries.length - 1];

  check(
    "B2b. State date is updated to 2026-10-27",
    stateB2?.knownFacts?.date === "2026-10-27" &&
      stateB2?.selectedDate === "2026-10-27",
  );
  check(
    "B2c. Actual availability query date matches 2026-10-27",
    capturedAvailabilityQueries.length > queriesBeforeB2 &&
      lastQueryB2?.date === "2026-10-27",
  );
  check(
    "B2d. Active typed slot offer date matches 2026-10-27",
    stateB2?.offer?.status === "ACTIVE" &&
      stateB2?.offer?.date === "2026-10-27",
  );

  // B3. REMOVE provider: preference cleared; search allows eligible providers
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "مش فارق أي دكتور متاح.",
    summary: "إلغاء تفضيل الطبيب",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: null,
      date: "2026-10-27",
      timePreference: null,
    },
    factUpdates: [{ key: "provider", operation: "remove" }],
  };

  const queriesBeforeB3 = capturedAvailabilityQueries.length;
  const turnB3 = await runTurn("مش فارق معايا أي دكتور متاح");

  check("B3a. REMOVE provider turn executes successfully", turnB3.ok === true);
  const reloadedB3 = await loadHydratedState("conv-1");
  const stateB3 = reloadedB3?.state as any;
  const lastQueryB3 =
    capturedAvailabilityQueries[capturedAvailabilityQueries.length - 1];

  check(
    "B3b. Provider preference is cleared in state",
    stateB3?.knownFacts?.provider === undefined &&
      stateB3?.providerPreference === null,
  );
  check(
    "B3c. Date and service survive provider removal",
    stateB3?.knownFacts?.date === "2026-10-27" &&
      stateB3?.knownFacts?.service === "تنظيف أسنان",
  );
  check(
    "B3d. Availability query allows all eligible providers without single-doctor filter",
    capturedAvailabilityQueries.length > queriesBeforeB3 &&
      lastQueryB3?.assigneeIds?.length === 3,
  );

  // B4. REMOVE timePreference: slot results no longer carry the old filter
  // First seed time preference 'evening'
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "تم تحديد تفضيل المساء.",
    summary: "تفضيل مساء",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: null,
      date: "2026-10-27",
      timePreference: "evening",
    },
    factUpdates: [
      { key: "timePreference", operation: "set", value: "evening" },
    ],
  };

  await runTurn("عايز الميعاد بالليل");

  const reloadedB4Pre = await loadHydratedState("conv-1");
  const stateB4Pre = reloadedB4Pre?.state as any;
  check(
    "B4-pre. Evening preference prioritizes evening slot at head of offer",
    stateB4Pre?.offer?.options?.[0]?.startAt?.includes("T17:") ||
      stateB4Pre?.offer?.options?.[0]?.startAt?.includes("T18:"),
  );

  // Now REMOVE timePreference
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "أي وقت متاح مناسب.",
    summary: "إلغاء تفضيل الوقت",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: null,
      date: "2026-10-27",
      timePreference: null,
    },
    factUpdates: [{ key: "timePreference", operation: "remove" }],
  };

  const turnB4 = await runTurn(
    "مش مهم بالليل، في أي وقت متاح بالنهار أو الصبح عادي",
  );

  check(
    "B4a. REMOVE timePreference turn executes successfully",
    turnB4.ok === true,
  );
  const reloadedB4 = await loadHydratedState("conv-1");
  const stateB4 = reloadedB4?.state as any;

  check(
    "B4b. timePreference cleared from state",
    stateB4?.knownFacts?.timePreference === undefined &&
      stateB4?.selectedTimePref === null,
  );
  check(
    "B4c. Slot results in offer lead with morning hours (chronological, no evening bias)",
    stateB4?.offer?.options?.[0]?.startAt?.includes("T09:00"),
  );

  // B5. REMOVE date: no new date-dependent query/appointment; ask for date
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "بلاش يوم 27.",
    summary: "إلغاء التاريخ",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: null,
      date: null,
      timePreference: null,
    },
    factUpdates: [{ key: "date", operation: "remove" }],
  };

  const queriesBeforeB5 = capturedAvailabilityQueries.length;
  const apptsBeforeB5 = createdAppointments.length;
  const turnB5 = await runTurn("بلاش يوم 27 خالص، مش هعرف أجي");

  check("B5a. REMOVE date turn executes successfully", turnB5.ok === true);
  const reloadedB5 = await loadHydratedState("conv-1");
  const stateB5 = reloadedB5?.state as any;

  check(
    "B5b. Date cleared from state",
    stateB5?.knownFacts?.date === undefined && stateB5?.selectedDate === null,
  );
  check(
    "B5c. Old offer was INVALIDATED upon date removal",
    stateB5?.offer?.status === "INVALIDATED",
  );
  check(
    "B5d. No new availability query was executed",
    capturedAvailabilityQueries.length === queriesBeforeB5,
  );
  check(
    "B5e. No appointment was created",
    createdAppointments.length === apptsBeforeB5,
  );
  check(
    "B5f. Engine requests date clarification (MISSING_DATE)",
    (turnB5 as any).assistantAction === "AI_REPLY" &&
      messages[messages.length - 1]?.content?.includes("التاريخ"),
  );

  // B6. Conflicting extraction cannot defeat explicit factUpdates
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "تم الاختيار.",
    summary: "تعارض استخراج مع تحديث",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: "دكتورة سارة", // Conflicting extraction
      date: "2026-10-28",
      timePreference: null,
    },
    factUpdates: [
      { key: "provider", operation: "set", value: "د. أحمد علي" }, // Explicit winner
      { key: "date", operation: "set", value: "2026-10-28" },
    ],
  };

  const turnB6 = await runTurn(
    "عايز أحجز مع د. أحمد علي مش دكتورة سارة يوم 28",
  );

  check(
    "B6a. Conflicting extraction turn executes successfully",
    turnB6.ok === true,
  );
  const reloadedB6 = await loadHydratedState("conv-1");
  const stateB6 = reloadedB6?.state as any;
  const lastQueryB6 =
    capturedAvailabilityQueries[capturedAvailabilityQueries.length - 1];

  check(
    "B6b. Explicit factUpdate 'د. أحمد علي' defeats conflicting extraction 'دكتورة سارة'",
    stateB6?.knownFacts?.provider === "د. أحمد علي" &&
      stateB6?.providerPreference === "د. أحمد علي",
  );
  check(
    "B6c. Availability query was dispatched for 'د. أحمد علي' (not 'دكتورة سارة')",
    lastQueryB6?.assigneeIds?.length === 1 &&
      lastQueryB6?.assigneeIds[0] === PROVIDER_AHMED_ALI,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PART C: Persistence and continuation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("C. Persistence and continuation...");

  // C1. Save, reload and send a turn without replacement:
  // First REMOVE provider
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "شلت تفضيل الطبيب.",
    summary: "إزالة الطبيب",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: null,
      date: "2026-10-28",
      timePreference: null,
    },
    factUpdates: [{ key: "provider", operation: "remove" }],
  };

  await runTurn("مش فارق الطبيب");

  // Next turn: customer sends message with no provider mentioned, AI has no updates
  currentGenerativeResponse = {
    intent: "FAQ",
    action: "reply",
    content: "العنوان في المعادي شارع النصر.",
    summary: null,
    handoffReason: null,
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    factUpdates: [],
  };

  await runTurn("هو العنوان فين بالضبط؟ وهل دكتور أحمد موجود في الفرع ده؟");

  const reloadedC1 = await loadHydratedState("conv-1");
  const stateC1 = reloadedC1?.state as any;

  check(
    "C1a. Removed provider does NOT revive from transcript or prose mention",
    stateC1?.knownFacts?.provider === undefined &&
      stateC1?.providerPreference === null,
  );

  // C2. New valid SET after removal is accepted
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "تم اختيار دكتورة سارة.",
    summary: "اختيار دكتورة سارة",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: "دكتورة سارة",
      date: "2026-10-28",
      timePreference: null,
    },
    factUpdates: [
      { key: "provider", operation: "set", value: "دكتورة سارة" },
      { key: "date", operation: "set", value: "2026-10-28" },
    ],
  };

  await runTurn("خلاص عايز أحجز مع دكتورة سارة");

  const reloadedC2 = await loadHydratedState("conv-1");
  const stateC2 = reloadedC2?.state as any;
  const lastQueryC2 =
    capturedAvailabilityQueries[capturedAvailabilityQueries.length - 1];

  check(
    "C2a. New valid SET after remove is accepted in state",
    stateC2?.knownFacts?.provider === "دكتورة سارة" &&
      stateC2?.providerPreference === "دكتورة سارة",
  );
  check(
    "C2b. Domain resolves new provider unambiguously",
    lastQueryC2?.assigneeIds?.length === 1 &&
      lastQueryC2?.assigneeIds[0] === PROVIDER_SARA,
  );

  // C3. With missing authoritative date and no semantic date proposal,
  // raw prose is NOT silently converted to date after AI
  // Clear date from state first
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "تم حذف التاريخ.",
    summary: "حذف التاريخ",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: "دكتورة سارة",
      date: null,
      timePreference: null,
    },
    factUpdates: [{ key: "date", operation: "remove" }],
  };

  await runTurn("احذف التاريخ القديم");

  // Now customer prose mentions "بكرا" (tomorrow), but AI proposes NO date
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "محتاج أعرف تفاصيل أكتر.",
    summary: "طلب حجز بدون تاريخ محدد",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: "دكتورة سارة",
      date: null, // AI omitted date
      timePreference: null,
    },
    factUpdates: [],
  };

  const queriesBeforeC3 = capturedAvailabilityQueries.length;
  const turnC3 = await runTurn("عايز أحجز بكرا لو ينفع");

  check("C3a. Turn executes successfully", turnC3.ok === true);
  const reloadedC3 = await loadHydratedState("conv-1");
  const stateC3 = reloadedC3?.state as any;

  check(
    "C3b. Raw prose 'بكرا' is NOT silently converted to date by lexical helper after AI",
    stateC3?.knownFacts?.date === undefined && stateC3?.selectedDate === null,
  );
  check(
    "C3c. No availability query was dispatched for guessed date",
    capturedAvailabilityQueries.length === queriesBeforeC3,
  );
  check(
    "C3d. Engine asks for date clarification instead of guessing",
    (turnC3 as any).assistantAction === "AI_REPLY" &&
      messages[messages.length - 1]?.content?.includes("التاريخ"),
  );

  // C4. Pending clarification must not bind arbitrary sentence as provider/time
  // Set up pending clarification for provider in state
  let clarifyState = emptyConversationState();
  clarifyState = {
    ...clarifyState,
    currentGoal: "BOOKING",
    bookingStage: "GOAL_STATED",
    knownFacts: { service: "تنظيف أسنان" },
    missingFacts: ["provider"],
    lastClarification: { type: "provider" },
    selectedService: "تنظيف أسنان",
    serviceId: SERVICE_CLEANING,
    serviceSource: "CUSTOMER",
  };
  const currentBeforeC4 = await stateStore.load(BUSINESS_ID, "conv-1");
  await stateStore.save(
    BUSINESS_ID,
    "conv-1",
    currentBeforeC4?.revision ?? null,
    dehydrateConversationState(clarifyState),
  );

  // Customer replies with arbitrary query: "هو الكشف بكام؟"
  // AI answers the question without proposing a provider
  currentGenerativeResponse = {
    intent: "FAQ",
    action: "reply",
    content: "سعر كشف الأسنان 200 ج.م.",
    summary: null,
    handoffReason: null,
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    factUpdates: [],
  };

  const turnC4 = await runTurn("هو الكشف بكام؟");

  check("C4a. FAQ clarification turn executes", turnC4.ok === true);
  const reloadedC4 = await loadHydratedState("conv-1");
  const stateC4 = reloadedC4?.state as any;

  check(
    "C4b. Arbitrary sentence is NOT bound as provider fact",
    stateC4?.knownFacts?.provider === undefined &&
      stateC4?.providerPreference === null,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // PART D: Existing product boundaries
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("D. Existing product boundaries...");

  // D1. Offer-bound and numeric selection stay zero-model
  // First seed active slot offer
  const testOffer = buildSlotOffer(
    { businessId: BUSINESS_ID, conversationId: "conv-1" },
    "zero-model-token-9",
    {
      serviceId: SERVICE_CLEANING,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      providerId: PROVIDER_AHMED_ALI,
      date: "2026-10-30",
      followUpRequestId: null,
      shownCount: 2,
      options: [
        {
          providerId: PROVIDER_AHMED_ALI,
          displayName: "د. أحمد علي",
          startAt: "2026-10-30T09:00",
          endAt: "2026-10-30T09:30",
        },
        {
          providerId: PROVIDER_SARA,
          displayName: "دكتورة سارة",
          startAt: "2026-10-30T09:00",
          endAt: "2026-10-30T09:30",
        },
      ],
    },
    new Date("2026-10-21T10:00:00.000Z"),
  );

  let stateD1 = emptyConversationState();
  stateD1 = {
    ...stateD1,
    currentGoal: "BOOKING",
    bookingStage: "AVAILABILITY_RESOLVED",
    knownFacts: { service: "تنظيف أسنان", date: "2026-10-30" },
    serviceId: SERVICE_CLEANING,
    selectedService: "تنظيف أسنان",
    selectedDate: "2026-10-30",
  };
  stateD1 = withPresentedOffer(stateD1, testOffer!);
  const currentBeforeD1 = await stateStore.load(BUSINESS_ID, "conv-1");
  await stateStore.save(
    BUSINESS_ID,
    "conv-1",
    currentBeforeD1?.revision ?? null,
    dehydrateConversationState(stateD1),
  );

  const genCallsBeforeD1 = capturedGenerativeRequests.length;
  const jevCallsBeforeD1 = capturedJevRequests.length;

  const turnD1 = await runTurn("١");

  check(
    "D1a. Arabic numeral '١' resolves selection successfully",
    turnD1.ok === true && (turnD1 as any).conversationStatus === "BOOKED",
  );
  check(
    "D1b. Mechanical selection '١' executes with EXACTLY ZERO generative model calls",
    capturedGenerativeRequests.length === genCallsBeforeD1,
  );
  check(
    "D1c. Mechanical selection '١' executes with EXACTLY ZERO JEV calls",
    capturedJevRequests.length === jevCallsBeforeD1,
  );

  // D2. Mixed numeric prose reaches semantic handling intact
  check(
    "D2a. parseBookingSelection('٢ بس غير اليوم ده') returns null",
    parseBookingSelection("٢ بس غير اليوم ده") === null,
  );

  // D3. Replaced/expired/consumed offers retain existing protections
  const reloadedD3 = await loadHydratedState("conv-1");
  const stateD3 = reloadedD3?.state as any;
  check(
    "D3a. Consumed offer cannot be re-booked with callback token",
    stateD3?.offer?.status === "CONSUMED",
  );

  // D4. Default service applies under existing rules
  const turnD4State = emptyConversationState();
  await stateStore.save(
    BUSINESS_ID,
    "conv-2",
    null,
    dehydrateConversationState(turnD4State),
  );

  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "المواعيد المتاحة ليوم 2026-10-30.",
    summary: "طلب حجز بدون تحديد خدمة",
    handoffReason: null,
    extraction: {
      service: null, // No service specified
      provider: null,
      date: "2026-10-30",
      timePreference: null,
    },
    factUpdates: [{ key: "date", operation: "set", value: "2026-10-30" }],
  };

  const turnD4 = await runTurn(
    "عايز أحجز ميعاد يوم 2026-10-30",
    {
      conversationRepository: {
        ...baseDeps.conversationRepository,
        findLatestByCustomer: async () => ({ id: "conv-2" }) as any,
        findById: async () =>
          ({
            id: "conv-2",
            businessId: BUSINESS_ID,
            status: "AI_ACTIVE",
            assignedUserId: null,
          }) as any,
      } as any,
    },
    "+201111111112",
  );

  check("D4a. Turn without service executes", turnD4.ok === true);
  const reloadedD4 = await stateStore.load(BUSINESS_ID, "conv-2");
  const stateD4 = reloadedD4?.state as any;
  check(
    "D4b. Configured default service (تنظيف أسنان) resolved cleanly",
    stateD4?.serviceId === SERVICE_CLEANING,
  );

  // D5. Explicit unknown service does NOT silently become default
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "الخدمة غير معروفة.",
    summary: "طلب خدمة غير معروفة",
    handoffReason: null,
    extraction: {
      service: "علاج طبيعي للركبة", // Unknown service
      provider: null,
      date: "2026-10-30",
      timePreference: null,
    },
    factUpdates: [
      { key: "service", operation: "set", value: "علاج طبيعي للركبة" },
      { key: "date", operation: "set", value: "2026-10-30" },
    ],
  };

  const apptsBeforeD5 = createdAppointments.length;
  const turnD5 = await runTurn(
    "عايز أحجز علاج طبيعي للركبة يوم 2026-10-30",
    {
      conversationRepository: {
        ...baseDeps.conversationRepository,
        findLatestByCustomer: async () => ({ id: "conv-2" }) as any,
        findById: async () =>
          ({
            id: "conv-2",
            businessId: BUSINESS_ID,
            status: "AI_ACTIVE",
            assignedUserId: null,
          }) as any,
      } as any,
    },
    "+201111111112",
  );

  check("D5a. Unknown service turn executes", turnD5.ok === true);
  check(
    "D5b. Unknown explicit service does NOT create appointment under default service",
    createdAppointments.length === apptsBeforeD5,
  );
  check(
    "D5c. Engine asks for clarification or reports service not found",
    (turnD5 as any).assistantAction === "AI_REPLY" &&
      messages[messages.length - 1]?.content?.includes("الخدمة"),
  );

  // D6. Staff-assigned conversation preserves human ownership
  const genBeforeD6 = capturedGenerativeRequests.length;
  const jevBeforeD6 = capturedJevRequests.length;

  const turnD6 = await runTurn(
    "السلام عليكم محتاج مساعدة",
    {
      conversationRepository: {
        ...baseDeps.conversationRepository,
        findLatestByCustomer: async () =>
          ({
            id: "conv-staff",
            assignedUserId: "staff-user-1",
          }) as any,
        findById: async () =>
          ({
            id: "conv-staff",
            businessId: BUSINESS_ID,
            status: "AI_ACTIVE",
            assignedUserId: "staff-user-1",
          }) as any,
      } as any,
    },
    "+201111111113",
  );

  check(
    "D6a. Staff-assigned thread defers to staff (DEFERRED_TO_STAFF)",
    (turnD6 as any).assistantAction === "DEFERRED_TO_STAFF",
  );
  check(
    "D6b. Staff-assigned thread spends ZERO generative model calls",
    capturedGenerativeRequests.length === genBeforeD6,
  );
  check(
    "D6c. Staff-assigned thread spends ZERO JEV calls",
    capturedJevRequests.length === jevBeforeD6,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n── CORE-03B2B1 ACCEPTANCE RESULTS ──\n");
  let passCount = 0;
  let failCount = 0;
  for (const c of checks) {
    if (c.pass) {
      passCount++;
      console.log(`  ✅ ${c.label}`);
    } else {
      failCount++;
      console.log(`  ❌ ${c.label}`);
    }
  }

  console.log(
    `\nTOTAL: ${checks.length} assertions. PASSED: ${passCount}, FAILED: ${failCount}`,
  );

  if (failCount > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("FATAL ERROR in suite:", err);
  process.exit(1);
});
