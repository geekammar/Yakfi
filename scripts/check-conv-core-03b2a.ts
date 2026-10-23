/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — CORE-03B2A Verification Suite
 * Capability-Safe Routing for Free-Form Conversation Turns
 *
 * Verifies all required boundaries & invariants:
 *
 * A. Actual Routing with JEV Configured:
 *  1. Server requirement (requiredSemanticCapability: "structured_turn") survives request assembly
 *  2. Zero JEV HTTP attempts on free-form turns requiring structured_turn
 *  3. Generative request is captured with complete customer message unchanged
 *  4. Temporal context and conversation state are present in generative request
 *  5. Egyptian Arabic free-text fixtures:
 *     - setting/correcting a provider ("عايز دكتور أحمد مش دكتورة سارة")
 *     - removing provider/time preference ("مش فارق معايا أي دكتور ومش مهم الصبح")
 *     - changing a date ("عايز أغير الميعاد لـ 2026-10-25")
 *     - knowledge question plus booking ("بكام الكشف وعايز أحجز بكرة؟")
 *     - mixed numeric prose ("٢ بس غير اليوم")
 *     - social free text previously on lexical bypass ("السلام عليكم ورحمة الله وبركاته، محتاج مساعدة بخصوص الحجز")
 *     - catalog inquiry previously on lexical bypass ("إيه الخدمات اللي عندكم للأسنان؟")
 *
 * B. Mechanical Paths (Zero-Model Guarantees):
 *  6. Valid numeric choice from active offer executes with exactly 0 model calls
 *  7. Valid offer-bound callback (fp:<token>:1) executes with exactly 0 model calls
 *  8. Stale / unknown offer callback token is rejected safely without model calls (lifecycle coverage noted)
 *  9. Mixed sentence ("٢ بس غير اليوم") is not reduced to its numeric prefix
 *  10. Positive controls prove HTTP attempt counters and valid evaluation for both provider paths
 *
 * C. End-to-End State Behavior:
 *  11. Provider REMOVE clears preference, preserves date/service, and establishes active slot offer on 2026-10-25
 *  12. Date correction reaches durable state, dispatches availability query for corrected date, updates active typed slot offer, and rejects replaced old-date offer
 *  13. Conflicting extraction cannot override explicit factUpdates
 *  14. Invalid output causes no guessed appointment and resolves safely to NEED_HUMAN
 *
 * D. Policy and Compatibility:
 *  15. Prohibited/invalid AI policy falls back safely to deterministic assistant (0 calls); positive control reaches generative provider (1 generative, 0 JEV)
 *  16. Staff-assigned conversation preserves human ownership (DEFERRED_TO_STAFF)
 *  17. Requests without the capability: eligible turns execute bounded JEV inference (1 JEV, 0 LLM); greeting turns preserve 0-call bypass
 *  18. No second model chain: exactly 1 generative provider attempt and 0 JEV on measured fixture
 *
 * E. Wire & Contract Invariants:
 *  19. requiredSemanticCapabilitySchema validates "structured_turn" and rejects invalid values
 *  20. parseAiRequest preserves requiredSemanticCapability
 *  21. buildPromptMessages does not leak internal routing metadata to the model
 *  (Informational capability boundary note distinguishes offline mock evidence from live model accuracy)
 *
 * Run: pnpm check:conv-core-03b2a
 */

import {
  parseAiRequest,
  requiredSemanticCapabilitySchema,
  type AiRequest,
  type AiResponse,
} from "../src/features/conversations/server/ai-contract";
import { buildSlotOffer } from "../src/features/conversations/server/booking-offer";
import { parseBookingSelection } from "../src/features/conversations/server/booking-selection";
import {
  receiveInboundMessage,
  type ConversationEngineDeps,
} from "../src/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
  withPresentedOffer,
} from "../src/features/conversations/server/conversation-state";
import { createLlmConversationAi } from "../src/server/integrations/ai/conversation-ai";
import { createPolicyBackedAi } from "../src/server/integrations/ai/factory";
import {
  createJevDecisionsProvider,
  type JevDecisionsProvider,
} from "../src/server/integrations/ai/jev-decisions-provider";
import { createSemanticJevStrategy } from "../src/server/integrations/ai/jev-semantic-strategy";
import { createOpenRouterAdapter } from "../src/server/integrations/ai/openrouter";
import { createAiOrchestrator } from "../src/server/integrations/ai/orchestrator";
import { buildPromptMessages } from "../src/server/integrations/ai/prompt";
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
  console.log("── FLOWPILOT CORE-03B2A ACCEPTANCE VERIFICATION SUITE ──\n");

  const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
  const BRANCH_ID = "22222222-2222-4222-8222-222222222221";
  const SERVICE_CLEANING = "33333333-3333-4333-8333-333333333331";
  const SERVICE_EXAM = "33333333-3333-4333-8333-333333333332";
  const PROVIDER_AHMED = "44444444-4444-4444-8444-444444444441";
  const PROVIDER_SARA = "44444444-4444-4444-8444-444444444442";
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
      id: PROVIDER_AHMED,
      businessId: BUSINESS_ID,
      displayName: "دكتور أحمد",
      user: { name: "دكتور أحمد" },
    },
    {
      id: PROVIDER_SARA,
      businessId: BUSINESS_ID,
      displayName: "دكتورة سارة",
      user: { name: "دكتورة سارة" },
    },
  ];

  // Captured HTTP requests for both paths
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
      provider: "دكتور أحمد",
      date: "2026-10-25",
      timePreference: null,
    },
    factUpdates: [
      { key: "service", operation: "set", value: "تنظيف أسنان" },
      { key: "provider", operation: "set", value: "دكتور أحمد" },
      { key: "date", operation: "set", value: "2026-10-25" },
    ],
  };

  let generativeShouldFailWithInvalid = false;

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

    const questions = body.questions ?? {};
    const answers: Record<string, any> = {};
    for (const [key, q] of Object.entries<any>(questions)) {
      if (q.type === "choice") {
        const choice =
          key === "conversationGoal"
            ? "booking"
            : (Object.keys(q.criteria ?? {})[0] ?? "default");
        answers[key] = {
          type: "choice",
          choice,
          confidence: null,
          probabilities: { [choice]: 1.0 },
        };
      } else {
        // noul
        let noul = 0.05;
        if (key === "bookingRequested") noul = 0.95;
        else if (key === "providerPreferenceExpressed") noul = 0.05;
        else if (key === "sensitiveTurn") noul = 0.01;
        else if (key === "supportRequested") noul = 0.05;
        else if (key === "greetingOnly") noul = 0.01;
        else if (key === "ambiguousTurn") noul = 0.05;
        answers[key] = { type: "noul", noul };
      }
    }

    return new Response(
      JSON.stringify({
        id: `mock-jev-dec-${capturedJevRequests.length}`,
        model: "typesafe/jev-1.13",
        answers,
        usage: {
          input_tokens: 180,
          output_tokens: 30,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const unifiedFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    if (url.includes("/decisions")) {
      return mockJevFetch(input, init);
    }
    return mockGenerativeFetch(input, init);
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

    if (generativeShouldFailWithInvalid) {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "this is not structured json at all",
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        id: "mock-generative-turn",
        model: "mock-openrouter-model",
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify({
                safetyAssessment: "safe",
                ...currentGenerativeResponse,
              }),
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

  const capturedEngineRequests: AiRequest[] = [];

  const realAi = createLlmConversationAi({
    primary: generativeAdapter,
    secondary: null,
    fallbackEnabled: false,
    decisionStrategy: jevStrategy,
  });

  const wrappingAi = {
    providerName: realAi.providerName,
    async respond(request: AiRequest): Promise<AiResponse> {
      capturedEngineRequests.push(request);
      return realAi.respond(request);
    },
    getLastTelemetry() {
      return realAi.getLastTelemetry();
    },
  };

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
      claim: async () => ({ status: "claimed" as const, claimId: "claim-1" }),
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
          userId: `user-${p.id}`,
          assignedUserId: `user-${p.id}`,
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
        return [];
      },
    } as any,
    conversationStateRepository: stateStore as any,
    ai: wrappingAi as any,
    transport: {
      providerName: "test-transport",
      send: async () => ({ provider: "test-transport", delivered: true }),
    } as any,
  };

  let turnIndex = 0;
  async function runTurn(
    text: string,
    customDeps?: Partial<ConversationEngineDeps>,
  ) {
    turnIndex++;
    const now = new Date(
      Date.UTC(2026, 9, 21, 10, Math.floor(turnIndex / 60), turnIndex % 60),
    );
    return receiveInboundMessage(
      { ...baseDeps, ...(customDeps ?? {}) },
      {
        to: "+201000000000",
        from: "+201111111111",
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

  // =========================================================================
  // SECTION E: Contract & Wire Serialization Invariants
  // =========================================================================
  console.log("E. Wire & Contract Invariants...");

  check(
    "E19a. requiredSemanticCapabilitySchema validates 'structured_turn'",
    requiredSemanticCapabilitySchema.safeParse("structured_turn").success,
  );
  check(
    "E19b. requiredSemanticCapabilitySchema rejects invalid values",
    !requiredSemanticCapabilitySchema.safeParse("arbitrary_intent").success,
  );

  const parsedValidReq = parseAiRequest({
    message: "مرحبا",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "عيادة د. حسام",
    services: [],
    faqs: [],
    requiredSemanticCapability: "structured_turn",
  });
  check(
    "E20. parseAiRequest preserves requiredSemanticCapability",
    parsedValidReq !== null &&
      parsedValidReq.requiredSemanticCapability === "structured_turn",
  );

  const renderedMessages = buildPromptMessages({
    message: "أنا عايز أحجز",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "عيادة د. حسام",
    services: [],
    faqs: [],
    requiredSemanticCapability: "structured_turn",
  });
  const wireUserContent =
    renderedMessages.find((m) => m.role === "user")?.content ?? "";
  check(
    "E21. buildPromptMessages does not leak internal routing metadata to the model",
    !wireUserContent.includes("requiredSemanticCapability") &&
      !wireUserContent.includes("structured_turn"),
  );

  console.log(
    "  ℹ️  Evidence limitation note: offline mock evidence validates contract/routing boundaries, distinguished from live model accuracy.",
  );

  // =========================================================================
  // SECTION B: Mechanical Paths & Positive Controls
  // =========================================================================
  console.log("B. Mechanical Paths & Zero-Model Guarantees...");

  // Positive control 1: direct call to JEV decisions provider increments JEV HTTP calls and returns valid evaluation
  const jevHttpBefore = capturedJevRequests.length;
  const jevEvalResult = await jevProvider.evaluate({
    state: {
      customerMessage: "test prompt",
      businessName: "test business",
      services: [],
      faqs: [],
      languageHint: "ar",
    },
    questions: {
      bookingRequested: {
        type: "noul",
        instructions: "test instructions",
      },
    },
  });
  check(
    "B10a. Positive control: direct JEV call increments JEV HTTP counter and returns valid successful evaluation",
    capturedJevRequests.length === jevHttpBefore + 1 &&
      jevEvalResult.ok === true &&
      jevEvalResult.errorCode === null &&
      jevEvalResult.answers.bookingRequested?.type === "noul" &&
      jevEvalResult.answers.bookingRequested.noul === 0.95,
  );

  // Positive control 2: direct call to generative adapter increments Generative HTTP calls
  const genHttpBefore = capturedGenerativeRequests.length;
  await generativeAdapter.call({
    message: "test generative",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "test business",
    services: [],
    faqs: [],
  });
  check(
    "B10b. Positive control: direct generative call increments Generative HTTP counter",
    capturedGenerativeRequests.length === genHttpBefore + 1,
  );

  // Set up an active slot offer in conversation state for mechanical selection assertions
  const slotOffer = buildSlotOffer(
    { businessId: BUSINESS_ID, conversationId: "conv-1" },
    "offer-token-active-123",
    {
      serviceId: SERVICE_CLEANING,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      providerId: PROVIDER_AHMED,
      date: "2026-10-25",
      followUpRequestId: null,
      shownCount: 2,
      options: [
        {
          providerId: PROVIDER_AHMED,
          displayName: "دكتور أحمد",
          startAt: "2026-10-25T10:00",
          endAt: "2026-10-25T10:30",
        },
        {
          providerId: PROVIDER_AHMED,
          displayName: "دكتور أحمد",
          startAt: "2026-10-25T11:00",
          endAt: "2026-10-25T11:30",
        },
      ],
    },
    new Date("2026-10-21T10:00:00.000Z"),
  );

  await stateStore.save(
    BUSINESS_ID,
    "conv-1",
    null,
    dehydrateConversationState(
      withPresentedOffer(emptyConversationState(), slotOffer!),
    ),
  );

  // Mechanical selection 1: Arabic numeral '١'
  const genCallsBeforeNum = capturedGenerativeRequests.length;
  const jevCallsBeforeNum = capturedJevRequests.length;
  const numSelectRes = await runTurn("١");
  check(
    "B6a. Mechanical Arabic numeral '١' resolves without error",
    numSelectRes.ok === true &&
      "assistantAction" in numSelectRes &&
      numSelectRes.assistantAction === "AI_REPLY",
  );
  check(
    "B6b. Mechanical selection '١' executes with EXACTLY ZERO model HTTP attempts",
    capturedGenerativeRequests.length === genCallsBeforeNum &&
      capturedJevRequests.length === jevCallsBeforeNum,
  );

  // Present fresh offer for callback test
  const slotOffer2 = buildSlotOffer(
    { businessId: BUSINESS_ID, conversationId: "conv-1" },
    "offer-token-callback-456",
    {
      serviceId: SERVICE_CLEANING,
      serviceName: "تنظيف أسنان",
      serviceSource: "CUSTOMER",
      providerId: PROVIDER_AHMED,
      date: "2026-10-25",
      followUpRequestId: null,
      shownCount: 1,
      options: [
        {
          providerId: PROVIDER_AHMED,
          displayName: "دكتور أحمد",
          startAt: "2026-10-25T14:00",
          endAt: "2026-10-25T14:30",
        },
      ],
    },
    new Date("2026-10-21T10:00:00.000Z"),
  );
  await stateStore.save(
    BUSINESS_ID,
    "conv-1",
    null,
    dehydrateConversationState(
      withPresentedOffer(emptyConversationState(), slotOffer2!),
    ),
  );

  // Mechanical selection 2: Valid offer callback
  const genCallsBeforeCb = capturedGenerativeRequests.length;
  const jevCallsBeforeCb = capturedJevRequests.length;
  const cbSelectRes = await runTurn(`fp:${slotOffer2!.token}:1`);
  check(
    "B7a. Offer callback fp:<token>:1 resolves successfully",
    cbSelectRes.ok === true &&
      "assistantAction" in cbSelectRes &&
      cbSelectRes.assistantAction === "AI_REPLY",
  );
  check(
    "B7b. Offer callback executes with EXACTLY ZERO model HTTP attempts",
    capturedGenerativeRequests.length === genCallsBeforeCb &&
      capturedJevRequests.length === jevCallsBeforeCb,
  );

  // Unknown token offer callback (lifecycle states: expired/consumed/replaced are inherited
  // from check-conv-core-01, check-conv-core-02, and check-booking-offer; replaced offer rejection
  // is additionally verified end-to-end in C12d below)
  const genCallsBeforeStale = capturedGenerativeRequests.length;
  const jevCallsBeforeStale = capturedJevRequests.length;
  const staleRes = await runTurn("fp:unknowntok12:1");
  check(
    "B8a. Stale / unknown offer callback token is rejected safely without model calls",
    staleRes.ok === true &&
      "delivery" in staleRes &&
      staleRes.delivery !== null,
  );
  check(
    "B8b. Stale callback executes with EXACTLY ZERO model HTTP attempts",
    capturedGenerativeRequests.length === genCallsBeforeStale &&
      capturedJevRequests.length === jevCallsBeforeStale,
  );

  // Pure function parseBookingSelection preserves mixed sentences
  check(
    "B9a. parseBookingSelection('٢ بس غير اليوم') returns null",
    parseBookingSelection("٢ بس غير اليوم") === null,
  );
  check(
    "B9b. parseBookingSelection('١') returns index 1",
    parseBookingSelection("١")?.kind === "index",
  );

  // =========================================================================
  // SECTION A: Actual Routing with JEV Configured
  // =========================================================================
  console.log("A. Actual Routing with JEV Configured...");

  // Free-form Egyptian text turn 1: Setting/correcting a provider
  const jevBeforeT1 = capturedJevRequests.length;
  const genBeforeT1 = capturedGenerativeRequests.length;
  capturedEngineRequests.length = 0;

  const t1Res = await runTurn("عايز دكتور أحمد مش دكتورة سارة");
  check("A1a. Free-form turn 1 executed successfully", t1Res.ok === true);
  check(
    "A1b. Server requirement 'structured_turn' survived request assembly",
    capturedEngineRequests[0]?.requiredSemanticCapability === "structured_turn",
  );
  check(
    "A2. EXACTLY ZERO JEV HTTP attempts spent for free-form turn requiring structured_turn",
    capturedJevRequests.length === jevBeforeT1,
  );
  check(
    "A3a. Exactly 1 generative HTTP request was captured",
    capturedGenerativeRequests.length === genBeforeT1 + 1,
  );
  const t1WireBody =
    capturedGenerativeRequests[capturedGenerativeRequests.length - 1]
      ?.rawBody ?? "";
  check(
    "A3b. Complete customer message reaches generative wire unchanged",
    t1WireBody.includes("عايز دكتور أحمد مش دكتورة سارة"),
  );
  check(
    "A4a. Server-derived temporal context is present on generative wire",
    t1WireBody.includes("temporalContext") &&
      t1WireBody.includes("Africa/Cairo"),
  );
  check(
    "A4b. Conversation context projection is present on generative wire",
    t1WireBody.includes("conversationContext"),
  );

  // Free-form Egyptian text turn 2: Removing provider/time preference
  const jevBeforeT2 = capturedJevRequests.length;
  const genBeforeT2 = capturedGenerativeRequests.length;
  await runTurn("مش فارق معايا أي دكتور ومش مهم الصبح");
  check(
    "A5a. Removing provider/time preference: ZERO JEV calls, exactly 1 generative call",
    capturedJevRequests.length === jevBeforeT2 &&
      capturedGenerativeRequests.length === genBeforeT2 + 1,
  );
  const t2Wire =
    capturedGenerativeRequests[capturedGenerativeRequests.length - 1]
      ?.rawBody ?? "";
  check(
    "A5b. Customer message reached generative wire intact",
    t2Wire.includes("مش فارق معايا أي دكتور ومش مهم الصبح"),
  );

  // Free-form Egyptian text turn 3: Changing a date
  const jevBeforeT3 = capturedJevRequests.length;
  const genBeforeT3 = capturedGenerativeRequests.length;
  await runTurn("عايز أغير الميعاد لـ 2026-10-25");
  check(
    "A5c. Changing a date: ZERO JEV calls, exactly 1 generative call",
    capturedJevRequests.length === jevBeforeT3 &&
      capturedGenerativeRequests.length === genBeforeT3 + 1,
  );

  // Free-form Egyptian text turn 4: Knowledge question plus booking
  const jevBeforeT4 = capturedJevRequests.length;
  const genBeforeT4 = capturedGenerativeRequests.length;
  await runTurn("بكام الكشف وعايز أحجز بكرة؟");
  check(
    "A5d. Knowledge question plus booking: ZERO JEV calls, exactly 1 generative call",
    capturedJevRequests.length === jevBeforeT4 &&
      capturedGenerativeRequests.length === genBeforeT4 + 1,
  );

  // Free-form Egyptian text turn 5: Mixed numeric prose ("٢ بس غير اليوم")
  const jevBeforeT5 = capturedJevRequests.length;
  const genBeforeT5 = capturedGenerativeRequests.length;
  await runTurn("٢ بس غير اليوم");
  check(
    "A5e. Mixed numeric prose: ZERO JEV calls, reaches generative provider",
    capturedJevRequests.length === jevBeforeT5 &&
      capturedGenerativeRequests.length === genBeforeT5 + 1,
  );
  const t5Wire =
    capturedGenerativeRequests[capturedGenerativeRequests.length - 1]
      ?.rawBody ?? "";
  check(
    "A5f. Mixed numeric prose arrives intact at generative wire",
    t5Wire.includes("٢ بس غير اليوم"),
  );

  // Free-form Egyptian text turn 6: Social greeting free text previously on lexical bypass
  const jevBeforeT6 = capturedJevRequests.length;
  const genBeforeT6 = capturedGenerativeRequests.length;
  await runTurn("السلام عليكم ورحمة الله وبركاته، محتاج مساعدة بخصوص الحجز");
  check(
    "A5g. Social greeting free text reaches generative assistant (lexical bypass skipped)",
    capturedJevRequests.length === jevBeforeT6 &&
      capturedGenerativeRequests.length === genBeforeT6 + 1,
  );

  // Free-form Egyptian text turn 7: Catalog inquiry previously on lexical bypass
  const jevBeforeT7 = capturedJevRequests.length;
  const genBeforeT7 = capturedGenerativeRequests.length;
  await runTurn("إيه الخدمات اللي عندكم للأسنان؟");
  check(
    "A5h. Catalog inquiry reaches generative assistant (lexical bypass skipped)",
    capturedJevRequests.length === jevBeforeT7 &&
      capturedGenerativeRequests.length === genBeforeT7 + 1,
  );

  // =========================================================================
  // SECTION C: End-to-End State Behavior
  // =========================================================================
  console.log("C. End-to-End State Behavior...");

  // 11. Provider REMOVE clears the preference in saved state
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "تمام، لغيت تفضيل الدكتور وأي دكتور متاح هيكون مناسب.",
    summary: "إلغاء تفضيل الطبيب",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: null,
      date: "2026-10-25",
      timePreference: null,
    },
    factUpdates: [{ key: "provider", operation: "remove" }],
  };

  await runTurn("عايز أحجز بس مش عايز دكتور معين، أي حد متاح");
  const loadedStateAfterRemove = await stateStore.load(BUSINESS_ID, "conv-1");
  const stateAfterRemove = loadedStateAfterRemove?.state as any;
  const factsAfterRemove = stateAfterRemove?.knownFacts ?? {};
  check(
    "C11a. Provider REMOVE clears the preference from durable conversation state",
    factsAfterRemove.provider === undefined,
  );
  check(
    "C11b. Date and service survive provider removal in durable state",
    factsAfterRemove.service === "تنظيف أسنان" &&
      factsAfterRemove.date === "2026-10-25",
  );

  const priorOfferToken = stateAfterRemove?.offer?.token;
  check(
    "C11c. Prior turn established an active slot offer on 2026-10-25",
    typeof priorOfferToken === "string" &&
      stateAfterRemove?.offer?.date === "2026-10-25",
  );

  // 12. Date correction reaches saved state and booking input
  const queriesBeforeCorrection = capturedAvailabilityQueries.length;
  const apptsBeforeCorrection = createdAppointments.length;

  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "تم تعديل التاريخ إلى 2026-10-27، ودي المواعيد المتاحة.",
    summary: "تعديل التاريخ",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: null,
      date: "2026-10-27",
      timePreference: null,
    },
    factUpdates: [{ key: "date", operation: "set", value: "2026-10-27" }],
  };

  await runTurn("خلي الميعاد يوم 27 أكتوبر");
  const loadedStateAfterDate = await stateStore.load(BUSINESS_ID, "conv-1");
  const stateAfterDate = loadedStateAfterDate?.state as any;
  const factsAfterDate = stateAfterDate?.knownFacts ?? {};
  check(
    "C12a. Date correction reaches durable saved state knownFacts",
    factsAfterDate.date === "2026-10-27",
  );

  const latestQuery =
    capturedAvailabilityQueries[capturedAvailabilityQueries.length - 1];
  check(
    "C12b. Exactly one new availability query dispatched for corrected date",
    capturedAvailabilityQueries.length === queriesBeforeCorrection + 1 &&
      latestQuery?.date === "2026-10-27" &&
      latestQuery?.businessId === BUSINESS_ID,
  );

  const correctedOffer = stateAfterDate?.offer;
  check(
    "C12c. Active offer is updated to a typed slot offer on the corrected date with new token",
    correctedOffer?.kind === "SLOT" &&
      correctedOffer?.date === "2026-10-27" &&
      typeof correctedOffer?.token === "string" &&
      correctedOffer.token !== priorOfferToken,
  );

  // Assert no old-date offer remains selectable after the correction
  const oldOfferSelectRes = await runTurn(`fp:${priorOfferToken}:1`);
  check(
    "C12d. Replaced old-date offer is rejected and cannot be selected (no appointment created)",
    oldOfferSelectRes.ok === true &&
      createdAppointments.length === apptsBeforeCorrection,
  );

  // 13. Conflicting extraction cannot override explicit updates
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "تمام، اخترت دكتور أحمد.",
    summary: "تأكيد الطبيب",
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: "دكتورة سارة", // Stale/conflicting extraction
      date: "2026-10-27",
      timePreference: null,
    },
    factUpdates: [
      // Explicit SET with higher precedence
      { key: "provider", operation: "set", value: "دكتور أحمد" },
    ],
  };

  await runTurn("عايز أحجز مع دكتور أحمد");
  const loadedStateAfterConflict = await stateStore.load(BUSINESS_ID, "conv-1");
  const factsAfterConflict =
    (loadedStateAfterConflict?.state as any)?.knownFacts ?? {};
  check(
    "C13. Conflicting extraction ('دكتورة سارة') cannot override explicit factUpdate ('دكتور أحمد')",
    factsAfterConflict.provider === "دكتور أحمد",
  );

  // 14. Invalid output causes no guessed appointment and resolves safely to NEED_HUMAN
  const apptsCountBefore = createdAppointments.length;
  generativeShouldFailWithInvalid = true;

  const invalidTurnRes = await runTurn("أي كلام مش مفهوم خالص");
  generativeShouldFailWithInvalid = false;

  check(
    "C14a. Invalid provider output causes safe handoff to NEED_HUMAN",
    invalidTurnRes.ok === true &&
      "conversationStatus" in invalidTurnRes &&
      invalidTurnRes.conversationStatus === "NEED_HUMAN" &&
      invalidTurnRes.assistantAction === "AI_HANDOFF",
  );
  check(
    "C14b. Invalid provider output creates NO guessed appointment in domain",
    createdAppointments.length === apptsCountBefore,
  );

  // =========================================================================
  // SECTION D: Policy and Compatibility
  // =========================================================================
  console.log("D. Policy and Compatibility...");

  // 15. Actual platform policy-boundary verification
  // 15a. Prohibited/invalid policy falls back safely to deterministic AI
  const genCallsBeforeProhibited = capturedGenerativeRequests.length;
  const jevCallsBeforeProhibited = capturedJevRequests.length;

  const prohibitedPolicyAi = await createPolicyBackedAi({
    getEnvVar: (name) =>
      name === "OPENROUTER_API_KEY" || name === "FLOWPILOT_JEV_API_KEY"
        ? "test-key"
        : undefined,
    fetchImpl: unifiedFetch as any,
    getAiPolicyImpl: async () => ({
      success: false,
      error: {
        code: "INVALID_POLICY",
        message: "تكوين سياسة الذكاء الاصطناعي غير صالح",
      },
    }),
  });

  check(
    "D15a. Prohibited/invalid AI policy resolves to deterministic fallback assistant",
    prohibitedPolicyAi.providerName === "deterministic",
  );

  const prohibitedTurnRes = await runTurn("عايز أحجز كشف", {
    ai: prohibitedPolicyAi,
  });

  check(
    "D15b. Request with requiredSemanticCapability='structured_turn' under prohibited policy spends ZERO generative and ZERO JEV calls",
    prohibitedTurnRes.ok === true &&
      "assistantProvider" in prohibitedTurnRes &&
      prohibitedTurnRes.assistantProvider === "deterministic" &&
      capturedGenerativeRequests.length === genCallsBeforeProhibited &&
      capturedJevRequests.length === jevCallsBeforeProhibited,
  );

  // 15c. Positive control: allowed policy reaches generative provider through same factory harness
  const allowedPolicyAi = await createPolicyBackedAi({
    getEnvVar: (name) =>
      name === "OPENROUTER_API_KEY" || name === "FLOWPILOT_JEV_API_KEY"
        ? "test-key"
        : undefined,
    fetchImpl: unifiedFetch as any,
    getAiPolicyImpl: async () => ({
      success: true,
      data: {
        policy: {
          primaryProvider: "openrouter",
          primaryModel: "mock-openrouter-model",
          secondaryProvider: null,
          secondaryModel: null,
          fallbackEnabled: false,
          primarySecretRef: "OPENROUTER_API_KEY",
          secondarySecretRef: null,
          openRouterProviderOnly: null,
          updatedAt: new Date(),
        },
        effective: {
          primaryProvider: "openrouter",
          primaryModel: "mock-openrouter-model",
          secondary: null,
          openRouterProviderOnly: null,
        },
      },
    }),
  });

  const genCallsBeforeAllowed = capturedGenerativeRequests.length;
  const jevCallsBeforeAllowed = capturedJevRequests.length;

  const allowedTurnRes = await runTurn("عايز أحجز كشف", {
    ai: allowedPolicyAi,
  });

  check(
    "D15c. Positive control: allowed policy reaches configured generative provider (1 generative call, 0 JEV)",
    allowedTurnRes.ok === true &&
      capturedGenerativeRequests.length === genCallsBeforeAllowed + 1 &&
      capturedJevRequests.length === jevCallsBeforeAllowed,
  );

  // 16. Staff-assigned conversation preserves human ownership (DEFERRED_TO_STAFF)
  const staffConversationRepo = {
    ...baseDeps.conversationRepository,
    findById: async () =>
      ({
        id: "conv-1",
        businessId: BUSINESS_ID,
        status: "NEED_HUMAN",
        assignedUserId: "staff-assigned-uuid-1",
      }) as any,
  };
  const genCallsBeforeStaff = capturedGenerativeRequests.length;
  const jevCallsBeforeStaff = capturedJevRequests.length;
  const staffTurnRes = await runTurn("محتاج مساعدة", {
    conversationRepository: staffConversationRepo as any,
  });
  check(
    "D16a. Staff-assigned conversation defers to staff (DEFERRED_TO_STAFF)",
    staffTurnRes.ok === true &&
      "assistantAction" in staffTurnRes &&
      staffTurnRes.assistantAction === "DEFERRED_TO_STAFF",
  );
  check(
    "D16b. Staff-assigned turn executes ZERO model HTTP calls",
    capturedGenerativeRequests.length === genCallsBeforeStaff &&
      capturedJevRequests.length === jevCallsBeforeStaff,
  );

  // 17. Requests without the capability preserve legacy bounded JEV behavior
  // Directly test the orchestrator with JEV configured on a request without requiredSemanticCapability
  const orchestrator = createAiOrchestrator({
    primary: generativeAdapter,
    secondary: null,
    fallbackEnabled: false,
    decisionStrategy: jevStrategy,
  });

  // 17a. Actually eligible legacy turn (no capability requirement, no bypass, no quotable facts)
  const eligibleLegacyRequest: AiRequest = {
    message: "محتاج معاد بكرة",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "عيادة د. حسام",
    services: [], // no prices/descriptions
    faqs: [], // no FAQs
    // requiredSemanticCapability is omitted (legacy caller)
  };

  const genCallsBeforeLegacy = capturedGenerativeRequests.length;
  const jevCallsBeforeLegacy = capturedJevRequests.length;
  const legacyOrchResult = await orchestrator.callWithFallback(
    eligibleLegacyRequest,
  );
  check(
    "D17a. Eligible legacy request without capability executes real bounded JEV inference (1 JEV call, 0 LLM calls)",
    legacyOrchResult.response !== null &&
      legacyOrchResult.telemetry.finalProvider === "jev-deterministic" &&
      legacyOrchResult.telemetry.jevDecision?.mode === "DETERMINISTIC" &&
      legacyOrchResult.telemetry.jevDecision?.semantic?.jevCallSpent === true &&
      capturedJevRequests.length === jevCallsBeforeLegacy + 1 &&
      capturedGenerativeRequests.length === genCallsBeforeLegacy,
  );

  // 17b. Legacy greeting request preserved on deterministic bypass (0 JEV calls, 0 LLM calls)
  const legacyGreetingRequest: AiRequest = {
    message: "السلام عليكم",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "عيادة د. حسام",
    services: [],
    faqs: [],
  };
  const genCallsBeforeGreeting = capturedGenerativeRequests.length;
  const jevCallsBeforeGreeting = capturedJevRequests.length;
  const greetingOrchResult = await orchestrator.callWithFallback(
    legacyGreetingRequest,
  );
  check(
    "D17b. Legacy greeting turn preserves 0-call deterministic bypass (0 JEV calls, 0 LLM calls)",
    greetingOrchResult.response !== null &&
      greetingOrchResult.telemetry.finalProvider === "jev-deterministic" &&
      capturedJevRequests.length === jevCallsBeforeGreeting &&
      capturedGenerativeRequests.length === genCallsBeforeGreeting,
  );

  // 18. No second model chain: exactly 1 generative provider attempt on measured fixture
  const measuredGenerativeCallsBefore = capturedGenerativeRequests.length;
  const measuredJevCallsBefore = capturedJevRequests.length;
  currentGenerativeResponse = {
    intent: "BOOKING",
    action: "reply",
    content: "تمام، أقدر أساعدك في حجز موعد تنظيف.",
    summary: null,
    handoffReason: null,
    extraction: {
      service: "تنظيف أسنان",
      provider: null,
      date: "2026-10-25",
      timePreference: null,
    },
  };
  await runTurn("عايز أحجز تنظيف");
  check(
    "D18. Single model call spent without duplicate chains (exactly 1 generative call, 0 JEV)",
    capturedGenerativeRequests.length === measuredGenerativeCallsBefore + 1 &&
      capturedJevRequests.length === measuredJevCallsBefore,
  );

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log("\n── CORE-03B2A ACCEPTANCE RESULTS ──\n");
  let passCount = 0;
  for (const c of checks) {
    if (c.pass) {
      passCount++;
      console.log(`  ✅ ${c.label}`);
    } else {
      console.log(`  ❌ ${c.label}`);
    }
  }

  console.log(
    `\nTOTAL: ${checks.length} assertions. PASSED: ${passCount}, FAILED: ${checks.length - passCount}`,
  );

  if (passCount !== checks.length) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("FATAL in check:conv-core-03b2a:", err);
  process.exit(1);
});
