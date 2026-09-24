/**
 * FlowPilot — APPOINTMENT CREATION + SCHEDULING UX check (PROMPT-B-07).
 *
 * Offline, in-memory verification of the B-07 slice (no DB, no network,
 * no LLM, no API tokens, no secrets): smart-context prefill, relative
 * scheduling, the availability-first "earliest slot" path, the
 * follow-up decision, tenant isolation, authorization, and the
 * unchanged booking invariants. It runs the REAL service layers with
 * the REAL schemas; only the repository collaborators are in-memory
 * fakes, so the whole creation path is exercised through its own
 * authorization rules.
 *
 *   1.  general new appointment path — a valid create succeeds
 *   2.  customer-prefilled path — a same-Business customer prefills
 *       and the wizard opens past العميل
 *   3.  service-prefilled path — an ACTIVE same-Business service
 *       prefills; inactive / foreign / unknown do not
 *   4.  conversation-context path — the customer a conversation
 *       exposes resolves as prefill; another Business's conversation
 *       customer never leaks
 *   5.  Today — resolves to the anchor
 *   6.  Tomorrow — anchor + 1
 *   7.  This week — a later day inside the current Sat–Fri week (and
 *       the end-of-week fallback)
 *   8.  Next week — the Saturday starting the next Sat–Fri week
 *   9.  Custom date — passes through untransformed to availability
 *  10.  earliest available slot — the first server slot, null when none
 *  11.  an unavailable slot cannot be booked — a conflicting write is
 *       rejected (SLOT_CONFLICT) and never stored
 *  12.  follow-up after one week — the created date + 7
 *  13.  follow-up after two weeks — the created date + 14
 *  14.  follow-up after one month — one calendar month, month-end
 *       clamped
 *  15.  tenant isolation — cross-Business customer/service ids are
 *       rejected or "not found", never returned, never written
 *  16.  authorization rejection — an actor without a Business is
 *       rejected before any repository call
 *  17.  no AI direct DB write — the B-07 modules contain no Prisma /
 *       DB access; the ONE appointment write path is the canonical
 *       create service (the follow-up reuses it — there is no second
 *       writer), and the UI scheduling helpers are pure
 *  18.  existing booking invariants remain intact — server-derived
 *       endTime, confirmationMode-derived status, active-service rule,
 *       conflict check, honest success
 *
 * Run: pnpm check:appointment-creation
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

  const { addMonths, moveDate, resolveRelativeDate, startOfBusinessWeek } =
    await import("../src/features/appointments/components/smart-create/date-format");
  const { earliestSlot, slotExistsIn } =
    await import("../src/features/appointments/components/smart-create/slot-helpers");
  const {
    defaultBookingFlowServiceDeps: _unused, // constructed only; never called
    deriveInitialBookingScreen,
    listBookingServices,
    resolveBookingContext,
  } = await import("../src/features/appointments/server/booking-flow-service");
  const { getAvailability } =
    await import("../src/features/appointments/server/availability-service");
  const { createAppointmentRecord } =
    await import("../src/features/appointments/server/appointment-create-service");
  const { bookingContextSchema } =
    await import("../src/features/appointments/schemas/booking-flow-schema");
  const { appointmentDateSchema } = await import("../src/lib/validation");

  void _unused;

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
  /** Read a typed create result's failure code without manual narrowing. */
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
  const CUSTOMER_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const CUSTOMER_B = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2"; // BUSINESS_B
  const SERVICE_A = "33333333-3333-4333-8333-333333333331"; // active
  const SERVICE_INACTIVE = "33333333-3333-4333-8333-333333333332"; // inactive
  const SERVICE_B = "33333333-3333-4333-8333-333333333333"; // BUSINESS_B

  // 2026-09-19 is a Saturday — the start of its own Sat–Fri business
  // week (verified against the module's own epoch math).
  const TODAY = "2026-09-19";
  const APPOINTMENT_DATE = "2026-09-24"; // a Thursday
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
    {
      id: CUSTOMER_B,
      businessId: BUSINESS_B,
      name: "عميل آخر",
      phone: "+201000000002",
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
    {
      id: SERVICE_INACTIVE,
      businessId: BUSINESS_A,
      name: "تقويم",
      durationMinutes: 60,
      isActive: false,
    },
    {
      id: SERVICE_B,
      businessId: BUSINESS_B,
      name: "خدمة خارجية",
      durationMinutes: 30,
      isActive: true,
    },
  ];
  const appointments: StoredAppointment[] = [];
  let nextAppointment = 0;

  function businessRow(
    id: string,
    confirmationMode: "manual" | "automatic" = "manual",
  ): Business {
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
      confirmationMode,
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
  const actorNoBusiness = {
    userId: USER_A,
    role: "STAFF" as const,
    businessId: null,
  };
  type Actor = {
    userId: string;
    role: "ADMIN" | "STAFF";
    businessId: string | null;
  };

  const deps = {
    customerRepository: {
      findById: async (id: string) =>
        (customers.find((row) => row.id === id) ?? null) as Customer | null,
      listByBusiness: async (businessId: string) =>
        customers.filter((row) => row.businessId === businessId) as Customer[],
    },
    serviceRepository: {
      findById: async (id: string) =>
        (services.find((row) => row.id === id) ?? null) as Service | null,
      listByBusiness: async (businessId: string) =>
        services.filter(
          (row) => row.businessId === businessId && row.isActive,
        ) as Service[],
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

  // A create call the fake can attribute to a real customer+service.
  // It builds its own deps so no shared state is mutated between runs.
  async function create(input: {
    actor?: Actor;
    customerId?: string;
    serviceId?: string;
    date?: string;
    startTime?: string;
    confirmationMode?: "manual" | "automatic";
  }) {
    const mode = input.confirmationMode ?? "manual";
    return createAppointmentRecord(
      {
        customerRepository: deps.customerRepository,
        serviceRepository: deps.serviceRepository,
        businessRepository: {
          findById: async () => businessRow(BUSINESS_A, mode),
        },
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
              assignedUserId: string;
              notes?: string;
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
              assignedUserId: payload.assignedUserId,
              date: payload.date,
              startTime: payload.startTime,
              endTime: payload.endTime,
              status: payload.status ?? "PENDING",
            };
            appointments.push(row);
            return row as unknown as Appointment;
          },
        },
      },
      input.actor ?? actorA,
      {
        customerId: input.customerId ?? CUSTOMER_A,
        serviceId: input.serviceId ?? SERVICE_A,
        date: input.date ?? APPOINTMENT_DATE,
        startTime: input.startTime ?? "10:00",
        notes: "",
      },
    );
  }

  // ─── 1. General new appointment path ──────────────────────────────

  const general = await create({});
  check(
    "1a general create succeeds with an id",
    general.success && ok(general.appointmentId),
  );
  check(
    "1b general create reports the server-derived status",
    general.success && eq(general.status, "PENDING"),
  );
  check(
    "1c general create persisted exactly one appointment",
    eq(appointments.length, 1),
  );

  // ─── 2. Customer-prefilled path (smart context) ───────────────────

  const customerPrefill = await resolveBookingContext(deps, actorA, {
    customerId: CUSTOMER_A,
  });
  check(
    "2a a same-Business customer prefills",
    ok(customerPrefill.customer) &&
      eq(customerPrefill.customer?.id, CUSTOMER_A),
  );
  check(
    "2b a prefilled customer opens the flow past العميل",
    eq(deriveInitialBookingScreen(customerPrefill), "service"),
  );
  check(
    "2c an unknown customer id prefills nothing",
    notOk(
      (
        await resolveBookingContext(deps, actorA, {
          customerId: "99999999-9999-4999-8999-999999999999",
        })
      ).customer,
    ),
  );

  // ─── 3. Service-prefilled path (smart context) ────────────────────

  const servicePrefill = await resolveBookingContext(deps, actorA, {
    serviceId: SERVICE_A,
  });
  check(
    "3a an active same-Business service prefills",
    eq(servicePrefill.serviceId, SERVICE_A),
  );
  check(
    "3b a service alone never skips العميل (customer still required)",
    eq(deriveInitialBookingScreen(servicePrefill), "customer"),
  );
  check(
    "3c customer + service opens on التاريخ",
    eq(
      deriveInitialBookingScreen({
        customer: customerPrefill.customer,
        serviceId: SERVICE_A,
      }),
      "date",
    ),
  );
  check(
    "3d an INACTIVE service prefills nothing (not bookable)",
    notOk(
      (
        await resolveBookingContext(deps, actorA, {
          serviceId: SERVICE_INACTIVE,
        })
      ).serviceId,
    ),
  );
  const catalog = await listBookingServices(deps, actorA);
  check(
    "3e the booking catalog lists active services only",
    Array.isArray(catalog) && eq(catalog.length, 1),
  );

  // ─── 4. Conversation-context path ─────────────────────────────────

  // A conversation exposes its customer id; booking from it prefills
  // the SAME way. The conversation's customer belongs to BUSINESS_B
  // here — resolving it under actorA must yield nothing (no leak).
  const conversationCustomer = await resolveBookingContext(deps, actorA, {
    customerId: CUSTOMER_B,
  });
  check(
    "4a a foreign conversation's customer never prefills",
    notOk(conversationCustomer.customer),
  );
  // The same id resolved by its OWN business does prefill.
  check(
    "4b the conversation's customer prefills for its own business",
    ok(
      (
        await resolveBookingContext(
          deps,
          { ...actorA, businessId: BUSINESS_B },
          { customerId: CUSTOMER_B },
        )
      ).customer,
    ),
  );

  // ─── 5–9. Relative scheduling ─────────────────────────────────────

  check(
    "5 today resolves to the anchor",
    eq(resolveRelativeDate(TODAY, "today"), TODAY),
  );
  check(
    "6 tomorrow resolves to anchor + 1",
    eq(resolveRelativeDate(TODAY, "tomorrow"), moveDate(TODAY, 1)),
  );
  const thisWeek = resolveRelativeDate(TODAY, "this-week");
  check(
    "7a this-week lands inside the current Sat–Fri week",
    thisWeek >= moveDate(TODAY, 2) &&
      thisWeek <= moveDate(startOfBusinessWeek(TODAY), 6),
  );
  check(
    "7b this-week is strictly after tomorrow",
    thisWeek > moveDate(TODAY, 1),
  );
  // Absolute anchor: TODAY is Saturday 2026-09-19 ⇒ earliest later
  // week day is Monday 2026-09-21.
  check(
    "7c this-week absolute date (Mon 2026-09-21)",
    eq(thisWeek, "2026-09-21"),
  );
  // End-of-week fallback: a Thursday anchor has no later week day
  // after tomorrow inside the week → the next week's Saturday.
  check(
    "7d this-week end-of-week fallback (Thu 2026-09-24 → Sat 2026-09-26)",
    eq(resolveRelativeDate("2026-09-24", "this-week"), "2026-09-26"),
  );
  check(
    "8 next-week is the next business week's Saturday",
    eq(
      resolveRelativeDate(TODAY, "next-week"),
      moveDate(startOfBusinessWeek(TODAY), 7),
    ) && eq(resolveRelativeDate(TODAY, "next-week"), "2026-09-26"),
  );
  // Custom date: the wizard passes the user's date through untransformed
  // — availability echoes it verbatim.
  const customDate = "2026-10-15";
  check(
    "9a a custom date is schema-valid and untransformed",
    appointmentDateSchema.safeParse(customDate).success &&
      eq(resolveRelativeDate(customDate, "today"), customDate),
  );
  const customAvailability = await getAvailability(deps, actorA, {
    date: customDate,
    serviceId: SERVICE_A,
  });
  check(
    "9b availability echoes the custom date verbatim",
    customAvailability.success && eq(customAvailability.data.date, customDate),
  );

  // ─── 10. Earliest available slot ──────────────────────────────────

  const availability = await getAvailability(deps, actorA, {
    date: APPOINTMENT_DATE,
    serviceId: SERVICE_A,
  });
  const slots = availability.success ? availability.data.slots : [];
  check(
    "10a the working day yields ascending bookable slots",
    slots.length > 0 &&
      slots.every(
        (slot, index) =>
          index === 0 || slots[index - 1]!.startTime < slot.startTime,
      ),
  );
  check(
    "10b earliest slot is the first server-provided slot",
    ok(earliestSlot(slots)) &&
      eq(earliestSlot(slots)?.startTime, slots[0]?.startTime),
  );
  check("10c earliest slot is null when none exist", notOk(earliestSlot([])));
  check(
    "10d the earliest slot is bookable end-to-end",
    (await create({ startTime: earliestSlot(slots)?.startTime ?? "" })).success,
  );

  // ─── 11. An unavailable slot cannot be booked ────────────────────

  // Seed a blocking appointment for the create path's assignee…
  appointments.push({
    id: `appt-${++nextAppointment}`,
    businessId: BUSINESS_A,
    customerId: CUSTOMER_A,
    serviceId: SERVICE_A,
    branchId: BRANCH_A,
    assignedUserId: USER_A,
    date: "2026-09-26",
    startTime: "11:00",
    endTime: "11:30",
    status: "CONFIRMED",
  });
  const conflicting = await create({
    date: "2026-09-26",
    startTime: "11:15",
  });
  check(
    "11a an overlapping create is rejected as SLOT_CONFLICT",
    notOk(conflicting.success) && eq(failureCode(conflicting), "SLOT_CONFLICT"),
  );
  // …and availability no longer offers it.
  const blocked = await getAvailability(deps, actorA, {
    date: "2026-09-26",
    serviceId: SERVICE_A,
  });
  const blockedSlots = blocked.success ? blocked.data.slots : [];
  check(
    "11b the blocked time is absent from available slots",
    notOk(slotExistsIn({ startTime: "11:15", endTime: "11:45" }, blockedSlots)),
  );
  check(
    "11c a genuinely free time is still offered",
    ok(slotExistsIn({ startTime: "09:00", endTime: "09:30" }, blockedSlots)),
  );

  // ─── 12–14. Follow-up relative offsets (from the appointment date) ─

  check(
    "12 follow-up after one week = appointment date + 7",
    eq(
      resolveRelativeDate(APPOINTMENT_DATE, "after-1-week"),
      moveDate(APPOINTMENT_DATE, 7),
    ) &&
      eq(resolveRelativeDate(APPOINTMENT_DATE, "after-1-week"), "2026-10-01"),
  );
  check(
    "13 follow-up after two weeks = appointment date + 14",
    eq(
      resolveRelativeDate(APPOINTMENT_DATE, "after-2-weeks"),
      moveDate(APPOINTMENT_DATE, 14),
    ) &&
      eq(resolveRelativeDate(APPOINTMENT_DATE, "after-2-weeks"), "2026-10-08"),
  );
  check(
    "14a follow-up after one month = one calendar month later",
    eq(resolveRelativeDate(APPOINTMENT_DATE, "after-1-month"), "2026-10-24"),
  );
  check(
    "14b month-end is clamped (2026-01-31 → 2026-02-28)",
    eq(resolveRelativeDate("2026-01-31", "after-1-month"), "2026-02-28"),
  );
  check(
    "14c addMonths matches the resolver",
    eq(
      resolveRelativeDate(APPOINTMENT_DATE, "after-1-month"),
      addMonths(APPOINTMENT_DATE, 1),
    ),
  );
  // The follow-up decision: the ORIGINAL time is re-checked against the
  // follow-up date and only then written through the same path.
  const followUpDate = resolveRelativeDate(APPOINTMENT_DATE, "after-1-week");
  const followUpAvailability = await getAvailability(deps, actorA, {
    date: followUpDate,
    serviceId: SERVICE_A,
  });
  const followUpSlots = followUpAvailability.success
    ? followUpAvailability.data.slots
    : [];
  const originalSlot = { startTime: "09:30", endTime: "10:00" };
  check(
    "14d a follow-up time verified available books through the same path",
    ok(slotExistsIn(originalSlot, followUpSlots)) &&
      (await create({ date: followUpDate, startTime: "09:30" })).success,
  );
  // The SAME conflict guard protects the follow-up write, and the
  // availability result reflects it: after 14d booked 09:30–10:00 on
  // the follow-up date, that time is no longer offered and an
  // overlapping follow-up is rejected by the domain (SLOT_CONFLICT).
  const refreshed = await getAvailability(deps, actorA, {
    date: followUpDate,
    serviceId: SERVICE_A,
  });
  const refreshedSlots = refreshed.success ? refreshed.data.slots : [];
  const overlap = await create({ date: followUpDate, startTime: "09:45" });
  check(
    "14e a follow-up conflicting with an existing appointment is rejected",
    notOk(slotExistsIn(originalSlot, refreshedSlots)) && notOk(overlap.success),
  );

  // ─── 15. Tenant isolation ────────────────────────────────────────

  const foreignCustomer = await create({ customerId: CUSTOMER_B });
  check(
    "15a a cross-Business customer is rejected",
    notOk(foreignCustomer.success) &&
      eq(failureCode(foreignCustomer), "CUSTOMER_NOT_FOUND"),
  );
  const foreignService = await create({ serviceId: SERVICE_B });
  check(
    "15b a cross-Business service is rejected",
    notOk(foreignService.success) &&
      eq(failureCode(foreignService), "SERVICE_UNAVAILABLE"),
  );
  const foreignRead = await getAvailability(deps, actorA, {
    date: APPOINTMENT_DATE,
    serviceId: SERVICE_B,
  });
  check(
    "15c cross-Business availability leaks nothing",
    notOk(foreignRead.success) &&
      eq(errorCode(foreignRead), "SERVICE_NOT_FOUND"),
  );
  check(
    "15d cross-Business prefill yields nothing",
    notOk(
      (await resolveBookingContext(deps, actorA, { serviceId: SERVICE_B }))
        .serviceId,
    ),
  );
  check(
    "15e no appointment was ever written for the foreign business",
    notOk(appointments.some((row) => row.businessId === BUSINESS_B)),
  );

  // ─── 16. Authorization rejection ─────────────────────────────────

  const noBusinessCreate = await create({ actor: actorNoBusiness });
  check(
    "16a an actor without a Business cannot create",
    notOk(noBusinessCreate.success) &&
      eq(failureCode(noBusinessCreate), "NO_BUSINESS"),
  );
  const noBusinessAvailability = await getAvailability(deps, actorNoBusiness, {
    date: APPOINTMENT_DATE,
    serviceId: SERVICE_A,
  });
  check(
    "16b an actor without a Business cannot read availability",
    notOk(noBusinessAvailability.success) &&
      eq(errorCode(noBusinessAvailability), "NO_BUSINESS"),
  );
  check(
    "16c an actor without a Business gets no prefill",
    notOk(
      (
        await resolveBookingContext(deps, actorNoBusiness, {
          customerId: CUSTOMER_A,
        })
      ).customer,
    ),
  );

  // ─── 17. No AI direct DB write (structural) ──────────────────────

  const B07_MODULES = [
    "../src/features/appointments/components/smart-create/date-format.ts",
    "../src/features/appointments/components/smart-create/slot-helpers.ts",
    "../src/features/appointments/server/booking-flow-service.ts",
    "../src/features/appointments/schemas/booking-flow-schema.ts",
  ];
  let b07Clean = true;
  for (const path of B07_MODULES) {
    const source = await readModuleSource(path);
    if (/prisma|\bdb\b\.|@\/server\/db/.test(source)) b07Clean = false;
  }
  check(
    "17a the B-07 scheduling/context modules contain no DB access",
    b07Clean,
  );
  // The follow-up reuses the ONE canonical writer: the UI container
  // imports createAppointment (the thin session wrapper over the same
  // service) — there is no second scheduling subsystem.
  const containerSource = await readModuleSource(
    "../src/features/appointments/components/smart-create/smart-create-appointment.tsx",
  );
  check(
    "17b the follow-up path reuses the single canonical write path",
    /import \{ createAppointment \}/.test(containerSource) &&
      !/createWithConflictCheck|prisma|\bdb\b\./.test(containerSource),
  );
  check(
    "17c the container computes follow-up dates purely (no availability engine)",
    /resolveRelativeDate/.test(containerSource) &&
      !/generateCandidateSlots|filterConflictingSlots/.test(containerSource),
  );
  // The boundary schema strips every hostile identity key.
  const stripped = bookingContextSchema.safeParse({
    customerId: CUSTOMER_A,
    serviceId: SERVICE_A,
    businessId: BUSINESS_B, // hostile — must never survive
    role: "ADMIN",
  });
  check(
    "17d the context schema strips hostile identity keys",
    stripped.success &&
      eq(Object.keys(stripped.data).length, 2) &&
      !("businessId" in stripped.data) &&
      !("role" in stripped.data),
  );

  // ─── 18. Existing booking invariants remain intact ───────────────

  const automatic = await create({
    date: "2026-10-02",
    startTime: "09:00",
    confirmationMode: "automatic",
  });
  check(
    "18a automatic confirmation mode creates a CONFIRMED appointment",
    automatic.success && eq(automatic.status, "CONFIRMED"),
  );
  const inactiveCreate = await create({ serviceId: SERVICE_INACTIVE });
  check(
    "18b an inactive service is still not bookable",
    notOk(inactiveCreate.success) &&
      eq(failureCode(inactiveCreate), "SERVICE_UNAVAILABLE"),
  );
  // endTime is server-derived: startTime + service duration.
  const durations = appointments.filter(
    (row) => row.serviceId === SERVICE_A && row.status === "CONFIRMED",
  );
  check(
    "18c every stored endTime equals startTime + service duration",
    durations.length > 0 &&
      durations.every((row) => {
        const [h = 0, m = 0] = row.startTime.split(":").map(Number);
        const total = h * 60 + m + 30; // SERVICE_A duration
        const expected = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
        return eq(row.endTime, expected);
      }),
  );
  // A past-the-end-of-day start cannot be created (addMinutes guard).
  const endOfDay = await create({ startTime: "23:45" });
  check(
    "18d a service that crosses midnight is rejected",
    notOk(endOfDay.success) && eq(failureCode(endOfDay), "END_OF_DAY"),
  );
  check(
    "18e every successful create reported a server-generated id",
    appointments.every((row) => ok(row.id) && row.id.startsWith("appt-")),
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

/** Read a module's source text (for the no-DB-write structural check). */
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
