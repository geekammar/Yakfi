/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — Persistent Conversation Context on Mobile (CONV-UI-01 / U01–U10).
 *
 * Deterministic offline verification of conversation detail screen invariants:
 *   U01: Persistent Header below AppShell bar (sticky top-0 z-20 inside section, no scroll away)
 *   U02: Real customer identity with truncation & dir="ltr" phone (no overflow)
 *   U03: Accessible status badge & attention reason chip (never color-only)
 *   U04: Actual assignee / responder context visible in header (AI Assistant / "أنت" / staff / unassigned)
 *   U05: Mobile viewport protection (actions unpinned on mobile, compact header)
 *   U06: Independently scrollable message history (role="log", overflow-y-auto, focusable)
 *   U07: Composer usable above bottom navigation (form sibling, pb-24 clearance, live status)
 *   U08: Zero overlapping floating controls and zero duplicate scroll traps
 *   U09: Multi-viewport & RTL logical properties only (no physical left/right)
 *   U10: 44px touch targets on mobile & documented browser emulation limitations
 *
 * Run: pnpm check:conv-ui-01
 */
export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

async function main(): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const read = (rel: string) =>
    fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  const detail = read(
    "src/features/conversations/components/conversation-detail.tsx",
  );
  const actions = read(
    "src/features/conversations/components/conversation-actions.tsx",
  );
  const appShell = read("src/components/shared/layout/app-shell.tsx");
  const bottomNav = read("src/components/shared/layout/bottom-nav.tsx");
  const sharedStatusBadge = read("src/components/shared/status-badge.tsx");

  // ── U01: Persistent Header below AppShell bar ─────────────────────────────
  check(
    "U01a. ترويسة المحادثة تحمل data-testid ولها sticky top-0 z-20 (ثابتة لا تختفي)",
    detail.includes('data-testid="conversation-persistent-header"') &&
      detail.includes("sticky top-0 z-20"),
  );
  check(
    "U01b. لوحة المحادثة بارتفاع محدود + overflow-hidden (لا فيضان على النافذة)",
    /className="flex h-\[calc\(100dvh-11rem\)\] min-h-\[28rem\] flex-1 flex-col overflow-hidden/.test(
      detail,
    ),
  );
  check(
    "U01c. الشريط الجانبي مخفي على الجوال في وضع الرسائل (hidden lg:block) لمنع التمرير المزدوج",
    detail.includes('className="hidden lg:block space-y-4"'),
  );

  // ── U02: Real customer identity with truncation ───────────────────────────
  check(
    "U02a. اسم العميل داخل <h1> مع truncate font-semibold داخل min-w-0 flex-1",
    /<h1[^>]*class(?:Name)?="[^"]*font-semibold[^"]*"/.test(detail) &&
      detail.includes("truncate") &&
      detail.includes("min-w-0 flex-1"),
  );
  check(
    "U02b. هاتف العميل مع dir=ltr و truncate لمنع كسر الاتجاه والفيضان الأفقي",
    /<p className="truncate text-xs text-muted-foreground" dir="ltr">/.test(
      detail,
    ),
  );

  // ── U03: Accessible status & attention reason ─────────────────────────────
  check(
    "U03a. شارة الحالة معروضة في الترويسة الدائمة",
    detail.includes("<ConversationStatusBadge status={data.status}"),
  );
  check(
    "U03b. شارة سبب الانتباه معروضة عند وجود سبب (أيقونة + نص عربي + اسم متاح)",
    detail.includes("AttentionReasonChip") &&
      detail.includes("AlertCircleIcon") &&
      detail.includes("ATTENTION_REASON_LABELS") &&
      /aria-label=\{`سبب انتباه المشغل:/.test(detail),
  );
  check(
    "U03c. StatusBadge يمرر الخصائص بما فيها aria-label إلى DOM (ليست لوناً فقط)",
    sharedStatusBadge.includes("{...props}"),
  );

  // ── U04: Actual assignee / responder context ──────────────────────────────
  check(
    "U04a. الترويسة الدائمة تعرض المسؤول الحالي (المساعد الذكي / أنت / اسم العضو / غير معينة)",
    detail.includes("<AssigneeResponderBadge") &&
      detail.includes("المساعد الذكي") &&
      detail.includes("غير معينة") &&
      detail.includes('"أنت"'),
  );
  check(
    "U04b. شارة المسؤول تحمل أسماء وصفية متاحة (aria-label) وأيقونات دلالية",
    detail.includes('aria-label="المسؤول الحالي: المساعد الذكي"') &&
      detail.includes('aria-label="المسؤول الحالي: غير معينة"') &&
      detail.includes("BotIcon") &&
      detail.includes("UserRoundIcon"),
  );

  // ── U05: Mobile viewport protection (non-bloated actions) ───────────────────
  check(
    "U05a. الإجراء المشترك متاح على الجوال والمكتب في الترويسة عبر ConversationActions",
    detail.includes("<ConversationActions") &&
      actions.includes("export function ConversationActions"),
  );
  check(
    "U05b. الإجراءات الأربعة الصريحة موجودة وتعمل مع الصلاحيات (تولّي/إعادة/محجوز/تحويل)",
    (detail + actions).includes('"TAKE_OVER"') &&
      (detail + actions).includes('"RETURN_TO_AI"') &&
      (detail + actions).includes('"MARK_BOOKED"') &&
      (detail + actions).includes('"HANDOFF"'),
  );

  // ── U06: Independently scrollable message history ─────────────────────────
  check(
    "U06a. سجل الرسائل هو الحاوية الوحيدة للتمرير (overflow-y-auto + role=log)",
    /role="log"[\s\S]*?overflow-y-auto/.test(detail),
  );
  check(
    "U06b. السجل قابل للتركيز عبر لوحة المفاتيح (tabIndex=0) وله عنوان وصفي",
    detail.includes('role="log"') &&
      detail.includes("tabIndex={0}") &&
      detail.includes('aria-label="رسائل المحادثة"'),
  );

  // ── U07: Composer usable above bottom navigation ──────────────────────────
  check(
    "U07a. صندوق الرد شقيق للسجل في الأسفل وليس داخله",
    /role="log"[\s\S]*?<form onSubmit=\{handleReply\}/.test(detail) &&
      !/<form onSubmit=\{handleReply\}[\s\S]*?role="log"/.test(detail),
  );
  check(
    "U07b. زر الإرسال وصندوق الرد يحملان تسميات إمكانية وصول ومؤشر الإرسال live region",
    detail.includes('aria-label="رد على العميل"') &&
      detail.includes('aria-label="إرسال الرد"') &&
      detail.includes('<span role="status" aria-label="جارٍ الإرسال">'),
  );

  // ── U08: Zero overlapping floating controls & no scroll traps ─────────────
  check(
    "U08a. تدرج z-index محكم (BottomNav: 40, Header: 30, PersistentHeader: 20)",
    appShell.includes("z-[var(--z-header)]") &&
      bottomNav.includes("z-[var(--z-bottom-nav)]") &&
      detail.includes("z-20"),
  );
  check(
    "U08b. خلو الغلاف من عناصر عائمة تتقاطع مع صندوق الرد أو شريط التنقل السفلي",
    appShell.includes("pb-24") &&
      bottomNav.includes("env(safe-area-inset-bottom)"),
  );

  // ── U09: Multi-viewport & RTL logical properties ──────────────────────────
  {
    const physical = [
      /\bleft-\d/,
      /\bright-\d/,
      /\bml-\d/,
      /\bmr-\d/,
      /\bpl-\d/,
      /\bpr-\d/,
      /text-left/,
      /text-right/,
      /float-left/,
      /float-right/,
    ];
    const isRtlClean = (source: string) =>
      !physical.some((pattern) => pattern.test(source));
    check(
      "U09. مكونات المحادثة والغلاف تستخدم خصائص منطقية فقط (RTL سليم)",
      isRtlClean(detail) &&
        isRtlClean(actions) &&
        isRtlClean(appShell) &&
        isRtlClean(bottomNav),
    );
  }

  // ── U10: 44px touch targets on mobile & accessibility ─────────────────────
  {
    const touchTargets = [
      "min-h-11 min-w-11 md:min-h-8 md:min-w-8", // back
      "min-h-11 md:min-h-8", // booking + transition actions
      "min-h-11 min-w-11 md:min-h-10 md:min-w-10", // send
    ];
    const combined = detail + actions;
    const allPresent = touchTargets.every((cls) => combined.includes(cls));
    const count = (combined.match(/min-h-11/g) ?? []).length;
    check(
      "U10. الإجراءات التفاعلية تحقق 44px على الجوال (min-h-11) مع الحفاظ على المقاس المكتبي",
      allPresent && count >= 7 && detail.includes('role="alert"'),
    );
  }

  // ── report ────────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => !item.pass);
  console.log(
    `\n── CONVERSATION PERSISTENT HEADER UX (CONV-UI-01) — ${checks.length} checks ──`,
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
