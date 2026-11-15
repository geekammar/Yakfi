import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
import { mergeConversationRefreshMessages } from "@/features/conversations/lib/live-refresh";
import type {
  ConversationDetailData,
  ConversationRefreshData,
  StaffReplyActionResult,
} from "@/features/conversations/types";

import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  assignConversation,
  checkStaffReplyStatus,
  refreshConversationDetail,
  sendStaffReply,
  transitionConversation,
  updateAiSummary,
} = vi.hoisted(() => ({
  assignConversation: vi.fn(),
  checkStaffReplyStatus: vi.fn(),
  refreshConversationDetail: vi.fn(),
  sendStaffReply: vi.fn(),
  transitionConversation: vi.fn(),
  updateAiSummary: vi.fn(),
}));

vi.mock("@/features/conversations/actions/conversation-actions", () => ({
  assignConversation,
  checkStaffReplyStatus,
  sendStaffReply,
  transitionConversation,
  updateAiSummary,
}));

vi.mock("@/features/conversations/actions/conversation-refresh-actions", () => {
  return { refreshConversationDetail };
});

const mockData: ConversationDetailData = {
  id: "conv-test-1",
  status: "AI_ACTIVE",
  customer: {
    id: "cust-1",
    name: "سارة عبد الله أحمد محمد",
    phone: "+201012345678",
    notes: "عميل مميز — يفضل المواعيد المسائية",
  },
  currentUserId: "user-me",
  assignedUser: null,
  team: [
    { id: "user-me", name: "أحمد المشرف", image: null },
    { id: "user-other", name: "د. سارة الاستشارية", image: null },
  ],
  attentionReason: null,
  attentionCause: null,
  aiSummary: "العميل يستفسر عن أسعار ومواعيد تنظيف الأسنان",
  appointments: [
    {
      id: "apt-1",
      date: "2026-10-30",
      startTime: "2026-10-30T16:00:00Z",
      status: "CONFIRMED",
      notes: null,
      service: { name: "تنظيف أسنان", durationMinutes: 30 },
    },
  ],
  messages: [
    {
      id: "msg-1",
      senderType: "CUSTOMER",
      content: "السلام عليكم، ما هي مواعيد العيادة؟",
      createdAt: "2026-10-27T10:00:00Z",
    },
    {
      id: "msg-2",
      senderType: "AI",
      content: "وعليكم السلام! العيادة تفتح يومياً من ٩ صباحاً إلى ٩ مساءً.",
      createdAt: "2026-10-27T10:01:00Z",
    },
  ],
};

describe("ConversationDetail live refresh (open thread)", () => {
  let container: HTMLDivElement;
  let visibility: DocumentVisibilityState = "visible";

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    assignConversation.mockResolvedValue({ success: true });
    sendStaffReply.mockResolvedValue({ success: true });
    checkStaffReplyStatus.mockResolvedValue({
      success: false,
      status: "unknown",
      message: "غير مؤكد",
    });
    transitionConversation.mockResolvedValue({ success: true });
    updateAiSummary.mockResolvedValue({ success: true });
    refreshConversationDetail.mockResolvedValue({
      success: false,
      code: "UNKNOWN",
      message: "transient",
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    visibility = "visible";
    if (container.parentNode) document.body.removeChild(container);
  });

  type SuccessfulRefresh = {
    success: true;
    data: ConversationRefreshData;
  };

  function refreshSnapshot(
    overrides: Partial<ConversationRefreshData> = {},
  ): ConversationRefreshData {
    return {
      id: mockData.id,
      status: mockData.status,
      aiSummary: mockData.aiSummary,
      assignedUser: mockData.assignedUser,
      attentionReason: mockData.attentionReason,
      attentionCause: mockData.attentionCause,
      messages: mockData.messages,
      appointments: mockData.appointments,
      team: mockData.team,
      ...overrides,
    };
  }

  async function advance(ms = 5_000) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function typeInTextarea(element: HTMLTextAreaElement, value: string) {
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    nativeSetter?.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function logMessageTexts(): string[] {
    const nodes = container.querySelectorAll('[role="log"] p');
    return Array.from(nodes, (node) => node.textContent?.trim() ?? "");
  }

  it("shows incoming customer and assistant messages, new appointment and status without reload", async () => {
    const incomingCustomer = {
      id: "msg-live-customer",
      senderType: "CUSTOMER" as const,
      content: "وصلتني رسالة جديدة من العميل",
      createdAt: "2026-10-27T10:05:00Z",
    };
    const incomingAi = {
      id: "msg-live-ai",
      senderType: "AI" as const,
      content: "رد المساعد الآلي على الرسالة الجديدة",
      createdAt: "2026-10-27T10:05:05Z",
    };
    const newAppointment = {
      id: "apt-live-1",
      date: "2026-11-02",
      startTime: "2026-11-02T12:00:00Z",
      status: "CONFIRMED" as const,
      notes: null,
      service: { name: "متابعة جديدة", durationMinutes: 45 },
    };

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({
        status: "NEED_HUMAN",
        assignedUser: { id: "user-other", name: "د. سارة", image: null },
        messages: [...mockData.messages, incomingCustomer, incomingAi],
        appointments: [...mockData.appointments, newAppointment],
      }),
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    await advance();

    expect(refreshConversationDetail).toHaveBeenCalledWith({ id: mockData.id });
    expect(container.textContent).toContain(incomingCustomer.content);
    expect(container.textContent).toContain(incomingAi.content);
    expect(container.textContent).toContain("متابعة جديدة");
    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="المسؤول الحالي: د. سارة"]'),
    ).not.toBeNull();

    expect(assignConversation).not.toHaveBeenCalled();
    expect(sendStaffReply).not.toHaveBeenCalled();
    expect(transitionConversation).not.toHaveBeenCalled();
    expect(updateAiSummary).not.toHaveBeenCalled();
    expect(checkStaffReplyStatus).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("clears the previous handoff reason after a successful Return to assistant", async () => {
    const handoffData: ConversationDetailData = {
      ...mockData,
      status: "NEED_HUMAN",
      assignedUser: { id: "user-me", name: "أحمد المشرف", image: null },
      attentionReason: "AI_HANDOFF",
      attentionCause: "KNOWLEDGE_GAP_UNRESOLVED",
    };
    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({
        status: "AI_ACTIVE",
        assignedUser: null,
        attentionReason: null,
        attentionCause: null,
      }),
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={handoffData} />);
    });
    expect(container.textContent).toContain("المعلومات غير متوفرة");

    const returnButton = container.querySelector(
      'button[aria-label="إعادة للمساعد"]',
    );
    await act(async () => {
      returnButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(transitionConversation).toHaveBeenCalledWith({
      id: mockData.id,
      transition: "RETURN_TO_AI",
    });
    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: المساعد الذكي نشط"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("المعلومات غير متوفرة");

    await act(async () => root.unmount());
  });

  it("shows the current reason when a genuine new handoff arrives after Return to assistant", async () => {
    const handoffData: ConversationDetailData = {
      ...mockData,
      status: "NEED_HUMAN",
      assignedUser: { id: "user-me", name: "أحمد المشرف", image: null },
      attentionReason: "AI_HANDOFF",
      attentionCause: "KNOWLEDGE_GAP_UNRESOLVED",
    };

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={handoffData} />);
    });
    const returnButton = container.querySelector(
      'button[aria-label="إعادة للمساعد"]',
    );
    await act(async () => {
      returnButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("المعلومات غير متوفرة");

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({
        status: "NEED_HUMAN",
        assignedUser: null,
        attentionReason: "AI_HANDOFF",
        attentionCause: "CUSTOMER_REQUESTED_HUMAN",
      }),
    });
    await advance();

    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).toContain("العميل طلب مسؤولاً");
    expect(container.textContent).not.toContain("المعلومات غير متوفرة");

    await act(async () => root.unmount());
  });

  it("preserves an unsent draft and unsaved assistant-summary edit across refresh", async () => {
    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({
        aiSummary: "ملخص جديد وصل من الخادم",
        messages: [
          ...mockData.messages,
          {
            id: "msg-live-2",
            senderType: "CUSTOMER" as const,
            content: "رسالة جديدة أثناء كتابة المسودة",
            createdAt: "2026-10-27T10:06:00Z",
          },
        ],
      }),
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const replyBox = container.querySelector(
      'textarea[aria-label="رد على العميل"]',
    ) as HTMLTextAreaElement;
    const summaryBox = container.querySelector(
      'textarea[aria-label="ملخص المساعد"]',
    ) as HTMLTextAreaElement;

    await act(async () => {
      typeInTextarea(replyBox, "مسودة رد لم تُرسل بعد");
      typeInTextarea(summaryBox, "تعديل ملخص غير محفوظ");
    });

    await advance();

    expect(replyBox.value).toBe("مسودة رد لم تُرسل بعد");
    expect(summaryBox.value).toBe("تعديل ملخص غير محفوظ");
    expect(container.textContent).toContain("رسالة جديدة أثناء كتابة المسودة");

    await act(async () => root.unmount());
  });

  it("updates the server-authored summary when there is no unsaved edit", async () => {
    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({ aiSummary: "ملخص محدث من الخادم" }),
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    await advance();

    const summaryBox = container.querySelector(
      'textarea[aria-label="ملخص المساعد"]',
    ) as HTMLTextAreaElement;
    expect(summaryBox.value).toBe("ملخص محدث من الخادم");

    await act(async () => root.unmount());
  });

  it("does not duplicate an optimistic sent message when the refresh confirms it", async () => {
    let resolveSend: (value: StaffReplyActionResult) => void = () => {};
    const sendPromise = new Promise<StaffReplyActionResult>((res) => {
      resolveSend = res;
    });
    sendStaffReply.mockReturnValue(sendPromise);

    const content = "رد الفريق المؤكد أثناء التحديث";
    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({
        status: "NEED_HUMAN",
        messages: [
          ...mockData.messages,
          {
            id: "server-confirmed-message-1",
            senderType: "STAFF" as const,
            content,
            createdAt: "2026-10-27T10:07:00Z",
          },
        ],
      }),
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const replyBox = container.querySelector(
      'textarea[aria-label="رد على العميل"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      typeInTextarea(replyBox, content);
    });

    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(logMessageTexts().filter((text) => text === content)).toHaveLength(
      1,
    );

    await advance();
    expect(logMessageTexts().filter((text) => text === content)).toHaveLength(
      1,
    );

    await act(async () => {
      resolveSend({
        success: true,
        outcome: "accepted",
        messageId: "server-confirmed-message-1",
      });
      await sendPromise;
    });

    expect(logMessageTexts().filter((text) => text === content)).toHaveLength(
      1,
    );

    await act(async () => root.unmount());
  });

  it("ignores an older refresh response after a newer local action result", async () => {
    let resolveRefresh: (value: SuccessfulRefresh) => void = () => {};
    const refreshPromise = new Promise<SuccessfulRefresh>((res) => {
      resolveRefresh = res;
    });
    refreshConversationDetail.mockReturnValueOnce(refreshPromise);

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    await advance();
    expect(refreshConversationDetail).toHaveBeenCalledTimes(1);

    const takeOver = container.querySelector(
      'button[aria-label="تولّي المحادثة"]',
    );
    await act(async () => {
      takeOver?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(transitionConversation).toHaveBeenCalledWith({
      id: mockData.id,
      transition: "TAKE_OVER",
    });
    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      resolveRefresh({
        success: true,
        data: refreshSnapshot({
          status: "AI_ACTIVE",
          messages: [
            ...mockData.messages,
            {
              id: "stale-message",
              senderType: "CUSTOMER" as const,
              content: "رسالة من استجابة قديمة",
              createdAt: "2026-10-27T10:08:00Z",
            },
          ],
        }),
      });
      await refreshPromise;
    });

    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("رسالة من استجابة قديمة");
    expect(
      container.querySelector('[aria-label="المسؤول الحالي: أنت"]'),
    ).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("ignores a refresh that completes after navigation/unmount", async () => {
    let resolveRefresh: (value: SuccessfulRefresh) => void = () => {};
    const refreshPromise = new Promise<SuccessfulRefresh>((res) => {
      resolveRefresh = res;
    });
    refreshConversationDetail.mockReturnValueOnce(refreshPromise);

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });
    await advance();
    expect(refreshConversationDetail).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());

    await act(async () => {
      resolveRefresh({
        success: true,
        data: refreshSnapshot({
          messages: [
            ...mockData.messages,
            {
              id: "late-message",
              senderType: "CUSTOMER" as const,
              content: "رسالة متأخرة بعد المغادرة",
              createdAt: "2026-10-27T10:09:00Z",
            },
          ],
        }),
      });
      await refreshPromise;
    });

    const nextContainer = document.createElement("div");
    document.body.appendChild(nextContainer);
    const nextRoot = createRoot(nextContainer);
    await act(async () => {
      nextRoot.render(
        <ConversationDetail
          data={{
            ...mockData,
            id: "conv-test-2",
            customer: { ...mockData.customer, name: "عميل آخر" },
          }}
        />,
      );
    });

    expect(nextContainer.textContent).toContain("عميل آخر");
    expect(nextContainer.textContent).not.toContain(
      "رسالة متأخرة بعد المغادرة",
    );

    await act(async () => nextRoot.unmount());
    document.body.removeChild(nextContainer);
  });

  it("pauses while hidden, refreshes on visibility/focus, never overlaps and cleans up on unmount", async () => {
    let resolveFirst: (value: SuccessfulRefresh) => void = () => {};
    const firstPromise = new Promise<SuccessfulRefresh>((res) => {
      resolveFirst = res;
    });
    refreshConversationDetail.mockReturnValueOnce(firstPromise);

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(30_000);
    expect(refreshConversationDetail).not.toHaveBeenCalled();

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(refreshConversationDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await advance(30_000);
    expect(refreshConversationDetail).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ success: true, data: refreshSnapshot() });
      await firstPromise;
    });
    await advance(5_000);
    expect(refreshConversationDetail).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
    await advance(60_000);
    expect(refreshConversationDetail).toHaveBeenCalledTimes(2);
  });

  it("never conflates independent STAFF messages that share identical text", () => {
    const optimistic = {
      id: "optimistic-staff-1",
      senderType: "STAFF" as const,
      content: "نص متطابق تماماً",
      createdAt: "2026-10-27T10:10:00Z",
    };
    const independent = {
      id: "independent-staff-1",
      senderType: "STAFF" as const,
      content: "نص متطابق تماماً",
      createdAt: "2026-10-27T10:11:00Z",
    };

    const merged = mergeConversationRefreshMessages(
      [...mockData.messages, optimistic],
      [...mockData.messages, independent],
    );

    expect(merged.map((message) => message.id)).toEqual(
      expect.arrayContaining([optimistic.id, independent.id]),
    );
    expect(merged).toHaveLength(mockData.messages.length + 2);
  });

  it("defers snapshots during an unresolved send and confirms via the authoritative messageId", async () => {
    let resolveSend: (value: StaffReplyActionResult) => void = () => {};
    const sendPromise = new Promise<StaffReplyActionResult>((res) => {
      resolveSend = res;
    });
    sendStaffReply.mockReturnValue(sendPromise);

    const content = "رسالة فريق بنفس النص";
    const independent = {
      id: "independent-server-staff",
      senderType: "STAFF" as const,
      content,
      createdAt: "2026-10-27T10:12:00Z",
    };
    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({
        status: "NEED_HUMAN",
        messages: [
          ...mockData.messages,
          {
            id: "authoritative-staff-row",
            senderType: "STAFF" as const,
            content,
            createdAt: "2026-10-27T10:11:30Z",
          },
          independent,
        ],
      }),
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const replyBox = container.querySelector(
      'textarea[aria-label="رد على العميل"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      typeInTextarea(replyBox, content);
    });
    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    const attemptId = sendStaffReply.mock.calls[0]![0].clientSubmissionId;
    expect(logMessageTexts().filter((text) => text === content)).toHaveLength(
      1,
    );

    // A snapshot completing before the send result must not identify or
    // replace the optimistic row.
    await advance(5_000);
    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: المساعد الذكي نشط"]',
      ),
    ).not.toBeNull();
    expect(logMessageTexts().filter((text) => text === content)).toHaveLength(
      1,
    );

    await act(async () => {
      resolveSend({
        success: true,
        outcome: "accepted",
        messageId: "authoritative-staff-row",
      });
      await sendPromise;
    });

    // The authoritative confirmation is one row, not a duplicate.
    expect(logMessageTexts().filter((text) => text === content)).toHaveLength(
      1,
    );

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({
        status: "NEED_HUMAN",
        messages: [
          ...mockData.messages,
          {
            id: "authoritative-staff-row",
            senderType: "STAFF" as const,
            content,
            createdAt: "2026-10-27T10:11:30Z",
          },
          independent,
        ],
      }),
    });
    await advance(5_000);

    // One confirmed row for the send + one independent identical-text row.
    expect(logMessageTexts().filter((text) => text === content)).toHaveLength(
      2,
    );
    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]',
      ),
    ).not.toBeNull();
    expect(attemptId).not.toBe("authoritative-staff-row");

    await act(async () => root.unmount());
  });

  it("retains an unknown attempt identity and recovery UI across refresh", async () => {
    let resolveSend: (value: StaffReplyActionResult) => void = () => {};
    const sendPromise = new Promise<StaffReplyActionResult>((res) => {
      resolveSend = res;
    });
    sendStaffReply.mockReturnValue(sendPromise);

    const content = "رد غير مؤكد الهوية";
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const replyBox = container.querySelector(
      'textarea[aria-label="رد على العميل"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      typeInTextarea(replyBox, content);
    });
    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    const attemptId = sendStaffReply.mock.calls[0]![0].clientSubmissionId;

    await act(async () => {
      resolveSend({
        success: false,
        outcome: "unknown",
        message: "حالة الإرسال غير مؤكدة",
      });
      await sendPromise;
    });

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({
        status: "NEED_HUMAN",
        messages: [
          ...mockData.messages,
          {
            id: "server-unknown-staff-row",
            senderType: "STAFF" as const,
            content,
            createdAt: "2026-10-27T10:13:00Z",
          },
        ],
      }),
    });
    await advance(5_000);

    expect(
      container.querySelector(
        'div[role="alert"][aria-label="تنبيه حالة الإرسال غير مؤكدة"]',
      ),
    ).not.toBeNull();
    expect(logMessageTexts().filter((text) => text === content)).toHaveLength(
      1,
    );

    const recheck = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("إعادة التحقق من الإرسال"),
    );
    expect(recheck).not.toBeNull();
    await act(async () => {
      recheck?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(checkStaffReplyStatus).toHaveBeenCalledWith({
      id: mockData.id,
      clientSubmissionId: attemptId,
    });

    await act(async () => root.unmount());
  });

  it("retains an in-progress attempt identity and recovery UI across refresh", async () => {
    let resolveSend: (value: StaffReplyActionResult) => void = () => {};
    const sendPromise = new Promise<StaffReplyActionResult>((res) => {
      resolveSend = res;
    });
    sendStaffReply.mockReturnValue(sendPromise);

    const content = "رد قيد المعالجة";
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const replyBox = container.querySelector(
      'textarea[aria-label="رد على العميل"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      typeInTextarea(replyBox, content);
    });
    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    const attemptId = sendStaffReply.mock.calls[0]![0].clientSubmissionId;

    await act(async () => {
      resolveSend({
        success: false,
        outcome: "in-progress",
        message: "الطلب قيد المعالجة حالياً",
      });
      await sendPromise;
    });

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({ status: "NEED_HUMAN" }),
    });
    await advance(5_000);

    expect(
      container.querySelector(
        'div[role="status"][aria-label="حالة الطلب قيد المعالجة"]',
      ),
    ).not.toBeNull();

    const recheck = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("تحديث الحالة"),
    );
    expect(recheck).not.toBeNull();
    await act(async () => {
      recheck?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(checkStaffReplyStatus).toHaveBeenCalledWith({
      id: mockData.id,
      clientSubmissionId: attemptId,
    });

    await act(async () => root.unmount());
  });

  it("preserves a newer summary edit when an in-flight save resolves", async () => {
    let resolveSave: (value: { success: boolean }) => void = () => {};
    const savePromise = new Promise<{ success: boolean }>((res) => {
      resolveSave = res;
    });
    updateAiSummary.mockReturnValueOnce(savePromise);

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const summaryBox = container.querySelector(
      'textarea[aria-label="ملخص المساعد"]',
    ) as HTMLTextAreaElement;
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ الملخص"),
    );
    expect(saveButton).not.toBeNull();

    await act(async () => {
      typeInTextarea(summaryBox, "ملخص أ");
    });
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(updateAiSummary).toHaveBeenCalledWith({
      id: mockData.id,
      aiSummary: "ملخص أ",
    });

    await act(async () => {
      typeInTextarea(summaryBox, "ملخص ب الأحدث");
    });

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({ status: "NEED_HUMAN", aiSummary: "ملخص أ" }),
    });
    await advance(5_000);
    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: المساعد الذكي نشط"]',
      ),
    ).not.toBeNull();

    await act(async () => {
      resolveSave({ success: true });
      await savePromise;
    });

    expect(summaryBox.value).toBe("ملخص ب الأحدث");

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({ aiSummary: "ملخص أ" }),
    });
    await advance(5_000);
    expect(summaryBox.value).toBe("ملخص ب الأحدث");

    await act(async () => root.unmount());
  });

  it("updates the summary baseline normally when no newer edit intervened", async () => {
    updateAiSummary.mockResolvedValueOnce({ success: true });

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const summaryBox = container.querySelector(
      'textarea[aria-label="ملخص المساعد"]',
    ) as HTMLTextAreaElement;
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ الملخص"),
    );

    await act(async () => {
      typeInTextarea(summaryBox, "ملخص محفوظ");
    });
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await advance(0);
    expect(updateAiSummary).toHaveBeenCalledWith({
      id: mockData.id,
      aiSummary: "ملخص محفوظ",
    });
    expect(summaryBox.value).toBe("ملخص محفوظ");

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({ aiSummary: "ملخص محدث من الخادم" }),
    });
    await advance(5_000);
    expect(summaryBox.value).toBe("ملخص محدث من الخادم");

    await act(async () => root.unmount());
  });

  it("preserves editor text after a failed save and resumes refresh", async () => {
    updateAiSummary.mockRejectedValueOnce(new Error("network"));

    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const summaryBox = container.querySelector(
      'textarea[aria-label="ملخص المساعد"]',
    ) as HTMLTextAreaElement;
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ الملخص"),
    );

    await act(async () => {
      typeInTextarea(summaryBox, "ملخص غير محفوظ");
    });
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await advance(0);
    expect(summaryBox.value).toBe("ملخص غير محفوظ");
    expect(container.textContent).toContain("تعذر حفظ الملخص الآن");

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({ status: "NEED_HUMAN" }),
    });
    await advance(5_000);
    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]',
      ),
    ).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("retains the last good snapshot and backs off transient failures", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    await advance(5_000);
    expect(refreshConversationDetail).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(mockData.messages[0]!.content);

    await advance(9_000);
    expect(refreshConversationDetail).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(mockData.messages[0]!.content);

    await advance(1_100);
    expect(refreshConversationDetail).toHaveBeenCalledTimes(2);

    await advance(19_000);
    expect(refreshConversationDetail).toHaveBeenCalledTimes(2);

    refreshConversationDetail.mockResolvedValue({
      success: true,
      data: refreshSnapshot({ status: "NEED_HUMAN" }),
    });
    await advance(1_100);
    expect(refreshConversationDetail).toHaveBeenCalledTimes(3);
    expect(
      container.querySelector(
        '[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]',
      ),
    ).not.toBeNull();

    await act(async () => root.unmount());
  });
});
