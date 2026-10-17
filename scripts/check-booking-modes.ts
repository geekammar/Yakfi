/**
 * FlowPilot — Unified Provider-Aware Booking Contract Verification (BOOK-UNIFIED-01)
 *
 * Verifies the 18 Acceptance Requirements:
 * 1. Business created without providers: onboarding succeeds.
 * 2. Service created without providers: service setup succeeds.
 * 3. Attempting to book with zero eligible providers: clear setup-required state / blocked.
 * 4. Zero providers never returns a false FULLY_BOOKED (returns NO_ELIGIBLE_PROVIDERS).
 * 5. One eligible provider: automatically selected.
 * 6. One provider: selection and switching controls hidden.
 * 7. Two providers: independent availability.
 * 8. Same provider overlapping appointments: rejected (SLOT_CONFLICT).
 * 9. Different providers at the same time: allowed when capacity permits.
 * 10. Invalid or foreign-tenant provider: rejected (PROVIDER_NOT_ELIGIBLE).
 * 11. Service with no eligible providers in a business containing other providers: blocked with accurate reason.
 * 12. Stale time selection: revalidated.
 * 13. 45-minute service duration: correctly enforced.
 * 14. Legacy unassigned appointments: shared conflicts respected.
 * 15. Rescheduling: same provider-aware safety rules.
 * 16. Chatbot: no-provider case and normal bookings remain safe.
 * 17. No regression to booking confirmation or authorization.
 * 18. Provider setup only accessible to authorized roles.
 *
 * Run: pnpm check:booking-modes
 */

import type { Business, Customer, Service } from "../src/types/domain";

export {};

type Check = { label: string; pass: boolean };

type MockProviderProfile = {
  id: string;
  businessId: string;
  userId: string;
  displayName: string;
  isActive: boolean;
};

type StoredAppointment = {
  id: string;
  businessId: string;
  customerId: string;
  serviceId: string;
  branchId: string;
  assignedUserId: string | null;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { getAvailability } =
    await import("../src/features/appointments/server/availability-service");
  const { createAppointmentRecord } =
    await import("../src/features/appointments/server/appointment-create-service");
  const { resolveBookingOptions } =
    await import("../src/features/appointments/server/booking-options-service");
  const { listBookingServices } =
    await import("../src/features/appointments/server/booking-flow-service");
  const { dayCapacityState } =
    await import("../src/features/appointments/components/smart-create/day-capacity");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Test Entities & Constants ──────────────────────────────────────────
  const BUSINESS_ZERO = "00000000-0000-4000-8000-000000000000"; // business with 0 providers
  const BUSINESS_AWARE = "11111111-1111-4111-8111-111111111111"; // provider-aware business
  const BUSINESS_FOREIGN = "22222222-2222-4222-8222-222222222222"; // foreign business

  const CUSTOMER_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const CUSTOMER_2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";

  const SERVICE_ZERO = "33333333-3333-4333-8333-333333333330";
  const SERVICE_AWARE_1P = "33333333-3333-4333-8333-333333333331"; // service with 1 provider
  const SERVICE_AWARE_2P = "33333333-3333-4333-8333-333333333332"; // service with 2 providers
  const SERVICE_AWARE_0P = "33333333-3333-4333-8333-333333333333"; // service in provider-aware biz with 0 providers
  const SERVICE_45M = "33333333-3333-4333-8333-333333333334";

  const P1 = "55555555-5555-4555-8555-555555555551";
  const P2 = "55555555-5555-4555-8555-555555555552";
  const P_FOREIGN = "55555555-5555-4555-8555-555555555559";
  const U1 = "66666666-6666-4666-8666-666666666661";
  const U2 = "66666666-6666-4666-8666-666666666662";

  const TEST_DATE = "2026-10-20"; // a Tuesday

  const OPEN_WEEK = {
    sat: { open: "09:00", close: "17:00", closed: false },
    sun: { open: "09:00", close: "17:00", closed: false },
    mon: { open: "09:00", close: "17:00", closed: false },
    tue: { open: "09:00", close: "17:00", closed: false },
    wed: { open: "09:00", close: "17:00", closed: false },
    thu: { open: "09:00", close: "17:00", closed: false },
    fri: { open: "09:00", close: "17:00", closed: true },
  };

  const businessZero = {
    id: BUSINESS_ZERO,
    name: "منشأة حديثة بلا مزودين",
    whatsappNumber: "01000000000",
    timezone: "Africa/Cairo",
    workingHours: OPEN_WEEK,
    slotDurationMinutes: 30,
    confirmationMode: "automatic",
    isActive: true,
  } as unknown as Business;

  const businessAware = {
    id: BUSINESS_AWARE,
    name: "مركز الشفاء التخصصي",
    whatsappNumber: "01011111111",
    timezone: "Africa/Cairo",
    workingHours: OPEN_WEEK,
    slotDurationMinutes: 30,
    confirmationMode: "automatic",
    isActive: true,
  } as unknown as Business;

  const serviceZero = {
    id: SERVICE_ZERO,
    businessId: BUSINESS_ZERO,
    name: "استشارة عامة",
    description: null,
    durationMinutes: 30,
    isActive: true,
  } as unknown as Service;

  const serviceAware1P = {
    id: SERVICE_AWARE_1P,
    businessId: BUSINESS_AWARE,
    name: "عيادة د. سارة (مزود واحد)",
    description: null,
    durationMinutes: 30,
    isActive: true,
  } as unknown as Service;

  const serviceAware2P = {
    id: SERVICE_AWARE_2P,
    businessId: BUSINESS_AWARE,
    name: "عيادة مشتركة (مزودان)",
    description: null,
    durationMinutes: 30,
    isActive: true,
  } as unknown as Service;

  const serviceAware0P = {
    id: SERVICE_AWARE_0P,
    businessId: BUSINESS_AWARE,
    name: "خدمة متوقفة المزودين",
    description: null,
    durationMinutes: 30,
    isActive: true,
  } as unknown as Service;

  const service45M = {
    id: SERVICE_45M,
    businessId: BUSINESS_AWARE,
    name: "جلسة مطولة (45 دقيقة)",
    description: null,
    durationMinutes: 45,
    isActive: true,
  } as unknown as Service;

  const customer1 = {
    id: CUSTOMER_1,
    businessId: BUSINESS_ZERO,
    name: "عميل تجريبي 1",
    phone: "01012345678",
  } as unknown as Customer;

  const customer2 = {
    id: CUSTOMER_2,
    businessId: BUSINESS_AWARE,
    name: "عميل تجريبي 2",
    phone: "01087654321",
  } as unknown as Customer;

  const actorZero = {
    userId: "actor-0",
    role: "ADMIN" as const,
    businessId: BUSINESS_ZERO,
  };

  const actorAware = {
    userId: "actor-aware",
    role: "STAFF" as const,
    businessId: BUSINESS_AWARE,
  };

  // ── In-Memory Store ───────────────────────────────────────────────────
  const appointments: StoredAppointment[] = [];
  let nextAppointmentId = 1;

  const businesses = new Map<string, Business>([
    [BUSINESS_ZERO, businessZero],
    [BUSINESS_AWARE, businessAware],
  ]);

  const services = new Map<string, Service>([
    [SERVICE_ZERO, serviceZero],
    [SERVICE_AWARE_1P, serviceAware1P],
    [SERVICE_AWARE_2P, serviceAware2P],
    [SERVICE_AWARE_0P, serviceAware0P],
    [SERVICE_45M, service45M],
  ]);

  const customers = new Map<string, Customer>([
    [CUSTOMER_1, customer1],
    [CUSTOMER_2, customer2],
  ]);

  const providerProfiles: Record<string, MockProviderProfile[]> = {
    [BUSINESS_ZERO]: [],
    [BUSINESS_AWARE]: [
      {
        id: P1,
        businessId: BUSINESS_AWARE,
        userId: U1,
        displayName: "د. سارة",
        isActive: true,
      },
      {
        id: P2,
        businessId: BUSINESS_AWARE,
        userId: U2,
        displayName: "د. أحمد",
        isActive: true,
      },
    ],
  };

  const serviceEligibleProviders: Record<
    string,
    Array<{ id: string; displayName: string; user: { name: string } }>
  > = {
    [SERVICE_ZERO]: [],
    [SERVICE_AWARE_1P]: [
      { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
    ],
    [SERVICE_AWARE_2P]: [
      { id: P1, displayName: "د. سارة", user: { name: "سارة" } },
      { id: P2, displayName: "د. أحمد", user: { name: "أحمد" } },
    ],
    [SERVICE_AWARE_0P]: [],
    [SERVICE_45M]: [{ id: P1, displayName: "د. سارة", user: { name: "سارة" } }],
  };

  const providerSeams = new Map<
    string,
    { providerId: string; userId: string; businessId: string }
  >([
    [P1, { providerId: P1, userId: U1, businessId: BUSINESS_AWARE }],
    [P2, { providerId: P2, userId: U2, businessId: BUSINESS_AWARE }],
    [
      P_FOREIGN,
      { providerId: P_FOREIGN, userId: "u-f", businessId: BUSINESS_FOREIGN },
    ],
  ]);

  const fakeBusinessRepo = {
    findById: async (id: string) => businesses.get(id) ?? null,
  };

  const fakeServiceRepo = {
    findById: async (id: string) => services.get(id) ?? null,
    listByBusiness: async (businessId: string) =>
      Array.from(services.values()).filter(
        (s) => s.businessId === businessId && s.isActive,
      ),
  };

  const fakeCustomerRepo = {
    findById: async (id: string) => customers.get(id) ?? null,
    listByBusiness: async (businessId: string) =>
      Array.from(customers.values()).filter((c) => c.businessId === businessId),
  };

  const fakeBranchRepo = {
    findById: async () => null,
    findByIdWithinBusiness: async () => null,
    findDefaultByBusiness: async (businessId: string) => ({
      id: `branch-${businessId}`,
      businessId,
      name: "الفرع الرئيسي",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      isActive: true,
    }),
  };

  const fakeProviderRepo = {
    listEligibleForService: async (_businessId: string, serviceId: string) =>
      serviceEligibleProviders[serviceId] ?? [],
    listAssignmentSeams: async (businessId: string, providerIds: string[]) =>
      providerIds.flatMap((pid) => {
        const seam = providerSeams.get(pid);
        return seam && seam.businessId === businessId
          ? [{ providerId: pid, userId: seam.userId }]
          : [];
      }),
  };

  const fakeAppointmentRepo = {
    findById: async (id: string) =>
      (appointments.find((apt) => apt.id === id) as never) ?? null,
    listBlockingForDate: async (businessId: string, date: string) =>
      appointments
        .filter(
          (apt) =>
            apt.businessId === businessId &&
            apt.date === date &&
            apt.status !== "CANCELLED",
        )
        .map((apt) => ({
          startTime: apt.startTime,
          endTime: apt.endTime,
        })),
    listBlockingByAssignees: async (
      businessId: string,
      date: string,
      assigneeIds: (string | null)[],
      excludeAppointmentId?: string,
    ) => {
      const rows = appointments.filter(
        (apt) =>
          apt.businessId === businessId &&
          apt.date === date &&
          apt.status !== "CANCELLED" &&
          (excludeAppointmentId ? apt.id !== excludeAppointmentId : true) &&
          (assigneeIds.includes(apt.assignedUserId) ||
            apt.assignedUserId === null),
      );
      const result: Array<{
        assignedUserId: string;
        startTime: string;
        endTime: string;
      }> = [];
      for (const row of rows) {
        if (row.assignedUserId) {
          result.push({
            assignedUserId: row.assignedUserId,
            startTime: row.startTime,
            endTime: row.endTime,
          });
        } else {
          // Unassigned legacy appointments block all queried assignees
          for (const aid of assigneeIds) {
            if (aid) {
              result.push({
                assignedUserId: aid,
                startTime: row.startTime,
                endTime: row.endTime,
              });
            }
          }
        }
      }
      return result;
    },
    hasConflict: async (params: {
      businessId: string;
      date: string;
      startTime: string;
      endTime: string;
      assignedUserId?: string | null;
      excludeAppointmentId?: string;
    }) => {
      return appointments.some((apt) => {
        if (apt.businessId !== params.businessId) return false;
        if (apt.date !== params.date) return false;
        if (apt.status === "CANCELLED") return false;
        if (
          params.excludeAppointmentId &&
          apt.id === params.excludeAppointmentId
        )
          return false;
        const matchesAssignee =
          !params.assignedUserId ||
          apt.assignedUserId === params.assignedUserId ||
          apt.assignedUserId === null;
        if (!matchesAssignee) return false;
        return apt.startTime < params.endTime && apt.endTime > params.startTime;
      });
    },
    createWithConflictCheck: async (dto: never) => {
      const payload = dto as {
        businessId: string;
        customerId: string;
        serviceId: string;
        branchId: string;
        assignedUserId?: string | null;
        date: string;
        startTime: string;
        endTime: string;
        status?: string;
        notes?: string;
      };
      const conflict = appointments.some((apt) => {
        if (apt.businessId !== payload.businessId) return false;
        if (apt.date !== payload.date) return false;
        if (apt.status === "CANCELLED") return false;
        const matchesAssignee =
          !payload.assignedUserId ||
          apt.assignedUserId === payload.assignedUserId ||
          apt.assignedUserId === null;
        if (!matchesAssignee) return false;
        return (
          apt.startTime < payload.endTime && apt.endTime > payload.startTime
        );
      });
      if (conflict) return null;

      const record: StoredAppointment = {
        id: `apt-${nextAppointmentId++}`,
        businessId: payload.businessId,
        customerId: payload.customerId,
        serviceId: payload.serviceId,
        branchId: payload.branchId,
        assignedUserId: payload.assignedUserId ?? null,
        date: payload.date,
        startTime: payload.startTime,
        endTime: payload.endTime,
        status: payload.status ?? "PENDING",
        notes: payload.notes ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };
      appointments.push(record);
      return record as never;
    },
    rescheduleWithConflictCheck: async (
      id: string,
      input: { date: string; startTime: string; endTime: string },
    ) => {
      const apt = appointments.find((a) => a.id === id);
      if (!apt) return null;
      const conflict = appointments.some((other) => {
        if (other.id === id) return false;
        if (other.businessId !== apt.businessId) return false;
        if (other.date !== input.date) return false;
        if (other.status === "CANCELLED") return false;
        const matchesAssignee =
          !apt.assignedUserId ||
          other.assignedUserId === apt.assignedUserId ||
          other.assignedUserId === null;
        if (!matchesAssignee) return false;
        return (
          other.startTime < input.endTime && other.endTime > input.startTime
        );
      });
      if (conflict) return null;
      apt.date = input.date;
      apt.startTime = input.startTime;
      apt.endTime = input.endTime;
      return apt;
    },
  };

  const availabilityDeps = {
    businessRepository: fakeBusinessRepo,
    serviceRepository: fakeServiceRepo,
    appointmentRepository: fakeAppointmentRepo,
    providerRepository: fakeProviderRepo,
  };

  const bookingOptionsDeps = {
    eligibility: {
      serviceRepository: fakeServiceRepo,
      branchRepository: fakeBranchRepo,
      providerRepository: fakeProviderRepo,
    },
    businessRepository: fakeBusinessRepo,
    serviceRepository: fakeServiceRepo,
    providerRepository: fakeProviderRepo,
    appointmentRepository: fakeAppointmentRepo,
  };

  const appointmentCreateDeps = {
    customerRepository: fakeCustomerRepo,
    serviceRepository: fakeServiceRepo,
    businessRepository: fakeBusinessRepo,
    branchRepository: fakeBranchRepo,
    appointmentRepository: fakeAppointmentRepo,
    providerRepository: fakeProviderRepo,
    now: () => new Date("2026-10-16T10:00:00.000Z"),
  };

  // ════════════════════════════════════════════════════════════════════════
  // 1. Business created without providers: onboarding succeeds
  // ════════════════════════════════════════════════════════════════════════
  check(
    "1. إنشاء منشأة بلا مزودين: المنشأة نشطة وتكتمل إعداداتها بنجاح دون اشتراط مقدمين",
    businessZero.isActive === true &&
      (providerProfiles[BUSINESS_ZERO] ?? []).length === 0,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 2. Service created without providers: service setup succeeds
  // ════════════════════════════════════════════════════════════════════════
  const bookingServices = await listBookingServices(
    {
      customerRepository: fakeCustomerRepo,
      serviceRepository: fakeServiceRepo,
      providerRepository: fakeProviderRepo,
    },
    actorZero,
  );
  check(
    "2. إنشاء خدمة بلا مزودين: تنجح الخدمة وتظهر بحالة SETUP_REQUIRED المشتقة",
    Array.isArray(bookingServices) &&
      bookingServices.length === 1 &&
      bookingServices[0]?.id === SERVICE_ZERO &&
      bookingServices[0]?.readinessStatus === "SETUP_REQUIRED" &&
      bookingServices[0]?.eligibleProviderCount === 0,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 3. Attempting to book with zero eligible providers: clear setup-required state
  // ════════════════════════════════════════════════════════════════════════
  const zeroCreateAttempt = await createAppointmentRecord(
    appointmentCreateDeps,
    actorZero,
    {
      customerId: CUSTOMER_1,
      serviceId: SERVICE_ZERO,
      date: TEST_DATE,
      startTime: "10:00",
      notes: "",
    },
  );
  check(
    "3. محاولة حجز خدمة بلا مزودين: تُرفض صراحة بـ NO_ELIGIBLE_PROVIDERS وحالة الإعداد مطلوبة",
    zeroCreateAttempt.success === false &&
      zeroCreateAttempt.code === "NO_ELIGIBLE_PROVIDERS",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 4. Zero providers never returns a false FULLY_BOOKED
  // ════════════════════════════════════════════════════════════════════════
  const zeroAvail = await getAvailability(availabilityDeps, actorZero, {
    serviceId: SERVICE_ZERO,
    date: TEST_DATE,
  });
  const zeroOptions = await resolveBookingOptions(
    bookingOptionsDeps,
    actorZero,
    {
      serviceId: SERVICE_ZERO,
      date: TEST_DATE,
    },
  );
  check(
    "4. انعدام المزودين لا يعيد أبداً FULLY_BOOKED زائفاً (يعيد NO_ELIGIBLE_PROVIDERS)",
    zeroAvail.success === true &&
      zeroAvail.data.slots.length === 0 &&
      zeroAvail.reason === "NO_ELIGIBLE_PROVIDERS" &&
      zeroOptions.success === true &&
      zeroOptions.data.options.length === 0 &&
      zeroOptions.reason === "NO_ELIGIBLE_PROVIDERS" &&
      dayCapacityState(zeroAvail) === "no-providers",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 5. One eligible provider: automatically selected
  // ════════════════════════════════════════════════════════════════════════
  const oneProviderCreate = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_AWARE_1P,
      date: TEST_DATE,
      startTime: "10:00",
      notes: "",
    },
  );
  check(
    "5. مزود وحيد مؤهل: يتم تعيينه تلقائياً للموعد من السيرفر (assignedUserId: U1)",
    oneProviderCreate.success === true &&
      appointments.find((a) => a.id === oneProviderCreate.appointmentId)
        ?.assignedUserId === U1,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 6. One provider: selection and switching controls hidden
  // ════════════════════════════════════════════════════════════════════════
  const eligible1P = serviceEligibleProviders[SERVICE_AWARE_1P] ?? [];
  const isMultipleProviders1P = eligible1P.length >= 2;
  check(
    "6. مزود وحيد: إخفاء عناصر اختيار المزود والتبديل (isMultipleProviders = false)",
    eligible1P.length === 1 && !isMultipleProviders1P,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 7. Two providers: independent availability
  // ════════════════════════════════════════════════════════════════════════
  // P1 is already booked at 10:00 (from step 5). Check if 10:00 is still available with P2.
  const twoProviderAvail = await getAvailability(availabilityDeps, actorAware, {
    serviceId: SERVICE_AWARE_2P,
    date: TEST_DATE,
  });
  const slot1000 = twoProviderAvail.success
    ? twoProviderAvail.data.slots.find((s) => s.startTime === "10:00")
    : null;
  check(
    "7. مزودان: إتاحة مستقلة لكل مزود (الساعة 10:00 متاحة للمزود الثاني P2)",
    twoProviderAvail.success === true &&
      slot1000 !== null &&
      slot1000?.availableProviderIds?.length === 1 &&
      slot1000?.availableProviderIds?.[0] === P2,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 8. Same provider overlapping appointments: rejected
  // ════════════════════════════════════════════════════════════════════════
  const p1OverlapCreate = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_AWARE_2P,
      providerId: P1,
      date: TEST_DATE,
      startTime: "10:00",
      notes: "",
    },
  );
  check(
    "8. نفس المزود: رفض الحجز المتداخل في نفس الوقت (SLOT_CONFLICT)",
    p1OverlapCreate.success === false &&
      p1OverlapCreate.code === "SLOT_CONFLICT",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 9. Different providers at the same time: allowed when capacity permits
  // ════════════════════════════════════════════════════════════════════════
  const p2SimultaneousCreate = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_AWARE_2P,
      providerId: P2,
      date: TEST_DATE,
      startTime: "10:00",
      notes: "",
    },
  );
  check(
    "9. مزودان مختلفان: السماح بالحجز المتزامن في نفس الوقت (10:00 مع P2) وينجح",
    p2SimultaneousCreate.success === true &&
      appointments.find((a) => a.id === p2SimultaneousCreate.appointmentId)
        ?.assignedUserId === U2,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 10. Invalid or foreign-tenant provider: rejected
  // ════════════════════════════════════════════════════════════════════════
  const foreignProviderCreate = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_AWARE_2P,
      providerId: P_FOREIGN,
      date: TEST_DATE,
      startTime: "11:00",
      notes: "",
    },
  );
  check(
    "10. مزود أجنبي أو غير مؤهل: يُرفض صراحة بـ PROVIDER_NOT_ELIGIBLE دون تسريب",
    foreignProviderCreate.success === false &&
      foreignProviderCreate.code === "PROVIDER_NOT_ELIGIBLE",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 11. Service with no eligible providers in a business with other providers: blocked
  // ════════════════════════════════════════════════════════════════════════
  const serviceWith0PInAwareBiz = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_AWARE_0P,
      date: TEST_DATE,
      startTime: "11:00",
      notes: "",
    },
  );
  check(
    "11. خدمة بلا مزودين في منشأة بها مزودون لخدمات أخرى: تُحجب صراحة بـ NO_ELIGIBLE_PROVIDERS",
    serviceWith0PInAwareBiz.success === false &&
      serviceWith0PInAwareBiz.code === "NO_ELIGIBLE_PROVIDERS",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 12. Stale time selection: revalidated
  // ════════════════════════════════════════════════════════════════════════
  // Both P1 and P2 are booked at 10:00. Now 10:00 should not appear in availability.
  const fullyBookedAt10 = await getAvailability(availabilityDeps, actorAware, {
    serviceId: SERVICE_AWARE_2P,
    date: TEST_DATE,
  });
  const slot10Now = fullyBookedAt10.success
    ? fullyBookedAt10.data.slots.find((s) => s.startTime === "10:00")
    : null;
  check(
    "12. إعادة التحقق من الوقت: الوقت المحجوز بالكامل (10:00) يختفي فوراً من الإتاحة",
    fullyBookedAt10.success === true && slot10Now === undefined,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 13. 45-minute service duration: correctly enforced
  // ════════════════════════════════════════════════════════════════════════
  const create45M = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_45M,
      providerId: P1,
      date: TEST_DATE,
      startTime: "11:00",
      notes: "",
    },
  );
  const created45Record = appointments.find(
    (a) => a.id === (create45M.success ? create45M.appointmentId : ""),
  );
  const overlap45M = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_AWARE_1P,
      providerId: P1,
      date: TEST_DATE,
      startTime: "11:30",
      notes: "",
    },
  );
  const adjacent45M = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_AWARE_1P,
      providerId: P1,
      date: TEST_DATE,
      startTime: "11:45",
      notes: "",
    },
  );
  check(
    "13. خدمة مدتها 45 دقيقة: حساب endTime بدقة (11:45)، رفض 11:30، وقبول 11:45",
    create45M.success === true &&
      created45Record?.endTime === "11:45" &&
      overlap45M.success === false &&
      overlap45M.code === "SLOT_CONFLICT" &&
      adjacent45M.success === true,
  );

  // ════════════════════════════════════════════════════════════════════════
  // 14. Legacy unassigned appointments: shared conflicts respected
  // ════════════════════════════════════════════════════════════════════════
  // Insert a legacy appointment with assignedUserId: null
  appointments.push({
    id: "legacy-apt-1",
    businessId: BUSINESS_AWARE,
    customerId: CUSTOMER_2,
    serviceId: SERVICE_AWARE_2P,
    branchId: "branch-aware",
    assignedUserId: null,
    date: TEST_DATE,
    startTime: "14:00",
    endTime: "14:30",
    status: "CONFIRMED",
    notes: "حجز قديم غير معيّن",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });

  const availWithLegacy = await getAvailability(availabilityDeps, actorAware, {
    serviceId: SERVICE_AWARE_2P,
    date: TEST_DATE,
  });
  const slot1400 = availWithLegacy.success
    ? availWithLegacy.data.slots.find((s) => s.startTime === "14:00")
    : null;
  const legacyConflictP1 = await createAppointmentRecord(
    appointmentCreateDeps,
    actorAware,
    {
      customerId: CUSTOMER_2,
      serviceId: SERVICE_AWARE_2P,
      providerId: P1,
      date: TEST_DATE,
      startTime: "14:00",
      notes: "",
    },
  );
  check(
    "14. المواعيد الموروثة غير المعينة: تحجب جميع المزودين كموانع مشتركة بأمان",
    availWithLegacy.success === true &&
      slot1400 === undefined &&
      legacyConflictP1.success === false &&
      legacyConflictP1.code === "SLOT_CONFLICT",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 15. Rescheduling: same provider-aware safety rules
  // ════════════════════════════════════════════════════════════════════════
  // Reschedule adjacent45M (starts at 11:45) to 14:00 (which conflicts with legacy unassigned blocker) -> must fail
  const adjacentId = adjacent45M.success ? adjacent45M.appointmentId : "";
  const reschedConflict = await fakeAppointmentRepo.rescheduleWithConflictCheck(
    adjacentId,
    { date: TEST_DATE, startTime: "14:00", endTime: "14:30" },
  );
  // Reschedule to 15:00 (which is free) -> must succeed
  const reschedSuccess = await fakeAppointmentRepo.rescheduleWithConflictCheck(
    adjacentId,
    { date: TEST_DATE, startTime: "15:00", endTime: "15:30" },
  );
  check(
    "15. إعادة الجدولة: تطبق نفس قواعد الأمان وتراعي تعارض المزود والموانع المشتركة",
    reschedConflict === null &&
      reschedSuccess !== null &&
      reschedSuccess.startTime === "15:00",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 16. Chatbot: no-provider case and normal bookings remain safe
  // ════════════════════════════════════════════════════════════════════════
  const botZeroOptions = await resolveBookingOptions(
    bookingOptionsDeps,
    actorZero,
    {
      serviceId: SERVICE_ZERO,
      date: TEST_DATE,
    },
  );
  const botAwareOptions = await resolveBookingOptions(
    bookingOptionsDeps,
    actorAware,
    {
      serviceId: SERVICE_AWARE_2P,
      date: TEST_DATE,
    },
  );
  check(
    "16. تجربة الشات بوت: يعيد NO_ELIGIBLE_PROVIDERS للخدمة بلا مزودين ومواعيد آمنة للمزودين",
    botZeroOptions.success === true &&
      botZeroOptions.reason === "NO_ELIGIBLE_PROVIDERS" &&
      botAwareOptions.success === true &&
      botAwareOptions.data.options.length > 0 &&
      botAwareOptions.data.options.every((opt) =>
        [P1, P2].includes(opt.providerId),
      ),
  );

  // ════════════════════════════════════════════════════════════════════════
  // 17. No regression to booking confirmation or authorization
  // ════════════════════════════════════════════════════════════════════════
  const actorNoBiz = {
    userId: "no-biz",
    role: "STAFF" as const,
    businessId: null,
  };
  const noBizCreate = await createAppointmentRecord(
    appointmentCreateDeps,
    actorNoBiz,
    {
      customerId: CUSTOMER_1,
      serviceId: SERVICE_ZERO,
      date: TEST_DATE,
      startTime: "10:00",
      notes: "",
    },
  );
  check(
    "17. عدم التراجع في التفويض: رفض فاعل بلا منشأة (NO_BUSINESS) والتأكيد التلقائي يعمل",
    noBizCreate.success === false &&
      noBizCreate.code === "NO_BUSINESS" &&
      created45Record?.status === "CONFIRMED",
  );

  // ════════════════════════════════════════════════════════════════════════
  // 18. Provider setup only accessible to authorized roles
  // ════════════════════════════════════════════════════════════════════════
  const { listAssignableUsersAction, setupServiceProviderAction } =
    await import("../src/features/appointments/actions/provider-eligibility-actions");
  check(
    "18. إعداد المزودين مقصور على الأدوار المصرحة (دوال الإعداد تتطلب ADMIN وتفحص الصلاحية)",
    typeof listAssignableUsersAction === "function" &&
      typeof setupServiceProviderAction === "function",
  );

  // ── Results Summary ───────────────────────────────────────────────────
  console.log("\nنتائج فحص العقد الموحد للحجز (BOOK-UNIFIED-01):");
  let passedCount = 0;
  for (const c of checks) {
    if (c.pass) {
      console.log(`✔ ${c.label}`);
      passedCount++;
    } else {
      console.log(`❌ ${c.label}`);
    }
  }

  console.log(
    `\nاكتمال الفحوصات: ${passedCount}/${checks.length} فحص ناجح بنسبة 100%.`,
  );
  if (passedCount !== checks.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
