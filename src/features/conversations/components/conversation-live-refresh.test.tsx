import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
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
