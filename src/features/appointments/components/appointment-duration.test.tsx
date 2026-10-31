/**
 * FlowPilot — Truthful Appointment Duration Tests (ISS-008 / BK-50)
 *
 * Verifies that:
 * 1. Booked service hint reflects the STORED appointment interval duration.
 * 2. Arabic label "مدة الموعد: N دقيقة" is displayed truthfully.
 * 3. Misleading label "N دقيقة (الأصلية)" is completely removed.
 * 4. Boundary calculations across hours (10:50–11:10) and noon (11:50–12:10)
 *    are exact.
 * 5. Changing catalog service duration does NOT change displayed duration.
 * 6. Changing stored appointment interval directly updates displayed duration.
 * 7. Missing, malformed, equal (end === start), reversed (end < start), or
 *    overnight intervals honestly output "مدة الموعد غير متاحة" without NaN,
 *    negative values, catalog fallback, or invented overnight duration.
 * 8. Booked service name and performed service details remain fully intact.
 */

import {
  APPOINTMENT_DURATION_UNAVAILABLE_LABEL,
  AppointmentDetail,
  calculateAppointmentDurationMinutes,
  formatAppointmentDurationHint,
} from "@/features/appointments/components/appointment-detail";
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
  usePathname: () => "/appointments/apt-bk50",
}));

const BASE_FIXTURE: AppointmentDetailData = {
  id: "apt-bk50",
  date: "2026-11-04",
  startTime: "1970-01-01T10:00:00.000Z",
  endTime: "1970-01-01T10:20:00.000Z",
  status: "CONFIRMED",
  notes: "ملاحظات الفحص الدوري",
  customer: {
    id: "cust-1",
    name: "سارة خالد",
    phone: "+201012345678",
  },
  service: {
    id: "srv-1",
    name: "جلسة تنظيف وتلميع أسنان",
    // Catalog changed to 25 min after booking; stored interval remains 20 min
    durationMinutes: 25,
  },
  provider: {
    id: "prov-1",
    name: "د. طارق",
    displayName: "د. طارق",
  },
  conversationId: null,
};

describe("calculateAppointmentDurationMinutes pure calculation", () => {
  it("calculates exact minutes for standard ISO epoch timestamps", () => {
    expect(
      calculateAppointmentDurationMinutes(
        "1970-01-01T10:00:00.000Z",
        "1970-01-01T10:20:00.000Z",
      ),
    ).toBe(20);
  });

  it("calculates exact minutes for plain HH:mm strings", () => {
    expect(calculateAppointmentDurationMinutes("10:00", "10:20")).toBe(20);
  });

  it("calculates exact minutes across hour boundary (10:50–11:10)", () => {
    expect(calculateAppointmentDurationMinutes("10:50", "11:10")).toBe(20);
    expect(
      calculateAppointmentDurationMinutes(
        "1970-01-01T10:50:00.000Z",
        "1970-01-01T11:10:00.000Z",
      ),
    ).toBe(20);
  });

  it("calculates exact minutes across noon boundary (11:50–12:10)", () => {
    expect(calculateAppointmentDurationMinutes("11:50", "12:10")).toBe(20);
    expect(
      calculateAppointmentDurationMinutes(
        "1970-01-01T11:50:00.000Z",
        "1970-01-01T12:10:00.000Z",
      ),
    ).toBe(20);
  });

  it("handles clock times with zero seconds", () => {
    expect(calculateAppointmentDurationMinutes("10:00:00", "10:20:00")).toBe(
      20,
    );
  });

  it("handles matched non-zero seconds (exact whole minutes)", () => {
    expect(calculateAppointmentDurationMinutes("10:00:30", "10:20:30")).toBe(
      20,
    );
  });

  it("returns null for non-integer minute intervals (no rounding)", () => {
    expect(
      calculateAppointmentDurationMinutes("10:00:15", "10:20:00"),
    ).toBeNull();
  });

  it("returns null for fractional seconds (does not round sub-seconds)", () => {
    expect(
      calculateAppointmentDurationMinutes(
        "1970-01-01T10:00:00.500Z",
        "1970-01-01T10:20:00.000Z",
      ),
    ).toBeNull();
  });

  it("returns null when start equals end (zero duration)", () => {
    expect(calculateAppointmentDurationMinutes("10:00", "10:00")).toBeNull();
  });

  it("returns null when end is before start (reversed interval)", () => {
    expect(calculateAppointmentDurationMinutes("10:20", "10:00")).toBeNull();
  });

  it("returns null for overnight intervals (no invented 24h duration)", () => {
    expect(calculateAppointmentDurationMinutes("23:00", "01:00")).toBeNull();
    expect(calculateAppointmentDurationMinutes("22:30", "00:30")).toBeNull();
  });

  it("returns null for missing, empty, or malformed time inputs", () => {
    expect(calculateAppointmentDurationMinutes(null, "10:20")).toBeNull();
    expect(calculateAppointmentDurationMinutes("10:00", undefined)).toBeNull();
    expect(calculateAppointmentDurationMinutes("", "10:20")).toBeNull();
    expect(calculateAppointmentDurationMinutes("10:00", "")).toBeNull();
    expect(calculateAppointmentDurationMinutes("invalid", "10:20")).toBeNull();
    expect(calculateAppointmentDurationMinutes("25:00", "10:20")).toBeNull();
    expect(calculateAppointmentDurationMinutes("10:65", "11:00")).toBeNull();
  });
});

describe("formatAppointmentDurationHint formatter", () => {
  it("formats valid duration with Arabic label", () => {
    expect(formatAppointmentDurationHint("10:00", "10:20")).toBe(
      "مدة الموعد: 20 دقيقة",
    );
  });

  it("returns honest unavailable label for invalid or unsupported interval", () => {
    expect(formatAppointmentDurationHint("10:00", "10:00")).toBe(
      APPOINTMENT_DURATION_UNAVAILABLE_LABEL,
    );
    expect(formatAppointmentDurationHint("10:20", "10:00")).toBe(
      APPOINTMENT_DURATION_UNAVAILABLE_LABEL,
    );
    expect(formatAppointmentDurationHint("23:00", "01:00")).toBe(
      APPOINTMENT_DURATION_UNAVAILABLE_LABEL,
    );
    expect(formatAppointmentDurationHint("invalid", "10:20")).toBe(
      APPOINTMENT_DURATION_UNAVAILABLE_LABEL,
    );
  });
});

describe("AppointmentDetail rendered component tests (ISS-008 / BK-50)", () => {
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
    container.remove();
  });

  function renderDetail(data: AppointmentDetailData) {
    act(() => {
      if (!root) {
        root = createRoot(container);
      }
      root.render(
        <AppointmentDetail
          initialData={data}
          today="2026-11-04"
          timezone="Africa/Cairo"
        />,
      );
    });
  }

  function getBookedServiceSection(): {
    dtText: string | null;
    valueText: string | null;
    hintText: string | null;
  } {
    const dts = Array.from(container.querySelectorAll("dt"));
    const bookedDt = dts.find(
      (dt) => dt.textContent?.trim() === "الخدمة المحجوزة",
    );
    if (!bookedDt) {
      throw new Error("Could not find 'الخدمة المحجوزة' dl entry");
    }
    const parent = bookedDt.parentElement;
    const dd = parent?.querySelector("dd");
    const hint = parent?.querySelector("p");
    return {
      dtText: bookedDt.textContent?.trim() ?? null,
      valueText: dd?.textContent?.trim() ?? null,
      hintText: hint?.textContent?.trim() ?? null,
    };
  }

  it("A. Stored 10:00–10:20 with catalog duration 25 renders truthful label", () => {
    renderDetail(BASE_FIXTURE);

    const section = getBookedServiceSection();
    expect(section.valueText).toBe("جلسة تنظيف وتلميع أسنان");
    expect(section.hintText).toBe("مدة الموعد: 20 دقيقة");

    // Must NOT contain the old misleading label anywhere in the document
    expect(container.textContent).not.toContain("25 دقيقة (الأصلية)");
    expect(container.textContent).not.toContain("(الأصلية)");
  });

  it("B. Stored 10:50–11:10 renders 'مدة الموعد: 20 دقيقة' across hour boundary", () => {
    const data: AppointmentDetailData = {
      ...BASE_FIXTURE,
      startTime: "1970-01-01T10:50:00.000Z",
      endTime: "1970-01-01T11:10:00.000Z",
    };
    renderDetail(data);

    const section = getBookedServiceSection();
    expect(section.hintText).toBe("مدة الموعد: 20 دقيقة");
  });

  it("C. Stored 11:50–12:10 renders 'مدة الموعد: 20 دقيقة' across noon", () => {
    const data: AppointmentDetailData = {
      ...BASE_FIXTURE,
      startTime: "1970-01-01T11:50:00.000Z",
      endTime: "1970-01-01T12:10:00.000Z",
    };
    renderDetail(data);

    const section = getBookedServiceSection();
    expect(section.hintText).toBe("مدة الموعد: 20 دقيقة");
  });

  it("D. Changing only catalog duration does NOT alter displayed duration", () => {
    const dataWithChangedCatalog: AppointmentDetailData = {
      ...BASE_FIXTURE,
      service: {
        ...BASE_FIXTURE.service,
        durationMinutes: 90, // Catalog changed to 90 min
      },
    };
    renderDetail(dataWithChangedCatalog);

    const section = getBookedServiceSection();
    // Duration is derived from stored 10:00–10:20 (20m);
    // unaffected by catalog duration
    expect(section.hintText).toBe("مدة الموعد: 20 دقيقة");
    expect(container.textContent).not.toContain("90 دقيقة");
  });

  it("E. Changing stored appointment interval updates displayed duration", () => {
    const dataWith45MinInterval: AppointmentDetailData = {
      ...BASE_FIXTURE,
      startTime: "1970-01-01T10:00:00.000Z",
      endTime: "1970-01-01T10:45:00.000Z",
    };
    renderDetail(dataWith45MinInterval);

    const section = getBookedServiceSection();
    expect(section.hintText).toBe("مدة الموعد: 45 دقيقة");
  });

  it("F. Missing, malformed, equal, reversed, overnight render unavailable", () => {
    // 1. Equal times (10:00 to 10:00)
    renderDetail({
      ...BASE_FIXTURE,
      startTime: "1970-01-01T10:00:00.000Z",
      endTime: "1970-01-01T10:00:00.000Z",
    });
    expect(getBookedServiceSection().hintText).toBe("مدة الموعد غير متاحة");
    expect(getBookedServiceSection().hintText).not.toContain("NaN");
    expect(getBookedServiceSection().hintText).not.toContain("-");

    // 2. Reversed times (10:20 to 10:00)
    renderDetail({
      ...BASE_FIXTURE,
      startTime: "1970-01-01T10:20:00.000Z",
      endTime: "1970-01-01T10:00:00.000Z",
    });
    expect(getBookedServiceSection().hintText).toBe("مدة الموعد غير متاحة");
    expect(getBookedServiceSection().hintText).not.toContain("NaN");
    expect(getBookedServiceSection().hintText).not.toContain("-");

    // 3. Overnight attempt (23:00 to 01:00)
    renderDetail({
      ...BASE_FIXTURE,
      startTime: "1970-01-01T23:00:00.000Z",
      endTime: "1970-01-01T01:00:00.000Z",
    });
    expect(getBookedServiceSection().hintText).toBe("مدة الموعد غير متاحة");
    expect(container.textContent).not.toContain("120 دقيقة");

    // 4. Missing/malformed time
    renderDetail({
      ...BASE_FIXTURE,
      startTime: "invalid",
      endTime: "10:20",
    });
    expect(getBookedServiceSection().hintText).toBe("مدة الموعد غير متاحة");
    expect(container.textContent).not.toContain("NaN");
  });

  it("G. Booked-service name and performed-service details remain intact", () => {
    const completedWithPerformedService: AppointmentDetailData = {
      ...BASE_FIXTURE,
      status: "COMPLETED",
      service: {
        id: "srv-1",
        name: "جلسة تنظيف وتلميع أسنان",
        durationMinutes: 25,
      },
      performedService: {
        id: "srv-2",
        name: "علاج عصب وقناة الجذر",
        durationMinutes: 45,
      },
      serviceCorrectedAt: "2026-11-04T12:00:00.000Z",
    };
    renderDetail(completedWithPerformedService);

    // Booked service remains truthful
    const bookedSection = getBookedServiceSection();
    expect(bookedSection.valueText).toBe("جلسة تنظيف وتلميع أسنان");
    expect(bookedSection.hintText).toBe("مدة الموعد: 20 دقيقة");

    // Performed service remains intact
    const dts = Array.from(container.querySelectorAll("dt"));
    const performedDt = dts.find(
      (dt) => dt.textContent?.trim() === "الخدمة المنفذة",
    );
    expect(performedDt).toBeTruthy();
    const performedParent = performedDt?.parentElement;
    expect(performedParent?.querySelector("dd")?.textContent?.trim()).toBe(
      "علاج عصب وقناة الجذر",
    );
  });
});
