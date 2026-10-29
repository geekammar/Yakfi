/**
 * FlowPilot — Staff Workspace Calendar-Date Consistency Unit & Render Tests
 *
 * Verifies that:
 * 1. formatAppointmentDate parses appointment dates using explicit UTC and preserves
 *    intended calendar dates (2026-11-07 and 2026-11-08) without backward day shift.
 * 2. formatAppointmentDate matches formatArabicDayMonth from date-format.ts.
 * 3. Rendered StaffWorkspace displays the correct appointment calendar date in both
 *    the NEED_HUMAN queue section and the assigned-to-me section.
 */

import { formatArabicDayMonth } from "@/features/appointments/components/smart-create/date-format";
import {
  StaffWorkspace,
  formatAppointmentDate,
} from "@/features/staff/components/staff-workspace";
import type {
  StaffAssignedItem,
  StaffQueueItem,
} from "@/features/staff/types";

import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/staff",
}));

const mockQueueNov7: StaffQueueItem = {
  id: "queue-nov-7",
  assignment: "unassigned",
  assignedUserName: null,
  customer: {
    id: "cust-1",
    name: "سارة عبد الله",
    phone: "+201012345678",
  },
  lastMessage: {
    content: "أريد تأكيد موعدي",
    senderType: "CUSTOMER",
    createdAt: "2026-10-29T10:00:00.000Z",
  },
  lastActivityAt: "2026-10-29T10:00:00.000Z",
  latestAppointment: {
    id: "apt-nov-7",
    serviceName: "تنظيف أسنان",
    date: "2026-11-07",
    startTime: "2026-11-07T10:00:00.000Z",
    status: "CONFIRMED",
  },
  hasAttention: false,
  attentionReason: null,
  attentionCause: null,
  attentionCreatedAt: null,
};

const mockQueueNov8: StaffQueueItem = {
  id: "queue-nov-8",
  assignment: "unassigned",
  assignedUserName: null,
  customer: {
    id: "cust-2",
    name: "عمر خالد",
    phone: "+201087654321",
  },
  lastMessage: {
    content: "استفسار عن موعد يوم الأحد",
    senderType: "CUSTOMER",
    createdAt: "2026-10-29T11:00:00.000Z",
  },
  lastActivityAt: "2026-10-29T11:00:00.000Z",
  latestAppointment: {
    id: "apt-nov-8",
    serviceName: "كشف أطفال",
    date: "2026-11-08",
    startTime: "2026-11-08T11:00:00.000Z",
    status: "CONFIRMED",
  },
  hasAttention: false,
  attentionReason: null,
  attentionCause: null,
  attentionCreatedAt: null,
};

const mockAssignedNov7: StaffAssignedItem = {
  id: "assigned-nov-7",
  status: "NEED_HUMAN",
  customer: {
    id: "cust-3",
    name: "مريم أحمد",
    phone: "+201055554444",
  },
  lastMessage: {
    content: "أنا بانتظار ردكم",
    senderType: "CUSTOMER",
    createdAt: "2026-10-29T12:00:00.000Z",
  },
  lastActivityAt: "2026-10-29T12:00:00.000Z",
  latestAppointment: {
    id: "apt-assigned-7",
    serviceName: "تقويم أسنان",
    date: "2026-11-07",
    startTime: "2026-11-07T15:00:00.000Z",
    status: "CONFIRMED",
  },
};

describe("Staff Workspace calendar-date consistency", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
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

  describe("formatAppointmentDate production helper", () => {
    it("formats 2026-11-07 as 7 November and never 6 November", () => {
      const formatted = formatAppointmentDate("2026-11-07");
      expect(formatted).toContain("نوفمبر");
      expect(formatted).toMatch(/[7٧]/);
      expect(formatted).not.toMatch(/[6٦]/);
    });

    it("formats 2026-11-08 as 8 November and never 7 November", () => {
      const formatted = formatAppointmentDate("2026-11-08");
      expect(formatted).toContain("نوفمبر");
      expect(formatted).toMatch(/[8٨]/);
      expect(formatted).not.toMatch(/[7٧]/);
    });

    it("matches formatArabicDayMonth parity on calendar dates", () => {
      const dates = ["2026-11-07", "2026-11-08", "2026-10-31", "2026-12-01"];
      for (const d of dates) {
        expect(formatAppointmentDate(d)).toBe(formatArabicDayMonth(d));
      }
    });

    it("handles ISO strings safely by slicing calendar date prefix", () => {
      const fromIso = formatAppointmentDate("2026-11-07T14:30:00.000Z");
      expect(fromIso).toContain("نوفمبر");
      expect(fromIso).toMatch(/[7٧]/);
      expect(fromIso).toBe(formatAppointmentDate("2026-11-07"));
    });
  });

  describe("Rendered StaffWorkspace component", () => {
    it("renders consistent 7 November for appointment in queue row", async () => {
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <StaffWorkspace
            queue={[mockQueueNov7]}
            assigned={[]}
            takeOver={vi.fn().mockResolvedValue({ success: true })}
          />,
        );
      });

      expect(container.textContent).toContain("تنظيف أسنان");
      expect(container.textContent).toContain("نوفمبر");
      expect(container.textContent).toMatch(/[7٧]/);
      // Ensure backward day shift to 6 November does not occur
      expect(container.textContent).not.toContain("٦ نوفمبر");
      expect(container.textContent).not.toContain("6 نوفمبر");
    });

    it("renders consistent 8 November for appointment in queue row without drift", async () => {
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <StaffWorkspace
            queue={[mockQueueNov8]}
            assigned={[]}
            takeOver={vi.fn().mockResolvedValue({ success: true })}
          />,
        );
      });

      expect(container.textContent).toContain("كشف أطفال");
      expect(container.textContent).toContain("نوفمبر");
      expect(container.textContent).toMatch(/[8٨]/);
      // Ensure day 7 does not appear for day 8 appointment
      expect(container.textContent).not.toContain("٧ نوفمبر");
      expect(container.textContent).not.toContain("7 نوفمبر");
    });

    it("renders consistent 7 November for appointment in assigned section", async () => {
      root = createRoot(container);
      await act(async () => {
        root?.render(
          <StaffWorkspace
            queue={[]}
            assigned={[mockAssignedNov7]}
            takeOver={vi.fn().mockResolvedValue({ success: true })}
          />,
        );
      });

      expect(container.textContent).toContain("تقويم أسنان");
      expect(container.textContent).toContain("نوفمبر");
      expect(container.textContent).toMatch(/[7٧]/);
      expect(container.textContent).not.toContain("٦ نوفمبر");
      expect(container.textContent).not.toContain("6 نوفمبر");
    });
  });
});
