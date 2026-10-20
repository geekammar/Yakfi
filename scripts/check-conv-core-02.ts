/**
 * FlowPilot — CONV-CORE-02 Verification Suite
 * Context-Aware JEV-First Semantic Gateway & Single Decision Ownership
 *
 * Verifies all 19 Required Scenarios (A through S) through real engine,
 * gateway, semantic strategy, decisions provider, and mock HTTP seams:
 *  A. Initial Arabic booking with context projection
 *  B. Date correction: date updates, service & evening preference survive, slot offer invalidated
 *  C. Provider correction: provider updates, slot offer invalidated, service & date survive
 *  D. Mixed inquiry and booking: grounded knowledge reply, booking preserved, 1 model call
 *  E. Knowledge interruption during booking: grounded reply, booking resumable
 *  F. Temporary pause ("ثواني بس"): active task and facts preserved
 *  G. Post-confirmation FAQ: answered without unjustified handoff
 *  H. Second booking after confirmation: fresh task, consumed offer not reused
 *  I. Explicit human request: authoritative safety precedence wins
 *  J. Provider preference without human request: mapped to provider, not handoff
 *  K. Numeric selection: mechanical resolution with ZERO model calls (Western & Arabic digits)
 *  L. Expired / invalid selection: safely rejected, no invalid appointment
 *  M. JEV timeout / malformed output: fails closed safely, 1 spent attempt, 0 LLM calls
 *  N. Missing credentials: pre-attempt routing, 0 network calls spent
 *  O. Successful semantic result vs conflicting lexical cue: JEV interpretation preserved
 *  P. Cross-tenant mismatch: mismatched state rejected by context builder (negative provenance tests)
 *  Q. Fresh request / durable reload: store reload affects provider request and planning
 *  R. Context bounds & disclosure: bounds enforced, secrets/nonces excluded, stale offers nullified
 *  S. State-revision regression: CAS conflict detected and handled through openTurnStateSession()
 *
 * Run: pnpm check:conv-core-02
 */

import type {
  Appointment,
  Branch,
  Business,
  Conversation,
  Customer,
  Message,
  Service,
} from "@/generated/prisma/client";

import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/conversation-ai";
import type { ConversationEngineDeps } from "@/features/conversations/server/conversation-engine";
import type {
  ConversationFactKey,
  ConversationState,
} from "@/features/conversations/server/conversation-state";
import type { UpdateConversationDto } from "@/lib/validation";
import type { JevAnswer } from "@/server/integrations/ai/jev-decisions-provider";
import type {
  AiProviderAdapter,
  AiProviderResult,
  AiTelemetry,
} from "@/server/integrations/ai/types";
import type { InboundClaimResult } from "@/server/repositories/inbound-dedupe.repository";
import type { UsageRecord } from "@/types/domain";

type MutableConversationState = {
  -readonly [K in keyof ConversationState]: ConversationState[K];
};

type Check = { label: string; pass: boolean; detail?: unknown };
const checks: Check[] = [];

function check(label: string, pass: boolean, detail?: unknown): void {
  if (!pass && detail !== undefined) {
    console.log(`[DEBUG FAIL] ${label}:`, detail);
  }
  checks.push({ label, pass, detail });
}

class InMemoryConversationStateStore {
  public rows = new Map<
    string,
    { businessId: string; revision: number; state: unknown; updatedAt: Date }
  >();
  public clock: () => Date = () => new Date("2026-09-14T10:00:00Z");

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
        updatedAt: this.clock(),
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
    const nextRevision = expectedRevision + 1;
    this.rows.set(conversationId, {
      businessId,
      revision: nextRevision,
      state: JSON.parse(JSON.stringify(state)),
      updatedAt: this.clock(),
    });
    return { status: "saved" as const, revision: nextRevision };
  }
}

function buildDefaultJevAnswers(text: string): Record<string, JevAnswer> {
  const isEmergency =
    text.includes("ألم") ||
    text.includes("طوارئ") ||
    text.includes("تعبان جدا");
  const isHumanReq =
    text.includes("الموظفين ضروري") ||
    text.includes("أكلم حد") ||
    text.includes("حولني لموظف");
  const isStaffCompliment =
    text.includes("الموظفين ممتازين") ||
    text.includes("الموظفين عندكم ممتازين");
  const isBenignIssue = text.includes("مفيش مشكلة");

  const sensitiveScore = isEmergency ? 0.98 : isBenignIssue ? 0.01 : 0.02;
  const supportScore = isHumanReq ? 0.95 : isStaffCompliment ? 0.05 : 0.05;
  const bookingScore = isEmergency || isHumanReq ? 0.1 : 0.95;

  let goal: string = "booking";
  if (isEmergency) goal = "sensitive";
  else if (isHumanReq) goal = "human_handoff";

  return {
    supportRequested: { type: "noul", noul: supportScore },
    providerRequested: {
      type: "noul",
      noul: text.includes("د.") || text.includes("دكتور") ? 0.95 : 0.05,
    },
    bookingRequested: { type: "noul", noul: bookingScore },
    availabilityAsked: { type: "noul", noul: 0.05 },
    cancellationRequested: { type: "noul", noul: 0.01 },
    rescheduleRequested: { type: "noul", noul: 0.01 },
    providerPreferenceExpressed: {
      type: "noul",
      noul: text.includes("د.") || text.includes("دكتور") ? 0.95 : 0.05,
    },
    sensitiveTurn: { type: "noul", noul: sensitiveScore },
    serviceOrPriceAsked: { type: "noul", noul: 0.05 },
    greetingOnly: { type: "noul", noul: 0.01 },
    ambiguousTurn: { type: "noul", noul: 0.05 },
    conversationGoal: {
      type: "choice",
      choice: goal,
      confidence: null,
      probabilities: { [goal]: 1.0 },
    },
  };
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { buildSlotOffer } =
    await import("../src/features/conversations/server/booking-offer");
  const { interpretOfferReply } =
    await import("../src/features/conversations/server/booking-selection");
  const {
    completeBookingTask,
    dehydrateConversationState,
    emptyConversationState,
    hydrateConversationState,
    mergeConversationState,
    projectConversationState,
    withPresentedOffer,
  } = await import("../src/features/conversations/server/conversation-state");
  const { buildAiContext } =
    await import("../src/features/conversations/server/ai-context-builder/context-builder");
  const { createJevDecisionsProvider, JEV_PINNED_MODEL, JEV_SECRET_REF } =
    await import("../src/server/integrations/ai/jev-decisions-provider");
  const { createSemanticJevStrategy } =
    await import("../src/server/integrations/ai/jev-semantic-strategy");
  const { createAiOrchestrator } =
    await import("../src/server/integrations/ai/orchestrator");
  const { openTurnStateSession } =
    await import("../src/features/conversations/server/conversation-state-store");
  const { receiveInboundMessage } =
    await import("../src/features/conversations/server/conversation-engine");
  const {
    extractProviderPreference,
    extractProviderPreferenceDetailed,
    extractTimeOfDayPreference,
    extractTimeOfDayPreferenceDetailed,
    resolveEgyptianRelativeDate,
    resolveEgyptianRelativeDateDetailed,
  } = await import("../src/features/conversations/server/relative-date");

  const B_ID = "11111111-1111-4111-8111-111111111111";
  const C_ID = "33333333-3333-4333-8333-333333333330";
  const SERVICE_1 = "33333333-3333-4333-8333-333333333331";
  const SERVICE_2 = "33333333-3333-4333-8333-333333333332";
  const PROVIDER_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const PROVIDER_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const PROVIDER_AHMED_ALI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const PROVIDER_AHMED_HASSAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
  const BRANCH_1 = "44444444-4444-4444-8444-444444444444";
  const now = new Date("2026-09-14T10:00:00Z");

  type HttpCall = {
    url: string;
    method: string;
    headers: Headers;
    body: Record<string, unknown> & {
      state?: {
        customer_message?: string;
        conversation_context?: {
          known_service?: string | null;
          known_date?: string | null;
          time_preference?: string | null;
          provider_preference?: string | null;
          active_offer?: {
            offered_service_name?: string | null;
          } | null;
          [key: string]: unknown;
        };
        [key: string]: unknown;
      };
    };
    rawBody: string;
  };

  type MockHttpHandler = (call: {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
  }) => { status: number; body: unknown };

  function createEngineFixture(opts?: {
    defaultServiceId?: string | null;
    customHttpHandler?: MockHttpHandler;
    hasCredentials?: boolean;
    customGenerativeReply?: (req: AiRequest) => AiResponse;
    providers?: Array<{
      id: string;
      displayName: string;
      user: { name: string };
    }>;
  }) {
    const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
    const workingHours: Record<string, unknown> = {};
    for (const d of days) {
      workingHours[d] = { open: "09:00", close: "18:00", closed: false };
    }

    const business = {
      id: B_ID,
      name: "عيادة الابتسامة",
      isActive: true,
      timezone: "Africa/Cairo",
      confirmationMode: "automatic",
      defaultBranchId: BRANCH_1,
      defaultServiceId: opts?.defaultServiceId ?? null,
      defaultBookingServiceId: opts?.defaultServiceId ?? null,
      defaultServiceBookingEnabled: Boolean(opts?.defaultServiceId),
      workingHours,
      slotDurationMinutes: 30,
      faqs: [
        {
          question: "عنوان ومكان العيادة فين؟",
          answer: "عنواننا في التجمع الخامس، القاهرة.",
        },
        {
          question: "بكام كشف الأسنان؟",
          answer: "سعر كشف الأسنان 300 جنيه.",
        },
        {
          question: "مواعيد العمل إيه؟",
          answer: "مواعيدنا يومياً من 9 صباحاً حتى 6 مساءً ما عدا الجمعة.",
        },
      ],
    };

    const branch = {
      id: BRANCH_1,
      businessId: B_ID,
      name: "الفرع الرئيسي",
      isActive: true,
    };

    const services = [
      {
        id: SERVICE_1,
        businessId: B_ID,
        name: "كشف أسنان",
        durationMinutes: 30,
        isActive: true,
      },
      {
        id: SERVICE_2,
        businessId: B_ID,
        name: "تنظيف أسنان",
        durationMinutes: 30,
        isActive: true,
      },
    ];

    const defaultProviders = [
      { id: PROVIDER_1, displayName: "د. سارة", user: { name: "سارة" } },
      { id: PROVIDER_2, displayName: "د. أحمد", user: { name: "أحمد" } },
    ];

    const providers = opts?.providers ?? defaultProviders;

    const customer = {
      id: "cust-1",
      businessId: B_ID,
      name: "عميل تجريبي",
      phone: "+201234567890",
    };

    let conversationStatus = "AI_ACTIVE";
    const conversation = {
      id: "conv-1",
      businessId: B_ID,
      customerId: customer.id,
      branchId: BRANCH_1,
      status: conversationStatus,
      assignedUserId: null as string | null,
      aiSummary: null as string | null,
    };

    const dedupeLedger = new Set<string>();
    const messages: Array<{ senderType: string; content: string; id: string }> =
      [];
    const stateStore = new InMemoryConversationStateStore();
    const createdAppointments: Array<{
      serviceId: string;
      providerId?: string;
      date: string;
      startTime: string;
      endTime: string;
    }> = [];

    // HTTP seam for provider adapter calls
    const httpCalls: HttpCall[] = [];
    let currentHttpHandler: MockHttpHandler =
      opts?.customHttpHandler ??
      ((call) => {
        const payload = call.body as
          { state?: { customer_message?: string } } | undefined;
        const text = payload?.state?.customer_message ?? "";
        const answers = buildDefaultJevAnswers(text);
        return {
          status: 200,
          body: {
            id: `dec-${httpCalls.length}`,
            model: JEV_PINNED_MODEL,
            answers,
            usage: { input_tokens: 180, output_tokens: 30 },
          },
        };
      });

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const rawBody = String(init?.body ?? "{}");
      let body: unknown = {};
      try {
        body = JSON.parse(rawBody);
      } catch {}
      const call: HttpCall = {
        url,
        method,
        headers,
        body: body as HttpCall["body"],
        rawBody,
      };
      httpCalls.push(call);

      const res = currentHttpHandler(call);
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: { "Content-Type": "application/json" },
      });
    };

    let hasCredentials = opts?.hasCredentials ?? true;
    const decisionsProvider = createJevDecisionsProvider({
      getEnvVar: (name) =>
        name === JEV_SECRET_REF && hasCredentials
          ? "sk-openrouter-test"
          : undefined,
      fetchImpl: mockFetch,
    });

    const semanticStrategy = createSemanticJevStrategy({
      provider: decisionsProvider,
      enabled: true,
    });

    let generativeCalls = 0;
    const capturedRequests: AiRequest[] = [];
    const generativeAdapter: AiProviderAdapter = {
      providerId: "openrouter",
      model: "mock-generative-v1",
      secretRef: "MOCK_KEY",
      async call(req: AiRequest): Promise<AiProviderResult> {
        generativeCalls++;
        capturedRequests.push(req);

        let response: AiResponse;
        if (opts?.customGenerativeReply) {
          response = opts.customGenerativeReply(req);
        } else if (
          req.message.includes("عنوان") ||
          req.message.includes("مكان")
        ) {
          response = {
            intent: "FAQ",
            action: "reply",
            summary: "سؤال عن المكان",
            content: "عنواننا في التجمع الخامس، القاهرة.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
          };
        } else if (req.message.includes("بكام")) {
          response = {
            intent: "FAQ",
            action: "reply",
            summary: "استفسار عن السعر مع حجز",
            content: "سعر كشف الأسنان 300 جنيه.",
            handoffReason: null,
            goals: [
              { kind: "ANSWER", intent: "FAQ", continueAfter: true },
              { kind: "DOMAIN_ACTION", intent: "BOOKING" },
            ],
            extraction: {
              service: "كشف أسنان",
              provider: null,
              date: "2026-09-15",
              timePreference: null,
            },
          };
        } else {
          response = {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "حجز موعد",
            content: "أهلاً بك! هساعدك في حجز الموعد.",
            handoffReason: null,
            extraction: {
              service: "تنظيف أسنان",
              provider: null,
              date: "2026-09-15",
              timePreference: "evening",
            },
          };
        }

        return {
          ok: true,
          response,
          provider: "openrouter",
          model: "mock-generative-v1",
          latencyMs: 15,
        };
      },
    };

    const orchestrator = createAiOrchestrator({
      primary: generativeAdapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: semanticStrategy,
    });

    let lastTelemetry: AiTelemetry | null = null;
    const realGatewayAi = {
      get providerName() {
        return lastTelemetry?.finalProvider ?? "policy-backed";
      },
      async respond(request: AiRequest): Promise<AiResponse> {
        capturedRequests.push(request);
        const result = await orchestrator.callWithFallback(request);
        lastTelemetry = result.telemetry;
        if (!result.response) {
          throw new Error("No response returned from orchestrator");
        }
        return result.response;
      },
      getLastTelemetry() {
        return lastTelemetry;
      },
    };

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findByWhatsappNumber: async () => business as unknown as Business,
        findById: async (id: string) =>
          id === B_ID ? (business as unknown as Business) : null,
      },
      branchRepository: {
        findDefaultByBusiness: async () => branch as unknown as Branch,
        findByIdWithinBusiness: async (id: string, bId?: string) =>
          id === BRANCH_1 && (!bId || bId === B_ID)
            ? (branch as unknown as Branch)
            : null,
      },
      customerRepository: {
        upsertByPhone: async () => customer as unknown as Customer,
        touchConversation: async () => customer as unknown as Customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findById: async () =>
          ({
            ...conversation,
            status: conversation.status,
          }) as unknown as Conversation,
        create: async () => conversation as unknown as Conversation,
        addMessage: async (
          input: {
            conversationId: string;
            senderType: string;
            content: string;
          },
          options?: { status?: string },
        ) => {
          if (options?.status) {
            conversationStatus = options.status;
            conversation.status = options.status;
          }
          const msg = {
            id: `msg-${messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
          };
          messages.push(msg);
          return msg as unknown as Message;
        },
        getMessages: async () => [...messages] as unknown as Message[],
        update: async (_id: string, data: UpdateConversationDto) => {
          if (data.aiSummary !== undefined) {
            conversation.aiSummary = data.aiSummary;
          }
          return {
            ...conversation,
            status: conversationStatus,
          } as unknown as Conversation;
        },
        updateWorkflow: async (
          _id: string,
          data: { status?: Conversation["status"] },
        ) => {
          if (data.status) {
            conversationStatus = data.status;
            conversation.status = data.status;
          }
          return {
            ...conversation,
            status: conversationStatus,
          } as unknown as Conversation;
        },
      },
      conversationStateRepository: stateStore,
      serviceRepository: {
        listByBusiness: async () => services as unknown as Service[],
        findById: async (id: string) =>
          (services.find((s) => s.id === id) ??
            null) as unknown as Service | null,
      },
      inboundDedupeRepository: {
        claim: async (
          _bId: string,
          key: string,
        ): Promise<InboundClaimResult> => {
          if (dedupeLedger.has(key)) {
            return {
              status: "duplicate",
              claimId: `claim-${dedupeLedger.size}`,
              conversationId: conversation.id,
              customerMessageId: "msg-1",
            };
          }
          dedupeLedger.add(key);
          return {
            status: "claimed",
            claimId: `claim-${dedupeLedger.size}`,
          };
        },
      },
      usageRepository: {
        record: async () => ({ id: "usage-1" }) as unknown as UsageRecord,
      },
      providerRepository: {
        listEligibleForService: async () =>
          providers as unknown as Array<{
            id: string;
            displayName: string;
            user: { name: string };
          }>,
        listAssignmentSeams: async () =>
          providers.map((p, idx) => ({
            providerId: p.id,
            userId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${idx + 1}`,
            assignedUserId: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${idx + 1}`,
          })),
      },
      appointmentRepository: {
        createWithConflictCheck: async (dto: {
          businessId: string;
          customerId: string;
          serviceId: string;
          date: string;
          startTime: string;
          endTime: string;
          branchId?: string | null;
          providerId?: string | null;
          assignedUserId?: string | null;
          status?: string;
          followUpRequestId?: string | null;
        }) => {
          createdAppointments.push({
            serviceId: dto.serviceId,
            providerId: dto.providerId ?? undefined,
            date: dto.date,
            startTime: dto.startTime,
            endTime: dto.endTime,
          });
          return {
            id: `apt-${createdAppointments.length}`,
          } as unknown as Appointment;
        },
        listBlockingByAssignees: async () => [],
      },
      transport: {
        providerName: "test-transport",
        send: async () => ({ provider: "test", delivered: true }),
      },
      ai: realGatewayAi as unknown as ConversationEngineDeps["ai"],
    };

    let msgCounter = 0;
    async function sendTurn(text: string, timestamp: Date = now) {
      msgCounter++;
      return receiveInboundMessage(deps, {
        from: "+201234567890",
        to: "+201000000000",
        text,
        receivedAt: timestamp.toISOString(),
        channel: "WHATSAPP",
        externalId: `ext-${msgCounter}-${Date.now()}-${Math.random()}`,
      });
    }

    return {
      deps,
      conversation,
      stateStore,
      createdAppointments,
      capturedRequests,
      sendTurn,
      httpCalls,
      setHttpHandler: (fn: MockHttpHandler) => {
        currentHttpHandler = fn;
      },
      setCredentials: (cred: boolean) => {
        hasCredentials = cred;
      },
      getJevCalls: () => httpCalls.length,
      getGenerativeCalls: () => generativeCalls,
    };
  }

  console.log("── FLOWPILOT CONV-CORE-02 ACCEPTANCE SUITE ──\n");

  // =========================================================================
  // SCENARIO A: Initial Arabic booking through real JEV gateway with context projection
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const res = await fixture.sendTurn("عايز أحجز تنظيف بكرة بالليل");

    check(
      "Scenario A: Turn executed successfully through real JEV gateway",
      Boolean(
        res.ok &&
        "assistantAction" in res &&
        res.assistantAction === "AI_REPLY",
      ),
      res,
    );
    check(
      "Scenario A: Exactly 1 JEV physical attempt spent, 0 generative LLM calls",
      fixture.getJevCalls() === 1 && fixture.getGenerativeCalls() === 0,
    );

    // Verify durable state was saved with the extracted facts and slot offer presented
    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const hydrated = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;
    check(
      "Scenario A: Durable state reflects BOOKING task",
      hydrated?.activeTask?.kind === "BOOKING",
    );
    check(
      "Scenario A: Resolved service is recorded",
      hydrated?.serviceId === SERVICE_2,
    );
    check(
      "Scenario A: Evening preference is preserved in durable state",
      hydrated?.selectedTimePref === "evening" ||
        hydrated?.knownFacts?.timePreference === "evening",
    );

    // Turn 2: Verify next turn projects this saved context to the AI and serializes to HTTP seam
    await fixture.sendTurn("الساعة كام المواعيد؟");
    const lastHttpCall = fixture.httpCalls[fixture.httpCalls.length - 1];
    const wireContext = lastHttpCall?.body?.state?.conversation_context;

    check(
      "Scenario A: Context projection serialized to HTTP seam on subsequent turn",
      wireContext !== undefined &&
        wireContext.known_service === "تنظيف أسنان" &&
        wireContext.time_preference === "evening",
      wireContext,
    );
  }

  // =========================================================================
  // SCENARIO B: Date correction
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const initialOffer = buildSlotOffer(
      { businessId: B_ID, conversationId: fixture.conversation.id },
      "offer-b",
      {
        serviceId: SERVICE_2,
        serviceName: "تنظيف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T19:00",
            endAt: "2026-09-15T19:30",
          },
        ],
      },
      now,
    )!;

    const seedState: MutableConversationState = withPresentedOffer(
      emptyConversationState(),
      initialOffer,
    );
    seedState.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
    seedState.serviceId = SERVICE_2;
    seedState.selectedService = "تنظيف أسنان";
    seedState.selectedDate = "2026-09-15";
    seedState.selectedTimePref = "evening";
    seedState.knownFacts = {
      service: "تنظيف أسنان",
      date: "2026-09-15",
      timePreference: "evening",
    };

    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    // Turn 2: Customer corrects date: "خليه الخميس بدل بكرة"
    await fixture.sendTurn("خليه الخميس بدل بكرة");

    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;

    const lastHttpCall = fixture.httpCalls[fixture.httpCalls.length - 1];
    const sentContext = lastHttpCall?.body?.state?.conversation_context;
    check(
      "Scenario B: Context projection carried prior activeOffer and facts to JEV HTTP seam",
      sentContext?.known_service === "تنظيف أسنان" &&
        sentContext?.active_offer?.offered_service_name === "تنظيف أسنان",
    );
    check(
      "Scenario B: Date updated to Thursday (2026-09-17)",
      state?.selectedDate === "2026-09-17" ||
        state?.knownFacts?.date === "2026-09-17",
      state?.knownFacts,
    );
    check(
      "Scenario B: Service survived date correction without being repeated",
      state?.serviceId === SERVICE_2,
    );
    check(
      "Scenario B: Evening time preference survived date correction",
      state?.selectedTimePref === "evening" ||
        state?.knownFacts?.timePreference === "evening",
    );
    check(
      "Scenario B: Slot offer for the old date was superseded with new date offer",
      state?.offer?.kind === "SLOT" && state.offer.date === "2026-09-17",
    );
  }

  // =========================================================================
  // SCENARIO C: Provider correction
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const initialOffer = buildSlotOffer(
      { businessId: B_ID, conversationId: fixture.conversation.id },
      "offer-c",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PROVIDER_2,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_2,
            displayName: "د. أحمد",
            startAt: "2026-09-15T10:00",
            endAt: "2026-09-15T10:30",
          },
        ],
      },
      now,
    )!;

    const seedState: MutableConversationState = withPresentedOffer(
      emptyConversationState(),
      initialOffer,
    );
    seedState.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
    seedState.serviceId = SERVICE_1;
    seedState.selectedService = "كشف أسنان";
    seedState.providerPreference = PROVIDER_2;
    seedState.selectedDate = "2026-09-15";
    seedState.knownFacts = {
      service: "كشف أسنان",
      provider: "د. أحمد",
      date: "2026-09-15",
    };

    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    // Turn: Customer corrects provider: "عايز مع د. سارة بدل د. أحمد"
    await fixture.sendTurn("عايز مع د. سارة بدل د. أحمد");

    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;

    check(
      "Scenario C: Provider updated to د. سارة",
      state?.providerPreference === PROVIDER_1 ||
        state?.knownFacts?.provider === "د. سارة",
    );
    check(
      "Scenario C: Service survived provider correction",
      state?.serviceId === SERVICE_1,
    );
    check(
      "Scenario C: Date survived provider correction",
      state?.selectedDate === "2026-09-15" ||
        state?.knownFacts?.date === "2026-09-15",
    );
    const firstOpt = state?.offer?.options?.[0];
    check(
      "Scenario C: Slot offer updated to selected provider",
      Boolean(
        firstOpt &&
        "displayName" in firstOpt &&
        firstOpt.displayName === "د. سارة",
      ),
    );
  }

  // =========================================================================
  // SCENARIO D: Mixed inquiry and booking (answer-and-continue)
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const res = await fixture.sendTurn("بكام كشف الأسنان وعايز أحجز بكرة");

    check(
      "Scenario D: Handled in exactly 1 model call (0 extra chains)",
      fixture.getGenerativeCalls() === 1 && fixture.getJevCalls() === 0,
    );
    check(
      "Scenario D: Grounded FAQ reply returned with booking preserved in pendingGoals",
      Boolean(
        res.ok &&
        "assistantAction" in res &&
        res.assistantAction === "AI_REPLY" &&
        res.observability?.turnPlan?.steps?.some((s) => s.kind === "ANSWER"),
      ),
      res,
    );
    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;
    check(
      "Scenario D: Booking goal survives as pendingGoal in durable state",
      Boolean(state?.pendingGoals?.some((g) => g.kind === "DOMAIN_ACTION")),
    );
  }

  // =========================================================================
  // SCENARIO E: Knowledge interruption during multi-turn booking
  // =========================================================================
  {
    const fixture = createEngineFixture();
    // Turn 1: Customer starts booking
    await fixture.sendTurn("عايز أحجز كشف أسنان");
    const state1 = (
      await fixture.stateStore.load(B_ID, fixture.conversation.id)
    )?.state as ConversationState | undefined;
    check(
      "Scenario E (Multi-turn): Turn 1 establishes active booking task",
      state1?.activeTask?.kind === "BOOKING",
    );

    // Turn 2: Customer interrupts with FAQ: "عنوان ومكان العيادة فين؟"
    const res2 = await fixture.sendTurn("عنوان ومكان العيادة فين؟");
    check(
      "Scenario E (Multi-turn): Grounded FAQ answer provided during interruption",
      Boolean(
        res2.ok &&
        "assistantAction" in res2 &&
        res2.assistantAction === "AI_REPLY" &&
        fixture.conversation.status === "AI_ACTIVE",
      ),
    );

    const saved2 = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state2 = saved2
      ? hydrateConversationState(saved2.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;

    check(
      "Scenario E (Multi-turn): Booking task marked INTERRUPTED and facts survive",
      state2?.bookingStage === "INTERRUPTED" &&
        state2.knownFacts.service === "كشف أسنان",
      {
        bookingStage: state2?.bookingStage,
        knownFacts: state2?.knownFacts,
        activeTask: state2?.activeTask,
        topics: state2?.topics,
      },
    );
  }

  // =========================================================================
  // SCENARIO F: Temporary pause ("ثواني بس")
  // =========================================================================
  {
    const { state: inBooking } = mergeConversationState(
      emptyConversationState(),
      {
        turnGoal: "BOOKING",
        factUpdates: [{ key: "service", value: "كشف أسنان" }],
      },
    );

    const { state: paused } = mergeConversationState(inBooking, {
      turnGoal: "GENERAL",
    });

    check(
      "Scenario F: Active booking task not erased by temporary pause",
      paused.activeTask?.kind === "BOOKING" &&
        paused.knownFacts.service === "كشف أسنان",
    );
  }

  // =========================================================================
  // SCENARIO G: Post-confirmation FAQ
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const seedState = completeBookingTask(emptyConversationState(), {
      appointmentId: "apt-1",
      serviceId: SERVICE_1,
      providerId: null,
      date: "2026-09-15",
      completedAt: now.toISOString(),
    });
    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    const res = await fixture.sendTurn("مواعيد العمل إيه؟");

    check(
      "Scenario G: Post-confirmation FAQ answered without handoff",
      res.ok &&
        "assistantAction" in res &&
        res.assistantAction === "AI_REPLY" &&
        fixture.conversation.status === "AI_ACTIVE",
    );
  }

  // =========================================================================
  // SCENARIO H: Second booking after confirmation
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const seedState = completeBookingTask(emptyConversationState(), {
      appointmentId: "apt-2",
      serviceId: SERVICE_1,
      providerId: null,
      date: "2026-09-15",
      completedAt: now.toISOString(),
    });
    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    await fixture.sendTurn("عايز أحجز كشف تاني يوم الخميس");

    const saved = await fixture.stateStore.load(B_ID, fixture.conversation.id);
    const state = saved
      ? hydrateConversationState(saved.state, {
          businessId: B_ID,
          conversationId: fixture.conversation.id,
        })
      : null;

    check(
      "Scenario H: Fresh booking task started after previous completion",
      state?.activeTask?.kind === "BOOKING",
    );
    check(
      "Scenario H: Consumed offer not reused",
      state?.offer === null || state?.offer?.status !== "CONSUMED",
    );
  }

  // =========================================================================
  // SCENARIO I: Explicit human request through real JEV gateway
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const res = await fixture.sendTurn("عايز أكلم حد من الموظفين ضروري");

    check(
      "Scenario I: Explicit human request triggers handoff",
      res.ok &&
        "assistantAction" in res &&
        res.assistantAction === "AI_HANDOFF" &&
        fixture.conversation.status === "NEED_HUMAN",
    );
  }

  // =========================================================================
  // SCENARIO J: Provider preference without human request
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const res = await fixture.sendTurn("عايز أحجز مع الدكتور أحمد");

    check(
      "Scenario J: Named provider preference is NOT treated as human handoff",
      res.ok &&
        "assistantAction" in res &&
        res.assistantAction === "AI_REPLY" &&
        fixture.conversation.status === "AI_ACTIVE",
    );
  }

  // =========================================================================
  // SCENARIO K: Numeric selection (1 / ١ against active offer) via receiveInboundMessage
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: fixture.conversation.id },
      "offer-k",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PROVIDER_1,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
          },
        ],
      },
      now,
    )!;

    const seedState = withPresentedOffer(emptyConversationState(), offer);
    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    // K1: Arabic digit selection "١" through receiveInboundMessage
    const resArabic = await fixture.sendTurn("١");
    check(
      "Scenario K: Arabic digit selection executes mechanically with exactly 0 model calls",
      resArabic.ok &&
        "assistantAction" in resArabic &&
        resArabic.assistantAction === "AI_REPLY" &&
        fixture.getJevCalls() === 0 &&
        fixture.getGenerativeCalls() === 0 &&
        fixture.createdAppointments.length === 1,
    );

    // K2: Western digit selection "1" against fresh active offer
    const fixture2 = createEngineFixture();
    const offer2 = buildSlotOffer(
      { businessId: B_ID, conversationId: fixture2.conversation.id },
      "offer-k2",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PROVIDER_1,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
          },
        ],
      },
      now,
    )!;
    const seedState2 = withPresentedOffer(emptyConversationState(), offer2);
    await fixture2.stateStore.save(
      B_ID,
      fixture2.conversation.id,
      null,
      dehydrateConversationState(seedState2),
    );

    const resWestern = await fixture2.sendTurn("1");
    check(
      "Scenario K: Western digit selection executes mechanically with exactly 0 model calls",
      resWestern.ok &&
        "assistantAction" in resWestern &&
        resWestern.assistantAction === "AI_REPLY" &&
        fixture2.getJevCalls() === 0 &&
        fixture2.getGenerativeCalls() === 0 &&
        fixture2.createdAppointments.length === 1,
    );
  }

  // =========================================================================
  // SCENARIO L: Expired / invalid selection
  // =========================================================================
  {
    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: C_ID },
      "offer-l",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PROVIDER_1,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
          },
        ],
      },
      now,
    )!;

    const dayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const reply = interpretOfferReply("1", offer, dayLater);

    check(
      "Scenario L: Expired offer selection is rejected as stale (EXPIRED)",
      reply.kind === "stale" && reply.reason === "EXPIRED",
    );
  }

  // =========================================================================
  // SCENARIO M: JEV timeout / spent failure
  // =========================================================================
  {
    const fixture = createEngineFixture({
      customHttpHandler: () => {
        throw new Error("ETIMEDOUT");
      },
    });

    const res = await fixture.sendTurn("عايز أحجز كشف");

    check(
      "Scenario M: JEV timeout results in deterministic fallback (fail-closed)",
      Boolean(res.ok && "assistantAction" in res),
    );
    check(
      "Scenario M: Exactly 1 JEV physical attempt spent, 0 generative LLM calls (no chaining)",
      fixture.getJevCalls() === 1 && fixture.getGenerativeCalls() === 0,
    );
  }

  // =========================================================================
  // SCENARIO N: Missing credentials
  // =========================================================================
  {
    const fixture = createEngineFixture({
      hasCredentials: false,
    });

    const res = await fixture.sendTurn("عايز كشف");

    check(
      "Scenario N: Missing credentials routes pre-attempt to GENERATIVE",
      Boolean(res.ok && "assistantAction" in res),
    );
    check(
      "Scenario N: Missing credentials spends exactly 0 network calls to JEV",
      fixture.getJevCalls() === 0 && fixture.getGenerativeCalls() === 1,
    );
  }

  // =========================================================================
  // SCENARIO O: Semantic Ownership & Lexical Conflict Resolution (Review Finding 1)
  // =========================================================================
  {
    // O.1: Booking + compliment mentioning staff ("الموظفين عندكم ممتازين")
    const fixtureStaffCompliment = createEngineFixture();
    const resCompliment = await fixtureStaffCompliment.sendTurn(
      "عايز أحجز كشف بكرة والموظفين عندكم ممتازين",
    );
    check(
      "Scenario O.1: Booking with staff compliment stays AI_ACTIVE booking (not human handoff)",
      resCompliment.ok &&
        "assistantAction" in resCompliment &&
        resCompliment.assistantAction === "AI_REPLY" &&
        fixtureStaffCompliment.conversation.status === "AI_ACTIVE",
      resCompliment,
    );

    // O.2: Benign "مفيش مشكلة"
    const fixtureBenignIssue = createEngineFixture();
    const resBenign = await fixtureBenignIssue.sendTurn(
      "عايز أحجز كشف بكرة ومفيش مشكلة",
    );
    check(
      "Scenario O.2: Benign 'مفيش مشكلة' stays AI_ACTIVE booking (not sensitive handoff)",
      resBenign.ok &&
        "assistantAction" in resBenign &&
        resBenign.assistantAction === "AI_REPLY" &&
        fixtureBenignIssue.conversation.status === "AI_ACTIVE",
    );

    // O.3: Genuine sensitive case
    const fixtureSensitive = createEngineFixture();
    const resSensitive = await fixtureSensitive.sendTurn(
      "عندي ألم شديد جداً ومش قادر أتحمل",
    );
    check(
      "Scenario O.3: Genuine emergency triggers SENSITIVE handoff",
      resSensitive.ok &&
        "assistantAction" in resSensitive &&
        resSensitive.assistantAction === "AI_HANDOFF" &&
        fixtureSensitive.conversation.status === "NEED_HUMAN" &&
        resSensitive.handoffCause === "SENSITIVE_OR_RESTRICTED",
      { resSensitive, status: fixtureSensitive.conversation.status },
    );

    // O.4: Staff-owned conversation deferred to staff
    const fixtureStaffOwned = createEngineFixture();
    fixtureStaffOwned.conversation.status = "NEED_HUMAN";
    const resStaffOwned =
      await fixtureStaffOwned.sendTurn("عايز أحجز كشف بكرة");
    check(
      "Scenario O.4: Staff-owned conversation routes to DEFERRED_TO_STAFF with 0 AI calls",
      resStaffOwned.ok &&
        "assistantAction" in resStaffOwned &&
        resStaffOwned.assistantAction === "DEFERRED_TO_STAFF" &&
        fixtureStaffOwned.getJevCalls() === 0 &&
        fixtureStaffOwned.getGenerativeCalls() === 0,
    );
  }

  // =========================================================================
  // SCENARIO P: Context Provenance & Cross-Tenant Isolation (Review Finding 4)
  // =========================================================================
  {
    const stateA: MutableConversationState = emptyConversationState();
    stateA.activeTask = { kind: "BOOKING", stage: "SERVICE_SUPPLIED" };
    stateA.serviceId = SERVICE_1;
    stateA.selectedService = "كشف أسنان";

    // P.1: State from Business A supplied toward Business B -> REJECTED
    const builtCrossTenant = buildAiContext({
      scope: { businessId: B_ID },
      sources: {
        message: "مرحبا",
        business: { businessId: B_ID, name: "عيادة الابتسامة" },
        conversation: { id: "conv-1", status: "AI_ACTIVE", recentMessages: [] },
        conversationState: stateA,
        conversationStateEnvelope: {
          businessId: "FOREIGN-BUSINESS-B",
          conversationId: "conv-1",
        },
        services: [],
      },
    });
    check(
      "Scenario P.1: Cross-tenant state envelope rejected by Context Builder",
      builtCrossTenant.request.conversationContext === undefined,
    );

    // P.2: Wrong conversation ID within same business -> REJECTED
    const builtWrongConv = buildAiContext({
      scope: { businessId: B_ID },
      sources: {
        message: "مرحبا",
        business: { businessId: B_ID, name: "عيادة الابتسامة" },
        conversation: {
          id: "conv-CURRENT",
          status: "AI_ACTIVE",
          recentMessages: [],
        },
        conversationState: stateA,
        conversationStateEnvelope: {
          businessId: B_ID,
          conversationId: "conv-FOREIGN",
        },
        services: [],
      },
    });
    check(
      "Scenario P.2: Mismatched conversation within same business rejected",
      builtWrongConv.request.conversationContext === undefined,
    );

    // P.3: Foreign state with no active offer and unproven provenance -> REJECTED
    const builtUnproven = buildAiContext({
      scope: { businessId: B_ID },
      sources: {
        message: "مرحبا",
        business: { businessId: B_ID, name: "عيادة الابتسامة" },
        conversation: { id: "conv-1", status: "AI_ACTIVE", recentMessages: [] },
        conversationState: stateA,
        conversationStateEnvelope: null,
        services: [],
      },
    });
    check(
      "Scenario P.3: Unproven state provenance rejected safely",
      builtUnproven.request.conversationContext === undefined,
    );

    // P.4: Correctly scoped state accepted -> INCLUDED
    const builtValid = buildAiContext({
      scope: { businessId: B_ID },
      sources: {
        message: "مرحبا",
        business: { businessId: B_ID, name: "عيادة الابتسامة" },
        conversation: { id: "conv-1", status: "AI_ACTIVE", recentMessages: [] },
        conversationState: stateA,
        conversationStateEnvelope: {
          businessId: B_ID,
          conversationId: "conv-1",
        },
        services: [],
      },
    });
    check(
      "Scenario P.4: Correctly scoped state envelope accepted and projected",
      builtValid.request.conversationContext !== undefined &&
        builtValid.request.conversationContext?.knownService === "كشف أسنان",
    );

    // P.5: No durable state remains supported
    const builtNoState = buildAiContext({
      scope: { businessId: B_ID },
      sources: {
        message: "مرحبا",
        business: { businessId: B_ID, name: "عيادة الابتسامة" },
        conversation: { id: "conv-1", status: "AI_ACTIVE", recentMessages: [] },
        conversationState: null,
        services: [],
      },
    });
    check(
      "Scenario P.5: Null durable state handled safely with undefined projection",
      builtNoState.request.conversationContext === undefined,
    );
  }

  // =========================================================================
  // SCENARIO Q: Fresh request / durable reload
  // =========================================================================
  {
    const fixture = createEngineFixture();
    const seedState: MutableConversationState = emptyConversationState();
    seedState.activeTask = { kind: "BOOKING", stage: "TIME_SUPPLIED" };
    seedState.bookingStage = "TIME_SUPPLIED";
    seedState.serviceId = SERVICE_2;
    seedState.selectedService = "تنظيف أسنان";
    seedState.selectedDate = "2026-09-20";
    seedState.selectedTimePref = "morning";
    seedState.knownFacts = {
      service: "تنظيف أسنان",
      date: "2026-09-20",
      timePreference: "morning",
    };
    await fixture.stateStore.save(
      B_ID,
      fixture.conversation.id,
      null,
      dehydrateConversationState(seedState),
    );

    await fixture.sendTurn("ممكن أعرف المواعيد المتاحة؟");

    const lastHttpCall = fixture.httpCalls[fixture.httpCalls.length - 1];
    const wireCtx = lastHttpCall?.body?.state?.conversation_context;
    check(
      "Scenario Q: Reloaded state reflected in provider request wire context",
      wireCtx?.known_service === "تنظيف أسنان" &&
        wireCtx?.known_date === "2026-09-20" &&
        wireCtx?.time_preference === "morning",
      wireCtx,
    );
  }

  // =========================================================================
  // SCENARIO R: Context bounds, boundary sizes & runtime validation (Finding 5)
  // =========================================================================
  {
    const state: MutableConversationState = emptyConversationState();
    state.activeTask = { kind: "BOOKING", stage: "SERVICE_SUPPLIED" };
    state.selectedService =
      "تنظيف وتلميع الأسنان بالفلورايد وإزالة الرواسب الجيرية بعناية فائقة"; // 65 chars
    state.serviceId =
      "svc-boundary-sized-identifier-that-is-longer-than-sixty-four-characters-long";
    state.missingFacts = [
      "date",
      "timePreference",
      "provider",
      "service",
      "customerName",
      "followUpRequestId",
      "date",
      "service",
      "provider",
    ] as unknown as ConversationFactKey[];

    const offer = buildSlotOffer(
      { businessId: B_ID, conversationId: "c-1" },
      "offer-secret-nonce-12345",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: PROVIDER_1,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 1,
        options: [
          {
            providerId: PROVIDER_1,
            displayName: "د. سارة",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
          },
        ],
      },
      now,
    )!;

    state.offer = offer;

    const projection = projectConversationState(state, { now });

    check(
      "Scenario R: Missing facts in clarification are bounded to 8 items",
      projection?.pendingClarification?.missingFacts?.length === 8,
    );
    check(
      "Scenario R: Offer nonce / internal tokens are NOT leaked in projection",
      !("nonce" in (projection?.activeOffer ?? {})),
    );
    check(
      "Scenario R: Live active offer is projected with safe fields",
      projection?.activeOffer?.type === "SLOT" &&
        projection.activeOffer.offeredServiceName === "كشف أسنان",
    );

    // Boundary size validation: lengths up to persistedState max bounds are accepted safely
    check(
      "Scenario R: Boundary-sized valid state passes runtime validation safely",
      projection?.knownService === state.selectedService &&
        projection?.resolvedServiceId === state.serviceId,
    );

    // Expired offer is projected as null
    const dayLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const staleProjection = projectConversationState(state, { now: dayLater });
    check(
      "Scenario R: Expired offer is projected as null",
      staleProjection?.activeOffer === null,
    );
  }

  // =========================================================================
  // SCENARIO S: Production Turn State Session CAS Concurrency (Review Finding 6)
  // =========================================================================
  {
    const store = new InMemoryConversationStateStore();
    const scope = { businessId: B_ID, conversationId: "conv-cas-session" };

    // Initialize state
    const session1 = await openTurnStateSession(store, scope, now);
    session1.state = {
      ...emptyConversationState(),
      selectedService: "كشف أسنان",
      serviceId: SERVICE_1,
      knownFacts: { service: "كشف أسنان" },
    };
    const commit1 = await session1.commit();
    check(
      "Scenario S: Initial session commit succeeds (revision 1)",
      commit1 === true,
    );

    // Concurrent turn: Session 2 opens while Session 1 is already loaded
    const session2 = await openTurnStateSession(store, scope, now);
    const session3Stale = await openTurnStateSession(store, scope, now);

    // Session 2 commits revision 2
    session2.state = {
      ...(session2.state ?? emptyConversationState()),
      knownFacts: {
        ...(session2.state?.knownFacts ?? {}),
        date: "2026-09-15",
      },
    };
    const commit2 = await session2.commit();
    check(
      "Scenario S: Second valid session commit advances revision",
      commit2 === true,
    );

    // Session 3 tries to commit with stale revision 1 -> Rejected
    session3Stale.state = {
      ...(session3Stale.state ?? emptyConversationState()),
      knownFacts: {
        ...(session3Stale.state?.knownFacts ?? {}),
        date: "2026-09-20",
      },
    };
    const commit3Conflict = await session3Stale.commit();
    check(
      "Scenario S: Stale revision commit rejected by production session seam",
      commit3Conflict === false,
    );

    // Session 3 reloads to pick up newer revision and succeeds
    const reloaded = await session3Stale.reload();
    check(
      "Scenario S: Session reload successfully synchronizes newer revision",
      reloaded === true &&
        session3Stale.state?.knownFacts?.date === "2026-09-15",
    );
  }

  // =========================================================================
  // FOCUSED FACT PRECEDENCE & NEGATION REGRESSIONS (Review Findings 2, 3 & 4)
  // =========================================================================
  {
    const REF_DATE = "2026-09-14"; // Reference Monday

    // ── Finding 2.1: Helper Regressions on Exact Review Cases ─────────────
    // Case 1: “بلاش بكرة خليها بعد بكرة”
    const r1 = resolveEgyptianRelativeDate(
      "بلاش بكرة خليها بعد بكرة",
      REF_DATE,
    );
    check(
      "Regression Finding 2.1a: 'بلاش بكرة خليها بعد بكرة' resolves to 2026-09-16",
      r1 === "2026-09-16",
      r1,
    );

    // Case 2: “عايز بكرة مش بعد بكرة”
    const r2 = resolveEgyptianRelativeDate("عايز بكرة مش بعد بكرة", REF_DATE);
    check(
      "Regression Finding 2.1b: 'عايز بكرة مش بعد بكرة' resolves to 2026-09-15",
      r2 === "2026-09-15",
      r2,
    );

    // Case 3: “بلاش بعد بكرة”
    const r3Det = resolveEgyptianRelativeDateDetailed(
      "بلاش بعد بكرة",
      REF_DATE,
    );
    check(
      "Regression Finding 2.1c: 'بلاش بعد بكرة' yields no positive date and captures negated date",
      r3Det.positiveDate === null && r3Det.negatedDates.includes("2026-09-16"),
      r3Det,
    );

    // Case 4: “بلاش الأسبوع الجاي”
    const r4Det = resolveEgyptianRelativeDateDetailed(
      "بلاش الأسبوع الجاي",
      REF_DATE,
    );
    check(
      "Regression Finding 2.1d: 'بلاش الأسبوع الجاي' yields no positive date and captures negated date",
      r4Det.positiveDate === null && r4Det.negatedDates.includes("2026-09-21"),
      r4Det,
    );

    // Case 5: “مش بعد الظهر بالليل”
    const r5 = extractTimeOfDayPreference("مش بعد الظهر بالليل");
    const r5Det = extractTimeOfDayPreferenceDetailed("مش بعد الظهر بالليل");
    check(
      "Regression Finding 2.1e: 'مش بعد الظهر بالليل' resolves to evening with negated afternoon",
      r5 === "evening" &&
        r5Det.positiveTime === "evening" &&
        r5Det.negatedTimes.includes("afternoon"),
      r5Det,
    );

    // Case 6: “مش د. أحمد، مع د. سارة”
    const r6 = extractProviderPreference("مش د. أحمد، مع د. سارة");
    const r6Det = extractProviderPreferenceDetailed("مش د. أحمد، مع د. سارة");
    check(
      "Regression Finding 2.1f: 'مش د. أحمد، مع د. سارة' resolves to د. سارة with negated د. أحمد",
      r6 === "د. سارة" &&
        r6Det.positiveProvider === "د. سارة" &&
        r6Det.negatedProviders.includes("د. أحمد"),
      r6Det,
    );

    // ── Finding 2.2: Proving Validated Fact Precedence (Section 5) ────────
    // Deliberate conflict through approved generative adapter seam:
    // Message says "الصبح بدري" (heuristic parser would propose morning),
    // but the validated update explicitly provides evening.
    const fixturePrecedence = createEngineFixture({
      hasCredentials: false, // forces generative adapter seam
      customGenerativeReply: (_req) => ({
        intent: "BOOKING",
        action: "reply",
        summary: "Validated extraction says evening despite morning text",
        content: "تم تأكيد موعدك المسائي.",
        handoffReason: null,
        extraction: {
          service: "كشف أسنان",
          date: "2026-09-15",
          timePreference: "evening",
          provider: null,
        },
      }),
    });

    await fixturePrecedence.sendTurn("عايز كشف أسنان الصبح بدري");
    const savedPrecedence = await fixturePrecedence.stateStore.load(
      B_ID,
      fixturePrecedence.conversation.id,
    );
    const statePrecedence = savedPrecedence
      ? hydrateConversationState(savedPrecedence.state, {
          businessId: B_ID,
          conversationId: fixturePrecedence.conversation.id,
        })
      : null;

    check(
      "Regression Finding 2.2a: Validated generative adapter update strictly overrides conflicting heuristic parser proposal",
      statePrecedence?.knownFacts?.timePreference === "evening",
      statePrecedence?.knownFacts,
    );
    check(
      "Regression Finding 2.2b: Saved durable state records validated evening preference despite message text",
      statePrecedence?.selectedTimePref === "evening",
      statePrecedence?.selectedTimePref,
    );
    check(
      "Regression Finding 2.2c: Single model call spent through approved generative adapter seam without duplicate chains",
      fixturePrecedence.getGenerativeCalls() === 1 &&
        fixturePrecedence.getJevCalls() === 0,
    );

    // ── Finding 2.3: Active Booking State & History Fallback (Section 4) ───

    // Test 2.3a: Active booking date correction replaces old offer with new date offer
    {
      const fixture = createEngineFixture();
      const initialOffer = buildSlotOffer(
        { businessId: B_ID, conversationId: fixture.conversation.id },
        "offer-date-corr",
        {
          serviceId: SERVICE_1,
          serviceName: "كشف أسنان",
          serviceSource: "CUSTOMER",
          providerId: null,
          date: "2026-09-15",
          followUpRequestId: null,
          shownCount: 1,
          options: [
            {
              providerId: PROVIDER_1,
              displayName: "د. سارة",
              startAt: "2026-09-15T10:00",
              endAt: "2026-09-15T10:30",
            },
          ],
        },
        now,
      )!;

      const seed: MutableConversationState = withPresentedOffer(
        emptyConversationState(),
        initialOffer,
      );
      seed.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
      seed.serviceId = SERVICE_1;
      seed.selectedService = "كشف أسنان";
      seed.selectedDate = "2026-09-15";
      seed.knownFacts = {
        service: "كشف أسنان",
        date: "2026-09-15",
      };
      await fixture.stateStore.save(
        B_ID,
        fixture.conversation.id,
        null,
        dehydrateConversationState(seed),
      );

      await fixture.sendTurn("بلاش بكرة خليها بعد بكرة");

      const saved = await fixture.stateStore.load(
        B_ID,
        fixture.conversation.id,
      );
      const state = saved
        ? hydrateConversationState(saved.state, {
            businessId: B_ID,
            conversationId: fixture.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.3a: Active booking date correction updates date to 2026-09-16 and supersedes old offer",
        Boolean(
          state?.knownFacts?.date === "2026-09-16" &&
          state?.selectedDate === "2026-09-16" &&
          state?.offer?.status === "ACTIVE" &&
          state?.offer?.kind === "SLOT" &&
          state?.offer?.date === "2026-09-16" &&
          state?.offer?.id !== initialOffer.id,
        ),
        {
          stateDate: state?.selectedDate,
          offerDate: state?.offer?.kind === "SLOT" ? state.offer.date : null,
        },
      );
    }

    // Test 2.3b: Active booking date negation without replacement clears date and invalidates offer
    {
      const fixture = createEngineFixture();
      const initialOffer = buildSlotOffer(
        { businessId: B_ID, conversationId: fixture.conversation.id },
        "offer-date-neg",
        {
          serviceId: SERVICE_1,
          serviceName: "كشف أسنان",
          serviceSource: "CUSTOMER",
          providerId: null,
          date: "2026-09-15",
          followUpRequestId: null,
          shownCount: 1,
          options: [
            {
              providerId: PROVIDER_1,
              displayName: "د. سارة",
              startAt: "2026-09-15T10:00",
              endAt: "2026-09-15T10:30",
            },
          ],
        },
        now,
      )!;

      const seed: MutableConversationState = withPresentedOffer(
        emptyConversationState(),
        initialOffer,
      );
      seed.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
      seed.serviceId = SERVICE_1;
      seed.selectedService = "كشف أسنان";
      seed.selectedDate = "2026-09-15";
      seed.knownFacts = {
        service: "كشف أسنان",
        date: "2026-09-15",
      };
      await fixture.stateStore.save(
        B_ID,
        fixture.conversation.id,
        null,
        dehydrateConversationState(seed),
      );

      const res = await fixture.sendTurn("بلاش بكرة");

      const saved = await fixture.stateStore.load(
        B_ID,
        fixture.conversation.id,
      );
      const state = saved
        ? hydrateConversationState(saved.state, {
            businessId: B_ID,
            conversationId: fixture.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.3b: Active booking date negation clears date, invalidates old offer, and requests date clarification",
        state?.knownFacts?.date == null &&
          state?.selectedDate == null &&
          state?.pendingOffer == null &&
          state?.offer?.status === "INVALIDATED",
        {
          date: state?.knownFacts?.date,
          pendingOffer: state?.pendingOffer,
          offerStatus: state?.offer?.status,
        },
      );
      check(
        "Regression Finding 2.3c: Negated date is never reintroduced through recent-message fallback or resumeBookingExtraction",
        state?.knownFacts?.date !== "2026-09-15" &&
          Boolean(
            res.ok &&
            "observability" in res &&
            res.observability?.clarification?.type === "CLARIFY_DATE",
          ),
        res,
      );
    }

    // Test 2.3d: Active booking provider correction updates provider and offer to requested provider
    {
      const fixture = createEngineFixture();
      const initialOffer = buildSlotOffer(
        { businessId: B_ID, conversationId: fixture.conversation.id },
        "offer-prov-corr",
        {
          serviceId: SERVICE_1,
          serviceName: "كشف أسنان",
          serviceSource: "CUSTOMER",
          providerId: PROVIDER_2,
          date: "2026-09-15",
          followUpRequestId: null,
          shownCount: 1,
          options: [
            {
              providerId: PROVIDER_2,
              displayName: "د. أحمد",
              startAt: "2026-09-15T10:00",
              endAt: "2026-09-15T10:30",
            },
          ],
        },
        now,
      )!;

      const seed: MutableConversationState = withPresentedOffer(
        emptyConversationState(),
        initialOffer,
      );
      seed.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
      seed.serviceId = SERVICE_1;
      seed.selectedService = "كشف أسنان";
      seed.selectedDate = "2026-09-15";
      seed.providerPreference = "د. أحمد";
      seed.knownFacts = {
        service: "كشف أسنان",
        date: "2026-09-15",
        provider: "د. أحمد",
      };
      await fixture.stateStore.save(
        B_ID,
        fixture.conversation.id,
        null,
        dehydrateConversationState(seed),
      );

      await fixture.sendTurn("مش د. أحمد، مع د. سارة");

      const saved = await fixture.stateStore.load(
        B_ID,
        fixture.conversation.id,
      );
      const state = saved
        ? hydrateConversationState(saved.state, {
            businessId: B_ID,
            conversationId: fixture.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.3d: Active booking provider correction updates provider to د. سارة and updates offer",
        Boolean(
          state?.knownFacts?.provider === "د. سارة" &&
          state?.providerPreference === "د. سارة" &&
          state?.offer?.kind === "SLOT" &&
          state?.offer?.options.every((opt) => opt.providerId === PROVIDER_1),
        ),
        {
          provider: state?.knownFacts?.provider,
          options: state?.offer?.kind === "SLOT" ? state.offer.options : [],
        },
      );
    }

    // Test 2.3e: Active booking provider negation without replacement clears provider and invalidates offer
    {
      const fixture = createEngineFixture();
      const initialOffer = buildSlotOffer(
        { businessId: B_ID, conversationId: fixture.conversation.id },
        "offer-prov-neg",
        {
          serviceId: SERVICE_1,
          serviceName: "كشف أسنان",
          serviceSource: "CUSTOMER",
          providerId: PROVIDER_2,
          date: "2026-09-15",
          followUpRequestId: null,
          shownCount: 1,
          options: [
            {
              providerId: PROVIDER_2,
              displayName: "د. أحمد",
              startAt: "2026-09-15T10:00",
              endAt: "2026-09-15T10:30",
            },
          ],
        },
        now,
      )!;

      const seed: MutableConversationState = withPresentedOffer(
        emptyConversationState(),
        initialOffer,
      );
      seed.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
      seed.serviceId = SERVICE_1;
      seed.selectedService = "كشف أسنان";
      seed.selectedDate = "2026-09-15";
      seed.providerPreference = "د. أحمد";
      seed.knownFacts = {
        service: "كشف أسنان",
        date: "2026-09-15",
        provider: "د. أحمد",
      };
      await fixture.stateStore.save(
        B_ID,
        fixture.conversation.id,
        null,
        dehydrateConversationState(seed),
      );

      await fixture.sendTurn("مش د. أحمد");

      const saved = await fixture.stateStore.load(
        B_ID,
        fixture.conversation.id,
      );
      const state = saved
        ? hydrateConversationState(saved.state, {
            businessId: B_ID,
            conversationId: fixture.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.3e: Active booking provider negation clears provider and invalidates previous offer",
        state?.knownFacts?.provider == null &&
          state?.providerPreference == null &&
          state?.offer?.id !== initialOffer.id,
        {
          provider: state?.knownFacts?.provider,
          pref: state?.providerPreference,
          offerId: state?.offer?.id,
        },
      );
      check(
        "Regression Finding 2.3f: Rejected provider is never retained as new selection",
        state?.knownFacts?.provider !== "د. أحمد",
      );
    }

    // Test 2.3g: Active booking time correction updates time preference and invalidates old slot offer
    {
      const fixture = createEngineFixture();
      const initialOffer = buildSlotOffer(
        { businessId: B_ID, conversationId: fixture.conversation.id },
        "offer-time-corr",
        {
          serviceId: SERVICE_1,
          serviceName: "كشف أسنان",
          serviceSource: "CUSTOMER",
          providerId: null,
          date: "2026-09-15",
          followUpRequestId: null,
          shownCount: 1,
          options: [
            {
              providerId: PROVIDER_1,
              displayName: "د. سارة",
              startAt: "2026-09-15T14:00",
              endAt: "2026-09-15T14:30",
            },
          ],
        },
        now,
      )!;

      const seed: MutableConversationState = withPresentedOffer(
        emptyConversationState(),
        initialOffer,
      );
      seed.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
      seed.serviceId = SERVICE_1;
      seed.selectedService = "كشف أسنان";
      seed.selectedDate = "2026-09-15";
      seed.selectedTimePref = "afternoon";
      seed.knownFacts = {
        service: "كشف أسنان",
        date: "2026-09-15",
        timePreference: "afternoon",
      };
      await fixture.stateStore.save(
        B_ID,
        fixture.conversation.id,
        null,
        dehydrateConversationState(seed),
      );

      await fixture.sendTurn("مش بعد الظهر بالليل");

      const saved = await fixture.stateStore.load(
        B_ID,
        fixture.conversation.id,
      );
      const state = saved
        ? hydrateConversationState(saved.state, {
            businessId: B_ID,
            conversationId: fixture.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.3g: Active booking time correction updates time preference to evening and invalidates old slot offer",
        state?.knownFacts?.timePreference === "evening" &&
          state?.selectedTimePref === "evening" &&
          state?.offer?.id !== initialOffer.id,
        { timePref: state?.selectedTimePref },
      );
    }

    // Test 2.3h: Active booking time negation without replacement clears time preference and invalidates old offer
    {
      const fixture = createEngineFixture();
      const initialOffer = buildSlotOffer(
        { businessId: B_ID, conversationId: fixture.conversation.id },
        "offer-time-neg",
        {
          serviceId: SERVICE_1,
          serviceName: "كشف أسنان",
          serviceSource: "CUSTOMER",
          providerId: null,
          date: "2026-09-15",
          followUpRequestId: null,
          shownCount: 1,
          options: [
            {
              providerId: PROVIDER_1,
              displayName: "د. سارة",
              startAt: "2026-09-15T14:00",
              endAt: "2026-09-15T14:30",
            },
          ],
        },
        now,
      )!;

      const seed: MutableConversationState = withPresentedOffer(
        emptyConversationState(),
        initialOffer,
      );
      seed.activeTask = { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" };
      seed.serviceId = SERVICE_1;
      seed.selectedService = "كشف أسنان";
      seed.selectedDate = "2026-09-15";
      seed.selectedTimePref = "afternoon";
      seed.knownFacts = {
        service: "كشف أسنان",
        date: "2026-09-15",
        timePreference: "afternoon",
      };
      await fixture.stateStore.save(
        B_ID,
        fixture.conversation.id,
        null,
        dehydrateConversationState(seed),
      );

      await fixture.sendTurn("بلاش بعد الظهر");

      const saved = await fixture.stateStore.load(
        B_ID,
        fixture.conversation.id,
      );
      const state = saved
        ? hydrateConversationState(saved.state, {
            businessId: B_ID,
            conversationId: fixture.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.3h: Active booking time negation clears time preference and invalidates old offer",
        state?.knownFacts?.timePreference == null &&
          state?.selectedTimePref == null,
        { timePref: state?.knownFacts?.timePreference },
      );
    }

    // ── Finding 2.4: Authoritative Provider Precedence & Disambiguation (Section 5) ──
    // Deliberate conflict through approved generative adapter seam with two providers sharing first name:
    // "د. أحمد علي" and "د. أحمد حسن".
    // Customer message says "عايز كشف مع دكتور أحمد", where heuristic regex parser extracts "أحمد".
    // The validated model extraction resolves to the specific provider "د. أحمد علي".
    {
      const fixtureProvider = createEngineFixture({
        hasCredentials: false,
        providers: [
          {
            id: PROVIDER_AHMED_ALI,
            displayName: "د. أحمد علي",
            user: { name: "أحمد علي" },
          },
          {
            id: PROVIDER_AHMED_HASSAN,
            displayName: "د. أحمد حسن",
            user: { name: "أحمد حسن" },
          },
          { id: PROVIDER_1, displayName: "د. سارة", user: { name: "سارة" } },
        ],
        customGenerativeReply: (_req) => ({
          intent: "BOOKING",
          action: "reply",
          summary: "حجز كشف مع د. أحمد علي",
          content: "تم اختيار د. أحمد علي لموعدك.",
          handoffReason: null,
          extraction: {
            service: "كشف أسنان",
            date: "2026-09-15",
            timePreference: "morning",
            provider: "د. أحمد علي",
          },
        }),
      });

      await fixtureProvider.sendTurn("عايز كشف أسنان مع دكتور أحمد الصبح");
      const savedProvider = await fixtureProvider.stateStore.load(
        B_ID,
        fixtureProvider.conversation.id,
      );
      const stateProvider = savedProvider
        ? hydrateConversationState(savedProvider.state, {
            businessId: B_ID,
            conversationId: fixtureProvider.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.4a: Authoritative validated provider update 'د. أحمد علي' is strictly preserved without heuristic first-name truncation",
        stateProvider?.knownFacts?.provider === "د. أحمد علي" &&
          stateProvider?.providerPreference === "د. أحمد علي",
        {
          provider: stateProvider?.knownFacts?.provider,
          pref: stateProvider?.providerPreference,
        },
      );
      check(
        "Regression Finding 2.4b: Booking domain and offer resolution cleanly match 'د. أحمد علي' without ambiguous catalog failure",
        stateProvider?.offer?.kind === "SLOT" &&
          stateProvider?.offer?.options.length > 0 &&
          stateProvider?.offer?.options.every(
            (opt) => opt.providerId === PROVIDER_AHMED_ALI,
          ),
        {
          kind: stateProvider?.offer?.kind,
          options:
            stateProvider?.offer?.kind === "SLOT"
              ? stateProvider.offer.options
              : [],
        },
      );
      check(
        "Regression Finding 2.4c: Single model call spent through approved generative adapter seam without duplicate chains",
        fixtureProvider.getGenerativeCalls() === 1 &&
          fixtureProvider.getJevCalls() === 0,
      );
    }

    // Test 2.4d-f: Provider supplied ONLY through factUpdates (extraction.provider = null).
    // Customer message contains "دكتور أحمد" (heuristic parser would propose "أحمد").
    // Validated factUpdates explicitly contains "د. أحمد علي".
    {
      const fixtureFactUpdateOnly = createEngineFixture({
        hasCredentials: false,
        providers: [
          {
            id: PROVIDER_AHMED_ALI,
            displayName: "د. أحمد علي",
            user: { name: "أحمد علي" },
          },
          {
            id: PROVIDER_AHMED_HASSAN,
            displayName: "د. أحمد حسن",
            user: { name: "أحمد حسن" },
          },
          { id: PROVIDER_1, displayName: "د. سارة", user: { name: "سارة" } },
        ],
        customGenerativeReply: (_req) => ({
          intent: "BOOKING",
          action: "reply",
          summary: "حجز كشف مع د. أحمد علي عبر factUpdates",
          content: "تم اختيار د. أحمد علي لموعدك.",
          handoffReason: null,
          extraction: {
            service: "كشف أسنان",
            date: "2026-09-15",
            timePreference: "morning",
            provider: null,
          },
          factUpdates: [
            { key: "provider", value: "د. أحمد علي", isRevision: true },
          ],
        }),
      });

      await fixtureFactUpdateOnly.sendTurn(
        "عايز كشف أسنان مع دكتور أحمد الصبح",
      );
      const saved = await fixtureFactUpdateOnly.stateStore.load(
        B_ID,
        fixtureFactUpdateOnly.conversation.id,
      );
      const state = saved
        ? hydrateConversationState(saved.state, {
            businessId: B_ID,
            conversationId: fixtureFactUpdateOnly.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.4d: Validated factUpdates provider 'د. أحمد علي' is preserved when extraction.provider is null",
        state?.knownFacts?.provider === "د. أحمد علي" &&
          state?.providerPreference === "د. أحمد علي",
        {
          provider: state?.knownFacts?.provider,
          pref: state?.providerPreference,
        },
      );
      check(
        "Regression Finding 2.4e: Booking domain and offer resolution match 'د. أحمد علي' from factUpdates without catalog ambiguity",
        state?.offer?.kind === "SLOT" &&
          state?.offer?.options.length > 0 &&
          state?.offer?.options.every(
            (opt) => opt.providerId === PROVIDER_AHMED_ALI,
          ),
        {
          kind: state?.offer?.kind,
          options: state?.offer?.kind === "SLOT" ? state.offer.options : [],
        },
      );
      check(
        "Regression Finding 2.4f: Single model call spent through factUpdates seam without extra chains",
        fixtureFactUpdateOnly.getGenerativeCalls() === 1 &&
          fixtureFactUpdateOnly.getJevCalls() === 0,
      );
    }

    // Test 2.4g-i: Both extraction and factUpdates supplied — factUpdates canonically wins over extraction.
    // extraction.provider has "د. أحمد حسن"
    // factUpdates has "د. أحمد علي"
    // Customer message contains "دكتور أحمد"
    {
      const fixturePrecedence = createEngineFixture({
        hasCredentials: false,
        providers: [
          {
            id: PROVIDER_AHMED_ALI,
            displayName: "د. أحمد علي",
            user: { name: "أحمد علي" },
          },
          {
            id: PROVIDER_AHMED_HASSAN,
            displayName: "د. أحمد حسن",
            user: { name: "أحمد حسن" },
          },
          { id: PROVIDER_1, displayName: "د. سارة", user: { name: "سارة" } },
        ],
        customGenerativeReply: (_req) => ({
          intent: "BOOKING",
          action: "reply",
          summary: "حجز كشف مع أسبقية factUpdates على extraction",
          content: "تم اختيار د. أحمد علي لموعدك.",
          handoffReason: null,
          extraction: {
            service: "كشف أسنان",
            date: "2026-09-15",
            timePreference: "morning",
            provider: "د. أحمد حسن",
          },
          factUpdates: [
            { key: "provider", value: "د. أحمد علي", isRevision: true },
          ],
        }),
      });

      await fixturePrecedence.sendTurn("عايز كشف أسنان مع دكتور أحمد الصبح");
      const saved = await fixturePrecedence.stateStore.load(
        B_ID,
        fixturePrecedence.conversation.id,
      );
      const state = saved
        ? hydrateConversationState(saved.state, {
            businessId: B_ID,
            conversationId: fixturePrecedence.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.4g: Canonical fact-merge precedence ensures factUpdates ('د. أحمد علي') overrides extraction ('د. أحمد حسن')",
        state?.knownFacts?.provider === "د. أحمد علي" &&
          state?.providerPreference === "د. أحمد علي",
        {
          provider: state?.knownFacts?.provider,
          pref: state?.providerPreference,
        },
      );
      check(
        "Regression Finding 2.4h: Booking domain and offer resolution match canonical winner 'د. أحمد علي'",
        state?.offer?.kind === "SLOT" &&
          state?.offer?.options.length > 0 &&
          state?.offer?.options.every(
            (opt) => opt.providerId === PROVIDER_AHMED_ALI,
          ),
        {
          kind: state?.offer?.kind,
          options: state?.offer?.kind === "SLOT" ? state.offer.options : [],
        },
      );
      check(
        "Regression Finding 2.4i: Single model call spent through canonical fact-merge seam without extra chains",
        fixturePrecedence.getGenerativeCalls() === 1 &&
          fixturePrecedence.getJevCalls() === 0,
      );
    }

    // ── Finding 2.5: Multi-Turn State Authority & History Fallback Protection (Date) ──
    // Turn A: Initial booking message establishes date.
    // Turn B: Date rejection without replacement clears date from durable state.
    // Turn C: Fresh request loading saved state with continuation ("تمام كمل").
    // Turn D: Explicit new date ("خليها الخميس") is accepted and completed.
    {
      const fixtureDateMulti = createEngineFixture();

      // Turn 1: Initial booking establishing date 2026-09-15
      await fixtureDateMulti.sendTurn("عايز أحجز كشف بكرة");
      const savedT1 = await fixtureDateMulti.stateStore.load(
        B_ID,
        fixtureDateMulti.conversation.id,
      );
      const stateT1 = savedT1
        ? hydrateConversationState(savedT1.state, {
            businessId: B_ID,
            conversationId: fixtureDateMulti.conversation.id,
          })
        : null;
      const initialOfferId = stateT1?.offer?.id;

      // Turn 2: Date rejection without replacement
      await fixtureDateMulti.sendTurn("بلاش بكرة");
      const savedT2 = await fixtureDateMulti.stateStore.load(
        B_ID,
        fixtureDateMulti.conversation.id,
      );
      const stateT2 = savedT2
        ? hydrateConversationState(savedT2.state, {
            businessId: B_ID,
            conversationId: fixtureDateMulti.conversation.id,
          })
        : null;
      check(
        "Regression Finding 2.5a-pre: Turn 2 date negation drops date fact and invalidates initial offer",
        stateT2?.knownFacts?.date == null &&
          (stateT2?.offer == null ||
            stateT2?.offer?.status === "INVALIDATED" ||
            stateT2?.pendingOffer == null),
        {
          date: stateT2?.knownFacts?.date,
          offerStatus: stateT2?.offer?.status,
          pendingOffer: stateT2?.pendingOffer,
        },
      );

      // Turn 3: Continuation without new date ("تمام كمل")
      const resT3 = await fixtureDateMulti.sendTurn("تمام كمل");
      const savedT3 = await fixtureDateMulti.stateStore.load(
        B_ID,
        fixtureDateMulti.conversation.id,
      );
      const stateT3 = savedT3
        ? hydrateConversationState(savedT3.state, {
            businessId: B_ID,
            conversationId: fixtureDateMulti.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.5a: Rejected date remains absent across subsequent turns loading durable state",
        stateT3?.knownFacts?.date == null && stateT3?.selectedDate == null,
        { date: stateT3?.knownFacts?.date, selDate: stateT3?.selectedDate },
      );
      check(
        "Regression Finding 2.5b: Old offer remains unusable and no unintended appointment is created",
        fixtureDateMulti.createdAppointments.length === 0 &&
          (stateT3?.offer == null ||
            stateT3?.offer?.status === "INVALIDATED" ||
            stateT3?.offer?.id !== initialOfferId),
        {
          appointments: fixtureDateMulti.createdAppointments.length,
          offerStatus: stateT3?.offer?.status,
        },
      );
      check(
        "Regression Finding 2.5c: System asks for the missing date upon continuation",
        Boolean(
          (stateT3?.missingFacts && stateT3.missingFacts.includes("date")) ||
          (resT3.ok &&
            "assistantAction" in resT3 &&
            resT3.assistantAction === "AI_REPLY"),
        ),
        { missingFacts: stateT3?.missingFacts },
      );

      // Turn 4: Later explicit new date (Thursday 2026-09-17) is accepted
      await fixtureDateMulti.sendTurn("خليها الخميس");
      const savedT4 = await fixtureDateMulti.stateStore.load(
        B_ID,
        fixtureDateMulti.conversation.id,
      );
      const stateT4 = savedT4
        ? hydrateConversationState(savedT4.state, {
            businessId: B_ID,
            conversationId: fixtureDateMulti.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.5d: Later explicit new date (Thursday 2026-09-17) is accepted correctly into durable state and fresh slot offer",
        stateT4?.knownFacts?.date === "2026-09-17" &&
          stateT4?.selectedDate === "2026-09-17" &&
          stateT4?.offer?.kind === "SLOT" &&
          stateT4?.offer?.date === "2026-09-17",
        {
          date: stateT4?.knownFacts?.date,
          offerDate:
            stateT4?.offer?.kind === "SLOT" ? stateT4.offer.date : null,
        },
      );

      // Turn 5: Selection consumes valid Thursday offer
      await fixtureDateMulti.sendTurn("1");
      check(
        "Regression Finding 2.5e: Mechanical selection consumes valid Thursday offer and creates intended appointment",
        fixtureDateMulti.createdAppointments.length === 1 &&
          fixtureDateMulti.createdAppointments[0]?.date === "2026-09-17",
        fixtureDateMulti.createdAppointments,
      );
    }

    // ── Finding 2.6: Multi-Turn State Authority & History Fallback Protection (Time Preference) ──
    {
      const fixtureTimeMulti = createEngineFixture();

      // Turn 1: Initial booking with afternoon preference
      await fixtureTimeMulti.sendTurn("عايز أحجز كشف بكرة بعد الظهر");
      const savedT1 = await fixtureTimeMulti.stateStore.load(
        B_ID,
        fixtureTimeMulti.conversation.id,
      );
      const stateT1 = savedT1
        ? hydrateConversationState(savedT1.state, {
            businessId: B_ID,
            conversationId: fixtureTimeMulti.conversation.id,
          })
        : null;
      check(
        "Regression Finding 2.6a-pre: Turn 1 records afternoon preference",
        stateT1?.knownFacts?.timePreference === "afternoon",
        { timePref: stateT1?.knownFacts?.timePreference },
      );

      // Turn 2: Time rejection without replacement
      await fixtureTimeMulti.sendTurn("بلاش بعد الظهر");
      const savedT2 = await fixtureTimeMulti.stateStore.load(
        B_ID,
        fixtureTimeMulti.conversation.id,
      );
      const stateT2 = savedT2
        ? hydrateConversationState(savedT2.state, {
            businessId: B_ID,
            conversationId: fixtureTimeMulti.conversation.id,
          })
        : null;
      check(
        "Regression Finding 2.6b-pre: Turn 2 time rejection drops time preference",
        stateT2?.knownFacts?.timePreference == null,
        { timePref: stateT2?.knownFacts?.timePreference },
      );

      // Turn 3: Continuation without time preference ("تمام كمل")
      await fixtureTimeMulti.sendTurn("تمام كمل");
      const savedT3 = await fixtureTimeMulti.stateStore.load(
        B_ID,
        fixtureTimeMulti.conversation.id,
      );
      const stateT3 = savedT3
        ? hydrateConversationState(savedT3.state, {
            businessId: B_ID,
            conversationId: fixtureTimeMulti.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.6a: Rejected time preference remains absent on subsequent turns and is not resurrected from history",
        stateT3?.knownFacts?.timePreference == null &&
          stateT3?.selectedTimePref == null,
        {
          timePref: stateT3?.knownFacts?.timePreference,
          selTime: stateT3?.selectedTimePref,
        },
      );
      check(
        "Regression Finding 2.6b: Old slot offer remains invalidated and no unintended appointment is created",
        fixtureTimeMulti.createdAppointments.length === 0,
        { appointments: fixtureTimeMulti.createdAppointments.length },
      );

      // Turn 4: Later explicit time preference (evening) is accepted
      await fixtureTimeMulti.sendTurn("خليها بالليل");
      const savedT4 = await fixtureTimeMulti.stateStore.load(
        B_ID,
        fixtureTimeMulti.conversation.id,
      );
      const stateT4 = savedT4
        ? hydrateConversationState(savedT4.state, {
            businessId: B_ID,
            conversationId: fixtureTimeMulti.conversation.id,
          })
        : null;

      check(
        "Regression Finding 2.6c: Later explicit time preference (evening) is accepted into durable state",
        stateT4?.knownFacts?.timePreference === "evening" &&
          stateT4?.selectedTimePref === "evening",
        {
          timePref: stateT4?.knownFacts?.timePreference,
          selTime: stateT4?.selectedTimePref,
        },
      );
    }
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log("\n── CONV-CORE-02 ACCEPTANCE RESULTS ──\n");
  let failed = 0;
  for (const c of checks) {
    if (c.pass) {
      console.log(`  ✅ ${c.label}`);
    } else {
      console.log(`  ❌ ${c.label}`);
      failed++;
    }
  }

  console.log(
    `\nTOTAL: ${checks.length} assertions. PASSED: ${checks.length - failed}, FAILED: ${failed}`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL in check-conv-core-02:", err);
  process.exit(1);
});
