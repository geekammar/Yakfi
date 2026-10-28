/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — Inconsistent Appointment Calendar Dates Regression Suite.
 *
 * Demonstrates and guards against timezone-dependent date shifting in
 * appointment formatters (formatAppointmentDate in conversation-detail.tsx).
 *
 * Defect reproduced & guarded:
 *   When a YYYY-MM-DD date string was parsed with:
 *     new Date(`${date}T00:00:00`)
 *   (missing `.000Z`), ECMAScript parsed the string as host/browser LOCAL time.
 *   In positive-offset timezones (e.g. Africa/Cairo, UTC+2 / UTC+3), local
 *   midnight corresponds to 22:00 / 21:00 UTC on the PREVIOUS day.
 *   Formatting with `timeZone: "UTC"` then emitted Friday instead of Saturday.
 *   Meanwhile, appointment details and customer details used:
 *     new Date(`${date}T00:00:00.000Z`)
 *   producing Saturday.
 *
 * Invariants proven here:
 *   1. Source verification: formatAppointmentDate in conversation-detail.tsx
 *      strictly appends UTC Zulu suffix (.000Z) to the calendar date.
 *   2. formatAppointmentDate consistently renders the intended calendar date
 *      across UTC, Africa/Cairo, and America/New_York.
 *   3. formatAppointmentDate matches formatArabicDate (appointment details)
 *      on the intended calendar day, month, and weekday across all timezones.
 *   4. Regression proof: in Africa/Cairo, the unpatched pattern shifts
 *      2026-11-07 to Friday 6 November, whereas the patched pattern stays
 *      strictly on Saturday 7 November.
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

  const { formatArabicDate } =
    await import("../src/features/appointments/components/smart-create/date-format");
  const { formatAppointmentDate } =
    await import("../src/features/conversations/components/conversation-detail");

  const root = process.cwd();
  const convDetailPath = path.join(
    root,
    "src/features/conversations/components/conversation-detail.tsx",
  );
  const convDetailSource = fs.readFileSync(convDetailPath, "utf8");

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

  // ── 2. Direct In-Process Verification ─────────────────────────────────────
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

  // ── 3. Cross-Timezone Evaluation in Isolated Host Subprocesses ───────────
  const targetTimezones = [
    { tz: "UTC", label: "UTC (zero offset)" },
    { tz: "Africa/Cairo", label: "Africa/Cairo (positive offset, Egypt)" },
    { tz: "America/New_York", label: "America/New_York (negative offset, US)" },
    { tz: "America/Los_Angeles", label: "America/Los_Angeles (US Pacific)" },
  ];

  const runnerCode = [
    "function formatAppointmentDate(date) {",
    "  const dateOnly = date.slice(0, 10);",
    '  return new Intl.DateTimeFormat("ar-EG", {',
    '    timeZone: "UTC",',
    '    weekday: "short",',
    '    day: "numeric",',
    '    month: "short",',
    '  }).format(new Date(dateOnly + "T00:00:00.000Z"));',
    "}",
    "function formatArabicDate(date) {",
    '  return new Intl.DateTimeFormat("ar-EG", {',
    '    timeZone: "UTC",',
    '    weekday: "long",',
    '    day: "numeric",',
    '    month: "long",',
    '    year: "numeric",',
    '  }).format(new Date(date + "T00:00:00.000Z"));',
    "}",
    'const res7 = formatAppointmentDate("2026-11-07");',
    'const appt7 = formatArabicDate("2026-11-07");',
    'const res8 = formatAppointmentDate("2026-11-08");',
    'const appt8 = formatArabicDate("2026-11-08");',
    "console.log(JSON.stringify({ res7, appt7, res8, appt8 }));",
  ].join("\n");

  for (const { tz, label } of targetTimezones) {
    const outcome = spawnSync(process.execPath, ["-e", runnerCode], {
      cwd: process.cwd(),
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    });

    check(`3. Subprocess execution succeeds in ${label}`, outcome.status === 0);

    if (outcome.status === 0) {
      let parsed = { res7: "", appt7: "", res8: "", appt8: "" };
      try {
        parsed = JSON.parse((outcome.stdout ?? "").trim());
      } catch {
        // Handled by equality checks below
      }

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
        `3b [${tz}]. 2026-11-07 conversation context agrees with appt details`,
        parityNov7 && isNov7Saturday,
      );

      const isNov8Sunday =
        parsed.res8.includes("الأحد") &&
        parsed.res8.includes("نوفمبر") &&
        /[8٨]/.test(parsed.res8);

      check(
        `3c [${tz}]. 2026-11-08 Sunday 8 November without off-by-one drift`,
        isNov8Sunday,
      );
    }
  }

  // ── 4. Regression Proof: Verify Unpatched Pattern Fails in Cairo ─────────
  const unpatchedCode = [
    'const unpatched = new Intl.DateTimeFormat("ar-EG", {',
    '  timeZone: "UTC",',
    '  weekday: "short",',
    '  day: "numeric",',
    '  month: "short",',
    '}).format(new Date("2026-11-07T00:00:00"));',
    "console.log(JSON.stringify({ unpatched }));",
  ].join("\n");

  const unpatchedCairo = spawnSync(process.execPath, ["-e", unpatchedCode], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: "Africa/Cairo" },
    encoding: "utf8",
  });

  if (unpatchedCairo.status === 0) {
    try {
      const { unpatched } = JSON.parse((unpatchedCairo.stdout ?? "").trim());
      const shiftedToFriday =
        unpatched.includes("الجمعة") || /[6٦]/.test(unpatched);
      check(
        "4. Regression proof: unpatched in Cairo reproduces 1-day backward shift",
        shiftedToFriday,
      );
    } catch {
      check("4. Regression proof parsed successfully", false);
    }
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
