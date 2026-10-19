/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Test Harness & In-Memory Environment
 * Provides isolated, side-effect-free execution for Hybrid B and Full Agent C.
 */

import type { ConversationEngineDeps } from "@/features/conversations/server/conversation-engine";
import type {
  Business,
  Conversation,
  ConversationStatus,
  Customer,
  Message,
} from "@/types/domain";

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

export type PlaygroundHarnessOptions = {
  businessConfig?: Partial<Business>;
  customServices?: any[];
  customProviders?: any[];
  initialAppointments?: any[];
  priorAppointment?: boolean;
  channel?: "WHATSAPP" | "TELEGRAM";
  todayRef?: string;
};

export type DeliveredOutbound = {
  to: string;
  body: string;
  channel: "WHATSAPP" | "TELEGRAM";
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
    defaultBranchId: PLAYGROUND_IDS.BRANCH_ID,
    whatsappNumber: "+201001111111",
    isActive: true,
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
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
    status: "AI_ACTIVE" as ConversationStatus,
    assignedUserId: null,
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
    appointmentRepository: {
      listBlockingByAssignees: async () =>
        appointments.map((a) => ({
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
        })),
      createWithConflictCheck: async (dto: any) => {
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
    ai: {
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
    } as any,
    transport: {
      providerName: "PLAYGROUND_TRANSPORT",
      send: async (out: any) => {
        deliveredOutbound.push({
          to: out.to,
          body: out.content ?? out.body ?? out.text ?? "",
          channel,
          replyMarkup: out.replyMarkup ?? null,
          buttons: out.buttons ?? [],
          sentAt: virtualNow,
        });
        return { provider: "PLAYGROUND_TRANSPORT", delivered: true };
      },
    } as any,
  };

  return {
    deps,
    business,
    customer,
    conversation,
    messages,
    appointments,
    deliveredOutbound,
    dedupeLedger,
    llmStats,
    options,
    getVirtualNow: () => virtualNow,
    setVirtualNow: (date: Date) => {
      virtualNow = date;
    },
    resetConversation: () => {
      messages.length = 0;
      deliveredOutbound.length = 0;
      conversation.status = "AI_ACTIVE" as ConversationStatus;
    },
  };
}
