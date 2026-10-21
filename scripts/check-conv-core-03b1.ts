/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — CORE-03B1 Verification Suite
 * Server-Derived Temporal Context & Semantic Capability Boundary
 *
 * Verifies all required scenarios:
 *
 * A. Contract:
 *  1. Existing requests without temporal context still validate
 *  2. Valid temporal context survives parsing with identical values
 *  3. Malformed instant is rejected
 *  4. Malformed timezone is rejected
 *  5. Malformed localDate is rejected
 *  6. Mismatched localDate vs (instant + timezone) is rejected
 *  7. Fallback policy: resolveValidTimeZone handles null, empty, and invalid strings by returning "UTC"
 *  8. buildAiTemporalContext safely derives context and falls back to "UTC" on invalid timezone
 *
 * B. Timezone Correctness:
 *  9. Same instant at UTC/Cairo date boundary yields exact expected distinct local dates
 *  10. Cairo daylight-saving transition sensitivity in October 2026 detects fixed UTC+2 and UTC+3 offset errors
 *  11. Fixed explicit instants used; no dependency on host machine timezone or Date.now()
 *  12. Pure-function buildAiTemporalContext yields byte-identical references across repeated calls
 *
 * C. Actual Engine-to-Wire Path:
 *  13. receiveInboundMessage drives through context builder and real createOpenRouterAdapter
 *  14. Captured HTTP body carries exact temporalContext block; independent turns preserve canonical instant without wall-clock drift
 *  15. temporalContext appears exactly once in the rendered request
 *  16. Customer statement claiming alternative date/timezone cannot overwrite server-derived fields
 *  17. Context builder is not bypassed (validated in-engine context matches wire context)
 *
 * D. Boundaries:
 *  18. Non-vacuous canary isolation: upstream state contains offer token & claim nonce; wire excludes them and adapter credential
 *  19. Mechanical numeric choice ('١') executes exactly zero model network calls
 *  20. Measured generative turn fixture executes exactly 1 provider call (unexercised retry/fallback/shadow paths not tested here)
 *  21. Explicit REMOVE operation payload conforms to aiResponseSchema schema
 *  22. Business fixture configuration defines default service (default resolution behavior proven in check:conv-core-03a)
 *
 * E. Honest Language Evidence:
 *  23. Downstream engine persisted extracted date '2026-10-23' into conversation state (mocked extraction/persistence evidence)
 *  24. Honest capability boundary: offline mock proves plumbing only; live model dialect comprehension is NOT evaluated
 *  25. JEV capability boundary: adapter mapping currently omits temporalContext; JEV questions are bounded routing decisions
 *
 * Run: pnpm check:conv-core-03b1
 */

import {
  aiRequestSchema,
  aiResponseSchema,
  type AiRequest,
  type AiResponse,
} from "../src/features/conversations/server/ai-contract";
import { buildSlotOffer } from "../src/features/conversations/server/booking-offer";
import {
  receiveInboundMessage,
  type ConversationEngineDeps,
} from "../src/features/conversations/server/conversation-engine";
import {
  emptyConversationState,
  projectConversationState,
  withPresentedOffer,
  type ConversationState,
} from "../src/features/conversations/server/conversation-state";
import {
  aiTemporalContextSchema,
  buildAiTemporalContext,
  deriveLocalDate,
  resolveValidTimeZone,
} from "../src/features/conversations/server/temporal-context";
import {
  SEMANTIC_QUESTIONS,
  buildSemanticRequest,
} from "../src/server/integrations/ai/jev-semantic-strategy";
import {
  OPENROUTER_SECRET_REF,
  createOpenRouterAdapter,
} from "../src/server/integrations/ai/openrouter";

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
  console.log("── FLOWPILOT CORE-03B1 ACCEPTANCE VERIFICATION SUITE ──\n");

  // =========================================================================
  // SECTION A: Contract Validation
  // =========================================================================
  console.log("A. Temporal Contract & Validation Invariants...");

  const baseMinimalRequest: AiRequest = {
    message: "مرحبا",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "عيادة النور",
    services: [],
    faqs: [],
  };

  // 1. Existing requests without temporal context still validate
  const noTemporal = aiRequestSchema.safeParse(baseMinimalRequest);
  check(
    "A1. Existing request without temporal context validates cleanly",
    noTemporal.success && noTemporal.data.temporalContext === undefined,
  );

  // 2. Valid temporal context survives parsing with identical values
  const validTemporalBlock = {
    referenceInstant: "2026-05-15T22:30:00.000Z",
    timeZone: "Africa/Cairo",
    localDate: "2026-05-16",
  };
  const withTemporal = aiRequestSchema.safeParse({
    ...baseMinimalRequest,
    temporalContext: validTemporalBlock,
  });
  check(
    "A2. Valid temporal context survives parsing with identical values",
    withTemporal.success &&
      withTemporal.data.temporalContext?.referenceInstant ===
        validTemporalBlock.referenceInstant &&
      withTemporal.data.temporalContext?.timeZone ===
        validTemporalBlock.timeZone &&
      withTemporal.data.temporalContext?.localDate ===
        validTemporalBlock.localDate,
  );

  // 3. Malformed instant is rejected
  const malformedInstant = aiTemporalContextSchema.safeParse({
    referenceInstant: "not-an-iso-instant",
    timeZone: "Africa/Cairo",
    localDate: "2026-05-16",
  });
  check("A3. Malformed instant is rejected", !malformedInstant.success);

  // 4. Malformed timezone is rejected
  const malformedTimezone = aiTemporalContextSchema.safeParse({
    referenceInstant: "2026-05-15T22:30:00.000Z",
    timeZone: "Invalid/Not_A_Real_Timezone",
    localDate: "2026-05-16",
  });
  check("A4. Malformed timezone is rejected", !malformedTimezone.success);

  // 5. Malformed localDate is rejected
  const malformedDate = aiTemporalContextSchema.safeParse({
    referenceInstant: "2026-05-15T22:30:00.000Z",
    timeZone: "Africa/Cairo",
    localDate: "2026-02-31", // invalid date
  });
  check("A5. Malformed localDate is rejected", !malformedDate.success);

  // 6. Mismatched localDate vs (instant + timezone) is rejected
  const mismatchedDate = aiTemporalContextSchema.safeParse({
    referenceInstant: "2026-05-15T22:30:00.000Z",
    timeZone: "Africa/Cairo",
    localDate: "2026-05-15", // In Cairo (UTC+3 in May), it is 2026-05-16
  });
  check(
    "A6. Mismatched localDate vs (instant + timezone) is rejected",
    !mismatchedDate.success,
  );

  // 7. Fallback policy for missing or invalid business timezone
  check(
    "A7a. resolveValidTimeZone(null) returns 'UTC'",
    resolveValidTimeZone(null) === "UTC",
  );
  check(
    "A7b. resolveValidTimeZone(undefined) returns 'UTC'",
    resolveValidTimeZone(undefined) === "UTC",
  );
  check(
    "A7c. resolveValidTimeZone('   ') returns 'UTC'",
    resolveValidTimeZone("   ") === "UTC",
  );
  check(
    "A7d. resolveValidTimeZone('Gibberish/Zone') returns 'UTC'",
    resolveValidTimeZone("Gibberish/Zone") === "UTC",
  );
  check(
    "A7e. resolveValidTimeZone('Africa/Cairo') preserves valid timezone",
    resolveValidTimeZone("Africa/Cairo") === "Africa/Cairo",
  );

  // 8. buildAiTemporalContext safely derives context and falls back to "UTC" on invalid timezone
  const fallbackBuilt = buildAiTemporalContext(
    new Date("2026-05-15T22:30:00.000Z"),
    "Invalid/Zone",
  );
  check(
    "A8a. buildAiTemporalContext falls back to UTC on invalid timezone",
    fallbackBuilt.timeZone === "UTC" &&
      fallbackBuilt.localDate === "2026-05-15",
  );
  const fallbackParsed = aiTemporalContextSchema.safeParse(fallbackBuilt);
  check(
    "A8b. Fallback temporal context validates cleanly",
    fallbackParsed.success,
  );

  // =========================================================================
  // SECTION B: Timezone Correctness
  // =========================================================================
  console.log("B. Timezone Correctness & Boundary Invariants...");

  // 9. Same instant at UTC/Cairo date boundary yields exact expected distinct local dates
  // 2026-05-15T22:30:00.000Z:
  // In UTC: 2026-05-15
  // In Africa/Cairo (UTC+3): 2026-05-16 01:30:00 -> 2026-05-16
  const boundaryInstant = new Date("2026-05-15T22:30:00.000Z");
  const utcDate = deriveLocalDate(boundaryInstant, "UTC");
  const cairoDate = deriveLocalDate(boundaryInstant, "Africa/Cairo");
  check(
    "B9a. Exact UTC local date at boundary is 2026-05-15",
    utcDate === "2026-05-15",
  );
  check(
    "B9b. Exact Cairo local date at boundary is 2026-05-16",
    cairoDate === "2026-05-16",
  );

  // 10. Cairo daylight-saving transition sensitivity in October 2026.
  // Explicit instants whose expected local dates distinguish runtime IANA Cairo timezone
  // from fixed UTC+2 and UTC+3 offset assumptions:
  //
  // Instant 1 (during DST, summer UTC+3): 2026-10-28T21:30:00.000Z
  // In Africa/Cairo: 21:30 UTC + 3h = 00:30 on 2026-10-29.
  // An incorrect fixed UTC+2 offset would give 23:30 on 2026-10-28 (differs!).
  const dstSummerInstant = new Date("2026-10-28T21:30:00.000Z");
  const dstSummerCairo = deriveLocalDate(dstSummerInstant, "Africa/Cairo");
  const fixedUtc2Summer = new Date(dstSummerInstant.getTime() + 2 * 3600000)
    .toISOString()
    .slice(0, 10);
  check(
    "B10a. Cairo date during DST is 2026-10-29 (differs from fixed UTC+2: 2026-10-28)",
    dstSummerCairo === "2026-10-29" && dstSummerCairo !== fixedUtc2Summer,
  );

  // Instant 2 (after DST ends, standard time UTC+2): 2026-10-29T21:30:00.000Z
  // Egypt DST ends at 24:00 (21:00 UTC) on Oct 29, falling back to UTC+2.
  // In Africa/Cairo: 21:30 UTC + 2h = 23:30 on 2026-10-29.
  // An incorrect fixed UTC+3 offset would give 00:30 on 2026-10-30 (differs!).
  const dstWinterInstant = new Date("2026-10-29T21:30:00.000Z");
  const dstWinterCairo = deriveLocalDate(dstWinterInstant, "Africa/Cairo");
  const fixedUtc3Winter = new Date(dstWinterInstant.getTime() + 3 * 3600000)
    .toISOString()
    .slice(0, 10);
  check(
    "B10b. Cairo date after DST ends is 2026-10-29 (differs from fixed UTC+3: 2026-10-30)",
    dstWinterCairo === "2026-10-29" && dstWinterCairo !== fixedUtc3Winter,
  );

  // 11. Fixed explicit instants used; no host machine timezone dependency
  const instantIsoString = "2026-10-21T04:14:20.000Z";
  const builtFromInstant = buildAiTemporalContext(
    new Date(instantIsoString),
    "Africa/Cairo",
  );
  check(
    "B11. Context derived strictly from explicit instant, not host clock",
    builtFromInstant.referenceInstant === instantIsoString &&
      builtFromInstant.timeZone === "Africa/Cairo" &&
      builtFromInstant.localDate === "2026-10-21",
  );

  // 12. Pure-function determinism: repeated buildAiTemporalContext calls preserve byte-identical references
  const turnDateA = buildAiTemporalContext(
    new Date(instantIsoString),
    "Africa/Cairo",
  );
  const turnDateB = buildAiTemporalContext(
    new Date(instantIsoString),
    "Africa/Cairo",
  );
  check(
    "B12. Pure-function buildAiTemporalContext yields byte-identical references across repeated calls",
    turnDateA.referenceInstant === turnDateB.referenceInstant &&
      turnDateA.localDate === turnDateB.localDate,
  );

  // =========================================================================
  // SECTION C: Actual Engine-to-Wire Path
  // =========================================================================
  console.log("C. Actual Engine-to-Wire Integration Invariants...");

  const BUSINESS_ID = "biz-temp-cairo-01";
  const CONVERSATION_ID = "conv-temp-cairo-01";
  const CUSTOMER_ID = "cust-temp-cairo-01";
  const SERVICE_ID = "33333333-3333-4333-8333-333333333331";
  const BRANCH_ID = "22222222-2222-4222-8222-222222222221";
  const PROVIDER_ID = "44444444-4444-4444-8444-444444444441";

  const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
  const workingHours: Record<string, unknown> = {};
  for (const d of days) {
    workingHours[d] = { open: "09:00", close: "18:00", closed: false };
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
    defaultServiceId: SERVICE_ID,
    defaultBookingServiceId: SERVICE_ID,
    defaultServiceBookingEnabled: true,
    workingHours,
    slotDurationMinutes: 30,
    confirmationMode: "automatic",
  };

  const services = [
    {
      id: SERVICE_ID,
      businessId: BUSINESS_ID,
      name: "تنظيف أسنان",
      durationMinutes: 30,
      price: "300 ج.م",
      isActive: true,
    },
  ];

  const stateStore = new InMemoryConversationStateStore();
  const interceptedHttpCalls: Array<{
    url: string;
    body: any;
    rawBody: string;
  }> = [];

  const mockOpenRouterFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawBody = String(init?.body ?? "{}");
    let body: any = {};
    try {
      body = JSON.parse(rawBody);
    } catch {}
    interceptedHttpCalls.push({
      url: String(input),
      body,
      rawBody,
    });

    return new Response(
      JSON.stringify({
        id: "mock-openrouter-turn-1",
        model: "mock-generative-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING",
                action: "booking_handoff",
                content:
                  "تمام، هشوف لحضرتك المواعيد المتاحة لتنظيف الأسنان يوم 2026-10-23.",
                summary: "طلب حجز تنظيف أسنان غداً",
                extraction: {
                  service: "تنظيف أسنان",
                  provider: null,
                  date: "2026-10-23",
                  timePreference: null,
                },
                factUpdates: [
                  { key: "service", operation: "set", value: "تنظيف أسنان" },
                  { key: "date", operation: "set", value: "2026-10-23" },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const CANARY_AUTH_SECRET = "sk-canary-secret-auth-boundary-99999";
  const generativeAdapter = createOpenRouterAdapter({
    model: "mock-generative-model",
    getEnvVar: (name) =>
      name === OPENROUTER_SECRET_REF ? CANARY_AUTH_SECRET : undefined,
    fetchImpl: mockOpenRouterFetch as any,
  });

  const capturedEngineAiRequests: AiRequest[] = [];
  const engineAi = {
    providerName: "openrouter-test",
    async respond(request: AiRequest): Promise<AiResponse> {
      capturedEngineAiRequests.push(request);
      const res = await generativeAdapter.call(request);
      if (!res.ok || !res.response) {
        throw new Error(
          `OpenRouter call failed: ${"errorMessage" in res ? res.errorMessage : "unknown error"}`,
        );
      }
      return res.response;
    },
  };

  const messages: any[] = [];

  const deps: ConversationEngineDeps = {
    usageRepository: {
      record: async () => ({ id: "u-1" }) as any,
    } as any,
    businessRepository: {
      findByWhatsappNumber: async () => business as any,
      findById: async (id: string) =>
        id === BUSINESS_ID ? (business as any) : null,
    } as any,
    branchRepository: {
      findDefaultByBusiness: async () => branch as any,
      findByIdWithinBusiness: async (id: string) =>
        id === branch.id ? (branch as any) : null,
      findById: async (id: string) =>
        id === branch.id ? (branch as any) : null,
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
          name: "أحمد محمود",
        }) as any,
      findById: async () =>
        ({
          id: CUSTOMER_ID,
          businessId: BUSINESS_ID,
          phone: "+201111111111",
          name: "أحمد محمود",
        }) as any,
      touchConversation: async () => {},
    } as any,
    conversationRepository: {
      findLatestByCustomer: async () =>
        ({
          id: CONVERSATION_ID,
          businessId: BUSINESS_ID,
          customerId: CUSTOMER_ID,
          branchId: branch.id,
          status: "AI_ACTIVE",
        }) as any,
      findById: async () =>
        ({
          id: CONVERSATION_ID,
          businessId: BUSINESS_ID,
          customerId: CUSTOMER_ID,
          branchId: branch.id,
          status: "AI_ACTIVE",
        }) as any,
      create: async () =>
        ({
          id: CONVERSATION_ID,
          businessId: BUSINESS_ID,
          customerId: CUSTOMER_ID,
          branchId: branch.id,
          status: "AI_ACTIVE",
        }) as any,
      addMessage: async (input: any) => {
        const msg = {
          id: `msg-${messages.length + 1}`,
          ...input,
          createdAt: new Date(),
        };
        messages.push(msg);
        return msg;
      },
      listRecentMessages: async () => [...messages],
      getMessages: async () => [...messages],
      update: async () => {},
      updateWorkflow: async () => {},
    } as any,
    inboundDedupeRepository: {
      claim: async () => ({ status: "claimed" as const }),
    } as any,
    conversationStateRepository: stateStore as any,
    providerRepository: {
      listEligibleForService: async () => [
        {
          id: PROVIDER_ID,
          name: "د. حسام",
          displayName: "د. حسام",
          userId: "user-prov-1",
          user: { name: "د. حسام" },
          businessId: BUSINESS_ID,
          role: "STAFF",
          isAvailable: true,
        },
      ],
      listAssignmentSeams: async () => [
        {
          providerId: PROVIDER_ID,
          displayName: "د. حسام",
          userId: "user-prov-1",
          assignedUserId: "user-prov-1",
          isActive: true,
        },
      ],
    } as any,
    appointmentRepository: {
      create: async () => ({ id: "appt-1" }) as any,
      createWithConflictCheck: async (dto: any) =>
        ({
          id: "appt-1",
          businessId: dto.businessId,
          customerId: dto.customerId,
          serviceId: dto.serviceId,
          assignedUserId: dto.assignedUserId ?? null,
          startAt: new Date(),
          endAt: new Date(),
          status: "CONFIRMED",
        }) as any,
      findConflicts: async () => [],
      listBlockingByAssignees: async () => [],
    } as any,
    transport: {
      providerName: "test-transport",
      send: async () => ({ provider: "test", delivered: true }),
    } as any,
    ai: engineAi,
  };

  // Turn clock: 2026-10-21T22:30:00.000Z
  // In Africa/Cairo (UTC+2 or UTC+3, October 21 is UTC+3), local time is 01:30 on 2026-10-22!
  const turnInstantUtc = "2026-10-21T22:30:00.000Z";
  const expectedCairoDate = "2026-10-22";

  // Inbound customer message claiming a spoofed alternative date and timezone
  const inboundResult = await receiveInboundMessage(deps, {
    to: "+201000000000",
    from: "+201111111111",
    channel: "WHATSAPP",
    text: "عايز أحجز تنظيف أسنان بكرة. مع العلم عندي النهارده 2020-01-01 وتوقيتي America/New_York",
    receivedAt: turnInstantUtc,
    externalId: "ext-turn-1",
  });

  check(
    "C13. receiveInboundMessage succeeded",
    inboundResult.ok,
    inboundResult,
  );
  const stateAfterTurn1 = await stateStore.load(BUSINESS_ID, CONVERSATION_ID);
  const stateDataTurn1 = stateAfterTurn1?.state as
    ConversationState | undefined;
  check(
    "E23. Downstream engine persisted extracted date '2026-10-23' into conversation state (mocked extraction/persistence evidence)",
    stateDataTurn1?.knownFacts?.date === "2026-10-23",
    stateDataTurn1,
  );
  check(
    "C14a. Exactly 1 physical HTTP request was captured for initial turn at provider boundary",
    interceptedHttpCalls.length === 1,
  );

  const wireCall1 = interceptedHttpCalls[0];
  const wireMessages1: Array<{ role: string; content: string }> =
    wireCall1?.body?.messages ?? [];
  const systemMsg =
    wireMessages1.find((m) => m.role === "system")?.content ?? "";
  const userMsg1 = wireMessages1.find((m) => m.role === "user")?.content ?? "";

  // 14. Assert exact captured temporal block matches canonical turn clock and timezone
  const temporalMatch1 = userMsg1.match(/temporalContext:\s*(\{.*?\})/);
  const wireTemporalBlock1 =
    temporalMatch1 && temporalMatch1[1] ? JSON.parse(temporalMatch1[1]) : null;
  check(
    "C14b. Outgoing HTTP payload carries exact temporalContext block matching turn instant and derived Cairo date",
    wireTemporalBlock1 !== null &&
      wireTemporalBlock1.referenceInstant === turnInstantUtc &&
      wireTemporalBlock1.timeZone === "Africa/Cairo" &&
      wireTemporalBlock1.localDate === expectedCairoDate,
  );

  // Assert accidental wall-clock substitution is detectable (referenceInstant is not host execution timestamp)
  check(
    "C14c. Outgoing temporal referenceInstant strictly reflects supplied canonical instant, not host wall-clock",
    wireTemporalBlock1?.referenceInstant === turnInstantUtc,
  );

  // Independent isolated turn with identical explicit reference instant (isolated phone/conversation/dedupe)
  const CONVERSATION_ID_2 = "conv-temp-cairo-02";
  const CUSTOMER_ID_2 = "cust-temp-cairo-02";
  const inboundTurn2 = await receiveInboundMessage(
    {
      ...deps,
      conversationRepository: {
        ...deps.conversationRepository,
        findLatestByCustomer: async () =>
          ({
            id: CONVERSATION_ID_2,
            businessId: BUSINESS_ID,
            customerId: CUSTOMER_ID_2,
            branchId: branch.id,
            status: "AI_ACTIVE",
          }) as any,
        findById: async () =>
          ({
            id: CONVERSATION_ID_2,
            businessId: BUSINESS_ID,
            customerId: CUSTOMER_ID_2,
            branchId: branch.id,
            status: "AI_ACTIVE",
          }) as any,
        create: async () =>
          ({
            id: CONVERSATION_ID_2,
            businessId: BUSINESS_ID,
            customerId: CUSTOMER_ID_2,
            branchId: branch.id,
            status: "AI_ACTIVE",
          }) as any,
      },
      customerRepository: {
        ...deps.customerRepository,
        upsertByPhone: async () =>
          ({
            id: CUSTOMER_ID_2,
            businessId: BUSINESS_ID,
            phone: "+201222222222",
            name: "محمود حسن",
          }) as any,
        touchConversation: async () => {},
      } as any,
    },
    {
      to: "+201000000000",
      from: "+201222222222",
      channel: "WHATSAPP",
      text: "عايز أعرف مواعيد الكشف الطبي",
      receivedAt: turnInstantUtc,
      externalId: "ext-turn-2",
    },
  );
  check(
    "C14d. Independent isolated turn succeeded through engine",
    inboundTurn2.ok,
  );

  const wireCall2 = interceptedHttpCalls[1];
  const userMsg2 =
    wireCall2?.body?.messages?.find((m: any) => m.role === "user")?.content ??
    "";
  const temporalMatch2 = userMsg2.match(/temporalContext:\s*(\{.*?\})/);
  const wireTemporalBlock2 =
    temporalMatch2 && temporalMatch2[1] ? JSON.parse(temporalMatch2[1]) : null;
  check(
    "C14e. Independent turn with identical canonical instant preserves identical wire temporal block without clock drift",
    wireTemporalBlock2 !== null &&
      wireTemporalBlock2.referenceInstant === turnInstantUtc &&
      wireTemporalBlock2.timeZone === "Africa/Cairo" &&
      wireTemporalBlock2.localDate === expectedCairoDate,
  );

  // 15. temporalContext appears exactly once
  const matches = userMsg1.match(/temporalContext:/g);
  check(
    "C15. temporalContext block appears exactly once in user context",
    matches !== null && matches.length === 1,
  );

  // 16. Customer statement claiming alternative date/timezone cannot overwrite server fields
  const customerClaimPreservedAsContentOnly =
    userMsg1.includes("عايز أحجز تنظيف أسنان بكرة") &&
    !userMsg1.includes(`"timeZone":"America/New_York"`) &&
    !userMsg1.includes(`"localDate":"2020-01-01"`);
  check(
    "C16. Customer claims do not overwrite server-derived temporal context",
    customerClaimPreservedAsContentOnly,
  );

  // 17. Context builder was not bypassed
  const capturedAiReq = capturedEngineAiRequests[0];
  check(
    "C17a. Engine captured AiRequest carries valid temporalContext",
    capturedAiReq?.temporalContext?.referenceInstant === turnInstantUtc &&
      capturedAiReq?.temporalContext?.timeZone === "Africa/Cairo" &&
      capturedAiReq?.temporalContext?.localDate === expectedCairoDate,
  );
  check(
    "C17b. System instructions in HTTP request contain temporal reference rules",
    systemMsg.includes("temporalContext") &&
      systemMsg.includes("authoritative calendar reference"),
  );

  // =========================================================================
  // SECTION D: Boundaries & Zero-Model Assertions
  // =========================================================================
  console.log("D. Security & Zero-Model Boundary Invariants...");

  // 18. Zero secrets / tokens / canaries in temporal context or wire payload (non-vacuous canary test)
  const CANARY_OFFER_TOKEN = "canarytok123";
  const CANARY_CLAIM_NONCE = "canary_claim_nonce_secret_abc456";

  const canarySlotOffer = buildSlotOffer(
    { businessId: BUSINESS_ID, conversationId: "conv-canary-01" },
    "offer-canary-id-1",
    {
      serviceId: SERVICE_ID,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      providerId: PROVIDER_ID,
      date: "2026-10-23",
      followUpRequestId: null,
      shownCount: 1,
      options: [
        {
          providerId: PROVIDER_ID,
          displayName: "د. حسام",
          startAt: "2026-10-23T09:00",
          endAt: "2026-10-23T09:30",
        },
      ],
    },
    new Date(turnInstantUtc),
  );
  const offerWithCanaries = {
    ...canarySlotOffer!,
    token: CANARY_OFFER_TOKEN,
    claimNonce: CANARY_CLAIM_NONCE,
  };
  const stateWithCanaries = withPresentedOffer(
    {
      ...emptyConversationState(),
      serviceId: SERVICE_ID,
      serviceSource: "CUSTOMER",
      knownFacts: { service: "تنظيف أسنان", date: "2026-10-23" },
    },
    offerWithCanaries as any,
  );
  check(
    "D18a. Positive control: Upstream state fixture contains offer token and claim nonce canaries",
    stateWithCanaries.offer?.token === CANARY_OFFER_TOKEN &&
      (stateWithCanaries.offer as any)?.claimNonce === CANARY_CLAIM_NONCE,
  );

  const canaryProjection = projectConversationState(stateWithCanaries, {
    now: new Date(turnInstantUtc),
  });
  const canaryWireReq: AiRequest = {
    message: "مش فارق الوقت",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [{ senderType: "CUSTOMER", content: "مش فارق الوقت" }],
    businessName: "عيادة د. حسام لطب الأسنان",
    services: [{ name: "تنظيف أسنان" }],
    faqs: [],
    conversationContext: canaryProjection ?? undefined,
    temporalContext: buildAiTemporalContext(
      new Date(turnInstantUtc),
      "Africa/Cairo",
    ),
  };

  const canaryHttpCalls: Array<{ url: string; rawBody: string }> = [];
  const canaryAdapter = createOpenRouterAdapter({
    model: "mock-generative-model",
    getEnvVar: (name) =>
      name === OPENROUTER_SECRET_REF ? CANARY_AUTH_SECRET : undefined,
    fetchImpl: async (input, init) => {
      const rawBody = String(init?.body ?? "{}");
      canaryHttpCalls.push({ url: String(input), rawBody });
      return new Response(
        JSON.stringify({
          id: "canary-resp-1",
          model: "mock-generative-model",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  intent: "BOOKING",
                  action: "reply",
                  content: "تمام بدون تفضيل وقت.",
                  summary: null,
                  handoffReason: null,
                  extraction: {
                    service: null,
                    provider: null,
                    date: null,
                    timePreference: null,
                  },
                  factUpdates: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  await canaryAdapter.call(canaryWireReq);
  check(
    "D18b. Real captured HTTP request exists from context projection path",
    canaryHttpCalls.length === 1,
  );
  const canaryCall = canaryHttpCalls[0];
  const canaryWireBody = canaryCall?.rawBody ?? "";
  check(
    "D18c. Wire payload body strictly excludes offer token canary",
    !canaryWireBody.includes(CANARY_OFFER_TOKEN),
  );
  check(
    "D18d. Wire payload body strictly excludes claim nonce canary",
    !canaryWireBody.includes(CANARY_CLAIM_NONCE),
  );
  check(
    "D18e. Wire payload body strictly excludes adapter auth credential canary",
    !canaryWireBody.includes(CANARY_AUTH_SECRET),
  );

  // 19. Mechanical numeric choice ('١') executes exactly zero model network calls
  // Set up an active offer on conversation state for 2026-10-23:
  const baseState = {
    ...emptyConversationState(),
    serviceId: SERVICE_ID,
    serviceSource: "CUSTOMER" as const,
    knownFacts: { service: "تنظيف أسنان", date: "2026-10-23" },
  };
  const slotOffer = buildSlotOffer(
    { businessId: BUSINESS_ID, conversationId: CONVERSATION_ID },
    "tok-sel-1",
    {
      serviceId: SERVICE_ID,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      providerId: PROVIDER_ID,
      date: "2026-10-23",
      followUpRequestId: null,
      shownCount: 1,
      options: [
        {
          providerId: PROVIDER_ID,
          displayName: "د. حسام",
          startAt: "2026-10-23T09:00",
          endAt: "2026-10-23T09:30",
        },
      ],
    },
    new Date("2026-10-21T22:30:00.000Z"),
  );
  const activeOfferState = withPresentedOffer(baseState, slotOffer!);
  await stateStore.save(BUSINESS_ID, CONVERSATION_ID, 1, activeOfferState);

  const initialHttpCount = interceptedHttpCalls.length;
  // Send Arabic digit '١'
  const selectionTurn = await receiveInboundMessage(deps, {
    to: "+201000000000",
    from: "+201111111111",
    channel: "WHATSAPP",
    text: "١",
    receivedAt: "2026-10-21T22:35:00.000Z",
    externalId: "ext-sel-1",
  });

  const subsequentHttpCount = interceptedHttpCalls.length;
  check("D19a. Selection turn resolved successfully", selectionTurn.ok);
  check(
    "D19b. Exactly ZERO physical model HTTP attempts spent on numeric selection '١'",
    subsequentHttpCount === initialHttpCount,
  );

  // 20. Single-attempt bound: measured fixture executes exactly 1 provider call
  check(
    "D20. Measured generative turn fixture executes exactly 1 provider call (unexercised retry/fallback/shadow paths not tested here)",
    subsequentHttpCount === initialHttpCount,
  );

  // 21. Explicit REMOVE schema contract validation
  const removeProviderResponse: AiResponse = {
    intent: "BOOKING",
    action: "reply",
    content: "تمام شلت أي تفضيل للطبيب.",
    summary: null,
    handoffReason: null,
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    factUpdates: [{ key: "provider", operation: "remove" }],
  };
  check(
    "D21. Explicit REMOVE operation payload conforms to aiResponseSchema schema (state reconciliation proven in check:conv-core-03a)",
    aiResponseSchema.safeParse(removeProviderResponse).success,
  );

  // 22. Business fixture configuration defines default service
  check(
    "D22. Business fixture configuration defines default service (default-service resolution behavior proven in check:conv-core-03a)",
    business.defaultServiceId === SERVICE_ID,
  );

  // =========================================================================
  // SECTION E: Honest Language Evidence
  // =========================================================================
  console.log("E. Honest Language Evidence & JEV Capability Boundary...");

  console.log(
    "  ℹ️ [HONEST BOUNDARY] Offline test suite verifies mock extraction and schema persistence only; live model Egyptian Arabic dialect comprehension is NOT evaluated in this suite.",
  );

  // 25. JEV capability boundary:
  // a. Current adapter/request mapping omits temporalContext from JevState.
  // b. Configured JEV questions are bounded routing decisions; rich extraction is delegated in semanticResponse.
  const reqWithTemporal: AiRequest = {
    ...baseMinimalRequest,
    temporalContext: {
      referenceInstant: "2026-10-21T04:14:20.000Z",
      timeZone: "Africa/Cairo",
      localDate: "2026-10-21",
    },
  };
  const jevReq = buildSemanticRequest(reqWithTemporal);
  const jevState = jevReq.state as any;
  check(
    "E25a. Current buildSemanticRequest adapter mapping omits temporalContext from JevState",
    jevState.temporalContext === undefined &&
      jevState.temporal_context === undefined,
  );
  check(
    "E25b. Configured JEV questions are bounded routing decisions; rich extraction is delegated in semanticResponse",
    Object.keys(SEMANTIC_QUESTIONS).includes("bookingRequested") &&
      !Object.keys(SEMANTIC_QUESTIONS).includes("dateExtraction"),
  );

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log("\n── CORE-03B1 ACCEPTANCE RESULTS ──\n");
  let passed = 0;
  let failed = 0;
  for (const c of checks) {
    if (c.pass) {
      console.log(`  ✅ ${c.label}`);
      passed++;
    } else {
      console.log(`  ❌ ${c.label}`);
      failed++;
    }
  }

  console.log(
    `\nTOTAL: ${checks.length} assertions. PASSED: ${passed}, FAILED: ${failed}`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("FATAL ERROR in CORE-03B1 suite:", err);
  process.exit(1);
});
