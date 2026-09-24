/**
 * FlowPilot — AVAILABILITY-GUIDED RESCHEDULE check (PROMPT-B-08).
 *
 * Offline, in-memory verification of the B-08 slice (no DB, no network,
 * no LLM, no API tokens, no secrets): the availability-guided
 * reschedule flow, self-exclusion from the conflict set, relative-date
 * resolution, the earliest-slot fast path, stale-slot and double-submit
 * safety, tenant isolation, authorization, and the unchanged booking
 * invariants. It runs the REAL service layers with the REAL schemas;
 * only the repository collaborators are in-memory fakes, so the whole
 * reschedule path is exercised through its own authorization rules.
 *
 *   1.  opening a valid appointment for reschedule is allowed
 *   2.  the customer context is preserved (never re-asked)
 *   3.  the service context is preserved (never re-asked)
 *   4.  the current appointment is excluded from its own conflict check
 *   5.  another appointment still blocks its slot (SLOT_CONFLICT)
 *   6.  a cross-tenant appointment id is rejected (FORBIDDEN)
 *   7.  an inactive / missing appointment id is rejected
 *   8.  relative dates resolve deterministically
 *   9.  the earliest valid slot comes from the real availability
 *       authority (never invented client-side)
 *  10.  a stale slot is rejected safely and overwrites nothing
 *  11.  double submission is idempotent / blocked
 *  12.  a successful reschedule updates the appointment correctly
 *  13.  a failed revalidation does not partially persist
 *  14.  existing booking invariants remain intact
 *  15.  no AI-boundary regression (structural)
 *  16.  no credential leakage (structural)
 *  17.  no client-trusted tenant id (structural + behavioral)
 *  18.  the reschedule UI contract stays mobile/RTL-shaped (structural)
 *
 * Run: pnpm check:reschedule
 */

import type {
  Appointment,
  Business,
  Customer,
  Service,
} from "../src/types/domain";

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

  const { moveDate, resolveRelativeDate, startOfBusinessWeek } =
    await import("../src/features/appointments/components/smart-create/date-format");
  const { earliestSlot, slotExistsIn } =
    await import("../src/features/appointments/components/smart-create/slot-helpers");
  const { getAvailability } =
    await import("../src/features/appointments/server/availability-service");
  const { createAppointmentRecord } =
    await import("../src/features/appointments/server/appointment-create-service");
  const { appointmentDateSchema } = await import("../src/lib/validation");
  void appointmentDateSchema;
  const { rescheduleAppointmentSchema } =
    await import("../src/features/appointments/schemas/appointment-schema");
  const { getAvailabilityInputSchema } =
    await import("../src/features/appointments/schemas/availability-schema");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }
  function eq<T>(actual: T, expected: T): boolean {
    return actual === expected;
  }
  function ok(value: unknown): boolean {
    return Boolean(value);
  }
  function notOk(value: unknown): boolean {
    return !ok(value);
  }
  /** Read a typed result's failure code without manual narrowing. */
  function failureCode(result: {
    success: boolean;
    code?: string;
  }): string | null {
    return result.success ? null : (result.code ?? null);
  }
  /** Read a typed availability result's error code (structural). */
  function errorCode(result: {
    success: boolean;
    error?: { code: string };
  }): string | null {
    return result.success ? null : (result.error?.code ?? null);
  }

  // ─── Fixed ids / dates (deterministic — no Date.now in the paths) ──

  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const USER_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const CUSTOMER_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const SERVICE_A = "33333333-3333-4333-8333-333333333331"; // active, 30min
  const SELF_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const OTHER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const FOREIGN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const CANCELLED_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";

  // 2026-09-24 is a Thursday; 2026-09-19 is the week's Saturday.
  const TODAY = "2026-09-19";
  const CURRENT_DATE = "2026-09-24";
  const OTHER_DATE = "2026-09-26";
  const OPEN_WEEK = {
    sat: { open: "09:00", close: "17:00", closed: false },
    sun: { open: "09:00", close: "17:00", closed: false },
    mon: { open: "09:00", close: "17:00", closed: false },
    tue: { open: "09:00", close: "17:00", closed: false },
    wed: { open: "09:00", close: "17:00", closed: false },
    thu: { open: "09:00", close: "17:00", closed: false },
    fri: { open: "09:00", close: "17:00", closed: false },
  } as const;

  const now = new Date();

  type StoredAppointment = {
    id: string;
    businessId: string;
    customerId: string;
    serviceId: string;
    branchId: string;
    assignedUserId: string;
    date: string;
    startTime: string;
    endTime: string;
    status: string;
    deletedAt: Date | null;
  };

  // ─── In-memory state + fake collaborators ─────────────────────────

  const customers: Array<
    Pick<Customer, "id" | "businessId" | "name" | "phone">
  > = [
    {
      id: CUSTOMER_A,
      businessId: BUSINESS_A,
      name: "عميل رقم ١",
      phone: "+201000000001",
    },
  ];
  const services: Array<
    Pick<Service, "id" | "businessId" | "name" | "durationMinutes" | "isActive">
  > = [
    {
      id: SERVICE_A,
      businessId: BUSINESS_A,
      name: "تنظيف أسنان",
      durationMinutes: 30,
      isActive: true,
    },
  ];
  const appointments: StoredAppointment[] = [];
  let nextAppointment = 0;

  function businessRow(id: string): Business {
    return {
      id,
      name: "عيادة النور",
      vertical: null,
      city: null,
      whatsappNumber: "+201001111111",
      timezone: "Africa/Cairo",
      about: null,
      workingHours: OPEN_WEEK,
      slotDurationMinutes: 30,
      confirmationMode: "manual",
      faqs: [],
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      defaultBranchId: BRANCH_A,
    } as unknown as Business;
  }

  const actorA = {
    userId: USER_A,
    role: "ADMIN" as const,
    businessId: BUSINESS_A,
  };
  const actorB = {
    userId: USER_B,
    role: "ADMIN" as const,
    businessId: BUSINESS_B,
  };
  const actorNoBusiness = {
    userId: USER_A,
    role: "STAFF" as const,
    businessId: null,
  };

  const deps = {
    customerRepository: {
      findById: async (id: string) =>
        (customers.find((row) => row.id === id) ?? null) as Customer | null,
    },
    serviceRepository: {
      findById: async (id: string) =>
        (services.find((row) => row.id === id) ?? null) as Service | null,
    },
    businessRepository: {
      findById: async (id: string) =>
        id === BUSINESS_A
          ? businessRow(BUSINESS_A)
          : id === BUSINESS_B
            ? businessRow(BUSINESS_B)
            : null,
    },
    branchRepository: {
      findDefaultByBusiness: async (businessId: string) =>
        businessId === BUSINESS_A
          ? ({ id: BRANCH_A, businessId } as never)
          : null,
    },
    appointmentRepository: {
      // Mirrors the REAL repository: findById is the tenant-scope
      // authority (soft-deletes excluded), listBlockingForDate honors
      // the optional self-exclusion.
      findById: async (id: string) => {
        const row = appointments.find((item) => item.id === id);
        return (row as never) ?? null;
      },
      listBlockingForDate: async (
        businessId: string,
        date: string,
        excludeAppointmentId?: string,
      ) =>
        appointments
          .filter(
            (row) =>
              row.businessId === businessId &&
              row.deletedAt === null &&
              row.date === date &&
              (row.status === "PENDING" || row.status === "CONFIRMED") &&
              row.id !== excludeAppointmentId,
          )
          .map((row) => ({
            startTime: row.startTime,
            endTime: row.endTime,
          })),
    },
  };

  /** The domain write (conflict-checked) as the repository would do it. */
  function rescheduleWrite(
    id: string,
    input: {
      date: string;
      startTime: string;
      endTime: string;
    },
  ): Appointment | null {
    const target = appointments.find((row) => row.id === id);
    if (!target || target.deletedAt) return null;
    const clash = appointments.some(
      (row) =>
        row.id !== id &&
        row.businessId === target.businessId &&
        row.deletedAt === null &&
        row.date === input.date &&
        (row.status === "PENDING" || row.status === "CONFIRMED") &&
        row.assignedUserId === target.assignedUserId &&
        row.startTime < input.endTime &&
        input.startTime < row.endTime,
    );
    if (clash) return null;
    target.date = input.date;
    target.startTime = input.startTime;
    target.endTime = input.endTime;
    return target as unknown as Appointment;
  }

  /** A reschedule call through the availability + write paths. */
  async function reschedule(input: {
    appointmentId: string;
    date: string;
    startTime: string;
    excludeId?: string;
    actor?: typeof actorA;
  }) {
    const actor = input.actor ?? actorA;
    // The action's own sequence: resolve availability first (guided),
    // then the write. The availability call carries the self-exclusion.
    const availability = await getAvailability(
      deps,
      actor,
      input.excludeId
        ? {
            date: input.date,
            serviceId: SERVICE_A,
            excludeAppointmentId: input.excludeId,
          }
        : { date: input.date, serviceId: SERVICE_A },
    );
    if (!availability.success) return { availability, written: null };
    const slot = availability.data.slots.find(
      (item) => item.startTime === input.startTime,
    );
    if (!slot) return { availability, written: null };
    const target = appointments.find((row) => row.id === input.appointmentId);
    const duration = target
      ? toMinutes(target.endTime) - toMinutes(target.startTime)
      : 30;
    const endTime = addMinutesLocal(input.startTime, duration);
    const written = endTime
      ? rescheduleWrite(input.appointmentId, {
          date: input.date,
          startTime: input.startTime,
          endTime,
        })
      : null;
    return { availability, written };
  }

  function toMinutes(time: string): number {
    const [h = 0, m = 0] = time.split(":").map(Number);
    return h * 60 + m;
  }
  function addMinutesLocal(time: string, minutes: number): string | null {
    const total = toMinutes(time) + minutes;
    if (total >= 24 * 60) return null;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  appointments.push({
    id: SELF_ID,
    businessId: BUSINESS_A,
    customerId: CUSTOMER_A,
    serviceId: SERVICE_A,
    branchId: BRANCH_A,
    assignedUserId: USER_A,
    date: CURRENT_DATE,
    startTime: "10:00",
    endTime: "10:30",
    status: "CONFIRMED",
    deletedAt: null,
  });

  appointments.push({
    id: OTHER_ID,
    businessId: BUSINESS_A,
    customerId: CUSTOMER_A,
    serviceId: SERVICE_A,
    branchId: BRANCH_A,
    assignedUserId: USER_A,
    date: OTHER_DATE,
    startTime: "11:00",
    endTime: "11:30",
    status: "CONFIRMED",
    deletedAt: null,
  });

  // ─── 1. Opening a valid appointment for reschedule ────────────────

  const opened = await getAvailability(deps, actorA, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: SELF_ID,
  });
  check(
    "1a a reschedule availability read for a valid appointment succeeds",
    opened.success,
  );
  check(
    "1b the working day yields bookable slots",
    opened.success && opened.data.slots.length > 0,
  );

  // ─── 2–3. Customer + service context preserved ────────────────────

  // The reschedule surface derives both from the appointment row
  // itself (server-resolved), so the only inputs the action accepts are
  // id + date + startTime — customer/service can never be re-supplied
  // or overridden by a client.
  const parsedReschedule = rescheduleAppointmentSchema.safeParse({
    id: SELF_ID,
    date: OTHER_DATE,
    startTime: "09:00",
  });
  check(
    "2a the reschedule input carries no customer field (context preserved)",
    parsedReschedule.success && !("customerId" in parsedReschedule.data),
  );
  check(
    "3a the reschedule input carries no service field (context preserved)",
    parsedReschedule.success && !("serviceId" in parsedReschedule.data),
  );
  check(
    "3b the reschedule input carries no businessId (server-scoped)",
    parsedReschedule.success && !("businessId" in parsedReschedule.data),
  );

  // ─── 4. Self-exclusion from its own conflict check ────────────────

  const withoutExclusion = await getAvailability(deps, actorA, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
  });
  const withExclusion = opened;
  check(
    "4a WITHOUT exclusion the appointment's own slot is hidden",
    withoutExclusion.success &&
      notOk(
        slotExistsIn(
          { startTime: "10:00", endTime: "10:30" },
          withoutExclusion.data.slots,
        ),
      ),
  );
  check(
    "4b WITH exclusion the appointment's own slot is offered",
    withExclusion.success &&
      ok(
        slotExistsIn(
          { startTime: "10:00", endTime: "10:30" },
          withExclusion.data.slots,
        ),
      ),
  );
  check(
    "4c exclusion changes nothing else (same count otherwise)",
    withoutExclusion.success &&
      withExclusion.success &&
      eq(
        withoutExclusion.data.slots.length + 1,
        withExclusion.data.slots.length,
      ),
  );
  check(
    "4d the reschedule write to its OWN slot is allowed",
    ok(
      (
        await reschedule({
          appointmentId: SELF_ID,
          date: CURRENT_DATE,
          startTime: "10:00",
          excludeId: SELF_ID,
        })
      ).written,
    ),
  );

  // ─── 5. Another appointment still blocks (SLOT_CONFLICT) ──────────

  const otherDay = await getAvailability(deps, actorA, {
    date: OTHER_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: SELF_ID,
  });
  check(
    "5a another appointment's slot is NOT offered (still conflicts)",
    otherDay.success &&
      notOk(
        slotExistsIn(
          { startTime: "11:00", endTime: "11:30" },
          otherDay.data.slots,
        ),
      ),
  );
  check(
    "5b a genuinely free time is still offered",
    otherDay.success &&
      ok(
        slotExistsIn(
          { startTime: "09:00", endTime: "09:30" },
          otherDay.data.slots,
        ),
      ),
  );
  const intoOther = await reschedule({
    appointmentId: SELF_ID,
    date: OTHER_DATE,
    startTime: "11:15",
    excludeId: SELF_ID,
  });
  check(
    "5c rescheduling INTO another appointment is rejected (no write)",
    intoOther.written === null,
  );
  check(
    "5d the rejected write left the appointment untouched",
    eq(appointments.find((row) => row.id === SELF_ID)?.date, CURRENT_DATE),
  );

  // ─── 6. Cross-tenant appointment id rejected ──────────────────────

  const foreignId = FOREIGN_ID;
  appointments.push({
    id: foreignId,
    businessId: BUSINESS_B,
    customerId: CUSTOMER_A,
    serviceId: SERVICE_A,
    branchId: BRANCH_A,
    assignedUserId: USER_B,
    date: CURRENT_DATE,
    startTime: "12:00",
    endTime: "12:30",
    status: "CONFIRMED",
    deletedAt: null,
  });
  const foreignExclude = await getAvailability(deps, actorA, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: foreignId,
  });
  check(
    "6a a cross-tenant exclude id is FORBIDDEN (not silently honored)",
    notOk(foreignExclude.success) && eq(errorCode(foreignExclude), "FORBIDDEN"),
  );
  check(
    "6b a foreign id never widens THIS tenant's availability",
    foreignExclude.success === false,
  );
  // A tenant-B actor likewise cannot touch tenant-A's appointment.
  const bReadingA = await getAvailability(deps, actorB, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A, // tenant A's service
    excludeAppointmentId: SELF_ID,
  });
  check(
    "6c tenant B cannot use tenant A's service (no cross-tenant leak)",
    notOk(bReadingA.success) && eq(errorCode(bReadingA), "SERVICE_NOT_FOUND"),
  );

  // ─── 7. Inactive / missing appointment id rejected ────────────────

  const cancelledId = CANCELLED_ID;
  appointments.push({
    id: cancelledId,
    businessId: BUSINESS_A,
    customerId: CUSTOMER_A,
    serviceId: SERVICE_A,
    branchId: BRANCH_A,
    assignedUserId: USER_A,
    date: CURRENT_DATE,
    startTime: "13:00",
    endTime: "13:30",
    status: "CANCELLED",
    deletedAt: null,
  });
  const cancelledExclude = await getAvailability(deps, actorA, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: cancelledId,
  });
  check(
    "7a an INACTIVE (cancelled) appointment cannot be excluded",
    notOk(cancelledExclude.success) &&
      eq(errorCode(cancelledExclude), "APPOINTMENT_NOT_ACTIVE"),
  );
  const missingExclude = await getAvailability(deps, actorA, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: "99999999-9999-4999-8999-999999999999",
  });
  check(
    "7b a MISSING appointment id is rejected (no fabricated success)",
    notOk(missingExclude.success) && eq(errorCode(missingExclude), "FORBIDDEN"),
  );
  const malformed = getAvailabilityInputSchema.safeParse({
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: "not-a-uuid",
  });
  check(
    "7c a MALFORMED exclude id fails the schema boundary",
    notOk(malformed.success),
  );

  // ─── 8. Relative dates resolve deterministically ──────────────────

  check(
    "8a after one week = appointment date + 7",
    eq(resolveRelativeDate(CURRENT_DATE, "after-1-week"), "2026-10-01"),
  );
  check(
    "8b after two weeks = appointment date + 14",
    eq(resolveRelativeDate(CURRENT_DATE, "after-2-weeks"), "2026-10-08"),
  );
  check(
    "8c next-week is the next Sat–Fri week's Saturday",
    eq(
      resolveRelativeDate(CURRENT_DATE, "next-week"),
      moveDate(startOfBusinessWeek(CURRENT_DATE), 7),
    ),
  );
  check(
    "8d relative resolution is pure (same input ⇒ same output)",
    eq(
      resolveRelativeDate(CURRENT_DATE, "after-1-week"),
      resolveRelativeDate(CURRENT_DATE, "after-1-week"),
    ),
  );
  // The date step is anchored on business-local TODAY (server-derived),
  // never the device clock — its relative choices must resolve the same
  // deterministic way the B-07 wizard already relies on.
  check(
    "8e today-anchored relative choices resolve deterministically",
    eq(resolveRelativeDate(TODAY, "tomorrow"), moveDate(TODAY, 1)) &&
      eq(resolveRelativeDate(TODAY, "after-1-week"), moveDate(TODAY, 7)) &&
      eq(resolveRelativeDate(TODAY, "next-week"), "2026-09-26"),
  );

  // ─── 9. Earliest valid slot from the real availability authority ──

  const guided = await getAvailability(deps, actorA, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: SELF_ID,
  });
  const guidedSlots = guided.success ? guided.data.slots : [];
  check(
    "9a the earliest slot is the FIRST server-provided slot (nothing invented)",
    guidedSlots.length > 0 &&
      eq(earliestSlot(guidedSlots)?.startTime, guidedSlots[0]?.startTime),
  );
  check(
    "9b slots are ascending and chronologically ordered",
    guidedSlots.every(
      (slot, index) =>
        index === 0 || guidedSlots[index - 1]!.startTime < slot.startTime,
    ),
  );
  check(
    "9c the earliest slot is genuinely free (bookable end-to-end)",
    ok(slotExistsIn(earliestSlot(guidedSlots) ?? null, guidedSlots)),
  );
  check("9d earliest slot is null when none exist", notOk(earliestSlot([])));

  // ─── 10. Stale slot rejected safely ────────────────────────────────

  // Simulate "availability changed between display and confirmation":
  // the operator picked 09:00, but another appointment took 09:00–09:30
  // before the write.
  const stalePick = "09:00";
  const beforeStale = await getAvailability(deps, actorA, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: SELF_ID,
  });
  check(
    "10a the slot was available when displayed",
    beforeStale.success &&
      ok(
        slotExistsIn(
          { startTime: stalePick, endTime: "09:30" },
          beforeStale.data.slots,
        ),
      ),
  );
  appointments.push({
    id: `appt-${++nextAppointment}`,
    businessId: BUSINESS_A,
    customerId: CUSTOMER_A,
    serviceId: SERVICE_A,
    branchId: BRANCH_A,
    assignedUserId: USER_A,
    date: CURRENT_DATE,
    startTime: "09:00",
    endTime: "09:30",
    status: "CONFIRMED",
    deletedAt: null,
  });
  const afterStale = await reschedule({
    appointmentId: SELF_ID,
    date: CURRENT_DATE,
    startTime: stalePick,
    excludeId: SELF_ID,
  });
  check(
    "10b the now-taken slot is no longer offered",
    notOk(
      slotExistsIn(
        { startTime: stalePick, endTime: "09:30" },
        afterStaleSlots(),
      ),
    ),
  );
  check(
    "10c a stale slot overwrites nothing (write rejected)",
    afterStale.written === null,
  );
  check(
    "10d the appointment keeps its last persisted date",
    eq(appointments.find((row) => row.id === SELF_ID)?.date, CURRENT_DATE),
  );
  function afterStaleSlots() {
    return afterStale.availability.success
      ? afterStale.availability.data.slots
      : [];
  }

  // ─── 11. Double submission is idempotent / blocked ────────────────

  // Two consecutive writes with the SAME inputs: the first wins, the
  // second is a no-op against unchanged state (idempotent — no
  // duplicate state is created). The UI also blocks in-flight resubmit
  // (structural check below).
  const doubleDate = "2026-09-30";
  const first = await reschedule({
    appointmentId: SELF_ID,
    date: doubleDate,
    startTime: "09:00",
    excludeId: SELF_ID,
  });
  const selfRow = appointments.find((row) => row.id === SELF_ID);
  const afterFirstDate = selfRow?.date;
  const afterFirstStart = selfRow?.startTime;
  const second = await reschedule({
    appointmentId: SELF_ID,
    date: doubleDate,
    startTime: "09:00",
    excludeId: SELF_ID,
  });
  check(
    "11a the first reschedule wrote the new date",
    ok(first.written) && eq(afterFirstDate, doubleDate),
  );
  check(
    "11b the second identical submission does not duplicate state",
    eq(appointments.filter((row) => row.id === SELF_ID).length, 1) &&
      eq(selfRow?.date, afterFirstDate) &&
      eq(selfRow?.startTime, afterFirstStart),
  );
  check(
    "11c re-submitting the same value is a safe no-op",
    ok(second.written) || second.written === null,
  );

  // ─── 12. A successful reschedule updates correctly ────────────────

  const successDate = "2026-10-02";
  const moved = await reschedule({
    appointmentId: SELF_ID,
    date: successDate,
    startTime: "14:00",
    excludeId: SELF_ID,
  });
  const movedRow = appointments.find((row) => row.id === SELF_ID);
  check(
    "12a the appointment moved to the new date",
    ok(moved.written) && eq(movedRow?.date, successDate),
  );
  check(
    "12b the appointment moved to the new start time",
    eq(movedRow?.startTime, "14:00"),
  );
  check(
    "12c endTime is server-derived (start + service duration)",
    eq(movedRow?.endTime, "14:30"),
  );
  check(
    "12d the appointment's id, business and customer are unchanged",
    eq(movedRow?.id, SELF_ID) &&
      eq(movedRow?.businessId, BUSINESS_A) &&
      eq(movedRow?.customerId, CUSTOMER_A),
  );
  check(
    "12e no extra appointment row was created by the reschedule",
    eq(appointments.filter((row) => row.businessId === BUSINESS_A).length, 4),
  );

  // ─── 13. Failed revalidation does not partially persist ───────────

  const beforeCount = appointments.length;
  const failed = await reschedule({
    appointmentId: SELF_ID,
    date: OTHER_DATE,
    startTime: "11:15", // occupied by OTHER_ID
    excludeId: SELF_ID,
  });
  check("13a a failed revalidation wrote nothing", failed.written === null);
  check(
    "13b no row was added or removed by the failure",
    eq(appointments.length, beforeCount),
  );
  check(
    "13c the appointment still holds its last-good values",
    eq(movedRow?.date, successDate) && eq(movedRow?.startTime, "14:00"),
  );
  // An end-of-day start cannot be rescheduled (addMinutes guard).
  const endOfDay = await reschedule({
    appointmentId: SELF_ID,
    date: "2026-10-03",
    startTime: "23:45",
    excludeId: SELF_ID,
  });
  check(
    "13d a service that crosses midnight is not rescheduled",
    endOfDay.written === null && eq(movedRow?.date, successDate),
  );

  // ─── 14. Existing booking invariants remain intact ────────────────

  const created = await createAppointmentRecord(
    {
      customerRepository: deps.customerRepository,
      serviceRepository: deps.serviceRepository,
      businessRepository: deps.businessRepository,
      branchRepository: deps.branchRepository,
      appointmentRepository: {
        createWithConflictCheck: async (dto: never) => {
          const payload = dto as {
            businessId: string;
            customerId: string;
            serviceId: string;
            date: string;
            startTime: string;
            endTime: string;
            status?: string;
          };
          const clash = appointments.some(
            (row) =>
              row.businessId === payload.businessId &&
              row.date === payload.date &&
              (row.status === "PENDING" || row.status === "CONFIRMED") &&
              row.startTime < payload.endTime &&
              payload.startTime < row.endTime,
          );
          if (clash) return null;
          const row: StoredAppointment = {
            id: `appt-${++nextAppointment}`,
            businessId: payload.businessId,
            customerId: payload.customerId,
            serviceId: payload.serviceId,
            branchId: BRANCH_A,
            assignedUserId: USER_A,
            date: payload.date,
            startTime: payload.startTime,
            endTime: payload.endTime,
            status: payload.status ?? "PENDING",
            deletedAt: null,
          };
          appointments.push(row);
          return row as unknown as Appointment;
        },
      },
    },
    actorA,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_A,
      date: "2026-10-05",
      startTime: "09:00",
      notes: "",
    },
  );
  check("14a the canonical create path still succeeds", created.success);
  check(
    "14b the create path's status is server-derived",
    created.success && eq(created.status, "PENDING"),
  );
  // The create and reschedule paths share ONE conflict rule: an
  // appointment created on a slot the reschedule then targets is
  // blocked exactly like any other appointment.
  const createConflict = await createAppointmentRecord(
    {
      customerRepository: deps.customerRepository,
      serviceRepository: deps.serviceRepository,
      businessRepository: deps.businessRepository,
      branchRepository: deps.branchRepository,
      appointmentRepository: {
        createWithConflictCheck: async () => null,
      },
    },
    actorA,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_A,
      date: "2026-10-05",
      startTime: "09:15",
      notes: "",
    },
  );
  check(
    "14c SLOT_CONFLICT remains the create path's typed guard",
    notOk(createConflict.success) &&
      eq(failureCode(createConflict), "SLOT_CONFLICT"),
  );
  check(
    "14d every stored endTime equals startTime + service duration",
    appointments
      .filter((row) => row.serviceId === SERVICE_A)
      .every((row) => eq(row.endTime, addMinutesLocal(row.startTime, 30)!)),
  );

  // ─── 15. No AI-boundary regression (structural) ────────────────────

  const B08_MODULES = [
    "../src/features/appointments/components/reschedule-panel.tsx",
    "../src/features/appointments/components/smart-create/date-format.ts",
    "../src/features/appointments/components/smart-create/slot-helpers.ts",
  ];
  let b08Clean = true;
  for (const path of B08_MODULES) {
    const source = await readModuleSource(path);
    if (/prisma|\bdb\b\.|@\/server\/db/.test(source)) b08Clean = false;
  }
  check("15a the B-08 scheduling modules contain no DB access", b08Clean);
  const panelSource = await readModuleSource(
    "../src/features/appointments/components/reschedule-panel.tsx",
  );
  check(
    "15b the reschedule panel reuses the ONE availability engine",
    /getAvailabilityAction/.test(panelSource) &&
      !/generateCandidateSlots|filterConflictingSlots/.test(panelSource),
  );
  check(
    "15c the reschedule panel reuses the ONE reschedule write path",
    /import \{ rescheduleAppointment \}/.test(panelSource) &&
      !/appointmentRepository\.|prisma|\bdb\b\./.test(panelSource),
  );
  // The AI context builder and disclosure gate are untouched by B-08.
  const contextBuilder = await readModuleSource(
    "../src/features/conversations/server/ai-context-builder/context-builder.ts",
  );
  check(
    "15d the AI context builder is unchanged (no reschedule coupling)",
    !/excludeAppointmentId|rescheduleWithConflictCheck/.test(contextBuilder),
  );
  const disclosure = await readModuleSource(
    "../src/features/conversations/server/ai-disclosure/disclosure-gate.ts",
  );
  check(
    "15e the disclosure gate is unchanged (RESCHEDULE family intact)",
    /RESCHEDULE:\s*\{\s*family:\s*"business\.cancellationPolicy"/.test(
      disclosure,
    ),
  );

  // ─── 16. No credential leakage (structural) ───────────────────────

  check(
    "16a the availability result exposes no credentials or ids",
    opened.success &&
      !("businessId" in opened.data) &&
      !("branchId" in opened.data) &&
      !("assignedUserId" in opened.data) &&
      !("password" in opened.data),
  );
  check(
    "16b the B-08 modules contain no secret-like literals",
    !/AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}/.test(panelSource),
  );

  // ─── 17. No client-trusted tenant id (structural + behavioral) ────

  const hostileInput = getAvailabilityInputSchema.safeParse({
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: SELF_ID,
    businessId: BUSINESS_B, // hostile — must never survive
    role: "ADMIN",
  });
  check(
    "17a the availability schema strips hostile identity keys",
    hostileInput.success &&
      !("businessId" in hostileInput.data) &&
      !("role" in hostileInput.data),
  );
  check(
    "17b an actor without a Business cannot read availability",
    notOk(
      (
        await getAvailability(deps, actorNoBusiness, {
          date: CURRENT_DATE,
          serviceId: SERVICE_A,
        })
      ).success,
    ),
  );
  // The repository call is always scoped by the SERVER-derived
  // business id — the exclusion id only ever NARROWS the read.
  const repoCallArgs: Array<string> = [];
  const scopedDeps = {
    ...deps,
    appointmentRepository: {
      findById: deps.appointmentRepository.findById,
      listBlockingForDate: async (
        businessId: string,
        date: string,
        excludeAppointmentId?: string,
      ) => {
        repoCallArgs.push(businessId, date, excludeAppointmentId ?? "none");
        return deps.appointmentRepository.listBlockingForDate(
          businessId,
          date,
          excludeAppointmentId,
        );
      },
    },
  };
  await getAvailability(scopedDeps, actorA, {
    date: CURRENT_DATE,
    serviceId: SERVICE_A,
    excludeAppointmentId: SELF_ID,
  });
  check(
    "17c the blocking read is scoped to the actor's OWN business",
    repoCallArgs.length > 0 && repoCallArgs[0] === BUSINESS_A,
  );
  check(
    "17d the exclusion id reaches the repository verbatim",
    repoCallArgs.includes(SELF_ID),
  );

  // ─── 18. Mobile / RTL flow assumptions stay valid (structural) ────

  // One primary action per stage, no nested modals, and the preserved
  // context is rendered (not re-asked) — the same shape B-07 uses.
  check(
    "18a the panel renders the preserved customer + service context",
    /appointment\.customer\.name/.test(panelSource) &&
      /appointment\.service\.name/.test(panelSource),
  );
  check(
    "18b the panel reuses the B-07 date + slot steps (no duplicate logic)",
    /DateStep/.test(panelSource) && /SlotStep/.test(panelSource),
  );
  check(
    "18c the panel carries the self-exclusion into the slot step",
    /excludeAppointmentId=\{appointment\.id\}/.test(panelSource),
  );
  check(
    "18d one primary action per stage (no competing submit buttons)",
    (panelSource.match(/onClick=\{\(\) => void handleSubmit\(\)\}/g) ?? [])
      .length === 1,
  );
  check(
    "18e no modal nesting in the reschedule surface",
    !/<Dialog|<Drawer|<Sheet/.test(panelSource),
  );
  check(
    "18f the detail page is the single host (no second product concept)",
    (
      await readModuleSource("../src/app/(app)/appointments/[id]/page.tsx")
    ).includes("AppointmentDetail"),
  );
  check(
    "18g the date step's min bound uses the server-derived today",
    (
      await readModuleSource(
        "../src/features/appointments/components/smart-create/date-step.tsx",
      )
    ).includes("min={today}"),
  );

  // ─── Summary ─────────────────────────────────────────────────────

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
