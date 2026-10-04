import type {
  ConversationEngineDeps,
  InboundResult,
} from "../src/features/conversations/server/conversation-engine";
import type {
  Branch,
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
  UsageRecord,
} from "../src/types/domain";

/**
 * FlowPilot — CONVERSATION → BOOKING close-the-loop check (PROMPT-AI-03B).
 *
 * Deterministic offline harness (no DB, no network, no LLM, no Meta):
 *   customer selection (index | HH:mm | provider-name | Arabic-normalized)
 *   → deterministic parser → server-derived Business/Branch/Service
 *   → fresh CORE-01 → fresh CORE-02 → option-still-bookable verification
 *   → canonical createWithConflictCheck → BOOKED + confirmation.
 *
 * Scenarios (fixed date 2026-09-14 Monday):
 *   1  valid option index → BOOKED
 *   2  valid time selection → BOOKED
 *   3  provider-name selection → BOOKED
 *   4  Arabic-normalized selection (١ / ١٠:٠٠) → BOOKED
 *   5  stale selection (offered option gone) → refreshed options, zero write
 *   6  invalid selection (out-of-range index / unoffered time) → zero write
 *   7  ambiguous selection (shared time / shared name) → zero write
 *   8  CORE-01 rejection (inactive service) → NEED_HUMAN, zero write
 *   9  CORE-02 typed rejection + empty options → NEED_HUMAN, zero write
 *   10 hostile identity injection → no fabricated ids, zero write
 *   11 successful canonical appointment creation (authoritative DTO)
 *   12 successful BOOKED transition
 *   13 confirmation delivery via MessageTransport
 *   14 duplicate inbound replay → idempotent, one create + one confirmation
 *   15 SLOT_CONFLICT / concurrent close → refreshed options, no BOOKED
 *   16 booking failure → no success confirmation
 *   17 deterministic path → zero LLM calls (and BOOKED non-AI_ACTIVE replay
 *      deferred to staff, never a second booking)
 *
 * 11–13 are asserted inside scenario 1; 17 is asserted in 1, 8 (zero calls
 * on the deterministic path) and 15/non-selection (AI called only when the
 * text is NOT a selection).
 *
 * Run: pnpm check:booking-confirm
 */
export {};

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const { InboundDuplicateError } =
    await import("../src/server/repositories/inbound-dedupe.repository");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const SERVICE_CLEAN = "33333333-3333-4333-8333-333333333333";
  const SERVICE_INACTIVE = "35555555-5555-4555-8555-555555555555";
  const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const P3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const U1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const U2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const U3 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
  const TEST_DATE = "2026-09-14";
  const WHATSAPP_NUMBER = "+201001111111";
  const FROM = "+201234567890";
  const OFFER_SERVICE = "تنظيف أسنان";

  type ServiceRow = {
    id: string;
    businessId: string;
    name: string;
    description: null;
    durationMinutes: number;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: null;
    priceType: string | null;
    priceAmount: number | null;
    priceMaxAmount: number | null;
    priceCurrency: string | null;
    priceNote: string | null;
  };
  type ProviderRow = {
    id: string;
    displayName: string;
    user: { name: string };
  };
  type BlockingRow = {
    assignedUserId: string;
    startTime: string;
    endTime: string;
  };
  type CreateDto = {
    businessId: string;
    customerId: string;
    serviceId: string;
    branchId: string;
    assignedUserId: string;
    date: string;
    startTime: string;
    endTime: string;
    status: string;
  };

  const now = new Date();

  function openWeek(testDay: string, closed = false): Record<string, unknown> {
    const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
    const hours: Record<string, unknown> = {};
    for (const day of days) {
      hours[day] =
        day === testDay
          ? { open: "10:00", close: "18:00", closed }
          : { open: "10:00", close: "18:00", closed: false };
    }
    return hours;
  }

  function businessRow(
    id: string,
    closed = false,
    confirmationMode: "manual" | "automatic" = "manual",
  ): Business {
    return {
      id,
      name: "عيادة النور",
      vertical: null,
      city: null,
      whatsappNumber: WHATSAPP_NUMBER,
      timezone: "Africa/Cairo",
      about: null,
      workingHours: openWeek("mon", closed),
      slotDurationMinutes: 30,
      confirmationMode,
      faqs: [],
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      assistantName: null,
      assistantStyle: null,
      defaultBranchId: BRANCH_A,
    } as unknown as Business;
  }

  function serviceRow(input: {
    id: string;
    name: string;
    isActive?: boolean;
  }): ServiceRow {
    return {
      id: input.id,
      businessId: BUSINESS_A,
      name: input.name,
      description: null,
      durationMinutes: 30,
      isActive: input.isActive ?? true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: null,
    };
  }

  function canonicalOffer(
    serviceName: string,
    date: string,
    options: Array<{ displayName: string; start: string; end: string }>,
  ): string {
    const lines = options.map(
      (option, index) =>
        `${index + 1}. ${option.displayName} — ${option.start} إلى ${option.end}`,
    );
    return `تتوفر المواعيد التالية لخدمة "${serviceName}" يوم ${date}:\n${lines.join("\n")}\nيرجى اختيار أحد الخيارات وسيتواصل معك الفريق لإتمام الحجز.`;
  }

  const PROVIDERS: ProviderRow[] = [
    { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
    { id: P3, displayName: "د. منى", user: { name: "منى" } },
  ];
  const SEAMS = new Map<string, string>([
    [P1, U1],
    [P2, U2],
    [P3, U3],
  ]);
  // Canonical fixture: distinct option times, matching the default offer.
  const DEFAULT_BLOCKING: BlockingRow[] = [
    { assignedUserId: U2, startTime: "10:00", endTime: "10:30" },
    { assignedUserId: U3, startTime: "10:00", endTime: "10:30" },
    { assignedUserId: U3, startTime: "10:30", endTime: "11:00" },
  ];
  const DEFAULT_OFFER = canonicalOffer(OFFER_SERVICE, TEST_DATE, [
    { displayName: "د. سارة", start: "10:00", end: "10:30" },
    { displayName: "د. أحمد", start: "10:30", end: "11:00" },
    { displayName: "د. منى", start: "11:00", end: "11:30" },
  ]);

  type FixtureOptions = {
    services: ServiceRow[];
    serviceById?: Map<string, ServiceRow>;
    providers?: ProviderRow[];
    blocking?: BlockingRow[];
    offer?: string;
    businessClosed?: boolean;
    confirmationMode?: "manual" | "automatic";
    conversationStatus?: ConversationStatus;
    createImpl?: (dto: CreateDto) => Promise<{ id: string } | null>;
  };

  type FixtureState = {
    deps: ConversationEngineDeps;
    messages: Array<{ senderType: string; content: string; id: string }>;
    createCalls: CreateDto[];
    transportSends: Array<{ to: string; content: string }>;
    aiCalls: number;
    conversationStatus: () => ConversationStatus;
  };

  function makeFixture(opts: FixtureOptions): FixtureState {
    const ledger = new Map<
      string,
      {
        claimId: string;
        conversationId: string | null;
        customerMessageId: string | null;
      }
    >();
    const messages: Array<{ senderType: string; content: string; id: string }> =
      [];
    const createCalls: CreateDto[] = [];
    const transportSends: Array<{ to: string; content: string }> = [];
    const state = { aiCalls: 0 };
    const business = businessRow(
      BUSINESS_A,
      !!opts.businessClosed,
      opts.confirmationMode ?? "manual",
    );
    const serviceById =
      opts.serviceById ??
      new Map<string, ServiceRow>(opts.services.map((s) => [s.id, s]));
    const providers = opts.providers ?? PROVIDERS;
    const seams = new Set(
      (opts.providers ?? PROVIDERS)
        .filter((p) => SEAMS.has(p.id))
        .map((p) => p.id),
    );
    const blocking = opts.blocking ?? DEFAULT_BLOCKING;

    const customer = {
      id: "cust-1",
      businessId: BUSINESS_A,
      name: "عميل",
      phone: FROM,
      notes: null,
      lastConversationAt: null,
      lastAppointmentAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    } as unknown as Customer;

    let conversation: Conversation = {
      id: "conv-1",
      businessId: BUSINESS_A,
      customerId: customer.id,
      branchId: BRANCH_A,
      status: opts.conversationStatus ?? "AI_ACTIVE",
      assignedUserId: null,
      aiSummary: null,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    } as unknown as Conversation;

    const branchRow = {
      id: BRANCH_A,
      businessId: BUSINESS_A,
      name: "الفرع الرئيسي",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    } as unknown as Branch;

    // Pre-seed history: a prior AI offer (required for selection parsing).
    messages.push({
      senderType: "CUSTOMER",
      content: `عايز أحجز ${OFFER_SERVICE} يوم ${TEST_DATE}`,
      id: "msg-1",
    });
    messages.push({
      senderType: "AI",
      content: opts.offer ?? DEFAULT_OFFER,
      id: "msg-2",
    });

    const deps: ConversationEngineDeps = {
      businessRepository: {
        findByWhatsappNumber: async () => business,
        findById: async (id: string) => (id === BUSINESS_A ? business : null),
      },
      branchRepository: {
        findDefaultByBusiness: async () => branchRow,
        findByIdWithinBusiness: async (id: string, businessId: string) =>
          id === BRANCH_A && businessId === BUSINESS_A ? branchRow : null,
      },
      customerRepository: {
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () => ({ id: conversation.id }),
        findById: async () => conversation,
        create: async (input) => {
          conversation = {
            id: "conv-1",
            businessId: input.businessId,
            customerId: input.customerId,
            branchId: input.branchId,
            status: "AI_ACTIVE",
            assignedUserId: null,
            aiSummary: null,
            lastMessageAt: now,
            createdAt: now,
            updatedAt: now,
          } as unknown as Conversation;
          return conversation;
        },
        addMessage: async (input, workflow, ref) => {
          const row = ref
            ? [...ledger.values()].find((r) => r.claimId === ref.claimId)
            : undefined;
          if (row?.customerMessageId) {
            throw new InboundDuplicateError({
              conversationId: row.conversationId,
              customerMessageId: row.customerMessageId,
            });
          }
          const message = {
            id: `msg-${messages.length + 1}`,
            conversationId: input.conversationId,
            senderType: input.senderType,
            content: input.content,
            createdAt: input.createdAt ?? new Date(),
            updatedAt: new Date(),
          } as unknown as Message;
          messages.push({
            senderType: input.senderType,
            content: input.content,
            id: message.id,
          });
          if (row) {
            row.conversationId = input.conversationId;
            if (input.senderType === "CUSTOMER") {
              row.customerMessageId = message.id;
            }
          }
          if (workflow?.status) {
            conversation = {
              ...conversation,
              status: workflow.status,
            } as unknown as Conversation;
          }
          return message;
        },
        getMessages: async () =>
          [...messages].reverse() as unknown as Message[],
        update: async () => conversation,
        updateWorkflow: async (id, patch) => {
          if (conversation.id === id && patch.status) {
            conversation = {
              ...conversation,
              status: patch.status,
            } as unknown as Conversation;
          }
          return conversation;
        },
      },
      serviceRepository: {
        listByBusiness: async () => [...opts.services],
        findById: async (id: string) =>
          (serviceById.get(id) as unknown as never) ?? null,
      },
      inboundDedupeRepository: {
        claim: async (businessId: string, key: string) => {
          const ledgerKey = `${businessId}|${key}`;
          const existing = ledger.get(ledgerKey);
          if (existing) {
            if (existing.customerMessageId) {
              return {
                status: "duplicate" as const,
                claimId: existing.claimId,
                conversationId: existing.conversationId,
                customerMessageId: existing.customerMessageId,
              };
            }
            return { status: "reclaim" as const, claimId: existing.claimId };
          }
          const claimId = `claim-${ledger.size + 1}`;
          ledger.set(ledgerKey, {
            claimId,
            conversationId: null,
            customerMessageId: null,
          });
          return { status: "claimed" as const, claimId };
        },
      },
      usageRepository: {
        record: async (input) => input as unknown as UsageRecord,
      },
      providerRepository: {
        listEligibleForService: async (
          businessId: string,
          serviceId: string,
        ) => {
          if (businessId !== BUSINESS_A) return [] as unknown as never;
          if (!opts.services.some((service) => service.id === serviceId)) {
            return [] as unknown as never;
          }
          // Only seam-resolvable providers are eligible (CORE-02 skips
          // providers without an assignment seam).
          return providers.filter((provider) =>
            seams.has(provider.id),
          ) as unknown as never;
        },
        listAssignmentSeams: async (_businessId: string, ids: string[]) =>
          ids
            .filter((id) => SEAMS.has(id))
            .map((id) => ({
              providerId: id,
              userId: SEAMS.get(id) as string,
            })) as unknown as never,
      },
      appointmentRepository: {
        listBlockingByAssignees: async (
          _businessId: string,
          _date: string,
          assignedUserIds: string[],
        ) =>
          blocking.filter((row) =>
            assignedUserIds.includes(row.assignedUserId),
          ) as unknown as never,
        createWithConflictCheck: async (dto: unknown) => {
          createCalls.push(dto as CreateDto);
          if (opts.createImpl) return opts.createImpl(dto as CreateDto);
          return { id: `appt-${createCalls.length}` } as unknown as never;
        },
      } as unknown as ConversationEngineDeps["appointmentRepository"],
      ai: {
        providerName: "fake-ai",
        respond: async () => {
          state.aiCalls += 1;
          throw new Error("AI must not be called on the deterministic path");
        },
      },
      transport: {
        providerName: "fake-transport",
        send: async (input: { to: string; content: string }) => {
          transportSends.push({ to: input.to, content: input.content });
          return { provider: "fake-transport", delivered: true };
        },
      },
    };

    return {
      deps,
      messages,
      createCalls,
      transportSends,
      get aiCalls() {
        return state.aiCalls;
      },
      conversationStatus: () => conversation.status,
    };
  }

  async function runCase(
    opts: FixtureOptions,
    text: string,
    externalId: string,
  ): Promise<FixtureState & { result: InboundResult }> {
    const fixture = makeFixture(opts);
    const result = await engine.receiveInboundMessage(fixture.deps, {
      to: WHATSAPP_NUMBER,
      from: FROM,
      text,
      receivedAt: new Date().toISOString(),
      externalId,
    });
    return { ...fixture, result };
  }

  function conversationStatusOf(result: InboundResult): string | null {
    return "conversationStatus" in result ? result.conversationStatus : null;
  }
  function lastAiMessage(state: FixtureState): string {
    return (
      [...state.messages].reverse().find((m) => m.senderType === "AI")
        ?.content ?? ""
    );
  }
  function lastTransport(state: FixtureState): string {
    return state.transportSends[state.transportSends.length - 1]?.content ?? "";
  }

  const CLEAN_SERVICES = [
    serviceRow({ id: SERVICE_CLEAN, name: OFFER_SERVICE }),
  ];
  const INACTIVE_SERVICES = [
    ...CLEAN_SERVICES,
    serviceRow({ id: SERVICE_INACTIVE, name: "خدمة معطلة", isActive: false }),
  ];

  // 1 + 11 + 12 + 14 + 16: valid index → canonical creation + BOOKED + delivery
  {
    const run = await runCase(
      { services: CLEAN_SERVICES },
      "1",
      "wamid.BOOK-1",
    );
    const dto = run.createCalls[0];
    const confirmation = lastAiMessage(run);
    check(
      "11+12 اختيار صحيح برقم 1 → إنشاء قياسي بالقيم الخادمية + BOOKED",
      run.result.ok === true &&
        run.result.duplicate === false &&
        conversationStatusOf(run.result) === "BOOKED" &&
        run.createCalls.length === 1 &&
        dto?.businessId === BUSINESS_A &&
        dto?.customerId === "cust-1" &&
        dto?.serviceId === SERVICE_CLEAN &&
        dto?.branchId === BRANCH_A &&
        dto?.assignedUserId === U1 &&
        dto?.date === TEST_DATE &&
        dto?.startTime === "10:00" &&
        dto?.endTime === "10:30" &&
        dto?.status === "PENDING",
    );
    check(
      "13 التأكيد يُسلَّم عبر Transport بعد الإنشاء فقط",
      confirmation.includes("تم استلام طلب حجزك") &&
        confirmation.includes(OFFER_SERVICE) &&
        confirmation.includes(TEST_DATE) &&
        confirmation.includes("د. سارة") &&
        lastTransport(run) === confirmation &&
        "delivery" in run.result &&
        run.result.delivery?.delivered === true,
    );
    check("17 المسار الحتمي لا يستهلك أي نداء LLM", run.aiCalls === 0);
  }

  // 2: valid time selection
  {
    const run = await runCase(
      { services: CLEAN_SERVICES },
      "10:00",
      "wamid.BOOK-2",
    );
    check(
      "2 اختيار بوقت 10:00 (فريد) → BOOKED",
      run.result.ok === true &&
        conversationStatusOf(run.result) === "BOOKED" &&
        run.createCalls.length === 1 &&
        run.createCalls[0]?.startTime === "10:00" &&
        run.createCalls[0]?.assignedUserId === U1 &&
        run.aiCalls === 0,
    );
  }

  // 3: provider-name selection
  {
    const run = await runCase(
      { services: CLEAN_SERVICES },
      "د. سارة",
      "wamid.BOOK-3",
    );
    check(
      "3 اختيار مزود بالاسم د. سارة → BOOKED (نطاق المزود)",
      run.result.ok === true &&
        conversationStatusOf(run.result) === "BOOKED" &&
        run.createCalls.length === 1 &&
        run.createCalls[0]?.assignedUserId === U1 &&
        run.aiCalls === 0,
    );
  }

  // 4: Arabic-normalized selection forms
  {
    const indexRun = await runCase(
      { services: CLEAN_SERVICES },
      "١",
      "wamid.BOOK-4a",
    );
    const timeRun = await runCase(
      { services: CLEAN_SERVICES },
      "١٠:٠٠",
      "wamid.BOOK-4b",
    );
    check(
      "4 اختيار عربي مطبَّع (١ / ١٠:٠٠) → BOOKED",
      conversationStatusOf(indexRun.result) === "BOOKED" &&
        conversationStatusOf(timeRun.result) === "BOOKED" &&
        indexRun.createCalls.length === 1 &&
        timeRun.createCalls.length === 1 &&
        indexRun.aiCalls === 0 &&
        timeRun.aiCalls === 0,
    );
  }

  // 5: stale offered option → refreshed options, zero write
  {
    const run = await runCase(
      {
        services: CLEAN_SERVICES,
        blocking: [
          ...DEFAULT_BLOCKING,
          { assignedUserId: U1, startTime: "10:00", endTime: "10:30" },
        ],
      },
      "1",
      "wamid.BOOK-5",
    );
    const message = lastAiMessage(run);
    check(
      "5 اختيار قديم (سارة 10:00 لم تعد متاحة) → خيارات محدثة بلا كتابة",
      run.result.ok === true &&
        conversationStatusOf(run.result) === "AI_ACTIVE" &&
        run.createCalls.length === 0 &&
        run.aiCalls === 0 &&
        message.includes("لم يعد متاحاً") &&
        message.includes("تتوفر المواعيد التالية"),
    );
  }

  // 6: invalid selections → clarification, zero write
  {
    const indexRun = await runCase(
      { services: CLEAN_SERVICES },
      "5",
      "wamid.BOOK-6a",
    );
    const timeRun = await runCase(
      { services: CLEAN_SERVICES },
      "19:00",
      "wamid.BOOK-6b",
    );
    check(
      "6 اختيار غير صالح (رقم 5 / وقت 19:00) → توضيح بلا كتابة",
      conversationStatusOf(indexRun.result) === "AI_ACTIVE" &&
        indexRun.createCalls.length === 0 &&
        lastAiMessage(indexRun).includes("غير صالح") &&
        conversationStatusOf(timeRun.result) === "AI_ACTIVE" &&
        timeRun.createCalls.length === 0 &&
        lastAiMessage(timeRun).includes("الوقت المحدد غير متاح"),
    );
  }

  // 7: ambiguous selections → clarification, zero write
  {
    const timeRun = await runCase(
      { services: CLEAN_SERVICES, blocking: [] },
      "10:00",
      "wamid.BOOK-7a",
    );
    const ambiguousProviders: ProviderRow[] = [
      { id: P1, displayName: "د. أحمد", user: { name: "أحمد" } },
      { id: P2, displayName: "د. أحمد علي", user: { name: "أحمد علي" } },
    ];
    const providerRun = await runCase(
      { services: CLEAN_SERVICES, providers: ambiguousProviders },
      "أحمد",
      "wamid.BOOK-7b",
    );
    check(
      "7 اختيار ملتبس (وقت مشترك / مزود مشترك) → توضيح بلا كتابة",
      conversationStatusOf(timeRun.result) === "AI_ACTIVE" &&
        timeRun.createCalls.length === 0 &&
        lastAiMessage(timeRun).includes("أكثر من موعد") &&
        conversationStatusOf(providerRun.result) === "AI_ACTIVE" &&
        providerRun.createCalls.length === 0 &&
        lastAiMessage(providerRun).includes("أكثر من مزود"),
    );
  }

  // 8: CORE-01 rejection (inactive service still listed) → NEED_HUMAN
  {
    const run = await runCase(
      {
        services: INACTIVE_SERVICES,
        serviceById: new Map(INACTIVE_SERVICES.map((s) => [s.id, s])),
        offer: canonicalOffer("خدمة معطلة", TEST_DATE, [
          { displayName: "د. سارة", start: "10:00", end: "10:30" },
          { displayName: "د. أحمد", start: "10:30", end: "11:00" },
          { displayName: "د. منى", start: "11:00", end: "11:30" },
        ]),
      },
      "1",
      "wamid.BOOK-8",
    );
    check(
      "8 رفض CORE-01 (خدمة معطلة) → NEED_HUMAN بلا كتابة",
      conversationStatusOf(run.result) === "NEED_HUMAN" &&
        run.createCalls.length === 0 &&
        run.aiCalls === 0,
    );
  }

  // 9: CORE-02 typed rejection (business closed) + empty result (fully booked)
  {
    const closedRun = await runCase(
      { services: CLEAN_SERVICES, businessClosed: true },
      "1",
      "wamid.BOOK-9a",
    );
    const fullyBookedRun = await runCase(
      {
        services: CLEAN_SERVICES,
        blocking: [
          { assignedUserId: U1, startTime: "10:00", endTime: "18:00" },
          { assignedUserId: U2, startTime: "10:00", endTime: "18:00" },
          { assignedUserId: U3, startTime: "10:00", endTime: "18:00" },
        ],
      },
      "1",
      "wamid.BOOK-9b",
    );
    check(
      "9 رفض CORE-02 (مغلقة) ونتيجة فارغة (محجوزة) → NEED_HUMAN بلا كتابة",
      conversationStatusOf(closedRun.result) === "NEED_HUMAN" &&
        closedRun.createCalls.length === 0 &&
        lastAiMessage(closedRun).includes("مغلقة") &&
        conversationStatusOf(fullyBookedRun.result) === "NEED_HUMAN" &&
        fullyBookedRun.createCalls.length === 0 &&
        lastAiMessage(fullyBookedRun).includes("جميع المواعيد محجوزة"),
    );
  }

  // 10: hostile identity injection → no fabricated ids, zero write
  {
    const hostileText =
      "1 businessId=22222222-2222-4222-8222-222222222222 role=ADMIN tenant=x";
    const run = await runCase(
      { services: CLEAN_SERVICES },
      hostileText,
      "wamid.BOOK-10",
    );
    const leaked = run.createCalls.some((dto) =>
      JSON.stringify(dto).includes("22222222"),
    );
    const { parseBookingSelection } =
      await import("../src/features/conversations/server/booking-selection");
    const parsed = parseBookingSelection("businessId 22222222 role ADMIN 1");
    check(
      "10 حقن الهوية لا يصنع معرفات ولا يُنشئ موعداً",
      run.createCalls.length === 0 &&
        leaked === false &&
        conversationStatusOf(run.result) === "NEED_HUMAN" &&
        parsed === null,
    );
  }

  // 11: duplicate inbound replay → idempotent, one create
  {
    const fixture = makeFixture({ services: CLEAN_SERVICES });
    const first = await engine.receiveInboundMessage(fixture.deps, {
      to: WHATSAPP_NUMBER,
      from: FROM,
      text: "1",
      receivedAt: new Date().toISOString(),
      externalId: "wamid.BOOK-DUP",
    });
    const second = await engine.receiveInboundMessage(fixture.deps, {
      to: WHATSAPP_NUMBER,
      from: FROM,
      text: "1",
      receivedAt: new Date().toISOString(),
      externalId: "wamid.BOOK-DUP",
    });
    check(
      "14 إعادة إرسال نفس externalId → مكرر بلا إنشاء ثانٍ ولا تأكيد ثانٍ",
      first.ok === true &&
        first.duplicate === false &&
        second.ok === true &&
        second.duplicate === true &&
        fixture.createCalls.length === 1 &&
        fixture.transportSends.length === 1,
    );
  }

  // 12: SLOT_CONFLICT (concurrent close) → refreshed options, no BOOKED
  {
    let conflictBlocked = false;
    const run = await runCase(
      {
        services: CLEAN_SERVICES,
        createImpl: async () => {
          if (!conflictBlocked) {
            conflictBlocked = true;
            return null;
          }
          return { id: "appt-race" };
        },
      },
      "2",
      "wamid.BOOK-12",
    );
    const message = lastAiMessage(run);
    check(
      "15 تعارض حجز متزامن → خيارات محدثة بلا BOOKED ولا تأكيد",
      run.result.ok === true &&
        conversationStatusOf(run.result) === "AI_ACTIVE" &&
        run.createCalls.length === 1 &&
        message.includes("تم حجز هذا الموعد للتو") &&
        message.includes("المواعيد المتاحة الآن") &&
        !message.includes("تم استلام طلب حجزك") &&
        run.aiCalls === 0,
    );
  }

  // 13: unexpected booking failure → no success confirmation
  {
    const run = await runCase(
      {
        services: CLEAN_SERVICES,
        createImpl: async () => {
          throw new Error("DB_WRITE_FAILURE");
        },
      },
      "1",
      "wamid.BOOK-13",
    );
    const message = lastAiMessage(run);
    check(
      "16 فشل إنشاء غير متوقع → NEED_HUMAN بلا تأكيد نجاح",
      conversationStatusOf(run.result) === "NEED_HUMAN" &&
        run.createCalls.length === 1 &&
        message.includes("تعذر إتمام الحجز") &&
        !message.includes("تم استلام طلب حجزك") &&
        !message.includes("تم تأكيد حجزك"),
    );
  }

  // 14: confirmation-mode status (manual PENDING vs automatic CONFIRMED)
  {
    const manualRun = await runCase(
      { services: CLEAN_SERVICES, confirmationMode: "manual" },
      "1",
      "wamid.BOOK-14a",
    );
    const autoRun = await runCase(
      { services: CLEAN_SERVICES, confirmationMode: "automatic" },
      "1",
      "wamid.BOOK-14b",
    );
    check(
      "12b وضع التأكيد من الحقل الخادمي (manual → PENDING / automatic → CONFIRMED)",
      manualRun.createCalls[0]?.status === "PENDING" &&
        lastAiMessage(manualRun).includes("تم استلام طلب حجزك") &&
        autoRun.createCalls[0]?.status === "CONFIRMED" &&
        lastAiMessage(autoRun).includes("تم تأكيد حجزك"),
    );
  }

  // 15: non-selection text that matches no provider → AI turn, no booking
  {
    const run = await runCase(
      { services: CLEAN_SERVICES },
      "تمام",
      "wamid.BOOK-15",
    );
    check(
      "17b رسالة ليست اختياراً (لا تطابق مزوداً) → مسار AI بلا حجز",
      conversationStatusOf(run.result) === "NEED_HUMAN" &&
        run.createCalls.length === 0 &&
        run.aiCalls === 1,
    );
  }

  // 16: BOOKED conversation is not AI-eligible → replay-safe, no new booking
  {
    const run = await runCase(
      { services: CLEAN_SERVICES, conversationStatus: "BOOKED" },
      "1",
      "wamid.BOOK-16",
    );
    check(
      "17c محادثة BOOKED → لا حجز ثانٍ ولا تأكيد جديد",
      run.result.ok === true &&
        run.result.duplicate === false &&
        "assistantAction" in run.result &&
        run.result.assistantAction === "DEFERRED_TO_STAFF" &&
        run.createCalls.length === 0 &&
        run.transportSends.length === 0,
    );
  }

  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nثوابت إغلاق حلقة الحجز صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
