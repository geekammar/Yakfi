import { refreshConversationDetail } from "@/features/conversations/actions/conversation-refresh-actions";
import { getConversationRefresh } from "@/features/conversations/server/conversation-queries";

import { beforeEach, describe, expect, it, vi } from "vitest";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const BUSINESS_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const {
  appointmentRepository,
  conversationRepository,
  getSession,
  operatorAttentionRepository,
  userRepository,
} = vi.hoisted(() => ({
  appointmentRepository: {
    listRecentByCustomer: vi.fn(),
  },
  conversationRepository: {
    findDetailByBusiness: vi.fn(),
  },
  getSession: vi.fn(),
  operatorAttentionRepository: {
    findOpen: vi.fn(),
    open: vi.fn(),
    resolve: vi.fn(),
    resolveByConversation: vi.fn(),
  },
  userRepository: {
    findById: vi.fn(),
    listByBusiness: vi.fn(),
  },
}));

vi.mock("@/server/repositories", () => ({
  appointmentRepository,
  conversationRepository,
  operatorAttentionRepository,
  userRepository,
}));

vi.mock("@/features/conversations/server/interaction-display", () => ({
  resolveDisplayForMessage: ({
    displayText,
  }: {
    displayText?: string | null;
  }) => displayText ?? null,
}));

vi.mock("@/server/auth/guards", () => ({
  getSession,
  isPlatformOperator: (user: { accountType?: string | null }) =>
    user.accountType === "PLATFORM",
}));

function detailFor(businessId = BUSINESS_ID) {
  return {
    id: CONVERSATION_ID,
    businessId,
    status: "AI_ACTIVE" as const,
    aiSummary: "ملخص الخادم",
    customerId: "44444444-4444-4444-8444-444444444444",
    customer: {
      id: "44444444-4444-4444-8444-444444444444",
      name: "عميل المحادثة",
      phone: "+201000000000",
      notes: null,
    },
    assignedTo: { id: USER_ID, name: "موظف", image: null },
    messages: [
      {
        id: "55555555-5555-4555-8555-555555555555",
        senderType: "CUSTOMER" as const,
        content: "رسالة العميل",
        displayText: null,
        metadata: null,
        createdAt: new Date("2026-11-01T10:00:00.000Z"),
      },
    ],
  };
}

function activeBusinessUser() {
  return {
    id: USER_ID,
    businessId: BUSINESS_ID,
    role: "ADMIN" as const,
    isActive: true,
  };
}

describe("getConversationRefresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationRepository.findDetailByBusiness.mockResolvedValue(detailFor());
    appointmentRepository.listRecentByCustomer.mockResolvedValue([]);
    userRepository.listByBusiness.mockResolvedValue([
      { id: USER_ID, name: "موظف", image: null, isActive: true },
    ]);
  });

  it("is a tenant-scoped pure read that returns only refresh fields", async () => {
    const result = await getConversationRefresh(BUSINESS_ID, CONVERSATION_ID);

    expect(conversationRepository.findDetailByBusiness).toHaveBeenCalledWith(
      CONVERSATION_ID,
      BUSINESS_ID,
    );
    expect(operatorAttentionRepository.findOpen).toHaveBeenCalledWith(
      CONVERSATION_ID,
    );
    expect(operatorAttentionRepository.resolve).not.toHaveBeenCalled();
    expect(operatorAttentionRepository.open).not.toHaveBeenCalled();
    expect(
      operatorAttentionRepository.resolveByConversation,
    ).not.toHaveBeenCalled();

    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      id: CONVERSATION_ID,
      status: "AI_ACTIVE",
      aiSummary: "ملخص الخادم",
      assignedUser: { id: USER_ID },
      attentionReason: null,
      attentionCause: null,
    });
    expect(result).not.toHaveProperty("customer");
    expect(result).not.toHaveProperty("currentUserId");
  });

  it("reads the current open attention without acknowledging it", async () => {
    operatorAttentionRepository.findOpen.mockResolvedValueOnce({
      id: "attention-1",
      conversationId: CONVERSATION_ID,
      reason: "AI_HANDOFF",
      cause: "KNOWLEDGE_GAP_UNRESOLVED",
      createdAt: "2026-11-01T10:05:00.000Z",
    });

    const result = await getConversationRefresh(BUSINESS_ID, CONVERSATION_ID);

    expect(result).toMatchObject({
      attentionReason: "AI_HANDOFF",
      attentionCause: "KNOWLEDGE_GAP_UNRESOLVED",
    });
    expect(operatorAttentionRepository.findOpen).toHaveBeenCalledWith(
      CONVERSATION_ID,
    );
    expect(operatorAttentionRepository.resolve).not.toHaveBeenCalled();
    expect(operatorAttentionRepository.open).not.toHaveBeenCalled();
    expect(
      operatorAttentionRepository.resolveByConversation,
    ).not.toHaveBeenCalled();
  });

  it("rejects a cross-tenant conversation without any write or attention read", async () => {
    conversationRepository.findDetailByBusiness.mockResolvedValueOnce(null);

    const result = await getConversationRefresh(
      "99999999-9999-4999-8999-999999999999",
      CONVERSATION_ID,
    );

    expect(result).toBeNull();
    expect(operatorAttentionRepository.findOpen).not.toHaveBeenCalled();
    expect(operatorAttentionRepository.resolve).not.toHaveBeenCalled();
    expect(operatorAttentionRepository.open).not.toHaveBeenCalled();
  });
});

describe("refreshConversationDetail authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({
      user: {
        id: USER_ID,
        isActive: true,
        accountType: "BUSINESS",
      },
    });
    userRepository.findById.mockResolvedValue(activeBusinessUser());
    conversationRepository.findDetailByBusiness.mockResolvedValue(detailFor());
    appointmentRepository.listRecentByCustomer.mockResolvedValue([]);
    userRepository.listByBusiness.mockResolvedValue([
      { id: USER_ID, name: "موظف", image: null, isActive: true },
    ]);
  });

  it("rejects an unauthenticated caller before reading any conversation", async () => {
    getSession.mockResolvedValueOnce(null);

    const result = await refreshConversationDetail({ id: CONVERSATION_ID });

    expect(result).toEqual({
      success: false,
      code: "UNAUTHENTICATED",
      message: expect.any(String),
    });
    expect(conversationRepository.findDetailByBusiness).not.toHaveBeenCalled();
  });

  it("rejects inactive and platform users as forbidden", async () => {
    getSession.mockResolvedValueOnce({
      user: { id: USER_ID, isActive: false, accountType: "BUSINESS" },
    });
    expect(
      await refreshConversationDetail({ id: CONVERSATION_ID }),
    ).toMatchObject({ success: false, code: "FORBIDDEN" });

    getSession.mockResolvedValueOnce({
      user: { id: USER_ID, isActive: true, accountType: "PLATFORM" },
    });
    expect(
      await refreshConversationDetail({ id: CONVERSATION_ID }),
    ).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(conversationRepository.findDetailByBusiness).not.toHaveBeenCalled();
  });

  it("rejects a user without an active tenant as forbidden", async () => {
    userRepository.findById.mockResolvedValueOnce({
      ...activeBusinessUser(),
      isActive: false,
    });
    expect(
      await refreshConversationDetail({ id: CONVERSATION_ID }),
    ).toMatchObject({ success: false, code: "FORBIDDEN" });

    userRepository.findById.mockResolvedValueOnce({
      ...activeBusinessUser(),
      businessId: null,
    });
    expect(
      await refreshConversationDetail({ id: CONVERSATION_ID }),
    ).toMatchObject({ success: false, code: "FORBIDDEN" });
    expect(conversationRepository.findDetailByBusiness).not.toHaveBeenCalled();
  });

  it("uses the session-derived business id and never a client-supplied tenant", async () => {
    const result = await refreshConversationDetail({
      id: CONVERSATION_ID,
      businessId: "99999999-9999-4999-8999-999999999999",
    });

    expect(result).toMatchObject({ success: true });
    expect(userRepository.findById).toHaveBeenCalledWith(USER_ID);
    expect(conversationRepository.findDetailByBusiness).toHaveBeenCalledWith(
      CONVERSATION_ID,
      BUSINESS_ID,
    );
    expect(operatorAttentionRepository.resolve).not.toHaveBeenCalled();
    expect(operatorAttentionRepository.open).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for a missing or cross-tenant conversation", async () => {
    conversationRepository.findDetailByBusiness.mockResolvedValueOnce(null);

    const result = await refreshConversationDetail({ id: CONVERSATION_ID });

    expect(result).toEqual({
      success: false,
      code: "NOT_FOUND",
      message: expect.any(String),
    });
    expect(operatorAttentionRepository.resolve).not.toHaveBeenCalled();
  });

  it("rejects malformed conversation ids without touching the database", async () => {
    const result = await refreshConversationDetail({ id: "not-a-uuid" });

    expect(result).toMatchObject({ success: false, code: "INVALID_INPUT" });
    expect(userRepository.findById).not.toHaveBeenCalled();
    expect(conversationRepository.findDetailByBusiness).not.toHaveBeenCalled();
  });
});
