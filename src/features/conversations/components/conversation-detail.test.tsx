/**
 * FlowPilot — ConversationDetail Component & Persistent Header Tests (CONV-UI-01).
 *
 * Verifies the component lifecycle, persistent header elements, assignee/responder
 * resolution, mobile context tab switching, and transition actions in JSDOM.
 */
import {
  ConversationDetail,
  formatAppointmentDate,
} from "@/features/conversations/components/conversation-detail";
import {
  clearConversationStorage,
  getDraftStorageKey,
  getStoredDraft,
  removeStoredDraft,
  setStoredDraft,
} from "@/features/conversations/lib/storage";
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

  it("U05: Actions are directly accessible in the persistent header on mobile and desktop without opening context", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const header = container.querySelector(
      'header[data-testid="conversation-persistent-header"]',
    );
    expect(header).not.toBeNull();

    // Primary action button is directly in header
    expect(header?.textContent).toContain("تولّي المحادثة");
    const takeOverBtn = header?.querySelector(
      'button[aria-label="تولّي المحادثة"]',
    );
    expect(takeOverBtn).not.toBeNull();

    // Booking shortcut is directly in header
    expect(header?.textContent).toContain("حجز موعد");
    const bookingLink = header?.querySelector('a[aria-label="حجز موعد"]');
    expect(bookingLink).not.toBeNull();

    // Details toggle button is directly in header with label "التفاصيل"
    const detailsBtn = header?.querySelector(
      'button[aria-label="عرض تفاصيل العميل والمواعيد"]',
    );
    expect(detailsBtn).not.toBeNull();
    expect(detailsBtn?.textContent).toContain("التفاصيل");
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
      'button[aria-label="عرض تفاصيل العميل والمواعيد"]',
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

  it("U04: BOOKED status displays actual assignment separately without conflating status with assignee", async () => {
    const root1 = createRoot(container);
    const bookedDataWithAssignee: ConversationDetailData = {
      ...mockData,
      status: "BOOKED",
      assignedUser: {
        id: "user-other",
        name: "د. سارة الاستشارية",
        image: null,
      },
    };

    await act(async () => {
      root1.render(<ConversationDetail data={bookedDataWithAssignee} />);
    });

    // Conversation status badge shows BOOKED (محجوز)
    const statusBadge = container.querySelector(
      '[aria-label="حالة المحادثة: محجوز"]',
    );
    expect(statusBadge).not.toBeNull();

    // Assignee badge shows actual assigned staff name, NOT "مكتمل الحجز"
    const staffAssignee = container.querySelector(
      '[aria-label="المسؤول الحالي: د. سارة الاستشارية"]',
    );
    expect(staffAssignee).not.toBeNull();
    expect(staffAssignee?.textContent).toContain("د. سارة الاستشارية");

    // Clean up first root before second test
    await act(async () => {
      root1.unmount();
    });

    // Also verify unassigned BOOKED conversation
    const root2 = createRoot(container);
    const bookedUnassigned: ConversationDetailData = {
      ...mockData,
      status: "BOOKED",
      assignedUser: null,
    };

    await act(async () => {
      root2.render(<ConversationDetail data={bookedUnassigned} />);
    });

    const unassignedBadge = container.querySelector(
      '[aria-label="المسؤول الحالي: غير معينة"]',
    );
    expect(unassignedBadge).not.toBeNull();
  });

  it("Preserves draft text across mobile view toggles", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    const textarea = container.querySelector(
      'textarea[aria-label="رد على العميل"]',
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();

    // Type a draft by invoking native value setter so React registers onChange
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeSetter?.call(textarea, "مسودة رد غير مرسلة");
      textarea.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(textarea.value).toBe("مسودة رد غير مرسلة");

    // Toggle to context view
    const toggleToContext = container.querySelector(
      'button[aria-label="عرض تفاصيل العميل والمواعيد"]',
    );
    await act(async () => {
      toggleToContext?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    // Toggle back to messages
    const toggleToMessages = container.querySelector(
      'button[aria-label="العودة إلى المحادثة"]',
    );
    await act(async () => {
      toggleToMessages?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    // Draft text is preserved
    const restoredTextarea = container.querySelector(
      'textarea[aria-label="رد على العميل"]',
    ) as HTMLTextAreaElement;
    expect(restoredTextarea.value).toBe("مسودة رد غير مرسلة");
  });

  it("Handles long Arabic customer names and allows up to two lines on narrow screens", async () => {
    const root = createRoot(container);
    const longNameData: ConversationDetailData = {
      ...mockData,
      customer: {
        ...mockData.customer,
        name: "عبد الرحمن عبد الرحيم عبد الصمد المصطفى الشريف بن هاشم",
      },
    };

    await act(async () => {
      root.render(<ConversationDetail data={longNameData} />);
    });

    const h1 = container.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toBe(longNameData.customer.name);
    expect(h1?.className).toContain("line-clamp-2");
    expect(h1?.className).toContain("break-words");
    expect(h1?.className).toContain("truncate");
  });

  it("NEED_HUMAN with attention cause and unassigned does not infer an active human responder", async () => {
    const root = createRoot(container);
    const needHumanData: ConversationDetailData = {
      ...mockData,
      status: "NEED_HUMAN",
      assignedUser: null,
      attentionReason: "AI_HANDOFF",
      attentionCause: "CUSTOMER_REQUESTED_HUMAN",
    };

    await act(async () => {
      root.render(<ConversationDetail data={needHumanData} />);
    });

    // Status is NEED_HUMAN
    const statusBadge = container.querySelector(
      '[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]',
    );
    expect(statusBadge).not.toBeNull();

    // Attention cause chip is displayed
    const attentionChip = container.querySelector(
      '[aria-label^="سبب انتباه المشغل:"]',
    );
    expect(attentionChip).not.toBeNull();
    expect(attentionChip?.textContent).toContain("العميل طلب مسؤولاً");

    // Assignee shows "غير معينة" — does NOT infer active responder
    const assigneeBadge = container.querySelector(
      '[aria-label="المسؤول الحالي: غير معينة"]',
    );
    expect(assigneeBadge).not.toBeNull();
    expect(assigneeBadge?.textContent).toContain("غير معينة");
  });

  it("AI_ACTIVE renders compact status 'نشط' without duplicate AI labels", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<ConversationDetail data={mockData} />);
    });

    // Compact status badge displays "نشط"
    const statusBadge = container.querySelector(
      '[aria-label="حالة المحادثة: المساعد الذكي نشط"]',
    );
    expect(statusBadge).not.toBeNull();
    expect(statusBadge?.textContent).toBe("نشط");

    // Assignee displays "المساعد الذكي"
    const assigneeBadge = container.querySelector(
      '[aria-label="المسؤول الحالي: المساعد الذكي"]',
    );
    expect(assigneeBadge).not.toBeNull();
    expect(assigneeBadge?.textContent).toContain("المساعد الذكي");
  });

  it("Primary action switches to 'إعادة للمساعد' when assigned to human", async () => {
    const root = createRoot(container);
    const assignedData: ConversationDetailData = {
      ...mockData,
      status: "NEED_HUMAN",
      assignedUser: { id: "user-me", name: "أحمد المشرف", image: null },
    };

    await act(async () => {
      root.render(<ConversationDetail data={assignedData} />);
    });

    const returnBtn = container.querySelector(
      'button[aria-label="إعادة للمساعد"]',
    );
    expect(returnBtn).not.toBeNull();
    expect(returnBtn?.textContent).toContain("إعادة");

    // Clicking Return to AI triggers transitionConversation
    await act(async () => {
      returnBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(transitionConversation).toHaveBeenCalledWith({
      id: "conv-test-1",
      transition: "RETURN_TO_AI",
    });
  });

  describe("Draft lifecycle and operator state isolation", () => {
    const testBiz = "biz-test-1";
    const userA = "user-alice";
    const userB = "user-bob";

    function typeInTextarea(element: HTMLTextAreaElement, value: string) {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeSetter?.call(element, value);
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    beforeEach(() => {
      window.sessionStorage.clear();
      vi.clearAllMocks();
    });

    afterEach(() => {
      window.sessionStorage.clear();
    });

    it("Raw draft with surrounding whitespace is removed after successful send when not superseded", async () => {
      let resolveReply: (value: { success: boolean }) => void = () => {};
      const replyPromise = new Promise<{ success: boolean }>((res) => {
        resolveReply = res;
      });
      sendStaffReply.mockReturnValue(replyPromise);

      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ConversationDetail
            data={{ ...mockData, businessId: testBiz, currentUserId: userA }}
          />,
        );
      });

      const textarea = container.querySelector(
        'textarea[aria-label="رد على العميل"]',
      ) as HTMLTextAreaElement;
      expect(textarea).not.toBeNull();

      // Type raw draft with leading and trailing whitespace and newlines
      const rawDraftWithWhitespace = "   \nالسلام عليكم ورحمة الله   \n\n";
      await act(async () => {
        typeInTextarea(textarea, rawDraftWithWhitespace);
      });
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBe(
        rawDraftWithWhitespace,
      );

      // Submit form
      const form = container.querySelector("form");
      await act(async () => {
        form?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });

      // Draft remains in storage while pending for safety/reload recovery
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBe(
        rawDraftWithWhitespace,
      );

      // Server confirms success
      await act(async () => {
        resolveReply({ success: true });
        await replyPromise;
      });

      // Stored draft is removed cleanly despite surrounding whitespace
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBeNull();
    });

    it("Newer draft survives both success and failure unchanged", async () => {
      // --- PART A: FAILURE ---
      let resolveReplyFail: (value: {
        success: boolean;
        message?: string;
      }) => void = () => {};
      const failPromise = new Promise<{ success: boolean; message?: string }>(
        (res) => {
          resolveReplyFail = res;
        },
      );
      sendStaffReply.mockReturnValue(failPromise);

      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ConversationDetail
            data={{ ...mockData, businessId: testBiz, currentUserId: userA }}
          />,
        );
      });

      const textarea = container.querySelector(
        'textarea[aria-label="رد على العميل"]',
      ) as HTMLTextAreaElement;

      // Submit first message
      await act(async () => {
        typeInTextarea(textarea, "الرسالة الأولى");
      });
      const form = container.querySelector("form");
      await act(async () => {
        form?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });

      // Operator types newer second draft while first send is pending
      const newerDraft = "الرسالة الثانية الأحدث";
      await act(async () => {
        typeInTextarea(textarea, newerDraft);
      });
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBe(newerDraft);

      // Resolve first request with FAILURE
      await act(async () => {
        resolveReplyFail({ success: false, message: "فشل مؤقت في الشبكة" });
        await failPromise;
      });

      // Newer draft in textarea and storage must be completely UNCHANGED (not concatenated!)
      expect(textarea.value).toBe(newerDraft);
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBe(newerDraft);

      // Failed submission is displayed separately with recovery affordance
      const alert = container.querySelector(
        'div[role="alert"][aria-label="تنبيه تعذر إرسال الرد"]',
      );
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("الرسالة الأولى");

      // --- PART B: SUCCESS ---
      let resolveReplySuccess: (value: { success: boolean }) => void = () => {};
      const successPromise = new Promise<{ success: boolean }>((res) => {
        resolveReplySuccess = res;
      });
      sendStaffReply.mockReturnValue(successPromise);

      // Submit the newer draft
      await act(async () => {
        form?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });

      // While pending, type a third draft
      const thirdDraft = "مسودة ثالثة جديدة كلياً";
      await act(async () => {
        typeInTextarea(textarea, thirdDraft);
      });

      // Resolve second send as SUCCESS
      await act(async () => {
        resolveReplySuccess({ success: true });
        await successPromise;
      });

      // Third draft survives success completely unchanged
      expect(textarea.value).toBe(thirdDraft);
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBe(thirdDraft);
    });

    it("Begins a pending mocked send, unmounts, then remounts and verifies recoverability", async () => {
      // Mock sendStaffReply with a pending (unresolved) promise
      const pendingPromise = new Promise<{ success: boolean }>(() => {});
      sendStaffReply.mockReturnValue(pendingPromise);

      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ConversationDetail
            data={{ ...mockData, businessId: testBiz, currentUserId: userA }}
          />,
        );
      });

      const textarea = container.querySelector(
        'textarea[aria-label="رد على العميل"]',
      ) as HTMLTextAreaElement;

      const inFlightText = "رسالة قيد الإرسال أثناء إغلاق الصفحة";
      await act(async () => {
        typeInTextarea(textarea, inFlightText);
      });

      // Submit message — request begins and is now pending
      const form = container.querySelector("form");
      await act(async () => {
        form?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });

      // Unmount the component while send is pending (simulate tab close / route change)
      await act(async () => {
        root.unmount();
      });

      // Mount fresh instance (simulate remount / reload)
      const container2 = document.createElement("div");
      document.body.appendChild(container2);
      const root2 = createRoot(container2);

      await act(async () => {
        root2.render(
          <ConversationDetail
            data={{ ...mockData, businessId: testBiz, currentUserId: userA }}
          />,
        );
      });

      // Wait microtask for draft hydration
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      const remountedTextarea = container2.querySelector(
        'textarea[aria-label="رد على العميل"]',
      ) as HTMLTextAreaElement;
      expect(remountedTextarea.value).toBe(inFlightText);

      root2.unmount();
      document.body.removeChild(container2);
    });

    it("Quota-exhausted writes do not prevent reading or removing existing feature data", async () => {
      // Pre-seed draft in storage
      setStoredDraft(testBiz, userA, mockData.id, "مسودة مخزنة مسبقاً");
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBe(
        "مسودة مخزنة مسبقاً",
      );

      // Simulate full storage quota by throwing on setItem
      vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
        throw new DOMException("QuotaExceededError", "QuotaExceededError");
      });

      // 1. Reading existing draft still works under quota exhaustion
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBe(
        "مسودة مخزنة مسبقاً",
      );

      // 2. Setting a new draft does not throw or crash
      expect(() => {
        setStoredDraft(testBiz, userA, mockData.id, "محاولة كتابة");
      }).not.toThrow();

      // 3. Removing draft works under quota exhaustion
      removeStoredDraft(testBiz, userA, mockData.id);
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBeNull();

      // 4. Logout cleanup works under quota exhaustion
      expect(() => {
        clearConversationStorage();
      }).not.toThrow();

      vi.restoreAllMocks();
    });

    it("Trusted identity safety: missing identity safely skips persistence without shared default keys", async () => {
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ConversationDetail
            data={{ ...mockData, businessId: undefined, currentUserId: "" }}
          />,
        );
      });

      const textarea = container.querySelector(
        'textarea[aria-label="رد على العميل"]',
      ) as HTMLTextAreaElement;

      await act(async () => {
        typeInTextarea(textarea, "نص بدون هوية موثوقة");
      });

      // No key containing default_biz or default_user is created
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const key = window.sessionStorage.key(i) ?? "";
        expect(key).not.toContain("default_biz");
        expect(key).not.toContain("default_user");
      }
    });

    it("Two operators in the same tab cannot restore each other's drafts or leak state", async () => {
      // Operator A writes a draft
      setStoredDraft(testBiz, userA, mockData.id, "مسودة خاصة بالمشغل أ");

      // Operator B opens the same conversation in the same browser tab
      const rootB = createRoot(container);
      await act(async () => {
        rootB.render(
          <ConversationDetail
            data={{ ...mockData, businessId: testBiz, currentUserId: userB }}
          />,
        );
      });

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      const textareaB = container.querySelector(
        'textarea[aria-label="رد على العميل"]',
      ) as HTMLTextAreaElement;
      // Operator B must NOT see Operator A's draft
      expect(textareaB.value).toBe("");

      // Operator B types their own draft
      await act(async () => {
        typeInTextarea(textareaB, "مسودة خاصة بالمشغل ب");
      });

      // Verify both drafts exist under their distinct scoped keys
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBe(
        "مسودة خاصة بالمشغل أ",
      );
      expect(getStoredDraft(testBiz, userB, mockData.id)).toBe(
        "مسودة خاصة بالمشغل ب",
      );

      // Logging out clears both feature drafts
      clearConversationStorage();
      expect(getStoredDraft(testBiz, userA, mockData.id)).toBeNull();
      expect(getStoredDraft(testBiz, userB, mockData.id)).toBeNull();
    });

    it("Gracefully handles disabled or malformed storage without crashing UI", async () => {
      // Corrupt the key with non-string data
      const key = getDraftStorageKey(testBiz, userA, mockData.id);
      window.sessionStorage.setItem(key, "{}");

      const root = createRoot(container);
      await act(async () => {
        root.render(
          <ConversationDetail
            data={{ ...mockData, businessId: testBiz, currentUserId: userA }}
          />,
        );
      });

      const textarea = container.querySelector(
        'textarea[aria-label="رد على العميل"]',
      ) as HTMLTextAreaElement;
      expect(textarea).not.toBeNull();
    });
  });

  describe("Appointment calendar date formatting consistency", () => {
    it("formats 2026-11-07 as Saturday 7 November", () => {
      const formatted = formatAppointmentDate("2026-11-07");
      expect(formatted).toContain("السبت");
      expect(formatted).toContain("نوفمبر");
      expect(formatted).toMatch(/[7٧]/);
      expect(formatted).not.toContain("الجمعة");
      expect(formatted).not.toMatch(/[6٦]/);
    });

    it("formats 2026-11-08 as Sunday 8 November", () => {
      const formatted = formatAppointmentDate("2026-11-08");
      expect(formatted).toContain("الأحد");
      expect(formatted).toContain("نوفمبر");
      expect(formatted).toMatch(/[8٨]/);
      expect(formatted).not.toContain("السبت");
    });

    it("renders consistent Saturday 7 November in appointment card", async () => {
      const root = createRoot(container);
      const dataWithNov7Apt: ConversationDetailData = {
        ...mockData,
        appointments: [
          {
            id: "apt-nov-7",
            date: "2026-11-07",
            startTime: "2026-11-07T10:00:00Z",
            status: "CONFIRMED",
            notes: null,
            service: { name: "تنظيف أسنان", durationMinutes: 30 },
          },
        ],
      };

      await act(async () => {
        root.render(<ConversationDetail data={dataWithNov7Apt} />);
      });

      expect(container.textContent).toContain("السبت");
      expect(container.textContent).toContain("نوفمبر");
      expect(container.textContent).toMatch(/[7٧]/);
      expect(container.textContent).not.toContain("الجمعة، ٦ نوفمبر");
      expect(container.textContent).not.toContain("الجمعة، 6 نوفمبر");
    });
  });
});
