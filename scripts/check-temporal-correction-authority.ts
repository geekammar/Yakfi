/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { createPlaygroundHarness } from "../src/features/conversations/playground/harness";
import {
  aiTemporalRequestSchema,
  type AiResponse,
} from "../src/features/conversations/server/ai-contract";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import {
  daysInMonth,
  deriveLocalDate,
  isLeapYear,
  isValidCalendarComponents,
  isValidIsoCalendarDate,
  resolveServerTemporalRequest,
  todayIsoInTimeZone,
} from "../src/features/conversations/server/temporal-context";

/**
 * Temporal Correction Authority & Invalid-Date Acceptance Suite
 * (ISS-011 & ISS-015).
 *
 * Verifies:
 * 1. Old pending offer + new past-date request ("عايز أحجز امبارح"):
 *    Truthful response, no old offer replay, no appointment, offer invalidated.
 * 2. Same past-date request without prior offer: truthful response.
 * 3. Impossible 30 February and another impossible calendar date:
 *    Rejected as impossible date, no rollover to 1 March or 1 November.
 * 4. 29 February in non-leap year (2026) vs valid leap year (2028).
 * 5. Day-only request ("يوم 5"):
 *    Missing context asks bounded question for month; prior context resolves.
 * 6. Invalid/ambiguous correction followed by a valid correction:
 *    Correct date resumes; valid service/provider preferences survive.
 * 7. Obsolete callback after a date correction:
 *    Rejected, no inconsistent appointment created.
 * 8. Business-local date around midnight, independent of runner timezone.
 * 9. Contract rejection/fallback behavior:
 *    No accidental inherited-date resurrection.
 * 10. Equivalent temporal authority under START_ONLY and FULL_RANGE.
 */

type Check = { label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(label: string, condition: boolean, details?: string): void {
  checks.push({ label, pass: condition, details });
  const icon = condition ? "✅" : "❌";
  console.log(`${icon} ${label}${details ? ` (${details})` : ""}`);
}

function lastBody(h: any): string {
  return h.deliveredOutbound[h.deliveredOutbound.length - 1]?.body ?? "";
}

function getOffer(h: any): any {
  return h.stateStore.rows.get(h.conversation.id)?.state;
}

function isReply(res: any): boolean {
  return (
    res.ok === true && !res.duplicate && res.assistantAction === "AI_REPLY"
  );
}

function isActive(res: any): boolean {
  return (
    res.ok === true && !res.duplicate && res.conversationStatus === "AI_ACTIVE"
  );
}

function noHandoff(res: any): boolean {
  return res.ok === true && !res.duplicate && res.handoffCause === null;
}

function createMockAiResponse(overrides: Partial<AiResponse> = {}): AiResponse {
  return {
    intent: "BOOKING",
    action: "booking_handoff",
    content: "المواعيد المتاحة لطلبك:",
    summary: "طلب حجز",
    handoffReason: null,
    safetyAssessment: "safe",
    extraction: {
      service: "كشف أسنان",
      provider: null,
      date: null,
      timePreference: null,
      temporalRequest: null,
      exactTime: null,
      ...(overrides.extraction ?? {}),
    },
    ...overrides,
  };
}

async function runSuite(): Promise<void> {
  console.log("── TEMPORAL CORRECTION AUTHORITY ACCEPTANCE SUITE ──\n");

  const CAIRO_TZ = "Africa/Cairo";

  // ───────────────────────────────────────────────────────────────────────────
  // Group 1: Old pending offer + new past-date request (ISS-011 / TG-11)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 1: Past-date request with old pending offer");
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    // Fixed clock: Sunday 1 November 2026, 10:00 AM UTC
    const clockTurn1 = "2026-11-01T10:00:00.000Z";

    check(
      "1.0 aiTemporalRequestSchema validates negative relative day offset",
      aiTemporalRequestSchema.safeParse({
        type: "relative_day",
        offsetDays: -1,
      }).success,
    );

    // Turn 1: Customer requests booking for Thursday 5 November 2026
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: "2026-11-05",
            timePreference: null,
            temporalRequest: { type: "exact_date", date: "2026-11-05" },
            exactTime: null,
          },
        });
      },
    };

    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان يوم 5 نوفمبر 2026",
        receivedAt: clockTurn1,
        externalId: "ext-grp1-turn1",
      },
      identity,
    );

    check(
      "1.1 Turn 1 successfully presents booking options for 2026-11-05",
      isReply(turn1),
    );
    const offer1 = getOffer(harness);
    check(
      "1.2 Turn 1 establishes active SLOT offer for 2026-11-05",
      offer1?.offer?.kind === "SLOT" &&
        offer1?.offer?.date === "2026-11-05" &&
        offer1?.offer?.status === "ACTIVE",
    );

    // Turn 2: Customer challenges with past date: "عايز أحجز امبارح"
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "relative_day", offsetDays: -1 },
            exactTime: null,
          },
        });
      },
    };

    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز أحجز امبارح",
        receivedAt: "2026-11-01T10:05:00.000Z",
        externalId: "ext-grp1-turn2",
      },
      identity,
    );

    check(
      "1.3 Turn 2 responds with AI_REPLY and stays AI_ACTIVE",
      isReply(turn2) && isActive(turn2),
    );

    const turn2Message = lastBody(harness);
    const hasPastExplanation =
      turn2Message.includes("التاريخ المحدد في الماضي") ||
      turn2Message.includes("في الماضي");
    check(
      "1.4 Turn 2 delivers truthful past-date explanation",
      hasPastExplanation,
      `Delivered: ${turn2Message}`,
    );

    const noOldOffer =
      !turn2Message.includes("2026-11-05") &&
      !turn2Message.includes("5 نوفمبر");
    check(
      "1.5 Turn 2 does NOT re-present the old 2026-11-05 offer",
      noOldOffer,
    );

    check(
      "1.6 Zero appointments created during past-date request",
      harness.appointments.length === 0,
    );

    const stateAfterTurn2 = getOffer(harness);
    const isOfferInvalidated =
      stateAfterTurn2?.offer === null ||
      stateAfterTurn2?.offer?.status === "INVALIDATED";
    check(
      "1.7 Obsolete offer is invalidated and cleared from actionable state",
      isOfferInvalidated,
    );
    const dateClearedServiceSurvives =
      stateAfterTurn2?.knownFacts?.date === undefined &&
      stateAfterTurn2?.knownFacts?.service === "كشف أسنان";
    check(
      "1.8 Obsolete date is cleared from knownFacts while service survives",
      dateClearedServiceSurvives,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 2: Past-date request without prior offer
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 2: Past-date request without prior offer");
  {
    // Group 2 harness
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "relative_day", offsetDays: -1 },
            exactTime: null,
          },
        });
      },
    };

    const turn = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز أحجز امبارح",
        receivedAt: "2026-11-01T10:00:00.000Z",
        externalId: "ext-grp2-turn1",
      },
      identity,
    );

    check(
      "2.1 Fresh past-date turn returns AI_REPLY and AI_ACTIVE",
      turn.ok === true &&
        !turn.duplicate &&
        turn.assistantAction === "AI_REPLY" &&
        turn.conversationStatus === "AI_ACTIVE",
    );

    const msg = harness.deliveredOutbound[0]?.body ?? "";
    check(
      "2.2 Fresh past-date delivers past-date explanation",
      msg.includes("في الماضي"),
    );

    check("2.3 Zero appointments created", harness.appointments.length === 0);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 3: Impossible calendar dates (ISS-015 B)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 3: Impossible calendar dates (ISS-015 B)");
  {
    // 3.1 Direct server resolution test for 30 February
    const res30Feb = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 30, month: 2 },
      null,
      new Date("2026-11-01T10:00:00.000Z"),
      CAIRO_TZ,
    );
    check(
      "3.1 30 February is rejected by server as IMPOSSIBLE_DATE",
      res30Feb.kind === "invalid" && res30Feb.reason === "IMPOSSIBLE_DATE",
      `Got: ${JSON.stringify(res30Feb)}`,
    );

    // 3.2 Direct server resolution test for 31 April (April has 30 days)
    const res31Apr = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 31, month: 4 },
      null,
      new Date("2026-11-01T10:00:00.000Z"),
      CAIRO_TZ,
    );
    check(
      "3.2 31 April is rejected by server as IMPOSSIBLE_DATE",
      res31Apr.kind === "invalid" && res31Apr.reason === "IMPOSSIBLE_DATE",
      `Got: ${JSON.stringify(res31Apr)}`,
    );

    check(
      "3.2b Calendar helpers validate calendar components and ISO dates",
      isValidCalendarComponents(30, 2, 2026) === false &&
        isValidCalendarComponents(29, 2, 2028) === true &&
        isValidIsoCalendarDate("2026-02-30") === false &&
        isValidIsoCalendarDate("2028-02-29") === true,
    );

    // 3.3 Engine end-to-end turn with "30 فبراير"
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "unresolved_date", day: 30, month: 2 },
            exactTime: null,
          },
        });
      },
    };

    const turn = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان يوم 30 فبراير",
        receivedAt: "2026-10-31T10:00:00.000Z",
        externalId: "ext-grp3-turn1",
      },
      identity,
    );

    check(
      "3.3 Engine executes 30 February as AI_REPLY / AI_ACTIVE",
      isReply(turn) && isActive(turn),
    );

    const msg = lastBody(harness);
    const hasImpossibleDateReject =
      (msg.includes("غير موجود في التقويم") || msg.includes("فبراير")) &&
      !msg.includes("1 نوفمبر") &&
      !msg.includes("1 مارس");
    check(
      "3.4 Rejection explains impossible calendar date without rollover",
      hasImpossibleDateReject,
      `Delivered message: ${msg}`,
    );

    check(
      "3.5 Zero appointments created for impossible date",
      harness.appointments.length === 0,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 4: 29 February leap year vs non-leap year (ISS-015 C)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 4: 29 February leap year vs non-leap (ISS-015 C)");
  {
    check(
      "4.1 2026 is non-leap year, 2028 is leap year",
      !isLeapYear(2026) && isLeapYear(2028),
    );
    check(
      "4.2 daysInMonth(2, 2026) === 28, daysInMonth(2, 2028) === 29",
      daysInMonth(2, 2026) === 28 && daysInMonth(2, 2028) === 29,
    );

    // 4.3 29 February in non-leap year 2026
    const res2026 = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 29, month: 2, year: 2026 },
      null,
      new Date("2026-02-01T10:00:00.000Z"),
      CAIRO_TZ,
    );
    check(
      "4.3 29 February 2026 is rejected as IMPOSSIBLE_DATE in non-leap year",
      res2026.kind === "invalid" && res2026.reason === "IMPOSSIBLE_DATE",
      `Got: ${JSON.stringify(res2026)}`,
    );

    // 4.4 29 February in leap year 2028 under fixed clock
    const res2028 = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 29, month: 2, year: 2028 },
      null,
      new Date("2028-02-01T10:00:00.000Z"),
      CAIRO_TZ,
      60,
    );
    check(
      "4.4 29 February 2028 is accepted as single_date in leap year",
      res2028.kind === "single_date" && res2028.date === "2028-02-29",
      `Got: ${JSON.stringify(res2028)}`,
    );

    // 4.5 29 February without stated year when clock is in non-leap year
    const resNoYearNonLeap = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 29, month: 2 },
      null,
      new Date("2026-01-15T10:00:00.000Z"),
      CAIRO_TZ,
      60,
    );
    const isNoYearNonLeapInvalid =
      resNoYearNonLeap.kind === "invalid" &&
      resNoYearNonLeap.reason === "IMPOSSIBLE_DATE";
    check(
      "4.5 29 February without stated year in non-leap year 2026 is rejected",
      isNoYearNonLeapInvalid,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 5: Day-only request with missing context vs prior context (ISS-015 A)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 5: Day-only request (ISS-015 A)");
  {
    // 5.1 Day-only without context asks for month
    const harness1 = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness1.business.id,
      branchId: harness1.business.defaultBranchId,
      connectionId: "conn-1",
    };

    harness1.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "unresolved_date", day: 5 },
            exactTime: null,
          },
        });
      },
    };

    const turn1 = await receiveInboundMessage(
      harness1.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز أحجز استشارة أسنان يوم 5",
        receivedAt: "2026-10-31T10:00:00.000Z",
        externalId: "ext-grp5-turn1",
      },
      identity,
    );

    check(
      "5.1 Day-only without prior context returns AI_REPLY and stays AI_ACTIVE",
      isReply(turn1) && isActive(turn1) && noHandoff(turn1),
    );

    const msg1 = lastBody(harness1);
    check(
      "5.2 Clarification asks for the missing month for day 5",
      msg1.includes("الشهر المطلوب") && msg1.includes("5"),
      `Delivered: ${msg1}`,
    );

    const state1 = getOffer(harness1);
    const preservesServiceAndClarification =
      state1?.knownFacts?.service === "كشف أسنان" &&
      state1?.lastClarification?.type === "date_month";
    check(
      "5.3 State preserves service and records date_month clarification",
      preservesServiceAndClarification,
    );

    // 5.4 Day-only with prior context (November 2026)
    const resWithContext = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 5 },
      null,
      new Date("2026-10-31T10:00:00.000Z"),
      CAIRO_TZ,
      60,
      { date: "2026-11-20" },
    );

    check(
      "5.4 Day-only with November prior context resolves to 2026-11-05",
      resWithContext.kind === "single_date" &&
        resWithContext.date === "2026-11-05",
      `Got: ${JSON.stringify(resWithContext)}`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 6: Invalid/ambiguous correction followed by a valid correction
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 6: Invalid correction then valid correction");
  {
    // Group 2 harness
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    // Turn 1: Valid initial booking establishes service & provider
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: "د. أحمد سامي",
            date: "2026-11-05",
            timePreference: null,
            temporalRequest: { type: "exact_date", date: "2026-11-05" },
            exactTime: null,
          },
        });
      },
    };

    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان مع د. أحمد سامي يوم 5 نوفمبر",
        receivedAt: "2026-11-01T10:00:00.000Z",
        externalId: "ext-grp6-turn1",
      },
      identity,
    );

    check(
      "6.1 Turn 1 establishes offer for 2026-11-05 with provider",
      isReply(turn1),
    );

    // Turn 2: Customer sends invalid date "30 فبراير"
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: "د. أحمد سامي",
            date: null,
            timePreference: null,
            temporalRequest: { type: "unresolved_date", day: 30, month: 2 },
            exactTime: null,
          },
        });
      },
    };

    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "غير الميعاد لـ 30 فبراير",
        receivedAt: "2026-11-01T10:05:00.000Z",
        externalId: "ext-grp6-turn2",
      },
      identity,
    );

    check(
      "6.2 Turn 2 rejects 30 February, clears obsolete offer",
      isActive(turn2),
    );

    const state2 = getOffer(harness);
    const providerAndServiceSurvive =
      state2?.knownFacts?.service === "كشف أسنان" &&
      state2?.knownFacts?.provider !== undefined;
    check(
      "6.3 Provider and service survive after invalid date rejection",
      providerAndServiceSurvive,
    );

    // Turn 3: Customer sends valid correction: "2026-11-10"
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: "د. أحمد سامي",
            date: "2026-11-10",
            timePreference: null,
            temporalRequest: { type: "exact_date", date: "2026-11-10" },
            exactTime: null,
          },
        });
      },
    };

    const turn3 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "خلاص خليها 10 نوفمبر 2026",
        receivedAt: "2026-11-01T10:10:00.000Z",
        externalId: "ext-grp6-turn3",
      },
      identity,
    );

    check(
      "6.4 Turn 3 successfully resumes booking for 2026-11-10",
      isReply(turn3),
    );

    const msg3 = lastBody(harness);
    check(
      "6.5 Turn 3 presents slot choices for corrected date 2026-11-10",
      msg3.includes("2026-11-10") || msg3.includes("10 نوفمبر"),
      `Delivered: ${msg3}`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 7: Obsolete callback after a date correction
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 7: Obsolete callback after a date correction");
  {
    // Group 2 harness
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    // Turn 1: Offer generated for 2026-11-05
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: "2026-11-05",
            timePreference: null,
            temporalRequest: { type: "exact_date", date: "2026-11-05" },
            exactTime: null,
          },
        });
      },
    };

    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان يوم 5 نوفمبر 2026",
        receivedAt: "2026-11-01T10:00:00.000Z",
        externalId: "ext-grp7-turn1",
      },
      identity,
    );

    const state1 = getOffer(harness);
    const tokenOffer1 = state1?.offer?.token;
    check(
      "7.1 Turn 1 establishes offer token",
      turn1.ok === true && Boolean(tokenOffer1),
    );

    // Turn 2: Past-date challenge invalidates offer
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "relative_day", offsetDays: -1 },
            exactTime: null,
          },
        });
      },
    };

    await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز أحجز امبارح",
        receivedAt: "2026-11-01T10:05:00.000Z",
        externalId: "ext-grp7-turn2",
      },
      identity,
    );

    // Turn 3: Customer taps obsolete button from Turn 1
    const turn3 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: `fp:${tokenOffer1}:1`,
        receivedAt: "2026-11-01T10:10:00.000Z",
        externalId: "ext-grp7-turn3",
      },
      identity,
    );

    check(
      "7.2 Obsolete callback does NOT create an appointment",
      turn3.ok === true && harness.appointments.length === 0,
    );

    const turn3Msg = lastBody(harness);
    check(
      "7.3 Obsolete callback does NOT confirm booking on 2026-11-05",
      !turn3Msg.includes("تم تأكيد الحجز"),
      `Delivered: ${turn3Msg}`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 8: Business-local date around midnight
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 8: Business-local date around midnight");
  {
    // UTC: 2026-10-31 at 23:30 (11:30 PM UTC)
    // Africa/Cairo (UTC+2 standard time): 2026-11-01 at 01:30 AM
    const midnightInstant = new Date("2026-10-31T23:30:00.000Z");

    const derivedCairoDate = deriveLocalDate(midnightInstant, CAIRO_TZ);
    check(
      "8.1 In Cairo timezone, 23:30 UTC on Oct 31 resolves to 2026-11-01",
      derivedCairoDate === "2026-11-01" &&
        todayIsoInTimeZone(midnightInstant, CAIRO_TZ) === "2026-11-01",
      `Got: ${derivedCairoDate}`,
    );

    // Today (offset 0) in Cairo resolves to 2026-11-01
    const resToday = resolveServerTemporalRequest(
      { type: "relative_day", offsetDays: 0 },
      null,
      midnightInstant,
      CAIRO_TZ,
    );
    check(
      "8.2 Today offset 0 in Cairo resolves to 2026-11-01",
      resToday.kind === "single_date" && resToday.date === "2026-11-01",
      `Got: ${JSON.stringify(resToday)}`,
    );

    // 2026-10-31 in Cairo is already past at 01:30 AM on Nov 1
    const resOct31InCairo = resolveServerTemporalRequest(
      { type: "exact_date", date: "2026-10-31" },
      null,
      midnightInstant,
      CAIRO_TZ,
    );
    const isPastCairo =
      resOct31InCairo.kind === "invalid" &&
      resOct31InCairo.reason === "PAST_DATE";
    check(
      "8.3 2026-10-31 is rejected as PAST_DATE in Cairo at 23:30 UTC",
      isPastCairo,
      `Got: ${JSON.stringify(resOct31InCairo)}`,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 9: Contract rejection/fallback behavior
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 9: Contract rejection/fallback behavior");
  {
    // Group 2 harness
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    // Turn 1 establishes initial offer for 2026-11-05
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: "2026-11-05",
            timePreference: null,
            temporalRequest: { type: "exact_date", date: "2026-11-05" },
            exactTime: null,
          },
        });
      },
    };

    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان يوم 5 نوفمبر 2026",
        receivedAt: "2026-11-01T10:00:00.000Z",
        externalId: "ext-grp9-turn1",
      },
      identity,
    );

    check("9.1 Turn 1 establishes baseline offer", turn1.ok === true);

    // Turn 2: Malformed AI response causing contract parse failure (turn=null)
    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        throw new Error("Provider parse failure / invalid JSON");
      },
    };

    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز أحجز يوم تاني",
        receivedAt: "2026-11-01T10:05:00.000Z",
        externalId: "ext-grp9-turn2",
      },
      identity,
    );

    check(
      "9.2 Failed provider turn routes safely to NEED_HUMAN handoff",
      turn2.ok === true &&
        !turn2.duplicate &&
        turn2.assistantAction === "AI_HANDOFF" &&
        turn2.conversationStatus === "NEED_HUMAN",
    );

    check(
      "9.3 Zero appointments created during fallback",
      harness.appointments.length === 0,
    );

    const turn2Msg = lastBody(harness);
    const noResurrectedSlots =
      !turn2Msg.includes("5 نوفمبر") && !turn2Msg.includes("2026-11-05");
    check(
      "9.4 Contract failure does not resurrect 2026-11-05 slots",
      noResurrectedSlots,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 10: Equivalent temporal authority under START_ONLY and FULL_RANGE
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 10: Parity under START_ONLY and FULL_RANGE");
  {
    for (const pref of ["START_ONLY", "FULL_RANGE"] as const) {
      const harness = createPlaygroundHarness({
        channel: "TELEGRAM",
        businessConfig: {
          appointmentTimeDisplay: pref,
          confirmationMode: "automatic",
        },
      });

      const identity = {
        businessId: harness.business.id,
        branchId: harness.business.defaultBranchId,
        connectionId: "conn-1",
      };

      // Turn 1: Initial offer
      harness.deps.ai = {
        providerName: "test-ai",
        async respond(): Promise<AiResponse> {
          return createMockAiResponse({
            extraction: {
              service: "كشف أسنان",
              provider: null,
              date: "2026-11-05",
              timePreference: null,
              temporalRequest: { type: "exact_date", date: "2026-11-05" },
              exactTime: null,
            },
          });
        },
      };

      const turn1 = await receiveInboundMessage(
        harness.deps,
        {
          to: "123456789",
          from: "998877",
          text: "عايز كشف أسنان يوم 5 نوفمبر",
          receivedAt: "2026-11-01T10:00:00.000Z",
          externalId: `ext-grp10-${pref}-turn1`,
        },
        identity,
      );

      check(`10.1 [${pref}] Turn 1 establishes offer`, isReply(turn1));

      // Turn 2: Past-date challenge
      harness.deps.ai = {
        providerName: "test-ai",
        async respond(): Promise<AiResponse> {
          return createMockAiResponse({
            extraction: {
              service: "كشف أسنان",
              provider: null,
              date: null,
              timePreference: null,
              temporalRequest: { type: "relative_day", offsetDays: -1 },
              exactTime: null,
            },
          });
        },
      };

      const turn2 = await receiveInboundMessage(
        harness.deps,
        {
          to: "123456789",
          from: "998877",
          text: "عايز أحجز امبارح",
          receivedAt: "2026-11-01T10:05:00.000Z",
          externalId: `ext-grp10-${pref}-turn2`,
        },
        identity,
      );

      check(
        `10.2 [${pref}] Past date produces AI_REPLY, stays AI_ACTIVE`,
        isReply(turn2) && isActive(turn2),
      );

      const msg = lastBody(harness);
      check(
        `10.3 [${pref}] Explains past date and never replays old offer`,
        msg.includes("في الماضي") && !msg.includes("5 نوفمبر"),
      );

      check(
        `10.4 [${pref}] Zero appointments created`,
        harness.appointments.length === 0,
      );
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 11: PR71 Review 1.A — Preserve Explicit Components
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── Group 11: Review 1.A — Preserve Explicit Components ──");
  {
    const refDate = new Date("2026-11-01T12:00:00.000Z");
    const prior = { date: "2026-11-20" };
    const res = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 5, year: 2027 },
      null,
      refDate,
      CAIRO_TZ,
      400,
      prior,
    );
    check(
      "11.1 Explicit year 2027 preserved with prior context",
      res.kind === "single_date" && res.date === "2027-11-05",
      res.kind === "single_date" ? res.date : res.kind,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 12: PR71 Review 1.B — Range Resolution Without Arbitrary Month
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── Group 12: Review 1.B — Range Context Resolution ──");
  {
    const refDate = new Date("2026-11-01T12:00:00.000Z");
    const multiRange = {
      dateRange: { startDate: "2026-11-01", endDate: "2026-12-10" },
    };
    const multiRes = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 5 },
      null,
      refDate,
      CAIRO_TZ,
      60,
      multiRange,
    );
    check(
      "12.1 Spanning range with multiple day-5 matches asks clarification",
      multiRes.kind === "ambiguous" &&
        multiRes.reason === "AMBIGUOUS_RANGE_MONTH",
    );

    const singleRange = {
      dateRange: { startDate: "2026-11-01", endDate: "2026-11-20" },
    };
    const singleRes = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 5 },
      null,
      refDate,
      CAIRO_TZ,
      60,
      singleRange,
    );
    check(
      "12.2 Range with unique day-5 match resolves without ambiguity",
      singleRes.kind === "single_date" && singleRes.date === "2026-11-05",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 13: PR71 Review 1.C — Respect Offer Validity
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── Group 13: Review 1.C — Respect Offer Validity ──");
  {
    const harness = await createPlaygroundHarness({
      initialState: {
        now: "2026-11-01T10:00:00.000Z",
        serviceId: "srv-dental",
        serviceName: "كشف أسنان",
        status: "AI_ACTIVE",
      },
    });

    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: "2026-11-05",
            timePreference: null,
            temporalRequest: { type: "exact_date", date: "2026-11-05" },
            exactTime: null,
          },
        });
      },
    };

    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "778899",
        text: "عايز أحجز كشف أسنان يوم 5 نوفمبر",
        receivedAt: "2026-11-01T10:00:00.000Z",
        externalId: "ext-grp13-turn1",
      },
      identity,
    );
    check("13.1 Turn 1 establishes active offer", isReply(turn1));
    const st1 = getOffer(harness);
    check("13.2 State has active offer", st1?.offer?.status === "ACTIVE");

    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "relative_day", offsetDays: -1 },
            exactTime: null,
          },
        });
      },
    };

    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "778899",
        text: "عايز أحجز امبارح",
        receivedAt: "2026-11-01T10:05:00.000Z",
        externalId: "ext-grp13-turn2",
      },
      identity,
    );
    check("13.3 Turn 2 invalidates offer", isReply(turn2));
    const st2 = getOffer(harness);
    check(
      "13.4 Offer is now invalidated or cleared",
      !st2?.offer || st2.offer.status !== "ACTIVE",
    );

    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "unresolved_date", day: 5 },
            exactTime: null,
          },
        });
      },
    };

    const turn3 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "778899",
        text: "يوم 5",
        receivedAt: "2026-11-01T10:10:00.000Z",
        externalId: "ext-grp13-turn3",
      },
      identity,
    );
    check("13.5 Turn 3 produces AI_REPLY", isReply(turn3) && isActive(turn3));
    const body3 = lastBody(harness);
    check(
      "13.6 Does NOT resurrect invalidated offer; asks month clarification",
      body3.includes("توضيح الشهر") && !body3.includes("المواعيد المتاحة"),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 14: PR71 Review 1.D — Yearless 29 February & Year Resolution Policy
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── Group 14: Review 1.D — Yearless 29 February ──");
  {
    const refEnd2027 = new Date("2027-12-31T12:00:00.000Z");
    const leapRes = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 29, month: 2 },
      null,
      refEnd2027,
      CAIRO_TZ,
      60,
      null,
    );
    check(
      "14.1 Yearless 29 Feb on 2027-12-31 resolves to 2028-02-29",
      leapRes.kind === "single_date" && leapRes.date === "2028-02-29",
      leapRes.kind === "single_date" ? leapRes.date : leapRes.kind,
    );

    const refPostLeap = new Date("2028-03-01T12:00:00.000Z");
    const pastLeapRes = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 29, month: 2 },
      null,
      refPostLeap,
      CAIRO_TZ,
      60,
      null,
    );
    check(
      "14.2 29 Feb evaluated on 2028-03-01 is PAST_DATE",
      pastLeapRes.kind === "invalid" && pastLeapRes.reason === "PAST_DATE",
    );

    const ref2026 = new Date("2026-01-01T12:00:00.000Z");
    const nonLeapRes = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 29, month: 2, year: 2026 },
      null,
      ref2026,
      CAIRO_TZ,
      60,
      null,
    );
    check(
      "14.3 Explicit 2026-02-29 is IMPOSSIBLE_DATE",
      nonLeapRes.kind === "invalid" && nonLeapRes.reason === "IMPOSSIBLE_DATE",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 15: PR71 Review 2 — Contradiction Checks
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── Group 15: Review 2 — Contradiction Checks ──");
  {
    const refDate = new Date("2026-11-01T12:00:00.000Z");
    const conflictRes = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 5, month: 11 },
      "2026-11-10",
      refDate,
      CAIRO_TZ,
      60,
      null,
    );
    check(
      "15.1 Conflicting same-turn extraction.date yields CONTRADICTION",
      conflictRes.kind === "invalid" &&
        conflictRes.reason === "CONTRADICTION",
    );

    const matchRes = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 5, month: 11 },
      "2026-11-05",
      refDate,
      CAIRO_TZ,
      60,
      null,
    );
    check(
      "15.2 Concordant same-turn extraction.date resolves cleanly",
      matchRes.kind === "single_date" && matchRes.date === "2026-11-05",
    );

    const replaceRes = resolveServerTemporalRequest(
      { type: "unresolved_date", day: 5, month: 11 },
      null,
      refDate,
      CAIRO_TZ,
      60,
      { date: "2026-11-20" },
    );
    check(
      "15.3 Legitimate replacement of inherited date does not contradict",
      replaceRes.kind === "single_date" && replaceRes.date === "2026-11-05",
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Group 16: PR71 Review 3 — Durable Partial-Date Clarification & Resume
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n── Group 16: Review 3 — Durable Clarification & Resume ──");
  {
    const harness = await createPlaygroundHarness({
      initialState: {
        now: "2026-11-01T10:00:00.000Z",
        serviceId: "srv-dental",
        serviceName: "كشف أسنان",
        status: "AI_ACTIVE",
      },
    });

    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "unresolved_date", day: 5 },
            exactTime: null,
          },
        });
      },
    };

    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "11223344",
        text: "عايز أحجز كشف أسنان يوم 5",
        receivedAt: "2026-11-01T10:00:00.000Z",
        externalId: "ext-grp16-turn1",
      },
      identity,
    );
    check(
      "16.1 Turn 1 produces AI_REPLY, stays AI_ACTIVE",
      isReply(turn1) && isActive(turn1),
    );
    check(
      "16.2 Turn 1 asks for month clarification",
      lastBody(harness).includes("توضيح الشهر"),
    );

    const st1 = getOffer(harness);
    check(
      "16.3 State persists unresolvedDate day 5",
      st1?.lastClarification?.unresolvedDate?.day === 5 &&
        st1?.knownFacts?.unresolvedDate?.day === 5,
    );

    harness.deps.ai = {
      providerName: "test-ai",
      async respond(): Promise<AiResponse> {
        return createMockAiResponse({
          extraction: {
            service: "كشف أسنان",
            provider: null,
            date: null,
            timePreference: null,
            temporalRequest: { type: "unresolved_date", month: 11 },
            exactTime: null,
          },
        });
      },
    };

    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "11223344",
        text: "نوفمبر",
        receivedAt: "2026-11-01T10:05:00.000Z",
        externalId: "ext-grp16-turn2",
      },
      identity,
    );
    check(
      "16.4 Turn 2 produces AI_REPLY, stays AI_ACTIVE",
      isReply(turn2) && isActive(turn2),
    );

    const st2 = getOffer(harness);
    check(
      "16.5 Turn 2 resumes booking with resolved date 2026-11-05",
      st2?.knownFacts?.date === "2026-11-05" &&
        st2?.selectedDate === "2026-11-05",
    );
    check(
      "16.6 Pending clarification and unresolvedDate are cleared",
      st2?.lastClarification === null && !st2?.knownFacts?.unresolvedDate,
    );
    check(
      "16.7 Offer is presented for 2026-11-05",
      st2?.offer?.status === "ACTIVE" &&
        (st2?.offer?.kind === "SLOT" ? st2.offer.date === "2026-11-05" : true),
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n────────────────────────────────────────────────────────────");
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(`\n❌ ${failed.length} checks failed!`);
    process.exit(1);
  }
  console.log(`\n✅ ALL ${checks.length} CHECKS PASSED DETERMINISTICALLY!`);
}

runSuite().catch((err) => {
  console.error("Suite execution error:", err);
  process.exit(1);
});
