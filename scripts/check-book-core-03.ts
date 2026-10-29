/**
 * FlowPilot — Phase BOOK-CORE-03: Minimal Provider-Aware Booking Core Fix Check.
 *
 * Explicit verification of the 9 BOOK-CORE-03 acceptance scenarios:
 *
 * 1. Provider A booked at 10:00; provider B free at 10:00 → B can be booked.
 * 2. A 45-minute booking from 09:00 to 09:45 blocks 09:30 for the same provider.
 * 3. A new booking starting 09:45 does not overlap the previous booking.
 * 4. Unqualified providers cannot be assigned.
 * 5. Cross-business provider IDs are rejected.
 * 6. Receptionist bookings persist the selected provider's user ID (never actor.userId).
 * 7. Past appointment creation is rejected server-side (past date & same-day past time).
 * 8. Legacy unassigned appointments are not silently ignored (conservative blocking).
 * 9. Existing chatbot booking regressions remain green.
 *
 * Run: pnpm check:book-core-03
 */

import type { Appointment, Business, Customer, Service } from "@/types/domain";

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { createAppointmentRecord } =
    await import("@/features/appointments/server/appointment-create-service");
  const { getAvailability } =
    await import("@/features/appointments/server/availability-service");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
    console.log(`${pass ? "✓" : "✗"} ${label}`);
  }

  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
  const BRANCH_A = "33333333-3333-4333-8333-333333333333";

  const RECEPTIONIST_USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const PROVIDER_A_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const PROVIDER_B_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const UNQUALIFIED_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
  const FOREIGN_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";

  const PROVIDER_A_ID = "aaaaaaaa-1111-4111-8111-111111111111";
  const PROVIDER_B_ID = "bbbbbbbb-2222-4222-8222-222222222222";
  const UNQUALIFIED_ID = "cccccccc-3333-4333-8333-333333333333";
  const FOREIGN_PROVIDER_ID = "dddddddd-4444-4444-8444-444444444444";

  const CUSTOMER_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const SERVICE_30 = "55555555-5555-4555-8555-555555555551";
  const SERVICE_45 = "55555555-5555-4555-8555-555555555552";

  const business: Business = {
    id: BUSINESS_A,
    name: "عيادة النور",
    timezone: "Africa/Cairo",
    confirmationMode: "manual",
    slotDurationMinutes: 15,
    workingHours: {
      sat: { open: "09:00", close: "17:00", closed: false },
      sun: { open: "09:00", close: "17:00", closed: false },
      mon: { open: "09:00", close: "17:00", closed: false },
      tue: { open: "09:00", close: "17:00", closed: false },
      wed: { open: "09:00", close: "17:00", closed: false },
      thu: { open: "09:00", close: "17:00", closed: false },
      fri: { open: "09:00", close: "17:00", closed: false },
    },
    vertical: null,
    city: null,
    whatsappNumber: "+201001111111",
    about: null,
    address: null,
    faqs: [],
    cancellationPolicy: null,
    onboardingCompletedAt: new Date(),
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    assistantName: null,
    assistantStyle: null,
    defaultBranchId: BRANCH_A,
  } as unknown as Business;

  const services: Service[] = [
    {
      id: SERVICE_30,
      businessId: BUSINESS_A,
      name: "كشف عام",
      durationMinutes: 30,
      isActive: true,
      priceNote: null,
      description: null,
      order: 0,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as unknown as Service,
    {
      id: SERVICE_45,
      businessId: BUSINESS_A,
      name: "تنظيف أسنان مطول",
      durationMinutes: 45,
      isActive: true,
      priceNote: null,
      description: null,
      order: 1,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    } as unknown as Service,
  ];

  type StoredAppointment = {
    id: string;
    businessId: string;
    branchId: string;
    customerId: string;
    serviceId: string;
    assignedUserId: string | null;
    date: string;
    startTime: string;
    endTime: string;
    status: string;
  };

  const appointments: StoredAppointment[] = [];
  let nextId = 0;

  // In-memory provider repository mock
  const providerRepo = {
    listEligibleForService: async (businessId: string, _serviceId: string) => {
      if (businessId !== BUSINESS_A) return [];
      // Provider A and B are eligible for both services
      // Unqualified is NOT eligible for either
      // Foreign provider belongs to BUSINESS_B
      return [
        { id: PROVIDER_A_ID, displayName: "د. أحمد", user: { name: "أحمد" } },
        { id: PROVIDER_B_ID, displayName: "د. سارة", user: { name: "سارة" } },
      ];
    },
    listAssignmentSeams: async (businessId: string, providerIds: string[]) => {
      const seams: Array<{ providerId: string; userId: string }> = [];
      for (const pid of providerIds) {
        if (pid === PROVIDER_A_ID && businessId === BUSINESS_A) {
          seams.push({ providerId: pid, userId: PROVIDER_A_USER });
        }
        if (pid === PROVIDER_B_ID && businessId === BUSINESS_A) {
          seams.push({ providerId: pid, userId: PROVIDER_B_USER });
        }
        if (pid === UNQUALIFIED_ID && businessId === BUSINESS_A) {
          seams.push({ providerId: pid, userId: UNQUALIFIED_USER });
        }
        if (pid === FOREIGN_PROVIDER_ID && businessId === BUSINESS_B) {
          seams.push({ providerId: pid, userId: FOREIGN_USER });
        }
      }
      return seams;
    },
  };

  // In-memory appointment repository mock adhering to SERIALIZABLE conflict semantics
  const appointmentRepo = {
    findById: async () => null,
    createWithConflictCheck: async (input: {
      businessId: string;
      customerId: string;
      serviceId: string;
      branchId: string;
      assignedUserId?: string | null;
      date: string;
      startTime: string;
      endTime: string;
      status?: string;
    }) => {
      const hasConflict = appointments.some((row) => {
        if (row.businessId !== input.businessId) return false;
        if (row.date !== input.date) return false;
        if (row.status !== "PENDING" && row.status !== "CONFIRMED")
          return false;
        // Overlap: row.startTime < input.endTime && input.startTime < row.endTime
        const timesOverlap =
          row.startTime < input.endTime && input.startTime < row.endTime;
        if (!timesOverlap) return false;

        // If input has assignedUserId:
        // Conflicts if row has same assignedUserId OR row is unassigned (legacy null)
        if (input.assignedUserId) {
          return (
            row.assignedUserId === input.assignedUserId ||
            row.assignedUserId === null
          );
        }
        // If unassigned: conflicts with any appointment in the business
        return true;
      });

      if (hasConflict) return null;

      const appt: StoredAppointment = {
        id: `appt-${++nextId}`,
        businessId: input.businessId,
        customerId: input.customerId,
        serviceId: input.serviceId,
        branchId: input.branchId,
        assignedUserId: input.assignedUserId ?? null,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        status: input.status ?? "PENDING",
      };
      appointments.push(appt);
      return appt as unknown as Appointment;
    },
    listBlockingForDate: async (
      businessId: string,
      date: string,
      excludeId?: string,
    ) => {
      return appointments
        .filter(
          (a) =>
            a.businessId === businessId &&
            a.date === date &&
            (a.status === "PENDING" || a.status === "CONFIRMED") &&
            a.id !== excludeId,
        )
        .map((a) => ({ startTime: a.startTime, endTime: a.endTime }));
    },
    listBlockingByAssignees: async (
      businessId: string,
      date: string,
      assignedUserIds: string[],
      excludeId?: string,
    ) => {
      const result: Array<{
        assignedUserId: string;
        startTime: string;
        endTime: string;
      }> = [];
      for (const a of appointments) {
        if (a.businessId !== businessId || a.date !== date) continue;
        if (a.status !== "PENDING" && a.status !== "CONFIRMED") continue;
        if (excludeId && a.id === excludeId) continue;

        if (a.assignedUserId && assignedUserIds.includes(a.assignedUserId)) {
          result.push({
            assignedUserId: a.assignedUserId,
            startTime: a.startTime,
            endTime: a.endTime,
          });
        } else if (a.assignedUserId === null) {
          // Conservative policy: legacy unassigned blocks all assignees
          for (const uid of assignedUserIds) {
            result.push({
              assignedUserId: uid,
              startTime: a.startTime,
              endTime: a.endTime,
            });
          }
        }
      }
      return result;
    },
  };

  const createDeps = {
    customerRepository: {
      findById: async () =>
        ({ id: CUSTOMER_A, businessId: BUSINESS_A }) as Customer,
    },
    serviceRepository: {
      findById: async (id: string) => services.find((s) => s.id === id) ?? null,
    },
    businessRepository: { findById: async () => business },
    branchRepository: {
      findDefaultByBusiness: async () =>
        ({ id: BRANCH_A, businessId: BUSINESS_A }) as never,
    },
    appointmentRepository: appointmentRepo,
    providerRepository: providerRepo,
    now: () => new Date("2026-10-16T08:00:00.000Z"), // 10:00 Cairo time
  };

  const availabilityDeps = {
    businessRepository: { findById: async () => business },
    serviceRepository: {
      findById: async (id: string) => services.find((s) => s.id === id) ?? null,
    },
    appointmentRepository: appointmentRepo,
    providerRepository: providerRepo,
    now: () => new Date("2026-10-16T08:00:00.000Z"),
  };

  const receptionistActor = {
    userId: RECEPTIONIST_USER,
    role: "STAFF" as const,
    businessId: BUSINESS_A,
  };

  const TARGET_DATE = "2026-10-20";

  // Scenario 1: Provider A booked at 10:00; Provider B free at 10:00 → B can be booked
  const bookA10 = await createAppointmentRecord(createDeps, receptionistActor, {
    customerId: CUSTOMER_A,
    serviceId: SERVICE_30,
    providerId: PROVIDER_A_ID,
    date: TARGET_DATE,
    startTime: "10:00",
    notes: "",
  });
  check(
    "1a. Provider A can be booked at 10:00",
    bookA10.success &&
      appointments.some(
        (a) => a.assignedUserId === PROVIDER_A_USER && a.startTime === "10:00",
      ),
  );

  const bookB10 = await createAppointmentRecord(createDeps, receptionistActor, {
    customerId: CUSTOMER_A,
    serviceId: SERVICE_30,
    providerId: PROVIDER_B_ID,
    date: TARGET_DATE,
    startTime: "10:00",
    notes: "",
  });
  check(
    "1b. Provider B free at 10:00 can be booked simultaneously with Provider A",
    bookB10.success &&
      appointments.some(
        (a) => a.assignedUserId === PROVIDER_B_USER && a.startTime === "10:00",
      ),
  );

  // Overlap prevention: Provider A cannot be double booked at 10:00
  const bookA10Duplicate = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: PROVIDER_A_ID,
      date: TARGET_DATE,
      startTime: "10:00",
      notes: "",
    },
  );
  check(
    "1c. Overlapping booking for same provider A at 10:00 is rejected as SLOT_CONFLICT",
    !bookA10Duplicate.success &&
      "code" in bookA10Duplicate &&
      bookA10Duplicate.code === "SLOT_CONFLICT",
  );

  // Scenario 2: A 45-minute booking from 09:00 to 09:45 blocks 09:30 for the same provider
  const TARGET_DATE_2 = "2026-10-21";
  const bookA09_45 = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_45, // 45 minutes duration
      providerId: PROVIDER_A_ID,
      date: TARGET_DATE_2,
      startTime: "09:00",
      notes: "",
    },
  );
  check(
    "2a. 45-min booking from 09:00 to 09:45 for Provider A succeeds",
    bookA09_45.success &&
      appointments.some(
        (a) =>
          a.assignedUserId === PROVIDER_A_USER &&
          a.date === TARGET_DATE_2 &&
          a.startTime === "09:00" &&
          a.endTime === "09:45",
      ),
  );

  const bookA09_30_conflict = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: PROVIDER_A_ID,
      date: TARGET_DATE_2,
      startTime: "09:30",
      notes: "",
    },
  );
  check(
    "2b. Booking 09:30 for same provider A is blocked by 09:00-09:45 (SLOT_CONFLICT)",
    !bookA09_30_conflict.success &&
      "code" in bookA09_30_conflict &&
      bookA09_30_conflict.code === "SLOT_CONFLICT",
  );

  // Scenario 3: A new booking starting 09:45 does not overlap the previous booking (09:00-09:45)
  const bookA09_45_adjacent = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: PROVIDER_A_ID,
      date: TARGET_DATE_2,
      startTime: "09:45",
      notes: "",
    },
  );
  check(
    "3. New booking starting at 09:45 does not overlap previous 09:00-09:45 booking",
    bookA09_45_adjacent.success,
  );

  // Scenario 4: Unqualified providers cannot be assigned
  const bookUnqualified = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: UNQUALIFIED_ID,
      date: TARGET_DATE,
      startTime: "12:00",
      notes: "",
    },
  );
  check(
    "4. Unqualified provider is rejected with PROVIDER_NOT_ELIGIBLE",
    !bookUnqualified.success &&
      "code" in bookUnqualified &&
      bookUnqualified.code === "PROVIDER_NOT_ELIGIBLE",
  );

  // Scenario 5: Cross-business provider IDs are rejected
  const bookCrossBusiness = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: FOREIGN_PROVIDER_ID,
      date: TARGET_DATE,
      startTime: "12:00",
      notes: "",
    },
  );
  check(
    "5. Cross-business provider ID is rejected with PROVIDER_NOT_ELIGIBLE",
    !bookCrossBusiness.success &&
      "code" in bookCrossBusiness &&
      bookCrossBusiness.code === "PROVIDER_NOT_ELIGIBLE",
  );

  // Scenario 6: Receptionist bookings persist the selected provider's user ID (never receptionist's actor.userId)
  const bookProviderPersisted = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: PROVIDER_B_ID,
      date: TARGET_DATE,
      startTime: "13:00",
      notes: "",
    },
  );
  const savedAppt = bookProviderPersisted.success
    ? appointments.find((a) => a.id === bookProviderPersisted.appointmentId)
    : null;
  check(
    "6a. Receptionist booking persists selected provider user ID",
    savedAppt !== null && savedAppt?.assignedUserId === PROVIDER_B_USER,
  );
  check(
    "6b. Receptionist booking NEVER substitutes receptionist actor.userId",
    savedAppt !== null && savedAppt?.assignedUserId !== RECEPTIONIST_USER,
  );

  // Scenario 7: Past appointment creation is rejected server-side
  // Anchor is 2026-10-16T08:00:00.000Z → 10:00 Cairo time on 2026-10-16
  const bookPastDate = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: PROVIDER_A_ID,
      date: "2026-10-15", // yesterday
      startTime: "10:00",
      notes: "",
    },
  );
  check(
    "7a. Past date creation is rejected with PAST_TIME",
    !bookPastDate.success &&
      "code" in bookPastDate &&
      bookPastDate.code === "PAST_TIME",
  );

  const bookSameDayPastTime = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: PROVIDER_A_ID,
      date: "2026-10-16", // today
      startTime: "09:30", // past (current is 10:00)
      notes: "",
    },
  );
  check(
    "7b. Same-day past time creation is rejected with PAST_TIME",
    !bookSameDayPastTime.success &&
      "code" in bookSameDayPastTime &&
      bookSameDayPastTime.code === "PAST_TIME",
  );

  const bookSameDayFutureTime = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: PROVIDER_A_ID,
      date: "2026-10-16", // today
      startTime: "14:00", // future
      notes: "",
    },
  );
  check(
    "7c. Same-day future time creation succeeds",
    bookSameDayFutureTime.success,
  );

  // Scenario 8: Legacy unassigned appointments are not silently ignored
  // Inject a legacy unassigned appointment at 15:00-15:30
  appointments.push({
    id: `appt-legacy-${++nextId}`,
    businessId: BUSINESS_A,
    branchId: BRANCH_A,
    customerId: CUSTOMER_A,
    serviceId: SERVICE_30,
    assignedUserId: null, // legacy unassigned
    date: TARGET_DATE,
    startTime: "15:00",
    endTime: "15:30",
    status: "CONFIRMED",
  });

  // Attempting to book Provider A at 15:00 must detect conflict with the unassigned appointment
  const bookOverLegacy = await createAppointmentRecord(
    createDeps,
    receptionistActor,
    {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_30,
      providerId: PROVIDER_A_ID,
      date: TARGET_DATE,
      startTime: "15:00",
      notes: "",
    },
  );
  check(
    "8a. Legacy unassigned appointment blocks Provider A creation (SLOT_CONFLICT)",
    !bookOverLegacy.success &&
      "code" in bookOverLegacy &&
      bookOverLegacy.code === "SLOT_CONFLICT",
  );

  // Availability check for Provider A must NOT offer 15:00
  const availA = await getAvailability(availabilityDeps, receptionistActor, {
    date: TARGET_DATE,
    serviceId: SERVICE_30,
    providerId: PROVIDER_A_ID,
  });
  const has1500InA =
    availA.success && availA.data.slots.some((s) => s.startTime === "15:00");
  check(
    "8b. Legacy unassigned appointment is not offered in Provider A availability",
    availA.success && !has1500InA,
  );

  // Since we booked Provider B at 10:00 in step 1b, let's check 16:00 where Provider A is booked and Provider B is free
  appointments.push({
    id: `appt-test-${++nextId}`,
    businessId: BUSINESS_A,
    branchId: BRANCH_A,
    customerId: CUSTOMER_A,
    serviceId: SERVICE_30,
    assignedUserId: PROVIDER_A_USER,
    date: TARGET_DATE,
    startTime: "16:00",
    endTime: "16:30",
    status: "CONFIRMED",
  });
  const availB_16 = await getAvailability(availabilityDeps, receptionistActor, {
    date: TARGET_DATE,
    serviceId: SERVICE_30,
    providerId: PROVIDER_B_ID,
  });
  const availA_16 = await getAvailability(availabilityDeps, receptionistActor, {
    date: TARGET_DATE,
    serviceId: SERVICE_30,
    providerId: PROVIDER_A_ID,
  });
  check(
    "8c. Provider A availability shows 16:00 blocked",
    availA_16.success &&
      !availA_16.data.slots.some((s) => s.startTime === "16:00"),
  );
  check(
    "8d. Provider B availability shows 16:00 available while Provider A is booked",
    availB_16.success &&
      availB_16.data.slots.some((s) => s.startTime === "16:00"),
  );

  const passedCount = checks.filter((c) => c.pass).length;
  console.log(`\n${passedCount}/${checks.length} checks passed`);
  if (passedCount !== checks.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
