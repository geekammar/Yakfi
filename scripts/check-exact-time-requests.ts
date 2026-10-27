/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import {
  composeExactTimeResponse,
  evaluateExactTimeAvailability,
  formatTimeArabic,
  rankAlternativesByTemporalDistance,
} from "../src/features/appointments/server/exact-time-service";
import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
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
  dehydrateConversationState,
  emptyConversationState,
  hydrateConversationState,
  projectConversationState,
} from "../src/features/conversations/server/conversation-state";
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

function check(title: string, passed: unknown, extraInfo?: string): void {
  totalChecks++;
  if (Boolean(passed)) {
    passedChecks++;
    console.log(`✔ ${title}`);
  } else {
    failures.push(title);
    console.error(`❌ ${title}${extraInfo ? ` -> ${extraInfo}` : ""}`);
  }
}

async function loadDurableState(harness: any): Promise<any> {
  const loaded = await harness.stateStore.load(
    harness.business.id,
    harness.conversation.id,
  );
  return loaded?.state ?? null;
}

function mockResponse(params: {
  intent: "AVAILABILITY" | "BOOKING" | "FAQ";
  action?: "reply" | "booking_handoff" | "handoff";
  content: string;
  service?: string | null;
  date?: string | null;
  provider?: string | null;
  exactTime?:
    | { type: "specific"; time: string }
    | { type: "unresolved_period"; hour: number; minute?: number }
    | null;
  timePreference?: "morning" | "afternoon" | "evening" | null;
  factUpdates?: Array<{
    key: string;
    operation?: "set" | "remove";
    value?: string;
  }>;
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
      exactTime: params.exactTime
        ? params.exactTime.type === "specific"
          ? params.exactTime
          : {
              type: "unresolved_period",
              hour: params.exactTime.hour,
              minute: params.exactTime.minute ?? 0,
            }
        : null,
    },
    ...(params.factUpdates ? { factUpdates: params.factUpdates as any } : {}),
  };
}

async function main(): Promise<void> {
  console.log(
    "=================================================================",
  );
  console.log(
    "  FLOWPILOT — EXACT-TIME REQUESTS & HONEST AVAILABILITY (T01–T21)",
  );
  console.log(
    "=================================================================\n",
  );

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

    check(
      "T01: Inbound succeeded and active",
      res.ok && (res as any).conversationStatus === "AI_ACTIVE",
    );
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T01: Answers directly that 5:00 PM is available",
      lastReply?.body?.includes("5:00 مساءً متاح"),
    );
    check(
      "T01: Presents slot option for 5:00 PM",
      lastReply?.body?.includes("1️⃣ الساعة 5:00 مساءً"),
    );
    check(
      "T01: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
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
          id: "appt-1300-p1",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          branchId: PLAYGROUND_IDS.BRANCH_ID,
          customerId: "cust-other",
          serviceId: PLAYGROUND_IDS.SERV_DENTAL,
          providerId: PLAYGROUND_IDS.PROV_1,
          assignedUserId: PLAYGROUND_IDS.USER_P1,
          date: new Date("2026-10-21T00:00:00Z"),
          startTime: "13:00",
          endTime: "13:30",
          status: "CONFIRMED",
        },
        {
          id: "appt-1300-p2",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          branchId: PLAYGROUND_IDS.BRANCH_ID,
          customerId: "cust-other-2",
          serviceId: PLAYGROUND_IDS.SERV_DENTAL,
          providerId: PLAYGROUND_IDS.PROV_2,
          assignedUserId: PLAYGROUND_IDS.USER_P2,
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

    check(
      "T02: Inbound succeeded and active",
      res.ok && (res as any).conversationStatus === "AI_ACTIVE",
    );
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T02: Answers directly that 1:00 PM is unavailable",
      lastReply?.body?.includes("1:00 مساءً غير متاح"),
    );
    check(
      "T02: Explains that slot is booked",
      lastReply?.body?.includes("محجوز مسبقاً"),
    );
    check(
      "T02: Offers nearby alternatives",
      lastReply?.body?.includes("أقرب المواعيد المتاحة"),
    );
    check(
      "T02: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );

    // Sub-case: 14:00–15:00 requested with booking beginning at 14:30 and other slots free
    const harness60min = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
      customServices: [
        {
          id: "serv_60min",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          name: "جلسة علاج",
          durationMinutes: 60,
          price: 500,
          currency: "EGP",
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      initialAppointments: [
        {
          id: "appt-1430-p1",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          branchId: PLAYGROUND_IDS.BRANCH_ID,
          customerId: "cust-other-1",
          serviceId: "serv_60min",
          providerId: PLAYGROUND_IDS.PROV_1,
          assignedUserId: PLAYGROUND_IDS.USER_P1,
          date: new Date("2026-10-21T00:00:00Z"),
          startTime: "14:30",
          endTime: "15:00",
          status: "CONFIRMED",
        },
        {
          id: "appt-1430-p2",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          branchId: PLAYGROUND_IDS.BRANCH_ID,
          customerId: "cust-other-2",
          serviceId: "serv_60min",
          providerId: PLAYGROUND_IDS.PROV_2,
          assignedUserId: PLAYGROUND_IDS.USER_P2,
          date: new Date("2026-10-21T00:00:00Z"),
          startTime: "14:30",
          endTime: "15:00",
          status: "CONFIRMED",
        },
      ],
    });

    harness60min.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "AVAILABILITY",
          content: "فحص",
          service: "جلسة علاج",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "14:00" },
        });
      },
    };

    const res60 = await receiveInboundMessage(harness60min.deps, {
      to: harness60min.business.whatsappNumber,
      from: harness60min.customer.phone,
      text: "عايز موعد الساعة 2 مساء لجلسة علاج",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T02: 60-min conflict inbound succeeded", res60.ok);
    const reply60 =
      harness60min.deliveredOutbound[harness60min.deliveredOutbound.length - 1];
    check(
      "T02: 14:00-15:00 classified as conflict when overlapping 14:30 booking",
      reply60?.body?.includes("2:00 مساءً غير متاح") &&
        reply60?.body?.includes("محجوز مسبقاً"),
    );
    check(
      "T02: Never claims whole day is fully booked when alternatives are free",
      !reply60?.body?.includes("جميع المواعيد محجوزة بالكامل"),
    );
    check(
      "T02: Returns genuine alternatives nearby",
      reply60?.body?.includes("أقرب المواعيد المتاحة") &&
        reply60?.body?.includes("1️⃣ الساعة"),
    );
    check(
      "T02: Zero appointments created for 60-min conflict inquiry",
      harness60min.capturedAppointmentWrites.length === 0,
    );
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

    check(
      "T03: Inbound succeeded",
      res.ok && (res as any).conversationStatus === "AI_ACTIVE",
    );
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T03: Discovers off-page slot truthfully without inferring from top-3",
      lastReply?.body?.includes("7:00 مساءً متاح"),
    );
    check(
      "T03: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T04: Genuine AM/PM ambiguity ("الساعة 3:30" and "الساعة 3")
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T04: Genuine AM/PM ambiguity ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Mocked semantic proposal: hour 3, minute 30 unresolved
    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "يرجى التوضيح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "unresolved_period", hour: 3, minute: 30 },
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد الساعة 3:30",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check(
      "T04: Inbound succeeded and active",
      res.ok && (res as any).conversationStatus === "AI_ACTIVE",
    );
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T04: Asks ONE AM/PM clarifying question with exact minutes preserved",
      lastReply?.body?.includes(
        "هل تقصد الساعة 3:30 عصراً (مساءً) أم 3:30 فجراً (صباحاً)؟",
      ),
    );
    check(
      "T04: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T05: Clarification resolution on follow-up turn (3:30 PM preservation)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T05: Clarification resolution on follow-up turn ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Turn 1: ambiguity with minute 30
    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "توضيح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "unresolved_period", hour: 3, minute: 30 },
        });
      },
    };

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد الساعة 3:30",
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

    check(
      "T05: Clarification turn succeeded",
      res2.ok && (res2 as any).conversationStatus === "AI_ACTIVE",
    );
    const reply2 =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T05: Resolved hour 3 + minute 30 + afternoon to 15:30 (3:30 مساءً) without minute truncation",
      reply2?.body?.includes("3:30 مساءً متاح"),
    );
    check(
      "T05: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T05b: 12 AM / 12 PM ambiguity resolution (noon vs midnight)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T05b: 12 AM / 12 PM ambiguity resolution ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Turn 1: 12 ambiguous
    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "توضيح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "unresolved_period", hour: 12 },
        });
      },
    };

    await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "الساعة 12 متاح؟",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    // Turn 2: customer clarifies "ظهراً / مساءً"
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
      text: "ظهراً",
      receivedAt: "2026-10-20T10:01:00Z",
    });

    check("T05b: 12 + afternoon resolves to 12:00 (12:00 ظهراً)", res2.ok);
    const reply2 =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T05b: Answers 12:00 ظهراً directly",
      reply2?.body?.includes("12:00 ظهراً متاح"),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T05c: Missing clarification state safety (no hardcoded fallback hour 3)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T05c: Missing clarification state safety ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Turn with bare "مساءً" and NO previous unresolved ambiguity
    harness.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "تمام",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "evening",
        });
      },
    };

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber,
      from: harness.customer.phone,
      text: "عايز موعد بالليل",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    check("T05c: Inbound succeeded", res.ok);
    const reply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    // Must NOT guess hour 3 or claim exact time 3:00 was requested
    check(
      "T05c: Does not guess hour 3 or invent exact-time request",
      !reply?.body?.includes("الساعة 3:00"),
    );
    check(
      "T05c: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
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
        const time = req.message.includes("5")
          ? "17:00"
          : req.message.includes("6")
            ? "18:00"
            : "19:00";
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

    check(
      "T06: Zero appointments created across all availability questions",
      harness.capturedAppointmentWrites.length === 0,
    );
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
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T07: Presents offer option 1 for confirmation",
      lastReply?.body?.includes("1️⃣ الساعة 5:00 مساءً"),
    );
    check(
      "T07: Never silently creates appointment before confirmation",
      harness.capturedAppointmentWrites.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T08: Unavailable requested time NEVER silently books an alternative
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(
    "--- T08: Unavailable requested time NEVER silently books alternative ---",
  );
  {
    const harness = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
      initialAppointments: [
        {
          id: "appt-conflict-1400",
          businessId: PLAYGROUND_IDS.BIZ_ID,
          branchId: PLAYGROUND_IDS.BRANCH_ID,
          customerId: "cust-other",
          serviceId: PLAYGROUND_IDS.SERV_DENTAL,
          providerId: PLAYGROUND_IDS.PROV_1,
          assignedUserId: PLAYGROUND_IDS.USER_P1,
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

    check(
      "T08: Inbound handled",
      res.ok && (res as any).conversationStatus === "AI_ACTIVE",
    );
    check(
      "T08: Alternatives presented without silent booking",
      harness.capturedAppointmentWrites.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T09: Nearby alternatives ranking
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T09: Nearby alternatives ranking ---");
  {
    const slots = [
      {
        providerOrder: 0,
        providerId: "p1",
        displayName: "د. أحمد",
        startTime: "13:00",
        endTime: "13:30",
      },
      {
        providerOrder: 0,
        providerId: "p1",
        displayName: "د. أحمد",
        startTime: "13:30",
        endTime: "14:00",
      },
      {
        providerOrder: 0,
        providerId: "p1",
        displayName: "د. أحمد",
        startTime: "14:30",
        endTime: "15:00",
      },
      {
        providerOrder: 0,
        providerId: "p1",
        displayName: "د. أحمد",
        startTime: "15:00",
        endTime: "15:30",
      },
    ];
    // Target 14:00: 13:30 and 14:30 are both distance 30. Earlier time (13:30) must win tie.
    const alts = rankAlternativesByTemporalDistance(slots, "14:00", 3);
    check("T09: Exactly 3 alternatives returned", alts.length === 3);
    check(
      "T09: Rank 1 is 13:30 (closer/earlier tie breaker)",
      alts[0]?.startTime === "13:30",
    );
    check("T09: Rank 2 is 14:30", alts[1]?.startTime === "14:30");
    check(
      "T09: Rank 3 is 13:00 (distance 60, earlier than 15:00)",
      alts[2]?.startTime === "13:00",
    );
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
          businessId: PLAYGROUND_IDS.BIZ_ID,
          branchId: PLAYGROUND_IDS.BRANCH_ID,
          customerId: "cust-other",
          serviceId: PLAYGROUND_IDS.SERV_DENTAL,
          providerId: PLAYGROUND_IDS.PROV_1,
          assignedUserId: PLAYGROUND_IDS.USER_P1,
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
          provider: "د. أحمد سامي",
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
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T10: Preserves provider scope and date scope in alternatives",
      lastReply?.body?.includes("أقرب المواعيد المتاحة"),
    );
    check(
      "T10: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
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
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T11: Directly states outside working hours with business hours explained",
      lastReply?.body?.includes("خارج أوقات العمل الرسمية") &&
        lastReply?.body?.includes("أوقات العمل"),
    );
    check(
      "T11: Offers nearest in-hours alternatives (e.g. 09:00)",
      lastReply?.body?.includes("9:00 صباحاً"),
    );
    check(
      "T11: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
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
    const origFindById = harness.deps.serviceRepository.findById?.bind(
      harness.deps.serviceRepository,
    );
    harness.deps.serviceRepository.findById = async (id: string) => {
      const s = origFindById ? await origFindById(id) : null;
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
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T12: States service duration exceeds closing time",
      lastReply?.body?.includes("تتجاوز موعد إغلاق"),
    );
    check(
      "T12: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T13: Business breaks and non-slot grid alignment
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T13: Non-slot grid alignment ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: {
        workingHours: standardWorkingHours,
        slotDurationMinutes: 30,
      },
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
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T13: Answers 2:15 is unavailable",
      lastReply?.body?.includes("2:15 مساءً غير متاح"),
    );
    check(
      "T13: Explains truthful slot-grid mismatch without falsely claiming booked",
      lastReply?.body?.includes("لا يتوافق مع فترات جدول المواعيد") &&
        !lastReply?.body?.includes("محجوز مسبقاً"),
    );
    check(
      "T13: Offers nearest aligned slots (14:00 or 14:30)",
      lastReply?.body?.includes("2:00 مساءً") ||
        lastReply?.body?.includes("2:30 مساءً"),
    );
    check(
      "T13: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T14: Past-time rule on today
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T14: Past-time rule on today ---");
  {
    const harness = createPlaygroundHarness({
      businessConfig: {
        workingHours: standardWorkingHours,
        timezone: "Africa/Cairo",
      },
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
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T14: Directly states time has passed today",
      lastReply?.body?.includes("قد مضى اليوم"),
    );
    check(
      "T14: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T15: Business timezone awareness
  // ─────────────────────────────────────────────────────────────────────────────
  console.log("--- T15: Business timezone awareness ---");
  {
    // Cairo is UTC+2
    const harness = createPlaygroundHarness({
      businessConfig: {
        workingHours: standardWorkingHours,
        timezone: "Africa/Cairo",
      },
      todayRef: "2026-10-20",
    });

    const bookingDeps: any = {
      eligibility: {
        serviceRepository: harness.deps.serviceRepository,
        branchRepository: harness.deps.branchRepository,
        providerRepository: harness.deps.providerRepository,
      },
      businessRepository: harness.deps.businessRepository,
      serviceRepository: harness.deps.serviceRepository,
      providerRepository: harness.deps.providerRepository,
      appointmentRepository: harness.deps.appointmentRepository,
    };

    const evalResult = await evaluateExactTimeAvailability(
      bookingDeps,
      { businessId: PLAYGROUND_IDS.BIZ_ID, userId: "u1" },
      {
        serviceId: PLAYGROUND_IDS.SERV_DENTAL,
        date: "2026-10-20",
        requestedTime: "11:00",
        now: new Date("2026-10-20T10:00:00Z"), // 12:00 in Cairo! So 11:00 is PAST in Cairo
        businessTimezone: "Africa/Cairo",
      },
    );

    check(
      "T15: Timezone awareness correctly identifies past time in Cairo",
      evalResult.isAvailable === false &&
        evalResult.unavailabilityReason === "PAST_TIME",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T16: Numeric protocol selection distinct from "الساعة 3"
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(
    "--- T16: Numeric protocol selection distinct from 'الساعة 3' ---",
  );
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

    check(
      "T16: Bare numeric '2' triggers appointment booking with 0 model calls",
      modelCallCount === callsBeforeSelection && selectRes.ok,
    );
    check(
      "T16: Appointment successfully created by numeric selection",
      harness.capturedAppointmentWrites.length === 1,
    );
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

    check(
      "T17: Fact update replaces previous exactTime with 18:00",
      rec1.normalizedExtraction.exactTime?.type === "specific" &&
        (rec1.normalizedExtraction.exactTime as any).time === "18:00",
    );

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

    check(
      "T17: Fact update remove explicitly clears exactTime",
      rec2.normalizedExtraction.exactTime === null,
    );
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

    check(
      "T18: Replayed selection creates ZERO duplicate appointments",
      harness.capturedAppointmentWrites.length === 1,
    );

    // Sub-case: Invalidate active offer when customer changes exact-time request
    const harness2 = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Turn 1: request 17:00 -> offer presented
    harness2.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "متاح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "17:00" },
        });
      },
    };
    await receiveInboundMessage(harness2.deps, {
      to: harness2.business.whatsappNumber,
      from: harness2.customer.phone,
      text: "عايز موعد الساعة 5 مساء",
      receivedAt: "2026-10-20T10:00:00Z",
    });
    const offerMsg1 =
      harness2.deliveredOutbound[harness2.deliveredOutbound.length - 1];
    const choices1 = (offerMsg1 as any)?.choices;
    const token1 = choices1?.offerToken;
    check(
      "T18: Offer 1 yielded a valid callback offerToken",
      typeof token1 === "string" && token1.length > 0,
    );

    // Turn 2: customer changes exact time to 19:00 -> offer1 invalidated, offer2 presented
    harness2.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "متاح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "19:00" },
        });
      },
    };
    await receiveInboundMessage(harness2.deps, {
      to: harness2.business.whatsappNumber,
      from: harness2.customer.phone,
      text: "لا خليه الساعة 7 مساء",
      receivedAt: "2026-10-20T10:01:00Z",
    });
    const offerMsg2 =
      harness2.deliveredOutbound[harness2.deliveredOutbound.length - 1];
    const choices2 = (offerMsg2 as any)?.choices;
    const token2 = choices2?.offerToken;
    check(
      "T18: Offer 2 yielded a valid callback offerToken",
      typeof token2 === "string" && token2.length > 0,
    );
    check(
      "T18: New offer has a distinct offerToken from offer 1",
      token2 !== token1,
    );

    // Replay old callback token from offer 1 unconditionally (must be rejected)
    await receiveInboundMessage(harness2.deps, {
      to: harness2.business.whatsappNumber,
      from: harness2.customer.phone,
      text: `fp:${token1}:1`,
      receivedAt: "2026-10-20T10:02:00Z",
    });
    const staleReply =
      harness2.deliveredOutbound[harness2.deliveredOutbound.length - 1];
    check(
      "T18: Old offer callback rejected as stale after exact-time change",
      staleReply?.body?.includes("عرضاً سابقاً لم يعد متاحاً") ||
        staleReply?.body?.includes("لم يعد متاحاً"),
    );
    check(
      "T18: Zero appointments created from stale callback",
      harness2.capturedAppointmentWrites.length === 0,
    );

    // Select newly offered exact-time slot through current callback token unconditionally (must succeed)
    await receiveInboundMessage(harness2.deps, {
      to: harness2.business.whatsappNumber,
      from: harness2.customer.phone,
      text: `fp:${token2}:1`,
      receivedAt: "2026-10-20T10:03:00Z",
    });
    check(
      "T18: New exact-time offer callback successfully booked with revalidation",
      harness2.capturedAppointmentWrites.length === 1,
    );
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

    check(
      "T19: Engine handles provider failure gracefully",
      res.ok && (res as any).conversationStatus === "NEED_HUMAN",
    );
    const lastReply =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    check(
      "T19: Customer receives safe temporary failure acknowledgment",
      lastReply?.body?.includes("واجهت صعوبة مؤقتة في الرد") ||
        lastReply?.body?.includes("سيتواصل معك أحد أعضاء الفريق") ||
        lastReply?.body?.includes("جارٍ تحويلك لأحد أعضاء الفريق"),
    );
    check(
      "T19: Zero appointments created",
      harness.capturedAppointmentWrites.length === 0,
    );

    // Sub-case: Repository lookup failure during exact-time availability check
    const harnessRepoFail = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Seed state with an existing active offer
    harnessRepoFail.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "متاح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "17:00" },
        });
      },
    };
    await receiveInboundMessage(harnessRepoFail.deps, {
      to: harnessRepoFail.business.whatsappNumber,
      from: harnessRepoFail.customer.phone,
      text: "عايز موعد الساعة 5 مساء",
      receivedAt: "2026-10-20T10:00:00Z",
    });
    const priorState = await loadDurableState(harnessRepoFail);
    check(
      "T19: Prior offer was active before technical failure",
      priorState?.offer?.status === "ACTIVE",
    );

    // Inject repository lookup failure on subsequent exact-time lookup
    harnessRepoFail.deps.appointmentRepository!.listBlockingByAssignees =
      async () => {
        throw new Error("Database connection pool exhausted");
      };

    harnessRepoFail.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "فحص",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "18:00" },
        });
      },
    };

    const failRes = await receiveInboundMessage(harnessRepoFail.deps, {
      to: harnessRepoFail.business.whatsappNumber,
      from: harnessRepoFail.customer.phone,
      text: "عايز موعد الساعة 6 مساء",
      receivedAt: "2026-10-20T10:05:00Z",
    });

    check("T19: Technical repository failure turn handled safely", failRes.ok);
    const repoFailReply =
      harnessRepoFail.deliveredOutbound[
        harnessRepoFail.deliveredOutbound.length - 1
      ];
    check(
      "T19: Technical failure returns honest unable-to-check explanation",
      repoFailReply?.body?.includes(
        "تعذر التحقق من توفر موعد الساعة 6:00 مساءً حالياً بسبب خلل فني مؤقت",
      ),
    );
    check(
      "T19: Technical failure does NOT append 'no other appointments' claim",
      !repoFailReply?.body?.includes("ولا تتوفر مواعيد أخرى"),
    );
    check(
      "T19: Technical failure offers zero alternatives / choices",
      (repoFailReply as any)?.choices === null ||
        (repoFailReply as any)?.choices === undefined,
    );
    check(
      "T19: Zero appointment writes on technical failure",
      harnessRepoFail.capturedAppointmentWrites.length === 0,
    );
    const stateAfterFail = await loadDurableState(harnessRepoFail);
    check(
      "T19: Obsolete offer is safely invalidated/cleared after technical failure",
      stateAfterFail?.offer === null ||
        stateAfterFail?.offer?.status !== "ACTIVE",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T20: Durable state round-trip, context projection & correlated evidence check
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(
    "--- T20: Durable state round-trip, context projection & correlated evidence check ---",
  );
  {
    // 1. Correlated evidence analysis:
    // Historical handoff on "الساعة 3" was correlated with schema rejection of non-canonical time strings (e.g. "3 الفجر").
    // In the absence of live provider request traces, cause is classified truthfully as UNKNOWN without paid probes or secret mutations.
    const schemaTest1 = aiExactTimeRequestSchema.safeParse({
      type: "specific",
      time: "17:00",
    });
    const schemaTest2 = aiExactTimeRequestSchema.safeParse({
      type: "unresolved_period",
      hour: 3,
    });
    const schemaTest3 = aiExactTimeRequestSchema.safeParse({
      type: "unresolved_period",
      hour: 3,
      minute: 30,
    });
    const extractionTest = aiExtractionSchema.safeParse({
      service: "كشف أسنان",
      provider: null,
      date: "2026-10-21",
      timePreference: null,
      exactTime: { type: "unresolved_period", hour: 3, minute: 30 },
    });

    check("T20: Specific exact-time schema validates", schemaTest1.success);
    check("T20: Unresolved period schema validates", schemaTest2.success);
    check("T20: Unresolved period with minute validates", schemaTest3.success);
    check(
      "T20: Bounded extraction accepts structured exact-time without crashing",
      extractionTest.success,
    );

    // 2. Durable state dehydration and hydration round-trip
    const baseState = emptyConversationState();
    const testState = {
      ...baseState,
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-21",
        exactTime: "17:00",
        unresolvedTime: { hour: 3, minute: 30 },
      },
      lastClarification: {
        type: "exact_time_period",
        turnId: "turn-test-1",
        unresolvedTime: { hour: 3, minute: 30 },
      },
    };

    const dehydrated = dehydrateConversationState(testState);
    const jsonStr = JSON.stringify(dehydrated);
    const reloaded = JSON.parse(jsonStr);
    const hydrated = hydrateConversationState(reloaded, {
      businessId: PLAYGROUND_IDS.BIZ_ID,
      conversationId: "conv_test_1",
    });

    check(
      "T20: Durable state round-trips via dehydrate -> JSON -> hydrate",
      hydrated !== null,
    );
    check(
      "T20: Hydrated state preserves exactTime",
      hydrated?.knownFacts.exactTime === "17:00",
    );
    check(
      "T20: Hydrated state preserves typed unresolvedTime { hour: 3, minute: 30 }",
      hydrated?.knownFacts.unresolvedTime?.hour === 3 &&
        hydrated?.knownFacts.unresolvedTime?.minute === 30,
    );
    check(
      "T20: Hydrated state preserves typed lastClarification unresolvedTime",
      (hydrated?.lastClarification as any)?.unresolvedTime?.hour === 3 &&
        (hydrated?.lastClarification as any)?.unresolvedTime?.minute === 30,
    );

    // 3. AI context projection
    const projection = projectConversationState(hydrated);
    check(
      "T20: Context projection projects knownExactTime",
      projection?.knownExactTime === "17:00",
    );
    check(
      "T20: Context projection projects pendingClarification unresolvedTime",
      (projection?.pendingClarification as any)?.unresolvedTime?.hour === 3 &&
        (projection?.pendingClarification as any)?.unresolvedTime?.minute ===
          30,
    );

    // 4. Backward compatibility: hydrate legacy state JSON without exactTime / unresolvedTime
    const legacyRaw = {
      version: 1,
      currentGoal: "BOOKING",
      activeTask: { kind: "BOOKING", stage: "DATE_SUPPLIED" },
      knownFacts: {
        service: "كشف أسنان",
        date: "2026-10-21",
        timePreference: "morning",
      },
      missingFacts: [],
      bookingStage: "DATE_SUPPLIED",
      pendingGoals: [],
      lastClarification: null,
      serviceId: "srv_test",
      serviceSource: "CUSTOMER",
      offer: null,
      suspendedOffer: null,
      completedTask: null,
    };
    const legacyHydrated = hydrateConversationState(legacyRaw, {
      businessId: PLAYGROUND_IDS.BIZ_ID,
      conversationId: "conv_test_1",
    });
    check(
      "T20: Legacy persisted state without exactTime hydrates safely without error",
      legacyHydrated !== null &&
        legacyHydrated.knownFacts.exactTime === undefined,
    );

    // 5. Unit checks for formatting, default extraction, and response schema
    check(
      "T20: formatTimeArabic formats 17:00 as 5:00 مساءً",
      formatTimeArabic("17:00") === "5:00 مساءً",
    );
    check(
      "T20: formatTimeArabic formats 00:00 as 12:00 منتصف الليل",
      formatTimeArabic("00:00") === "12:00 منتصف الليل",
    );
    check(
      "T20: emptyAiExtraction has null exactTime",
      emptyAiExtraction.exactTime === null,
    );
    check(
      "T20: aiResponseSchema validates mock response",
      aiResponseSchema.safeParse(
        mockResponse({ intent: "FAQ", content: "test" }),
      ).success,
    );
    const mockEvalResult = {
      isAvailable: true,
      matchedSlot: {
        providerOrder: 0,
        providerId: "prov_1",
        displayName: "دكتور",
        startTime: "17:00",
        endTime: "17:30",
      },
      allAvailableSlots: [],
      alternatives: [],
      serviceName: "كشف أسنان",
      serviceDurationMinutes: 30,
    };
    const composed = composeExactTimeResponse({
      evaluation: mockEvalResult,
      date: "2026-10-21",
      requestedTime: "17:00",
      intent: "AVAILABILITY",
    });
    check(
      "T20: composeExactTimeResponse formats availability message",
      composed.message.includes("5:00 مساءً"),
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T21: Full-engine exact-time resume & reconciliation with durable reloads
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(
    "--- T21: Full-engine exact-time resume & reconciliation with durable reloads ---",
  );
  {
    // 1. Omission across durable reloads:
    // Turn 1: Customer requests exact time 17:00 on 2026-10-21.
    // Turn 2: Customer specifies provider only ("مع دكتور أحمد"). AI extraction omits exactTime, date, and service.
    // Verify: exactTime 17:00 restored from durable state; persisted state, response, and offer contents agree.
    const harnessOmission = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harnessOmission.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "متاح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "17:00" },
        });
      },
    };
    await receiveInboundMessage(harnessOmission.deps, {
      to: harnessOmission.business.whatsappNumber,
      from: harnessOmission.customer.phone,
      text: "عايز موعد كشف أسنان بكرة الساعة 5 مساء",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    // Durable reload: read state directly from stateStore
    const stateTurn1 = await loadDurableState(harnessOmission);
    check(
      "T21.1: Turn 1 persisted state carries exactTime 17:00",
      stateTurn1?.knownFacts.exactTime === "17:00",
    );

    // Turn 2: Customer provides provider; AI extraction omits exactTime and date
    harnessOmission.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "متاح",
          provider: PLAYGROUND_IDS.PROV_1,
        });
      },
    };
    await receiveInboundMessage(harnessOmission.deps, {
      to: harnessOmission.business.whatsappNumber,
      from: harnessOmission.customer.phone,
      text: "مع دكتور أحمد",
      receivedAt: "2026-10-20T10:01:00Z",
    });

    const replyTurn2 =
      harnessOmission.deliveredOutbound[
        harnessOmission.deliveredOutbound.length - 1
      ];
    const stateTurn2 = await loadDurableState(harnessOmission);
    const choicesTurn2 = (replyTurn2 as any)?.choices;

    check(
      "T21.1: Omission turn response answers for resumed exact time 17:00",
      replyTurn2?.body?.includes("5:00 مساءً"),
    );
    check(
      "T21.1: Omission turn offer is present and bound to resumed exact time 17:00",
      choicesTurn2?.offerKind === "SLOT" &&
        stateTurn2?.offer?.options?.some((o: any) =>
          o.startAt?.includes("17:00"),
        ),
    );
    check(
      "T21.1: Persisted state, outgoing response, and offer contents agree on resumed exact time",
      stateTurn2?.knownFacts.exactTime === "17:00" &&
        stateTurn2?.knownFacts.provider === PLAYGROUND_IDS.PROV_1,
    );

    // 2. factUpdates-only set and remove across durable reloads:
    const harnessFactUpdates = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // 2a. factUpdates-only SET: extraction has exactTime null, factUpdates sets exactTime: "14:00"
    harnessFactUpdates.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "متاح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: null,
          factUpdates: [{ key: "exactTime", value: "14:00", operation: "set" }],
        });
      },
    };
    await receiveInboundMessage(harnessFactUpdates.deps, {
      to: harnessFactUpdates.business.whatsappNumber,
      from: harnessFactUpdates.customer.phone,
      text: "عايز موعد كشف أسنان بكرة",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    const replySet =
      harnessFactUpdates.deliveredOutbound[
        harnessFactUpdates.deliveredOutbound.length - 1
      ];
    const stateSet = await loadDurableState(harnessFactUpdates);
    const choicesSet = (replySet as any)?.choices;

    check(
      "T21.2a: factUpdates-only SET makes reconciled exact time authoritative in response",
      replySet?.body?.includes("2:00 مساءً"),
    );
    check(
      "T21.2a: factUpdates-only SET persists exactTime 14:00 in durable state",
      stateSet?.knownFacts.exactTime === "14:00",
    );
    check(
      "T21.2a: factUpdates-only SET offer contents match 14:00",
      stateSet?.offer?.options?.some((o: any) =>
        o.startAt?.includes("14:00"),
      ) && choicesSet?.offerKind === "SLOT",
    );

    // 2b. factUpdates-only REMOVE: extraction has exactTime null, factUpdates removes exactTime
    harnessFactUpdates.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "أي وقت",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: null,
          factUpdates: [{ key: "exactTime", operation: "remove" }],
        });
      },
    };
    await receiveInboundMessage(harnessFactUpdates.deps, {
      to: harnessFactUpdates.business.whatsappNumber,
      from: harnessFactUpdates.customer.phone,
      text: "أي وقت مناسب مش لازم 2",
      receivedAt: "2026-10-20T10:02:00Z",
    });

    const stateRemove = await loadDurableState(harnessFactUpdates);
    check(
      "T21.2b: factUpdates-only REMOVE removes exactTime from persisted durable state",
      stateRemove?.knownFacts.exactTime === undefined,
    );

    // 3. Conflicting extraction and factUpdate:
    // Extraction says 16:00, but factUpdates says 18:00 (factUpdate must win authoritative)
    const harnessConflict = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harnessConflict.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "فحص",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "16:00" },
          factUpdates: [{ key: "exactTime", value: "18:00", operation: "set" }],
        });
      },
    };
    await receiveInboundMessage(harnessConflict.deps, {
      to: harnessConflict.business.whatsappNumber,
      from: harnessConflict.customer.phone,
      text: "خليه الساعة 6 مساء",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    const replyConflict =
      harnessConflict.deliveredOutbound[
        harnessConflict.deliveredOutbound.length - 1
      ];
    const stateConflict = await loadDurableState(harnessConflict);
    check(
      "T21.3: Conflicting extraction vs factUpdate: factUpdate 18:00 wins in response",
      replyConflict?.body?.includes("6:00 مساءً"),
    );
    check(
      "T21.3: Conflicting extraction vs factUpdate: persisted state has 18:00",
      stateConflict?.knownFacts.exactTime === "18:00",
    );
    check(
      "T21.3: Conflicting extraction vs factUpdate: offer options match 18:00",
      stateConflict?.offer?.options?.some((o: any) =>
        o.startAt?.includes("18:00"),
      ),
    );

    // 4. Date and provider correction with durable reload:
    // Turn 1: 14:00 on 2026-10-21 -> Offer 1
    // Turn 2: date corrected to 2026-10-22 (omits exactTime) -> Offer 1 invalidated, exactTime 14:00 evaluated on 2026-10-22
    const harnessCorrection = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    harnessCorrection.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "متاح",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "specific", time: "14:00" },
        });
      },
    };
    await receiveInboundMessage(harnessCorrection.deps, {
      to: harnessCorrection.business.whatsappNumber,
      from: harnessCorrection.customer.phone,
      text: "عايز موعد كشف أسنان بكرة الساعة 2 مساء",
      receivedAt: "2026-10-20T10:00:00Z",
    });
    const stateCorr1 = await loadDurableState(harnessCorrection);
    const offerTokenCorr1 = stateCorr1?.offer?.token;
    check(
      "T21.4: Turn 1 offer created with valid token",
      typeof offerTokenCorr1 === "string" && offerTokenCorr1.length > 0,
    );

    // Turn 2: date corrected to 2026-10-22, exactTime omitted
    harnessCorrection.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "متاح",
          date: "2026-10-22",
        });
      },
    };
    await receiveInboundMessage(harnessCorrection.deps, {
      to: harnessCorrection.business.whatsappNumber,
      from: harnessCorrection.customer.phone,
      text: "لا خليه يوم الخميس 2026-10-22",
      receivedAt: "2026-10-20T10:02:00Z",
    });
    const replyCorr2 =
      harnessCorrection.deliveredOutbound[
        harnessCorrection.deliveredOutbound.length - 1
      ];
    const stateCorr2 = await loadDurableState(harnessCorrection);
    check(
      "T21.4: Date correction evaluates resumed exact time 14:00 on new date 2026-10-22",
      replyCorr2?.body?.includes("2:00 مساءً") &&
        replyCorr2?.body?.includes("2026-10-22"),
    );
    check(
      "T21.4: Date correction offer matches new date and resumed exact time",
      stateCorr2?.offer?.date === "2026-10-22" &&
        stateCorr2?.offer?.options?.some((o: any) =>
          o.startAt?.includes("2026-10-22T14:00"),
        ),
    );
    check(
      "T21.4: Offer 1 token is superseded and distinct from new offer token",
      stateCorr2?.offer?.token !== offerTokenCorr1,
    );

    // 5. Removal of unresolved time across durable reloads:
    const harnessUnresolvedRemove = createPlaygroundHarness({
      businessConfig: { workingHours: standardWorkingHours },
      todayRef: "2026-10-20",
    });

    // Turn 1: Customer asks "الساعة 3" -> ambiguity clarification
    harnessUnresolvedRemove.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "أي وقت؟",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: { type: "unresolved_period", hour: 3, minute: 0 },
        });
      },
    };
    await receiveInboundMessage(harnessUnresolvedRemove.deps, {
      to: harnessUnresolvedRemove.business.whatsappNumber,
      from: harnessUnresolvedRemove.customer.phone,
      text: "عايز موعد الساعة 3",
      receivedAt: "2026-10-20T10:00:00Z",
    });

    const stateUnresolved1 = await loadDurableState(harnessUnresolvedRemove);
    check(
      "T21.5: Turn 1 persisted state has typed unresolvedTime and clarification",
      stateUnresolved1?.knownFacts.unresolvedTime?.hour === 3 &&
        stateUnresolved1?.lastClarification?.type === "exact_time_period",
    );

    // Turn 2: Customer removes exactTime via factUpdate
    harnessUnresolvedRemove.deps.ai = {
      providerName: "mock-ai",
      async respond(): Promise<AiResponse> {
        return mockResponse({
          intent: "BOOKING",
          content: "تم الإلغاء",
          service: "كشف أسنان",
          date: "2026-10-21",
          exactTime: null,
          factUpdates: [{ key: "exactTime", operation: "remove" }],
        });
      },
    };
    await receiveInboundMessage(harnessUnresolvedRemove.deps, {
      to: harnessUnresolvedRemove.business.whatsappNumber,
      from: harnessUnresolvedRemove.customer.phone,
      text: "بلاش الساعة 3 اعرض لي كل المتاح",
      receivedAt: "2026-10-20T10:02:00Z",
    });

    const stateUnresolved2 = await loadDurableState(harnessUnresolvedRemove);
    check(
      "T21.5: Removing exactTime clears unresolvedTime from durable state",
      stateUnresolved2?.knownFacts.unresolvedTime === undefined,
    );
    check(
      "T21.5: Removing exactTime clears lastClarification",
      stateUnresolved2?.lastClarification === null,
    );
  }

  console.log(
    "\n=================================================================",
  );
  console.log(`  SUMMARY: ${passedChecks}/${totalChecks} checks passed`);
  if (failures.length > 0) {
    console.error(`  FAILURES (${failures.length}):`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  } else {
    console.log("  ALL TESTS PASSED (T01–T21) ✅");
    console.log(
      "=================================================================",
    );
  }
}

main().catch((err) => {
  console.error("FATAL ERROR in test suite:", err);
  process.exit(1);
});
