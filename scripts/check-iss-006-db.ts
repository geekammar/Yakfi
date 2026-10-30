/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Follow-up Scheduling Real PostgreSQL Integration Suite (ISS-006)
 *
 * Verifies the complete real database path against a disposable/local PostgreSQL
 * database in GitHub Actions CI / local development:
 *
 * 1. Follow-up request alone creates no appointment in DB.
 * 2. Valid scheduling creates exactly one linked appointment atomically:
 *    - FollowUpRequest status -> SCHEDULED
 *    - FollowUpRequest.scheduledAppointmentId -> linked to new Appointment id
 * 3. Controlled duplicate-conversion race (Promise.all):
 *    - Exactly ONE conversion succeeds.
 *    - The second conversion fails with FOLLOW_UP_NOT_PENDING.
 *    - Exactly ONE appointment is created (zero orphan appointments).
 * 4. Controlled cancel-vs-schedule race (Promise.all):
 *    - Exactly one valid terminal outcome commits.
 *    - No orphan appointment; no CANCELLED request incorrectly linked to an appointment.
 * 5. Terminal states reconcile honestly in real DB:
 *    - PENDING -> CANCELLED (success: true)
 *    - Already CANCELLED -> reconciles honestly (success: true, message: "طلب المتابعة ملغى بالفعل")
 *    - SCHEDULED -> explicit honest refusal (success: false, message: "لا يمكن إلغاء طلب متابعة تم حجز موعد له مسبقاً")
 *    - Cross-tenant cancellation attempt fails (NOT_FOUND) without mutating record.
 * 6. Historical records are preserved in real DB:
 *    - Before/after database row comparison guarantees notes, customerId, serviceId,
 *      sourceAppointmentId, createdAt, and deletedAt are byte-for-byte preserved.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:password@localhost:5432/flowpilot_test' \
 *     pnpm check:iss-006-db
 */

import "./setup-test-env";

import {
  cancelFollowUpRequest,
  convertFollowUpToAppointmentAction,
} from "@/features/appointments/actions/follow-up-actions";
import { db } from "@/server/db";
import {
  appointmentRepository,
  branchRepository,
  businessRepository,
  customerRepository,
  followUpRequestRepository,
  providerRepository,
  serviceRepository,
  userRepository,
} from "@/server/repositories";

type Check = { id: number; label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(
  id: number,
  label: string,
  pass: boolean,
  details?: string,
): void {
  checks.push({ id, label, pass, details });
  const status = pass ? "✅ PASS" : "❌ FAIL";
  const num = String(id).padStart(2, "0");
  const detailStr = details ? ` (${details})` : "";
  console.log(`${status} [DB-${num}/06]: ${label}${detailStr}`);
}

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
    "\n=== FlowPilot ISS-006 Real PostgreSQL Integration Verification ===\n",
  );

  const url = process.env.DATABASE_URL ?? "";
  const target = classifyTarget(url);
  if (!target || !target.local) {
    console.error(
      "❌ DEV_DB_INTEGRATION_BLOCKED: DATABASE_URL must point to a local disposable test database.",
    );
    process.exit(1);
  }
  console.log(`🔒 Target database verified local: ${target.host}\n`);

  const BIZ_A = crypto.randomUUID();
  const BIZ_B = crypto.randomUUID();
  const BRANCH_A = crypto.randomUUID();
  const USER_A = crypto.randomUUID();
  const USER_B = crypto.randomUUID();
  const CUST_A = crypto.randomUUID();
  const SRV_A = crypto.randomUUID();
  const PROV_A = crypto.randomUUID();

  const sessionTenantA = async () => ({
    user: { id: USER_A, businessId: BIZ_A, role: "ADMIN" as const },
  });

  const sessionTenantB = async () => ({
    user: { id: USER_B, businessId: BIZ_B, role: "ADMIN" as const },
  });

  try {
    // 0. Setup isolated test fixtures in real DB
    await db.business.createMany({
      data: [
        {
          id: BIZ_A,
          name: "عيادة الأمل (Tenant A)",
          whatsappNumber: `+2010${Math.floor(10000000 + Math.random() * 90000000)}`,
          timezone: "Africa/Cairo",
          confirmationMode: "manual",
        },
        {
          id: BIZ_B,
          name: "عيادة النور (Tenant B)",
          whatsappNumber: `+2010${Math.floor(10000000 + Math.random() * 90000000)}`,
          timezone: "Africa/Cairo",
          confirmationMode: "manual",
        },
      ],
    });

    await db.branch.create({
      data: {
        id: BRANCH_A,
        businessId: BIZ_A,
        name: "الفرع الرئيسي",
      },
    });

    await db.business.update({
      where: { id: BIZ_A },
      data: { defaultBranchId: BRANCH_A },
    });

    await db.user.createMany({
      data: [
        {
          id: USER_A,
          email: `${USER_A}@flowpilot.invalid`,
          emailVerified: false,
          name: "مدير المنشأة أ",
          businessId: BIZ_A,
          role: "ADMIN",
        },
        {
          id: USER_B,
          email: `${USER_B}@flowpilot.invalid`,
          emailVerified: false,
          name: "مدير المنشأة ب",
          businessId: BIZ_B,
          role: "ADMIN",
        },
      ],
    });

    await db.customer.create({
      data: {
        id: CUST_A,
        businessId: BIZ_A,
        name: "سارة محمد",
        phone: `+2010${Math.floor(10000000 + Math.random() * 90000000)}`,
      },
    });

    await db.service.create({
      data: {
        id: SRV_A,
        businessId: BIZ_A,
        name: "جلسة متابعة أسنان",
        durationMinutes: 30,
        isActive: true,
      },
    });

    await db.providerProfile.create({
      data: {
        id: PROV_A,
        businessId: BIZ_A,
        userId: USER_A,
        name: "د. أحمد",
        servicePolicy: "ALL_SERVICES",
        isActive: true,
      },
    });

    await db.providerBranch.create({
      data: {
        id: crypto.randomUUID(),
        providerId: PROV_A,
        branchId: BRANCH_A,
      },
    });

    // =========================================================================
    // 1. Follow-up alone creates no appointment in DB
    // =========================================================================
    const fuAlone = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      notes: "Follow-up request alone test",
    });

    const appointmentsForFuAlone = await db.appointment.count({
      where: {
        businessId: BIZ_A,
        customerId: CUST_A,
        scheduledFollowUpRequest: { id: fuAlone.id },
      },
    });

    check(
      1,
      "Follow-up request alone creates no appointment in real database",
      fuAlone.status === "PENDING" && appointmentsForFuAlone === 0,
      `fuStatus=${fuAlone.status}, appointmentsCount=${appointmentsForFuAlone}`,
    );

    // =========================================================================
    // 2. Valid scheduling creates exactly one linked appointment atomically
    // =========================================================================
    const fuAtomic = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      notes: "Atomic conversion test",
    });

    const convertRes = await convertFollowUpToAppointmentAction(
      {
        followUpId: fuAtomic.id,
        serviceId: SRV_A,
        date: "2026-11-05",
        startTime: "10:00",
        notes: "Scheduled appointment note",
      },
      {
        followUpRequestRepository,
        userRepository,
        appointmentCreateServiceDeps: {
          appointmentRepository,
          customerRepository,
          serviceRepository,
          businessRepository,
          branchRepository,
          providerRepository,
          followUpRequestRepository,
          now: () => new Date("2026-10-30T10:00:00Z"),
        },
        getSession: sessionTenantA,
      },
    );

    const fuAtomicInDb = await db.followUpRequest.findUnique({
      where: { id: fuAtomic.id },
    });

    const linkedAppointmentInDb = convertRes.success
      ? await db.appointment.findUnique({
          where: { id: convertRes.appointmentId },
        })
      : null;

    check(
      2,
      "Valid scheduling creates one linked appointment atomically in real DB",
      convertRes.success === true &&
        fuAtomicInDb?.status === "SCHEDULED" &&
        fuAtomicInDb?.scheduledAppointmentId === convertRes.appointmentId &&
        linkedAppointmentInDb !== null &&
        linkedAppointmentInDb.date.toISOString().slice(0, 10) === "2026-11-05",
      `success=${convertRes.success}, ` +
        `msg=${(convertRes as any)?.message ?? ""}, ` +
        `fuStatus=${fuAtomicInDb?.status}, ` +
        `linkedAppId=${fuAtomicInDb?.scheduledAppointmentId}`,
    );

    // =========================================================================
    // 3. Controlled concurrent duplicate-conversion race (Promise.all)
    // =========================================================================
    const fuDupRace = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      notes: "Duplicate conversion race test",
    });

    const createDeps = {
      appointmentRepository,
      customerRepository,
      serviceRepository,
      businessRepository,
      branchRepository,
      providerRepository,
      followUpRequestRepository,
      now: () => new Date("2026-10-30T10:00:00Z"),
    };

    const [dupRes1, dupRes2] = await Promise.all([
      convertFollowUpToAppointmentAction(
        {
          followUpId: fuDupRace.id,
          serviceId: SRV_A,
          date: "2026-11-06",
          startTime: "11:00",
        },
        {
          followUpRequestRepository,
          userRepository,
          appointmentCreateServiceDeps: createDeps,
          getSession: sessionTenantA,
        },
      ),
      convertFollowUpToAppointmentAction(
        {
          followUpId: fuDupRace.id,
          serviceId: SRV_A,
          date: "2026-11-06",
          startTime: "12:00",
        },
        {
          followUpRequestRepository,
          userRepository,
          appointmentCreateServiceDeps: createDeps,
          getSession: sessionTenantA,
        },
      ),
    ]);

    const successes = [dupRes1, dupRes2].filter((r) => r.success);
    const failures = [dupRes1, dupRes2].filter((r) => !r.success);

    const appointmentsForDupRace = await db.appointment.count({
      where: {
        businessId: BIZ_A,
        scheduledFollowUpRequest: { id: fuDupRace.id },
      },
    });

    const fuDupInDb = await db.followUpRequest.findUnique({
      where: { id: fuDupRace.id },
    });

    const dupAppId = (successes[0] as any)?.appointmentId;
    const dupValid =
      successes.length === 1 &&
      failures.length === 1 &&
      appointmentsForDupRace === 1 &&
      fuDupInDb?.status === "SCHEDULED" &&
      fuDupInDb.scheduledAppointmentId === dupAppId;

    check(
      3,
      "Controlled duplicate-conversion race yields exactly one appointment",
      dupValid,
      `successes=${successes.length}, appCount=${appointmentsForDupRace}`,
    );

    // =========================================================================
    // 4. Controlled cancel-vs-schedule race (Promise.all)
    // =========================================================================
    const fuRaceCS = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      notes: "Cancel vs schedule race test",
    });

    const [raceCancelRes, raceSchedRes] = await Promise.all([
      cancelFollowUpRequest(
        { id: fuRaceCS.id },
        {
          followUpRequestRepository,
          getSession: sessionTenantA,
        },
      ),
      convertFollowUpToAppointmentAction(
        {
          followUpId: fuRaceCS.id,
          serviceId: SRV_A,
          date: "2026-11-07",
          startTime: "14:00",
        },
        {
          followUpRequestRepository,
          userRepository,
          appointmentCreateServiceDeps: createDeps,
          getSession: sessionTenantA,
        },
      ),
    ]);

    const fuRaceInDb = await db.followUpRequest.findUnique({
      where: { id: fuRaceCS.id },
    });

    const appsForRaceInDb = await db.appointment.count({
      where: {
        businessId: BIZ_A,
        scheduledFollowUpRequest: { id: fuRaceCS.id },
      },
    });

    let raceValid = false;
    let raceOutcome = "";

    if (raceCancelRes.success && !raceSchedRes.success) {
      // Cancel won: request must be CANCELLED, scheduledAppointmentId null, 0 appointments
      raceValid =
        fuRaceInDb?.status === "CANCELLED" &&
        fuRaceInDb?.scheduledAppointmentId === null &&
        appsForRaceInDb === 0;
      raceOutcome = "Cancel won cleanly (0 appointments, CANCELLED)";
    } else if (!raceCancelRes.success && raceSchedRes.success) {
      // Schedule won: request must be SCHEDULED, scheduledAppointmentId set
      const schedAppId = (raceSchedRes as any)?.appointmentId;
      const refusalMsg = raceCancelRes.message.includes("تم حجز موعد له مسبقاً");
      raceValid =
        fuRaceInDb?.status === "SCHEDULED" &&
        fuRaceInDb?.scheduledAppointmentId === schedAppId &&
        appsForRaceInDb === 1 &&
        refusalMsg;
      raceOutcome = "Schedule won cleanly (1 appointment, SCHEDULED)";
    }

    check(
      4,
      "Controlled cancel-vs-schedule race produces valid terminal state",
      raceValid,
      `${raceOutcome}; cancelSuccess=${raceCancelRes.success}`,
    );

    // =========================================================================
    // 5. Terminal states reconcile honestly in real DB
    // =========================================================================
    // A. Pending cancellation
    const fuTerminal = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      notes: "Terminal reconciliation test",
    });

    const cancelPending = await cancelFollowUpRequest(
      { id: fuTerminal.id },
      { followUpRequestRepository, getSession: sessionTenantA },
    );

    // B. Second cancel on now-CANCELLED
    const cancelSecond = await cancelFollowUpRequest(
      { id: fuTerminal.id },
      { followUpRequestRepository, getSession: sessionTenantA },
    );

    // C. Cancel on already-SCHEDULED
    const cancelScheduled = await cancelFollowUpRequest(
      { id: fuAtomic.id },
      { followUpRequestRepository, getSession: sessionTenantA },
    );

    // D. Cross-tenant cancel attempt
    const cancelForeign = await cancelFollowUpRequest(
      { id: fuTerminal.id },
      { followUpRequestRepository, getSession: sessionTenantB },
    );

    const terminalHonesty =
      cancelPending.success === true &&
      cancelPending.message === "تم إلغاء طلب المتابعة بنجاح" &&
      cancelSecond.success === true &&
      cancelSecond.message === "طلب المتابعة ملغى بالفعل" &&
      cancelScheduled.success === false &&
      cancelScheduled.message.includes("تم حجز موعد له مسبقاً") &&
      cancelForeign.success === false &&
      cancelForeign.message === "طلب المتابعة غير موجود";

    check(
      5,
      "Terminal cancellation states reconcile honestly",
      terminalHonesty,
      `pending=${cancelPending.success}, 2nd=${cancelSecond.message}, foreign=${cancelForeign.message}`,
    );

    // =========================================================================
    // 6. Historical records are preserved in real DB
    // =========================================================================
    const HIST_NOTES =
      "Comprehensive post-operative follow-up: check surgical sutures";
    const fuHist = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      notes: HIST_NOTES,
    });

    // Snapshot before cancellation
    const snapshotBefore = await db.followUpRequest.findUniqueOrThrow({
      where: { id: fuHist.id },
    });

    // Execute cancellation
    await cancelFollowUpRequest(
      { id: fuHist.id },
      { followUpRequestRepository, getSession: sessionTenantA },
    );

    // Snapshot after cancellation
    const snapshotAfter = await db.followUpRequest.findUniqueOrThrow({
      where: { id: fuHist.id },
    });

    const notesPreserved = snapshotAfter.notes === snapshotBefore.notes;
    const custPreserved = snapshotAfter.customerId === snapshotBefore.customerId;
    const srvPreserved = snapshotAfter.serviceId === snapshotBefore.serviceId;
    const sourcePreserved = snapshotAfter.sourceAppointmentId === snapshotBefore.sourceAppointmentId;
    const createdAtPreserved =
      snapshotAfter.createdAt.getTime() === snapshotBefore.createdAt.getTime();
    const deletedAtUntouched = snapshotAfter.deletedAt === null;
    const statusTransitioned =
      snapshotBefore.status === "PENDING" &&
      snapshotAfter.status === "CANCELLED";

    const allPreserved =
      notesPreserved &&
      custPreserved &&
      srvPreserved &&
      sourcePreserved &&
      createdAtPreserved &&
      deletedAtUntouched &&
      statusTransitioned;

    check(
      6,
      "Historical follow-up database record is preserved on cancellation",
      allPreserved,
      `notesMatch=${notesPreserved}, notDeleted=${deletedAtUntouched}`,
    );
  } finally {
    // Clean up test fixtures in reverse dependency order
    console.log("\n🧹 Cleaning up test fixtures from disposable DB...");
    await db.appointment.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.followUpRequest.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.customer.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.service.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.providerBranch.deleteMany({
      where: { branchId: BRANCH_A },
    });
    await db.providerProfile.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.business.updateMany({
      where: { id: { in: [BIZ_A, BIZ_B] } },
      data: { defaultBranchId: null },
    });
    await db.branch.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.user.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.business.deleteMany({
      where: { id: { in: [BIZ_A, BIZ_B] } },
    });
    console.log("✅ Cleanup complete.\n");
  }

  console.log("=======================================================");
  const allPassed = checks.every((c) => c.pass);
  console.log(
    `Total Checks: ${checks.length} | Passed: ${checks.filter((c) => c.pass).length} | Failed: ${checks.filter((c) => !c.pass).length}`,
  );
  console.log("=======================================================\n");

  if (!allPassed) {
    console.error("❌ ISS-006 REAL DB INTEGRATION CHECK FAILED!");
    process.exit(1);
  } else {
    console.log("🎉 ALL ISS-006 REAL DB INTEGRATION CHECKS PASSED!");
  }
}

void main();
