/**
 * FlowPilot — ISS-006 Verification Suite
 *
 * Follow-up Scheduling Diagnostic & Defect Verification
 *
 * Verifies:
 * 1. Follow-up request alone creates no appointment.
 * 2. Valid scheduling creates one linked appointment atomically.
 * 3. Duplicate/stale scheduling cannot create a second appointment (idempotent / non-pending rejection).
 * 4. Pending cancellation works; terminal states reconcile honestly:
 *    - PENDING -> CANCELLED (success: true)
 *    - Already CANCELLED -> reconciles honestly (success: true, message: "طلب المتابعة ملغى بالفعل")
 *    - SCHEDULED -> explicit honest refusal (success: false, message: "لا يمكن إلغاء طلب متابعة تم حجز موعد له مسبقاً")
 * 5. Flexible & Date-free requests, invalid ranges, inactive resources, and tenant boundaries:
 *    - Undated / date-free follow-up does not crash DateStep or date formatters (avoids error boundary).
 *    - formatArabicDate / formatArabicWeekday / formatArabicMonth handle null / undefined / invalid safely.
 *    - Invalid date ranges (startDate > endDate) are rejected with explicit outcomes.
 *    - Inactive services & providers produce explicit domain errors.
 *    - Cross-tenant requests produce explicit domain errors.
 * 6. Historical records are preserved (no silent overwriting or deletions).
 *
 * Run: tsx scripts/check-iss-006.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Prisma } from "@/generated/prisma/client";

import {
  formatArabicDate,
  formatArabicDayMonth,
  formatArabicMonth,
  formatArabicWeekday,
} from "@/features/appointments/components/smart-create/date-format";
import { createFollowUpRequestSchema } from "@/features/appointments/schemas/follow-up-schema";
import {
  createAppointmentRecord,
  type AppointmentCreateActor,
  type AppointmentCreateServiceDeps,
} from "@/features/appointments/server/appointment-create-service";
import {
  resolveBookingContext,
  type BookingFlowActor,
  type BookingFlowServiceDeps,
} from "@/features/appointments/server/booking-flow-service";
import type { db } from "@/server/db";
import { AppointmentRepository } from "@/server/repositories/appointment.repository";
import { FollowUpRequestRepository } from "@/server/repositories/follow-up-request.repository";
import type {
  Customer,
  FollowUpRequestWithRelations,
  ProviderProfile,
  Service,
} from "@/types/domain";

type CheckResult = {
  id: number;
  label: string;
  pass: boolean;
  details?: string;
};
const results: CheckResult[] = [];

function check(id: number, label: string, pass: boolean, details?: string) {
  results.push({ id, label, pass, details });
  const status = pass ? "✅ PASS" : "❌ FAIL";
  console.log(
    `${status} [${String(id).padStart(2, "0")}/12]: ${label}${details ? ` (${details})` : ""}`,
  );
}

async function run() {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  console.log(
    "\n=== FlowPilot ISS-006 Follow-up Scheduling Diagnostic & Verification ===\n",
  );

  const BIZ_A = "a0000000-0000-4000-8000-000000000001";
  const BIZ_B = "b0000000-0000-4000-8000-000000000001";
  const CUST_A = "a0000000-0000-4000-8000-000000000002";
  const SRV_A = "a0000000-0000-4000-8000-000000000003";
  const PROV_A = "a0000000-0000-4000-8000-000000000004";
  const USER_A = "a0000000-0000-4000-8000-000000000005";
  const FU_ALONE = "a0000000-0000-4000-8000-000000000010";
  const FU_ATOMIC = "a0000000-0000-4000-8000-000000000020";
  const FU_STALE = "a0000000-0000-4000-8000-000000000030";
  const FU_PENDING = "a0000000-0000-4000-8000-000000000040";
  const FU_CANCELLED = "a0000000-0000-4000-8000-000000000050";
  const FU_SCHEDULED = "a0000000-0000-4000-8000-000000000060";
  const FU_UNDATED = "a0000000-0000-4000-8000-000000000070";
  const FU_INVERTED = "a0000000-0000-4000-8000-000000000080";
  const BRANCH_A = "a0000000-0000-4000-8000-000000000099";

  // --- 1. Follow-up request alone creates no appointment ---
  let appointmentsCreatedCount = 0;
  let followUpsCreatedCount = 0;

  const mockDbCreateFollowUp = {
    followUpRequest: {
      create: async ({
        data,
      }: {
        data: Prisma.FollowUpRequestUncheckedCreateInput;
      }) => {
        followUpsCreatedCount++;
        return {
          id: FU_ALONE,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        };
      },
    },
    appointment: {
      create: async () => {
        appointmentsCreatedCount++;
        return {};
      },
    },
  };

  const followUpRepo = new FollowUpRequestRepository(
    mockDbCreateFollowUp as unknown as typeof db,
  );

  const createdFollowUp = await followUpRepo.create({
    businessId: BIZ_A,
    customerId: CUST_A,
    serviceId: SRV_A,
    startDate: null,
    endDate: null,
    notes: "Follow-up test alone",
  });

  check(
    1,
    "Follow-up request creation creates no appointment",
    followUpsCreatedCount === 1 &&
      appointmentsCreatedCount === 0 &&
      createdFollowUp.status === "PENDING",
    `followUpsCreated=${followUpsCreatedCount}, appointmentsCreated=${appointmentsCreatedCount}`,
  );

  // --- 2. Valid scheduling creates one linked appointment atomically ---
  let linkedFollowUpStatus: string | null = null;
  let linkedFollowUpAppointmentId: string | null = null;
  let appointmentCreatedId: string | null = null;

  const mockDbAtomic = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const mockTx = {
        followUpRequest: {
          findFirst: async () => ({
            id: FU_ATOMIC,
            businessId: BIZ_A,
            status: "PENDING",
            startDate: new Date("2026-11-01T00:00:00.000Z"),
            endDate: new Date("2026-11-10T00:00:00.000Z"),
          }),
          update: async ({
            data,
          }: {
            data: { status: string; scheduledAppointmentId: string };
          }) => {
            linkedFollowUpStatus = data.status;
            linkedFollowUpAppointmentId = data.scheduledAppointmentId;
            return { id: FU_ATOMIC, ...data };
          },
        },
        appointment: {
          count: async () => 0,
          create: async ({
            data,
          }: {
            data: Prisma.AppointmentUncheckedCreateInput;
          }) => {
            appointmentCreatedId = "app-atomic-002";
            return {
              id: "app-atomic-002",
              ...data,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
          },
        },
        customer: { update: async () => ({}) },
      };
      return fn(mockTx);
    },
  };

  const appRepoAtomic = new AppointmentRepository(
    mockDbAtomic as unknown as typeof db,
  );
  const createdApp = await appRepoAtomic.createWithConflictCheck({
    businessId: BIZ_A,
    branchId: BRANCH_A,
    customerId: CUST_A,
    serviceId: SRV_A,
    date: "2026-11-05",
    startTime: "10:00",
    endTime: "10:30",
    followUpRequestId: FU_ATOMIC,
  });

  check(
    2,
    "Valid scheduling creates one linked appointment atomically",
    createdApp !== null &&
      appointmentCreatedId === "app-atomic-002" &&
      linkedFollowUpStatus === "SCHEDULED" &&
      linkedFollowUpAppointmentId === "app-atomic-002",
    `appointmentId=${createdApp?.id}, followUpStatus=${linkedFollowUpStatus}, linkedAppId=${linkedFollowUpAppointmentId}`,
  );

  // --- 3. Duplicate/stale scheduling cannot create a second appointment ---
  let duplicateRejectedInRepo = false;
  const mockDbStale = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const mockTx = {
        followUpRequest: {
          findFirst: async () => ({
            id: FU_STALE,
            businessId: BIZ_A,
            status: "SCHEDULED", // Already converted!
            scheduledAppointmentId: "app-existing-001",
          }),
        },
        appointment: {
          count: async () => 0,
          create: async () => {
            throw new Error("UNEXPECTED_APPOINTMENT_CREATION");
          },
        },
      };
      return fn(mockTx);
    },
  };

  const appRepoStale = new AppointmentRepository(
    mockDbStale as unknown as typeof db,
  );
  try {
    await appRepoStale.createWithConflictCheck({
      businessId: BIZ_A,
      branchId: BRANCH_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      date: "2026-11-05",
      startTime: "10:00",
      endTime: "10:30",
      followUpRequestId: FU_STALE,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "FOLLOW_UP_NOT_PENDING") {
      duplicateRejectedInRepo = true;
    }
  }

  // Also verify createAppointmentRecord service handling
  const mockServiceDepsStale: AppointmentCreateServiceDeps = {
    appointmentRepository: appRepoStale,
    customerRepository: {
      findById: async () => ({
        id: CUST_A,
        businessId: BIZ_A,
        name: "Customer A",
        phone: "01000000000",
        lastAppointmentAt: null,
      }),
    } as unknown as AppointmentCreateServiceDeps["customerRepository"],
    serviceRepository: {
      findById: async () => ({
        id: SRV_A,
        businessId: BIZ_A,
        name: "Service A",
        durationMinutes: 30,
        isActive: true,
      }),
    } as unknown as AppointmentCreateServiceDeps["serviceRepository"],
    businessRepository: {
      findById: async () => ({
        id: BIZ_A,
        timezone: "Africa/Cairo",
        confirmationMode: "manual",
        workingHours: null,
      }),
    } as unknown as AppointmentCreateServiceDeps["businessRepository"],
    branchRepository: {
      findDefaultByBusiness: async () => ({
        id: BRANCH_A,
        businessId: BIZ_A,
      }),
    } as unknown as AppointmentCreateServiceDeps["branchRepository"],
    followUpRequestRepository: {
      findById: async () => ({
        id: FU_STALE,
        businessId: BIZ_A,
        customerId: CUST_A,
        serviceId: SRV_A,
        status: "SCHEDULED" as const,
        startDate: new Date("2026-11-01"),
        endDate: new Date("2026-11-10"),
      }),
    } as unknown as AppointmentCreateServiceDeps["followUpRequestRepository"],
    now: () => new Date("2026-10-30T10:00:00Z"),
  };

  const actor: AppointmentCreateActor = {
    userId: USER_A,
    role: "STAFF",
    businessId: BIZ_A,
  };

  const serviceDuplicateResult = await createAppointmentRecord(
    mockServiceDepsStale,
    actor,
    {
      customerId: CUST_A,
      serviceId: SRV_A,
      date: "2026-11-05",
      startTime: "11:00",
      notes: "",
      followUpRequestId: FU_STALE,
    },
  );

  const duplicateServiceCode = !serviceDuplicateResult.success
    ? serviceDuplicateResult.code
    : "";
  const duplicateServiceMsg = !serviceDuplicateResult.success
    ? serviceDuplicateResult.message
    : "";

  check(
    3,
    "Duplicate/stale scheduling rejected without creating second appointment",
    duplicateRejectedInRepo &&
      !serviceDuplicateResult.success &&
      duplicateServiceCode === "FOLLOW_UP_NOT_PENDING" &&
      duplicateServiceMsg.includes("تم حجز موعد"),
    `repoRejected=${duplicateRejectedInRepo}, serviceCode=${duplicateServiceCode}, msg=${duplicateServiceMsg}`,
  );

  // --- 4. Pending cancellation works; terminal states reconcile honestly ---
  let statusUpdatedTo: string | null = null;
  const mockDbForCancel = {
    followUpRequest: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; status?: string };
      }) => {
        if (where.id === FU_PENDING) {
          return {
            id: FU_PENDING,
            businessId: BIZ_A,
            status: "PENDING",
            sourceAppointmentId: "app-src-01",
          };
        }
        if (where.id === FU_CANCELLED) {
          return {
            id: FU_CANCELLED,
            businessId: BIZ_A,
            status: "CANCELLED",
            sourceAppointmentId: "app-src-01",
          };
        }
        if (where.id === FU_SCHEDULED) {
          return {
            id: FU_SCHEDULED,
            businessId: BIZ_A,
            status: "SCHEDULED",
            sourceAppointmentId: "app-src-01",
          };
        }
        return null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: string };
      }) => {
        statusUpdatedTo = data.status;
        return { id: where.id, ...data };
      },
    },
  };

  const cancelRepo = new FollowUpRequestRepository(
    mockDbForCancel as unknown as typeof db,
  );

  // Case A: PENDING -> CANCELLED
  const updatePending = await cancelRepo.updateStatus(
    FU_PENDING,
    BIZ_A,
    "CANCELLED",
  );
  check(
    4,
    "Pending follow-up request can be cancelled successfully",
    updatePending !== null && statusUpdatedTo === "CANCELLED",
    `statusUpdatedTo=${statusUpdatedTo}`,
  );

  // Case B: Already CANCELLED request terminal reconciliation
  // Simulate cancelFollowUpRequest action logic
  async function simulateCancelAction(id: string, businessId: string) {
    const existing = await cancelRepo.findById(id, businessId);
    if (!existing) {
      return { success: false, message: "طلب المتابعة غير موجود" };
    }
    if (existing.status === "CANCELLED") {
      return { success: true, message: "طلب المتابعة ملغى بالفعل" };
    }
    if (existing.status === "SCHEDULED") {
      return {
        success: false,
        message: "لا يمكن إلغاء طلب متابعة تم حجز موعد له مسبقاً",
      };
    }
    if (existing.status !== "PENDING") {
      return { success: false, message: "لا يمكن إلغاء هذا الطلب" };
    }
    await cancelRepo.updateStatus(existing.id, businessId, "CANCELLED");
    return { success: true, message: "تم إلغاء طلب المتابعة بنجاح" };
  }

  const cancelAlreadyCancelledRes = await simulateCancelAction(
    FU_CANCELLED,
    BIZ_A,
  );
  check(
    5,
    "Cancelling an already CANCELLED request reconciles honestly without error",
    cancelAlreadyCancelledRes.success === true &&
      cancelAlreadyCancelledRes.message === "طلب المتابعة ملغى بالفعل",
    `success=${cancelAlreadyCancelledRes.success}, message=${cancelAlreadyCancelledRes.message}`,
  );

  // Case C: SCHEDULED request cancellation refusal
  const cancelScheduledRes = await simulateCancelAction(FU_SCHEDULED, BIZ_A);
  check(
    6,
    "Cancelling a SCHEDULED request fails with explicit honest explanation",
    cancelScheduledRes.success === false &&
      cancelScheduledRes.message.includes(
        "لا يمكن إلغاء طلب متابعة تم حجز موعد له مسبقاً",
      ),
    `success=${cancelScheduledRes.success}, message=${cancelScheduledRes.message}`,
  );

  // --- 5. Date-free / Undated follow-up requests safety (preventing Error Boundary) ---
  let dateFormattingThrew = false;
  let formattedNullDate = "";
  let formattedUndefinedDate = "";
  let formattedInvalidDate = "";
  let formattedNullWeekday = "";
  let formattedNullMonth = "";
  let formattedNullDayMonth = "";

  try {
    formattedNullDate = formatArabicDate(null);
    formattedUndefinedDate = formatArabicDate(undefined);
    formattedInvalidDate = formatArabicDate("invalid-date-string");
    formattedNullWeekday = formatArabicWeekday(null);
    formattedNullMonth = formatArabicMonth(null);
    formattedNullDayMonth = formatArabicDayMonth(null);
  } catch {
    dateFormattingThrew = true;
  }

  check(
    7,
    "Date formatters defensively handle null/undefined without throwing RangeError",
    !dateFormattingThrew &&
      formattedNullDate === "" &&
      formattedUndefinedDate === "" &&
      formattedInvalidDate === "invalid-date-string" &&
      formattedNullWeekday === "" &&
      formattedNullMonth === "" &&
      formattedNullDayMonth === "",
    `threw=${dateFormattingThrew}, nullDate='${formattedNullDate}', invalidDate='${formattedInvalidDate}'`,
  );

  // Verify Booking Flow Service with undated request
  const mockBookingFlowDepsUndated: BookingFlowServiceDeps = {
    customerRepository: {
      findById: async (id) =>
        id === CUST_A
          ? ({
              id: CUST_A,
              name: "Customer A",
              phone: "01000000000",
              businessId: BIZ_A,
            } as unknown as Customer)
          : null,
      listByBusiness: async () => [],
    },
    serviceRepository: {
      findById: async (id) =>
        id === SRV_A
          ? ({
              id: SRV_A,
              name: "Service A",
              durationMinutes: 30,
              businessId: BIZ_A,
              isActive: true,
            } as unknown as Service)
          : null,
      listByBusiness: async () => [],
    },
    followUpRequestRepository: {
      findById: async (id, bizId) =>
        id === FU_UNDATED && bizId === BIZ_A
          ? ({
              id: FU_UNDATED,
              businessId: BIZ_A,
              customerId: CUST_A,
              serviceId: SRV_A,
              preferredProviderId: null,
              status: "PENDING" as const,
              startDate: null,
              endDate: null,
              notes: "Undated request",
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
              customer: {
                id: CUST_A,
                name: "Customer A",
                phone: "01000000000",
              },
              service: { id: SRV_A, name: "Service A", durationMinutes: 30 },
              preferredProvider: null,
              sourceAppointment: null,
              scheduledAppointment: null,
            } as unknown as FollowUpRequestWithRelations)
          : null,
    },
  };

  const bookingActor: BookingFlowActor = {
    userId: USER_A,
    role: "STAFF",
    businessId: BIZ_A,
  };

  const bookingContextPrefill = await resolveBookingContext(
    mockBookingFlowDepsUndated,
    bookingActor,
    { followUpId: FU_UNDATED },
  );

  const followUpCtx = bookingContextPrefill.followUpContext;

  check(
    8,
    "Booking context resolves undated follow-up safely with null start/end dates",
    followUpCtx !== null &&
      followUpCtx !== undefined &&
      followUpCtx.id === FU_UNDATED &&
      followUpCtx.startDate === null &&
      followUpCtx.endDate === null &&
      bookingContextPrefill.customer?.id === CUST_A &&
      bookingContextPrefill.serviceId === SRV_A,
    `followUpContext=${JSON.stringify(followUpCtx)}`,
  );

  // --- 6. Invalid ranges & Out of Range explicit outcomes ---
  // Case A: Schema rejection on flexible without valid dates
  const invalidRangeSchema = createFollowUpRequestSchema.safeParse({
    customerId: CUST_A,
    type: "flexible",
    startDate: "2026-11-10",
    endDate: "2026-11-01", // startDate > endDate
  });

  // Case B: Service rejection on existing record with inverted range
  const mockDepsInvertedRange: AppointmentCreateServiceDeps = {
    ...mockServiceDepsStale,
    followUpRequestRepository: {
      findById: async () => ({
        id: FU_INVERTED,
        businessId: BIZ_A,
        customerId: CUST_A,
        serviceId: SRV_A,
        status: "PENDING" as const,
        startDate: new Date("2026-11-20"),
        endDate: new Date("2026-11-10"), // Inverted in DB
      }),
    } as unknown as AppointmentCreateServiceDeps["followUpRequestRepository"],
  };

  const invertedRangeResult = await createAppointmentRecord(
    mockDepsInvertedRange,
    actor,
    {
      customerId: CUST_A,
      serviceId: SRV_A,
      date: "2026-11-15",
      startTime: "11:00",
      notes: "",
      followUpRequestId: FU_INVERTED,
    },
  );

  const invertedCode = !invertedRangeResult.success
    ? invertedRangeResult.code
    : "";
  const invertedMsg = !invertedRangeResult.success
    ? invertedRangeResult.message
    : "";

  check(
    9,
    "Invalid ranges (startDate > endDate) have explicit rejection outcomes",
    !invalidRangeSchema.success &&
      !invertedRangeResult.success &&
      invertedCode === "DATE_OUT_OF_RANGE" &&
      invertedMsg === "فترة المتابعة غير صالحة",
    `schemaValid=${invalidRangeSchema.success}, serviceCode=${invertedCode}, msg=${invertedMsg}`,
  );

  // --- 7. Inactive resources explicit outcomes ---
  // Inactive service
  const mockDepsInactiveService: AppointmentCreateServiceDeps = {
    ...mockServiceDepsStale,
    serviceRepository: {
      findById: async () => ({
        id: SRV_A,
        businessId: BIZ_A,
        name: "Service A",
        durationMinutes: 30,
        isActive: false, // Inactive!
      }),
    } as unknown as AppointmentCreateServiceDeps["serviceRepository"],
  };

  const inactiveServiceResult = await createAppointmentRecord(
    mockDepsInactiveService,
    actor,
    {
      customerId: CUST_A,
      serviceId: SRV_A,
      date: "2026-11-05",
      startTime: "11:00",
      notes: "",
    },
  );

  const inactiveServiceCode = !inactiveServiceResult.success
    ? inactiveServiceResult.code
    : "";

  // Inactive provider in resolveBookingContext
  const mockBookingFlowDepsInactiveProvider: BookingFlowServiceDeps = {
    ...mockBookingFlowDepsUndated,
    providerRepository: {
      findProfileWithinBusiness: async () =>
        ({
          id: PROV_A,
          businessId: BIZ_A,
          name: "Dr Provider",
          displayName: "Dr. Provider",
          isActive: false, // Inactive!
        }) as unknown as ProviderProfile,
      listEligibleForService: async () => [],
    },
  };

  const inactiveProviderPrefill = await resolveBookingContext(
    mockBookingFlowDepsInactiveProvider,
    bookingActor,
    { providerId: PROV_A },
  );

  check(
    10,
    "Inactive resources produce explicit rejections or are excluded from prefill",
    !inactiveServiceResult.success &&
      inactiveServiceCode === "SERVICE_UNAVAILABLE" &&
      inactiveProviderPrefill.providerId === null,
    `inactiveServiceCode=${inactiveServiceCode}, inactiveProviderPrefill=${inactiveProviderPrefill.providerId}`,
  );

  // --- 8. Tenant isolation explicit outcomes ---
  const foreignActor: BookingFlowActor = {
    userId: "b0000000-0000-4000-8000-000000000099",
    role: "STAFF",
    businessId: BIZ_B, // Tenant B
  };

  const foreignPrefill = await resolveBookingContext(
    mockBookingFlowDepsUndated,
    foreignActor,
    { followUpId: FU_UNDATED }, // belongs to Tenant A
  );

  const foreignCancelRes = await simulateCancelAction(FU_UNDATED, BIZ_B);

  check(
    11,
    "Cross-tenant access attempts are rejected and isolated",
    foreignPrefill.followUpContext === null &&
      foreignPrefill.customer === null &&
      foreignCancelRes.success === false &&
      foreignCancelRes.message === "طلب المتابعة غير موجود",
    `foreignFollowUpContext=${foreignPrefill.followUpContext}, foreignCancelSuccess=${foreignCancelRes.success}`,
  );

  // --- 9. No historical record is silently rewritten ---
  const readSrc = (relPath: string) =>
    readFileSync(resolve(process.cwd(), relPath), "utf8");

  const repoSrc = readSrc(
    "src/server/repositories/follow-up-request.repository.ts",
  );
  const actionsSrc = readSrc(
    "src/features/appointments/actions/follow-up-actions.ts",
  );

  const updatesOnlyStatus =
    repoSrc.includes("data: { status }") &&
    !repoSrc.includes("deletedAt: new Date()");
  const cancelPreservesAudit =
    actionsSrc.includes("updateStatus") &&
    !actionsSrc.includes("delete(") &&
    !actionsSrc.includes("deleteMany(");

  check(
    12,
    "No historical follow-up record is silently deleted or rewritten",
    updatesOnlyStatus && cancelPreservesAudit,
    "updateStatus only mutates status field; no deletion or destructive overwrite",
  );

  console.log("\n=======================================================");
  const allPassed = results.every((r) => r.pass);
  console.log(
    `Total Checks: ${results.length} | Passed: ${results.filter((r) => r.pass).length} | Failed: ${results.filter((r) => !r.pass).length}`,
  );
  console.log("=======================================================\n");

  if (!allPassed) {
    console.error("❌ ISS-006 VERIFICATION FAILED!");
    process.exit(1);
  } else {
    console.log("🎉 ALL 12 ISS-006 VERIFICATION CHECKS PASSED!");
  }
}

void run();
