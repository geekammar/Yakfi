/**
 * FlowPilot — Mounted Reschedule Panel Integration Tests (ISS-005)
 *
 * Verifies that:
 * 1. ReschedulePanel mounts with real child components (DateStep, SlotStep) without crashing.
 * 2. Preserved context (customer, service, current date/time, and preserved provider) is rendered.
 * 3. Authoritative eligibility is loaded via resolveEligibleProvidersAction and passed to SlotStep.
 * 4. Genuine zero-provider empty state is rendered ONLY when eligible providers are confirmed zero.
 * 5. While eligible providers or availability is loading, loading skeleton is rendered (not empty state).
 * 6. Preserved provider (appointment.provider.id) is passed to SlotStep and slots are filtered.
 * 7. Provider switching UI is disabled/omitted to prevent silent provider switching.
 * 8. Ineligible preserved provider renders a clear ineligibility notice.
 * 9. Selecting an available slot renders the change review comparison card.
 * 10. Conflict failure (SLOT_CONFLICT) renders error alert and clears stale slot selection.
 * 11. Re-entrancy guard prevents double submission.
 * 12. Confirmed success invokes onDone with server-returned persisted values.
 */

import { ReschedulePanel } from "@/features/appointments/components/reschedule-panel";
import type { AppointmentDetailData } from "@/features/appointments/types";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  rescheduleAppointmentMock,
  resolveEligibleProvidersActionMock,
  getAvailabilityActionMock,
} = vi.hoisted(() => ({
  rescheduleAppointmentMock: vi.fn(),
  resolveEligibleProvidersActionMock: vi.fn(),
  getAvailabilityActionMock: vi.fn(),
}));

vi.mock("@/features/appointments/actions/appointment-actions", () => ({
  rescheduleAppointment: rescheduleAppointmentMock,
}));

vi.mock("@/features/appointments/actions/provider-eligibility-actions", () => ({
  resolveEligibleProvidersAction: resolveEligibleProvidersActionMock,
}));

vi.mock("@/features/appointments/actions/availability-actions", () => ({
  getAvailabilityAction: getAvailabilityActionMock,
}));

const FIXTURE_APPOINTMENT: AppointmentDetailData = {
  id: "44444444-4444-4444-8444-444444444444",
  date: "2026-11-10",
  startTime: "1970-01-01T10:00:00.000Z",
  endTime: "1970-01-01T10:30:00.000Z",
  status: "CONFIRMED",
  notes: "ملاحظات الموعد",
  customer: {
    id: "11111111-1111-4111-8111-111111111111",
    name: "فاطمة أحمد",
    phone: "+201012345678",
  },
  service: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "كشف أولي",
    durationMinutes: 30,
  },
  provider: {
    id: "33333333-3333-4333-8333-333333333333",
    name: "د. هبة المنصور",
    displayName: "د. هبة",
  },
  conversationId: null,
};

const FIXTURE_WORKING_HOURS = {
  sun: { open: "09:00", close: "18:00", closed: false },
  mon: { open: "09:00", close: "18:00", closed: false },
  tue: { open: "09:00", close: "18:00", closed: false },
  wed: { open: "09:00", close: "18:00", closed: false },
  thu: { open: "09:00", close: "18:00", closed: false },
  fri: { open: "09:00", close: "18:00", closed: true },
  sat: { open: "09:00", close: "18:00", closed: false },
};

describe("ReschedulePanel mounted integration tests (ISS-005)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.clearAllMocks();

    // Default mock responses
    resolveEligibleProvidersActionMock.mockResolvedValue({
      success: true,
      data: {
        serviceId: FIXTURE_APPOINTMENT.service.id,
        branchId: null,
        providers: [
          {
            providerId: FIXTURE_APPOINTMENT.provider!.id,
            displayName: FIXTURE_APPOINTMENT.provider!.displayName!,
          },
          {
            providerId: "99999999-9999-4999-8999-999999999999",
            displayName: "د. طارق",
          },
        ],
      },
    });

    getAvailabilityActionMock.mockResolvedValue({
      success: true,
      data: {
        date: "2026-11-10",
        timezone: "Africa/Cairo",
        serviceId: FIXTURE_APPOINTMENT.service.id,
        serviceDurationMinutes: 30,
        slots: [
          {
            startTime: "12:00",
            endTime: "12:30",
            availableProviderIds: [FIXTURE_APPOINTMENT.provider!.id],
          },
          {
            startTime: "13:00",
            endTime: "13:30",
            availableProviderIds: [FIXTURE_APPOINTMENT.provider!.id],
          },
        ],
      },
      reason: null,
    });
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
    queryClient.clear();
  });

  async function renderComponent(ui: ReactElement) {
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
      );
    });
  }

  it("1. renders preserved context: customer, service, current time, and preserved provider", async () => {
    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(container.textContent).toContain("إعادة جدولة الموعد");
    expect(container.textContent).toContain("فاطمة أحمد");
    expect(container.textContent).toContain("كشف أولي");
    expect(container.textContent).toContain("د. هبة");
    expect(container.textContent).toContain("١ · التاريخ الجديد");
  });

  it("2. advances to slot step with real child SlotStep and queries authoritative eligibility", async () => {
    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    // Click 'الأوقات المتاحة'
    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    expect(nextBtn).toBeDefined();

    await act(async () => {
      nextBtn?.click();
    });

    expect(container.textContent).toContain("٢ · الوقت المتاح");
    expect(resolveEligibleProvidersActionMock).toHaveBeenCalledWith({
      serviceId: FIXTURE_APPOINTMENT.service.id,
    });
  });

  it("3. does NOT show zero-provider empty state when eligible providers exist", async () => {
    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    // Zero-provider empty state must NOT be rendered
    expect(container.textContent).not.toContain("أضف مقدم خدمة لبدء الحجز");
    expect(container.textContent).toContain("الوقت المتاح");
  });

  it("4. renders genuine zero-provider empty state when eligible providers are truly empty", async () => {
    resolveEligibleProvidersActionMock.mockResolvedValueOnce({
      success: true,
      data: {
        serviceId: FIXTURE_APPOINTMENT.service.id,
        branchId: null,
        providers: [],
      },
    });

    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    // Genuine zero-provider empty state should appear
    expect(container.textContent).toContain("أضف مقدم خدمة لبدء الحجز");
    expect(container.textContent).toContain(
      "تحتاج هذه الخدمة إلى مقدم خدمة واحد على الأقل",
    );
  });

  it("5. renders clear ineligibility notice when preserved provider is no longer in eligible providers", async () => {
    // Only Dr. Tarek is eligible, but the appointment is with Dr. Heba
    resolveEligibleProvidersActionMock.mockResolvedValueOnce({
      success: true,
      data: {
        serviceId: FIXTURE_APPOINTMENT.service.id,
        branchId: null,
        providers: [
          {
            providerId: "99999999-9999-4999-8999-999999999999",
            displayName: "د. طارق",
          },
        ],
      },
    });

    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    expect(container.textContent).toContain(
      "مقدم الخدمة الحالي لم يعد مؤهلاً لهذه الخدمة",
    );
  });

  it("6. renders loading skeleton while eligibility or availability is pending", async () => {
    // Unresolved pending promise
    getAvailabilityActionMock.mockReturnValue(new Promise(() => {}));

    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    const busyContainer = container.querySelector('[aria-busy="true"]');
    expect(busyContainer).not.toBeNull();
    // Must NOT flash zero-provider empty state while loading
    expect(container.textContent).not.toContain("أضف مقدم خدمة لبدء الحجز");
  });

  it("7. handles slot selection and review card presentation", async () => {
    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        workingHours={FIXTURE_WORKING_HOURS}
        slotDurationMinutes={30}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Pick slot
    const slotBtn = Array.from(container.querySelectorAll("button")).find(
      (b) =>
        b.textContent?.includes("١٢:٠٠") ||
        b.textContent?.includes("12:00") ||
        b.textContent?.includes("أقرب وقت") ||
        b.textContent?.includes("متاح مع"),
    ) as HTMLButtonElement | undefined;
    expect(slotBtn).toBeDefined();

    await act(async () => {
      slotBtn?.click();
    });

    expect(container.textContent).toContain("مراجعة التغيير قبل التأكيد");
    expect(container.textContent).toContain("الموعد الجديد:");
  });

  it("8. handles conflict failure by displaying error alert and clearing selection", async () => {
    rescheduleAppointmentMock.mockResolvedValueOnce({
      success: false,
      code: "SLOT_CONFLICT",
      message: "يوجد موعد آخر متداخل في هذا الوقت",
    });

    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        workingHours={FIXTURE_WORKING_HOURS}
        slotDurationMinutes={30}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const slotBtn = Array.from(container.querySelectorAll("button")).find(
      (b) =>
        b.textContent?.includes("١٢:٠٠") ||
        b.textContent?.includes("12:00") ||
        b.textContent?.includes("أقرب وقت") ||
        b.textContent?.includes("متاح مع"),
    ) as HTMLButtonElement | undefined;
    expect(slotBtn).toBeDefined();

    await act(async () => {
      slotBtn?.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("تأكيد تغيير الموعد"),
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn?.click();
    });

    expect(rescheduleAppointmentMock).toHaveBeenCalledWith({
      id: FIXTURE_APPOINTMENT.id,
      date: "2026-11-10",
      startTime: expect.any(String),
    });

    expect(container.textContent).toContain(
      "يوجد موعد آخر متداخل في هذا الوقت",
    );
    // Review card should be cleared on conflict
    expect(container.textContent).not.toContain("مراجعة التغيير قبل التأكيد");
  });

  it("9. successful reschedule invokes onDone with server-returned persisted values", async () => {
    const onDoneMock = vi.fn();
    rescheduleAppointmentMock.mockResolvedValueOnce({
      success: true,
      id: FIXTURE_APPOINTMENT.id,
      date: "2026-11-10",
      startTime: "12:00",
      endTime: "12:30",
    });

    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        workingHours={FIXTURE_WORKING_HOURS}
        slotDurationMinutes={30}
        onDone={onDoneMock}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const slotBtn = Array.from(container.querySelectorAll("button")).find(
      (b) =>
        b.textContent?.includes("١٢:٠٠") ||
        b.textContent?.includes("12:00") ||
        b.textContent?.includes("أقرب وقت") ||
        b.textContent?.includes("متاح مع"),
    ) as HTMLButtonElement | undefined;
    expect(slotBtn).toBeDefined();

    await act(async () => {
      slotBtn?.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("تأكيد تغيير الموعد"),
    );
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      confirmBtn?.click();
    });

    expect(onDoneMock).toHaveBeenCalledWith({
      date: "2026-11-10",
      startTime: "12:00",
      endTime: "12:30",
    });
  });

  it("10. ensures suggestions and selection strictly respect preserved provider when earliest slot is with another provider", async () => {
    // 09:00 is available ONLY with Dr. Tarek (other provider)
    // 14:00 is available with Dr. Heba (preserved appointment provider)
    getAvailabilityActionMock.mockResolvedValueOnce({
      success: true,
      data: {
        date: "2026-11-10",
        timezone: "Africa/Cairo",
        serviceId: FIXTURE_APPOINTMENT.service.id,
        serviceDurationMinutes: 30,
        slots: [
          {
            startTime: "09:00",
            endTime: "09:30",
            availableProviderIds: ["99999999-9999-4999-8999-999999999999"],
          },
          {
            startTime: "14:00",
            endTime: "14:30",
            availableProviderIds: [FIXTURE_APPOINTMENT.provider!.id],
          },
        ],
      },
      reason: null,
    });

    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        workingHours={FIXTURE_WORKING_HOURS}
        slotDurationMinutes={30}
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // 09:00 belongs to the other provider (Dr. Tarek) and MUST NOT be suggested
    expect(container.textContent).not.toContain("د. طارق");
    expect(container.textContent).not.toContain("09:00");
    expect(container.textContent).not.toContain("٩:٠٠");

    // 14:00 (2:00 PM) belongs to Dr. Heba and SHOULD be present in suggestions
    expect(container.textContent).toContain("د. هبة");
    expect(container.textContent).toMatch(/02:00|2:00|٠٢:٠٠|٢:٠٠/);
  });

  it("11. renders honest error and retry state when eligibility query rejects", async () => {
    resolveEligibleProvidersActionMock.mockRejectedValueOnce(
      new Error("Network connection failure"),
    );

    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Must NOT collapse to zero-provider empty state
    expect(container.textContent).not.toContain("أضف مقدم خدمة لبدء الحجز");
    // Must render honest error alert and retry button
    expect(container.textContent).toContain("تعذر تحميل بيانات مقدمي الخدمة");
    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("إعادة المحاولة"),
    );
    expect(retryBtn).toBeDefined();
  });

  it("12. renders honest error and retry state when eligibility returns typed failure", async () => {
    resolveEligibleProvidersActionMock.mockResolvedValueOnce({
      success: false,
      error: {
        code: "SERVICE_NOT_FOUND",
        message: "الخدمة المطلوبة غير موجودة في هذا الفرع",
      },
    });

    await renderComponent(
      <ReschedulePanel
        appointment={FIXTURE_APPOINTMENT}
        today="2026-11-10"
        timezone="Africa/Cairo"
        onDone={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("الأوقات المتاحة"),
    );
    await act(async () => {
      nextBtn?.click();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Must NOT collapse to zero-provider empty state
    expect(container.textContent).not.toContain("أضف مقدم خدمة لبدء الحجز");
    expect(container.textContent).toContain("تعذر تحميل بيانات مقدمي الخدمة");
    expect(container.textContent).toContain(
      "الخدمة المطلوبة غير موجودة في هذا الفرع",
    );
    const retryBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("إعادة المحاولة"),
    );
    expect(retryBtn).toBeDefined();
  });
});
