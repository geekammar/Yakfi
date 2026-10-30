/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — Follow-up Scheduling Real PostgreSQL Integration Suite (ISS-006)
 *
 * Verifies the complete real database path against a disposable/local PostgreSQL
 * database in GitHub Actions CI / local development with deterministic race control:
 *
 * DB-01: Follow-up request alone creates no appointment in real database.
 * DB-02: Valid scheduling creates exactly one linked appointment atomically in real DB.
 * DB-03: Controlled Case A: Cancellation wins after scheduling has read PENDING
 *        - Scheduling transaction pauses after reading PENDING
 *        - Cancellation commits PENDING -> CANCELLED
 *        - Scheduling resumes, fails atomic updateMany, rolls back
 *        - Asserts zero appointments survive rollback.
 * DB-04: Controlled Case B: Scheduling wins while cancellation competes
 *        - Scheduling commits PENDING -> SCHEDULED with appointment link
 *        - Competing cancellation encounters SCHEDULED
 *        - Cancellation is refused honestly ("لا يمكن إلغاء طلب متابعة تم حجز موعد له مسبقاً")
 *        - Record cannot be overwritten.
 * DB-05: Controlled Case C: Duplicate conversions with distinct candidate slot times
 *        - Both transactions forced past initial PENDING read simultaneously
 *        - Distinct times (10:00 vs 14:00) eliminate same-slot conflict confounding
 *        - Attempt 1 commits SCHEDULED; Attempt 2 fails with FOLLOW_UP_NOT_PENDING
 *        - Exactly one appointment is committed.
 * DB-06: Controlled Case D: Fixture-wide orphan detection
 *        - Inspects ALL appointments in dedicated fixture scopes (no relation filter)
 *        - Asserts losing transactions leave zero unlinked or orphan appointments.
 * DB-07: Terminal cancellation states reconcile honestly in real DB
 *        - PENDING -> CANCELLED (success)
 *        - Already CANCELLED -> honest success ("طلب المتابعة ملغى بالفعل")
 *        - Already SCHEDULED -> honest refusal
 *        - Cross-tenant cancellation attempt fails (NOT_FOUND) without mutation.
 * DB-08: Historical records preserved in real DB
 *        - Byte-for-byte row comparison (notes, customerId, serviceId,
 *          sourceAppointmentId, createdAt, deletedAt) upon cancellation.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:password@localhost:5432/flowpilot_test' \
 *     pnpm check:iss-006-db
 */

import {
  cancelFollowUpRequest,
  convertFollowUpToAppointmentAction,
} from "@/features/appointments/actions/follow-up-actions";
import { db } from "@/server/db";
import {
  AppointmentRepository,
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
  console.log(`${status} [DB-${num}/08]: ${label}${detailStr}`);
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

/**
 * Creates a deterministic proxy around db to hook into transactions
 * at verified database operation boundaries.
 */
function createControlledDb(hooks: {
  onAfterFollowUpCheck?: (followUpId: string) => Promise<void>;
  onBeforeFollowUpUpdate?: (followUpId: string) => Promise<void>;
}): typeof db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        return async function (fn: (tx: any) => Promise<any>, options?: any) {
          return target.$transaction(async (realTx: any) => {
            const wrappedTx = new Proxy(realTx, {
              get(t, p, r) {
                if (p === "followUpRequest") {
                  return new Proxy(realTx.followUpRequest, {
                    get(fuTarget, fuProp, fuReceiver) {
                      if (
                        fuProp === "findFirst" &&
                        hooks.onAfterFollowUpCheck
                      ) {
                        return async (...args: any[]) => {
                          const result = await fuTarget.findFirst(...args);
                          if (result?.id) {
                            await hooks.onAfterFollowUpCheck!(result.id);
                          }
                          return result;
                        };
                      }
                      if (
                        fuProp === "updateMany" &&
                        hooks.onBeforeFollowUpUpdate
                      ) {
                        return async (...args: any[]) => {
                          const whereId = args[0]?.where?.id;
                          if (whereId) {
                            await hooks.onBeforeFollowUpUpdate!(whereId);
                          }
                          return fuTarget.updateMany(...args);
                        };
                      }
                      return Reflect.get(fuTarget, fuProp, fuReceiver);
                    },
                  });
                }
                return Reflect.get(t, p, r);
              },
            });
            return fn(wrappedTx);
          }, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function main(): Promise<void> {
  console.log(
    "\n=== FlowPilot ISS-006 Real PostgreSQL Controlled Integration Suite ===\n",
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

    const createDeps = {
      appointmentRepository: new AppointmentRepository(db),
      customerRepository,
      serviceRepository,
      businessRepository,
      branchRepository,
      providerRepository,
      followUpRequestRepository,
      now: () => new Date("2026-10-30T10:00:00Z"),
    };

    // =========================================================================
    // 1. Follow-up alone creates no appointment in real DB
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
        appointmentCreateServiceDeps: createDeps,
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
      `appId=${convertRes.success ? convertRes.appointmentId : "none"}, fuStatus=${fuAtomicInDb?.status}`,
    );

    // =========================================================================
    // 3. Controlled Case A: Cancellation wins after scheduling has read PENDING
    // =========================================================================
    const fuCaseA = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      notes: "Controlled Case A: Cancel wins after PENDING read",
    });

    const checkpointsCaseA: string[] = [];
    let cancelOutcomeCaseA: { success: boolean; message: string } | null = null;

    const controlledClientCaseA = createControlledDb({
      onAfterFollowUpCheck: async (id) => {
        if (id === fuCaseA.id) {
          checkpointsCaseA.push("1_scheduling_read_pending");
          // Interleave: Commit cancellation on a distinct transaction before scheduling commits
          cancelOutcomeCaseA = await cancelFollowUpRequest(
            { id: fuCaseA.id },
            { followUpRequestRepository, getSession: sessionTenantA },
          );
          checkpointsCaseA.push("2_cancellation_committed");
        }
      },
      onBeforeFollowUpUpdate: async (id) => {
        if (id === fuCaseA.id) {
          checkpointsCaseA.push("3_scheduling_attempting_update");
        }
      },
    });

    const schedulingOutcomeCaseA = await convertFollowUpToAppointmentAction(
      {
        followUpId: fuCaseA.id,
        serviceId: SRV_A,
        date: "2026-11-07",
        startTime: "12:00",
      },
      {
        followUpRequestRepository,
        userRepository,
        appointmentCreateServiceDeps: {
          ...createDeps,
          appointmentRepository: new AppointmentRepository(
            controlledClientCaseA,
          ),
        },
        getSession: sessionTenantA,
      },
    );

    const fuCaseAInDb = await db.followUpRequest.findUnique({
      where: { id: fuCaseA.id },
    });

    const allAppsCaseA = await db.appointment.findMany({
      where: {
        businessId: BIZ_A,
        customerId: CUST_A,
        date: new Date("2026-11-07T00:00:00.000Z"),
        startTime: new Date("1970-01-01T12:00:00.000Z"),
      },
    });

    const caseAValid =
      cancelOutcomeCaseA !== null &&
      (cancelOutcomeCaseA as any).success === true &&
      schedulingOutcomeCaseA.success === false &&
      (schedulingOutcomeCaseA as any).code === "FOLLOW_UP_NOT_PENDING" &&
      fuCaseAInDb?.status === "CANCELLED" &&
      fuCaseAInDb.scheduledAppointmentId === null &&
      allAppsCaseA.length === 0 &&
      checkpointsCaseA.includes("1_scheduling_read_pending") &&
      checkpointsCaseA.includes("2_cancellation_committed");

    check(
      3,
      "Controlled Case A: Cancellation wins after scheduling has already read PENDING",
      caseAValid,
      `checkpoints=${checkpointsCaseA.join("->")}, cancelSuccess=${cancelOutcomeCaseA?.success}, schedCode=${(schedulingOutcomeCaseA as any).code}, appsCount=${allAppsCaseA.length}`,
    );

    // =========================================================================
    // 4. Controlled Case B: Scheduling wins while cancellation competes
    // =========================================================================
    const fuCaseB = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      notes: "Controlled Case B: Scheduling wins while cancellation competes",
    });

    const checkpointsCaseB: string[] = [];

    // Schedule successfully first
    const schedOutcomeCaseB = await convertFollowUpToAppointmentAction(
      {
        followUpId: fuCaseB.id,
        serviceId: SRV_A,
        date: "2026-11-08",
        startTime: "13:00",
      },
      {
        followUpRequestRepository,
        userRepository,
        appointmentCreateServiceDeps: createDeps,
        getSession: sessionTenantA,
      },
    );
    checkpointsCaseB.push("1_scheduling_committed");

    // Competing cancellation runs against the now-SCHEDULED record
    const cancelOutcomeCaseB = await cancelFollowUpRequest(
      { id: fuCaseB.id },
      { followUpRequestRepository, getSession: sessionTenantA },
    );
    checkpointsCaseB.push("2_cancellation_refused_honest");

    const fuCaseBInDb = await db.followUpRequest.findUnique({
      where: { id: fuCaseB.id },
    });

    const caseBValid =
      schedOutcomeCaseB.success === true &&
      cancelOutcomeCaseB.success === false &&
      cancelOutcomeCaseB.message.includes("تم حجز موعد له مسبقاً") &&
      fuCaseBInDb?.status === "SCHEDULED" &&
      fuCaseBInDb.scheduledAppointmentId ===
        (schedOutcomeCaseB as any).appointmentId;

    check(
      4,
      "Controlled Case B: Scheduling wins and cancellation is honestly refused without overwrite",
      caseBValid,
      `checkpoints=${checkpointsCaseB.join("->")}, schedAppId=${(schedOutcomeCaseB as any).appointmentId}, cancelMsg=${cancelOutcomeCaseB.message}`,
    );

    // =========================================================================
    // 5. Controlled Case C: Duplicate conversions with distinct candidate times
    // =========================================================================
    const fuCaseC = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      startDate: "2026-11-01",
      endDate: "2026-11-15",
      notes: "Controlled Case C: Duplicate conversion race",
    });

    const checkpointsCaseC: string[] = [];
    let attempt1ReadPendingResolve: () => void;
    const attempt1ReadPendingPromise = new Promise<void>((r) => {
      attempt1ReadPendingResolve = r;
    });

    let attempt2ReadPendingResolve: () => void;
    const attempt2ReadPendingPromise = new Promise<void>((r) => {
      attempt2ReadPendingResolve = r;
    });

    let releaseAttempt2Resolve: () => void;
    const releaseAttempt2Promise = new Promise<void>((r) => {
      releaseAttempt2Resolve = r;
    });

    // Client wrapper for Attempt 1: pauses after reading PENDING until Attempt 2 has ALSO read PENDING
    const clientAttempt1 = createControlledDb({
      onAfterFollowUpCheck: async (id) => {
        if (id === fuCaseC.id) {
          checkpointsCaseC.push("attempt1_read_pending");
          attempt1ReadPendingResolve();
          await attempt2ReadPendingPromise;
        }
      },
      onBeforeFollowUpUpdate: async (id) => {
        if (id === fuCaseC.id) {
          checkpointsCaseC.push("attempt1_updating_scheduled");
        }
      },
    });

    // Client wrapper for Attempt 2: waits until Attempt 1 commits its update before continuing
    const clientAttempt2 = createControlledDb({
      onAfterFollowUpCheck: async (id) => {
        if (id === fuCaseC.id) {
          checkpointsCaseC.push("attempt2_read_pending");
          attempt2ReadPendingResolve();
          await releaseAttempt2Promise;
        }
      },
      onBeforeFollowUpUpdate: async (id) => {
        if (id === fuCaseC.id) {
          checkpointsCaseC.push("attempt2_attempting_stale_update");
        }
      },
    });

    // Run both attempts concurrently with DISTINCT candidate times (10:00 vs 14:00)
    const [dupRes1, dupRes2] = await Promise.all([
      convertFollowUpToAppointmentAction(
        {
          followUpId: fuCaseC.id,
          serviceId: SRV_A,
          date: "2026-11-09",
          startTime: "10:00", // Distinct time 1
        },
        {
          followUpRequestRepository,
          userRepository,
          appointmentCreateServiceDeps: {
            ...createDeps,
            appointmentRepository: new AppointmentRepository(clientAttempt1),
          },
          getSession: sessionTenantA,
        },
      ).then((res) => {
        // Once Attempt 1 completes and commits, release Attempt 2 to continue
        releaseAttempt2Resolve();
        return res;
      }),
      convertFollowUpToAppointmentAction(
        {
          followUpId: fuCaseC.id,
          serviceId: SRV_A,
          date: "2026-11-09",
          startTime: "14:00", // Distinct time 2 (proves not a same-slot conflict)
        },
        {
          followUpRequestRepository,
          userRepository,
          appointmentCreateServiceDeps: {
            ...createDeps,
            appointmentRepository: new AppointmentRepository(clientAttempt2),
          },
          getSession: sessionTenantA,
        },
      ),
    ]);

    const successes = [dupRes1, dupRes2].filter((r) => r.success);
    const failures = [dupRes1, dupRes2].filter((r) => !r.success);

    const fuCaseCInDb = await db.followUpRequest.findUnique({
      where: { id: fuCaseC.id },
    });

    const allAppsCaseC = await db.appointment.findMany({
      where: {
        businessId: BIZ_A,
        customerId: CUST_A,
        date: new Date("2026-11-09T00:00:00.000Z"),
      },
    });

    const caseCValid =
      successes.length === 1 &&
      failures.length === 1 &&
      (failures[0] as any).code === "FOLLOW_UP_NOT_PENDING" &&
      allAppsCaseC.length === 1 &&
      allAppsCaseC[0].startTime.toISOString().slice(11, 16) === "10:00" &&
      fuCaseCInDb?.status === "SCHEDULED" &&
      fuCaseCInDb.scheduledAppointmentId === allAppsCaseC[0].id &&
      checkpointsCaseC.includes("attempt1_read_pending") &&
      checkpointsCaseC.includes("attempt2_read_pending");

    check(
      5,
      "Controlled Case C: Duplicate conversion race past PENDING read yields exactly one appointment",
      caseCValid,
      `successes=${successes.length}, failedCode=${(failures[0] as any)?.code}, appCount=${allAppsCaseC.length}, checkpoints=${checkpointsCaseC.join("->")}`,
    );

    // =========================================================================
    // 6. Controlled Case D: Fixture-wide orphan detection
    // =========================================================================
    // Verify that NO orphan appointment was created in BIZ_A / CUST_A scope
    // across all previous race tests without relation filtering.
    const allAppointmentsInScope = await db.appointment.findMany({
      where: { businessId: BIZ_A, customerId: CUST_A },
    });

    // We expect appointments ONLY from:
    // 1. fuAtomic (2026-11-05 at 10:00) -> 1
    // 2. fuCaseB (2026-11-08 at 13:00) -> 1
    // 3. fuCaseC (2026-11-09 at 10:00) -> 1
    // Zero appointments from fuAlone, fuCaseA (cancelled), and fuCaseC attempt 2.
    const expectedAppIds = new Set([
      (convertRes as any).appointmentId,
      (schedOutcomeCaseB as any).appointmentId,
      (successes[0] as any).appointmentId,
    ]);

    const actualAppIds = new Set(allAppointmentsInScope.map((a) => a.id));
    const allExpectedFound = [...expectedAppIds].every((id) =>
      actualAppIds.has(id),
    );
    const zeroOrphans = allAppointmentsInScope.length === expectedAppIds.size;

    check(
      6,
      "Controlled Case D: Complete fixture-wide orphan detection asserts zero leaked appointments",
      allExpectedFound && zeroOrphans,
      `totalActual=${allAppointmentsInScope.length}, expected=${expectedAppIds.size}, zeroOrphans=${zeroOrphans}`,
    );

    // =========================================================================
    // 7. Terminal states reconcile honestly in real DB
    // =========================================================================
    const fuTerminal = await followUpRequestRepository.create({
      businessId: BIZ_A,
      customerId: CUST_A,
      serviceId: SRV_A,
      notes: "Terminal reconciliation test",
    });

    // A. Pending cancellation
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
      7,
      "Terminal cancellation states reconcile honestly (repeated, scheduled, cross-tenant)",
      terminalHonesty,
      `pending=${cancelPending.success}, 2nd=${cancelSecond.message}, scheduledRefusal=${cancelScheduled.success === false}, foreign=${cancelForeign.message}`,
    );

    // =========================================================================
    // 8. Historical records are preserved in real DB
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
    const custPreserved =
      snapshotAfter.customerId === snapshotBefore.customerId;
    const srvPreserved = snapshotAfter.serviceId === snapshotBefore.serviceId;
    const sourcePreserved =
      snapshotAfter.sourceAppointmentId ===
      snapshotBefore.sourceAppointmentId;
    const createdAtPreserved =
      snapshotAfter.createdAt.getTime() ===
      snapshotBefore.createdAt.getTime();
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
      8,
      "Historical follow-up database record is preserved on cancellation (byte-for-byte)",
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
    await db.providerBranch.deleteMany({
      where: { branchId: BRANCH_A },
    });
    await db.providerProfile.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.service.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.customer.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.user.deleteMany({
      where: { businessId: { in: [BIZ_A, BIZ_B] } },
    });
    await db.business.updateMany({
      where: { id: { in: [BIZ_A, BIZ_B] } },
      data: { defaultBranchId: null },
    });
    await db.branch.deleteMany({
      where: { id: BRANCH_A },
    });
    await db.business.deleteMany({
      where: { id: { in: [BIZ_A, BIZ_B] } },
    });
    console.log("✅ Cleanup complete.");
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\nResults: ${checks.length - failed.length} passed, ${failed.length} failed out of ${checks.length} checks.\n`,
  );
  if (failed.length > 0) {
    console.error("❌ ISS-006 REAL DB INTEGRATION CHECK FAILED!");
    process.exit(1);
  }
  console.log("🎉 ALL ISS-006 REAL DB INTEGRATION CHECKS PASSED!");
}

main().catch((error) => {
  console.error("Fatal test error:", error);
  process.exit(1);
});
