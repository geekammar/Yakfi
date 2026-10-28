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
    'import { formatArabicDate } from "./src/features/appointments/components/smart-create/date-format";',
    'const res7 = formatAppointmentDate("2026-11-07");',
    'const appt7 = formatArabicDate("2026-11-07");',
    'const res8 = formatAppointmentDate("2026-11-08");',
    'const appt8 = formatArabicDate("2026-11-08");',
    'console.log("__JSON_START__" + JSON.stringify({ res7, appt7, res8, appt8 }) + "__JSON_END__");',
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

    let parsed = { res7: "", appt7: "", res8: "", appt8: "" };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      check(`3 [${tz}]. Valid JSON payload from subprocess`, false);
      continue;
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
  }

  // ── 4. Regression Proof: Verify Unpatched Pattern Fails in Cairo ─────────
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
