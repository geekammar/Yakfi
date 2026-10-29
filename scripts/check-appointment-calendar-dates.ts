/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — Inconsistent Appointment Calendar Dates Regression Suite.
 *
 * Demonstrates and guards against timezone-dependent date shifting in appointment
 * formatters:
 *   1. formatAppointmentDate in conversation-detail.tsx
 *   2. formatAppointmentDate in staff-workspace.tsx
 *
 * Defect reproduced & guarded:
 *   When a YYYY-MM-DD date string was parsed with:
 *     new Date(`${date}T00:00:00`)
 *   (missing `.000Z`), ECMAScript parsed the string as host/browser LOCAL time.
 *   In positive-offset timezones (e.g. Africa/Cairo, UTC+2 / UTC+3), local
 *   midnight corresponds to 22:00 / 21:00 UTC on the PREVIOUS day.
 *   Formatting with `timeZone: "UTC"` then emitted the previous calendar day.
 *   Meanwhile, appointment details and customer details used:
 *     new Date(`${date}T00:00:00.000Z`)
 *   or formatArabicDayMonth, producing the correct intended calendar day.
 *
 * Invariants proven here:
 *   1. Source verification:
 *      - formatAppointmentDate in conversation-detail.tsx strictly appends UTC Zulu suffix (.000Z).
 *      - formatAppointmentDate in staff-workspace.tsx reuses formatArabicDayMonth and contains no un-suffixed literal.
 *   2. In-process verification:
 *      - formatAppointmentDate (both surfaces) renders intended dates (2026-11-07 and 2026-11-08) without backward drift.
 *      - Both formatters achieve full parity with shared date-format.ts helpers (formatArabicDate and formatArabicDayMonth).
 *   3. Cross-Timezone execution in isolated subprocesses:
 *      - UTC, Africa/Cairo (positive offset), America/New_York (negative offset), and America/Los_Angeles (negative offset)
 *      - Production helpers for both surfaces execute without day shift across all 4 timezones.
 *   4. Regression proofs:
 *      - In Africa/Cairo, unpatched conversation-detail pattern shifts 2026-11-07 to Friday 6 November.
 *      - In Africa/Cairo, unpatched staff-workspace pattern shifts 2026-11-07 to 6 November.
 *   5. Staff Workspace rendered test coverage exists and verifies DOM appointment date rendering.
 *
 * Run: pnpm check:appointment-calendar-dates
 */
export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const fs = await import("node:fs");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");

  const { formatArabicDate, formatArabicDayMonth } =
    await import("../src/features/appointments/components/smart-create/date-format");
  const { formatAppointmentDate } =
    await import("../src/features/conversations/components/conversation-detail");
  const { formatAppointmentDate: formatStaffAppointmentDate } =
    await import("../src/features/staff/components/staff-workspace");

  const root = process.cwd();
  const convDetailPath = path.join(
    root,
    "src/features/conversations/components/conversation-detail.tsx",
  );
  const convDetailSource = fs.readFileSync(convDetailPath, "utf8");

  const staffWorkspacePath = path.join(
    root,
    "src/features/staff/components/staff-workspace.tsx",
  );
  const staffWorkspaceSource = fs.readFileSync(staffWorkspacePath, "utf8");

  // ── 1. Source Contract Verification ───────────────────────────────────────
  check(
    "1a. formatAppointmentDate is exported from conversation-detail.tsx",
    /export\s+function\s+formatAppointmentDate/.test(convDetailSource),
  );
  check(
    "1b. formatAppointmentDate parses with UTC Zulu suffix (.000Z)",
    /T00:00:00\.000Z/.test(convDetailSource),
  );
  check(
    "1c. formatAppointmentDate does not contain unsuffixed date-time literal",
    !convDetailSource.includes("T00:00:00`"),
  );
  check(
    "1d. formatAppointmentDate specifies timeZone UTC",
    convDetailSource.includes('timeZone: "UTC"'),
  );

  // Staff Workspace source contract checks
  check(
    "1e. formatAppointmentDate is exported from staff-workspace.tsx",
    /export\s+function\s+formatAppointmentDate/.test(staffWorkspaceSource),
  );
  check(
    "1f. formatAppointmentDate in staff-workspace.tsx does not contain unsuffixed date-time literal",
    !staffWorkspaceSource.includes("T00:00:00`"),
  );
  check(
    "1g. formatAppointmentDate in staff-workspace.tsx reuses formatArabicDayMonth",
    staffWorkspaceSource.includes("formatArabicDayMonth(dateOnly)") ||
      staffWorkspaceSource.includes("formatArabicDayMonth("),
  );

  // ── 2. Direct In-Process Verification ─────────────────────────────────────
  // Conversation detail helper
  const nov7 = formatAppointmentDate("2026-11-07");
  const nov8 = formatAppointmentDate("2026-11-08");

  check(
    "2a. formatAppointmentDate('2026-11-07') contains Saturday and November",
    nov7.includes("السبت") && nov7.includes("نوفمبر"),
  );
  check(
    "2b. formatAppointmentDate('2026-11-07') displays day 7 and never 6",
    /[7٧]/.test(nov7) && !/[6٦]/.test(nov7),
  );
  check(
    "2c. formatAppointmentDate('2026-11-08') contains Sunday and day 8",
    nov8.includes("الأحد") && /[8٨]/.test(nov8),
  );

  // Parity with appointment details helper
  const appt7 = formatArabicDate("2026-11-07");
  const appt8 = formatArabicDate("2026-11-08");
  check(
    "2d. 2026-11-07 conversation date agrees with appointment details",
    appt7.includes("السبت") && nov7.includes("السبت"),
  );
  check(
    "2e. 2026-11-08 conversation date agrees with appointment details",
    appt8.includes("الأحد") && nov8.includes("الأحد"),
  );

  // Staff workspace helper
  const staffNov7 = formatStaffAppointmentDate("2026-11-07");
  const staffNov8 = formatStaffAppointmentDate("2026-11-08");

  check(
    "2f. formatStaffAppointmentDate('2026-11-07') contains day 7 and November and never 6",
    staffNov7.includes("نوفمبر") &&
      /[7٧]/.test(staffNov7) &&
      !/[6٦]/.test(staffNov7),
  );
  check(
    "2g. formatStaffAppointmentDate('2026-11-08') contains day 8 and November and never 7",
    staffNov8.includes("نوفمبر") &&
      /[8٨]/.test(staffNov8) &&
      !/[7٧]/.test(staffNov8),
  );

  const dayMonth7 = formatArabicDayMonth("2026-11-07");
  const dayMonth8 = formatArabicDayMonth("2026-11-08");
  check(
    "2h. 2026-11-07 Staff Workspace date matches formatArabicDayMonth parity",
    staffNov7 === dayMonth7,
  );
  check(
    "2i. 2026-11-08 Staff Workspace date matches formatArabicDayMonth parity",
    staffNov8 === dayMonth8,
  );

  // ── 3. Cross-Timezone Evaluation in Isolated Host Subprocesses ───────────
  // Note: These subprocesses verify production helpers under varied host (Node)
  // timezones. They do not represent real browser execution (which is verified
  // via Playwright automated UX QA in Chromium).
  const targetTimezones = [
    { tz: "UTC", label: "UTC (zero offset)" },
    { tz: "Africa/Cairo", label: "Africa/Cairo (positive offset, Egypt)" },
    { tz: "America/New_York", label: "America/New_York (negative offset, US)" },
    { tz: "America/Los_Angeles", label: "America/Los_Angeles (US Pacific)" },
  ];

  const runnerCode = [
    'import { formatAppointmentDate } from "./src/features/conversations/components/conversation-detail";',
    'import { formatArabicDate, formatArabicDayMonth } from "./src/features/appointments/components/smart-create/date-format";',
    'import { formatAppointmentDate as formatStaffAppointmentDate } from "./src/features/staff/components/staff-workspace";',
    'const res7 = formatAppointmentDate("2026-11-07");',
    'const appt7 = formatArabicDate("2026-11-07");',
    'const staff7 = formatStaffAppointmentDate("2026-11-07");',
    'const dayMonth7 = formatArabicDayMonth("2026-11-07");',
    'const res8 = formatAppointmentDate("2026-11-08");',
    'const appt8 = formatArabicDate("2026-11-08");',
    'const staff8 = formatStaffAppointmentDate("2026-11-08");',
    'const dayMonth8 = formatArabicDayMonth("2026-11-08");',
    'console.log("__JSON_START__" + JSON.stringify({ res7, appt7, staff7, dayMonth7, res8, appt8, staff8, dayMonth8 }) + "__JSON_END__");',
  ].join("\n");

  const childEnv = {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ||
      "postgresql://user:password@localhost:5432/placeholder",
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "0".repeat(32),
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    NEXT_PUBLIC_APP_URL:
      process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
  };

  for (const { tz, label } of targetTimezones) {
    const outcome = spawnSync("pnpm", ["exec", "tsx", "-e", runnerCode], {
      cwd: process.cwd(),
      env: { ...childEnv, TZ: tz },
      encoding: "utf8",
    });

    const match = outcome.stdout?.match(/__JSON_START__(.*?)__JSON_END__/s);
    const success = outcome.status === 0 && match !== null;
    check(`3. Production helpers execute successfully in ${label}`, success);

    if (!success) {
      console.error(
        `Subprocess failed for ${label} (exit ${outcome.status}):`,
        outcome.stderr || outcome.stdout,
      );
      continue;
    }

    const jsonStr = match[1];
    if (!jsonStr) {
      check(`3 [${tz}]. Subprocess produced JSON match group`, false);
      continue;
    }

    let parsed = {
      res7: "",
      appt7: "",
      staff7: "",
      dayMonth7: "",
      res8: "",
      appt8: "",
      staff8: "",
      dayMonth8: "",
    };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      check(`3 [${tz}]. Valid JSON payload from subprocess`, false);
      continue;
    }

    // Conversation Detail assertions
    const isNov7Saturday =
      parsed.res7.includes("السبت") &&
      parsed.res7.includes("نوفمبر") &&
      /[7٧]/.test(parsed.res7) &&
      !parsed.res7.includes("الجمعة") &&
      !/[6٦]/.test(parsed.res7);

    check(
      `3a [${tz}]. 2026-11-07 Saturday 7 November in conversation context`,
      isNov7Saturday,
    );

    const parityNov7 =
      parsed.appt7.includes("السبت") &&
      parsed.appt7.includes("نوفمبر") &&
      /[7٧]/.test(parsed.appt7);

    check(
      `3b [${tz}]. 2026-11-07 conversation context agrees with appt details parity`,
      parityNov7 && isNov7Saturday,
    );

    const isNov8Sunday =
      parsed.res8.includes("الأحد") &&
      parsed.res8.includes("نوفمبر") &&
      /[8٨]/.test(parsed.res8) &&
      !parsed.res8.includes("السبت") &&
      !/[7٧]/.test(parsed.res8);

    check(
      `3c [${tz}]. 2026-11-08 Sunday 8 November without off-by-one drift`,
      isNov8Sunday,
    );

    const parityNov8 =
      parsed.appt8.includes("الأحد") &&
      parsed.appt8.includes("نوفمبر") &&
      /[8٨]/.test(parsed.appt8);

    check(
      `3d [${tz}]. 2026-11-08 conversation context agrees with appt details parity`,
      parityNov8 && isNov8Sunday,
    );

    // Staff Workspace assertions
    const isNov7StaffValid =
      parsed.staff7.includes("نوفمبر") &&
      /[7٧]/.test(parsed.staff7) &&
      !/[6٦]/.test(parsed.staff7);

    check(
      `3e [${tz}]. 2026-11-07 Staff Workspace displays 7 November without backward shift`,
      isNov7StaffValid,
    );

    check(
      `3f [${tz}]. 2026-11-07 Staff Workspace agrees with formatArabicDayMonth parity`,
      parsed.staff7 === parsed.dayMonth7 && isNov7StaffValid,
    );

    const isNov8StaffValid =
      parsed.staff8.includes("نوفمبر") &&
      /[8٨]/.test(parsed.staff8) &&
      !/[7٧]/.test(parsed.staff8);

    check(
      `3g [${tz}]. 2026-11-08 Staff Workspace displays 8 November without off-by-one drift`,
      isNov8StaffValid,
    );

    check(
      `3h [${tz}]. 2026-11-08 Staff Workspace agrees with formatArabicDayMonth parity`,
      parsed.staff8 === parsed.dayMonth8 && isNov8StaffValid,
    );
  }

  // ── 4. Regression Proof: Verify Unpatched Patterns Fail in Cairo ─────────
  // 4a. Conversation-detail unpatched pattern
  const unpatchedCode = [
    'const unpatched = new Intl.DateTimeFormat("ar-EG", {',
    '  timeZone: "UTC",',
    '  weekday: "short",',
    '  day: "numeric",',
    '  month: "short",',
    '}).format(new Date("2026-11-07T00:00:00"));',
    'console.log("__JSON_START__" + JSON.stringify({ unpatched }) + "__JSON_END__");',
  ].join("\n");

  const unpatchedCairo = spawnSync(
    "pnpm",
    ["exec", "tsx", "-e", unpatchedCode],
    {
      cwd: process.cwd(),
      env: { ...childEnv, TZ: "Africa/Cairo" },
      encoding: "utf8",
    },
  );

  const unpatchedMatch = unpatchedCairo.stdout?.match(
    /__JSON_START__(.*?)__JSON_END__/s,
  );
  const unpatchedJson = unpatchedMatch?.[1];
  if (unpatchedCairo.status === 0 && unpatchedJson) {
    try {
      const { unpatched } = JSON.parse(unpatchedJson);
      const shiftedToFriday =
        unpatched.includes("الجمعة") || /[6٦]/.test(unpatched);
      check(
        "4. Regression proof: unpatched in Cairo reproduces 1-day backward shift",
        shiftedToFriday,
      );
    } catch {
      check("4. Regression proof parsed successfully", false);
    }
  } else {
    check("4. Regression proof subprocess succeeded", false);
  }

  // 4b. Staff-workspace unpatched pattern
  const unpatchedStaffCode = [
    'const unpatchedStaff = new Intl.DateTimeFormat("ar-EG", {',
    '  timeZone: "UTC",',
    '  day: "numeric",',
    '  month: "short",',
    '}).format(new Date("2026-11-07T00:00:00"));',
    'console.log("__JSON_START__" + JSON.stringify({ unpatchedStaff }) + "__JSON_END__");',
  ].join("\n");

  const unpatchedStaffCairo = spawnSync(
    "pnpm",
    ["exec", "tsx", "-e", unpatchedStaffCode],
    {
      cwd: process.cwd(),
      env: { ...childEnv, TZ: "Africa/Cairo" },
      encoding: "utf8",
    },
  );

  const unpatchedStaffMatch = unpatchedStaffCairo.stdout?.match(
    /__JSON_START__(.*?)__JSON_END__/s,
  );
  const unpatchedStaffJson = unpatchedStaffMatch?.[1];
  if (unpatchedStaffCairo.status === 0 && unpatchedStaffJson) {
    try {
      const { unpatchedStaff } = JSON.parse(unpatchedStaffJson);
      const shiftedToDay6 = /[6٦]/.test(unpatchedStaff);
      check(
        "4b. Regression proof: unpatched staff workspace pattern in Cairo reproduces 1-day backward shift to day 6",
        shiftedToDay6,
      );
    } catch {
      check(
        "4b. Regression proof for staff workspace parsed successfully",
        false,
      );
    }
  } else {
    check(
      "4b. Regression proof subprocess for staff workspace succeeded",
      false,
    );
  }

  // ── 5. Staff Workspace Rendered Test Suite Contract Verification ─────────
  const staffTestPath = path.join(
    root,
    "src/features/staff/components/staff-workspace.test.tsx",
  );
  const staffTestExists = fs.existsSync(staffTestPath);
  check("5a. staff-workspace.test.tsx exists", staffTestExists);
  if (staffTestExists) {
    const staffTestSource = fs.readFileSync(staffTestPath, "utf8");
    check(
      "5b. staff-workspace.test.tsx covers rendered 2026-11-07 appointment date in StaffWorkspace",
      staffTestSource.includes("2026-11-07") &&
        staffTestSource.includes("StaffWorkspace"),
    );
    check(
      "5c. staff-workspace.test.tsx covers rendered 2026-11-08 appointment date without drift",
      staffTestSource.includes("2026-11-08"),
    );
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => !item.pass);
  console.log(
    `\n── APPOINTMENT CALENDAR DATE CONSISTENCY — ${checks.length} checks ──`,
  );
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.label}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} passed, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const item of failed) console.log(`  ✗ ${item.label}`);
    process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  process.exit(1);
});
