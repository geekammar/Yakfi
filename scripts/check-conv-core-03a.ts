/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — CONV-CORE-03A Verification Suite
 * Explicit Semantic Fact Updates & One Reconciliation Path
 *
 * Verifies all 18 Required Scenarios:
 * Contract / pure reconciliation:
 *  1. Legacy SET accepted; explicit SET/REMOVE accepted
 *  2. extraction null does not delete; invalid operations/values rejected
 *  3. REMOVE defeats conflicting extraction
 *  4. Two operations same key: last SET/REMOVE wins in both orders
 *  5. Unknown/unsupported removal cannot clear unrelated facts
 *
 * Engine + controlled provider response:
 *  6. Remove provider: state/mirrors and captured Domain input all have no old preference; service/date survive
 *  7. Remove time preference: no old filter is applied; service/date/provider survive
 *  8. Remove date: state/mirrors clear, offer invalidates, no appointment is created; next step asks for date
 *  9. Set provider with two providers sharing first name: correct full preference reaches Domain through the same reconciliation
 *  10. Reload the saved state and send a continuation without replacement: rejected facts do not revive from historical text
 *  11. Reintroduce a NEW valid SET after deletion: it is accepted normally
 *  12. Valid numeric/button selection still has zero physical model network attempts, including retry/shadow
 *  13. Mixed numeric sentence still reaches semantic processing intact
 *
 * Product / prompt wire:
 *  14. Default-service booking stays automatic; explicit service takes precedence
 *  15. Catalog inquiry preserves state AND actually includes the expected real service names in reply content
 *  16. Through production prompt builder/provider adapter + mocked HTTP, assert the emitted contract supports removal and current context is present
 *  17. Real offer token/nonce canaries inserted into the upstream fixture must NOT appear in the projected model payload
 *  18. Missing/invalid provider output cannot create an appointment by guessing
 *
 * Run: pnpm check:conv-core-03a
 */

import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import type { ConversationEngineDeps } from "@/features/conversations/server/conversation-engine";
import type { ConversationState } from "@/features/conversations/server/conversation-state";
import type { JevAnswer } from "@/server/integrations/ai/jev-decisions-provider";

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

type HttpCall = {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
  rawBody: string;
};

type MockHttpHandler = (call: HttpCall) => {
  status: number;
  body: Record<string, unknown>;
};

function buildDefaultJevAnswers(text: string): Record<string, JevAnswer> {
  const isEmergency =
    text.includes("ألم") ||
    text.includes("طوارئ") ||
    text.includes("تعبان جدا");
  const isHumanReq =
    text.includes("الموظفين ضروري") ||
    text.includes("أكلم حد") ||
    text.includes("حولني لموظف");
  const sensitiveScore = isEmergency ? 0.98 : 0.02;
  const supportScore = isHumanReq ? 0.95 : 0.05;
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

  const { aiFactUpdateSchema } =
    await import("../src/features/conversations/server/ai-contract");
  const { buildSlotOffer } =
    await import("../src/features/conversations/server/booking-offer");
  const { parseBookingSelection, tryParseBookingSelection } =
    await import("../src/features/conversations/server/booking-selection");
  const { receiveInboundMessage } =
    await import("../src/features/conversations/server/conversation-engine");
  const {
    dehydrateConversationState,
    emptyConversationState,
    mergeConversationState,
    projectConversationState,
    withPresentedOffer,
  } = await import("../src/features/conversations/server/conversation-state");
  const { reconcileTurnSemanticFacts } =
    await import("../src/features/conversations/server/semantic-facts");
  const { createAiOrchestrator } =
    await import("../src/server/integrations/ai/orchestrator");
  const { createSemanticJevStrategy } =
    await import("../src/server/integrations/ai/jev-semantic-strategy");
  const { createJevDecisionsProvider, JEV_PINNED_MODEL, JEV_SECRET_REF } =
    await import("../src/server/integrations/ai/jev-decisions-provider");
  const { createOpenRouterAdapter, OPENROUTER_SECRET_REF } =
    await import("../src/server/integrations/ai/openrouter");

  console.log("── FLOWPILOT CONV-CORE-03A VERIFICATION SUITE ──\n");

  // =========================================================================
  // SECTION 1: Contract & Pure Reconciliation (Checks 1 - 5)
  // =========================================================================
  console.log("1. Contract & Pure Reconciliation Invariants...");

  // Check 1: Legacy SET accepted; explicit SET/REMOVE accepted
  {
    const legacySet = aiFactUpdateSchema.safeParse({
      key: "provider",
      value: "د. سارة",
    });
    check("1a. Legacy SET {key, value} parses", legacySet.success);

    const explicitSet = aiFactUpdateSchema.safeParse({
      key: "provider",
      operation: "set",
      value: "د. سارة",
    });
    check(
      "1b. Explicit SET {key, operation: 'set', value} parses",
      explicitSet.success,
    );

    const explicitRemoveProv = aiFactUpdateSchema.safeParse({
      key: "provider",
      operation: "remove",
    });
    check("1c. Explicit REMOVE provider parses", explicitRemoveProv.success);

    const explicitRemoveDate = aiFactUpdateSchema.safeParse({
      key: "date",
      operation: "remove",
    });
    check("1d. Explicit REMOVE date parses", explicitRemoveDate.success);

    const explicitRemoveTime = aiFactUpdateSchema.safeParse({
      key: "timePreference",
      operation: "remove",
    });
    check(
      "1e. Explicit REMOVE timePreference parses",
      explicitRemoveTime.success,
    );
  }

  // Check 2: extraction null does not delete; invalid operations/values rejected
  {
    const extractionNullRec = reconcileTurnSemanticFacts(
      { service: null, provider: null, date: null, timePreference: null },
      [],
    );
    check(
      "2a. extraction null produces zero removals",
      extractionNullRec.removedKeys.size === 0 &&
        extractionNullRec.operations.size === 0,
    );

    const invalidOp = aiFactUpdateSchema.safeParse({
      key: "provider",
      operation: "delete",
    });
    check("2b. Unknown operation 'delete' is rejected", !invalidOp.success);

    const unsupportedRemove = aiFactUpdateSchema.safeParse({
      key: "service",
      operation: "remove",
    });
    check(
      "2c. Unsupported removal for 'service' is rejected",
      !unsupportedRemove.success,
    );

    const removeWithValue = aiFactUpdateSchema.safeParse({
      key: "provider",
      operation: "remove",
      value: "د. سارة",
    });
    check(
      "2d. REMOVE with replacement value is rejected",
      !removeWithValue.success,
    );

    const emptyValue = aiFactUpdateSchema.safeParse({
      key: "provider",
      operation: "set",
      value: "",
    });
    check("2e. Empty string value is rejected", !emptyValue.success);

    const whitespaceValue = aiFactUpdateSchema.safeParse({
      key: "provider",
      operation: "set",
      value: "   ",
    });
    check("2f. Whitespace-only value is rejected", !whitespaceValue.success);

    const sentinelNullValue = aiFactUpdateSchema.safeParse({
      key: "provider",
      operation: "set",
      value: "null",
    });
    check(
      "2g. Sentinel text 'null' is rejected as deletion protocol",
      !sentinelNullValue.success,
    );
  }

  // Check 3: REMOVE defeats conflicting extraction
  {
    const rec = reconcileTurnSemanticFacts(
      {
        service: "تنظيف أسنان",
        provider: "د. أحمد",
        date: "2026-09-15",
        timePreference: null,
      },
      [{ key: "provider", operation: "remove" }],
    );
    check(
      "3a. REMOVE overrides conflicting extraction.provider",
      rec.isRemoved("provider") === true &&
        rec.normalizedExtraction.provider === null &&
        rec.normalizedExtraction.service === "تنظيف أسنان" &&
        rec.normalizedExtraction.date === "2026-09-15",
    );
    check(
      "3b. Effective factUpdates carries remove operation",
      rec.effectiveFactUpdates.some(
        (u) => u.key === "provider" && u.operation === "remove",
      ),
    );
  }

  // Check 4: Two operations same key: last SET/REMOVE wins in both orders
  {
    // Order 1: REMOVE then SET
    const order1 = reconcileTurnSemanticFacts(null, [
      { key: "provider", operation: "remove" },
      { key: "provider", operation: "set", value: "د. سارة" },
    ]);
    check(
      "4a. REMOVE then SET: SET wins ('د. سارة')",
      order1.isRemoved("provider") === false &&
        order1.normalizedExtraction.provider === "د. سارة" &&
        order1.setFacts.get("provider")?.value === "د. سارة",
    );

    // Order 2: SET then REMOVE
    const order2 = reconcileTurnSemanticFacts(null, [
      { key: "provider", operation: "set", value: "د. سارة" },
      { key: "provider", operation: "remove" },
    ]);
    check(
      "4b. SET then REMOVE: REMOVE wins",
      order2.isRemoved("provider") === true &&
        order2.normalizedExtraction.provider === null &&
        !order2.setFacts.has("provider"),
    );
  }

  // Check 5: Unknown/unsupported removal cannot clear unrelated facts
  {
    const baseState: ConversationState = {
      ...emptyConversationState(),
      knownFacts: {
        service: "تنظيف أسنان",
        date: "2026-09-15",
        timePreference: "evening",
        provider: "د. سارة",
      },
      selectedService: "تنظيف أسنان",
      selectedDate: "2026-09-15",
      selectedTimePref: "evening",
      providerPreference: "د. سارة",
    };

    // Passing an invalid update for an unknown key
    const merged = mergeConversationState(baseState, {
      factUpdates: [{ key: "unknownKey" as any, value: "something" }],
    });
    check(
      "5. Unknown fact update does not touch valid existing facts",
      merged.state.knownFacts.service === "تنظيف أسنان" &&
        merged.state.knownFacts.date === "2026-09-15" &&
        merged.state.knownFacts.provider === "د. سارة" &&
        merged.state.knownFacts.timePreference === "evening",
    );
  }

  // =========================================================================
  // Setup Mock Business & Engine Fixture
  // =========================================================================
  const B_ID = "11111111-1111-4111-8111-111111111111";
  const SERVICE_1 = "33333333-3333-4333-8333-333333333331";
  const SERVICE_2 = "33333333-3333-4333-8333-333333333332";
  const PROVIDER_SARA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const PROVIDER_AHMED_ALI = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const PROVIDER_AHMED_HASSAN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const BRANCH_1 = "44444444-4444-4444-8444-444444444444";
  const testNow = new Date("2026-09-14T10:00:00Z");

  function createTestHarness(opts?: {
    defaultServiceId?: string | null;
    customGenerativeReply?: (req: AiRequest) => AiResponse;
    customHttpHandler?: MockHttpHandler;
    hasCredentials?: boolean;
    blockingAppointments?: Array<{
      assignedUserId: string;
      startTime: string;
      endTime: string;
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

    const providers = [
      { id: PROVIDER_SARA, displayName: "د. سارة", user: { name: "سارة" } },
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
    ];

    const customer = {
      id: "cust-1",
      businessId: B_ID,
      name: "عميل تجريبي",
      phone: "+201234567890",
    };

    const conversation = {
      id: "conv-1",
      businessId: B_ID,
      customerId: customer.id,
      branchId: BRANCH_1,
      status: "AI_ACTIVE",
      assignedUserId: null as string | null,
      aiSummary: null as string | null,
    };

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

    const capturedDomainInputs: Array<{
      serviceId: string;
      providerId?: string;
      date: string;
    }> = [];

    const httpCalls: HttpCall[] = [];
    const capturedRequests: AiRequest[] = [];
    const currentGenerativeReply: (req: AiRequest) => AiResponse =
      opts?.customGenerativeReply ??
      ((_req) => ({
        intent: "BOOKING",
        action: "booking_handoff",
        summary: "حجز موعد",
        content: "أهلاً بك! هساعدك في حجز الموعد.",
        handoffReason: null,
        extraction: {
          service: "تنظيف أسنان",
          provider: null,
          date: "2026-09-15",
          timePreference: null,
        },
      }));

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const rawBody = String(init?.body ?? "{}");
      let body: any = {};
      try {
        body = JSON.parse(rawBody);
      } catch {}
      const call: HttpCall = {
        url,
        method,
        headers,
        body,
        rawBody,
      };
      httpCalls.push(call);

      if (opts?.customHttpHandler) {
        const res = opts.customHttpHandler(call);
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (body?.model === JEV_PINNED_MODEL) {
        const payload = body?.state as
          { customer_message?: string } | undefined;
        const text = payload?.customer_message ?? "";
        const answers = buildDefaultJevAnswers(text);
        return new Response(
          JSON.stringify({
            id: `dec-${httpCalls.length}`,
            model: JEV_PINNED_MODEL,
            answers,
            usage: { input_tokens: 180, output_tokens: 30 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      // Real generative adapter call through OpenRouter endpoint
      const lastReq = capturedRequests[capturedRequests.length - 1];
      const reply = currentGenerativeReply(
        lastReq ?? {
          message: "",
          conversationStatus: "AI_ACTIVE",
          recentMessages: [],
          businessName: business.name,
          services: [],
          faqs: [],
        },
      );

      return new Response(
        JSON.stringify({
          id: `gen-${httpCalls.length}`,
          model: "mock-generative-v1",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify(reply),
              },
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 40 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const hasCredentials =
      opts?.hasCredentials ?? (opts?.customGenerativeReply ? false : true);
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

    const generativeAdapter = createOpenRouterAdapter({
      model: "mock-generative-v1",
      getEnvVar: (name) =>
        name === "OPENROUTER_API_KEY" ? "sk-openrouter-gen-test" : undefined,
      fetchImpl: mockFetch,
    });

    const orchestrator = createAiOrchestrator({
      primary: generativeAdapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: semanticStrategy,
    });

    const realGatewayAi = {
      providerName: "mock-gateway",
      async respond(request: AiRequest): Promise<AiResponse> {
        capturedRequests.push(request);
        const result = await orchestrator.callWithFallback(request);
        if (!result.response) {
          throw new Error("AI call failed in test fixture");
        }
        return result.response;
      },
    };

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findByWhatsappNumber: async () => business as any,
        findById: async (id: string) =>
          id === B_ID ? (business as any) : null,
      } as any,
      branchRepository: {
        findDefaultByBusiness: async () => branch as any,
        findByIdWithinBusiness: async (id: string, bId?: string) =>
          id === BRANCH_1 && (!bId || bId === B_ID) ? (branch as any) : null,
        findById: async (id: string) =>
          id === BRANCH_1 ? (branch as any) : null,
        listByBusiness: async (bId: string) =>
          bId === B_ID ? [branch as any] : [],
      } as any,
      customerRepository: {
        upsertByPhone: async () => customer as any,
        touchConversation: async () => customer as any,
        findById: async (id: string) =>
          id === customer.id ? (customer as any) : null,
        findByPhone: async (bId: string, phone: string) =>
          bId === B_ID && phone === customer.phone ? (customer as any) : null,
      } as any,
      providerRepository: {
        listEligibleForService: async (bId: string) =>
          bId === B_ID
            ? (providers.map((p) => ({
                id: p.id,
                name: p.displayName,
                displayName: p.displayName,
                userId: p.id,
                user: { name: p.displayName },
                businessId: B_ID,
                role: "STAFF",
                isAvailable: true,
              })) as any)
            : [],
        listAssignmentSeams: async (_bId: string, ids: string[]) => {
          const scopedIds =
            ids && ids.length > 0 ? ids : providers.map((p) => p.id);
          capturedDomainInputs.push({
            serviceId: SERVICE_2,
            providerId: scopedIds.length === 1 ? scopedIds[0] : undefined,
            date: "2026-09-15",
          });
          return scopedIds.map((id) => ({
            providerId: id,
            displayName:
              providers.find((p) => p.id === id)?.displayName ?? "طبيب",
            userId: `user-${id}`,
            assignedUserId: `user-${id}`,
            isActive: true,
          }));
        },
      } as any,
      conversationRepository: {
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findById: async () =>
          ({
            ...conversation,
            status: conversation.status,
          }) as any,
        create: async () => conversation as any,
        update: async (_id: string, update: any) => {
          Object.assign(conversation, update);
          return {
            ...conversation,
            status: conversation.status,
          } as any;
        },
        updateWorkflow: async (_id: string, data: { status?: any }) => {
          if (data.status) {
            conversation.status = data.status;
          }
          return {
            ...conversation,
            status: conversation.status,
          } as any;
        },
        addMessage: async (
          input: { conversationId: string; senderType: any; content: string },
          options?: { status?: string },
        ) => {
          if (options?.status) {
            conversation.status = options.status;
          }
          const msg = {
            id: `msg-${messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
            createdAt: new Date(),
          };
          messages.push(msg);
          return msg as any;
        },
        getMessages: async () => [...messages] as any,
        async listRecentMessages() {
          return messages.map((m) => ({
            id: m.id,
            senderType: m.senderType,
            content: m.content,
            createdAt: new Date(),
          })) as any;
        },
      } as any,
      serviceRepository: {
        listByBusiness: async (bId: string) =>
          bId === B_ID ? (services as any) : [],
        findById: async (id: string) =>
          (services.find((s) => s.id === id) ?? null) as any,
      } as any,
      inboundDedupeRepository: {
        claim: async () => {
          return {
            status: "claimed",
            claimId: `claim-${Date.now()}-${Math.random()}`,
          } as any;
        },
      } as any,
      usageRepository: {
        record: async () => ({ id: "usage-1" }) as any,
      } as any,
      appointmentRepository: {
        createWithConflictCheck: async (dto: any) => {
          createdAppointments.push({
            serviceId: dto.serviceId,
            providerId: dto.providerId ?? undefined,
            date: dto.date,
            startTime: dto.startTime,
            endTime: dto.endTime,
          });
          return {
            id: `apt-${createdAppointments.length}`,
            businessId: dto.businessId,
            customerId: dto.customerId,
            serviceId: dto.serviceId,
            assignedUserId: dto.assignedUserId ?? null,
            startAt: new Date(),
            endAt: new Date(),
            status: "CONFIRMED",
          } as any;
        },
        listBlockingByAssignees: async () => opts?.blockingAppointments ?? [],
      } as any,
      transport: {
        providerName: "test-transport",
        send: async () => ({ provider: "test", delivered: true }),
      } as any,
      ai: realGatewayAi as any,
      conversationStateRepository: stateStore,
    };

    let msgCounter = 0;
    async function sendTurn(text: string, timestamp: Date = testNow) {
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
      stateStore,
      httpCalls,
      capturedRequests,
      capturedDomainInputs,
      createdAppointments,
      messages,
      conversation,
      sendTurn,
    };
  }

  // =========================================================================
  // SECTION 2: Engine + Controlled Provider Response (Checks 6 - 13)
  // =========================================================================
  console.log("2. Engine + Controlled Provider Response Invariants...");

  // Check 6: Remove provider: state/mirrors and captured Domain input all have no old preference; service/date survive
  {
    const h = createTestHarness({
      customGenerativeReply: (req) => {
        if (req.message.includes("أي حد متاح")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "إزالة تفضيل الطبيب",
            content: "تمام، هعرض لك المواعيد المتاحة مع أي دكتور.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            factUpdates: [{ key: "provider", operation: "remove" }],
          };
        }
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "حجز موعد",
          content: "حجز مع دكتورة سارة",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: "د. سارة",
            date: "2026-09-15",
            timePreference: null,
          },
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
            { key: "provider", operation: "set", value: "د. سارة" },
            { key: "date", operation: "set", value: "2026-09-15" },
          ],
        };
      },
    });

    // Turn 1: Set service, date, provider = "د. سارة"
    await h.sendTurn("عايز أنظف أسناني يوم 15-9 مع د. سارة");

    const loaded1 = await h.stateStore.load(B_ID, "conv-1");
    const s1 = loaded1?.state as any;
    check(
      "6-pre. Turn 1 establishes provider preference",
      s1.knownFacts.provider === "د. سارة",
    );

    const domainCountBefore = h.capturedDomainInputs.length;

    // Turn 2: Customer removes provider preference ("أي حد متاح")
    await h.sendTurn("أي حد متاح مش فارقة");

    const loaded2 = await h.stateStore.load(B_ID, "conv-1");
    const s2 = loaded2?.state as any;
    const currentDomainInput = h.capturedDomainInputs[domainCountBefore];

    check(
      "6a. State provider preference cleared after remove",
      s2.knownFacts.provider === undefined &&
        (s2.providerPreference === null || s2.providerPreference === undefined),
    );
    check(
      "6b. A new domain query was executed without provider filter (any provider)",
      h.capturedDomainInputs.length === domainCountBefore + 1 &&
        currentDomainInput !== undefined &&
        currentDomainInput.providerId === undefined,
    );
    check(
      "6c. Service and date survive provider removal",
      s2.knownFacts.service === "تنظيف أسنان" &&
        s2.knownFacts.date === "2026-09-15",
    );
  }

  // Check 7: Remove time preference: no old filter is applied; service/date/provider survive
  {
    const h = createTestHarness({
      blockingAppointments: [
        {
          assignedUserId: "user-" + PROVIDER_SARA,
          startTime: "09:30",
          endTime: "17:00",
        },
      ],
      customGenerativeReply: (req) => {
        if (req.message.includes("مش فارق الوقت")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "إزالة تفضيل الوقت",
            content: "تمام، هعرض لك كل المواعيد المتاحة على مدار اليوم.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            factUpdates: [{ key: "timePreference", operation: "remove" }],
          };
        }
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "حجز موعد مسائي",
          content: "حجز موعد مسائي",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: "د. سارة",
            date: "2026-09-15",
            timePreference: "evening",
          },
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
            { key: "provider", operation: "set", value: "د. سارة" },
            { key: "date", operation: "set", value: "2026-09-15" },
            { key: "timePreference", operation: "set", value: "evening" },
          ],
        };
      },
    });

    // Turn 1: Establish service, date, provider, evening time
    await h.sendTurn("عايز أنظف أسناني بالليل يوم 15-9 مع د. سارة");

    const loaded1 = await h.stateStore.load(B_ID, "conv-1");
    const s1 = loaded1?.state as any;
    const turn1Options: Array<{ startAt: string }> = s1.offer?.options ?? [];
    const leadsWithEvening =
      turn1Options.length > 0 &&
      parseInt(turn1Options[0]?.startAt.slice(11, 13) ?? "0", 10) >= 17;

    check(
      "7-pre. Active evening preference prioritizes evening slots at the head of the offer",
      leadsWithEvening,
      { turn1Options, offer: s1?.offer, knownFacts: s1?.knownFacts },
    );

    // Turn 2: Remove time preference
    await h.sendTurn("مش فارق الوقت الصبح أو بالليل");

    const loaded2 = await h.stateStore.load(B_ID, "conv-1");
    const s2 = loaded2?.state as any;
    const turn2Options: Array<{ startAt: string }> = s2.offer?.options ?? [];
    const leadsWithMorning =
      turn2Options.length > 0 &&
      parseInt(turn2Options[0]?.startAt.slice(11, 13) ?? "0", 10) < 12;

    check(
      "7a. State timePreference cleared after remove",
      s2.knownFacts.timePreference === undefined,
    );
    check(
      "7b. Mirrored selectedTimePref cleared after remove",
      s2.selectedTimePref === null || s2.selectedTimePref === undefined,
    );
    check(
      "7c. Resulting slot offer is no longer restricted to evening and leads with morning hour",
      leadsWithMorning,
    );
    check(
      "7d. Service, date, and provider survive timePreference removal",
      s2.knownFacts.service === "تنظيف أسنان" &&
        s2.knownFacts.date === "2026-09-15" &&
        s2.knownFacts.provider === "د. سارة",
    );
  }

  // Check 8: Remove date: state/mirrors clear, offer invalidates, no appointment is created; next step asks for date
  {
    const h = createTestHarness({
      customGenerativeReply: (req) => {
        if (req.message.includes("بلاش اليوم ده")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "إزالة التاريخ",
            content: "تمام، تحب نحدد يوم تاني إمتى؟",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            factUpdates: [{ key: "date", operation: "remove" }],
          };
        }
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "حجز موعد",
          content: "المواعيد المتاحة",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: null,
            date: "2026-09-15",
            timePreference: null,
          },
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
            { key: "date", operation: "set", value: "2026-09-15" },
          ],
        };
      },
    });

    // Turn 1: Present offer for 2026-09-15
    await h.sendTurn("عايز أنظف أسناني يوم 15-9");

    const loaded1 = await h.stateStore.load(B_ID, "conv-1");
    const s1 = loaded1?.state as any;
    check(
      "8-pre. Slot offer is active on Turn 1",
      s1.offer?.status === "ACTIVE",
    );

    const domainCountBefore = h.capturedDomainInputs.length;
    const apptCountBefore = h.createdAppointments.length;

    // Turn 2: Remove date
    const res2 = await h.sendTurn("بلاش اليوم ده، هحدد بعدين");

    const loaded2 = await h.stateStore.load(B_ID, "conv-1");
    const s2 = loaded2?.state as any;

    check(
      "8a. State date cleared after remove",
      s2.knownFacts.date === undefined,
    );
    check(
      "8b. Mirrored selectedDate cleared after remove",
      s2.selectedDate === null || s2.selectedDate === undefined,
    );
    check(
      "8c. Prior slot offer is INVALIDATED",
      s2.offer?.status === "INVALIDATED",
    );
    check(
      "8d. No new appointment slot search was executed for this turn",
      h.capturedDomainInputs.length === domainCountBefore,
    );
    check(
      "8e. No appointment was created",
      h.createdAppointments.length === apptCountBefore,
    );
    check(
      "8f. Next step asks for date (CLARIFY / MISSING_DATE)",
      Boolean(
        res2.ok &&
        "assistantAction" in res2 &&
        res2.assistantAction === "AI_REPLY" &&
        (h.messages[h.messages.length - 1]?.content.includes("تاريخ") ||
          res2.observability?.clarification?.missingFacts?.includes("date")),
      ),
    );
    check(
      "8g. Service survives date removal",
      s2.knownFacts.service === "تنظيف أسنان",
    );
  }

  // Check 9: Set provider with two providers sharing first name: correct full preference reaches Domain through the same reconciliation
  {
    const h = createTestHarness({
      customGenerativeReply: () => ({
        intent: "BOOKING",
        action: "booking_handoff",
        summary: "حجز موعد",
        content: "المواعيد مع د. أحمد علي",
        handoffReason: null,
        extraction: {
          service: "تنظيف أسنان",
          provider: "د. أحمد علي",
          date: "2026-09-15",
          timePreference: null,
        },
        factUpdates: [
          { key: "service", operation: "set", value: "تنظيف أسنان" },
          { key: "provider", operation: "set", value: "د. أحمد علي" },
          { key: "date", operation: "set", value: "2026-09-15" },
        ],
      }),
    });

    await h.sendTurn("عايز حجز مع د. أحمد علي");

    const loaded = await h.stateStore.load(B_ID, "conv-1");
    const s = loaded?.state as any;
    const lastDomainInput =
      h.capturedDomainInputs[h.capturedDomainInputs.length - 1];

    check(
      "9a. Reconciled providerPreference is 'د. أحمد علي'",
      s.knownFacts.provider === "د. أحمد علي",
    );
    check(
      "9b. Domain input matches PROVIDER_AHMED_ALI unambiguously",
      lastDomainInput?.providerId === PROVIDER_AHMED_ALI,
    );
  }

  // Check 10: Reload the saved state and send a continuation without replacement: rejected facts do not revive from historical text
  {
    // 10a. Provider removal continuation
    const hProv = createTestHarness({
      customGenerativeReply: (req) => {
        if (req.message.includes("أي حد متاح")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "إزالة تفضيل الطبيب",
            content: "تمام بدون تفضيل طبيب.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            factUpdates: [{ key: "provider", operation: "remove" }],
          };
        }
        if (req.message.includes("تمام الساعة 10")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "استمرار الحجز",
            content: "جاري حجز الساعة 10.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: "10:00",
            },
          };
        }
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "حجز موعد",
          content: "المواعيد المتاحة",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: "د. سارة",
            date: "2026-09-15",
            timePreference: null,
          },
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
            { key: "provider", operation: "set", value: "د. سارة" },
            { key: "date", operation: "set", value: "2026-09-15" },
          ],
        };
      },
    });

    await hProv.sendTurn("حجز تنظيف أسنان مع د. سارة يوم 15-9");
    await hProv.sendTurn("أي حد متاح مش فارقة");
    await hProv.sendTurn("تمام الساعة 10 مناسبة");

    const loadedProv = await hProv.stateStore.load(B_ID, "conv-1");
    const sProv = loadedProv?.state as any;
    check(
      "10a. Rejected provider does NOT revive on continuation turn",
      sProv.knownFacts.provider === undefined &&
        (sProv.providerPreference === null ||
          sProv.providerPreference === undefined),
    );

    // 10b. Date removal continuation
    const hDate = createTestHarness({
      customGenerativeReply: (req) => {
        if (req.message.includes("بلاش اليوم ده")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "إزالة التاريخ",
            content: "تمام بدون تاريخ محدد.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            factUpdates: [{ key: "date", operation: "remove" }],
          };
        }
        if (req.message.includes("مين الدكاترة")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "استفسار عن الأطباء",
            content: "الأطباء المتاحون: د. سارة، د. أحمد علي.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
          };
        }
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "حجز موعد",
          content: "المواعيد المتاحة",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: null,
            date: "2026-09-15",
            timePreference: null,
          },
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
            { key: "date", operation: "set", value: "2026-09-15" },
          ],
        };
      },
    });

    await hDate.sendTurn("حجز تنظيف أسنان يوم 2026-09-15");
    await hDate.sendTurn("بلاش اليوم ده، هحدد بعدين");
    await hDate.sendTurn("مين الدكاترة المتاحين عندكم؟");

    const loadedDate = await hDate.stateStore.load(B_ID, "conv-1");
    const sDate = loadedDate?.state as any;
    check(
      "10b. Rejected date does NOT revive from history on continuation turn",
      sDate.knownFacts.date === undefined &&
        (sDate.selectedDate === null || sDate.selectedDate === undefined),
    );

    // 10c. Time preference removal continuation
    const hTime = createTestHarness({
      blockingAppointments: [
        {
          assignedUserId: "user-" + PROVIDER_SARA,
          startTime: "09:30",
          endTime: "17:00",
        },
      ],
      customGenerativeReply: (req) => {
        if (req.message.includes("مش فارق الوقت")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "إزالة الوقت",
            content: "تمام بدون تفضيل وقت.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            factUpdates: [{ key: "timePreference", operation: "remove" }],
          };
        }
        if (req.message.includes("مع د. سارة")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "تأكيد الطبيب",
            content: "المواعيد مع د. سارة.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: "د. سارة",
              date: null,
              timePreference: null,
            },
            factUpdates: [
              { key: "provider", operation: "set", value: "د. سارة" },
            ],
          };
        }
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "حجز موعد",
          content: "المواعيد المتاحة",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: null,
            date: "2026-09-15",
            timePreference: "evening",
          },
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
            { key: "date", operation: "set", value: "2026-09-15" },
            { key: "timePreference", operation: "set", value: "evening" },
          ],
        };
      },
    });

    await hTime.sendTurn("حجز تنظيف أسنان بالليل يوم 2026-09-15");
    await hTime.sendTurn("مش فارق الوقت الصبح أو بالليل");
    await hTime.sendTurn("مع د. سارة");

    const loadedTime = await hTime.stateStore.load(B_ID, "conv-1");
    const sTime = loadedTime?.state as any;
    const contOptions: Array<{ startAt: string }> = sTime.offer?.options ?? [];
    const contHasMorning = contOptions.some(
      (opt) => parseInt(opt.startAt.slice(11, 13), 10) < 12,
    );

    check(
      "10c. Rejected time preference does NOT revive as filter on continuation turn",
      sTime.knownFacts.timePreference === undefined &&
        (sTime.selectedTimePref === null ||
          sTime.selectedTimePref === undefined) &&
        contHasMorning,
    );
  }

  // Check 11: Reintroduce a NEW valid SET after deletion: it is accepted normally
  {
    const h = createTestHarness({
      customGenerativeReply: (req) => {
        if (req.message.includes("خليه مع د. أحمد علي")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "تحديد طبيب جديد",
            content: "المواعيد مع د. أحمد علي.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: "د. أحمد علي",
              date: null,
              timePreference: null,
            },
            factUpdates: [
              { key: "provider", operation: "set", value: "د. أحمد علي" },
            ],
          };
        }
        if (req.message.includes("أي حد متاح")) {
          return {
            intent: "BOOKING",
            action: "booking_handoff",
            summary: "إزالة تفضيل الطبيب",
            content: "تم إلغاء التفضيل.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            factUpdates: [{ key: "provider", operation: "remove" }],
          };
        }
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "حجز موعد",
          content: "المواعيد مع د. سارة",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: "د. سارة",
            date: "2026-09-15",
            timePreference: null,
          },
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
            { key: "provider", operation: "set", value: "د. سارة" },
            { key: "date", operation: "set", value: "2026-09-15" },
          ],
        };
      },
    });

    // Turn 1: Dr. Sara
    await h.sendTurn("حجز تنظيف أسنان مع د. سارة يوم 15-9");

    // Turn 2: Remove provider
    await h.sendTurn("أي حد متاح");

    // Turn 3: Set new provider "د. أحمد علي"
    await h.sendTurn("خليه مع د. أحمد علي");

    const loaded3 = await h.stateStore.load(B_ID, "conv-1");
    const s3 = loaded3?.state as any;
    const lastDomainInput =
      h.capturedDomainInputs[h.capturedDomainInputs.length - 1];

    check(
      "11a. State accepts new SET after remove",
      s3.knownFacts.provider === "د. أحمد علي",
    );
    check(
      "11b. Domain resolves new provider unambiguously",
      lastDomainInput?.providerId === PROVIDER_AHMED_ALI,
    );
  }

  // Check 12: Valid numeric/button selection still has zero physical model network attempts, including retry/shadow
  {
    const h = createTestHarness();

    // Positive Control / Canary:
    // Send a regular semantic turn, proving that httpCalls captures model network attempts
    await h.sendTurn("عايز أحجز كشف أسنان");
    check(
      "12-canary. Positive control: Semantic turn captures physical network attempts in httpCalls",
      h.httpCalls.length > 0,
    );

    // Establish active offer in state
    const baseState: ConversationState = {
      ...emptyConversationState(),
      serviceId: SERVICE_1,
      serviceSource: "CUSTOMER",
      knownFacts: { service: "كشف أسنان", date: "2026-09-15" },
    };
    const slotOffer = buildSlotOffer(
      { businessId: B_ID, conversationId: "conv-1" },
      "tok-123",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 2,
        options: [
          {
            displayName: "د. سارة",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
            providerId: PROVIDER_SARA,
          },
          {
            displayName: "د. أحمد علي",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
            providerId: PROVIDER_AHMED_ALI,
          },
        ],
      },
      testNow,
    );
    const stateWithOffer = withPresentedOffer(baseState, slotOffer!);
    const prev1 = await h.stateStore.load(B_ID, "conv-1");
    await h.stateStore.save(
      B_ID,
      "conv-1",
      prev1?.revision ?? null,
      dehydrateConversationState(stateWithOffer),
    );

    // Reset counters for the selection turn
    h.httpCalls.length = 0;
    h.createdAppointments.length = 0;

    // Send selection "١" (Arabic digit 1)
    await h.sendTurn("١");

    check(
      "12a. Arabic digit selection books appointment directly",
      h.createdAppointments.length === 1 &&
        h.createdAppointments[0]?.startTime === "09:00",
    );
    check(
      "12b. Exactly ZERO physical model HTTP attempts spent on digit selection",
      h.httpCalls.length === 0,
    );

    // Test valid structured callback "opt_2"
    const prev2 = await h.stateStore.load(B_ID, "conv-1");
    await h.stateStore.save(
      B_ID,
      "conv-1",
      prev2?.revision ?? null,
      dehydrateConversationState(stateWithOffer),
    );
    h.httpCalls.length = 0;
    h.createdAppointments.length = 0;

    const resOpt = await h.sendTurn("opt_2");

    check(
      "12c. Valid callback 'opt_2' books appointment directly",
      h.createdAppointments.length === 1 &&
        h.createdAppointments[0]?.startTime === "09:00" &&
        h.createdAppointments[0]?.providerId === PROVIDER_AHMED_ALI,
      { resOpt, appts: h.createdAppointments, msgs: h.messages.slice(-2) },
    );
    check(
      "12d. Exactly ZERO physical model HTTP attempts spent on callback selection",
      h.httpCalls.length === 0,
    );
  }

  // Check 13: Mixed numeric sentence reaches semantic processing intact
  {
    const h = createTestHarness();

    const baseState: ConversationState = {
      ...emptyConversationState(),
      serviceId: SERVICE_1,
      serviceSource: "CUSTOMER",
      knownFacts: { service: "كشف أسنان", date: "2026-09-15" },
    };
    const slotOffer = buildSlotOffer(
      { businessId: B_ID, conversationId: "conv-1" },
      "tok-123",
      {
        serviceId: SERVICE_1,
        serviceName: "كشف أسنان",
        serviceSource: "CUSTOMER",
        providerId: null,
        date: "2026-09-15",
        followUpRequestId: null,
        shownCount: 2,
        options: [
          {
            displayName: "د. سارة",
            startAt: "2026-09-15T09:00",
            endAt: "2026-09-15T09:30",
            providerId: PROVIDER_SARA,
          },
          {
            displayName: "د. أحمد علي",
            startAt: "2026-09-15T09:30",
            endAt: "2026-09-15T10:00",
            providerId: PROVIDER_AHMED_ALI,
          },
        ],
      },
      testNow,
    );
    const stateWithOffer = withPresentedOffer(baseState, slotOffer!);
    const prev3 = await h.stateStore.load(B_ID, "conv-1");
    await h.stateStore.save(
      B_ID,
      "conv-1",
      prev3?.revision ?? null,
      dehydrateConversationState(stateWithOffer),
    );

    h.httpCalls.length = 0;
    h.createdAppointments.length = 0;

    // Send mixed sentence "٢ بس غير اليوم ده" through the engine
    await h.sendTurn("٢ بس غير اليوم ده");

    check(
      "13a. Mixed sentence '٢ بس غير اليوم ده' does NOT book an appointment",
      h.createdAppointments.length === 0,
    );
    check(
      "13b. Mixed sentence reaches full semantic pipeline and spends network calls",
      h.httpCalls.length > 0,
    );

    const selection = parseBookingSelection("٢ بس غير اليوم ده");
    check(
      "13c. parseBookingSelection('٢ بس غير اليوم ده') returns null (preserved for AI)",
      selection === null,
    );

    const tryOfferSelection = tryParseBookingSelection("٢ بس غير اليوم ده", []);
    check(
      "13d. tryParseBookingSelection('٢ بس غير اليوم ده') returns null",
      tryOfferSelection === null,
    );
  }

  // =========================================================================
  // SECTION 3: Product / Prompt Wire (Checks 14 - 18)
  // =========================================================================
  console.log("3. Product & Prompt Wire Invariants...");

  // Check 14: Default-service booking via receiveInboundMessage
  {
    // Scenario 1: Default configured (SERVICE_1 "كشف أسنان") + no service mentioned in message/extraction
    const h1 = createTestHarness({
      defaultServiceId: SERVICE_1,
      customGenerativeReply: () => ({
        intent: "BOOKING",
        action: "booking_handoff",
        summary: "حجز موعد",
        content: "المواعيد المتاحة",
        handoffReason: null,
        extraction: {
          service: null,
          provider: null,
          date: "2026-09-15",
          timePreference: null,
        },
        factUpdates: [{ key: "date", operation: "set", value: "2026-09-15" }],
      }),
    });

    await h1.sendTurn("عايز أحجز موعد يوم 15-9");
    const loaded1 = await h1.stateStore.load(B_ID, "conv-1");
    const s1 = loaded1?.state as any;
    const lastReply1 = h1.messages[h1.messages.length - 1]?.content ?? "";

    check(
      "14a. Default service used when no service mentioned",
      s1.serviceId === SERVICE_1 &&
        s1.serviceSource === "DEFAULT" &&
        s1.knownFacts.service === "كشف أسنان",
    );
    check(
      "14b. Default service booking does NOT show service catalog list",
      !lastReply1.includes("الخدمات المتاحة لدينا:") &&
        !lastReply1.includes("يرجى تحديد الخدمة"),
    );

    // Scenario 2: Explicit valid different service ("تنظيف أسنان" SERVICE_2) takes precedence over default
    const h2 = createTestHarness({
      defaultServiceId: SERVICE_1,
      customGenerativeReply: () => ({
        intent: "BOOKING",
        action: "booking_handoff",
        summary: "حجز تنظيف",
        content: "المواعيد المتاحة لتنظيف الأسنان",
        handoffReason: null,
        extraction: {
          service: "تنظيف أسنان",
          provider: null,
          date: "2026-09-15",
          timePreference: null,
        },
        factUpdates: [
          { key: "service", operation: "set", value: "تنظيف أسنان" },
          { key: "date", operation: "set", value: "2026-09-15" },
        ],
      }),
    });

    await h2.sendTurn("عايز تنظيف أسنان يوم 15-9");
    const loaded2 = await h2.stateStore.load(B_ID, "conv-1");
    const s2 = loaded2?.state as any;

    check(
      "14c. Explicit valid service takes precedence over default",
      s2.serviceId === SERVICE_2 &&
        s2.serviceSource === "CUSTOMER" &&
        s2.knownFacts.service === "تنظيف أسنان",
    );

    // Scenario 3: Explicit unknown service ("جراحة قلب") does NOT silently convert to default
    const h3 = createTestHarness({
      defaultServiceId: SERVICE_1,
      customGenerativeReply: () => ({
        intent: "BOOKING",
        action: "booking_handoff",
        summary: "طلب خدمة غير متوفرة",
        content: "جاري الفحص",
        handoffReason: null,
        extraction: {
          service: "جراحة قلب",
          provider: null,
          date: "2026-09-15",
          timePreference: null,
        },
        factUpdates: [{ key: "date", operation: "set", value: "2026-09-15" }],
      }),
    });

    const res3 = await h3.sendTurn("عايز جراحة قلب يوم 15-9");
    const loaded3 = await h3.stateStore.load(B_ID, "conv-1");
    const s3 = loaded3?.state as any;

    check(
      "14d. Explicit unknown service does NOT silently fall back to default",
      s3?.serviceId !== SERVICE_1 &&
        (Boolean(
          (res3 as any)?.observability?.clarification?.missingFacts?.includes(
            "service",
          ),
        ) ||
          (res3 as any)?.assistantAction === "AI_REPLY"),
    );
  }

  // Check 15: Catalog inquiry preserves state AND actually includes the expected real service names in reply content
  {
    const h = createTestHarness({
      customGenerativeReply: (req) => {
        if (req.message.includes("الخدمات المتاحة")) {
          return {
            intent: "FAQ",
            action: "reply",
            summary: "استفسار عن الخدمات",
            content: "الخدمات المتاحة لدينا هي: كشف أسنان، وتنظيف أسنان.",
            handoffReason: null,
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
          };
        }
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: "حجز موعد",
          content: "حجز موعد",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: null,
            date: "2026-09-15",
            timePreference: null,
          },
          factUpdates: [
            { key: "service", operation: "set", value: "تنظيف أسنان" },
            { key: "date", operation: "set", value: "2026-09-15" },
          ],
        };
      },
    });

    // Turn 1: Establish booking state
    await h.sendTurn("حجز تنظيف أسنان يوم 15-9");
    const loaded1 = await h.stateStore.load(B_ID, "conv-1");
    const s1 = loaded1?.state as any;

    // Turn 2: Inquire about services
    const res2 = await h.sendTurn("إيه الخدمات المتاحة عندكم؟");
    const loaded2 = await h.stateStore.load(B_ID, "conv-1");
    const s2 = loaded2?.state as any;
    const lastMsg = h.messages[h.messages.length - 1]?.content ?? "";

    check(
      "15a. Reply contains real service names ('كشف أسنان' and 'تنظيف أسنان')",
      res2.ok &&
        lastMsg.includes("كشف أسنان") &&
        lastMsg.includes("تنظيف أسنان"),
    );
    check(
      "15b. Preserved serviceId across inquiry",
      s2.serviceId === s1.serviceId && s2.serviceId === SERVICE_2,
    );
    check(
      "15c. Preserved serviceSource across inquiry",
      s2.serviceSource === s1.serviceSource && s2.serviceSource === "CUSTOMER",
    );
    check(
      "15d. Preserved knownFacts (service and date) across inquiry",
      s2.knownFacts.service === s1.knownFacts.service &&
        s2.knownFacts.date === s1.knownFacts.date &&
        s2.knownFacts.service === "تنظيف أسنان" &&
        s2.knownFacts.date === "2026-09-15",
    );
    check(
      "15e. Active booking task is preserved across inquiry",
      s2.activeTask?.kind === "BOOKING",
    );
  }

  // Check 16 & 17: Prompt contract & canary isolation on HTTP wire through real OpenRouter adapter
  {
    const TOKEN_CANARY = "canary_token_secret_xyz123";
    const NONCE_CANARY = "canary_claim_nonce_secret_abc456";

    // 1. Build upstream state containing canaries
    const baseState: ConversationState = {
      ...emptyConversationState(),
      serviceId: SERVICE_2,
      serviceSource: "CUSTOMER",
      knownFacts: {
        service: "تنظيف أسنان",
        date: "2026-09-15",
        timePreference: "evening",
      },
      selectedTimePref: "evening",
    };
    const canaryOffer = buildSlotOffer(
      { businessId: B_ID, conversationId: "conv-1" },
      TOKEN_CANARY,
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
            displayName: "د. سارة",
            startAt: "2026-09-15T17:00",
            endAt: "2026-09-15T17:30",
            providerId: PROVIDER_SARA,
          },
        ],
      },
      testNow,
    );
    const offerWithNonce = {
      ...canaryOffer!,
      claimNonce: NONCE_CANARY,
    };
    const stateWithCanary = withPresentedOffer(
      baseState,
      offerWithNonce as any,
    );
    const projection = projectConversationState(stateWithCanary, {
      now: testNow,
    });

    const wireReq: AiRequest = {
      message: "مش فارق الوقت",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [{ senderType: "CUSTOMER", content: "مش فارق الوقت" }],
      businessName: "عيادة الابتسامة",
      services: [{ name: "كشف أسنان" }, { name: "تنظيف أسنان" }],
      faqs: [],
      conversationContext: projection ?? undefined,
    };

    const interceptedCalls: HttpCall[] = [];
    const wireAdapter = createOpenRouterAdapter({
      model: "mock-generative-v1",
      getEnvVar: (name) =>
        name === OPENROUTER_SECRET_REF ? "sk-wire-test" : undefined,
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "POST";
        const headers = new Headers(init?.headers);
        const rawBody = String(init?.body ?? "{}");
        let body: any = {};
        try {
          body = JSON.parse(rawBody);
        } catch {}
        interceptedCalls.push({ url, method, headers, body, rawBody });

        return new Response(
          JSON.stringify({
            id: "wire-test-1",
            model: "mock-generative-v1",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    intent: "BOOKING",
                    action: "booking_handoff",
                    summary: "إزالة تفضيل الوقت",
                    content: "تمام بدون تفضيل وقت.",
                    extraction: {
                      service: null,
                      provider: null,
                      date: null,
                      timePreference: null,
                    },
                    factUpdates: [
                      { key: "timePreference", operation: "remove" },
                    ],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 45 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const adapterResult = await wireAdapter.call(wireReq);

    const wireCall = interceptedCalls[0];
    const wireMessages =
      (wireCall?.body?.messages as Array<{
        role: string;
        content: string;
      }>) ?? [];
    const wireSystem =
      wireMessages.find((m) => m.role === "system")?.content ?? "";
    const wireUser = wireMessages.find((m) => m.role === "user")?.content ?? "";

    check(
      "16a. Wire request body carries system instructions describing SET and REMOVE operations",
      wireSystem.includes("factUpdates") &&
        wireSystem.includes("operation") &&
        wireSystem.includes("remove"),
    );
    check(
      "16b. Wire request body carries serialized conversationContext",
      wireUser.includes("conversationContext:") &&
        wireUser.includes("2026-09-15") &&
        wireUser.includes("evening"),
    );
    check(
      "16c. Real adapter parses and validates JSON response carrying REMOVE operation",
      adapterResult.ok === true &&
        adapterResult.response?.factUpdates?.some(
          (u) => u.key === "timePreference" && u.operation === "remove",
        ) === true,
    );
    check(
      "17a. Token canary is strictly absent from physical HTTP wire payload",
      wireCall !== undefined && !wireCall.rawBody.includes(TOKEN_CANARY),
    );
    check(
      "17b. Claim nonce canary is strictly absent from physical HTTP wire payload",
      wireCall !== undefined && !wireCall.rawBody.includes(NONCE_CANARY),
    );
  }

  // Check 18: Missing/invalid provider output cannot create an appointment by guessing
  {
    const h = createTestHarness({
      customGenerativeReply: () => {
        // Model returns invalid response missing required fields
        return {
          intent: "BOOKING",
          action: "booking_handoff",
          summary: null, // missing summary for booking_handoff
          content: "حجز موعد",
          handoffReason: null,
          extraction: {
            service: "تنظيف أسنان",
            provider: null,
            date: "2026-09-15",
            timePreference: null,
          },
        } as any;
      },
    });

    try {
      await h.sendTurn("حجز موعد");
    } catch {
      // safe fallback / error handling
    }

    check(
      "18. Invalid AI output cannot create an appointment by guessing",
      h.createdAppointments.length === 0,
    );
  }

  // =========================================================================
  // Report Results
  // =========================================================================
  console.log("\n── CONV-CORE-03A ACCEPTANCE RESULTS ──\n");
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

main().catch((err) => {
  console.error("FATAL in check:conv-core-03a:", err);
  process.exit(1);
});
