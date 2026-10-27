/**
 * FlowPilot — ConversationDetail Component & Persistent Header Tests (CONV-UI-01).
 *
 * Verifies the component lifecycle, persistent header elements, assignee/responder
 * resolution, mobile context tab switching, and transition actions in JSDOM.
 */
import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
import type { ConversationDetailData } from "@/features/conversations/types";

import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  assignConversation,
  sendStaffReply,
  transitionConversation,
  updateAiSummary,
} = vi.hoisted(() => ({
  assignConversation: vi.fn(),
  sendStaffReply: vi.fn(),
  transitionConversation: vi.fn(),
  updateAiSummary: vi.fn(),
}));

vi.mock("@/features/conversations/actions/conversation-actions", () => ({
  assignConversation,
  sendStaffReply,
  transitionConversation,
  updateAiSummary,
}));

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

describe("ConversationDetail Component (CONV-UI-01)", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.clearAllMocks();
    assignConversation.mockResolvedValue({ success: true });
    sendStaffReply.mockResolvedValue({ success: true });
    transitionConversation.mockResolvedValue({ success: true });
    updateAiSummary.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    document.body.removeChild(container);
  });

  it("U01 & U02: Renders persistent header with customer identity and truncated name", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const header = container.querySelector(
      'header[data-testid="conversation-persistent-header"]',
    );
    expect(header).not.toBeNull();
    expect(header?.className).toContain("sticky top-0 z-20");

    const h1 = header?.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe(mockData.customer.name);
    expect(h1?.className).toContain("truncate");

    const phone = header?.querySelector('p[dir="ltr"]');
    expect(phone).not.toBeNull();
    expect(phone?.textContent).toBe(mockData.customer.phone);
  });

  it("U03 & U04: Renders conversation status and actual assignee/responder badge", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const statusBadge = container.querySelector(
      '[aria-label^="حالة المحادثة:"]',
    );
    expect(statusBadge).not.toBeNull();

    // AI_ACTIVE state should show AI assistant responder
    const aiResponder = container.querySelector(
      '[aria-label="المسؤول الحالي: المساعد الذكي"]',
    );
    expect(aiResponder).not.toBeNull();
    expect(aiResponder?.textContent).toContain("المساعد الذكي");
  });

  it("U04: Assignee badge reflects assigned user or current user ('أنت')", async () => {
    const root = createRoot(container);
    const assignedData: ConversationDetailData = {
      ...mockData,
      status: "NEED_HUMAN",
      assignedUser: { id: "user-me", name: "أحمد المشرف", image: null },
    };

    await act(async () => {
      root.render(<ConversationDetail data={assignedData} />);
    });

    const selfAssignee = container.querySelector(
      '[aria-label="المسؤول الحالي: أنت"]',
    );
    expect(selfAssignee).not.toBeNull();
    expect(selfAssignee?.textContent).toContain("أنت");
  });

  it("U05: Mobile action buttons are present inside scrollable transcript and not pinned", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const log = container.querySelector('div[role="log"]');
    expect(log).not.toBeNull();
    expect(log?.className).toContain("overflow-y-auto");

    // Action buttons container inside transcript on mobile
    const mobileActionsContainer = log?.querySelector("div.md\\:hidden");
    expect(mobileActionsContainer).not.toBeNull();
    expect(mobileActionsContainer?.textContent).toContain("تولّي المحادثة");
  });

  it("U06 & U07: Independently scrollable log and usable composer with labels", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const log = container.querySelector('div[role="log"]');
    expect(log?.getAttribute("tabindex")).toBe("0");
    expect(log?.getAttribute("aria-label")).toBe("رسائل المحادثة");

    const textarea = container.querySelector(
      'textarea[aria-label="رد على العميل"]',
    );
    expect(textarea).not.toBeNull();

    const submitBtn = container.querySelector(
      'button[aria-label="إرسال الرد"]',
    );
    expect(submitBtn).not.toBeNull();
  });

  it("Mobile view toggle switches cleanly between messages and context view", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const toggleBtn = container.querySelector(
      'button[aria-label="عرض سياق العميل والمواعيد"]',
    );
    expect(toggleBtn).not.toBeNull();

    // Click toggle to open context view
    await act(async () => {
      toggleBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // In context view, customer notes and appointments should be visible in main panel
    expect(container.textContent).toContain("سياق العميل");
    expect(container.textContent).toContain("سياق الحجز");
    expect(container.textContent).toContain("عميل مميز");
  });
});
