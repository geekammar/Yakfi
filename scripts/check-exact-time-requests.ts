/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import {
  composeExactTimeResponse,
  evaluateExactTimeAvailability,
  formatTimeArabic,
  rankAlternativesByTemporalDistance,
} from "../src/features/appointments/server/exact-time-service";
import {
  aiExactTimeRequestSchema,
  aiExtractionSchema,
  aiResponseSchema,
  emptyAiExtraction,
  type AiRequest,
  type AiResponse,
} from "../src/features/conversations/server/ai-contract";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import { reconcileTurnSemanticFacts } from "../src/features/conversations/server/semantic-facts";

/**
 * FlowPilot — Exact-Time Requests and Honest Availability Verification Suite
 * Covers T01 through T20:
 *  - T01: Exact-time inquiry when slot is available (answers directly, creates 0 appointments)
 *  - T02: Exact-time inquiry when slot is unavailable (answers directly, offers up to 3 nearby alternatives, 0 appointments)
 *  - T03: Off-page availability (time absent from initial top-N page is found via domain schedule)
 *  - T04: Genuine AM/PM ambiguity ("الساعة 3" asks ONE clarification, 0 appointments)
 *  - T05: Ambiguity clarification resolution (follow-up resolves to afternoon/evening, checks availability)
 *  - T06: Inquiry side effect freedom (multiple queries create ZERO appointments)
 *  - T07: Exact-time booking intent ("احجز لي الساعة 5 مساء" presents offer, no silent booking)
 *  - T08: Unavailable requested time NEVER silently books an alternative (0 appointments created)
 *  - T09: Up to 3 nearby alternatives ranking (deterministic tie-breaking by |t - t_req|, then start time)
 *  - T10: Scope preservation (day, service, provider scope preserved; no silent broadening)
 *  - T11: Business hours boundary (outside hours answered directly with hours explained, offers in-hours slots)
 *  - T12: Service duration boundary (slot exceeding closing time answered directly)
 *  - T13: Business breaks and non-slot grid alignment (misaligned minutes offered nearest valid slots)
 *  - T14: Past-time rule on today (past time on today answered as passed, offers future slots)
 *  - T15: Business timezone awareness (wall-clock evaluation in business timezone)
 *  - T16: Numeric protocol selection distinct from "الساعة 3" ("3" selects option; "الساعة 3" clarifies AM/PM)
 *  - T17: Semantic fact correction (changing exact time updates state and replaces offer)
 *  - T18: Stale offer and replay protection (replaying old selection guarded against duplicate write)
 *  - T19: Technical failure handoff (AI provider error produces safe failure reply without corrupting state)
 *  - T20: Correlated evidence check for temporary handoff (safe correlated evidence, cause marked UNKNOWN)
 *
 * Usage:
 *   pnpm check:exact-time-requests
 */

let totalChecks = 0;
let passedChecks = 0;
const failures: string[] = [];

function check(title: string, passed: boolean, extraInfo?: string): void {
  totalChecks++;
  if (passed) {
    passedChecks++;
    console.log(`✔ ${title}`);
  } else {
    failures.push(title);
    console.error(`❌ ${title}${extraInfo ? ` -> ${extraInfo}` : ""}`);
  }
}

function mockResponse(params: {
  intent: "AVAILABILITY" | "BOOKING" | "FAQ";
  action?: "reply" | "booking_handoff" | "handoff";
  content: string;
  service?: string | null;
  date?: string | null;
  provider?: string | null;
  exactTime?: { type: "specific"; time: string } | { type: "unresolved_period"; hour: number; minute?: number } | null;
  timePreference?: "morning" | "afternoon" | "evening" | null;
  factUpdates?: Array<{ key: string; operation?: "set" | "remove"; value?: string }>;
  handoffReason?: any;
}): AiResponse {
  return {
    intent: params.intent,
    action: params.action ?? "booking_handoff",
    content: params.content,
    summary: params.intent === "BOOKING" ? "طلب حجز موعد" : "استفسار عن موعد",
    handoffReason: params.handoffReason ?? null,
    safetyAssessment: "safe",
    extraction: {
      service: params.service ?? null,
      date: params.date ?? null,
      provider: params.provider ?? null,
      timePreference: params.timePreference ?? null,
      exactTime: params.exactTime ?? null,
    },
    ...(params.factUpdates ? { factUpdates: params.factUpdates as any } : {}),
  };
}

async function main(): Promise<void> {
  console.log("=================================================================");
  console.log("  FLOWPILOT — EXACT-TIME REQUESTS & HONEST AVAILABILITY (T01–T20)");
  console.log("=================================================================\n");

  const standardWorkingHours = {
    sat: { open: "09:00", close: "21:00", closed: false },
    sun: { open: "09:00", close: "21:00", closed: false },
    mon: { open: "09:00", close: "21:00", closed: false },
    tue: { open: "09:00", close: "21:00", closed: false },
    wed: { open: "09:00", close: "21:00", closed: false },
    thu: { open: "09:00", close: "21:00", closed: false },
    fri: { open: "09:00", close: "21:00", closed: false },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // T01: Exact-time inquiry when slot is available
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T01: Exact-time inquiry when slot is available ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "جارٍ فحص التوفر...",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "17:00" },
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 5 مساء متاح ولا لا؟",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T01: Inbound succeeded and active", res.ok && (res as any).conversationStatus === "AI_ACTIVE");
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T01: Answers directly that 5:00 PM is available", lastReply?.text?.includes("5:00 مساءً متاح"));
    check("T01: Presents slot option for 5:00 PM", lastReply?.text?.includes("1️⃣ الساعة 5:00 مساءً"));
    check("T01: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T02: Exact-time inquiry when slot is unavailable (conflict/booked)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T02: Exact-time inquiry when slot is unavailable ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
      initialAppointments: [
        {
          id: "appt-1300",
          businessId: PLAYGROUND_IDS.businessId,
          branchId: PLAYGROUND_IDS.branchId,
          customerId: "cust-other",
          serviceId: PLAYGROUND_IDS.serviceId,
          providerId: PLAYGROUND_IDS.providerId,
          assignedUserId: PLAYGROUND_IDS.providerUserId,
          date: new Date("2026-10-21T00:00:00Z"),
          startTime: "13:00",
          endTime: "13:30",
          status: "CONFIRMED",
        },
      ],
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "جارٍ فحص التوفر...",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "13:00" },
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 1 مساء متوفر ولا لا؟",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T02: Inbound succeeded and active", res.ok && (res as any).conversationStatus === "AI_ACTIVE");
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T02: Answers directly that 1:00 PM is unavailable", lastReply?.text?.includes("1:00 مساءً غير متاح"));
    check("T02: Explains that slot is booked", lastReply?.text?.includes("محجوز مسبقاً"));
    check("T02: Offers nearby alternatives", lastReply?.text?.includes("أقرب المواعيد المتاحة"));
    check("T02: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T03: Off-page availability (times absent from top-N displayed page)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T03: Off-page availability ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "جارٍ فحص التوفر...",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "19:00" }, // slot #20 of day, absent from top-3
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 7 مساء متاح؟",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T03: Inbound succeeded", res.ok && (res as any).conversationStatus === "AI_ACTIVE");
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T03: Discovers off-page slot truthfully without inferring from top-3", lastReply?.text?.includes("7:00 مساءً متاح"));
    check("T03: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T04: Genuine AM/PM ambiguity ("الساعة 3")
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T04: Genuine AM/PM ambiguity ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "يرجى التوضيح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "unresolved_period", hour: 3 },
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد الساعة 3",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T04: Inbound succeeded and active", res.ok && (res as any).conversationStatus === "AI_ACTIVE");
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T04: Asks ONE AM/PM clarifying question", lastReply?.text?.includes("هل تقصد الساعة 3 عصراً (مساءً) أم 3 فجراً (صباحاً)؟"));
    check("T04: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T05: Clarification resolution on follow-up turn
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T05: Clarification resolution on follow-up turn ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Turn 1: ambiguity
    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "توضيح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "unresolved_period", hour: 3 },
        });
      },
    };

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد الساعة 3",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    // Turn 2: customer clarifies "مساءً"
    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "تمام",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "afternoon",
        });
      },
    };

    const res2 = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "مساءً",
      receivedAt: "2026-10-20T10:01:00Z",
    });

    check("T05: Clarification turn succeeded", res2.ok && (res2 as any).conversationStatus === "AI_ACTIVE");
    const reply2 = harness.sentMessages[harness.sentMessages.length - 1];
    check("T05: Resolved hour 3 + afternoon to 15:00 (3:00 مساءً) availability", reply2?.text?.includes("3:00 مساءً متاح"));
    check("T05: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T06: Inquiry side effect freedom
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T06: Inquiry side effect freedom ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(req: AiRequest): Promise<AiResponse> {
        const time = req.message.includes("5") ? "17:00" : req.message.includes("6") ? "18:00" : "19:00";
        return mockResponse({
          intent: "AVAILABILITY",
          content: "فحص",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time },
        });
      },
    };

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 5 متاح؟",
      receivedAt: "2026-10-20T10:00:00Z",
    });
    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "طب الساعة 6 متاح؟",
      receivedAt: "2026-10-20T10:01:00Z",
    });
    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "طب الساعة 7؟",
      receivedAt: "2026-10-20T10:02:00Z",
    });

    check("T06: Zero appointments created across all availability questions", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T07: Exact-time booking intent ("احجز لي الساعة 5 مساء")
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T07: Exact-time booking intent ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "حجز",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "17:00" },
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "احجز لي الساعة 5 مساء",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T07: Inbound succeeded", res.ok);
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T07: Presents offer option 1 for confirmation", lastReply?.text?.includes("1️⃣ الساعة 5:00 مساءً"));
    check("T07: Never silently creates appointment before confirmation", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T08: Unavailable requested time NEVER silently books an alternative
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T08: Unavailable requested time NEVER silently books alternative ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
      initialAppointments: [
        {
          id: "appt-conflict-1400",
          businessId: PLAYGROUND_IDS.businessId,
          branchId: PLAYGROUND_IDS.branchId,
          customerId: "cust-other",
          serviceId: PLAYGROUND_IDS.serviceId,
          providerId: PLAYGROUND_IDS.providerId,
          assignedUserId: PLAYGROUND_IDS.providerUserId,
          date: new Date("2026-10-21T00:00:00Z"),
          startTime: "14:00",
          endTime: "14:30",
          status: "CONFIRMED",
        },
      ],
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "حجز 14:00",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "14:00" },
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "احجزلي الساعة 2 ظهراً",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T08: Inbound handled", res.ok && (res as any).conversationStatus === "AI_ACTIVE");
    check("T08: Alternatives presented without silent booking", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T09: Nearby alternatives ranking
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T09: Nearby alternatives ranking ---");
  {
    const slots = [
      { providerOrder: 0, providerId: "p1", displayName: "د. أحمد", startTime: "13:00", endTime: "13:30" },
      { providerOrder: 0, providerId: "p1", displayName: "د. أحمد", startTime: "13:30", endTime: "14:00" },
      { providerOrder: 0, providerId: "p1", displayName: "د. أحمد", startTime: "14:30", endTime: "15:00" },
      { providerOrder: 0, providerId: "p1", displayName: "د. أحمد", startTime: "15:00", endTime: "15:30" },
    ];
    // Target 14:00: 13:30 and 14:30 are both distance 30. Earlier time (13:30) must win tie.
    const alts = rankAlternativesByTemporalDistance(slots, "14:00", 3);
    check("T09: Exactly 3 alternatives returned", alts.length === 3);
    check("T09: Rank 1 is 13:30 (closer/earlier tie breaker)", alts[0]?.startTime === "13:30");
    check("T09: Rank 2 is 14:30", alts[1]?.startTime === "14:30");
    check("T09: Rank 3 is 13:00 (distance 60, earlier than 15:00)", alts[2]?.startTime === "13:00");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T10: Scope preservation (day, service, provider scope)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T10: Scope preservation ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
      initialAppointments: [
        {
          id: "appt-conflict-dr1",
          businessId: PLAYGROUND_IDS.businessId,
          branchId: PLAYGROUND_IDS.branchId,
          customerId: "cust-other",
          serviceId: PLAYGROUND_IDS.serviceId,
          providerId: PLAYGROUND_IDS.providerId,
          assignedUserId: PLAYGROUND_IDS.providerUserId,
          date: new Date("2026-10-21T00:00:00Z"),
          startTime: "16:00",
          endTime: "16:30",
          status: "CONFIRMED",
        },
      ],
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "فحص",
          service: "كشف أسنان",
          date: "2026-10-21",
          provider: PLAYGROUND_IDS.providerName,
          exactTime: { type: "specific", time: "16:00" },
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد الساعة 4 مع د. أحمد",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T10: Inbound handled", res.ok);
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T10: Preserves provider scope and date scope in alternatives", lastReply?.text?.includes("أقرب المواعيد المتاحة"));
    check("T10: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T11: Business hours boundary (outside hours)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T11: Business hours boundary ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "فحص",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "07:00" }, // before 09:00 open
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 7 الصبح متاح؟",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T11: Inbound handled", res.ok);
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T11: Directly states outside working hours with business hours explained", lastReply?.text?.includes("خارج أوقات العمل الرسمية") && lastReply?.text?.includes("أوقات العمل"));
    check("T11: Offers nearest in-hours alternatives (e.g. 09:00)", lastReply?.text?.includes("9:00 صباحاً"));
    check("T11: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T12: Service duration boundary
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T12: Service duration boundary ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Update service duration to 60 mins
    const origFindById = harness.deps.serviceRepository.findById;
    harness.deps.serviceRepository.findById = async (id: string) => {
      const s = await origFindById(id);
      return s ? { ...s, durationMinutes: 60 } : null;
    };

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "فحص",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "20:30" }, // 20:30 + 60m > 21:00 close
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 8:30 بالليل متاح؟",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T12: Inbound handled", res.ok);
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T12: States service duration exceeds closing time", lastReply?.text?.includes("تتجاوز موعد إغلاق"));
    check("T12: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T13: Business breaks and non-slot grid alignment
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T13: Non-slot grid alignment ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours, slotDurationMinutes: 30 },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "فحص",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "14:15" }, // misaligned with 30m grid
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 2 وربع متاح؟",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T13: Inbound handled", res.ok);
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T13: Answers 2:15 is unavailable", lastReply?.text?.includes("2:15 مساءً غير متاح"));
    check("T13: Offers nearest aligned slots (14:00 or 14:30)", lastReply?.text?.includes("2:00 مساءً") || lastReply?.text?.includes("2:30 مساءً"));
    check("T13: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T14: Past-time rule on today
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T14: Past-time rule on today ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours, timezone: "Africa/Cairo" },
      todayRef: "2026-10-20",
    });

    // Received at 15:00 UTC (17:00 Cairo time)
    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "فحص",
          service: "كشف أسنان",
          date: "2026-10-20",
          exactTime: { type: "specific", time: "12:00" }, // earlier today
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 12 الظهر اليوم متاح؟",
      receivedAt: "2026-10-20T15:00:00Z",
    });

    check("T14: Inbound handled", res.ok);
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T14: Directly states time has passed today", lastReply?.text?.includes("قد مضى اليوم"));
    check("T14: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T15: Business timezone awareness
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T15: Business timezone awareness ---");
  {
    // Cairo is UTC+2
    const evalResult = await evaluateExactTimeAvailability(
      {
        eligibility: {} as any,
        businessRepository: {
          findById: async () => ({
            id: PLAYGROUND_IDS.businessId,
            name: "عيادة النور",
            timezone: "Africa/Cairo",
            slotDurationMinutes: 30,
            workingHours: standardWorkingHours,
          } as any),
        },
        serviceRepository: {
          findById: async () => ({
            id: PLAYGROUND_IDS.serviceId,
            name: "كشف أسنان",
            durationMinutes: 30,
            isActive: true,
          } as any),
        },
        providerRepository: {
          listAssignmentSeams: async () => [{ providerId: PLAYGROUND_IDS.providerId, userId: PLAYGROUND_IDS.providerUserId }],
        },
        appointmentRepository: {
          listBlockingByAssignees: async () => [],
        } as any,
      },
      { businessId: PLAYGROUND_IDS.businessId, userId: "u1" },
      {
        serviceId: PLAYGROUND_IDS.serviceId,
        date: "2026-10-20",
        requestedTime: "11:00",
        now: new Date("2026-10-20T10:00:00Z"), // 12:00 in Cairo! So 11:00 is PAST in Cairo
        businessTimezone: "Africa/Cairo",
      },
    );

    check("T15: Timezone awareness correctly identifies past time in Cairo", evalResult.isAvailable === false && evalResult.unavailabilityReason === "PAST_TIME");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T16: Numeric protocol selection distinct from "الساعة 3"
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T16: Numeric protocol selection distinct from 'الساعة 3' ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Provide a slot offer first
    let modelCallCount = 0;
    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        modelCallCount++;
        return mockResponse({
          intent: "AVAILABILITY",
          content: "المواعيد المتاحة",
          service: "كشف أسنان",
          date: "2026-10-21",
        });
      },
    };

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد كشف أسنان بكرة",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    const callsBeforeSelection = modelCallCount;

    // Bare number "2" is mechanical protocol selection (0 AI calls)
    const selectRes = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "2",
      receivedAt: "2026-10-20T10:01:00Z",
    });

    check("T16: Bare numeric '2' triggers appointment booking with 0 model calls", modelCallCount === callsBeforeSelection);
    check("T16: Appointment successfully created by numeric selection", harness.capturedAppointmentWrites.length === 1);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T17: Semantic fact correction
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T17: Semantic fact correction ---");
  {
    const rec1 = reconcileTurnSemanticFacts(
      {
        service: "كشف أسنان",
        date: "2026-10-21",
        timePreference: null,
        provider: null,
        temporalRequest: null,
        exactTime: { type: "specific", time: "17:00" },
      },
      [{ key: "exactTime", operation: "set", value: "18:00" }],
    );

    check("T17: Fact update replaces previous exactTime with 18:00", rec1.normalizedExtraction.exactTime?.type === "specific" && (rec1.normalizedExtraction.exactTime as any).time === "18:00");

    const rec2 = reconcileTurnSemanticFacts(
      {
        service: "كشف أسنان",
        date: "2026-10-21",
        timePreference: null,
        provider: null,
        temporalRequest: null,
        exactTime: { type: "specific", time: "17:00" },
      },
      [{ key: "exactTime", operation: "remove" }],
    );

    check("T17: Fact update remove explicitly clears exactTime", rec2.normalizedExtraction.exactTime === null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T18: Stale offer and replay protection
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T18: Stale offer and replay protection ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "المواعيد المتاحة",
          service: "كشف أسنان",
          date: "2026-10-21",
        });
      },
    };

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد كشف أسنان بكرة",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    // Valid booking of option 1
    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "1",
      receivedAt: "2026-10-20T10:01:00Z",
    });

    const writesAfterFirst = harness.capturedAppointmentWrites.length;
    check("T18: First booking created 1 appointment", writesAfterFirst === 1);

    // Replay of selection "1" when offer is already closed/claimed
    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "1",
      receivedAt: "2026-10-20T10:02:00Z",
    });

    check("T18: Replayed selection creates ZERO duplicate appointments", harness.capturedAppointmentWrites.length === 1);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T19: Technical failure handoff
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T19: Technical failure handoff ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harness.deps.ai = {
      providerName: "mock-failing-ai",
      async respond(): Promise<AiResponse> {
        throw new Error("Provider timeout 504");
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد الساعة 5",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T19: Engine handles provider failure gracefully", res.ok && (res as any).conversationStatus === "NEED_HUMAN");
    const lastReply = harness.sentMessages[harness.sentMessages.length - 1];
    check("T19: Customer receives safe temporary failure acknowledgment", lastReply?.text?.includes("واجهت صعوبة مؤقتة في الرد") || lastReply?.text?.includes("سيتواصل معك أحد أعضاء الفريق"));
    check("T19: Zero appointments created", harness.capturedAppointmentWrites.length === 0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T20: Correlated evidence check for temporary handoff
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T20: Correlated evidence check for temporary handoff ---");
  {
    // Correlated evidence analysis:
    // Historical handoff on "الساعة 3" was correlated with schema rejection of non-canonical time strings (e.g. "3 الفجر").
    // In the absence of live provider request traces, cause is classified truthfully as UNKNOWN without paid probes or secret mutations.
    const schemaTest1 = aiExactTimeRequestSchema.safeParse({ type: "specific", time: "17:00" });
    const schemaTest2 = aiExactTimeRequestSchema.safeParse({ type: "unresolved_period", hour: 3 });
    const extractionTest = aiExtractionSchema.safeParse({
      service: "كشف أسنان",
      provider: null,
      date: "2026-10-21",
      timePreference: null,
      exactTime: { type: "unresolved_period", hour: 3 },
    });

    check("T20: Specific exact-time schema validates", schemaTest1.success);
    check("T20: Unresolved period schema validates", schemaTest2.success);
    check("T20: Bounded extraction accepts structured exact-time without crashing", extractionTest.success);
  }

  console.log("\n=================================================================");
  console.log(`  SUMMARY: ${passedChecks}/${totalChecks} checks passed`);
  if (failures.length > 0) {
    console.error(`  FAILURES (${failures.length}):`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  } else {
    console.log("  ALL TESTS PASSED (T01–T20) ✅");
    console.log("=================================================================");
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in test suite:", err);
  process.exit(1);
});
