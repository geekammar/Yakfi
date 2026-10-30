/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Booking Acceptance Blockers Real-DB Integration Check (ISS-002 -> ISS-005).
 *
 * Verifies against a disposable/local PostgreSQL database in GitHub Actions CI:
 *   1. Independent ALL_SERVICES provider creation without login account (nullable assignedUserId).
 *   2. Real-DB booking creation for independent provider without CREATE_FAILED exception.
 *   3. Real-DB availability and conflict detection for independent provider.
 *   4. Same appointment ID atomic rescheduling; old slot released; new slot occupied.
 *   5. Conflict failure leaves original appointment unchanged.
 *   6. Cross-tenant boundaries and tenant authorization enforced.
 *   7. ALL_SERVICES automatic inclusion of newly added services & explicit exclusions.
 *   8. SPECIFIC_SERVICES does not expand implicitly on saving unrelated fields (ISS-003/ISS-004).
 *   9. Explicit authorized policy upgrade from SPECIFIC_SERVICES to ALL_SERVICES.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:password@localhost:5432/flowpilot_test' \
 *     pnpm check:booking-acceptance-db
 */

import { randomUUID } from "node:crypto";

import {
  createAppointmentRecord,
  defaultAppointmentCreateServiceDeps,
} from "@/features/appointments/server/appointment-create-service";
import {
  defaultTeamServiceDeps,
  updateProvider,
} from "@/features/staff/server/team-service";
import { db } from "@/server/db";
import {
  appointmentRepository,
  providerRepository,
} from "@/server/repositories";
import type { UserRole } from "@/types/domain";

type Check = { label: string; pass: boolean; details?: string };

const checks: Check[] = [];
function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
}

const TEST_ADMIN_ID = randomUUID();
const TEST_BUSINESS_ID = randomUUID();
const TEST_CROSS_BIZ_ID = randomUUID();

function classifyTarget(
  url: string,
): { host: string; local: boolean; reason: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const isLocal =
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === "";
    return {
      host,
      local: isLocal,
      reason: isLocal
        ? "local / disposable test database"
        : "remote host rejected",
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  console.log(
    "▶ Running Booking Acceptance Blockers Real-DB Integration Check...",
  );

  const url = process.env.DATABASE_URL ?? "";
  const target = classifyTarget(url);
  if (!target || !target.local) {
    console.error(
      "❌ DEV_DB_INTEGRATION_BLOCKED: DATABASE_URL must point to a local disposable test database.",
    );
    process.exit(1);
  }
  console.log(`🔒 Target database verified local: ${target.host}`);

  const actor = {
    userId: TEST_ADMIN_ID,
    role: "ADMIN" as UserRole,
    businessId: TEST_BUSINESS_ID,
  };

  try {
    // ── Setup primary business & fixtures ──
    await db.user.create({
      data: {
        id: TEST_ADMIN_ID,
        email: `${TEST_ADMIN_ID}@flowpilot.invalid`,
        emailVerified: false,
        accountType: "BUSINESS",
        name: "Test Admin",
      },
    });

    await db.business.create({
      data: {
        id: TEST_BUSINESS_ID,
        name: "عيادة دكتور تيسير التجريبية",
        whatsappNumber: `+2010${Math.floor(10000000 + Math.random() * 90000000)}`,
        isActive: true,
        timezone: "Africa/Cairo",
        confirmationMode: "automatic",
      },
    });

    // Default branch
    const branchId = randomUUID();
    await db.branch.create({
      data: {
        id: branchId,
        businessId: TEST_BUSINESS_ID,
        name: "الفرع الرئيسي",
      },
    });
    await db.business.update({
      where: { id: TEST_BUSINESS_ID },
      data: { defaultBranchId: branchId },
    });

    // Cross-tenant business
    await db.business.create({
      data: {
        id: TEST_CROSS_BIZ_ID,
        name: "منشأة أخرى لعزل البيانات",
        whatsappNumber: `+2010${Math.floor(10000000 + Math.random() * 90000000)}`,
        isActive: true,
        timezone: "Africa/Cairo",
      },
    });
    const crossBranchId = randomUUID();
    await db.branch.create({
      data: {
        id: crossBranchId,
        businessId: TEST_CROSS_BIZ_ID,
        name: "فرع المنشأة الأخرى",
      },
    });
    await db.business.update({
      where: { id: TEST_CROSS_BIZ_ID },
      data: { defaultBranchId: crossBranchId },
    });

    // Services
    const serviceA = await db.service.create({
      data: {
        id: randomUUID(),
        businessId: TEST_BUSINESS_ID,
        name: "كشف أولي",
        durationMinutes: 30,
        isActive: true,
      },
    });

    const serviceB = await db.service.create({
      data: {
        id: randomUUID(),
        businessId: TEST_BUSINESS_ID,
        name: "متابعة دورية",
        durationMinutes: 30,
        isActive: true,
      },
    });

    const crossService = await db.service.create({
      data: {
        id: randomUUID(),
        businessId: TEST_CROSS_BIZ_ID,
        name: "خدمة منشأة أخرى",
        durationMinutes: 30,
        isActive: true,
      },
    });

    // Customer
    const customer = await db.customer.create({
      data: {
        id: randomUUID(),
        businessId: TEST_BUSINESS_ID,
        name: "أحمد عبد الله",
        phone: `+2011${Math.floor(10000000 + Math.random() * 90000000)}`,
      },
    });

    // ── 1. Create Independent ALL_SERVICES Provider (ISS-002) ──
    const independentProvider = await providerRepository.createProfile(
      TEST_BUSINESS_ID,
      {
        name: "د. هبة المنصور",
        displayName: "د. هبة",
        servicePolicy: "ALL_SERVICES",
      },
    );

    if (!independentProvider) {
      throw new Error("Failed to create independent provider profile");
    }

    check(
      "1. Independent provider profile created without auth user account",
      independentProvider.userId === null &&
        independentProvider.servicePolicy === "ALL_SERVICES",
      `providerId=${independentProvider.id}, userId=${independentProvider.userId}`,
    );

    // Verify seam mapping reflects null userId without fabricating providerId as user
    const seams = await providerRepository.listAssignmentSeams(
      TEST_BUSINESS_ID,
      [independentProvider.id],
    );
    check(
      "2. listAssignmentSeams returns null userId for independent provider without user account",
      seams.length === 1 && seams[0]?.userId === null,
      `seams=${JSON.stringify(seams)}`,
    );

    // ── 2. Real-DB Booking Creation for Independent Provider (ISS-002) ──
    const bookingDate = "2027-01-15";
    const bookingTime = "10:00";
    const createResult = await createAppointmentRecord(
      defaultAppointmentCreateServiceDeps,
      actor,
      {
        customerId: customer.id,
        serviceId: serviceA.id,
        providerId: independentProvider.id,
        date: bookingDate,
        startTime: bookingTime,
        notes: "حجز موعد أول تجريبي",
      },
    );

    check(
      "3. createAppointmentRecord succeeds for independent provider without CREATE_FAILED exception",
      createResult.success === true,
      `success=${createResult.success}, code=${!createResult.success ? (createResult as any).code : "NONE"}`,
    );

    let createdAppointmentId = "";
    if (createResult.success) {
      createdAppointmentId = createResult.appointmentId;
      const apptRow = await db.appointment.findUnique({
        where: { id: createdAppointmentId },
      });
      check(
        "4. Persisted appointment row links providerId while assignedUserId remains strictly null",
        Boolean(
          apptRow &&
          apptRow.providerId === independentProvider.id &&
          apptRow.assignedUserId === null &&
          apptRow.status === "CONFIRMED",
        ),
        `providerId=${apptRow?.providerId}, assignedUserId=${apptRow?.assignedUserId}`,
      );
    }

    // ── 3. Real-DB Rescheduling of Independent Provider Appointment (ISS-005) ──
    // Reschedule appointment to a new slot: 11:00 on the same day
    const rescheduleTime = "11:00";
    const rescheduleEndTime = "11:30";

    const rescheduleResult =
      await appointmentRepository.rescheduleWithConflictCheck(
        createdAppointmentId,
        {
          date: bookingDate,
          startTime: rescheduleTime,
          endTime: rescheduleEndTime,
        },
      );

    check(
      "5. rescheduleWithConflictCheck preserves same appointment ID atomically",
      Boolean(rescheduleResult && rescheduleResult.id === createdAppointmentId),
      `rescheduledId=${rescheduleResult?.id}`,
    );

    const rescheduledRow = await db.appointment.findUnique({
      where: { id: createdAppointmentId },
    });
    check(
      "6. Rescheduled row updates date/time while preserving providerId and null assignedUserId",
      Boolean(
        rescheduledRow &&
        rescheduledRow.providerId === independentProvider.id &&
        rescheduledRow.assignedUserId === null &&
        rescheduledRow.startTime.toISOString().slice(11, 16) === rescheduleTime,
      ),
      `startTime=${rescheduledRow?.startTime.toISOString().slice(11, 16)}, providerId=${rescheduledRow?.providerId}`,
    );

    // Verify old slot (10:00) is released and bookable by a second appointment
    const customer2 = await db.customer.create({
      data: {
        id: randomUUID(),
        businessId: TEST_BUSINESS_ID,
        name: "مروان كمال",
        phone: `+2011${Math.floor(10000000 + Math.random() * 90000000)}`,
      },
    });

    const secondBookingResult = await createAppointmentRecord(
      defaultAppointmentCreateServiceDeps,
      actor,
      {
        customerId: customer2.id,
        serviceId: serviceA.id,
        providerId: independentProvider.id,
        date: bookingDate,
        startTime: bookingTime, // Released slot
        notes: "حجز في الوقت المحرر بعد إعادة الجدولة",
      },
    );

    check(
      "7. Old slot released after reschedule and successfully booked by another appointment",
      secondBookingResult.success === true,
      `secondBookingSuccess=${secondBookingResult.success}`,
    );

    // Verify new slot (11:00) is occupied and blocks conflict
    const conflictingAttempt = await createAppointmentRecord(
      defaultAppointmentCreateServiceDeps,
      actor,
      {
        customerId: customer2.id,
        serviceId: serviceA.id,
        providerId: independentProvider.id,
        date: bookingDate,
        startTime: rescheduleTime, // Occupied slot
        notes: "محاولة تعارض في الوقت الجديد",
      },
    );

    check(
      "8. New rescheduled slot is occupied and rejects conflicting appointment with SLOT_CONFLICT",
      !conflictingAttempt.success &&
        conflictingAttempt.code === "SLOT_CONFLICT",
      `code=${!conflictingAttempt.success ? conflictingAttempt.code : "SUCCESS"}`,
    );

    // ── 4. Conflict Failure Leaves Original Unchanged ──
    // Attempting to reschedule customer2's appointment to 11:00 (which is taken) must fail and leave it at 10:00
    if (secondBookingResult.success) {
      const conflictReschedule =
        await appointmentRepository.rescheduleWithConflictCheck(
          secondBookingResult.appointmentId,
          {
            date: bookingDate,
            startTime: rescheduleTime,
            endTime: rescheduleEndTime,
          },
        );

      check("9. Reschedule conflict returns null", conflictReschedule === null);

      const unchangedRow = await db.appointment.findUnique({
        where: { id: secondBookingResult.appointmentId },
      });
      check(
        "10. Conflict failure leaves original appointment untouched in DB",
        Boolean(
          unchangedRow &&
          unchangedRow.startTime.toISOString().slice(11, 16) === bookingTime,
        ),
        `actualStartTime=${unchangedRow?.startTime.toISOString().slice(11, 16)}`,
      );
    }

    // ── 5. Provider, Role and Tenant Boundaries ──
    const crossTenantCreate = await createAppointmentRecord(
      defaultAppointmentCreateServiceDeps,
      actor,
      {
        customerId: customer.id,
        serviceId: crossService.id, // Foreign business service
        date: bookingDate,
        startTime: "14:00",
        notes: "محاولة اختراق حدود المنشأة",
      },
    );
    check(
      "11. Cross-tenant service access rejected (SERVICE_UNAVAILABLE)",
      !crossTenantCreate.success &&
        crossTenantCreate.code === "SERVICE_UNAVAILABLE",
      `code=${!crossTenantCreate.success ? crossTenantCreate.code : "SUCCESS"}`,
    );

    // ── 6. ALL_SERVICES New-Service Inclusion and Explicit Exclusions ──
    // Add future Service C
    const futureService = await db.service.create({
      data: {
        id: randomUUID(),
        businessId: TEST_BUSINESS_ID,
        name: "خدمة جراحة ليزر مستقبلية",
        durationMinutes: 45,
        isActive: true,
      },
    });

    const eligibleForFuture = await providerRepository.listEligibleForService(
      TEST_BUSINESS_ID,
      futureService.id,
    );
    check(
      "12. ALL_SERVICES provider is automatically eligible for newly added service without schema/data intervention",
      eligibleForFuture.some((p) => p.id === independentProvider.id),
      `count=${eligibleForFuture.length}`,
    );

    // Add explicit exclusion for futureService
    await providerRepository.addServiceExclusion(
      TEST_BUSINESS_ID,
      independentProvider.id,
      futureService.id,
    );

    const eligibleAfterExclusion =
      await providerRepository.listEligibleForService(
        TEST_BUSINESS_ID,
        futureService.id,
      );
    check(
      "13. Explicit exclusion removes eligibility for that service only",
      !eligibleAfterExclusion.some((p) => p.id === independentProvider.id),
    );

    const eligibleForServiceB = await providerRepository.listEligibleForService(
      TEST_BUSINESS_ID,
      serviceB.id,
    );
    check(
      "14. ALL_SERVICES provider remains eligible for non-excluded services",
      eligibleForServiceB.some((p) => p.id === independentProvider.id),
    );

    // ── 7. SPECIFIC_SERVICES Does Not Expand Implicitly (ISS-003 / ISS-004) ──
    const legacyProvider = await providerRepository.createProfile(
      TEST_BUSINESS_ID,
      {
        name: "د. سمير القديم",
        displayName: "د. سمير",
        servicePolicy: "SPECIFIC_SERVICES",
      },
    );

    if (!legacyProvider) {
      throw new Error("Failed to create legacy provider profile");
    }

    // Explicitly link to Service A only
    await providerRepository.addServiceEligibility(
      TEST_BUSINESS_ID,
      legacyProvider.id,
      serviceA.id,
    );

    const legacyEligibleA = await providerRepository.listEligibleForService(
      TEST_BUSINESS_ID,
      serviceA.id,
    );
    const legacyEligibleB = await providerRepository.listEligibleForService(
      TEST_BUSINESS_ID,
      serviceB.id,
    );
    const legacyEligibleFuture =
      await providerRepository.listEligibleForService(
        TEST_BUSINESS_ID,
        futureService.id,
      );

    check(
      "15. SPECIFIC_SERVICES provider is eligible only for explicitly assigned service",
      legacyEligibleA.some((p) => p.id === legacyProvider.id) &&
        !legacyEligibleB.some((p) => p.id === legacyProvider.id) &&
        !legacyEligibleFuture.some((p) => p.id === legacyProvider.id),
    );

    // Updating unrelated fields (e.g. name, isActive) must NOT convert policy or broaden eligibility
    const updateUnrelatedResult = await updateProvider(
      defaultTeamServiceDeps,
      {
        userId: TEST_ADMIN_ID,
        businessId: TEST_BUSINESS_ID,
        role: "ADMIN",
      },
      {
        providerId: legacyProvider.id,
        name: "د. سمير بعد تعديل الاسم",
        displayName: "د. سمير م.",
        isActive: true,
      },
    );

    check(
      "16. updateProvider succeeded on unrelated fields",
      updateUnrelatedResult.success === true,
    );

    const reloadedLegacy = await providerRepository.findProfileWithinBusiness(
      legacyProvider.id,
      TEST_BUSINESS_ID,
    );
    check(
      "17. Saving unrelated fields preserved SPECIFIC_SERVICES policy without broadening",
      reloadedLegacy?.servicePolicy === "SPECIFIC_SERVICES",
      `storedPolicy=${reloadedLegacy?.servicePolicy}`,
    );

    const legacyStillExcludedFuture =
      await providerRepository.listEligibleForService(
        TEST_BUSINESS_ID,
        futureService.id,
      );
    check(
      "18. Legacy SPECIFIC_SERVICES provider did not implicitly expand to new service after unrelated edit",
      !legacyStillExcludedFuture.some((p) => p.id === legacyProvider.id),
    );

    // Explicit authorized policy upgrade
    const upgradeResult = await updateProvider(
      defaultTeamServiceDeps,
      {
        userId: TEST_ADMIN_ID,
        businessId: TEST_BUSINESS_ID,
        role: "ADMIN",
      },
      {
        providerId: legacyProvider.id,
        servicePolicy: "ALL_SERVICES",
        excludedServiceIds: [serviceB.id],
      },
    );

    check(
      "19. Explicit policy change to ALL_SERVICES successfully updates provider",
      upgradeResult.success === true &&
        upgradeResult.provider.servicePolicy === "ALL_SERVICES",
      `policy=${upgradeResult.success ? upgradeResult.provider.servicePolicy : "FAIL"}`,
    );

    const upgradedEligibleFuture =
      await providerRepository.listEligibleForService(
        TEST_BUSINESS_ID,
        futureService.id,
      );
    const upgradedExcludedB = await providerRepository.listEligibleForService(
      TEST_BUSINESS_ID,
      serviceB.id,
    );
    check(
      "20. Upgraded provider now automatically covers new service while respecting exclusions",
      upgradedEligibleFuture.some((p) => p.id === legacyProvider.id) &&
        !upgradedExcludedB.some((p) => p.id === legacyProvider.id),
    );
  } finally {
    // Cleanup fixtures safely
    try {
      await db.appointment.deleteMany({
        where: { businessId: { in: [TEST_BUSINESS_ID, TEST_CROSS_BIZ_ID] } },
      });
      await db.providerServiceExclusion.deleteMany({
        where: { provider: { businessId: TEST_BUSINESS_ID } },
      });
      await db.providerService.deleteMany({
        where: { provider: { businessId: TEST_BUSINESS_ID } },
      });
      await db.providerProfile.deleteMany({
        where: { businessId: TEST_BUSINESS_ID },
      });
      await db.customer.deleteMany({
        where: { businessId: TEST_BUSINESS_ID },
      });
      await db.service.deleteMany({
        where: { businessId: { in: [TEST_BUSINESS_ID, TEST_CROSS_BIZ_ID] } },
      });
      await db.business.updateMany({
        where: { id: { in: [TEST_BUSINESS_ID, TEST_CROSS_BIZ_ID] } },
        data: { defaultBranchId: null },
      });
      await db.branch.deleteMany({
        where: { businessId: { in: [TEST_BUSINESS_ID, TEST_CROSS_BIZ_ID] } },
      });
      await db.business.deleteMany({
        where: { id: { in: [TEST_BUSINESS_ID, TEST_CROSS_BIZ_ID] } },
      });
      await db.user.deleteMany({
        where: { id: TEST_ADMIN_ID },
      });
    } catch {
      // Ignore cleanup error in finally
    }
  }

  // ── Results Summary ──
  console.log("\n=== FlowPilot Booking Acceptance DB Verification Matrix ===");
  let allPass = true;
  for (const c of checks) {
    const mark = c.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`${mark} : ${c.label}`);
    if (c.details) {
      console.log(`         (${c.details})`);
    }
    if (!c.pass) allPass = false;
  }

  console.log(
    `\nTotal: ${checks.length} | Passed: ${checks.filter((c) => c.pass).length} | Failed: ${checks.filter((c) => !c.pass).length}`,
  );
  if (!allPass) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    "Booking acceptance DB verification failed with exception:",
    err,
  );
  process.exit(1);
});
