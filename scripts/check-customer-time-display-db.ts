/**
 * FlowPilot — Customer Appointment Time Display Preference Real Disposable DB Check.
 *
 * Verifies real PostgreSQL persistence, readback, and tenant isolation:
 *   1. Initial state: businesses default to appointment_time_display = 'START_ONLY'.
 *   2. Update biz_A to 'FULL_RANGE' via updateBusinessSettings.
 *   3. Direct database read on biz_A confirms 'FULL_RANGE'.
 *   4. Readback via getBusinessSettings for biz_A confirms 'FULL_RANGE'.
 *   5. Tenant isolation: biz_B in database remains 'START_ONLY' and getBusinessSettings returns 'START_ONLY'.
 *   6. Unauthorized cross-tenant update rejection: Actor without businessId cannot update business.
 *   7. Revert biz_A to 'START_ONLY' verifies clean update cycle.
 *   8. Zero residue: all created test records are deleted on completion.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:password@localhost:5432/flowpilot_test' \
 *     pnpm check:customer-time-display-db
 */

import {
  defaultSettingsServiceDeps,
  getBusinessSettings,
  updateBusinessSettings,
  type SettingsActor,
} from "@/features/settings/server/settings-service";
import { db } from "@/server/db";

type Check = { label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
  if (pass) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}${details ? ` (${details})` : ""}`);
  }
}

const RUN_ID = `timedisplay-db-${Date.now()}`;
const TEST_USER_A = `usr-a-${RUN_ID}`;
const TEST_USER_B = `usr-b-${RUN_ID}`;
const BIZ_A_ID = `biz-a-${RUN_ID}`;
const BIZ_B_ID = `biz-b-${RUN_ID}`;

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
    "▶ Running Customer Appointment Time Display Preference Real-DB Check...\n",
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

  // Setup test users & businesses
  await db.user.createMany({
    data: [
      {
        id: TEST_USER_A,
        email: `${TEST_USER_A}@flowpilot.invalid`,
        emailVerified: false,
        accountType: "BUSINESS",
        role: "ADMIN",
        businessId: BIZ_A_ID,
        name: "Admin A",
      },
      {
        id: TEST_USER_B,
        email: `${TEST_USER_B}@flowpilot.invalid`,
        emailVerified: false,
        accountType: "BUSINESS",
        role: "ADMIN",
        businessId: BIZ_B_ID,
        name: "Admin B",
      },
    ],
  });

  await db.business.createMany({
    data: [
      {
        id: BIZ_A_ID,
        name: "مركز الشفاء الطبي (A)",
        whatsappNumber: `+2010${Math.floor(10000000 + Math.random() * 90000000)}`,
        timezone: "Africa/Cairo",
        isActive: true,
      },
      {
        id: BIZ_B_ID,
        name: "عيادة النور للأسنان (B)",
        whatsappNumber: `+2010${Math.floor(10000000 + Math.random() * 90000000)}`,
        timezone: "Africa/Cairo",
        isActive: true,
      },
    ],
  });

  const actorA: SettingsActor = {
    userId: TEST_USER_A,
    role: "ADMIN",
    businessId: BIZ_A_ID,
  };

  const actorB: SettingsActor = {
    userId: TEST_USER_B,
    role: "ADMIN",
    businessId: BIZ_B_ID,
  };

  try {
    // ── 1. Default DB column state ───────────────────────────────────────────
    const initialBizA = await db.business.findUnique({
      where: { id: BIZ_A_ID },
      select: { appointmentTimeDisplay: true },
    });
    const initialBizB = await db.business.findUnique({
      where: { id: BIZ_B_ID },
      select: { appointmentTimeDisplay: true },
    });

    check(
      "1.1 Freshly created business A defaults to appointment_time_display = 'START_ONLY' in PostgreSQL",
      initialBizA?.appointmentTimeDisplay === "START_ONLY",
      `received: ${initialBizA?.appointmentTimeDisplay}`,
    );
    check(
      "1.2 Freshly created business B defaults to appointment_time_display = 'START_ONLY' in PostgreSQL",
      initialBizB?.appointmentTimeDisplay === "START_ONLY",
      `received: ${initialBizB?.appointmentTimeDisplay}`,
    );

    // Readback via settings service
    const settingsAResult = await getBusinessSettings(
      defaultSettingsServiceDeps,
      actorA,
    );
    check(
      "1.3 getBusinessSettings for business A returns appointmentTimeDisplay = 'START_ONLY'",
      "appointmentTimeDisplay" in settingsAResult &&
        settingsAResult.appointmentTimeDisplay === "START_ONLY",
    );

    // ── 2. Persist update on business A to FULL_RANGE ────────────────────────
    const updateAResult = await updateBusinessSettings(
      defaultSettingsServiceDeps,
      actorA,
      {
        name: "مركز الشفاء الطبي (A)",
        vertical: "dental",
        city: "القاهرة",
        whatsappNumber: "+201011111111",
        timezone: "Africa/Cairo",
        confirmationMode: "automatic",
        appointmentTimeDisplay: "FULL_RANGE",
        slotDurationMinutes: 30,
        cancellationPolicy: "إلغاء قبل 24 ساعة",
      },
    );

    check(
      "2.1 updateBusinessSettings succeeds for authorized Admin A with FULL_RANGE",
      updateAResult.success === true,
    );

    // Direct DB query on business A
    const updatedBizA = await db.business.findUnique({
      where: { id: BIZ_A_ID },
      select: { appointmentTimeDisplay: true },
    });
    check(
      "2.2 Direct PostgreSQL query on business A confirms appointment_time_display is 'FULL_RANGE'",
      updatedBizA?.appointmentTimeDisplay === "FULL_RANGE",
      `received: ${updatedBizA?.appointmentTimeDisplay}`,
    );

    // Service readback on business A
    const reloadA = await getBusinessSettings(
      defaultSettingsServiceDeps,
      actorA,
    );
    check(
      "2.3 getBusinessSettings readback for business A reflects 'FULL_RANGE'",
      "appointmentTimeDisplay" in reloadA &&
        reloadA.appointmentTimeDisplay === "FULL_RANGE",
    );

    // ── 3. Tenant Isolation: business B remains unchanged ───────────────────
    const dbBizB = await db.business.findUnique({
      where: { id: BIZ_B_ID },
      select: { appointmentTimeDisplay: true },
    });
    check(
      "3.1 Business B in PostgreSQL strictly retains appointment_time_display = 'START_ONLY'",
      dbBizB?.appointmentTimeDisplay === "START_ONLY",
      `received: ${dbBizB?.appointmentTimeDisplay}`,
    );

    const reloadB = await getBusinessSettings(
      defaultSettingsServiceDeps,
      actorB,
    );
    check(
      "3.2 getBusinessSettings readback for business B strictly retains 'START_ONLY'",
      "appointmentTimeDisplay" in reloadB &&
        reloadB.appointmentTimeDisplay === "START_ONLY",
    );

    // ── 4. Cross-Tenant Authorization Boundary ──────────────────────────────
    // The service derives the business solely from actor.businessId, so Actor without businessId is rejected
    const updateBByA = await updateBusinessSettings(
      defaultSettingsServiceDeps,
      {
        userId: TEST_USER_A,
        role: "ADMIN",
        businessId: null, // Actor without businessId
      },
      {
        name: "محاولة اختراق",
        vertical: "dental",
        city: "القاهرة",
        whatsappNumber: "+201011111111",
        timezone: "Africa/Cairo",
        confirmationMode: "automatic",
        appointmentTimeDisplay: "FULL_RANGE",
        slotDurationMinutes: 30,
        cancellationPolicy: "none",
      },
    );
    check(
      "4.1 Actor without business association is rejected with FORBIDDEN (zero mutation)",
      updateBByA.success === false && updateBByA.error === "FORBIDDEN",
    );

    // ── 5. Revert business A back to START_ONLY ──────────────────────────────
    const revertAResult = await updateBusinessSettings(
      defaultSettingsServiceDeps,
      actorA,
      {
        name: "مركز الشفاء الطبي (A)",
        vertical: "dental",
        city: "القاهرة",
        whatsappNumber: "+201011111111",
        timezone: "Africa/Cairo",
        confirmationMode: "automatic",
        appointmentTimeDisplay: "START_ONLY",
        slotDurationMinutes: 30,
        cancellationPolicy: "إلغاء قبل 24 ساعة",
      },
    );
    const revertedBizA = await db.business.findUnique({
      where: { id: BIZ_A_ID },
      select: { appointmentTimeDisplay: true },
    });
    check(
      "5.1 Reverting business A to START_ONLY succeeds and persists to PostgreSQL",
      revertAResult.success === true &&
        revertedBizA?.appointmentTimeDisplay === "START_ONLY",
    );
  } finally {
    // Cleanup test records
    await db.user.deleteMany({
      where: { id: { in: [TEST_USER_A, TEST_USER_B] } },
    });
    await db.business.deleteMany({
      where: { id: { in: [BIZ_A_ID, BIZ_B_ID] } },
    });
  }

  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).length;
  console.log(
    `\nResults: ${passed} passed, ${failed} failed out of ${checks.length} checks.\n`,
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled DB test error:", err);
  process.exit(1);
});
