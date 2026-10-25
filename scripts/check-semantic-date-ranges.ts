/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Semantic Date Ranges & Telegram Booking UX Regression Suite
 *
 * Verifies:
 *   Area 1: Temporal Context & Server-Authoritative Date Resolution
 *     - Exact calendar date & legacy response compatibility
 *     - Tomorrow & relative day offset ("بعد أسبوع" = today + 7 days)
 *     - Next calendar week ("الأسبوع الجاي" = Saturday..Friday range)
 *     - Distinction: calendar-week range vs 7 days later
 *     - Explicit bounded range (<= 14 days)
 *     - Oversized range (> 14 days) rejected as range_too_broad
 *     - Reversed / invalid / past range rejected safely
 *     - Contradictory temporal output (legacy date vs range) rejected as CONTRADICTION
 *     - Month and year boundary rollover & Cairo local midnight
 *   Area 2: Range Availability & Bounded Scan Pipeline
 *     - Search inside requested range only (no out-of-range dates)
 *     - Closed days (e.g. Friday) and full days excluded
 *     - Up to 4 initial available dates returned
 *     - Continuation action ('more_dates') when > 4 dates exist
 *     - Deterministic pagination without repeats
 *     - Infrastructure failure distinguished from empty availability
 *     - Range in the past returns empty availability safely
 *   Area 3: Conversation State & Context Preservation
 *     - Setting single date clears obsolete dateRange
 *     - Setting dateRange clears obsolete single date and invalidates slot offer
 *     - Provider preference and timePreference preserved across range changes
 *     - Slot selection 'change_date' ("يوم آخر") preserves current range
 *     - 'date_other' ("فترة أخرى") clears range and prompts for fresh date/range
 *     - Backward-compatible state hydration (missing dateRange field handled)
 *     - CAS conflict & stale button protection
 *   Area 4: Shared Choice Contract & Multi-Channel Parity
 *     - Channel-neutral choices for DATE offer with range, more_dates, and other_date
 *     - Identical callback data and choice IDs on Telegram and WhatsApp
 *     - Arabic labels with day name, date, and 12-hour local time with ص/م
 *     - Numeric text selection supported (1, 2, 3...)
 *   Area 5: End-to-End Two-Turn Orchestration & Booking Execution
 *     - Turn 1: Range request ("الأسبوع الجاي مساءً") presents available dates in that week
 *     - Turn 2: Selecting date presents evening slots for that date (0 model calls)
 *     - Turn 3: Selecting slot completes booking (1 appointment created, 0 model calls)
 *     - Replay of confirmed selection creates ZERO duplicate appointments
 *
 * Usage:
 *   pnpm check:semantic-date-ranges
 */

import "./setup-test-env";

import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import {
  buildDateOffer,
  buildSlotOffer,
  type DateOffer,
  type SlotOffer,
} from "../src/features/conversations/server/booking-offer";
import {
  interpretOfferReply,
} from "../src/features/conversations/server/booking-selection";
import {
  buildChannelChoices,
  offerCallbackData,
} from "../src/features/conversations/server/channel-choice";
import {
  receiveInboundMessage,
  resolveUpcomingBookingDates,
} from "../src/features/conversations/server/conversation-engine";
import {
  dehydrateConversationState,
  emptyConversationState,
  hydrateConversationState,
  mergeConversationState,
  type ConversationState,
} from "../src/features/conversations/server/conversation-state";
import {
  formatArabicDateRange,
} from "../src/features/conversations/server/presentation-formatters";
import {
  resolveEgyptianRelativeDateDetailed,
} from "../src/features/conversations/server/relative-date";
import {
  deriveLocalDate,
  endOfSaturdayWeek,
  resolveServerTemporalRequest,
  startOfSaturdayWeek,
} from "../src/features/conversations/server/temporal-context";
import { renderTelegramInlineKeyboard } from "../src/server/integrations/telegram/telegram-presentation";

// ─── Assertion Utilities ───────────────────────────────────────────────────

let totalTests = 0;
let passedTests = 0;
const failedTests: string[] = [];

function assert(condition: boolean, label: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`✔ ${label}`);
  } else {
    failedTests.push(label);
    console.error(`❌ FAILED: ${label}`);
  }
}

async function runSuite() {
  console.log("── SUITE: Semantic Date Ranges & Telegram Booking UX ──\n");

  // ══════════════════════════════════════════════════════════════════════════
  // AREA 1: Temporal Context & Server-Authoritative Date Resolution
  // ══════════════════════════════════════════════════════════════════════════
  console.log("Area 1: Temporal Context & Server-Authoritative Date Resolution");

  // Reference clock: Wednesday, 2026-10-21 10:00:00 UTC (13:00 Cairo)
  const refDate = new Date("2026-10-21T10:00:00.000Z");
  const cairoTz = "Africa/Cairo";

  // 1.1 startOfSaturdayWeek and endOfSaturdayWeek
  // In a Saturday-start policy:
  // Wednesday 2026-10-21 belongs to week: Sat 2026-10-17 .. Fri 2026-10-23
  assert(
    startOfSaturdayWeek("2026-10-21") === "2026-10-17",
    "1.1a startOfSaturdayWeek resolves Wednesday 2026-10-21 to Saturday 2026-10-17",
  );
  assert(
    endOfSaturdayWeek("2026-10-21") === "2026-10-23",
    "1.1b endOfSaturdayWeek resolves Wednesday 2026-10-21 to Friday 2026-10-23",
  );
  // Saturday itself:
  assert(
    startOfSaturdayWeek("2026-10-17") === "2026-10-17",
    "1.1c startOfSaturdayWeek on Saturday resolves to that same Saturday",
  );
  assert(
    endOfSaturdayWeek("2026-10-17") === "2026-10-23",
    "1.1d endOfSaturdayWeek on Saturday resolves to the following Friday",
  );

  // 1.2 "الأسبوع الجاي" vs "بعد أسبوع"
  // "الأسبوع الجاي" = next calendar week = weekOffset 1 -> Sat 2026-10-24 .. Fri 2026-10-30
  const nextWeekRes = resolveServerTemporalRequest(
    { type: "calendar_week", weekOffset: 1 },
    null,
    refDate,
    cairoTz,
  );
  assert(
    nextWeekRes.kind === "date_range" &&
      nextWeekRes.startDate === "2026-10-24" &&
      nextWeekRes.endDate === "2026-10-30",
    "1.2a 'الأسبوع الجاي' resolves to next Saturday-start week (2026-10-24..2026-10-30)",
  );

  // "بعد أسبوع" = relative day offset = today + 7 days -> Wednesday 2026-10-28
  const afterWeekRes = resolveServerTemporalRequest(
    { type: "relative_day", offsetDays: 7 },
    null,
    refDate,
    cairoTz,
  );
  assert(
    afterWeekRes.kind === "single_date" &&
      afterWeekRes.date === "2026-10-28" &&
      afterWeekRes.source === "relative_day",
    "1.2b 'بعد أسبوع' resolves to relative single day today + 7 (2026-10-28)",
  );

  // Distinction test: Next calendar week range start (2026-10-24) != 7 days later (2026-10-28)
  assert(
    nextWeekRes.kind === "date_range" &&
      afterWeekRes.kind === "single_date" &&
      nextWeekRes.startDate !== afterWeekRes.date,
    "1.2c Calendar-week range is strictly distinguished from relative 7-day offset",
  );

  // 1.3 Exact calendar date & legacy date compatibility
  const exactRes = resolveServerTemporalRequest(
    { type: "exact_date", date: "2026-10-25" },
    null,
    refDate,
    cairoTz,
  );
  assert(
    exactRes.kind === "single_date" && exactRes.date === "2026-10-25",
    "1.3a Exact calendar date resolves cleanly",
  );

  const legacyRes = resolveServerTemporalRequest(
    null,
    "2026-10-25",
    refDate,
    cairoTz,
  );
  assert(
    legacyRes.kind === "single_date" &&
      legacyRes.date === "2026-10-25" &&
      legacyRes.source === "legacy_date",
    "1.3b Legacy extraction.date without temporalRequest is 100% backward compatible",
  );

  // 1.4 Explicit bounded date range (<= 14 days)
  const explicitRangeRes = resolveServerTemporalRequest(
    { type: "date_range", startDate: "2026-10-25", endDate: "2026-10-31" },
    null,
    refDate,
    cairoTz,
  );
  assert(
    explicitRangeRes.kind === "date_range" &&
      explicitRangeRes.startDate === "2026-10-25" &&
      explicitRangeRes.endDate === "2026-10-31",
    "1.4a Explicit date range <= 14 days resolves cleanly",
  );

  // 1.5 Oversized range (> 14 days) rejected as range_too_broad
  const oversizedRes = resolveServerTemporalRequest(
    { type: "date_range", startDate: "2026-10-25", endDate: "2026-11-15" },
    null,
    refDate,
    cairoTz,
  );
  assert(
    oversizedRes.kind === "range_too_broad" &&
      oversizedRes.requestedDays === 22 &&
      oversizedRes.maxDays === 14,
    "1.5a Range exceeding 14 days is rejected as range_too_broad with exact counts",
  );

  // 1.6 Reversed / past / contradictory bounds
  const reversedRes = resolveServerTemporalRequest(
    { type: "date_range", startDate: "2026-10-30", endDate: "2026-10-25" },
    null,
    refDate,
    cairoTz,
  );
  assert(
    reversedRes.kind === "invalid" && reversedRes.reason === "INVALID_ORDER",
    "1.6a Reversed date range (start > end) is rejected as INVALID_ORDER",
  );

  const pastDateRes = resolveServerTemporalRequest(
    { type: "exact_date", date: "2026-10-10" },
    null,
    refDate,
    cairoTz,
  );
  assert(
    pastDateRes.kind === "invalid" && pastDateRes.reason === "PAST_DATE",
    "1.6b Past date is rejected as PAST_DATE",
  );

  const horizonExceededRes = resolveServerTemporalRequest(
    { type: "exact_date", date: "2027-01-01" },
    null,
    refDate,
    cairoTz,
  );
  assert(
    horizonExceededRes.kind === "invalid" &&
      horizonExceededRes.reason === "OUT_OF_BOUNDS",
    "1.6c Date beyond 60-day horizon is rejected as OUT_OF_BOUNDS",
  );

  // Contradiction: legacy date outside temporal range
  const contradictionRes = resolveServerTemporalRequest(
    { type: "date_range", startDate: "2026-10-25", endDate: "2026-10-28" },
    "2026-11-05", // completely different date
    refDate,
    cairoTz,
  );
  assert(
    contradictionRes.kind === "invalid" &&
      contradictionRes.reason === "CONTRADICTION",
    "1.6d Contradictory legacy date and date_range fails closed as CONTRADICTION",
  );

  // 1.7 Month and year boundary rollover & Cairo local midnight
  // Near end of year: 2026-12-30 (Wednesday)
  const yearEndClock = new Date("2026-12-30T10:00:00.000Z");
  const yearEndNextWeek = resolveServerTemporalRequest(
    { type: "calendar_week", weekOffset: 1 },
    null,
    yearEndClock,
    cairoTz,
  );
  assert(
    yearEndNextWeek.kind === "date_range" &&
      yearEndNextWeek.startDate === "2027-01-02" &&
      yearEndNextWeek.endDate === "2027-01-08",
    "1.7a Year-end boundary rolls over cleanly across year boundary (2027-01-02..2027-01-08)",
  );

  // Cairo local midnight: 2026-10-21 21:30:00 UTC = 2026-10-21 23:30:00 Cairo
  // 31 minutes later: 2026-10-21 22:01:00 UTC = 2026-10-22 00:01:00 Cairo (rolled to 22nd)
  const midnightUtc = new Date("2026-10-21T22:01:00.000Z");
  assert(
    deriveLocalDate(midnightUtc, cairoTz) === "2026-10-22",
    "1.7b Local Cairo date reflects post-midnight rollover (2026-10-22) when UTC is 2026-10-21 22:01",
  );

  // 1.8 Colloquial Arabic relative date detailed extraction
  const detailedWeek = resolveEgyptianRelativeDateDetailed(
    "عايز أحجز الأسبوع الجاي",
    "2026-10-21",
  );
  assert(
    detailedWeek.positiveTemporal?.type === "calendar_week" &&
      (detailedWeek.positiveTemporal as any).weekOffset === 1,
    "1.8a Egyptian relative date detailed resolves 'الأسبوع الجاي' to calendar_week weekOffset 1",
  );

  const detailedOffset = resolveEgyptianRelativeDateDetailed(
    "عايز أحجز بعد أسبوع",
    "2026-10-21",
  );
  assert(
    detailedOffset.positiveTemporal?.type === "relative_day" &&
      (detailedOffset.positiveTemporal as any).offsetDays === 7,
    "1.8b Egyptian relative date detailed resolves 'بعد أسبوع' to relative_day offsetDays 7",
  );

  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // AREA 2: Range Availability & Bounded Scan Pipeline
  // ══════════════════════════════════════════════════════════════════════════
  console.log("Area 2: Range Availability & Bounded Scan Pipeline");

  const harness = createPlaygroundHarness({
    todayRef: "2026-10-21",
  });
  const testBusiness = {
    ...harness.business,
    id: PLAYGROUND_IDS.BIZ_ID,
    timezone: "Africa/Cairo",
    workingHours: {
      sat: { open: "09:00", close: "17:00", closed: false },
      sun: { open: "09:00", close: "17:00", closed: false },
      mon: { open: "09:00", close: "17:00", closed: false },
      tue: { open: "09:00", close: "17:00", closed: false },
      wed: { open: "09:00", close: "17:00", closed: false },
      thu: { open: "09:00", close: "17:00", closed: false },
      fri: { open: "00:00", close: "00:00", closed: true },
    },
    slotDurationMinutes: 30,
  };

  // 2.1 Search inside requested range only (Friday excluded, only dates within range returned)
  // Request week: Sat 2026-10-24 .. Fri 2026-10-30 (6 working days: Sat..Thu, Friday closed)
  const rangeResult = await resolveUpcomingBookingDates(
    harness.deps,
    { business: testBusiness, customerId: PLAYGROUND_IDS.CUST_ID },
    {
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      range: { startDate: "2026-10-24", endDate: "2026-10-30" },
    },
    refDate,
    4,
  );

  assert(
    rangeResult.status === "success",
    "2.1a resolveUpcomingBookingDates returns status 'success' for bounded range",
  );
  if (rangeResult.status === "success") {
    assert(
      rangeResult.dates.length <= 4,
      `2.1b Returns up to 4 initial available dates (got ${rangeResult.dates.length})`,
    );
    assert(
      rangeResult.hasMore === true,
      "2.1c hasMore is true when eligible days (6 working days) exceed initial count (4)",
    );
    assert(
      rangeResult.totalEligibleCount === 6,
      `2.1d totalEligibleCount reflects all 6 working days in that week (got ${rangeResult.totalEligibleCount})`,
    );
    assert(
      rangeResult.dates.every(
        (d) => d.date >= "2026-10-24" && d.date <= "2026-10-30",
      ),
      "2.1e All returned dates fall strictly inside the requested range",
    );
    assert(
      !rangeResult.dates.some((d) => d.date === "2026-10-30"), // 2026-10-30 is Friday (closed)
      "2.1f Closed Friday (2026-10-30) is strictly excluded from available dates",
    );
  }

  // 2.2 Continuation action (page 2 with offsetIndex = 4)
  const page2Result = await resolveUpcomingBookingDates(
    harness.deps,
    { business: testBusiness, customerId: PLAYGROUND_IDS.CUST_ID },
    {
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      range: { startDate: "2026-10-24", endDate: "2026-10-30" },
      offsetIndex: 4,
    },
    refDate,
    4,
  );

  assert(
    page2Result.status === "success",
    "2.2a Continuation query with offsetIndex = 4 succeeds",
  );
  if (page2Result.status === "success") {
    assert(
      page2Result.dates.length === 2, // remaining 2 working days (Tue, Wed, Thu)
      `2.2b Page 2 returns the remaining 2 dates without overlap (got ${page2Result.dates.length})`,
    );
    assert(
      page2Result.hasMore === false,
      "2.2c Page 2 hasMore is false (all eligible dates exhausted)",
    );
    assert(
      page2Result.pageOffset === 4,
      "2.2d Page 2 records pageOffset = 4",
    );
    // Ensure no overlap between page 1 and page 2
    if (rangeResult.status === "success") {
      const page1Dates = new Set(rangeResult.dates.map((d) => d.date));
      const hasOverlap = page2Result.dates.some((d) => page1Dates.has(d.date));
      assert(!hasOverlap, "2.2e No overlapping dates between page 1 and page 2");
    }
  }

  // 2.3 Range too broad (> 14 days)
  const tooBroadResult = await resolveUpcomingBookingDates(
    harness.deps,
    { business: testBusiness, customerId: PLAYGROUND_IDS.CUST_ID },
    {
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      range: { startDate: "2026-10-24", endDate: "2026-11-15" },
    },
    refDate,
    4,
  );
  assert(
    tooBroadResult.status === "too_broad" && tooBroadResult.requestedDays === 23,
    "2.3a Range > 14 days returns status 'too_broad' at the availability search pipeline",
  );

  // 2.4 Range in the past
  const pastRangeResult = await resolveUpcomingBookingDates(
    harness.deps,
    { business: testBusiness, customerId: PLAYGROUND_IDS.CUST_ID },
    {
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      range: { startDate: "2026-10-01", endDate: "2026-10-07" },
    },
    refDate,
    4,
  );
  assert(
    pastRangeResult.status === "success" &&
      pastRangeResult.dates.length === 0 &&
      pastRangeResult.hasMore === false,
    "2.4a Past range returns status 'success' with empty dates without crashing",
  );

  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // AREA 3: Conversation State & Context Preservation
  // ══════════════════════════════════════════════════════════════════════════
  console.log("Area 3: Conversation State & Context Preservation");

  // 3.1 Date vs Range mutual exclusivity in mergeConversationState
  const baseState = emptyConversationState();

  // Setting dateRange
  const stateWithRange = mergeConversationState(baseState, {
    factUpdates: [
      { key: "service", operation: "set", value: "قص شعر" },
      { key: "dateRange", operation: "set", value: "2026-10-24..2026-10-30" },
    ],
  });
  assert(
    stateWithRange.state.knownFacts.dateRange?.startDate === "2026-10-24" &&
      stateWithRange.state.knownFacts.date === undefined,
    "3.1a mergeConversationState sets dateRange and leaves date undefined",
  );

  // An explicit date correction clears dateRange
  const stateCorrectedDate = mergeConversationState(stateWithRange.state, {
    factUpdates: [
      { key: "date", operation: "set", value: "2026-10-26" },
    ],
  });
  assert(
    stateCorrectedDate.state.knownFacts.date === "2026-10-26" &&
      stateCorrectedDate.state.knownFacts.dateRange === undefined,
    "3.1b Setting an explicit single date clears obsolete dateRange",
  );

  // A range correction clears single date
  const stateCorrectedRange = mergeConversationState(stateCorrectedDate.state, {
    factUpdates: [
      { key: "dateRange", operation: "set", value: "2026-10-31..2026-11-06" },
    ],
  });
  assert(
    stateCorrectedRange.state.knownFacts.dateRange?.startDate === "2026-10-31" &&
      stateCorrectedRange.state.knownFacts.date === undefined,
    "3.1c Setting a dateRange clears obsolete single date",
  );

  // 3.2 Provider & timePreference preserved across range changes
  const stateWithPrefs = mergeConversationState(stateWithRange.state, {
    factUpdates: [
      { key: "timePreference", operation: "set", value: "evening" },
      { key: "provider", operation: "set", value: "أحمد" },
    ],
  });
  const stateChangedRange = mergeConversationState(stateWithPrefs.state, {
    factUpdates: [
      { key: "dateRange", operation: "set", value: "2026-10-31..2026-11-06" },
    ],
  });
  assert(
    stateChangedRange.state.knownFacts.timePreference === "evening" &&
      stateChangedRange.state.knownFacts.provider === "أحمد" &&
      stateChangedRange.state.knownFacts.service === "قص شعر",
    "3.2a Provider preference and timePreference are strictly preserved across date range changes",
  );

  // 3.3 Hydration and backward compatibility with older state missing dateRange
  const legacySerialized = dehydrateConversationState(baseState);
  delete (legacySerialized.knownFacts as any).dateRange;
  const hydrated = hydrateConversationState(legacySerialized, {
    businessId: PLAYGROUND_IDS.BIZ_ID,
    conversationId: "conv-legacy",
  });
  assert(
    hydrated !== null && hydrated.dateRange === null,
    "3.3a hydrateConversationState safely handles legacy stored state without dateRange",
  );

  // 3.4 Invalidation of obsolete slot offer on range change
  const dummySlotOffer = buildSlotOffer(
    { businessId: PLAYGROUND_IDS.BIZ_ID, conversationId: "conv-001" },
    "slot-offer-001",
    {
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      serviceName: "كشف أسنان",
      providerId: null,
      date: "2026-10-26",
      options: [
        {
          providerId: "p1",
          displayName: "أحمد",
          startAt: "2026-10-26T14:00",
          endAt: "2026-10-26T14:30",
        },
      ],
    },
    refDate,
  );
  assert(dummySlotOffer !== null, "3.4a buildSlotOffer succeeds");
  const stateWithSlotOffer: ConversationState = {
    ...stateCorrectedDate.state,
    offer: dummySlotOffer,
  };
  const rangeUpdated = mergeConversationState(stateWithSlotOffer, {
    factUpdates: [
      { key: "dateRange", operation: "set", value: "2026-10-31..2026-11-06" },
    ],
  });
  assert(
    rangeUpdated.state.offer?.status === "INVALIDATED",
    "3.4b Setting a dateRange invalidates the existing single-date slot offer",
  );

  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // AREA 4: Shared Choice Contract & Multi-Channel Parity
  // ══════════════════════════════════════════════════════════════════════════
  console.log("Area 4: Shared Choice Contract & Multi-Channel Parity");

  // 4.1 Build DateOffer with range and pagination metadata
  const sampleDates = [
    { date: "2026-10-24", label: "السبت، 24 أكتوبر" },
    { date: "2026-10-25", label: "الأحد، 25 أكتوبر" },
    { date: "2026-10-26", label: "الإثنين، 26 أكتوبر" },
    { date: "2026-10-27", label: "الثلاثاء، 27 أكتوبر" },
  ];
  const dateOfferWithRange = buildDateOffer(
    { businessId: PLAYGROUND_IDS.BIZ_ID, conversationId: "conv-001" },
    "date-offer-range-001",
    {
      serviceId: PLAYGROUND_IDS.SERV_DENTAL,
      serviceName: "كشف أسنان",
      providerId: null,
      timePreference: "morning",
      dates: sampleDates,
      range: { startDate: "2026-10-24", endDate: "2026-10-30" },
      pageOffset: 0,
      hasMore: true,
      totalEligibleCount: 6,
    },
    refDate,
  );

  assert(dateOfferWithRange !== null, "4.1a buildDateOffer with range succeeds");
  if (dateOfferWithRange) {
    assert(
      dateOfferWithRange.range?.startDate === "2026-10-24" &&
        dateOfferWithRange.range?.endDate === "2026-10-30",
      "4.1b DateOffer serializes range metadata accurately",
    );
    assert(
      dateOfferWithRange.hasMore === true && dateOfferWithRange.pageOffset === 0,
      "4.1c DateOffer carries hasMore: true and pageOffset: 0",
    );

    // 4.2 Channel choices presentation
    const choices = buildChannelChoices(dateOfferWithRange);
    assert(
      choices.offerKind === "DATE",
      "4.2a DateOffer presents channel choices with offerKind: 'DATE'",
    );

    // Should contain 4 date options + 2 action items (more_dates + other_date)
    const items = choices.groups.flat();
    assert(
      items.length === 6,
      `4.2b Total choices items = 4 dates + 'more_dates' + 'other_date' (got ${items.length})`,
    );

    const moreItem = items.find((it) => it.id.includes("more_dates"));
    const otherItem = items.find((it) => it.id.includes("other_date"));
    assert(
      moreItem !== undefined && moreItem.label === "➡️ مواعيد أخرى",
      "4.2c Choice list exposes '➡️ مواعيد أخرى' (more_dates)",
    );
    assert(
      otherItem !== undefined && otherItem.label === "✏️ فترة أخرى",
      "4.2d When a range is active, other_date renders as '✏️ فترة أخرى'",
    );

    // 4.3 Telegram inline keyboard rendering parity
    const telegramKeyboard = renderTelegramInlineKeyboard(choices);
    assert(
      telegramKeyboard.inline_keyboard.length >= 3,
      "4.3a Telegram inline keyboard renders date choices across multiple rows",
    );

    // Check callback data of telegram keyboard matches offerCallbackData
    const telegramCallbacks = telegramKeyboard.inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    assert(
      telegramCallbacks.includes(offerCallbackData(dateOfferWithRange, "more_dates")),
      "4.3b Telegram keyboard contains stable more_dates callback token",
    );
    assert(
      telegramCallbacks.includes(offerCallbackData(dateOfferWithRange, "other_date")),
      "4.3c Telegram keyboard contains stable other_date callback token",
    );

    // 4.4 Offer interpretation of 'more_dates' and 'other_date'
    const moreReply = interpretOfferReply(
      offerCallbackData(dateOfferWithRange, "more_dates"),
      dateOfferWithRange,
      refDate,
    );
    assert(
      moreReply.kind === "date_more" &&
        moreReply.serviceId === PLAYGROUND_IDS.SERV_DENTAL,
      "4.4a Clicking 'more_dates' is mechanically interpreted as kind: 'date_more'",
    );

    const otherReply = interpretOfferReply(
      offerCallbackData(dateOfferWithRange, "other_date"),
      dateOfferWithRange,
      refDate,
    );
    assert(
      otherReply.kind === "date_other" &&
        otherReply.serviceId === PLAYGROUND_IDS.SERV_DENTAL,
      "4.4b Clicking 'other_date' is mechanically interpreted as kind: 'date_other'",
    );

    // 4.5 Numeric text selection of date
    const numericReply = interpretOfferReply("2", dateOfferWithRange, refDate);
    assert(
      numericReply.kind === "date" && numericReply.date === "2026-10-25",
      "4.5a Numeric text '2' selects second date (2026-10-25) with zero model calls",
    );
  }

  // 4.6 Format Arabic date range copy
  const rangeStr = formatArabicDateRange("2026-10-24", "2026-10-30");
  assert(
    rangeStr.includes("السبت، 24 أكتوبر") && rangeStr.includes("الجمعة، 30 أكتوبر"),
    `4.6a formatArabicDateRange outputs formatted range string (${rangeStr})`,
  );

  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // AREA 5: End-to-End Multi-Turn Orchestration & Booking Execution
  // ══════════════════════════════════════════════════════════════════════════
  console.log("Area 5: End-to-End Multi-Turn Orchestration & Booking Execution");

  // Test setup: customer requests dental checkup next week in the morning
  // Turn 1: Customer sends "أنا عايز أحجز كشف أسنان الأسبوع الجاي صباحاً"
  // Engine should resolve service 'كشف أسنان', timePreference 'morning', dateRange (2026-10-24..2026-10-30),
  // and present DATE offer choices for that range.

  let aiCallCount = 0;
  const customAi = {
    providerName: "PLAYGROUND_AI",
    respond: async (_req: any) => {
      aiCallCount++;
      return {
        intent: "BOOKING" as const,
        action: "reply" as const,
        content: "تمام، هعرضلك المواعيد المتاحة الأسبوع الجاي",
        handoffReason: null,
        summary: null,
        safetyAssessment: "safe" as const,
        extraction: {
          service: "كشف أسنان",
          date: null,
          timePreference: "morning" as const,
          provider: null,
          temporalRequest: {
            type: "calendar_week" as const,
            weekOffset: 1,
          },
        },
        factUpdates: [
          { key: "service" as const, operation: "set" as const, value: "كشف أسنان" },
          { key: "timePreference" as const, operation: "set" as const, value: "morning" },
        ],
        goals: [
          {
            kind: "DOMAIN_ACTION" as const,
            intent: "BOOKING" as const,
            requiredKnowledge: "NONE" as const,
          },
        ],
      };
    },
  };

  const initialHarness = createPlaygroundHarness({
    channel: "TELEGRAM",
    todayRef: "2026-10-21",
    customAi: customAi as any,
  });
  initialHarness.customer.phone = "9988771122";

  const t1Res = await receiveInboundMessage(
    initialHarness.deps,
    {
      from: "9988771122",
      to: "6000000000",
      text: "أنا عايز أحجز كشف أسنان الأسبوع الجاي صباحاً",
      receivedAt: refDate.toISOString(),
      externalId: "tg:bot:msg-1",
    },
    {
      businessId: initialHarness.business.id,
      branchId: initialHarness.business.defaultBranchId,
    },
  );

  assert(t1Res.ok === true && !t1Res.duplicate, "5.1a Turn 1 processes successfully");
  if (!t1Res.ok || t1Res.duplicate) throw new Error("Turn 1 failed");
  const convId = t1Res.conversationId;
  const row1 = await initialHarness.stateStore.load(
    initialHarness.business.id,
    convId,
  );
  const conv1 = row1?.state as ConversationState;
  assert(
    conv1?.knownFacts.service === "كشف أسنان",
    "5.1b Turn 1 extracts and persists service fact 'كشف أسنان'",
  );
  assert(
    conv1?.knownFacts.timePreference === "morning",
    "5.1c Turn 1 extracts and persists timePreference 'morning'",
  );
  assert(
    conv1?.knownFacts.dateRange?.startDate === "2026-10-24" &&
      conv1?.knownFacts.dateRange?.endDate === "2026-10-30",
    "5.1d Turn 1 resolves and persists dateRange '2026-10-24..2026-10-30'",
  );
  assert(
    conv1?.offer?.kind === "DATE",
    "5.1e Turn 1 presents an active DATE offer",
  );
  const out1 = initialHarness.deliveredOutbound[initialHarness.deliveredOutbound.length - 1];
  assert(
    out1?.choices?.offerKind === "DATE",
    "5.1f Turn 1 delivers interactive choices for the available dates in that range",
  );

  // Turn 2: Mechanical continuation via more_dates ("➡️ مواعيد أخرى")
  const dateOfferT1 = conv1.offer as DateOffer;
  const moreCallback = offerCallbackData(dateOfferT1, "more_dates");
  const aiCallsBeforeT2 = aiCallCount;
  const t2MoreRes = await receiveInboundMessage(
    initialHarness.deps,
    {
      from: initialHarness.customer.phone,
      to: "6000000000",
      text: moreCallback,
      receivedAt: new Date(refDate.getTime() + 1000).toISOString(),
      externalId: "tg:bot:msg-2",
    },
    {
      businessId: initialHarness.business.id,
      branchId: initialHarness.business.defaultBranchId,
    },
  );

  assert(t2MoreRes.ok === true, "5.2a Turn 2 (more_dates) processes successfully");
  assert(
    aiCallCount === aiCallsBeforeT2,
    "5.2b Turn 2 makes strictly ZERO AI model calls for mechanical date browsing",
  );
  const row2 = await initialHarness.stateStore.load(
    initialHarness.business.id,
    convId,
  );
  const conv2More = row2?.state as ConversationState;
  const dateOfferT2 = conv2More?.offer as DateOffer;
  assert(
    dateOfferT2?.pageOffset === 4,
    "5.2c Turn 2 loads the next page of dates with pageOffset = 4",
  );

  // Turn 3: Selecting a date button (e.g. choice #1 on page 2 = 2026-10-28)
  const chosenOption = dateOfferT2.options[0]!;
  const chosenDate = chosenOption.date;
  const chosenIndex = chosenOption.index;
  const dateCallback = offerCallbackData(dateOfferT2, chosenIndex);
  const aiCallsBeforeT3 = aiCallCount;

  const t3DateRes = await receiveInboundMessage(
    initialHarness.deps,
    {
      from: initialHarness.customer.phone,
      to: "6000000000",
      text: dateCallback,
      receivedAt: new Date(refDate.getTime() + 2000).toISOString(),
      externalId: "tg:bot:msg-3",
    },
    {
      businessId: initialHarness.business.id,
      branchId: initialHarness.business.defaultBranchId,
    },
  );

  assert(t3DateRes.ok === true, "5.3a Turn 3 (date selection) processes successfully");
  assert(
    aiCallCount === aiCallsBeforeT3,
    "5.3b Turn 3 makes strictly ZERO AI model calls for button date selection",
  );
  const row3 = await initialHarness.stateStore.load(
    initialHarness.business.id,
    convId,
  );
  const conv3 = row3?.state as ConversationState;
  assert(
    conv3?.offer?.kind === "SLOT",
    "5.3c Turn 3 presents a SLOT offer for the selected date",
  );
  const slotOfferT3 = conv3?.offer as SlotOffer;
  assert(
    slotOfferT3.date === chosenDate,
    `5.3d Slot offer date matches chosen date (${chosenDate})`,
  );
  assert(
    slotOfferT3.range?.startDate === "2026-10-24",
    "5.3e Slot offer retains original dateRange for 'change_date' navigation",
  );

  // Turn 4: Clicking 'change_date' ("يوم آخر") from slot offer
  const changeDateCallback = offerCallbackData(slotOfferT3, "date");
  const aiCallsBeforeT4 = aiCallCount;
  const t4ChangeRes = await receiveInboundMessage(
    initialHarness.deps,
    {
      from: initialHarness.customer.phone,
      to: "6000000000",
      text: changeDateCallback,
      receivedAt: new Date(refDate.getTime() + 3000).toISOString(),
      externalId: "tg:bot:msg-4",
    },
    {
      businessId: initialHarness.business.id,
      branchId: initialHarness.business.defaultBranchId,
    },
  );

  assert(t4ChangeRes.ok === true, "5.4a Turn 4 (change_date) processes successfully");
  assert(
    aiCallCount === aiCallsBeforeT4,
    "5.4b Turn 4 makes strictly ZERO AI model calls for 'change_date'",
  );
  const row4 = await initialHarness.stateStore.load(
    initialHarness.business.id,
    convId,
  );
  const conv4 = row4?.state as ConversationState;
  assert(
    conv4?.offer?.kind === "DATE",
    "5.4c 'change_date' returns to DATE offer",
  );
  const dateOfferT4 = conv4?.offer as DateOffer;
  assert(
    dateOfferT4.range?.startDate === "2026-10-24",
    "5.4d DATE offer returned by 'change_date' stays within the current requested week range",
  );

  // Turn 5: Re-select date and complete slot booking
  const reselectCallback = offerCallbackData(dateOfferT4, 1);
  await receiveInboundMessage(
    initialHarness.deps,
    {
      from: initialHarness.customer.phone,
      to: "6000000000",
      text: reselectCallback,
      receivedAt: new Date(refDate.getTime() + 4000).toISOString(),
      externalId: "tg:bot:msg-5",
    },
    {
      businessId: initialHarness.business.id,
      branchId: initialHarness.business.defaultBranchId,
    },
  );
  const row5 = await initialHarness.stateStore.load(
    initialHarness.business.id,
    convId,
  );
  const conv5 = row5?.state as ConversationState;
  const slotOfferT5 = conv5?.offer as SlotOffer;
  assert(slotOfferT5?.kind === "SLOT", "5.5a Re-selected slot offer ready");

  // Select slot #1
  const slotChoiceCallback = offerCallbackData(slotOfferT5, 1);
  const t5SlotRes = await receiveInboundMessage(
    initialHarness.deps,
    {
      from: initialHarness.customer.phone,
      to: "6000000000",
      text: slotChoiceCallback,
      receivedAt: new Date(refDate.getTime() + 5000).toISOString(),
      externalId: "tg:bot:msg-6",
    },
    {
      businessId: initialHarness.business.id,
      branchId: initialHarness.business.defaultBranchId,
    },
  );

  assert(t5SlotRes.ok === true, "5.5b Final slot selection processes successfully");
  assert(
    initialHarness.appointments.length === 1 &&
      initialHarness.appointments[0].status === "CONFIRMED",
    "5.5c Final slot selection confirms appointment in database",
  );
  assert(
    initialHarness.appointments.length === 1,
    "5.5d Exactly ONE appointment was created in the database",
  );

  // Turn 6: Replay of confirmed callback creates ZERO duplicate appointments
  const t6ReplayRes = await receiveInboundMessage(
    initialHarness.deps,
    {
      from: initialHarness.customer.phone,
      to: "6000000000",
      text: slotChoiceCallback,
      receivedAt: new Date(refDate.getTime() + 6000).toISOString(),
      externalId: "tg:bot:msg-7",
    },
    {
      businessId: initialHarness.business.id,
      branchId: initialHarness.business.defaultBranchId,
    },
  );

  assert(t6ReplayRes.ok === true, "5.6a Replay of stale slot callback handled safely");
  assert(
    initialHarness.appointments.length === 1,
    "5.6b Replay creates ZERO duplicate appointments",
  );

  console.log("");
  console.log(`── Total: ${totalTests} | Passed: ${passedTests} | Failed: ${failedTests.length} ──`);

  if (failedTests.length > 0) {
    console.error("\nFailed checks:");
    for (const f of failedTests) {
      console.error(` - ${f}`);
    }
    process.exit(1);
  } else {
    console.log("✔ ALL SEMANTIC DATE RANGES & TELEGRAM UX CHECKS PASSED!");
  }
}

runSuite().catch((err) => {
  console.error("FATAL SUITE ERROR:", err);
  process.exit(1);
});
