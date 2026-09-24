/**
 * FlowPilot — B-07 POST-SHIP UX POLISH check (friction audit).
 *
 * Offline, in-memory verification of the post-ship polish slice for the
 * Smart Create Appointment flow and the global navigation that
 * surrounds it (no DB, no network, no LLM, no API tokens, no secrets):
 *
 *   1.  customer search → create preserves the typed NAME
 *   2.  customer search → create preserves the typed PHONE
 *   3.  customer search → create preserves BOTH (either order)
 *   4.  invalid typed text is dropped, never fabricated into a customer
 *   5.  relative "after 1 week" resolves to anchor + 7
 *   6.  relative "after 2 weeks" resolves to anchor + 14
 *   7.  the default date is explicit: every relative choice resolves to
 *       a valid date with a visible caption, and a period's candidate
 *       window defaults to the deterministic resolved date (never a
 *       guess, never "nearest calendar date")
 *   8.  an unavailable date/slot cannot bypass the availability
 *       authority (the membership guard the steps use rejects it, and
 *       the date modules contain no availability engine)
 *   9.  appointment creation still goes through the ONE canonical write
 *       path; the touched UI introduces no second writer
 *  10.  the conflict invariant remains intact — a REAL overlapping
 *       create is rejected as SLOT_CONFLICT and nothing is stored
 *  11.  the FlowPilot brand resolves to the canonical home of each area
 *  12.  the profile menu does NOT create a duplicate Settings surface
 *  13.  the Arabic copy carries the corrected "اختر سريعًا" wording
 *
 * Behavioral booking invariants (conflict rejection, tenant isolation,
 * active-service rule, server-derived endTime/status) remain covered by
 * `check:appointment-creation`; this script re-asserts the conflict
 * invariant through the same canonical writer so the polish cannot
 * silently weaken it.
 *
 * Run: pnpm check:booking-ux
 */

import type {
  Appointment,
  Business,
  Customer,
  Service,
} from "../src/types/domain";

export {};

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  // Placeholder env FIRST: the service modules import the repository
  // singletons, which construct the (lazy) Prisma client at import
  // time. Nothing connects — the harness never calls the fakes' DB.
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { deriveCustomerFormDefaults } =
    await import("../src/features/customers/customer-form-defaults");
  const {
    RELATIVE_DATE_OPTIONS,
    formatArabicDayMonth,
    moveDate,
    relativeDateWindow,
    resolveRelativeDate,
  } =
    await import("../src/features/appointments/components/smart-create/date-format");
  const { slotExistsIn } =
    await import("../src/features/appointments/components/smart-create/slot-helpers");
  const { createAppointmentRecord } =
    await import("../src/features/appointments/server/appointment-create-service");
  const {
    APP_NAV_ITEMS,
    ADMIN_NAV_ITEMS,
    PLATFORM_NAV_ITEMS,
    STAFF_NAV_ITEMS,
  } = await import("../src/lib/app-config");
  const { appointmentDateSchema } = await import("../src/lib/validation");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }
  function eq<T>(actual: T, expected: T): boolean {
    return actual === expected;
  }

  // ─── Customer-create input preservation (search → Add new customer) ──

  const nameOnly = deriveCustomerFormDefaults("أحمد محمود");
  check(
    "1 a typed name is carried into the create form",
    eq(nameOnly.name, "أحمد محمود") && eq(nameOnly.phone, ""),
  );

  const phoneOnly = deriveCustomerFormDefaults("+201000000001");
  check(
    "2 a typed phone is carried into the create form",
    eq(nameOnly.name, "أحمد محمود") &&
      eq(phoneOnly.phone, "+201000000001") &&
      eq(phoneOnly.name, ""),
  );

  const bothOrders = [
    deriveCustomerFormDefaults("أحمد 01001234567"),
    deriveCustomerFormDefaults("01001234567 أحمد"),
  ];
  check(
    "3 a typed name AND phone are both carried (either order)",
    bothOrders.every(
      (result) => eq(result.name, "أحمد") && eq(result.phone, "01001234567"),
    ),
  );

  const junk = deriveCustomerFormDefaults("ا");
  const blank = deriveCustomerFormDefaults("   ");
  check(
    "4 text that is neither a valid name nor phone fabricates nothing",
    eq(junk.name, "") &&
      eq(junk.phone, "") &&
      eq(blank.name, "") &&
      eq(blank.phone, ""),
  );

  // ─── Relative scheduling (B-07 §B) ────────────────────────────────────

  // 2026-09-19 is a Saturday — the start of its own Sat–Fri week.
  const TODAY = "2026-09-19";

  check(
    "5 relative «بعد أسبوع» resolves to anchor + 7 days",
    eq(resolveRelativeDate(TODAY, "after-1-week"), moveDate(TODAY, 7)) &&
      eq(resolveRelativeDate(TODAY, "after-1-week"), "2026-09-26"),
  );

  check(
    "6 relative «بعد أسبوعين» resolves to anchor + 14 days",
    eq(resolveRelativeDate(TODAY, "after-2-weeks"), moveDate(TODAY, 14)) &&
      eq(resolveRelativeDate(TODAY, "after-2-weeks"), "2026-10-03"),
  );

  const everyResolved = RELATIVE_DATE_OPTIONS.map((choice) =>
    resolveRelativeDate(TODAY, choice.option),
  );
  check(
    "7 the default date is explicit: every relative choice resolves to a valid date with a visible caption",
    everyResolved.every(
      (date) =>
        appointmentDateSchema.safeParse(date).success &&
        formatArabicDayMonth(date).length > 0,
    ),
  );

  const weekWindow = relativeDateWindow(TODAY, "after-1-week");
  const windowOk = weekWindow
    ? eq(weekWindow[0], resolveRelativeDate(TODAY, "after-1-week")) &&
      weekWindow.every((date) => appointmentDateSchema.safeParse(date).success)
    : false;
  check(
    "7b a period's candidate window defaults to the deterministic resolved date",
    windowOk,
  );

  check(
    "7c exact-day choices (today/tomorrow) offer no fabricated window",
    eq(relativeDateWindow(TODAY, "today"), null) &&
      eq(relativeDateWindow(TODAY, "tomorrow"), null),
  );

  // ─── Availability authority is never bypassed ────────────────────────

  const authoritySlots = [
    { startTime: "09:00", endTime: "09:30" },
    { startTime: "10:00", endTime: "10:30" },
  ];
  check(
    "8 a date/time the authority did not return cannot be selected as bookable",
    slotExistsIn({ startTime: "09:15", endTime: "09:45" }, authoritySlots) ===
      false &&
      slotExistsIn({ startTime: "11:00", endTime: "11:30" }, authoritySlots) ===
        false &&
      slotExistsIn(authoritySlots[1] ?? null, authoritySlots) === true,
  );

  // The date step must not host a second availability engine: its modules
  // contain no availability action import (structural, like check 17a of
  // the creation suite).
  const dateFormatSource = await readModuleSource(
    "../src/features/appointments/components/smart-create/date-format.ts",
  );
  const dateStepSource = await readModuleSource(
    "../src/features/appointments/components/smart-create/date-step.tsx",
  );
  check(
    "8b the date modules contain no client-side availability engine",
    !dateFormatSource.includes("getAvailability") &&
      !dateFormatSource.includes("availability-actions") &&
      !dateStepSource.includes("getAvailability") &&
      !dateStepSource.includes("availability-actions"),
  );

  // ─── The canonical write path + conflict invariant ───────────────────

  const wizardSource = await readModuleSource(
    "../src/features/appointments/components/smart-create/smart-create-appointment.tsx",
  );
  check(
    "9 creation still uses the single canonical createAppointment write path",
    wizardSource.includes(
      'from "@/features/appointments/actions/appointment-actions"',
    ) &&
      wizardSource.includes("createAppointment") &&
      !wizardSource.includes("prisma") &&
      !wizardSource.includes("@/server/repositories"),
  );

  // A REAL conflict through the canonical writer (minimal in-memory
  // collaborators — the repository contract only).
  const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
  const BRANCH_A = "44444444-4444-4444-8444-444444444444";
  const USER_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const CUSTOMER_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
  const SERVICE_A = "33333333-3333-4333-8333-333333333331";
  const DATE = "2026-09-24";

  const stored: Array<{
    id: string;
    businessId: string;
    branchId: string;
    assignedUserId: string;
    date: string;
    startTime: string;
    endTime: string;
  }> = [];
  let nextId = 0;

  const business: Business = {
    id: BUSINESS_A,
    confirmationMode: "manual",
    timezone: "Africa/Cairo",
    workingHours: {
      sat: { open: "09:00", close: "17:00", closed: false },
      sun: { open: "09:00", close: "17:00", closed: false },
      mon: { open: "09:00", close: "17:00", closed: false },
      tue: { open: "09:00", close: "17:00", closed: false },
      wed: { open: "09:00", close: "17:00", closed: false },
      thu: { open: "09:00", close: "17:00", closed: false },
      fri: { open: "09:00", close: "17:00", closed: false },
    },
  } as unknown as Business;

  const deps = {
    customerRepository: {
      findById: async () =>
        ({ id: CUSTOMER_A, businessId: BUSINESS_A }) as Customer,
    },
    serviceRepository: {
      findById: async () =>
        ({
          id: SERVICE_A,
          businessId: BUSINESS_A,
          isActive: true,
          durationMinutes: 30,
        }) as Service,
    },
    businessRepository: { findById: async () => business },
    branchRepository: {
      findDefaultByBusiness: async () =>
        ({ id: BRANCH_A, businessId: BUSINESS_A }) as unknown as {
          id: string;
          businessId: string;
        },
    },
    appointmentRepository: {
      createWithConflictCheck: async (input: {
        businessId: string;
        branchId: string;
        assignedUserId: string;
        date: string;
        startTime: string;
        endTime: string;
      }) => {
        const overlaps = stored.some(
          (row) =>
            row.businessId === input.businessId &&
            row.branchId === input.branchId &&
            row.assignedUserId === input.assignedUserId &&
            row.date === input.date &&
            input.startTime < row.endTime &&
            row.startTime < input.endTime,
        );
        if (overlaps) return null;
        const row = { id: `appt-${++nextId}`, ...input };
        stored.push(row);
        return row as unknown as Appointment;
      },
    },
  } as unknown as Parameters<typeof createAppointmentRecord>[0];

  const actor = {
    userId: USER_A,
    role: "ADMIN" as const,
    businessId: BUSINESS_A,
  };
  const create = (startTime: string) =>
    createAppointmentRecord(deps, actor, {
      customerId: CUSTOMER_A,
      serviceId: SERVICE_A,
      date: DATE,
      startTime,
      notes: "",
    });

  const first = await create("10:00");
  const conflict = await create("10:15"); // 10:15–10:45 overlaps 10:00–10:30
  const free = await create("10:30"); // exactly adjacent — no overlap

  check(
    "10a an overlapping create is rejected as SLOT_CONFLICT",
    first.success === true &&
      conflict.success === false &&
      "code" in conflict &&
      eq(conflict.code, "SLOT_CONFLICT"),
  );
  check(
    "10b the blocked create stored nothing, the adjacent one still booked",
    eq(stored.length, 2) &&
      stored.every((row) => row.id.startsWith("appt-")) &&
      free.success === true,
  );

  // ─── Global navigation ────────────────────────────────────────────────

  check(
    "11 the FlowPilot brand resolves to the canonical home of each area",
    eq(APP_NAV_ITEMS[0]?.href, "/") && // (app) — dashboard; redirects STAFF
      eq(STAFF_NAV_ITEMS[0]?.href, "/staff") &&
      eq(ADMIN_NAV_ITEMS[0]?.href, "/admin") &&
      eq(PLATFORM_NAV_ITEMS[0]?.href, "/platform"),
  );

  const appShellSource = await readModuleSource(
    "../src/components/shared/layout/app-shell.tsx",
  );
  check(
    "11b the shell renders the brand as a link to the area home (not dead text)",
    appShellSource.includes("next/link") &&
      appShellSource.includes("navItems[0]?.href") &&
      appShellSource.includes("href={homeHref}"),
  );

  const settingsEntries = [
    ...APP_NAV_ITEMS,
    ...STAFF_NAV_ITEMS,
    ...ADMIN_NAV_ITEMS,
    ...PLATFORM_NAV_ITEMS,
  ].filter((item) => item.href === "/settings");
  const userMenuSource = await readModuleSource(
    "../src/features/auth/components/user-menu.tsx",
  );
  check(
    "12 the profile menu adds no duplicate Settings surface (one nav item, no menu link)",
    eq(settingsEntries.length, 1) && !userMenuSource.includes("/settings"),
  );

  // ─── Arabic copy / RTL microcopy ──────────────────────────────────────

  check(
    "13 the date step uses the corrected «اختر سريعًا» wording",
    dateStepSource.includes("اختر سريعًا") &&
      !dateStepSource.includes("اختر سرعاً"),
  );

  // ─── Summary ──────────────────────────────────────────────────────────

  const failures = checks.filter((item) => !item.pass);
  for (const item of checks) {
    console.log(`${item.pass ? "✓" : "✗"} ${item.label}`);
  }
  console.log(
    `\n${checks.length - failures.length}/${checks.length} checks passed`,
  );
  if (failures.length > 0) {
    console.log("\nFAILED:");
    for (const item of failures) console.log(`  ✗ ${item.label}`);
    process.exit(1);
  }
  console.log("RESULT: PASSED ✅");
}

/** Read a module's source text (for the structural checks). */
async function readModuleSource(relativePath: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const url = await import("node:url");
  const here = url.fileURLToPath(new URL(import.meta.url));
  return readFileSync(resolve(here, "..", relativePath), "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
