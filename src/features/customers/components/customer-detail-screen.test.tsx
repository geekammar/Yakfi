/**
 * Customer Detail Screen Accessible Status Labels Regression Test (ISS-001)
 *
 * Verifies that:
 * 1. Appointment status badges render Arabic accessible labels (aria-label)
 *    consistent with their visible badge labels.
 * 2. Conversation status badges render Arabic accessible labels (aria-label)
 *    consistent with their visible badge labels.
 * 3. Covers all canonical appointment statuses used by this screen:
 *    PENDING, CONFIRMED, CANCELLED, NO_SHOW, COMPLETED.
 * 4. Covers all canonical conversation statuses used by this screen:
 *    AI_ACTIVE, NEED_HUMAN, BOOKED, INCOMPLETE.
 * 5. Ensures canonical status presentation definitions (resolveStatus from @/lib/status)
 *    govern accessible labels without duplicate translation tables.
 * 6. Guarantees raw canonical English status tokens never leak into accessible labels.
 */

import { CustomerDetailScreen } from "@/features/customers/components/customer-detail-screen";
import type {
  CustomerDetailData,
  CustomerHistoryAppointment,
  CustomerHistoryConversation,
} from "@/features/customers/types";
import { resolveStatus } from "@/lib/status";
import type { AppointmentStatus, ConversationStatus } from "@/types/domain";

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ALL_APPOINTMENT_STATUSES: AppointmentStatus[] = [
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "NO_SHOW",
  "COMPLETED",
];

const ALL_CONVERSATION_STATUSES: ConversationStatus[] = [
  "AI_ACTIVE",
  "NEED_HUMAN",
  "BOOKED",
  "INCOMPLETE",
];

const CANONICAL_APPOINTMENT_VALUES: Record<AppointmentStatus, string> = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  CANCELLED: "cancelled",
  NO_SHOW: "no-show",
  COMPLETED: "completed",
};

const CANONICAL_CONVERSATION_VALUES: Record<ConversationStatus, string> = {
  AI_ACTIVE: "ai-active",
  NEED_HUMAN: "need-human",
  BOOKED: "booked",
  INCOMPLETE: "incomplete",
};

function createFixtureCustomer(
  appointments: CustomerHistoryAppointment[] = [],
  conversations: CustomerHistoryConversation[] = [],
): CustomerDetailData {
  return {
    id: "cust-regression-001",
    name: "فاطمة الزهراء",
    phone: "+201011223344",
    email: "fatima@example.com",
    notes: "عميلة تفضل مواعيد الفترة الصباحية",
    createdAt: "2026-10-01T09:00:00.000Z",
    lastConversationAt: "2026-10-29T11:00:00.000Z",
    lastAppointmentAt: "2026-10-29T10:00:00.000Z",
    appointments,
    conversations,
  };
}

describe("CustomerDetailScreen accessible status labels (ISS-001)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders Arabic accessible labels consistent with visible badges for all appointment statuses", () => {
    const appointments: CustomerHistoryAppointment[] =
      ALL_APPOINTMENT_STATUSES.map((status, index) => ({
        id: `apt-${index}`,
        date: "2026-10-30",
        startTime: `2026-10-30T${String(10 + index).padStart(2, "0")}:00:00.000Z`,
        endTime: `2026-10-30T${String(11 + index).padStart(2, "0")}:00:00.000Z`,
        status,
        service: {
          id: `srv-${index}`,
          name: `خدمة تجريبية ${index + 1}`,
          durationMinutes: 60,
        },
      }));

    const customer = createFixtureCustomer(appointments, []);

    act(() => {
      root.render(<CustomerDetailScreen customer={customer} />);
    });

    const appointmentLinks = container.querySelectorAll(
      'li a[href^="/appointments/apt-"]',
    );
    expect(appointmentLinks).toHaveLength(ALL_APPOINTMENT_STATUSES.length);

    ALL_APPOINTMENT_STATUSES.forEach((status, index) => {
      const link = appointmentLinks[index];
      expect(link).toBeDefined();
      const badge = link?.querySelector("[aria-label]");
      expect(badge).not.toBeNull();

      const canonicalValue = CANONICAL_APPOINTMENT_VALUES[status];
      const statusDef = resolveStatus(canonicalValue);

      const expectedAriaLabel = `حالة الموعد: ${statusDef.labelAr}`;
      expect(badge?.getAttribute("aria-label")).toBe(expectedAriaLabel);

      // Verify visible text matches the canonical Arabic label
      expect(badge?.textContent).toContain(statusDef.labelAr);

      // Verify raw canonical English status value is NOT present in aria-label
      expect(badge?.getAttribute("aria-label")).not.toBe(
        `حالة الموعد: ${canonicalValue}`,
      );
      expect(badge?.getAttribute("aria-label")).not.toBe(
        `حالة الموعد: ${status}`,
      );
    });
  });

  it("renders Arabic accessible labels consistent with visible badges for all conversation statuses", () => {
    const conversations: CustomerHistoryConversation[] =
      ALL_CONVERSATION_STATUSES.map((status, index) => ({
        id: `conv-${index}`,
        status,
        lastActivityAt: `2026-10-30T${String(12 + index).padStart(2, "0")}:00:00.000Z`,
      }));

    const customer = createFixtureCustomer([], conversations);

    act(() => {
      root.render(<CustomerDetailScreen customer={customer} />);
    });

    const conversationLinks = container.querySelectorAll(
      'li a[href^="/conversations/conv-"]',
    );
    expect(conversationLinks).toHaveLength(ALL_CONVERSATION_STATUSES.length);

    ALL_CONVERSATION_STATUSES.forEach((status, index) => {
      const link = conversationLinks[index];
      expect(link).toBeDefined();
      const badge = link?.querySelector("[aria-label]");
      expect(badge).not.toBeNull();

      const canonicalValue = CANONICAL_CONVERSATION_VALUES[status];
      const statusDef = resolveStatus(canonicalValue);

      const expectedAriaLabel = `حالة المحادثة: ${statusDef.labelAr}`;
      expect(badge?.getAttribute("aria-label")).toBe(expectedAriaLabel);

      // Verify visible text matches the canonical Arabic label
      expect(badge?.textContent).toContain(statusDef.labelAr);

      // Verify raw canonical English status value is NOT present in aria-label
      expect(badge?.getAttribute("aria-label")).not.toBe(
        `حالة المحادثة: ${canonicalValue}`,
      );
      expect(badge?.getAttribute("aria-label")).not.toBe(
        `حالة المحادثة: ${status}`,
      );
    });
  });

  it("verifies exact canonical Arabic status wording for all customer-history badge values", () => {
    // Exact mapping verification according to canonical definitions in src/lib/status.ts
    expect(resolveStatus("pending").labelAr).toBe("قيد الانتظار");
    expect(resolveStatus("confirmed").labelAr).toBe("مؤكد");
    expect(resolveStatus("cancelled").labelAr).toBe("ملغي");
    expect(resolveStatus("no-show").labelAr).toBe("لم يحضر");
    expect(resolveStatus("completed").labelAr).toBe("مكتمل");

    expect(resolveStatus("ai-active").labelAr).toBe("المساعد الذكي نشط");
    expect(resolveStatus("need-human").labelAr).toBe("يحتاج تدخلاً بشرياً");
    expect(resolveStatus("booked").labelAr).toBe("محجوز");
    expect(resolveStatus("incomplete").labelAr).toBe("غير مكتملة");
  });

  it("renders both appointment and conversation badges simultaneously with consistent Arabic accessible labels", () => {
    const customer = createFixtureCustomer(
      [
        {
          id: "apt-pending",
          date: "2026-11-01",
          startTime: "2026-11-01T09:00:00.000Z",
          endTime: "2026-11-01T10:00:00.000Z",
          status: "PENDING",
          service: { id: "srv-1", name: "استشارة عامة", durationMinutes: 60 },
        },
      ],
      [
        {
          id: "conv-need-human",
          status: "NEED_HUMAN",
          lastActivityAt: "2026-10-30T14:00:00.000Z",
        },
      ],
    );

    act(() => {
      root.render(<CustomerDetailScreen customer={customer} />);
    });

    const aptBadge = container.querySelector(
      'li a[href="/appointments/apt-pending"] [aria-label]',
    );
    expect(aptBadge?.getAttribute("aria-label")).toBe(
      "حالة الموعد: قيد الانتظار",
    );
    expect(aptBadge?.textContent).toContain("قيد الانتظار");

    const convBadge = container.querySelector(
      'li a[href="/conversations/conv-need-human"] [aria-label]',
    );
    expect(convBadge?.getAttribute("aria-label")).toBe(
      "حالة المحادثة: يحتاج تدخلاً بشرياً",
    );
    expect(convBadge?.textContent).toContain("يحتاج تدخلاً بشرياً");
  });

  it("handles empty customer history without rendering orphaned status badges", () => {
    const customer = createFixtureCustomer([], []);

    act(() => {
      root.render(<CustomerDetailScreen customer={customer} />);
    });

    expect(container.textContent).toContain("لا توجد مواعيد لهذا العميل بعد.");
    expect(container.textContent).toContain(
      "لا توجد محادثات مع هذا العميل — تبدأ المحادثات تلقائياً عند تواصل العميل.",
    );

    const historyBadges = container.querySelectorAll("li [aria-label]");
    expect(historyBadges).toHaveLength(0);
  });
});
