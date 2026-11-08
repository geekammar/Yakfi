import type { BusinessSettingsView } from "@/features/settings/types";

import SettingsPage from "@/app/(app)/settings/page";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRequireRole,
  mockRedirect,
  mockGetBusinessSettings,
  mockListByBusiness,
  mockFindByIdWithinBusiness,
  mockUpdateBusinessSettingsAction,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  mockGetBusinessSettings: vi.fn(),
  mockListByBusiness: vi.fn(),
  mockFindByIdWithinBusiness: vi.fn(),
  mockUpdateBusinessSettingsAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock("@/server/auth/guards", () => ({
  requireRole: () => mockRequireRole(),
}));

vi.mock("@/features/settings/server/settings-service", () => ({
  getBusinessSettings: () => mockGetBusinessSettings(),
  defaultSettingsServiceDeps: {},
}));

vi.mock("@/server/repositories", () => ({
  serviceRepository: {
    listByBusiness: (...args: unknown[]) => mockListByBusiness(...args),
    findByIdWithinBusiness: (...args: unknown[]) =>
      mockFindByIdWithinBusiness(...args),
  },
}));

vi.mock("@/features/settings/actions/settings-actions", () => ({
  updateBusinessSettingsAction: (...args: unknown[]) =>
    mockUpdateBusinessSettingsAction(...args),
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

describe("SettingsPage Data-Loading Boundary (ISS-007 / BK-41 Regression)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const sampleSession = {
    user: {
      id: "usr_admin_1",
      role: "ADMIN",
      businessId: "biz_test_123",
      email: "admin@test.com",
    },
  };

  const baseSettings: BusinessSettingsView = {
    name: "مركز الشفاء الطبي",
    vertical: "clinic",
    city: "الرياض",
    whatsappNumber: "+966500000001",
    timezone: "Asia/Riyadh",
    about: "مركز طبي متكامل",
    address: "طريق الملك فهد",
    confirmationMode: "automatic",
    appointmentTimeDisplay: "START_ONLY",
    slotDurationMinutes: 30,
    cancellationPolicy: "قبل 24 ساعة",
    reminderEnabled: false,
    reminderLeadHours: 24,
    reminderTemplateId: "standard",
    remindersOperational: false,
    defaultServiceBookingEnabled: true,
    defaultBookingServiceId: null,
    channelReadiness: {
      whatsapp: true,
      telegram: true,
      hasActiveChannel: true,
    },
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();

    mockRequireRole.mockResolvedValue(sampleSession);
    mockUpdateBusinessSettingsAction.mockResolvedValue({ success: true });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("resolves and displays a known inactive saved default service within tenant", async () => {
    // 1. serviceRepository.listByBusiness only returns active services
    mockListByBusiness.mockResolvedValue([
      { id: "srv-active-1", name: "كشف استشاري", isActive: true },
      { id: "srv-active-2", name: "متابعة دورية", isActive: true },
    ]);

    // 2. Settings points to an inactive default service
    mockGetBusinessSettings.mockResolvedValue({
      ...baseSettings,
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-inactive-saved",
    });

    // 3. Point lookup within business resolves the inactive record
    mockFindByIdWithinBusiness.mockResolvedValue({
      id: "srv-inactive-saved",
      name: "خدمة قديمة متوقفة",
      isActive: false,
      businessId: "biz_test_123",
      deletedAt: null,
    });

    const jsx = await SettingsPage();

    // Verify props passed to SettingsScreen
    expect(jsx.props.services).toEqual(
      expect.arrayContaining([
        { id: "srv-active-1", name: "كشف استشاري", isActive: true },
        { id: "srv-active-2", name: "متابعة دورية", isActive: true },
        {
          id: "srv-inactive-saved",
          name: "خدمة قديمة متوقفة",
          isActive: false,
        },
      ]),
    );

    // Verify rendered DOM UI
    await act(async () => {
      root.render(jsx);
    });

    // The inactive warning alert with the service name must be present
    expect(container.textContent).toContain(
      "الخدمة الافتراضية المحفوظة غير مفعّلة (خدمة قديمة متوقفة)",
    );
    expect(container.textContent).toContain("خدمة قديمة متوقفة (غير مفعّلة)");

    // Must NOT show generic "unavailable" state
    expect(container.textContent).not.toContain("خدمة غير متاحة");

    // Active preview must be hidden
    expect(container.textContent).not.toContain("معاينة سلوك الحجز مع العميل:");

    // Lookup was tenant-scoped
    expect(mockFindByIdWithinBusiness).toHaveBeenCalledWith(
      "srv-inactive-saved",
      "biz_test_123",
    );
  });

  it("does not append point-lookup record when resolved record is active (preserves active catalog pagination and order)", async () => {
    // 1. serviceRepository.listByBusiness returns bounded active page
    const originalActivePage = [
      { id: "srv-active-1", name: "أ. خدمة أولى", isActive: true },
      { id: "srv-active-2", name: "ب. خدمة ثانية", isActive: true },
    ];
    mockListByBusiness.mockResolvedValue(originalActivePage);

    // 2. Settings points to a service absent from the current active page
    mockGetBusinessSettings.mockResolvedValue({
      ...baseSettings,
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-active-page-2",
    });

    // 3. Point lookup returns an active record (outside current active page)
    mockFindByIdWithinBusiness.mockResolvedValue({
      id: "srv-active-page-2",
      name: "ج. خدمة نشطة في صفحة تالية",
      isActive: true,
      businessId: "biz_test_123",
      deletedAt: null,
    });

    const jsx = await SettingsPage();

    // Active services passed to SettingsScreen must be EXACTLY the original ordered list
    expect(jsx.props.services).toEqual([
      { id: "srv-active-1", name: "أ. خدمة أولى", isActive: true },
      { id: "srv-active-2", name: "ب. خدمة ثانية", isActive: true },
    ]);
  });

  it("shows generic unavailable state when saved default cannot be resolved (missing, deleted, or foreign tenant)", async () => {
    // 1. Active-only services
    mockListByBusiness.mockResolvedValue([
      { id: "srv-active-1", name: "كشف استشاري", isActive: true },
    ]);

    // 2. Settings points to an unresolvable ID
    mockGetBusinessSettings.mockResolvedValue({
      ...baseSettings,
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-deleted-or-foreign",
    });

    // 3. Point lookup returns null (filtered out by deletedAt or businessId mismatch)
    mockFindByIdWithinBusiness.mockResolvedValue(null);

    const jsx = await SettingsPage();

    // Services passed to SettingsScreen does not contain the unresolvable ID
    expect(jsx.props.services).toEqual([
      { id: "srv-active-1", name: "كشف استشاري", isActive: true },
    ]);

    await act(async () => {
      root.render(jsx);
    });

    // Must display generic unavailable state without exposing service name or assuming cause
    expect(container.textContent).toContain("خدمة غير متاحة");
    expect(container.textContent).toContain(
      "الخدمة الافتراضية المحفوظة غير متاحة",
    );
    expect(container.textContent).not.toContain(
      "الخدمة الافتراضية المحفوظة غير مفعّلة",
    );
    expect(container.textContent).not.toContain("معاينة سلوك الحجز مع العميل:");
  });

  it("skips point lookup when saved default is already among active services", async () => {
    mockListByBusiness.mockResolvedValue([
      { id: "srv-active-1", name: "كشف استشاري", isActive: true },
    ]);

    mockGetBusinessSettings.mockResolvedValue({
      ...baseSettings,
      defaultServiceBookingEnabled: true,
      defaultBookingServiceId: "srv-active-1",
    });

    const jsx = await SettingsPage();

    // No extra query should be executed
    expect(mockFindByIdWithinBusiness).not.toHaveBeenCalled();

    await act(async () => {
      root.render(jsx);
    });

    expect(container.textContent).toContain("كشف استشاري");
    expect(container.textContent).toContain("معاينة سلوك الحجز مع العميل:");
  });

  it("skips point lookup when no default service is configured", async () => {
    mockListByBusiness.mockResolvedValue([
      { id: "srv-active-1", name: "كشف استشاري", isActive: true },
    ]);

    mockGetBusinessSettings.mockResolvedValue({
      ...baseSettings,
      defaultServiceBookingEnabled: false,
      defaultBookingServiceId: null,
    });

    const jsx = await SettingsPage();

    expect(mockFindByIdWithinBusiness).not.toHaveBeenCalled();

    await act(async () => {
      root.render(jsx);
    });

    expect(container.textContent).not.toContain(
      "الخدمة الافتراضية المحفوظة غير مفعّلة",
    );
    expect(container.textContent).not.toContain("خدمة غير متاحة");
  });
});
