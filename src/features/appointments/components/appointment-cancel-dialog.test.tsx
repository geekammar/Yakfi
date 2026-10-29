/**
 * FlowPilot — Appointment Cancellation Confirmation Tests
 *
 * Verifies that:
 * 1. Opening the cancel dialog causes ZERO mutations.
 * 2. Dismissing the dialog (via Escape, close button X, or Decline "تراجع") causes ZERO mutations.
 * 3. Appointment identity (customer, service, date/time) is displayed accurately.
 * 4. Explicit confirmation invokes updateAppointmentStatus exactly ONCE.
 * 5. Duplicate clicks while pending are prevented (action called only once, buttons disabled).
 * 6. Server failures preserve state, report error in role="alert", and keep dialog open for recovery.
 * 7. Focus containment and restoration:
 *    - Dismissal restores focus to the opener element.
 *    - Successful cancellation restores focus to an appropriate surviving control when opener unmounts.
 * 8. AppointmentDetail integration:
 *    - Clicking "إلغاء الموعد" opens the confirmation dialog without mutating immediately.
 *    - Confirmed cancellation updates appointment status to CANCELLED only after server confirmation.
 * 9. Error lifecycle & controlled parent reopening:
 *    - Server failure persists across normal re-renders while open.
 *    - Target appointment change resets previous unrelated error.
 *    - Dismissing and reopening via actual opener resets stale error; causes 0 additional mutations; allows working retry.
 */

import {
  AppointmentCancelDialog,
  type AppointmentCancelTarget,
} from "@/features/appointments/components/appointment-cancel-dialog";
import { AppointmentDetail } from "@/features/appointments/components/appointment-detail";
import type { AppointmentDetailData } from "@/features/appointments/types";

import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { updateAppointmentStatus } = vi.hoisted(() => ({
  updateAppointmentStatus: vi.fn(),
}));

vi.mock("@/server/auth/guards", () => ({
  requireUser: vi.fn(),
  requireAdmin: vi.fn(),
  currentUser: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@/features/appointments/actions/appointment-actions", () => ({
  updateAppointmentStatus,
}));

vi.mock("@/features/appointments/actions/follow-up-actions", () => ({
  createFollowUpRequest: vi.fn(),
  cancelFollowUpRequest: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/appointments/apt-123",
}));

const FIXTURE_APPOINTMENT: AppointmentCancelTarget = {
  id: "apt-123",
  date: "2026-11-04",
  startTime: "1970-01-01T10:00:00.000Z",
  endTime: "1970-01-01T11:00:00.000Z",
  customer: {
    name: "مريم أحمد محمود",
    phone: "+201098765432",
  },
  service: {
    name: "جلسة تنظيف وتلميع أسنان",
    durationMinutes: 60,
  },
};

const FIXTURE_DETAIL_DATA: AppointmentDetailData = {
  id: "apt-123",
  date: "2026-11-04",
  startTime: "1970-01-01T10:00:00.000Z",
  endTime: "1970-01-01T11:00:00.000Z",
  status: "CONFIRMED",
  notes: "ملاحظات الموعد المسبقة",
  customer: {
    id: "cust-1",
    name: "مريم أحمد محمود",
    phone: "+201098765432",
  },
  service: {
    id: "srv-1",
    name: "جلسة تنظيف وتلميع أسنان",
    durationMinutes: 60,
  },
  provider: {
    id: "prov-1",
    name: "د. طارق",
    displayName: "د. طارق",
  },
  conversationId: null,
};

describe("AppointmentCancelDialog component & boundaries", () => {
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

  it("1. opening the dialog causes ZERO mutations and identifies appointment accurately", () => {
    render(
      <AppointmentCancelDialog
        open={true}
        onOpenChange={vi.fn()}
        appointment={FIXTURE_APPOINTMENT}
        onCancelled={vi.fn()}
      />,
    );

    expect(updateAppointmentStatus).not.toHaveBeenCalled();

    const dialogContent = document.body.querySelector(
      '[data-slot="dialog-content"]',
    );
    expect(dialogContent).toBeTruthy();

    // Verify identification: customer name, service name, and date/time
    const customerEl = document.body.querySelector(
      '[data-testid="cancel-customer-name"]',
    );
    const serviceEl = document.body.querySelector(
      '[data-testid="cancel-service-name"]',
    );
    const datetimeEl = document.body.querySelector(
      '[data-testid="cancel-datetime"]',
    );

    expect(customerEl?.textContent).toContain("مريم أحمد محمود");
    expect(serviceEl?.textContent).toContain("جلسة تنظيف وتلميع أسنان");
    expect(datetimeEl?.textContent).toContain("١٠:٠٠");
    expect(datetimeEl?.textContent).toContain("١١:٠٠");
    expect(datetimeEl?.textContent).toContain("نوفمبر");
  });

  it("2. dismissing via Escape causes ZERO mutations and requests close", () => {
    const onOpenChange = vi.fn();
    render(
      <AppointmentCancelDialog
        open={true}
        onOpenChange={onOpenChange}
        appointment={FIXTURE_APPOINTMENT}
        onCancelled={vi.fn()}
      />,
    );

    const dialogContent = document.body.querySelector(
      '[data-slot="dialog-content"]',
    );
    expect(dialogContent).toBeTruthy();

    act(() => {
      dialogContent?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(updateAppointmentStatus).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("3. dismissing via Decline button ('تراجع') causes ZERO mutations", () => {
    const onOpenChange = vi.fn();
    render(
      <AppointmentCancelDialog
        open={true}
        onOpenChange={onOpenChange}
        appointment={FIXTURE_APPOINTMENT}
        onCancelled={vi.fn()}
      />,
    );

    const declineBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-decline-btn"]',
    );
    expect(declineBtn).toBeTruthy();

    act(() => {
      declineBtn?.click();
    });

    expect(updateAppointmentStatus).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("4. dismissing via Close button (X) causes ZERO mutations", () => {
    const onOpenChange = vi.fn();
    render(
      <AppointmentCancelDialog
        open={true}
        onOpenChange={onOpenChange}
        appointment={FIXTURE_APPOINTMENT}
        onCancelled={vi.fn()}
      />,
    );

    const closeBtn = document.body.querySelector<HTMLButtonElement>(
      'button[data-slot="dialog-close"]',
    );
    expect(closeBtn).toBeTruthy();

    act(() => {
      closeBtn?.click();
    });

    expect(updateAppointmentStatus).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("5. explicit confirmation invokes server action with appointment ID and CANCELLED status", async () => {
    updateAppointmentStatus.mockResolvedValueOnce({ success: true });
    const onCancelled = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <AppointmentCancelDialog
        open={true}
        onOpenChange={onOpenChange}
        appointment={FIXTURE_APPOINTMENT}
        onCancelled={onCancelled}
      />,
    );

    const confirmBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-confirm-btn"]',
    );
    expect(confirmBtn).toBeTruthy();

    await act(async () => {
      confirmBtn?.click();
    });

    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);
    expect(updateAppointmentStatus).toHaveBeenCalledWith({
      id: "apt-123",
      status: "CANCELLED",
    });
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("6. duplicate clicks while pending are strictly prevented", async () => {
    let resolveAction!: (val: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolveAction = resolve;
    });
    updateAppointmentStatus.mockReturnValueOnce(pendingPromise);

    const onCancelled = vi.fn();
    render(
      <AppointmentCancelDialog
        open={true}
        onOpenChange={vi.fn()}
        appointment={FIXTURE_APPOINTMENT}
        onCancelled={onCancelled}
      />,
    );

    const confirmBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-confirm-btn"]',
    );
    const declineBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-decline-btn"]',
    );

    // First click initiates mutation
    act(() => {
      confirmBtn?.click();
    });

    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);
    expect(confirmBtn?.disabled).toBe(true);
    expect(declineBtn?.disabled).toBe(true);

    // Second and third rapid clicks while pending
    act(() => {
      confirmBtn?.click();
      confirmBtn?.click();
    });

    // Still only 1 call
    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);

    // Resolve server action
    await act(async () => {
      resolveAction({ success: true });
    });

    expect(onCancelled).toHaveBeenCalledTimes(1);
  });

  it("7. server failure reports error in role='alert', keeps dialog open, and does not report success", async () => {
    updateAppointmentStatus.mockResolvedValueOnce({
      success: false,
      message: "لا يمكن إلغاء موعد منتهٍ أو ملغي مسبقاً",
    });

    const onCancelled = vi.fn();
    const onOpenChange = vi.fn();

    render(
      <AppointmentCancelDialog
        open={true}
        onOpenChange={onOpenChange}
        appointment={FIXTURE_APPOINTMENT}
        onCancelled={onCancelled}
      />,
    );

    const confirmBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-confirm-btn"]',
    );

    await act(async () => {
      confirmBtn?.click();
    });

    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);
    expect(onCancelled).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // Error alert is rendered for the user
    const alertEl = document.body.querySelector('[role="alert"]');
    expect(alertEl).toBeTruthy();
    expect(alertEl?.textContent).toContain(
      "لا يمكن إلغاء موعد منتهٍ أو ملغي مسبقاً",
    );

    // Buttons are re-enabled for recovery or retry
    expect(confirmBtn?.disabled).toBe(false);
  });

  it("8. focus restoration: restores focus to opener on dismiss, and to surviving target on cancellation", async () => {
    const opener = document.createElement("button");
    opener.setAttribute("data-testid", "test-opener-btn");
    opener.textContent = "إلغاء الموعد";
    document.body.appendChild(opener);

    const fallback = document.createElement("button");
    fallback.setAttribute("data-testid", "test-fallback-btn");
    fallback.textContent = "العودة للمواعيد";
    document.body.appendChild(fallback);

    opener.focus();
    expect(document.activeElement).toBe(opener);

    const returnFocusRef = { current: opener };
    const fallbackFocusRef = { current: fallback };

    let open = true;
    const onOpenChange = vi.fn((val: boolean) => {
      open = val;
    });

    const { rerender } = (() => {
      root = createRoot(container);
      const renderComp = (isOpen: boolean) => {
        act(() => {
          root?.render(
            <AppointmentCancelDialog
              open={isOpen}
              onOpenChange={onOpenChange}
              appointment={FIXTURE_APPOINTMENT}
              returnFocusRef={returnFocusRef}
              fallbackFocusRef={fallbackFocusRef}
              onCancelled={vi.fn()}
            />,
          );
        });
      };
      renderComp(open);
      return { rerender: renderComp };
    })();

    // ── Case A: Dismissal while opener survives → focus returns to opener
    act(() => {
      rerender(false);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(document.activeElement).toBe(opener);

    // ── Case B: Reopen, opener unmounts (cancelled), focus falls back to surviving target
    rerender(true);

    // Disconnect opener (mimicking unmount upon status becoming CANCELLED)
    document.body.removeChild(opener);
    expect(opener.isConnected).toBe(false);

    act(() => {
      rerender(false);
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(document.activeElement).toBe(fallback);

    document.body.removeChild(fallback);
  });

  it("9. error lifecycle: active failure persists across normal re-renders while open, and resets when appointment target changes", async () => {
    updateAppointmentStatus.mockResolvedValueOnce({
      success: false,
      message: "خطأ مؤقت بالخادم",
    });

    const onCancelled = vi.fn();
    const onOpenChange = vi.fn();

    const currentAppointment = FIXTURE_APPOINTMENT;
    const { rerender } = (() => {
      root = createRoot(container);
      const renderComp = (apt: AppointmentCancelTarget) => {
        act(() => {
          root?.render(
            <AppointmentCancelDialog
              open={true}
              onOpenChange={onOpenChange}
              appointment={apt}
              onCancelled={onCancelled}
            />,
          );
        });
      };
      renderComp(currentAppointment);
      return { rerender: renderComp };
    })();

    const confirmBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-confirm-btn"]',
    );

    // Fail first attempt
    await act(async () => {
      confirmBtn?.click();
    });

    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);
    let alertEl = document.body.querySelector('[role="alert"]');
    expect(alertEl?.textContent).toContain("خطأ مؤقت بالخادم");

    // Normal re-render with identical appointment target while open MUST NOT clear error
    rerender(currentAppointment);
    alertEl = document.body.querySelector('[role="alert"]');
    expect(alertEl?.textContent).toContain("خطأ مؤقت بالخادم");

    // Changing the appointment target to a different appointment MUST reset the unrelated error
    const SECOND_APPOINTMENT: AppointmentCancelTarget = {
      ...FIXTURE_APPOINTMENT,
      id: "apt-456",
      customer: { name: "أحمد سامي" },
    };
    rerender(SECOND_APPOINTMENT);

    alertEl = document.body.querySelector('[role="alert"]');
    expect(alertEl).toBeNull();
  });
});

describe("AppointmentDetail cancel confirmation integration", () => {
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

  it("clicking 'إلغاء الموعد' opens dialog without mutating; explicit confirm cancels on server", async () => {
    updateAppointmentStatus.mockResolvedValueOnce({ success: true });

    render(
      <AppointmentDetail
        initialData={FIXTURE_DETAIL_DATA}
        today="2026-11-04"
        timezone="Africa/Cairo"
      />,
    );

    const cancelOpenerBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="appointment-cancel-opener-btn"]',
    );
    expect(cancelOpenerBtn).toBeTruthy();

    // Clicking opener MUST NOT invoke updateAppointmentStatus
    act(() => {
      cancelOpenerBtn?.click();
    });

    expect(updateAppointmentStatus).not.toHaveBeenCalled();

    // Dialog is now open
    const dialogContent = document.body.querySelector(
      '[data-slot="dialog-content"]',
    );
    expect(dialogContent).toBeTruthy();

    const confirmBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-confirm-btn"]',
    );
    expect(confirmBtn).toBeTruthy();

    // Click confirm in the dialog
    await act(async () => {
      confirmBtn?.click();
    });

    // updateAppointmentStatus called with CANCELLED
    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);
    expect(updateAppointmentStatus).toHaveBeenCalledWith({
      id: "apt-123",
      status: "CANCELLED",
    });

    // Opener button is unmounted because appointment is no longer active
    const unmountedOpenerBtn = container.querySelector(
      '[data-testid="appointment-cancel-opener-btn"]',
    );
    expect(unmountedOpenerBtn).toBeNull();
  });

  it("resets stale cancellation error on dismiss and reopening through actual opener, with working retry", async () => {
    // 1. Server returns failure on first attempt, then succeeds on retry
    updateAppointmentStatus
      .mockResolvedValueOnce({
        success: false,
        message: "فشل الإلغاء: تعذر الاتصال بالخادم",
      })
      .mockResolvedValueOnce({
        success: true,
      });

    render(
      <AppointmentDetail
        initialData={FIXTURE_DETAIL_DATA}
        today="2026-11-04"
        timezone="Africa/Cairo"
      />,
    );

    const cancelOpenerBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="appointment-cancel-opener-btn"]',
    );
    expect(cancelOpenerBtn).toBeTruthy();

    // 2. Open dialog via the actual opener button
    act(() => {
      cancelOpenerBtn?.click();
    });

    const confirmBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-confirm-btn"]',
    );
    expect(confirmBtn).toBeTruthy();

    // 3. Click confirm -> server returns failure -> error visible in role="alert"
    await act(async () => {
      confirmBtn?.click();
    });

    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);
    let alertEl = document.body.querySelector('[role="alert"]');
    expect(alertEl).toBeTruthy();
    expect(alertEl?.textContent).toContain("فشل الإلغاء: تعذر الاتصال بالخادم");

    // 4. Dismiss through decline button "تراجع"
    const declineBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-decline-btn"]',
    );
    expect(declineBtn).toBeTruthy();

    act(() => {
      declineBtn?.click();
    });

    // Dialog is now dismissed
    expect(
      document.body.querySelector('[data-slot="dialog-content"]'),
    ).toBeNull();

    // 5. Reopen through the actual opener in the controlled parent
    act(() => {
      cancelOpenerBtn?.click();
    });

    // Dialog is reopened
    expect(
      document.body.querySelector('[data-slot="dialog-content"]'),
    ).toBeTruthy();

    // 6. Verify previous error is absent
    alertEl = document.body.querySelector('[role="alert"]');
    expect(alertEl).toBeNull();

    // 7. Reopening caused zero additional mutation calls
    expect(updateAppointmentStatus).toHaveBeenCalledTimes(1);

    // 8. Subsequent explicit retry still works
    const retryConfirmBtn = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="cancel-dialog-confirm-btn"]',
    );
    expect(retryConfirmBtn).toBeTruthy();

    await act(async () => {
      retryConfirmBtn?.click();
    });

    expect(updateAppointmentStatus).toHaveBeenCalledTimes(2);
    expect(updateAppointmentStatus).toHaveBeenLastCalledWith({
      id: "apt-123",
      status: "CANCELLED",
    });

    // Successful cancellation updates status and unmounts the cancel opener
    expect(
      container.querySelector('[data-testid="appointment-cancel-opener-btn"]'),
    ).toBeNull();
  });
});
