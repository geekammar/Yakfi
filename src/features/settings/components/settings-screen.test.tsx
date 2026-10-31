/**
 * Settings Screen — Appointment Time Display Preference Form & Lifecycle Verification.
 *
 * Mounts the real `SettingsScreen` in jsdom against a mocked server action boundary
 * (`updateBusinessSettingsAction`). Verifies:
 *   a) Default START_ONLY selection and Arabic labels/examples.
 *   b) Radio selection switch to FULL_RANGE.
 *   c) Form submission captures { appointmentTimeDisplay: "FULL_RANGE" } in payload.
 *   d) Re-open with saved FULL_RANGE reflects persisted state.
 */
import { SettingsScreen } from "@/features/settings/components/settings-screen";
import type { BusinessSettingsView } from "@/features/settings/types";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { updateBusinessSettingsAction } = vi.hoisted(() => ({
  updateBusinessSettingsAction: vi.fn(),
}));

vi.mock("@/features/settings/actions/settings-actions", () => ({
  updateBusinessSettingsAction,
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

describe("SettingsScreen — Customer Appointment Time Display Preference", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    updateBusinessSettingsAction.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const baseSettings: BusinessSettingsView = {
    name: "عيادة النور",
    vertical: "dental",
    city: "القاهرة",
    whatsappNumber: "+201000000001",
    timezone: "Africa/Cairo",
    about: "عيادة متخصصة",
    address: "الدقي",
    confirmationMode: "automatic",
    appointmentTimeDisplay: "START_ONLY",
    slotDurationMinutes: 30,
    cancellationPolicy: "قبل 24 ساعة",
    reminderEnabled: false,
    reminderLeadHours: 24,
    reminderTemplateId: "standard",
    remindersOperational: false,
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
    channelReadiness: {
      whatsapp: false,
      telegram: false,
      hasActiveChannel: false,
    },
  };

  it("renders START_ONLY selected by default with Arabic labels and local examples", async () => {
    await act(async () => {
      root.render(<SettingsScreen initialSettings={baseSettings} />);
    });

    const startOnlyRadio = container.querySelector(
      "#time-display-START_ONLY",
    ) as HTMLElement | null;
    const fullRangeRadio = container.querySelector(
      "#time-display-FULL_RANGE",
    ) as HTMLElement | null;

    expect(startOnlyRadio).not.toBeNull();
    expect(fullRangeRadio).not.toBeNull();
    expect(startOnlyRadio?.getAttribute("data-state")).toBe("checked");
    expect(fullRangeRadio?.getAttribute("data-state")).toBe("unchecked");

    expect(container.textContent).toContain("طريقة عرض وقت الموعد للعميل");
    expect(container.textContent).toContain("البداية فقط");
    expect(container.textContent).toContain("مثال: 2:00 م");
    expect(container.textContent).toContain("الفترة كاملة");
    expect(container.textContent).toContain("مثال: 2:00 م إلى 2:40 م");
  });

  it("allows switching to FULL_RANGE and submits the preference in the form payload", async () => {
    await act(async () => {
      root.render(<SettingsScreen initialSettings={baseSettings} />);
    });

    const startOnlyRadio = container.querySelector(
      "#time-display-START_ONLY",
    ) as HTMLElement;
    const fullRangeRadio = container.querySelector(
      "#time-display-FULL_RANGE",
    ) as HTMLElement;
    expect(fullRangeRadio).not.toBeNull();

    await act(async () => {
      fullRangeRadio.click();
    });

    expect(fullRangeRadio.getAttribute("data-state")).toBe("checked");
    expect(startOnlyRadio.getAttribute("data-state")).toBe("unchecked");

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ الإعدادات"),
    );
    expect(saveButton).toBeDefined();

    await act(async () => {
      saveButton?.click();
    });

    expect(updateBusinessSettingsAction).toHaveBeenCalledTimes(1);
    const submittedPayload = updateBusinessSettingsAction.mock.calls[0]?.[0];
    expect(submittedPayload).toMatchObject({
      appointmentTimeDisplay: "FULL_RANGE",
      name: "عيادة النور",
    });
  });

  it("reflects persisted FULL_RANGE on screen reload/reopen", async () => {
    const fullRangeSettings: BusinessSettingsView = {
      ...baseSettings,
      appointmentTimeDisplay: "FULL_RANGE",
    };

    await act(async () => {
      root.render(<SettingsScreen initialSettings={fullRangeSettings} />);
    });

    const startOnlyRadio = container.querySelector(
      "#time-display-START_ONLY",
    ) as HTMLElement;
    const fullRangeRadio = container.querySelector(
      "#time-display-FULL_RANGE",
    ) as HTMLElement;

    expect(startOnlyRadio.getAttribute("data-state")).toBe("unchecked");
    expect(fullRangeRadio.getAttribute("data-state")).toBe("checked");
  });
});

describe("SettingsScreen — Inactive & Unavailable Default Booking Service (ISS-007 / BK-41)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    updateBusinessSettingsAction.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  const baseSettings: BusinessSettingsView = {
    name: "عيادة النور",
    vertical: "dental",
    city: "القاهرة",
    whatsappNumber: "+201000000001",
    timezone: "Africa/Cairo",
    about: "عيادة متخصصة",
    address: "الدقي",
    confirmationMode: "automatic",
    appointmentTimeDisplay: "START_ONLY",
    slotDurationMinutes: 30,
    cancellationPolicy: "قبل 24 ساعة",
    reminderEnabled: false,
    reminderLeadHours: 24,
    reminderTemplateId: "standard",
    remindersOperational: false,
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
    channelReadiness: {
      whatsapp: true,
      telegram: true,
      hasActiveChannel: true,
    },
  };

  const sampleServices = [
    { id: "srv-active-1", name: "كشف عام", isActive: true },
    { id: "srv-active-2", name: "استشارة تخصصية", isActive: true },
    { id: "srv-inactive-1", name: "خدمة قديمة متوقفة", isActive: false },
  ];

  async function renderScreen(
    settingsOverrides: Partial<BusinessSettingsView> = {},
    services = sampleServices,
  ) {
    const settings: BusinessSettingsView = {
      ...baseSettings,
      ...settingsOverrides,
    };
    await act(async () => {
      root.render(
        <SettingsScreen initialSettings={settings} services={services} />,
      );
    });
    return { container };
  }

  it("1. Active saved default: renders correct selection and normal preview", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-active-1",
    });

    const trigger = container.querySelector("#settings-default-service");
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("كشف عام");

    // Normal preview is rendered with the active service name
    expect(container.textContent).toContain("معاينة سلوك الحجز مع العميل:");
    expect(container.textContent).toContain("كشف عام");

    // No warning alerts rendered for active service in booking section
    const bookingSection = container.querySelector(
      "section[aria-labelledby='settings-booking-section']",
    );
    expect(bookingSection?.querySelector("[role='alert']")).toBeNull();
  });

  it("2. Inactive saved default: service identity and warning are visible; no misleading success preview", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-inactive-1",
    });

    // Inactive service name is visible in trigger
    const trigger = container.querySelector("#settings-default-service");
    expect(trigger?.textContent).toContain("خدمة قديمة متوقفة (غير مفعّلة)");

    // Accessible warning is visible explaining inactive status
    const bookingSection = container.querySelector(
      "section[aria-labelledby='settings-booking-section']",
    );
    const alert = bookingSection?.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain(
      "الخدمة الافتراضية المحفوظة غير مفعّلة (خدمة قديمة متوقفة)",
    );
    expect(alert?.textContent).toContain("غير مفعّلة حالياً");

    // Misleading success booking preview is NOT rendered
    expect(container.textContent).not.toContain("معاينة سلوك الحجز مع العميل:");
  });

  it("3. Missing saved ID: honest unavailable state without fabricated cause", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-missing-unknown-id",
    });

    // Trigger shows unavailable state
    const trigger = container.querySelector("#settings-default-service");
    expect(trigger?.textContent).toContain("خدمة غير متاحة");

    // Warning is visible and honest
    const bookingSection = container.querySelector(
      "section[aria-labelledby='settings-booking-section']",
    );
    const alert = bookingSection?.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain(
      "الخدمة الافتراضية المحفوظة غير متاحة",
    );
    expect(alert?.textContent).toContain(
      "غير متاحة في قائمة خدمات المنشأة الحالية",
    );

    // Does not invent that it was deleted or belongs to another business
    expect(alert?.textContent).not.toContain("محذوفة");
    expect(alert?.textContent).not.toContain("منشأة أخرى");

    // Misleading preview is NOT rendered
    expect(container.textContent).not.toContain("معاينة سلوك الحجز مع العميل:");
  });

  it("4. No configured default: normal empty state, not an inactive warning", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: false,
      defaultBookingServiceId: null,
    });

    // Trigger shows default placeholder
    const trigger = container.querySelector("#settings-default-service");
    expect(trigger?.textContent).toContain("اختر الخدمة الافتراضية");

    // Disabled status banner is shown
    expect(container.textContent).toContain("الحالة الحالية: الوضع معطّل");

    // No inactive or unavailable alert is rendered in booking section
    const bookingSection = container.querySelector(
      "section[aria-labelledby='settings-booking-section']",
    );
    expect(bookingSection?.querySelector("[role='alert']")).toBeNull();
    expect(container.textContent).not.toContain(
      "الخدمة الافتراضية المحفوظة غير مفعّلة",
    );
    expect(container.textContent).not.toContain(
      "الخدمة الافتراضية المحفوظة غير متاحة",
    );

    // No preview is shown
    expect(container.textContent).not.toContain("معاينة سلوك الحجز مع العميل:");
  });

  it("5. Page mount does not submit, clear or replace the saved configuration", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-inactive-1",
    });

    // No submit fired on mount
    expect(updateBusinessSettingsAction).not.toHaveBeenCalled();

    // Checkbox remains checked and saved ID remains intact in trigger
    const checkbox = container.querySelector(
      "#settings-default-service-enabled",
    ) as HTMLElement | null;
    expect(checkbox?.getAttribute("data-state")).toBe("checked");

    const trigger = container.querySelector("#settings-default-service");
    expect(trigger?.textContent).toContain("خدمة قديمة متوقفة (غير مفعّلة)");
  });

  it("6. Selecting an active replacement produces the intended save payload", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-inactive-1",
    });

    // Replace selection with active service via bubble select or direct trigger
    const trigger = container.querySelector(
      "#settings-default-service",
    ) as HTMLElement;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerType: "mouse",
        }),
      );
      trigger.click();
    });

    const activeOption = Array.from(
      document.body.querySelectorAll("[role='option']"),
    ).find((el) => el.textContent?.includes("استشارة تخصصية")) as
      HTMLElement | undefined;

    if (activeOption) {
      await act(async () => {
        activeOption.click();
      });
    } else {
      const bubbleSelect = container.querySelector(
        "select",
      ) as HTMLSelectElement | null;
      if (bubbleSelect) {
        await act(async () => {
          bubbleSelect.value = "srv-active-2";
          bubbleSelect.dispatchEvent(new Event("change", { bubbles: true }));
        });
      }
    }

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ الإعدادات"),
    );
    expect(saveButton).toBeDefined();

    await act(async () => {
      saveButton?.click();
    });

    expect(updateBusinessSettingsAction).toHaveBeenCalledTimes(1);
    const submittedPayload = updateBusinessSettingsAction.mock.calls[0]?.[0];
    expect(submittedPayload).toMatchObject({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-active-2",
    });
  });

  it("7. Explicit disable + explicit clear produces false + null", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-inactive-1",
    });

    // Explicit disable
    const checkbox = container.querySelector(
      "#settings-default-service-enabled",
    ) as HTMLElement;
    await act(async () => {
      checkbox.click();
    });
    expect(checkbox.getAttribute("data-state")).toBe("unchecked");

    // Explicit clear
    const clearButton = container.querySelector(
      "button[aria-label='إلغاء اختيار الخدمة الافتراضية']",
    ) as HTMLButtonElement | null;
    expect(clearButton).not.toBeNull();

    await act(async () => {
      clearButton?.click();
    });

    // Save
    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ الإعدادات"),
    );
    await act(async () => {
      saveButton?.click();
    });

    expect(updateBusinessSettingsAction).toHaveBeenCalledTimes(1);
    const submittedPayload = updateBusinessSettingsAction.mock.calls[0]?.[0];
    expect(submittedPayload).toMatchObject({
      defaultServiceBookingEnabled: false,
      defaultBookingServiceId: null,
    });
  });

  it("8. Invalid active-mode save remains blocked/rejected", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-inactive-1",
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ الإعدادات"),
    );

    await act(async () => {
      saveButton?.click();
    });

    // Save must not succeed and action must be blocked or rejected
    expect(updateBusinessSettingsAction).not.toHaveBeenCalled();

    // Error message is displayed
    expect(container.textContent).toContain(
      "الخدمة الافتراضية المحددة غير صالحة أو غير مفعّلة",
    );
    expect(container.textContent).not.toContain("تم حفظ الإعدادات");
  });

  it("9. Failed save preserves the user's draft and shows no success", async () => {
    updateBusinessSettingsAction.mockResolvedValueOnce({
      success: false,
      message: "تعذر حفظ الإعدادات الآن",
    });

    await renderScreen({
      defaultServiceBookingEnabled: false,
      defaultBookingServiceId: null,
      name: "عيادة النور",
    });

    const nameInput = container.querySelector(
      "#settings-name",
    ) as HTMLInputElement;
    expect(nameInput).not.toBeNull();

    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      descriptor?.set?.call(nameInput, "عيادة النور الجديدة المسودة");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("حفظ الإعدادات"),
    );

    await act(async () => {
      saveButton?.click();
    });

    expect(updateBusinessSettingsAction).toHaveBeenCalledTimes(1);

    // Shows failure message and does not show success
    expect(container.textContent).toContain("تعذر حفظ الإعدادات الآن");
    expect(container.textContent).not.toContain("تم حفظ الإعدادات");

    // Preserves draft input
    expect(nameInput.value).toBe("عيادة النور الجديدة المسودة");
  });

  it("10. Warnings and recovery controls have clear Arabic accessible labels", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-inactive-1",
    });

    // Warning has role="alert" in booking section
    const bookingSection = container.querySelector(
      "section[aria-labelledby='settings-booking-section']",
    );
    const alert = bookingSection?.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.getAttribute("role")).toBe("alert");

    // Clear recovery button has clear Arabic accessible label
    const clearButton = container.querySelector(
      "button[aria-label='إلغاء اختيار الخدمة الافتراضية']",
    );
    expect(clearButton).not.toBeNull();
    expect(clearButton?.textContent?.trim()).toBe("إلغاء التحديد");

    // Trigger has aria-invalid set to true when retaining inactive service
    const trigger = container.querySelector("#settings-default-service");
    expect(trigger?.getAttribute("aria-invalid")).toBe("true");
  });

  it("toggling checkbox alone does not clear the configured defaultBookingServiceId", async () => {
    await renderScreen({
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-inactive-1",
    });

    const checkbox = container.querySelector(
      "#settings-default-service-enabled",
    ) as HTMLElement;

    // Toggle off
    await act(async () => {
      checkbox.click();
    });

    // The selection is NOT silently cleared
    const trigger = container.querySelector("#settings-default-service");
    expect(trigger?.textContent).toContain("خدمة قديمة متوقفة (غير مفعّلة)");

    // Clear button is still available
    const clearButton = container.querySelector(
      "button[aria-label='إلغاء اختيار الخدمة الافتراضية']",
    );
    expect(clearButton).not.toBeNull();
  });
});
