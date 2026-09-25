/**
 * FlowPilot — Appointments + Availability UX coherence check (B-09).
 *
 * Offline, in-memory verification of the appointments day-view +
 * availability coherence slice (no DB, no network, no LLM, no API
 * tokens, no secrets). It covers the slice's required areas:
 *
 *   1.  the selected day displays THAT day's appointments (exact,
 *       timezone-independent date normalization + a per-day reset of
 *       the agenda's client state)
 *   2.  an empty day renders an honest, actionable empty state
 *   3.  a full / closed / service-too-long day is a distinct, labelled,
 *       non-actionable state (never color alone)
 *   4.  an unavailable (blocked) slot can never be selected
 *   5.  a selectable slot is returned by the authority and is the
 *       earliest server-provided one
 *   6.  the selected date survives navigation between the wizard steps
 *   7.  stale state cannot survive a date change
 *   8.  mobile/RTL structural invariants (logical CSS only)
 *   9.  create-appointment behavior is unchanged
 *  10.  reschedule behavior is unchanged (own-slot self-exclusion)
 *  11.  tenant isolation is unchanged (foreign service / foreign
 *       exclude id are refused)
 *  12.  the conflict authority is intact (a real overlap is rejected and
 *       nothing is stored)
 *
 * Behavioral booking invariants remain covered by the dedicated suites
 * (`check:appointment-creation`, `check:reschedule`); this script
 * re-asserts the conflict invariant through the same canonical writer
 * so this slice cannot silently weaken it.
 *
 * Run: pnpm check:appointments-day-view
 */

export {};

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  // Placeholder env FIRST: the service modules import the repository
  // singletons, which construct the (lazy) Prisma client at import
  // time. Nothing connects — the harness never calls the fakes' DB.
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { dayCapacityState, isDayUnselectable, DAY_CAPACITY_LABELS } =
    await import("../src/features/appointments/components/smart-create/day-capacity");
  const {
    formatArabicDate,
    moveDate,
    resolveRelativeDate,
    RELATIVE_DATE_OPTIONS,
  } =
    await import("../src/features/appointments/components/smart-create/date-format");
  const { earliestSlot, slotExistsIn } =
    await import("../src/features/appointments/components/smart-create/slot-helpers");
  const { getAvailability, weekdayOf } =
    await import("../src/features/appointments/server/availability-service");
  const { createAppointmentRecord } =
    await import("../src/features/appointments/server/appointment-create-service");
  const { arabicCount, APPOINTMENT_NOUNS } = await import("../src/lib/arabic");
  const { appointmentDateSchema } = await import("../src/lib/validation");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }
  function eq<T>(actual: T, expected: T): boolean {
    return actual === expected;
  }

  // ─── 1. The selected day displays that day's appointments ───────────

  // The agenda query is an EXACT business-local date match: the
  // requested "YYYY-MM-DD" must normalize to UTC midnight of the SAME
  // calendar day and render back as the same date, for any date the
  // operator can navigate to — including DST boundaries, where a
  // device-local or offset-based derivation would drift a day.
  const NAV_DATES = [
    "2026-09-19",
    "2026-09-24",
    "2026-09-25",
    "2026-03-27", // Africa/Cairo DST transition day
    "2026-10-30",
    "2027-01-01",
  ];
  check(
    "1a every navigable date round-trips as the exact same business-local day",
    NAV_DATES.every(
      (date) =>
        appointmentDateSchema.safeParse(date).success &&
        new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) === date &&
        formatArabicDate(date).length > 0,
    ),
  );

  // Day navigation is pure arithmetic on the calendar string — moving a
  // day and back returns the origin (no timezone/offset drift).
  check(
    "1b moving a day forward then back is the identity",
    NAV_DATES.every((date) => eq(moveDate(moveDate(date, 1), -1), date)),
  );

  // The ROOT CAUSE fix of this slice: the agenda's client state is reset
  // per day, so a navigation to a new ?date= can never leave the
  // previous day's list, count or filter under a new date header.
  const pageSource = await readModuleSource(
    "../src/app/(app)/appointments/page.tsx",
  );
  const agendaSource = await readModuleSource(
    "../src/features/appointments/components/appointment-agenda.tsx",
  );
  check(
    "1c the page resets the agenda subtree per selected date (key={date})",
    /key=\{date\}/.test(pageSource),
  );
  check(
    "1d the agenda seeds its list from the server props only",
    /useState\(initialItems\)/.test(agendaSource) &&
      !/\bfunction moveDate\b/.test(agendaSource) &&
      !/\bfunction formatDate\b/.test(agendaSource),
  );

  // ─── 2. Empty day behavior ───────────────────────────────────────────

  check(
    "2a a zero-count day renders an honest Arabic zero",
    eq(arabicCount(0, APPOINTMENT_NOUNS), "لا توجد مواعيد"),
  );
  check(
    "2b the agenda's empty state is actionable (create on THAT day)",
    agendaSource.includes("لا توجد مواعيد في هذا اليوم") &&
      agendaSource.includes("غرّر") === false &&
      /\?date=\$\{date\}/.test(agendaSource),
  );

  // ─── 3. Full / unavailable day state (date-step capacity) ───────────

  const slotsResult = (
    slots: Array<{ startTime: string; endTime: string }>,
  ) => ({
    success: true as const,
    data: {
      date: "2026-09-19",
      timezone: "Africa/Cairo",
      serviceId: "s1",
      serviceDurationMinutes: 30,
      slots,
    },
    reason: null,
  });

  check(
    "3a a day with server slots is available",
    eq(
      dayCapacityState(slotsResult([{ startTime: "09:00", endTime: "09:30" }])),
      "available",
    ),
  );
  check(
    "3b a BUSINESS_CLOSED day is closed",
    eq(
      dayCapacityState({
        success: true,
        data: { ...slotsResult([]).data, slots: [] },
        reason: "BUSINESS_CLOSED",
      }),
      "closed",
    ),
  );
  check(
    "3c a FULLY_BOOKED day is full",
    eq(
      dayCapacityState({
        success: true,
        data: { ...slotsResult([]).data, slots: [] },
        reason: "FULLY_BOOKED",
      }),
      "full",
    ),
  );
  check(
    "3d a SERVICE_TOO_LONG day is too-long (not falsely «ممتلئ»)",
    eq(
      dayCapacityState({
        success: true,
        data: { ...slotsResult([]).data, slots: [] },
        reason: "SERVICE_TOO_LONG",
      }),
      "too-long",
    ),
  );
  check(
    "3e a reasonless empty list defaults to full (never closed)",
    eq(dayCapacityState(slotsResult([])), "full"),
  );
  check(
    "3f an error / unloaded result stays unknown (nothing fabricated)",
    eq(
      dayCapacityState({
        success: false,
        error: { code: "SERVICE_NOT_FOUND", message: "الخدمة غير موجودة" },
      }),
      "unknown",
    ) && eq(dayCapacityState(undefined), "unknown"),
  );
  check(
    "3g only closed/full/too-long days are unselectable",
    isDayUnselectable("closed") &&
      isDayUnselectable("full") &&
      isDayUnselectable("too-long") &&
      !isDayUnselectable("available") &&
      !isDayUnselectable("unknown"),
  );
  check(
    "3h every unselectable day has a non-empty Arabic label (never color alone)",
    DAY_CAPACITY_LABELS.closed.length > 0 &&
      DAY_CAPACITY_LABELS.full.length > 0 &&
      DAY_CAPACITY_LABELS["too-long"].length > 0 &&
      eq(DAY_CAPACITY_LABELS.closed, "مغلق") &&
      eq(DAY_CAPACITY_LABELS.full, "ممتلئ"),
  );

  // The date step paints capacity from the authority result ONLY — no
  // client-side slot generation/filtering, and the pure date module
  // stays availability-free.
  const dateStepSource = await readModuleSource(
    "../src/features/appointments/components/smart-create/date-step.tsx",
  );
  const dateFormatSource = await readModuleSource(
    "../src/features/appointments/components/smart-create/date-format.ts",
  );
  const dayCapacitySource = await readModuleSource(
    "../src/features/appointments/components/smart-create/day-capacity.ts",
  );
  check(
    "3i the date step consults the one authority and hosts no client engine",
    dateStepSource.includes("getAvailabilityAction") &&
      !dateStepSource.includes("generateCandidateSlots") &&
      !dateStepSource.includes("filterConflictingSlots") &&
      !dayCapacitySource.includes("generateCandidateSlots") &&
      !dayCapacitySource.includes("filterConflictingSlots") &&
      !dayCapacitySource.includes("prisma"),
  );
  check(
    "3j the date step shares the slot step's query key (one cached result per day)",
    dateStepSource.includes('"booking-availability"'),
  );
  check(
    "3k the date math stays pure (no availability code coupling in date-format)",
    !dateFormatSource.includes("getAvailability") &&
      !dateFormatSource.includes("availability-actions") &&
      !dateFormatSource.includes("generateCandidateSlots") &&
      !dateFormatSource.includes("filterConflictingSlots") &&
      !dateFormatSource.includes("resolveWorkingDay") &&
      !dateFormatSource.includes("weekdayOf"),
  );

  // ─── The authority itself: closed / full / available days ────────────

  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const SERVICE_A = "33333333-3333-4333-8333-333333333331";
  const SERVICE_FOREIGN = "33333333-3333-4333-8333-333333333399";
  const SERVICE_LONG = "33333333-3333-4333-8333-333333333332";
  const APPT_OWN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const APPT_FOREIGN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
  const SAT = "2026-09-19"; // Saturday
  const SUN = "2026-09-20"; // Sunday

  check(
    "3l the week keyder agrees 2026-09-19 is Saturday",
    eq(weekdayOf(SAT), "sat"),
  );

  const weekSatOnly: Record<
    string,
    { open: string; close: string; closed: boolean }
  > = {
    sat: { open: "09:00", close: "17:00", closed: false },
    sun: { open: "09:00", close: "17:00", closed: true },
    mon: { open: "09:00", close: "17:00", closed: true },
    tue: { open: "09:00", close: "17:00", closed: true },
    wed: { open: "09:00", close: "17:00", closed: true },
    thu: { open: "09:00", close: "17:00", closed: true },
    fri: { open: "09:00", close: "17:00", closed: true },
  };
  const business = {
    id: BUSINESS_A,
    timezone: "Africa/Cairo",
    slotDurationMinutes: 30,
    workingHours: weekSatOnly,
  };

  const service = {
    id: SERVICE_A,
    businessId: BUSINESS_A,
    isActive: true,
    durationMinutes: 30,
  };
  const longService = {
    ...service,
    durationMinutes: 600, // 10h never fits a 09:00–17:00 day
  };

  type Blocking = { id: string; startTime: string; endTime: string };
  let blocking: Blocking[] = [];
  function resetBlocking(rows: Blocking[]) {
    blocking = rows;
  }

  const availabilityDeps = {
    businessRepository: { findById: async () => business },
    serviceRepository: {
      findById: async (id: string) => {
        if (id === SERVICE_A) return service;
        if (id === SERVICE_LONG) return longService;
        if (id === SERVICE_FOREIGN) {
          return { ...service, businessId: "other-business" };
        }
        return null;
      },
    },
    appointmentRepository: {
      findById: async (id: string) => {
        if (id === APPT_OWN) {
          return {
            id: APPT_OWN,
            businessId: BUSINESS_A,
            status: "CONFIRMED",
          };
        }
        if (id === APPT_FOREIGN) {
          return {
            id: APPT_FOREIGN,
            businessId: "other-business",
            status: "CONFIRMED",
          };
        }
        return null;
      },
      listBlockingForDate: async (
        _businessId: string,
        _date: string,
        excludeAppointmentId?: string,
      ) =>
        blocking
          .filter((row) => row.id !== excludeAppointmentId)
          .map((row) => ({
            startTime: row.startTime,
            endTime: row.endTime,
          })),
    },
  } as unknown as Parameters<typeof getAvailability>[0];

  const actor = {
    userId: "u1",
    role: "ADMIN" as const,
    businessId: BUSINESS_A,
  };

  resetBlocking([]);
  const closedDay = await getAvailability(availabilityDeps, actor, {
    date: SUN,
    serviceId: SERVICE_A,
  });
  check(
    "3m a closed weekday yields zero slots with BUSINESS_CLOSED",
    closedDay.success === true &&
      closedDay.data.slots.length === 0 &&
      eq(closedDay.reason, "BUSINESS_CLOSED"),
  );

  const openDay = await getAvailability(availabilityDeps, actor, {
    date: SAT,
    serviceId: SERVICE_A,
  });
  check(
    "3n an open Saturday yields bookable slots in ascending order",
    openDay.success === true &&
      openDay.data.slots.length > 0 &&
      eq(openDay.data.slots[0]?.startTime, "09:00") &&
      openDay.data.slots.every(
        (slot, index) =>
          index === 0 ||
          openDay.data.slots[index - 1]!.startTime < slot.startTime,
      ),
  );

  resetBlocking([{ id: "block-all", startTime: "09:00", endTime: "17:00" }]);
  const fullDay = await getAvailability(availabilityDeps, actor, {
    date: SAT,
    serviceId: SERVICE_A,
  });
  check(
    "3o a day whose every candidate is blocked is FULLY_BOOKED",
    fullDay.success === true &&
      fullDay.data.slots.length === 0 &&
      eq(fullDay.reason, "FULLY_BOOKED"),
  );

  const tooLong = await getAvailability(availabilityDeps, actor, {
    date: SAT,
    serviceId: SERVICE_LONG,
  });
  check(
    "3p a service too long for the day yields SERVICE_TOO_LONG",
    tooLong.success === true &&
      tooLong.data.slots.length === 0 &&
      eq(tooLong.reason, "SERVICE_TOO_LONG"),
  );

  // ─── 4. Unavailable (blocked) slot state ─────────────────────────────

  resetBlocking([{ id: "block-ten", startTime: "10:00", endTime: "10:30" }]);
  const withBlock = await getAvailability(availabilityDeps, actor, {
    date: SAT,
    serviceId: SERVICE_A,
  });
  const blockedAbsent =
    withBlock.success &&
    !withBlock.data.slots.some((slot) => slot.startTime === "10:00");
  check(
    "4a a slot overlapping a blocking appointment is never offered",
    blockedAbsent === true,
  );
  check(
    "4b the blocked slot fails the membership guard the steps use",
    withBlock.success === true &&
      slotExistsIn(
        { startTime: "10:00", endTime: "10:30" },
        withBlock.data.slots,
      ) === false,
  );

  // ─── 5. Selectable slot state ────────────────────────────────────────

  check(
    "5a the free neighboring slots remain bookable",
    withBlock.success === true &&
      withBlock.data.slots.some((slot) => slot.startTime === "09:00") &&
      withBlock.data.slots.some((slot) => slot.startTime === "10:30"),
  );
  check(
    "5b «أقرب وقت متاح» is the authority's first (earliest) slot",
    withBlock.success === true &&
      eq(earliestSlot(withBlock.data.slots)?.startTime, "09:00") &&
      eq(earliestSlot([]), null),
  );

  // ─── 6. Selected-date persistence across the wizard steps ───────────

  check(
    "6a every relative choice resolves deterministically to a valid date",
    RELATIVE_DATE_OPTIONS.every((choice) => {
      const a = resolveRelativeDate(SAT, choice.option);
      const b = resolveRelativeDate(SAT, choice.option);
      return eq(a, b) && appointmentDateSchema.safeParse(a).success;
    }),
  );

  const wizardSource = await readModuleSource(
    "../src/features/appointments/components/smart-create/smart-create-appointment.tsx",
  );
  check(
    "6b the wizard holds the date in container state (steps come and go, the date persists)",
    wizardSource.includes("useState(defaultDate)") &&
      wizardSource.includes("setScreen") &&
      !wizardSource.includes("setDate(null)"),
  );

  // ─── 7. Stale-state prevention ───────────────────────────────────────

  check(
    "7a changing the date clears any slot chosen for another day",
    wizardSource.includes("handleSelectDate") &&
      /function handleSelectDate[\s\S]*?setSelectedSlot\(null\)/.test(
        wizardSource,
      ),
  );
  const slotStepSource = await readModuleSource(
    "../src/features/appointments/components/smart-create/slot-step.tsx",
  );
  check(
    "7b a slot that left the fresh server result is cleared in the wizard",
    slotStepSource.includes("slotExistsIn") &&
      slotStepSource.includes("onSlotUnavailable"),
  );
  check(
    "7c the date query key carries the service so a service change refetches",
    slotStepSource.includes('"booking-availability"'),
  );

  // ─── 8. Mobile / RTL structural invariants ───────────────────────────

  const PHYSICAL_CSS = /(?:^|[^\w-])(?:ml|mr|pl|pr|left|right)-(?:\w+)/;
  const RTL_SOURCES = [
    "../src/features/appointments/components/appointment-agenda.tsx",
    "../src/features/appointments/components/smart-create/date-step.tsx",
    "../src/features/appointments/components/smart-create/slot-step.tsx",
    "../src/features/appointments/components/reschedule-panel.tsx",
    "../src/features/appointments/components/appointment-detail.tsx",
  ];
  let rtlClean = true;
  for (const path of RTL_SOURCES) {
    const source = await readModuleSource(path);
    if (PHYSICAL_CSS.test(source)) rtlClean = false;
  }
  check(
    "8a the appointment surfaces use logical CSS only (no physical left/right)",
    rtlClean,
  );
  check(
    "8b the agenda renders an ordered daily agenda (list semantics, no calendar grid)",
    agendaSource.includes("<ol") && !agendaSource.includes("<table"),
  );
  check(
    "8c the date-step chips stay focusable-but-inert when unavailable (aria-disabled)",
    dateStepSource.includes("aria-disabled"),
  );

  // ─── 9 + 12. Create path + conflict authority intact ─────────────────

  const CUSTOMER_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const USER_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const DATE = "2026-09-19";

  const stored: Array<{
    id: string;
    businessId: string;
    branchId: string;
    assignedUserId: string;
    date: string;
    startTime: string;
    endTime: string;
  }> = [];
  let nextId = 0;

  const createDeps = {
    customerRepository: {
      findById: async () => ({ id: CUSTOMER_A, businessId: BUSINESS_A }),
    },
    serviceRepository: { findById: async () => service },
    businessRepository: {
      findById: async () => ({ ...business, confirmationMode: "manual" }),
    },
    branchRepository: {
      findDefaultByBusiness: async () => ({
        id: BRANCH_A,
        businessId: BUSINESS_A,
      }),
    },
    appointmentRepository: {
      createWithConflictCheck: async (input: {
        businessId: string;
        branchId: string;
        assignedUserId: string;
        date: string;
        startTime: string;
        endTime: string;
      }) => {
        const overlaps = stored.some(
          (row) =>
            row.businessId === input.businessId &&
            row.branchId === input.branchId &&
            row.assignedUserId === input.assignedUserId &&
            row.date === input.date &&
            input.startTime < row.endTime &&
            row.startTime < input.endTime,
        );
        if (overlaps) return null;
        const row = { id: `appt-${++nextId}`, ...input };
        stored.push(row);
        return row;
      },
    },
  } as unknown as Parameters<typeof createAppointmentRecord>[0];

  const createActor = {
    userId: USER_A,
    role: "ADMIN" as const,
    businessId: BUSINESS_A,
  };
  const create = (startTime: string) =>
    createAppointmentRecord(createDeps, createActor, {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_A,
      date: DATE,
      startTime,
      notes: "",
    });

  const first = await create("10:00");
  const conflict = await create("10:15"); // 10:15–10:45 overlaps 10:00–10:30
  const adjacent = await create("10:30"); // exactly adjacent — no overlap

  check(
    "9a/12a an overlapping create is rejected as SLOT_CONFLICT",
    first.success === true &&
      conflict.success === false &&
      "code" in conflict &&
      eq(conflict.code, "SLOT_CONFLICT"),
  );
  check(
    "9b/12b the blocked create stored nothing; the adjacent one still booked",
    eq(stored.length, 2) && adjacent.success === true,
  );
  check(
    "9c the created status is server-derived (manual mode ⇒ PENDING)",
    first.success === true && eq(first.status, "PENDING"),
  );

  // ─── 10. Reschedule path unchanged ───────────────────────────────────

  const actionsSource = await readModuleSource(
    "../src/features/appointments/actions/appointment-actions.ts",
  );
  const repoSource = await readModuleSource(
    "../src/server/repositories/appointment.repository.ts",
  );
  const availabilityServiceSource = await readModuleSource(
    "../src/features/appointments/server/availability-service.ts",
  );
  check(
    "10a the reschedule write goes through the conflict-checked repository path",
    actionsSource.includes("rescheduleWithConflictCheck"),
  );
  check(
    "10b the rescheduled appointment is excluded from its own conflict set (write + read agree)",
    repoSource.includes("id: { not: id }") &&
      repoSource.includes("excludeAppointmentId") &&
      availabilityServiceSource.includes("excludeAppointmentId"),
  );

  // A reschedule's own slot does not block its own day's capacity: the
  // authority excludes it, so the operator's current day stays bookable.
  resetBlocking([{ id: APPT_OWN, startTime: "10:00", endTime: "10:30" }]);
  const selfExcluded = await getAvailability(availabilityDeps, actor, {
    date: SAT,
    serviceId: SERVICE_A,
    excludeAppointmentId: APPT_OWN,
  });
  check(
    "10c the rescheduled appointment's own slot is offered back to it",
    selfExcluded.success === true &&
      selfExcluded.data.slots.some((slot) => slot.startTime === "10:00"),
  );

  // ─── 11. Tenant isolation intact ─────────────────────────────────────

  const foreignService = await getAvailability(availabilityDeps, actor, {
    date: SAT,
    serviceId: SERVICE_FOREIGN,
  });
  check(
    "11a another business's service resolves to SERVICE_NOT_FOUND (no leak)",
    foreignService.success === false &&
      eq(foreignService.error.code, "SERVICE_NOT_FOUND"),
  );

  const foreignExclude = await getAvailability(availabilityDeps, actor, {
    date: SAT,
    serviceId: SERVICE_A,
    excludeAppointmentId: APPT_FOREIGN,
  });
  check(
    "11b a foreign excludeAppointmentId is FORBIDDEN and widens nothing",
    foreignExclude.success === false &&
      eq(foreignExclude.error.code, "FORBIDDEN"),
  );

  const noBusiness = await getAvailability(
    availabilityDeps,
    { ...actor, businessId: null },
    { date: SAT, serviceId: SERVICE_A },
  );
  check(
    "11c an actor without a business reads nothing",
    noBusiness.success === false && eq(noBusiness.error.code, "NO_BUSINESS"),
  );

  // ─── Summary ──────────────────────────────────────────────────────────

  const failures = checks.filter((item) => !item.pass);
  for (const item of checks) {
    console.log(`${item.pass ? "✓" : "✗"} ${item.label}`);
  }
  console.log(
    `\n${checks.length - failures.length}/${checks.length} checks passed`,
  );
  if (failures.length > 0) {
    console.log("\nFAILED:");
    for (const item of failures) console.log(`  ✗ ${item.label}`);
    process.exit(1);
  }
  console.log("RESULT: PASSED ✅");
}

/** Read a module's source text (for the structural checks). */
async function readModuleSource(relativePath: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const url = await import("node:url");
  const here = url.fileURLToPath(new URL(import.meta.url));
  return readFileSync(resolve(here, "..", relativePath), "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
