/**
 * FlowPilot — Follow-up Scheduling Mounted Component Tests (ISS-006)
 *
 * Verifies:
 * 1. DateStep mounted tests:
 *    - Undated follow-up request (startDate: null, endDate: null) does not throw RangeError or crash.
 *    - Renders explicit Arabic non-restrictive banner: "طلب متابعة دون تاريخ محدد — يمكنك اختيار أي موعد متاح".
 *    - One-sided start range (startDate: "...", endDate: null) renders "ابتداءً من ...".
 *    - One-sided end range (startDate: null, endDate: "...") renders "حتى ...".
 *    - Inverted / invalid range (startDate > endDate) renders "فترة المتابعة غير صالحة".
 *    - Standard valid range renders "من ... إلى ..." and disables out-of-range days with "خارج الفترة".
 * 2. FollowUpList & AppointmentDetail mounted tests:
 *    - Confirmed cancel clicks trigger cancelFollowUpRequest action.
 *    - Optimistic/synchronous state update to "ملغاة" badge upon successful cancellation.
 *    - Server prop refresh updates list without stale state lag.
 *    - Already-cancelled item renders "ملغاة" badge without active cancel button.
 *    - Action failure displays error in role="alert".
 */

import { AppointmentDetail } from "@/features/appointments/components/appointment-detail";
import { FollowUpList } from "@/features/appointments/components/follow-up-list";
import { DateStep } from "@/features/appointments/components/smart-create/date-step";
import type {
  AppointmentDetailData,
  FollowUpRequestWithRelations,
} from "@/types/domain";

import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { cancelFollowUpRequestMock, routerRefreshMock } = vi.hoisted(() => ({
  cancelFollowUpRequestMock: vi.fn(),
  routerRefreshMock: vi.fn(),
}));

vi.mock("@/server/auth/guards", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@/features/appointments/actions/follow-up-actions", () => ({
  cancelFollowUpRequest: cancelFollowUpRequestMock,
  createFollowUpRequest: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: routerRefreshMock,
  }),
  usePathname: () => "/appointments/apt-001",
}));

const TODAY = "2026-11-01";

const FIXTURE_FOLLOW_UP_PENDING: FollowUpRequestWithRelations = {
  id: "fu-pending-1",
  businessId: "biz-1",
  customerId: "cust-1",
  serviceId: "srv-1",
  preferredProviderId: "prov-1",
  sourceAppointmentId: "apt-001",
  scheduledAppointmentId: null,
  createdById: "user-1",
  startDate: null,
  endDate: null,
  status: "PENDING",
  notes: "Follow-up note for tests",
  createdAt: new Date("2026-10-30T10:00:00Z"),
  updatedAt: new Date("2026-10-30T10:00:00Z"),
  deletedAt: null,
  customer: {
    id: "cust-1",
    name: "سارة محمد",
    phone: "+201011112222",
  },
  service: {
    id: "srv-1",
    name: "تنظيف أسنان",
    durationMinutes: 30,
  },
  preferredProvider: {
    id: "prov-1",
    name: "د. أحمد",
    displayName: "د. أحمد",
  },
  sourceAppointment: {
    id: "apt-001",
    date: new Date("2026-10-30"),
    startTime: new Date("1970-01-01T10:00:00Z"),
    endTime: new Date("1970-01-01T10:30:00Z"),
  },
  scheduledAppointment: null,
};

const FIXTURE_FOLLOW_UP_CANCELLED: FollowUpRequestWithRelations = {
  ...FIXTURE_FOLLOW_UP_PENDING,
  id: "fu-cancelled-1",
  status: "CANCELLED",
};

const FIXTURE_DETAIL_DATA: AppointmentDetailData = {
  id: "apt-001",
  date: "2026-10-30",
  startTime: "1970-01-01T10:00:00.000Z",
  endTime: "1970-01-01T10:30:00.000Z",
  status: "CONFIRMED",
  notes: "Note",
  customer: {
    id: "cust-1",
    name: "سارة محمد",
    phone: "+201011112222",
  },
  service: {
    id: "srv-1",
    name: "تنظيف أسنان",
    durationMinutes: 30,
  },
  provider: {
    id: "prov-1",
    name: "د. أحمد",
    displayName: "د. أحمد",
  },
  conversationId: null,
};

describe("Follow-up Scheduling & DateStep Mounted Integration (ISS-006)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
    document.body.innerHTML = "";
  });

  function render(ui: React.ReactElement) {
    root = createRoot(container);
    act(() => {
      root?.render(ui);
    });
  }

  // --- 1. DateStep Mounted Tests ---
  describe("DateStep mounted range handling", () => {
    it("1. undated follow-up request (startDate: null, endDate: null) renders without RangeError or crash", () => {
      expect(() => {
        render(
          <DateStep
            selectedDate={TODAY}
            today={TODAY}
            onSelect={vi.fn()}
            allowedRange={{ startDate: null, endDate: null }}
          />,
        );
      }).not.toThrow();

      const banner = container.textContent;
      expect(banner).toContain("طلب متابعة دون تاريخ محدد — يمكنك اختيار أي موعد متاح");
      expect(banner).not.toContain("Invalid time value");
    });

    it("2. one-sided start date range renders explicit start notice", () => {
      render(
        <DateStep
          selectedDate="2026-11-05"
          today={TODAY}
          onSelect={vi.fn()}
          allowedRange={{ startDate: "2026-11-05", endDate: null }}
        />,
      );

      expect(container.textContent).toContain("ابتداءً من");
    });

    it("3. one-sided end date range renders explicit end notice", () => {
      render(
        <DateStep
          selectedDate="2026-11-05"
          today={TODAY}
          onSelect={vi.fn()}
          allowedRange={{ startDate: null, endDate: "2026-11-10" }}
        />,
      );

      expect(container.textContent).toContain("حتى");
    });

    it("4. inverted / invalid range (startDate > endDate) renders explicit invalid range banner", () => {
      render(
        <DateStep
          selectedDate="2026-11-05"
          today={TODAY}
          onSelect={vi.fn()}
          allowedRange={{ startDate: "2026-11-10", endDate: "2026-11-05" }}
        />,
      );

      expect(container.textContent).toContain("فترة المتابعة غير صالحة");
    });

    it("5. valid continuous range renders date bounds and disables out-of-range days", () => {
      render(
        <DateStep
          selectedDate="2026-11-05"
          today={TODAY}
          onSelect={vi.fn()}
          allowedRange={{ startDate: "2026-11-05", endDate: "2026-11-07" }}
        />,
      );

      expect(container.textContent).toContain("الفترة المحددة من");
      expect(container.textContent).toContain("إلى");
      expect(container.textContent).toContain("خارج الفترة");
    });
  });

  // --- 2. FollowUpList & AppointmentDetail Mounted Tests ---
  describe("FollowUpList & AppointmentDetail mounted cancellation handling", () => {
    it("6. clicking cancel follow-up triggers cancel action and immediately updates to 'ملغاة'", async () => {
      cancelFollowUpRequestMock.mockResolvedValueOnce({
        success: true,
        message: "تم إلغاء طلب المتابعة بنجاح",
      });

      render(
        <FollowUpList
          followUps={[FIXTURE_FOLLOW_UP_PENDING]}
          onRefresh={routerRefreshMock}
        />,
      );

      expect(container.textContent).toContain("بانتظار تحديد موعد");
      const cancelButton = container.querySelector(
        'button:not([disabled])',
      ) as HTMLButtonElement | null;
      expect(cancelButton).toBeTruthy();
      expect(cancelButton?.textContent).toContain("إلغاء المتابعة");

      await act(async () => {
        cancelButton?.click();
      });

      expect(cancelFollowUpRequestMock).toHaveBeenCalledWith({
        id: FIXTURE_FOLLOW_UP_PENDING.id,
      });
      expect(routerRefreshMock).toHaveBeenCalledTimes(1);

      // Verify immediate transition to CANCELLED badge
      expect(container.textContent).toContain("ملغاة");
      expect(container.textContent).not.toContain("بانتظار تحديد موعد");
    });

    it("7. already-cancelled request displays 'ملغاة' badge without active cancel button", () => {
      render(
        <FollowUpList
          followUps={[FIXTURE_FOLLOW_UP_CANCELLED]}
          onRefresh={routerRefreshMock}
        />,
      );

      expect(container.textContent).toContain("ملغاة");
      expect(container.textContent).not.toContain("إلغاء المتابعة");
    });

    it("8. server prop updates re-render list immediately without stale state lock", () => {
      render(
        <FollowUpList
          followUps={[FIXTURE_FOLLOW_UP_PENDING]}
          onRefresh={routerRefreshMock}
        />,
      );
      expect(container.textContent).toContain("بانتظار تحديد موعد");

      // Simulate parent passing fresh prop
      render(
        <FollowUpList
          followUps={[FIXTURE_FOLLOW_UP_CANCELLED]}
          onRefresh={routerRefreshMock}
        />,
      );
      expect(container.textContent).toContain("ملغاة");
      expect(container.textContent).not.toContain("بانتظار تحديد موعد");
    });

    it("9. cancellation action failure renders error in role='alert'", async () => {
      cancelFollowUpRequestMock.mockResolvedValueOnce({
        success: false,
        message: "تعذر إلغاء الطلب حالياً",
      });

      render(
        <FollowUpList
          followUps={[FIXTURE_FOLLOW_UP_PENDING]}
          onRefresh={routerRefreshMock}
        />,
      );

      const cancelButton = container.querySelector(
        'button:not([disabled])',
      ) as HTMLButtonElement | null;

      await act(async () => {
        cancelButton?.click();
      });

      const alert = container.querySelector('[role="alert"]');
      expect(alert).toBeTruthy();
      expect(alert?.textContent).toContain("تعذر إلغاء الطلب حالياً");
    });

    it("10. AppointmentDetail integrates follow-up list with live cancellation flow", async () => {
      cancelFollowUpRequestMock.mockResolvedValueOnce({
        success: true,
        message: "تم إلغاء طلب المتابعة بنجاح",
      });

      render(
        <AppointmentDetail
          initialData={FIXTURE_DETAIL_DATA}
          today={TODAY}
          timezone="Africa/Cairo"
          initialFollowUps={[FIXTURE_FOLLOW_UP_PENDING]}
          services={[]}
          providers={[]}
        />,
      );

      expect(container.textContent).toContain("المتابعات المرتبطة (1)");
      expect(container.textContent).toContain("بانتظار تحديد موعد");

      const cancelButton = Array.from(container.querySelectorAll("button")).find(
        (btn) => btn.textContent?.includes("إلغاء المتابعة"),
      );
      expect(cancelButton).toBeTruthy();

      await act(async () => {
        cancelButton?.click();
      });

      expect(cancelFollowUpRequestMock).toHaveBeenCalledWith({
        id: FIXTURE_FOLLOW_UP_PENDING.id,
      });
      expect(container.textContent).toContain("ملغاة");
    });
  });
});
