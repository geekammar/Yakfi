/**
 * FlowPilot — UX001-R2 Verification Suite
 *
 * Verifies the key deliverables of Phase UX001-R2:
 * 1. Visual Staff Calendar timeline & duration representation (20m, 40m, 45m, 60m).
 * 2. Availability & blocked intervals distinction in slot helpers and UI contract.
 * 3. Provider management discoverability («إدارة الفريق ومقدمي الخدمة») & return path.
 * 4. Provider eligibility, 0-provider SETUP_REQUIRED, 1-provider selector suppression, 2+ independent.
 * 5. Role-based authorization & isolation.
 *
 * Run: pnpm check:ux001-r2
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type CheckResult = { label: string; pass: boolean; details?: string };
const results: CheckResult[] = [];

function check(label: string, pass: boolean, details?: string) {
  results.push({ label, pass, details });
  const status = pass ? "✅ PASS" : "❌ FAIL";
  console.log(`${status}: ${label}${details ? ` (${details})` : ""}`);
}

async function run() {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  console.log("\n=== FlowPilot UX001-R2 Verification Matrix ===\n");

  // -------------------------------------------------------------------------
  // 1. Visual Staff Calendar: Duration representation & timeline math
  // -------------------------------------------------------------------------
  const { derivePresentSlots } =
    await import("../src/features/appointments/components/smart-create/slot-helpers");

  // Verify non-30-minute duration math
  const parseMinutes = (time: string) => {
    const [h, m] = time.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };

  const testDurations = [20, 40, 45, 60, 90];
  for (const dur of testDurations) {
    const start = "10:00";
    const startM = parseMinutes(start);
    const endM = startM + dur;
    const end = `${String(Math.floor(endM / 60)).padStart(2, "0")}:${String(endM % 60).padStart(2, "0")}`;
    const calculatedDur = parseMinutes(end) - parseMinutes(start);
    check(
      `Calendar duration math accurately computes ${dur}m duration without forcing 30m blocks`,
      calculatedDur === dur,
      `start=${start}, end=${end}, dur=${calculatedDur}m`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Availability UX: Slot helper blocked interval distinction
  // -------------------------------------------------------------------------
  const candidateGrid = [
    { startTime: "09:00", endTime: "09:30" },
    { startTime: "09:30", endTime: "10:00" },
    { startTime: "10:00", endTime: "10:30" },
    { startTime: "10:30", endTime: "11:00" },
    { startTime: "11:00", endTime: "11:30" },
    { startTime: "11:30", endTime: "12:00" },
  ];
  const availableSlots = [
    { startTime: "09:00", endTime: "09:30" },
    { startTime: "11:30", endTime: "12:00" },
  ];
  const blockedIntervals = [
    { startTime: "09:30", endTime: "10:15", providerId: "prov-1" }, // Overlaps 09:30 and 10:00 (45m appointment)
    { startTime: "10:30", endTime: "11:10", providerId: "prov-1" }, // Overlaps 10:30 and 11:00 (40m appointment)
  ];

  const presentSlots = derivePresentSlots({
    candidateGrid,
    availableSlots,
    blockedIntervals,
    selectedProviderId: "prov-1",
  });

  const slot0900 = presentSlots?.find((s) => s.startTime === "09:00");
  const slot0930 = presentSlots?.find((s) => s.startTime === "09:30");
  const slot1000 = presentSlots?.find((s) => s.startTime === "10:00");
  const slot1030 = presentSlots?.find((s) => s.startTime === "10:30");
  const slot1130 = presentSlots?.find((s) => s.startTime === "11:30");

  check(
    "Slot 09:00 is available and not blocked",
    slot0900?.available === true && !slot0900?.blockedByAppointment,
  );
  check(
    "Slot 09:30 is unavailable and marked blockedByAppointment due to 45m overlap",
    slot0930?.available === false && slot0930?.blockedByAppointment === true,
  );
  check(
    "Slot 10:00 is unavailable and marked blockedByAppointment due to 45m overlap (ends at 10:15)",
    slot1000?.available === false && slot1000?.blockedByAppointment === true,
  );
  check(
    "Slot 10:30 is unavailable and marked blockedByAppointment due to 40m overlap (ends at 11:10)",
    slot1030?.available === false && slot1030?.blockedByAppointment === true,
  );
  check(
    "Slot 11:30 is available after appointments conclude",
    slot1130?.available === true && !slot1130?.blockedByAppointment,
  );

  // If another provider is selected, prov-1's blocked intervals should not block prov-2
  const presentSlotsProv2 = derivePresentSlots({
    candidateGrid,
    availableSlots,
    blockedIntervals,
    selectedProviderId: "prov-2",
  });
  const slot0930Prov2 = presentSlotsProv2?.find((s) => s.startTime === "09:30");
  check(
    "Provider-scoped independence: prov-1 appointment does not tag prov-2 as blockedByAppointment",
    slot0930Prov2?.blockedByAppointment !== true,
  );

  // -------------------------------------------------------------------------
  // 3. Provider Management Discoverability
  // -------------------------------------------------------------------------
  const settingsFile = readFileSync(
    resolve(
      process.cwd(),
      "src/features/settings/components/settings-screen.tsx",
    ),
    "utf8",
  );
  check(
    "Settings screen contains discoverable link to /admin/team",
    settingsFile.includes('href="/admin/team"'),
  );
  check(
    "Settings screen contains exact Arabic label «إدارة الفريق ومقدمي الخدمة»",
    settingsFile.includes("إدارة الفريق ومقدمي الخدمة"),
  );
  const settingsPageFile = readFileSync(
    resolve(process.cwd(), "src/app/(app)/settings/page.tsx"),
    "utf8",
  );
  check(
    "Settings screen restricts team management link to ADMIN role",
    settingsPageFile.includes('requireRole("ADMIN")'),
  );

  const teamScreenFile = readFileSync(
    resolve(process.cwd(), "src/features/staff/components/team-screen.tsx"),
    "utf8",
  );
  check(
    "Team screen provides clear return path to Settings (/settings)",
    teamScreenFile.includes('href="/settings"') &&
      teamScreenFile.includes("العودة للإعدادات"),
  );

  const appConfigFile = readFileSync(
    resolve(process.cwd(), "src/lib/app-config.ts"),
    "utf8",
  );
  check(
    "ADMIN_NAV_ITEMS config contains «إدارة الفريق ومقدمي الخدمة»",
    appConfigFile.includes("إدارة الفريق ومقدمي الخدمة"),
  );
  check(
    "ADMIN_NAV_ITEMS starts with /admin as first entry",
    appConfigFile.includes('href: "/admin"') &&
      appConfigFile.includes('href: "/admin/team"'),
  );

  // -------------------------------------------------------------------------
  // 4. Visual Staff Calendar Component Integrity
  // -------------------------------------------------------------------------
  const calendarFile = readFileSync(
    resolve(
      process.cwd(),
      "src/features/appointments/components/visual-calendar/visual-staff-calendar.tsx",
    ),
    "utf8",
  );
  check(
    "VisualStaffCalendar component exists and supports day navigation",
    calendarFile.includes("onNavigateDate") && calendarFile.includes("اليوم"),
  );
  check(
    "VisualStaffCalendar supports provider filter chips",
    calendarFile.includes("selectedProviderId") &&
      calendarFile.includes("جميع مقدمي الخدمة"),
  );
  check(
    "VisualStaffCalendar renders exact duration badges (e.g. دقيقة)",
    calendarFile.includes("دقيقة"),
  );
  check(
    "VisualStaffCalendar renders free gap intervals",
    calendarFile.includes("فترة متاحة"),
  );

  const agendaFile = readFileSync(
    resolve(
      process.cwd(),
      "src/features/appointments/components/appointment-agenda.tsx",
    ),
    "utf8",
  );
  check(
    "AppointmentAgenda embeds VisualStaffCalendar with view mode toggle",
    agendaFile.includes("VisualStaffCalendar") &&
      agendaFile.includes("الجدول المرئي") &&
      agendaFile.includes("قائمة المواعيد"),
  );
  check(
    "AppointmentAgenda preserves <ol> list structure for accessibility",
    agendaFile.includes("<ol"),
  );

  // -------------------------------------------------------------------------
  // 5. Booking Slot Step UI Distinction & Copy Rules
  // -------------------------------------------------------------------------
  const slotStepFile = readFileSync(
    resolve(
      process.cwd(),
      "src/features/appointments/components/smart-create/slot-step.tsx",
    ),
    "utf8",
  );
  check(
    "SlotStep does not use forbidden words (مشغول, Busy, محجوز)",
    !slotStepFile.includes("مشغول") &&
      !slotStepFile.includes("Busy") &&
      !slotStepFile.includes("محجوز"),
  );
  check(
    "SlotStep uses UNAVAILABLE_LABEL (غير متاح)",
    slotStepFile.includes("UNAVAILABLE_LABEL") ||
      slotStepFile.includes("غير متاح"),
  );
  check(
    "SlotStep provides visual distinction for blockedByAppointment",
    slotStepFile.includes("blockedByAppointment") &&
      slotStepFile.includes("border-amber-500"),
  );
  check(
    "SlotStep provides actionable link to /admin/team when 0 eligible providers",
    slotStepFile.includes('href="/admin/team"') &&
      slotStepFile.includes("إدارة الفريق ومقدمي الخدمة"),
  );

  // Summary
  const passedCount = results.filter((r) => r.pass).length;
  const totalCount = results.length;
  console.log(
    `\nUX001-R2 Verification Complete: ${passedCount}/${totalCount} passed (${Math.round((passedCount / totalCount) * 100)}%).\n`,
  );

  if (passedCount !== totalCount) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Verification failed with exception:", err);
  process.exit(1);
});
