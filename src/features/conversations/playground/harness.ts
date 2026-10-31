/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Test Harness & In-Memory Environment
 * Provides isolated, side-effect-free execution for Hybrid B and Full Agent C.
 */

import type { RequiredSemanticCapability } from "@/features/conversations/server/ai-contract";
import type { ConversationEngineDeps } from "@/features/conversations/server/conversation-engine";
import type { ConversationStateStore } from "@/features/conversations/server/conversation-state-store";
import { renderTelegramInlineKeyboard } from "@/server/integrations/telegram/telegram-presentation";
import type {
  ConversationStateRow,
  ConversationStateSaveResult,
} from "@/server/repositories/conversation-state.repository";
import type {
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
} from "@/types/domain";

export class InMemoryConversationStateStore implements ConversationStateStore {
  public rows = new Map<
    string,
    { businessId: string; revision: number; state: unknown; updatedAt: Date }
  >();

  constructor(private readonly clock?: () => Date) {}

  private now(): Date {
    return this.clock ? this.clock() : new Date();
  }

  async load(
    businessId: string,
    conversationId: string,
  ): Promise<ConversationStateRow | null> {
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
  ): Promise<ConversationStateSaveResult> {
    const existing = this.rows.get(conversationId);
    if (expectedRevision === null) {
      if (existing) return { status: "conflict" as const };
      this.rows.set(conversationId, {
        businessId,
        revision: 1,
        state: JSON.parse(JSON.stringify(state)),
        updatedAt: this.now(),
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
      updatedAt: this.now(),
    });
    return { status: "saved" as const, revision: nextRevision };
  }

  clear(): void {
    this.rows.clear();
  }
}

export function sanitizeHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const entries =
    headers instanceof Headers
      ? Array.from(headers.entries())
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [key, value] of entries) {
    const lower = key.toLowerCase();
    if (
      lower.includes("auth") ||
      lower.includes("key") ||
      lower.includes("secret") ||
      lower.includes("token") ||
      lower.includes("cookie")
    ) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

export const PLAYGROUND_IDS = {
  BIZ_ID: "11111111-1111-4111-8111-111111111111",
  BRANCH_ID: "44444444-4444-4444-8444-444444444444",
  CUST_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  USER_P1: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
  USER_P2: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
  PROV_1: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  PROV_2: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  SERV_DENTAL: "33333333-3333-4333-8333-333333333331",
  SERV_CLEAN: "33333333-3333-4333-8333-333333333332",
};

export type CapturedAvailabilityQuery = {
  businessId: string;
  date: string;
  assigneeIds: string[];
};

export type CapturedAppointmentWrite = {
  businessId: string;
  branchId: string;
  customerId: string;
  serviceId: string;
  providerId?: string | null;
  assignedUserId?: string | null;
  date: Date;
  startTime: string;
  endTime: string;
  status: string;
  notes?: string | null;
  followUpRequestId?: string | null;
};

export type CapturedHttpAttempt = {
  index: number;
  url: string;
  method: string;
  status: number;
  durationMs: number;
  timestamp: string;
  sanitizedHeaders: Record<string, string>;
  error?: string | null;
  responseBodyPreview?: string;
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  } | null;
};

export type PlaygroundHarnessOptions = {
  businessConfig?: Partial<Business>;
  customServices?: any[];
  customProviders?: any[];
  initialAppointments?: any[];
  priorAppointment?: boolean;
  channel?: "WHATSAPP" | "TELEGRAM";
  todayRef?: string;
  conversationStatus?: any;
  assignedUserId?: string | null;
  stateStore?: InMemoryConversationStateStore;
  customAi?: any;
  requiredSemanticCapability?: RequiredSemanticCapability | null;
};

export type DeliveredOutbound = {
  to: string;
  body: string;
  channel: "WHATSAPP" | "TELEGRAM";
  choices?: any;
  replyMarkup?: any;
  buttons?: Array<{ label: string; payload: string }>;
  sentAt: Date;
};

export type PlaygroundHarness = {
  deps: ConversationEngineDeps;
  business: Business;
  customer: Customer;
  conversation: Conversation;
  messages: Message[];
  appointments: any[];
  deliveredOutbound: DeliveredOutbound[];
  capturedAvailabilityQueries: CapturedAvailabilityQuery[];
  capturedAppointmentWrites: CapturedAppointmentWrite[];
  capturedHttpAttempts: CapturedHttpAttempt[];
  stateStore: InMemoryConversationStateStore;
  dedupeLedger: Set<string>;
  llmStats: {
    callCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  options: PlaygroundHarnessOptions;
  getVirtualNow: () => Date;
  setVirtualNow: (date: Date) => void;
  resetConversation: () => void;
  reset: () => void;
};

export function createPlaygroundHarness(
  options: PlaygroundHarnessOptions = {},
): PlaygroundHarness {
  const channel = options.channel ?? "WHATSAPP";
  const todayRefStr = options.todayRef ?? "2026-10-20"; // Tuesday
  let virtualNow = new Date(`${todayRefStr}T10:00:00.000Z`);

  function openWeek() {
    const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;
    const hours: any = {};
    for (const d of days) {
      hours[d] = { open: "09:00", close: "17:00", closed: false };
    }
    return hours;
  }

  const business: Business = {
    id: PLAYGROUND_IDS.BIZ_ID,
    name: "عيادة النور لطب الأسنان",
    slug: "al-noor",
    timezone: "Africa/Cairo",
    workingHours: openWeek(),
    slotDurationMinutes: 30,
    bookingLeadTimeHours: 1,
    bookingHorizonDays: 30,
    bookingIntervalMinutes: 30,
    confirmationMode: "automatic",
    appointmentTimeDisplay: "START_ONLY",
    defaultBranchId: PLAYGROUND_IDS.BRANCH_ID,
    whatsappNumber: "+201001111111",
    isActive: true,
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
    faqs: [
      {
        question: "مواعيد العمل",
        answer:
          "مواعيد العمل لدينا من السبت إلى الجمعة من الساعة 9:00 صباحاً حتى 5:00 مساءً.",
      },
      {
        question: "عنوان ومكان العيادة",
        answer:
          "عنوان العيادة: الفرع الرئيسي - القاهرة. شرفنا بزيارتك في أي وقت.",
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...options.businessConfig,
  } as any;

  const phone = channel === "TELEGRAM" ? "tg:998877" : "+201001234567";

  const customer: Customer = {
    id: PLAYGROUND_IDS.CUST_ID,
    businessId: business.id,
    name: "أحمد محمود",
    phone,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;

  const conversation: Conversation = {
    id: `conv-play-${Date.now()}`,
    businessId: business.id,
    customerId: customer.id,
    channel,
    status: (options.conversationStatus ?? "AI_ACTIVE") as ConversationStatus,
    assignedUserId: options.assignedUserId ?? null,
    branchId: business.defaultBranchId,
    unreadCount: 0,
    lastMessageAt: virtualNow,
    aiSummary: null,
    createdAt: virtualNow,
    updatedAt: virtualNow,
  } as any;

  const messages: Message[] = [];
  const appointments: any[] = [];
  const deliveredOutbound: DeliveredOutbound[] = [];
  const dedupeLedger = new Set<string>();
  const stateStore =
    options.stateStore ?? new InMemoryConversationStateStore(() => virtualNow);
  const capturedAvailabilityQueries: CapturedAvailabilityQuery[] = [];
  const capturedAppointmentWrites: CapturedAppointmentWrite[] = [];
  const capturedHttpAttempts: CapturedHttpAttempt[] = [];

  const llmStats = {
    callCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  if (options.priorAppointment) {
    appointments.push({
      id: "appt-prior-1",
      businessId: business.id,
      branchId: business.defaultBranchId,
      customerId: customer.id,
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      providerId: PLAYGROUND_IDS.PROV_1,
      assignedUserId: PLAYGROUND_IDS.USER_P1,
      date: new Date("2026-10-10T00:00:00Z"),
      startTime: "10:00",
      endTime: "10:30",
      status: "CONFIRMED",
      notes: null,
      followUpRequestId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });
  }

  if (options.initialAppointments) {
    appointments.push(...options.initialAppointments);
  }

  const services = (
    options.customServices ?? [
      {
        id: PLAYGROUND_IDS.SERV_DENTAL,
        businessId: business.id,
        name: "كشف أسنان",
        durationMinutes: 30,
        price: 200,
        currency: "EGP",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: PLAYGROUND_IDS.SERV_CLEAN,
        businessId: business.id,
        name: "تنظيف أسنان",
        durationMinutes: 30,
        price: 300,
        currency: "EGP",
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
  ).map((s) => ({
    ...s,
    businessId: s.businessId ?? business.id,
    isActive: s.isActive ?? true,
  }));

  const providers = (
    options.customProviders ?? [
      {
        id: PLAYGROUND_IDS.PROV_1,
        businessId: business.id,
        userId: PLAYGROUND_IDS.USER_P1,
        name: "د. أحمد سامي",
        displayName: "د. أحمد سامي",
        title: "طبيب أسنان",
        bio: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: PLAYGROUND_IDS.PROV_2,
        businessId: business.id,
        userId: PLAYGROUND_IDS.USER_P2,
        name: "د. سارة عادل",
        displayName: "د. سارة عادل",
        title: "طبيبة أسنان",
        bio: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]
  ).map((p) => ({
    ...p,
    businessId: p.businessId ?? business.id,
    isActive: p.isActive ?? true,
  }));

  const deps: ConversationEngineDeps = {
    businessRepository: {
      findById: async (id: string) => (id === business.id ? business : null),
      findBySlug: async () => null,
      findByWhatsAppNumber: async () => business,
      findByWhatsappNumber: async () => business,
      findByTelegramBotToken: async () => business,
    } as any,
    branchRepository: {
      findById: async () => ({
        id: business.defaultBranchId ?? PLAYGROUND_IDS.BRANCH_ID,
        businessId: business.id,
        name: "الفرع الرئيسي",
      }),
      findByIdWithinBusiness: async (brId: string, bId: string) =>
        bId === business.id ? { id: brId, businessId: bId } : null,
      findDefaultByBusiness: async () => ({
        id: business.defaultBranchId ?? PLAYGROUND_IDS.BRANCH_ID,
        businessId: business.id,
        name: "الفرع الرئيسي",
      }),
      listByBusiness: async () => [],
    } as any,
    customerRepository: {
      findById: async () => customer,
      findByPhone: async () => customer,
      upsertByPhone: async () => customer,
      touchConversation: async () => customer,
    } as any,
    conversationRepository: {
      findById: async () => conversation,
      findByCustomer: async () => conversation,
      findLatestByCustomer: async () => ({ id: conversation.id }),
      create: async () => conversation,
      update: async (_id: string, patch: any) => {
        Object.assign(conversation, patch);
        return conversation;
      },
      updateWorkflow: async (_id: string, patch: any) => {
        Object.assign(conversation, patch);
        return conversation;
      },
      addMessage: async (input: any, workflow?: any) => {
        if (workflow?.status) conversation.status = workflow.status;
        const m = {
          id: `msg-${messages.length + 1}`,
          conversationId: conversation.id,
          senderType: input.senderType,
          content: input.content,
          displayText: input.displayText ?? null,
          metadata: input.metadata ?? null,
          sentAt: virtualNow,
          createdAt: virtualNow,
        } as any;
        messages.push(m);
        return m;
      },
      getMessages: async () => [...messages].reverse(),
    } as any,
    serviceRepository: {
      listByBusiness: async () => services,
      findById: async (id: string) => services.find((s) => s.id === id) ?? null,
      findByIdWithinBusiness: async (sId: string, bId: string) =>
        bId === business.id
          ? (services.find((s) => s.id === sId) ?? null)
          : null,
    } as any,
    inboundDedupeRepository: {
      claim: async (businessId: string, key: string) => {
        const ledgerKey = `${businessId}|${key}`;
        if (dedupeLedger.has(ledgerKey)) {
          return {
            status: "duplicate" as const,
            claimId: "claim-dup",
            conversationId: null,
            customerMessageId: null,
          };
        }
        dedupeLedger.add(ledgerKey);
        return {
          status: "claimed" as const,
          claimId: `claim-${dedupeLedger.size}`,
        };
      },
      release: async () => {},
      complete: async () => {},
    } as any,
    usageRepository: {
      record: async () => ({ id: "usage-1" }),
    } as any,
    attentionRepository: {
      open: async () => ({ id: "att-1" }) as any,
    } as any,
    knowledgeGapRepository: {
      record: async () => {},
    } as any,
    turnTelemetry: {
      record: async () => {},
    } as any,
    providerRepository: {
      listEligibleForService: async (_bId: string, sId: string) => {
        const serv = services.find((s) => s.id === sId);
        if (!serv) return [];
        return providers;
      },
      findByIdWithinBusiness: async (pId: string, bId: string) => {
        if (bId !== business.id) return null;
        return providers.find((p) => p.id === pId) ?? null;
      },
      listAssignmentSeams: async () =>
        providers.map((p) => ({
          providerId: p.id,
          userId: p.userId,
          isActive: true,
        })),
    } as any,
    conversationStateRepository: stateStore,
    requiredSemanticCapability:
      options.requiredSemanticCapability !== undefined
        ? options.requiredSemanticCapability
        : "structured_turn",
    appointmentRepository: {
      listBlockingByAssignees: async (
        businessId: string,
        date: string,
        assigneeIds: string[],
      ) => {
        capturedAvailabilityQueries.push({ businessId, date, assigneeIds });
        return appointments.map((a) => ({
          id: a.id,
          assignedUserId: a.assignedUserId ?? "default-user",
          providerId: a.providerId ?? undefined,
          date:
            a.date instanceof Date
              ? a.date.toISOString().slice(0, 10)
              : String(a.date),
          startTime: a.startTime,
          endTime: a.endTime,
          status: a.status,
        }));
      },
      createWithConflictCheck: async (dto: any) => {
        capturedAppointmentWrites.push({
          businessId: dto.businessId,
          branchId: dto.branchId,
          customerId: dto.customerId,
          serviceId: dto.serviceId,
          providerId: dto.providerId ?? null,
          assignedUserId: dto.assignedUserId ?? null,
          date:
            dto.date instanceof Date
              ? dto.date
              : new Date(`${dto.date}T00:00:00Z`),
          startTime: dto.startTime,
          endTime: dto.endTime,
          status: dto.status,
          notes: dto.notes ?? null,
          followUpRequestId: dto.followUpRequestId ?? null,
        });
        const appt = {
          id: `appt-${appointments.length + 1}`,
          businessId: dto.businessId,
          branchId: dto.branchId,
          customerId: dto.customerId,
          serviceId: dto.serviceId,
          providerId: dto.providerId ?? null,
          assignedUserId: dto.assignedUserId ?? null,
          date: new Date(`${dto.date}T00:00:00Z`),
          startTime: dto.startTime,
          endTime: dto.endTime,
          status: dto.status,
          notes: dto.notes ?? null,
          followUpRequestId: dto.followUpRequestId ?? null,
          createdAt: virtualNow,
          updatedAt: virtualNow,
          deletedAt: null,
        } as any;
        appointments.push(appt);
        return appt;
      },
      listRecentByCustomer: async (_bId: string, _cId: string, take = 3) => {
        return appointments.slice(-take);
      },
    } as any,
    followUpRequestRepository: {
      getEligibleForChannel: async () => [],
      findById: async () => null,
      updateStatus: async () => {},
    } as any,
    ai:
      options.customAi ??
      ({
        providerName: "PLAYGROUND_AI",
        respond: async (req: any) => {
          llmStats.callCount++;
          llmStats.promptTokens += 180;
          llmStats.completionTokens += 60;
          llmStats.totalTokens += 240;
          const { deterministicConversationAi } =
            await import("@/features/conversations/server/conversation-ai");
          return deterministicConversationAi.respond(req);
        },
      } as any),
    transport: {
      providerName: "PLAYGROUND_TRANSPORT",
      send: async (out: any) => {
        const replyMarkup =
          out.replyMarkup ??
          (channel === "TELEGRAM" && out.choices
            ? renderTelegramInlineKeyboard(out.choices)
            : null);
        deliveredOutbound.push({
          to: out.to,
          body: out.content ?? out.body ?? out.text ?? "",
          channel,
          replyMarkup,
          choices: out.choices ?? null,
          buttons: out.buttons ?? [],
          sentAt: virtualNow,
        });
        return { provider: "PLAYGROUND_TRANSPORT", delivered: true };
      },
    } as any,
  };

  const reset = () => {
    messages.length = 0;
    appointments.length = 0;
    if (options.priorAppointment) {
      appointments.push({
        id: "appt-prior-1",
        businessId: business.id,
        branchId: business.defaultBranchId,
        customerId: customer.id,
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        providerId: PLAYGROUND_IDS.PROV_1,
        assignedUserId: PLAYGROUND_IDS.USER_P1,
        date: new Date("2026-10-10T00:00:00Z"),
        startTime: "10:00",
        endTime: "10:30",
        status: "CONFIRMED",
        notes: null,
        followUpRequestId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      });
    }
    if (options.initialAppointments) {
      appointments.push(...options.initialAppointments);
    }
    deliveredOutbound.length = 0;
    capturedAvailabilityQueries.length = 0;
    capturedAppointmentWrites.length = 0;
    capturedHttpAttempts.length = 0;
    dedupeLedger.clear();
    stateStore.clear();
    conversation.status = (options.conversationStatus ??
      "AI_ACTIVE") as ConversationStatus;
    conversation.assignedUserId = options.assignedUserId ?? null;
    llmStats.callCount = 0;
    llmStats.promptTokens = 0;
    llmStats.completionTokens = 0;
    llmStats.totalTokens = 0;
  };

  return {
    deps,
    business,
    customer,
    conversation,
    messages,
    appointments,
    deliveredOutbound,
    capturedAvailabilityQueries,
    capturedAppointmentWrites,
    capturedHttpAttempts,
    stateStore,
    dedupeLedger,
    llmStats,
    options,
    getVirtualNow: () => virtualNow,
    setVirtualNow: (date: Date) => {
      virtualNow = date;
    },
    resetConversation: reset,
    reset,
  };
}
