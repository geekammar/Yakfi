/**
 * CI Verification Suite: Prevent elapsed booking slots from being selectable.
 *
 * Verifies:
 * 1. past / today / future availability filtering
 * 2. Business timezone different from host server timezone
 * 3. Midnight boundary rollover
 * 4. Exact cutoff boundary policy (matching appointment-create-service)
 * 5. Provider branches (provider-specific, any-provider unified, legacy)
 * 6. No remaining times (truthful reason & guidance, not falsely FULLY_BOOKED or «ممتلئ»)
 * 7. Stale selection revalidation & final submission rejection
 *
 * Uses controlled fixtures with an injected reference clock and actual production helpers.
 * Zero real network, provider, or DB calls.
 */

import {
  DAY_CAPACITY_LABELS,
  dayCapacityState,
  isDayUnselectable,
} from "../src/features/appointments/components/smart-create/day-capacity";
import {
  derivePresentSlots,
  deriveSmartSuggestions,
  slotExistsIn,
} from "../src/features/appointments/components/smart-create/slot-helpers";
import { createAppointmentRecord } from "../src/features/appointments/server/appointment-create-service";
import type { AppointmentCreateServiceDeps } from "../src/features/appointments/server/appointment-create-service";
import {
  deriveNoSlotsReason,
  getAvailability,
} from "../src/features/appointments/server/availability-service";
import type {
  AvailabilityActor,
  AvailabilityServiceDeps,
} from "../src/features/appointments/server/availability-service";
import {
  generateCandidateGrid,
  generateCandidateSlots,
  nowTimeInTimeZone,
  todayInTimeZone,
} from "../src/lib/scheduling/slot-grid";
import type { Business, Service } from "../src/types/domain";

type Check = { label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
  const mark = pass ? "✓" : "✗";
  console.log(`${mark} ${label}${details && !pass ? ` (${details})` : ""}`);
}

async function run(): Promise<void> {
  console.log(
    "===============================================================",
  );
  console.log(
    "  FLOWPILOT — PREVENT ELAPSED BOOKING SLOTS VERIFICATION SUITE ",
  );
  console.log(
    "===============================================================\n",
  );

  const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
  const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
  const PROVIDER_1 = "33333333-3333-4333-8333-333333333331";
  const PROVIDER_2 = "33333333-3333-4333-8333-333333333332";
  const USER_1 = "44444444-4444-4444-8444-444444444441";
  const USER_2 = "44444444-4444-4444-8444-444444444442";
  const CUSTOMER_ID = "55555555-5555-4555-8555-555555555555";

  // Business open Sat-Fri 09:00–17:00 with 30-min slot granularity in Asia/Riyadh (UTC+3)
  const riyadhBusiness = {
    id: BUSINESS_ID,
    name: "عيادة الرياض",
    timezone: "Asia/Riyadh",
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    workingHours: {
      sat: { open: "09:00", close: "17:00", closed: false },
      sun: { open: "09:00", close: "17:00", closed: false },
      mon: { open: "09:00", close: "17:00", closed: false },
      tue: { open: "09:00", close: "17:00", closed: false },
      wed: { open: "09:00", close: "17:00", closed: false },
      thu: { open: "09:00", close: "17:00", closed: false },
      fri: { open: "09:00", close: "17:00", closed: true }, // Friday closed
    },
  } as unknown as Business;

  const service30m = {
    id: SERVICE_ID,
    businessId: BUSINESS_ID,
    name: "استشارة عامة",
    durationMinutes: 30,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Service;

  const actor: AvailabilityActor = {
    userId: "staff_actor",
    role: "ADMIN",
    businessId: BUSINESS_ID,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 1: Past / Today / Future with Injected Clock
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("▶ Section 1: Past / Today / Future Availability");

  // Injected clock: 2026-10-27T10:00:00Z -> in Asia/Riyadh (UTC+3) it is 13:00 on 2026-10-27 (Tuesday)
  const refNow = new Date("2026-10-27T10:00:00.000Z");
  const todayInRiyadh = todayInTimeZone(refNow, riyadhBusiness.timezone); // "2026-10-27"
  const currentTimeInRiyadh = nowTimeInTimeZone(
    refNow,
    riyadhBusiness.timezone,
  ); // "13:00"

  check(
    "1.1 Authoritative reference clock resolves today and wall-clock time in Business timezone",
    todayInRiyadh === "2026-10-27" && currentTimeInRiyadh === "13:00",
  );

  const createBaseDeps = (
    nowFn: () => Date = () => refNow,
  ): AvailabilityServiceDeps => ({
    businessRepository: {
      findById: async (id) => (id === BUSINESS_ID ? riyadhBusiness : null),
    },
    serviceRepository: {
      findById: async (id) => (id === SERVICE_ID ? service30m : null),
    },
    appointmentRepository: {
      findById: async () => null,
      listBlockingForDate: async () => [],
    },
    now: nowFn,
  });

  // 1a. Past date query ("2026-10-26" — Monday)
  const pastResult = await getAvailability(createBaseDeps(), actor, {
    serviceId: SERVICE_ID,
    date: "2026-10-26",
  });
  check(
    "1.2 Past date returns zero selectable slots",
    pastResult.success === true && pastResult.data.slots.length === 0,
  );
  check(
    "1.3 Past date returns truthful NO_REMAINING_TIMES reason (not FULLY_BOOKED)",
    pastResult.success === true && pastResult.reason === "NO_REMAINING_TIMES",
  );

  // 1b. Today query ("2026-10-27" at 13:00 in Riyadh)
  // Working hours 09:00–17:00. Candidates step by 30 min.
  // Elapsed: 09:00, 09:30, 10:00, 10:30, 11:00, 11:30, 12:00, 12:30.
  // Non-elapsed: 13:00, 13:30, 14:00, 14:30, 15:00, 15:30, 16:00, 16:30.
  const todayResult = await getAvailability(createBaseDeps(), actor, {
    serviceId: SERVICE_ID,
    date: "2026-10-27",
  });
  check(
    "1.4 Today query filters out all times before current authoritative time (13:00)",
    todayResult.success === true &&
      todayResult.data.slots.length === 8 &&
      todayResult.data.slots[0]?.startTime === "13:00" &&
      todayResult.data.slots.every((s) => s.startTime >= "13:00"),
  );

  // 1c. Future date query ("2026-10-28" — Wednesday)
  const futureResult = await getAvailability(createBaseDeps(), actor, {
    serviceId: SERVICE_ID,
    date: "2026-10-28",
  });
  check(
    "1.5 Future date returns full candidate schedule starting from open (09:00) unaffected by current time",
    futureResult.success === true &&
      futureResult.data.slots.length === 16 &&
      futureResult.data.slots[0]?.startTime === "09:00" &&
      futureResult.data.slots[futureResult.data.slots.length - 1]?.startTime ===
        "16:30",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 2: Business Timezone Different from Host Server Clock
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Section 2: Cross-Timezone Server Clock Scenarios");

  // Host UTC is 2026-10-25T22:30:00Z (Sunday night)
  // In Asia/Riyadh (+3), it is already 2026-10-26T01:30:00 (Monday early morning)
  const crossDateUtc = new Date("2026-10-25T22:30:00.000Z");

  const crossTzResultPast = await getAvailability(
    createBaseDeps(() => crossDateUtc),
    actor,
    {
      serviceId: SERVICE_ID,
      date: "2026-10-25", // Sunday: in UTC it's still today, but in Riyadh it's ALREADY PAST!
    },
  );
  check(
    "2.1 Calendar day that rolled forward in Business timezone is treated as past date (empty slots)",
    crossTzResultPast.success === true &&
      crossTzResultPast.data.slots.length === 0 &&
      crossTzResultPast.reason === "NO_REMAINING_TIMES",
  );

  const crossTzResultToday = await getAvailability(
    createBaseDeps(() => crossDateUtc),
    actor,
    {
      serviceId: SERVICE_ID,
      date: "2026-10-26", // Monday: in Riyadh it is 01:30 today; opens at 09:00
    },
  );
  check(
    "2.2 Active Business day in Riyadh (01:30 AM) retains full 09:00-17:00 schedule for that day",
    crossTzResultToday.success === true &&
      crossTzResultToday.data.slots.length === 16 &&
      crossTzResultToday.data.slots[0]?.startTime === "09:00",
  );

  // Reverse case: New York timezone (UTC-4)
  // Host UTC is 2026-10-26T02:00:00Z (Monday in UTC)
  // In America/New_York (UTC-4), it is 2026-10-25T22:00:00 (Sunday night in NY)
  const nyBusiness: Business = {
    ...riyadhBusiness,
    timezone: "America/New_York",
  };
  const nyDeps: AvailabilityServiceDeps = {
    ...createBaseDeps(() => new Date("2026-10-26T02:00:00.000Z")),
    businessRepository: { findById: async () => nyBusiness },
  };
  const nySundayResult = await getAvailability(nyDeps, actor, {
    serviceId: SERVICE_ID,
    date: "2026-10-25", // Sunday is today in New York (22:00), but working hours (09:00-17:00) elapsed
  });
  check(
    "2.3 New York business: 2026-10-25 is still today at 22:00 NY time, all slots elapsed -> NO_REMAINING_TIMES",
    nySundayResult.success === true &&
      nySundayResult.data.slots.length === 0 &&
      nySundayResult.reason === "NO_REMAINING_TIMES",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 3: Midnight Boundary Rollover
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Section 3: Midnight Boundary Rollover");

  // Instant 1: Exactly 23:59:59 on Tuesday in Riyadh
  const justBeforeMidnightRiyadh = new Date("2026-10-27T20:59:59.000Z"); // 23:59:59 in UTC+3
  const justBeforeResult = await getAvailability(
    createBaseDeps(() => justBeforeMidnightRiyadh),
    actor,
    { serviceId: SERVICE_ID, date: "2026-10-27" },
  );
  check(
    "3.1 At 23:59:59 in Business timezone, all Tuesday daytime slots have elapsed",
    justBeforeResult.success === true &&
      justBeforeResult.data.slots.length === 0 &&
      justBeforeResult.reason === "NO_REMAINING_TIMES",
  );

  // Instant 2: Exactly 00:00:00 on Wednesday in Riyadh
  const midnightRiyadh = new Date("2026-10-27T21:00:00.000Z"); // 00:00:00 on 2026-10-28 in UTC+3
  const midnightResult = await getAvailability(
    createBaseDeps(() => midnightRiyadh),
    actor,
    { serviceId: SERVICE_ID, date: "2026-10-28" },
  );
  check(
    "3.2 At 00:00:00 midnight rollover, new day's slots (>= 00:00) become fully available starting 09:00",
    midnightResult.success === true &&
      midnightResult.data.slots.length === 16 &&
      midnightResult.data.slots[0]?.startTime === "09:00",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 4: Exact Cutoff Boundary Policy (Contract Parity)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(
    "\n▶ Section 4: Exact Cutoff Boundary Parity with appointment-create-service",
  );

  // Reference time: Exactly 10:00 in Riyadh (07:00 UTC)
  const exact1000 = new Date("2026-10-27T07:00:00.000Z"); // 10:00 in Asia/Riyadh
  const exactResult = await getAvailability(
    createBaseDeps(() => exact1000),
    actor,
    {
      serviceId: SERVICE_ID,
      date: "2026-10-27",
    },
  );
  const exactSlots = exactResult.success ? exactResult.data.slots : [];
  const exactSlotTimes = exactSlots.map((s) => s.startTime);

  check(
    "4.1 Slot at 09:30 (< 10:00) is filtered out as elapsed",
    !exactSlotTimes.includes("09:30"),
  );
  check(
    "4.2 Slot at 10:00 (=== 10:00) is preserved as valid (exact boundary matching appointment creation)",
    exactSlotTimes.includes("10:00") && exactSlotTimes[0] === "10:00",
  );
  check(
    "4.3 Slot at 10:30 (> 10:00) is preserved as valid",
    exactSlotTimes.includes("10:30"),
  );

  // Parity verification against appointment-create-service
  const createServiceDeps = {
    customerRepository: {
      findById: async () => ({
        id: CUSTOMER_ID,
        businessId: BUSINESS_ID,
        name: "علي",
        phone: "+966500000000",
      }),
    },
    serviceRepository: { findById: async () => service30m },
    businessRepository: { findById: async () => riyadhBusiness },
    branchRepository: {
      findDefaultByBusiness: async () => ({
        id: "66666666-6666-4666-8666-666666666666",
        businessId: BUSINESS_ID,
      }),
    },
    appointmentRepository: {
      createWithConflictCheck: async (payload: { businessId: string }) => ({
        id: "77777777-7777-4777-8777-777777777777",
        businessId: payload.businessId,
        status: "CONFIRMED",
      }),
    },
    now: () => exact1000,
  } as unknown as Parameters<typeof createAppointmentRecord>[0];

  const createElapsedAttempt = await createAppointmentRecord(
    createServiceDeps,
    { userId: actor.userId, role: actor.role, businessId: BUSINESS_ID },
    {
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      date: "2026-10-27",
      startTime: "09:30", // < 10:00 -> should reject PAST_TIME
      notes: "",
    },
  );
  check(
    "4.4 appointment-create-service rejects 09:30 (< 10:00) with PAST_TIME",
    createElapsedAttempt.success === false &&
      createElapsedAttempt.code === "PAST_TIME",
  );

  const createExactAttempt = await createAppointmentRecord(
    createServiceDeps,
    { userId: actor.userId, role: actor.role, businessId: BUSINESS_ID },
    {
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      date: "2026-10-27",
      startTime: "10:00", // === 10:00 -> should succeed
      notes: "",
    },
  );
  check(
    "4.5 appointment-create-service accepts exact boundary 10:00 (=== 10:00) without PAST_TIME rejection",
    createExactAttempt.success === true,
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 5: Consistent Application across All Provider Branches
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Section 5: Consistency across Provider Branches");

  // Injected clock: 14:00 in Riyadh (11:00 UTC)
  const now1400 = new Date("2026-10-27T11:00:00.000Z");

  // Branch 1: Provider-specific branch
  const providerBranchDeps: AvailabilityServiceDeps = {
    ...createBaseDeps(() => now1400),
    providerRepository: {
      listEligibleForService: async () => [
        { id: PROVIDER_1, name: "د. أحمد", displayName: "د. أحمد" },
      ],
      listAssignmentSeams: async () => [
        { providerId: PROVIDER_1, userId: USER_1 },
      ],
    },
    appointmentRepository: {
      findById: async () => null,
      listBlockingForDate: async () => [],
      listBlockingByAssignees: async () => [
        // Provider 1 has conflict at 15:00
        {
          id: "b1",
          assignedUserId: USER_1,
          startTime: "15:00",
          endTime: "15:30",
        },
      ],
    },
    now: () => now1400,
  };

  const branch1Result = await getAvailability(providerBranchDeps, actor, {
    serviceId: SERVICE_ID,
    date: "2026-10-27",
    providerId: PROVIDER_1,
  });
  const branch1Slots = branch1Result.success ? branch1Result.data.slots : [];
  check(
    "5.1 Provider-specific branch: filters slots < 14:00, filters conflict at 15:00, offers 14:00 & 14:30",
    branch1Result.success === true &&
      !branch1Slots.some((s) => s.startTime < "14:00") &&
      !branch1Slots.some((s) => s.startTime === "15:00") &&
      branch1Slots.some((s) => s.startTime === "14:00") &&
      branch1Slots.some((s) => s.startTime === "14:30"),
  );

  // Branch 2: Unified any-provider branch (PROVIDER_AWARE_BOOKING)
  const unifiedBranchDeps: AvailabilityServiceDeps = {
    ...createBaseDeps(() => now1400),
    providerRepository: {
      listEligibleForService: async () => [
        { id: PROVIDER_1, name: "د. أحمد", displayName: "د. أحمد" },
        { id: PROVIDER_2, name: "د. منى", displayName: "د. منى" },
      ],
      listAssignmentSeams: async () => [
        { providerId: PROVIDER_1, userId: USER_1 },
        { providerId: PROVIDER_2, userId: USER_2 },
      ],
    },
    appointmentRepository: {
      findById: async () => null,
      listBlockingForDate: async () => [],
      listBlockingByAssignees: async () => [
        // P1 blocked at 14:00, P2 free at 14:00
        {
          id: "b1",
          assignedUserId: USER_1,
          startTime: "14:00",
          endTime: "14:30",
        },
        // Both blocked at 14:30
        {
          id: "b2",
          assignedUserId: USER_1,
          startTime: "14:30",
          endTime: "15:00",
        },
        {
          id: "b3",
          assignedUserId: USER_2,
          startTime: "14:30",
          endTime: "15:00",
        },
      ],
    },
    now: () => now1400,
  };

  const branch2Result = await getAvailability(unifiedBranchDeps, actor, {
    serviceId: SERVICE_ID,
    date: "2026-10-27",
  });
  const branch2Slots = branch2Result.success ? branch2Result.data.slots : [];
  const slot1400 = branch2Slots.find((s) => s.startTime === "14:00");
  check(
    "5.2 Unified any-provider branch: filters elapsed slots (< 14:00) and preserves provider attribution",
    branch2Result.success === true &&
      !branch2Slots.some((s) => s.startTime < "14:00") &&
      slot1400?.availableProviderIds?.includes(PROVIDER_2) === true &&
      slot1400?.availableProviderIds?.includes(PROVIDER_1) === false,
  );
  check(
    "5.3 Unified branch: slot blocked for all providers (14:30) is omitted",
    !branch2Slots.some((s) => s.startTime === "14:30"),
  );

  // Branch 3: Legacy branch (without provider repo)
  const legacyBranchDeps: AvailabilityServiceDeps = {
    ...createBaseDeps(() => now1400),
    providerRepository: undefined,
    appointmentRepository: {
      findById: async () => null,
      listBlockingForDate: async () => [
        { startTime: "14:00", endTime: "14:30" },
      ],
    },
    now: () => now1400,
  };
  const branch3Result = await getAvailability(legacyBranchDeps, actor, {
    serviceId: SERVICE_ID,
    date: "2026-10-27",
  });
  const branch3Slots = branch3Result.success ? branch3Result.data.slots : [];
  check(
    "5.4 Legacy branch: filters elapsed slots (< 14:00) and blocking conflict (14:00)",
    branch3Result.success === true &&
      !branch3Slots.some((s) => s.startTime < "14:00") &&
      !branch3Slots.some((s) => s.startTime === "14:00") &&
      branch3Slots[0]?.startTime === "14:30",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 6: No Remaining Times vs Fully Booked Truthfulness
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Section 6: No Remaining Times & Day Capacity Truthfulness");

  // Reference time: 18:00 in Riyadh (working hours 09:00–17:00 have completely elapsed)
  const now1800 = new Date("2026-10-27T15:00:00.000Z"); // 18:00 in Riyadh
  const allElapsedTodayResult = await getAvailability(
    createBaseDeps(() => now1800),
    actor,
    {
      serviceId: SERVICE_ID,
      date: "2026-10-27",
    },
  );
  check(
    "6.1 When all slots for today have elapsed, getAvailability returns reason: NO_REMAINING_TIMES",
    allElapsedTodayResult.success === true &&
      allElapsedTodayResult.data.slots.length === 0 &&
      allElapsedTodayResult.reason === "NO_REMAINING_TIMES",
  );

  // Day capacity derivation
  const elapsedDayCapacity = dayCapacityState(allElapsedTodayResult);
  check(
    "6.2 dayCapacityState returns 'no-remaining' for NO_REMAINING_TIMES (NOT 'full' / «ممتلئ»)",
    elapsedDayCapacity === "no-remaining",
  );
  check(
    "6.3 DAY_CAPACITY_LABELS for 'no-remaining' is «غير متاح» (truthful, never «ممتلئ»)",
    elapsedDayCapacity !== "unknown" &&
      DAY_CAPACITY_LABELS[elapsedDayCapacity] === "غير متاح",
  );
  check(
    "6.4 isDayUnselectable confirms 'no-remaining' day is unselectable",
    isDayUnselectable(elapsedDayCapacity),
  );

  // Genuinely fully booked comparison
  // At 10:00 in Riyadh, remaining slots (10:00–17:00) are ALL blocked by appointments
  const remainingBlockedDeps: AvailabilityServiceDeps = {
    ...createBaseDeps(() => exact1000),
    appointmentRepository: {
      findById: async () => null,
      listBlockingForDate: async () => [
        { startTime: "10:00", endTime: "17:00" },
      ],
    },
    now: () => exact1000,
  };
  const genuineFullResult = await getAvailability(remainingBlockedDeps, actor, {
    serviceId: SERVICE_ID,
    date: "2026-10-27",
  });
  check(
    "6.5 When remaining future times are blocked by appointments, reason is truthfully FULLY_BOOKED",
    genuineFullResult.success === true &&
      genuineFullResult.data.slots.length === 0 &&
      genuineFullResult.reason === "FULLY_BOOKED",
  );
  check(
    "6.6 Genuinely full day produces dayCapacityState 'full' with label «ممتلئ»",
    dayCapacityState(genuineFullResult) === "full" &&
      DAY_CAPACITY_LABELS["full"] === "ممتلئ",
  );

  // Pure deriveNoSlotsReason unit verification
  const candidatesList = generateCandidateSlots({
    openMinutes: 540, // 09:00
    closeMinutes: 1020, // 17:00
    durationMinutes: 30,
    slotDurationMinutes: 30,
  });
  const pureReasonElapsed = deriveNoSlotsReason({
    candidates: candidatesList,
    unblockedCandidates: candidatesList, // unblocked, but all before 18:00
    isPastDate: false,
    isToday: true,
    currentTime: "18:00",
  });
  check(
    "6.7 deriveNoSlotsReason returns NO_REMAINING_TIMES when all candidates elapsed",
    pureReasonElapsed === "NO_REMAINING_TIMES",
  );

  const pureReasonPastDate = deriveNoSlotsReason({
    candidates: candidatesList,
    unblockedCandidates: candidatesList,
    isPastDate: true,
    isToday: false,
    currentTime: "10:00",
  });
  check(
    "6.8 deriveNoSlotsReason returns NO_REMAINING_TIMES on past date",
    pureReasonPastDate === "NO_REMAINING_TIMES",
  );

  const pureReasonFutureFull = deriveNoSlotsReason({
    candidates: candidatesList,
    unblockedCandidates: [],
    isPastDate: false,
    isToday: false,
    currentTime: "10:00",
  });
  check(
    "6.9 deriveNoSlotsReason returns FULLY_BOOKED on future fully booked date",
    pureReasonFutureFull === "FULLY_BOOKED",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 7: Presentation Grid & Smart Suggestions Contracts
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Section 7: Presentation Grid & Smart Suggestions");

  // At 14:00 in Riyadh:
  // Candidate grid covers full day (09:00–17:00)
  const candidateGrid = generateCandidateGrid({
    workingHours: riyadhBusiness.workingHours,
    date: "2026-10-27",
    durationMinutes: 30,
    slotDurationMinutes: 30,
  });
  const presentSlots = derivePresentSlots({
    candidateGrid,
    availableSlots: branch1Slots, // contains 14:00, 14:30, 15:30, 16:00, 16:30
    blockedIntervals: [
      { startTime: "15:00", endTime: "15:30", providerId: PROVIDER_1 },
    ],
    selectedProviderId: PROVIDER_1,
  });

  const slot0900Present = presentSlots?.find((s) => s.startTime === "09:00");
  const slot1400Present = presentSlots?.find((s) => s.startTime === "14:00");
  const slot1500Present = presentSlots?.find((s) => s.startTime === "15:00");

  check(
    "7.1 Candidate grid retains elapsed times (09:00) with available: false (rendered disabled)",
    slot0900Present?.available === false,
  );
  check(
    "7.2 Candidate grid marks genuine bookable times (14:00) with available: true",
    slot1400Present?.available === true,
  );
  check(
    "7.3 Candidate grid marks appointment-conflicted times (15:00) with available: false and blockedByAppointment: true",
    slot1500Present?.available === false &&
      slot1500Present?.blockedByAppointment === true,
  );

  // Smart suggestions: must never suggest elapsed times
  const smartSuggestions = deriveSmartSuggestions({
    slots: branch1Slots,
    eligibleProviders: [{ providerId: PROVIDER_1, displayName: "د. أحمد" }],
    selectedProviderId: PROVIDER_1,
  });
  check(
    "7.4 Smart suggestions only pick from valid future slots (none < 14:00)",
    smartSuggestions.length > 0 &&
      smartSuggestions.every((s) => s.slot.startTime >= "14:00"),
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Section 8: Stale Selection Revalidation & Workflow Invalidation
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Section 8: Stale Selection Revalidation");

  // User selected slot 10:00 at 09:55
  const userSelectedSlot = { startTime: "10:00", endTime: "10:30" };

  // Initial check at 09:55: 10:00 is valid
  const initialAvailability = await getAvailability(
    createBaseDeps(() => new Date("2026-10-27T06:55:00.000Z")), // 09:55 Riyadh
    actor,
    { serviceId: SERVICE_ID, date: "2026-10-27" },
  );
  const initialSlots = initialAvailability.success
    ? initialAvailability.data.slots
    : [];
  check(
    "8.1 At 09:55, slot 10:00 is present in available slots",
    slotExistsIn(userSelectedSlot, initialSlots),
  );

  // Time elapses: operator pauses, clock advances to 10:05
  const freshAvailabilityAfterElapsed = await getAvailability(
    createBaseDeps(() => new Date("2026-10-27T07:05:00.000Z")), // 10:05 Riyadh
    actor,
    { serviceId: SERVICE_ID, date: "2026-10-27" },
  );
  const freshSlots = freshAvailabilityAfterElapsed.success
    ? freshAvailabilityAfterElapsed.data.slots
    : [];

  // slotExistsIn checks stale selection
  const isStillValid = slotExistsIn(userSelectedSlot, freshSlots);
  check(
    "8.2 At 10:05, slotExistsIn reports 10:00 is STALE (not in fresh availability slots)",
    isStillValid === false,
  );

  // Final submission rejection if user attempts to submit anyway
  const lateSubmitDeps: AppointmentCreateServiceDeps = {
    ...createServiceDeps,
    now: () => new Date("2026-10-27T07:05:00.000Z"), // 10:05 Riyadh
  };
  const lateSubmitAttempt = await createAppointmentRecord(
    lateSubmitDeps,
    { userId: actor.userId, role: actor.role, businessId: BUSINESS_ID },
    {
      customerId: CUSTOMER_ID,
      serviceId: SERVICE_ID,
      date: "2026-10-27",
      startTime: "10:00",
      notes: "",
    },
  );
  check(
    "8.3 Final submission guard in createAppointmentRecord rejects stale slot at 10:05 with PAST_TIME",
    lateSubmitAttempt.success === false &&
      lateSubmitAttempt.code === "PAST_TIME",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(
    "\n===============================================================",
  );
  const passedCount = checks.filter((c) => c.pass).length;
  const totalCount = checks.length;
  console.log(`TOTAL CHECKS: ${totalCount}`);
  console.log(`PASSED:       ${passedCount}`);
  console.log(`FAILED:       ${totalCount - passedCount}`);
  console.log(
    "===============================================================",
  );

  if (passedCount !== totalCount) {
    process.exit(1);
  }
}

void run();
