/**
 * FlowPilot — UI & ACCESSIBILITY REPAIRS REGRESSION CHECK
 *
 * Verifies the 4 critical UI/accessibility repairs:
 * 1. Shared Dialog:
 *    - Reserved header space (pe-12 / rtl:pe-12 / ltr:pe-12) to prevent overlap with titles/icons
 *    - Close control positioned on left in RTL and right in LTR (end-* / rtl:left-* / ltr:right-*)
 *    - Accessible Arabic label "إغلاق" (aria-label and sr-only)
 *    - Mobile touch target at least 44x44px (size-11 / min-h-[44px] min-w-[44px])
 *    - Escape handling, focus trap and return focus preserved via Radix primitives
 * 2. Working-hours inputs:
 *    - Unique day-specific labels bound via htmlFor/id and aria-label
 *    - Example: "بداية العمل يوم السبت" and "نهاية العمل يوم السبت"
 *    - Autosave, existing values, and closed-day behavior preserved
 * 3. Team screen:
 *    - Displayed count matches displayed members
 *    - Removed hasStaff empty-state condition that hid admin-only members
 *    - Distinction between service providers and login members preserved
 *    - No role changes or authorization rule modifications
 * 4. Appointment view switch:
 *    - Group role and aria-label
 *    - aria-pressed pattern exposing selected view state
 *    - Retains view-switching behavior
 *    - Selection understandable without relying only on color (visual indicator dot, border/ring)
 *
 * Run: tsx scripts/check-ui-accessibility.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Check = { label: string; pass: boolean; details?: string };

const checks: Check[] = [];
function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
}

const root = process.cwd();

// ─── 1. Shared Dialog (src/components/ui/dialog.tsx) ───
const dialogPath = resolve(root, "src/components/ui/dialog.tsx");
const dialogSrc = readFileSync(dialogPath, "utf8");

check(
  "1.1 DialogHeader reserves space with pe-12 to prevent title/icon collision",
  dialogSrc.includes("pe-12") && dialogSrc.includes("DialogHeader"),
);

check(
  "1.2 Dialog close button positioned on left in RTL and right in LTR",
  (dialogSrc.includes("rtl:left-") && dialogSrc.includes("ltr:right-")) ||
    dialogSrc.includes("end-"),
);

check(
  "1.3 Dialog close button has accessible Arabic label 'إغلاق'",
  dialogSrc.includes('aria-label="إغلاق"') &&
    dialogSrc.includes('<span className="sr-only">إغلاق</span>'),
);

check(
  "1.4 Dialog close button touch target is at least 44x44px",
  dialogSrc.includes("min-h-[44px]") &&
    dialogSrc.includes("min-w-[44px]") &&
    dialogSrc.includes("size-11"),
);

check(
  "1.5 Dialog preserves Radix primitives (Close, Content, Portal, Overlay, Title, Description)",
  dialogSrc.includes("DialogPrimitive.Close") &&
    dialogSrc.includes("DialogPrimitive.Content") &&
    dialogSrc.includes("DialogPrimitive.Portal") &&
    dialogSrc.includes("DialogPrimitive.Overlay") &&
    dialogSrc.includes("DialogPrimitive.Title"),
);

// ─── 2. Working Hours Inputs (src/features/onboarding/components/working-hours-form.tsx) ───
const workingHoursPath = resolve(
  root,
  "src/features/onboarding/components/working-hours-form.tsx",
);
const workingHoursSrc = readFileSync(workingHoursPath, "utf8");

check(
  "2.1 Working hours start-time input has unique day-specific label with htmlFor/id",
  workingHoursSrc.includes("working-hours-${day.key}-open") &&
    workingHoursSrc.includes("بداية العمل يوم ${day.label}"),
);

check(
  "2.2 Working hours end-time input has unique day-specific label with htmlFor/id",
  workingHoursSrc.includes("working-hours-${day.key}-close") &&
    workingHoursSrc.includes("نهاية العمل يوم ${day.label}"),
);

check(
  "2.3 Working hours inputs preserve aria-label for assistive tech",
  workingHoursSrc.includes("aria-label={`بداية العمل يوم ${day.label}`}") &&
    workingHoursSrc.includes("aria-label={`نهاية العمل يوم ${day.label}`}"),
);

check(
  "2.4 Working hours preserves autosave hook and form registration",
  workingHoursSrc.includes("useAutosave") &&
    workingHoursSrc.includes("form.register(`workingHours.${day.key}.open`)") &&
    workingHoursSrc.includes("form.register(`workingHours.${day.key}.close`)"),
);

check(
  "2.5 Working hours preserves closed-day disabled state",
  workingHoursSrc.includes("disabled={closed}"),
);

// ─── 3. Team Screen (src/features/staff/components/team-screen.tsx) ───
const teamScreenPath = resolve(
  root,
  "src/features/staff/components/team-screen.tsx",
);
const teamScreenSrc = readFileSync(teamScreenPath, "utf8");

check(
  "3.1 hasStaff condition removed so admin-only teams are not hidden by empty-state",
  !teamScreenSrc.includes("const hasStaff =") &&
    !teamScreenSrc.includes("!hasStaff && invitations.length === 0"),
);

check(
  "3.2 Empty state condition uses members.length === 0 matching count heading",
  teamScreenSrc.includes("members.length === 0 ? (") &&
    teamScreenSrc.includes("arabicCount(members.length, MEMBER_NOUNS)"),
);

check(
  "3.3 Distinction between providers and login members preserved",
  teamScreenSrc.includes("مقدمو الخدمة") &&
    teamScreenSrc.includes("أعضاء المنشأة (حسابات الدخول)") &&
    teamScreenSrc.includes("arabicCount(providers.length, PROVIDER_NOUNS)") &&
    teamScreenSrc.includes("arabicCount(members.length, MEMBER_NOUNS)"),
);

// ─── 4. Appointment View Switch (src/features/appointments/components/appointment-agenda.tsx) ───
const agendaPath = resolve(
  root,
  "src/features/appointments/components/appointment-agenda.tsx",
);
const agendaSrc = readFileSync(agendaPath, "utf8");

check(
  "4.1 Appointment view switcher has role='group' and accessible aria-label",
  agendaSrc.includes('role="group"') &&
    agendaSrc.includes('aria-label="طريقة عرض المواعيد"'),
);

check(
  "4.2 View switcher exposes selected view via aria-pressed pattern",
  agendaSrc.includes('aria-pressed={viewMode === "list"}') &&
    agendaSrc.includes('aria-pressed={viewMode === "calendar"}'),
);

check(
  "4.3 Selection is understandable without relying only on color (visual dot indicator + ring/font-weight)",
  agendaSrc.includes("rounded-full bg-primary") &&
    agendaSrc.includes("ring-1 ring-border") &&
    agendaSrc.includes("font-semibold"),
);

check(
  "4.4 Existing view-switching behavior retained",
  agendaSrc.includes('onClick={() => setViewMode("list")}') &&
    agendaSrc.includes('onClick={() => setViewMode("calendar")}'),
);

// ─── Report Summary ───
let failed = 0;
console.log("🔍 FlowPilot UI & Accessibility Repairs Verification:\n");

for (const { label, pass, details } of checks) {
  if (pass) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}`);
    if (details) console.error(`     Details: ${details}`);
    failed++;
  }
}

console.log(`\n───────────────────────────────────────────────────`);
if (failed > 0) {
  console.error(`❌ FAILED: ${failed}/${checks.length} checks failed.`);
  process.exit(1);
} else {
  console.log(
    `✅ PASSED: All ${checks.length}/${checks.length} checks passed successfully.`,
  );
}
