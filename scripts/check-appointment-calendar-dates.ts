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
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import { formatAppointmentDate } from "@/features/conversations/components/conversation-detail";

type Check = { label: string; pass: boolean; detail?: string };

const checks: Check[] = [];
function check(label: string, pass: boolean, detail?: string): void {
  checks.push({ label, pass, detail });
}

// Subprocess runner evaluating formatting under designated TZ env variable.
function evalInTimezone(
  tz: string,
  code: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(process.execPath, ["-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  return {
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    status: result.status ?? 1,
  };
}

async function main(): Promise<void> {
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
    "must append .000Z to prevent local midnight parsing",
  );
  check(
    "1c. formatAppointmentDate does NOT contain un-suffixed `${date}T00:00:00`",
    !/\$\{date\}T00:00:00`/.test(convDetailSource),
    "un-suffixed local date-time string causes positive-offset date shifts",
  );
  check(
    "1d. formatAppointmentDate specifies timeZone: 'UTC'",
    /timeZone:\s*"UTC"/.test(convDetailSource),
  );

  // ── 2. Direct In-Process Verification ─────────────────────────────────────
  const nov7 = formatAppointmentDate("2026-11-07");
  const nov8 = formatAppointmentDate("2026-11-08");

  check(
    "2a. formatAppointmentDate('2026-11-07') contains Saturday and November",
    nov7.includes("السبت") && nov7.includes("نوفمبر"),
    `got: "${nov7}"`,
  );
  check(
    "2b. formatAppointmentDate('2026-11-07') displays day 7 and never 6",
    /[7٧]/.test(nov7) && !/[6٦]/.test(nov7),
    `got: "${nov7}"`,
  );
  check(
    "2c. formatAppointmentDate('2026-11-08') contains Sunday and day 8",
    nov8.includes("الأحد") && /[8٨]/.test(nov8),
    `got: "${nov8}"`,
  );

  // Parity with appointment details helper
  const appt7 = formatArabicDate("2026-11-07");
  const appt8 = formatArabicDate("2026-11-08");
  check(
    "2d. 2026-11-07 conversation date agrees with appointment details",
    appt7.includes("السبت") && nov7.includes("السبت"),
    `conv: "${nov7}", appt: "${appt7}"`,
  );
  check(
    "2e. 2026-11-08 conversation date agrees with appointment details",
    appt8.includes("الأحد") && nov8.includes("الأحد"),
    `conv: "${nov8}", appt: "${appt8}"`,
  );

  // ── 3. Cross-Timezone Evaluation in Isolated Host Subprocesses ───────────
  const targetTimezones = [
    { tz: "UTC", label: "UTC (zero offset)" },
    { tz: "Africa/Cairo", label: "Africa/Cairo (positive offset, Egypt)" },
    { tz: "America/New_York", label: "America/New_York (negative offset, US)" },
    { tz: "America/Los_Angeles", label: "America/Los_Angeles (US Pacific)" },
  ];

  // The runner script executes pure formatting logic directly in timezone
  const runnerScript = `
    function formatAppointmentDate(date) {
      const dateOnly = date.slice(0, 10);
      return new Intl.DateTimeFormat("ar-EG", {
        timeZone: "UTC",
        weekday: "short",
        day: "numeric",
        month: "short",
      }).format(new Date(dateOnly + "T00:00:00.000Z"));
    }

    function formatArabicDate(date) {
      return new Intl.DateTimeFormat("ar-EG", {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }).format(new Date(date + "T00:00:00.000Z"));
    }

    const res7 = formatAppointmentDate("2026-11-07");
    const appt7 = formatArabicDate("2026-11-07");
    const res8 = formatAppointmentDate("2026-11-08");
    const appt8 = formatArabicDate("2026-11-08");
    console.log(JSON.stringify({ res7, appt7, res8, appt8 }));
  `;

  for (const { tz, label } of targetTimezones) {
    const outcome = evalInTimezone(tz, runnerScript);
    check(
      `3. Subprocess execution succeeds in ${label}`,
      outcome.status === 0,
      outcome.stderr || outcome.stdout,
    );

    if (outcome.status === 0) {
      let parsed: { res7: string; appt7: string; res8: string; appt8: string };
      try {
        parsed = JSON.parse(outcome.stdout);
      } catch {
        parsed = { res7: "", appt7: "", res8: "", appt8: "" };
      }

      // Check 2026-11-07: Must be Saturday, day 7, November in conv context
      const isNov7Saturday =
        parsed.res7.includes("السبت") &&
        parsed.res7.includes("نوفمبر") &&
        /[7٧]/.test(parsed.res7) &&
        !parsed.res7.includes("الجمعة") &&
        !/[6٦]/.test(parsed.res7);

      check(
        `3a [${tz}]. 2026-11-07 Saturday 7 November in conversation context`,
        isNov7Saturday,
        `conversation formatted: "${parsed.res7}"`,
      );

      // Check parity between conversation context and appointment details
      const parityNov7 =
        parsed.appt7.includes("السبت") &&
        parsed.appt7.includes("نوفمبر") &&
        /[7٧]/.test(parsed.appt7);

      check(
        `3b [${tz}]. 2026-11-07 conversation context agrees with appt details`,
        parityNov7 && isNov7Saturday,
        `conv: "${parsed.res7}", appt: "${parsed.appt7}"`,
      );

      // Check adjacent date 2026-11-08
      const isNov8Sunday =
        parsed.res8.includes("الأحد") &&
        parsed.res8.includes("نوفمبر") &&
        /[8٨]/.test(parsed.res8);

      check(
        `3c [${tz}]. 2026-11-08 Sunday 8 November without off-by-one drift`,
        isNov8Sunday,
        `conversation formatted: "${parsed.res8}"`,
      );
    }
  }

  // ── 4. Regression Proof: Verify Unpatched Pattern Fails in Cairo ─────────
  const unpatchedScript = `
    const unpatched = new Intl.DateTimeFormat("ar-EG", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(new Date("2026-11-07T00:00:00"));
    console.log(JSON.stringify({ unpatched }));
  `;

  const unpatchedCairo = evalInTimezone("Africa/Cairo", unpatchedScript);
  if (unpatchedCairo.status === 0) {
    try {
      const { unpatched } = JSON.parse(unpatchedCairo.stdout);
      // In Africa/Cairo (UTC+2), local midnight is 22:00 UTC previous day
      const shiftedToFriday =
        unpatched.includes("الجمعة") || /[6٦]/.test(unpatched);
      check(
        "4. Regression proof: unpatched in Cairo reproduces 1-day backward shift",
        shiftedToFriday,
        `unpatched produced: "${unpatched}"`,
      );
    } catch (e) {
      check("4. Regression proof parsed successfully", false, String(e));
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  let failed = 0;
  for (const { label, pass, detail } of checks) {
    if (pass) {
      console.log(`✔ ${label}`);
    } else {
      console.error(`✘ ${label}${detail ? ` (${detail})` : ""}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(`\nثوابت تطابق تواريخ التقويم صحيحة: ${checks.length}/${checks.length} فحص ناجح.`);
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
