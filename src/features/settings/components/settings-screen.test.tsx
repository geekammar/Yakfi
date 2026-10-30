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
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
  };

  it("renders START_ONLY selected by default with Arabic labels and local examples", async () => {
    await act(async () => {
      root.render(<SettingsScreen initialSettings={baseSettings} />);
    });

    const startOnlyRadio = container.querySelector(
      "#time-display-START_ONLY",
    ) as HTMLInputElement | null;
    const fullRangeRadio = container.querySelector(
      "#time-display-FULL_RANGE",
    ) as HTMLInputElement | null;

    expect(startOnlyRadio).not.toBeNull();
    expect(fullRangeRadio).not.toBeNull();
    expect(startOnlyRadio?.checked).toBe(true);
    expect(fullRangeRadio?.checked).toBe(false);

    expect(container.textContent).toContain("طريقة عرض وقت الموعد للعميل");
    expect(container.textContent).toContain("البداية فقط");
    expect(container.textContent).toContain("مثل: 2:00 م");
    expect(container.textContent).toContain("الفترة كاملة");
    expect(container.textContent).toContain("مثل: 2:00 م إلى 2:40 م");
  });

  it("allows switching to FULL_RANGE and submits the preference in the form payload", async () => {
    await act(async () => {
      root.render(<SettingsScreen initialSettings={baseSettings} />);
    });

    const fullRangeRadio = container.querySelector(
      "#time-display-FULL_RANGE",
    ) as HTMLInputElement;
    expect(fullRangeRadio).not.toBeNull();

    await act(async () => {
      fullRangeRadio.click();
    });

    expect(fullRangeRadio.checked).toBe(true);

    const form = container.querySelector("form");
    expect(form).not.toBeNull();

    await act(async () => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
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
    ) as HTMLInputElement;
    const fullRangeRadio = container.querySelector(
      "#time-display-FULL_RANGE",
    ) as HTMLInputElement;

    expect(startOnlyRadio.checked).toBe(false);
    expect(fullRangeRadio.checked).toBe(true);
  });
});
