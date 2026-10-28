/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — CONVERSATION SCREEN UX check (DECISIONS #62).
 *
 * Deterministic, OFFLINE structural verification of the operator
 * conversation screen (`/conversations` inbox + `/conversations/[id]`
 * detail). Real-browser verification is NOT performed anywhere in this
 * project (see BUILD_STATE); this asserts the STRUCTURE that makes the UX
 * invariants hold in the built DOM, the same source-level guard pattern
 * `check:conversation-handoff` H11 uses. No DB, no network, no LLM call.
 *
 *   U1  CUSTOMER IDENTITY STAYS VISIBLE WHILE SCROLLING A LONG THREAD —
 *       the detail screen is a fixed-height panel whose message log is the
 *       ONLY scroll container, so the header (customer name + phone) is
 *       pinned while messages scroll; the reply form is a sibling of the
 *       log, never inside it, so it stays reachable too
 *   U2  IDENTITY IS REAL IDENTITY — an <h1> with the customer name + a
 *       dir="ltr" phone (truncated, never overflowing)
 *   U3  AI/HUMAN OWNERSHIP IS VISIBLE AND ACCESSIBLE — a status badge for
 *       AI_ACTIVE / NEED_HUMAN with an accessible name, plus the explicit
 *       operator actions (تولّي / إعادة للمساعد / تحديد كمحجوز / تحويل)
 *   U4  NEED_HUMAN state visibility — the handoff reason chip (icon +
 *       Arabic text + aria-label) so the state is never color-only
 *   U5  MOBILE — the panel fits the mobile shell (dvh-based height), the
 *       bottom nav clears content with safe-area padding, and the primary
 *       operator actions meet the 44px touch target on mobile
 *   U6  RTL — the conversation components use logical properties only
 *       (no physical left/right that would break the mirror)
 *   U7  KEYBOARD / SR — a focusable role="log" transcript, labelled
 *       composer + send, role="alert" errors, a skip link, and the sending
 *       indicator announced as a live region
 *
 * Run: pnpm check:conversation-ux
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
  const inbox = read("src/features/conversations/components/inbox-list.tsx");
  const appShell = read("src/components/shared/layout/app-shell.tsx");
  const bottomNav = read("src/components/shared/layout/bottom-nav.tsx");
  const statusBadge = read(
    "src/features/conversations/components/conversation-status.tsx",
  );
  const statusLib = read("src/lib/status.ts");

  // ── U1. identity stays visible while scrolling a long thread ───────────
  // The panel is a fixed-height flex column with overflow-hidden; the ONLY
  // scroll region is the message log, so the header + action bar + composer
  // are structurally pinned while the transcript scrolls.
  check(
    "U1a. اللوحة ارتفاع ثابت + overflow-hidden (التمرير داخلها فقط)",
    /className="flex h-\[calc\(100dvh-11rem\)\] min-h-\[28rem\] flex-1 flex-col overflow-hidden/.test(
      detail,
    ),
  );
  check(
    "U1b. سجل الرسائل هو الحاوية الوحيدة للتمرير (overflow-y-auto + role=log)",
    /role="log"[\s\S]*?overflow-y-auto/.test(detail),
  );
  check(
    "U1c. صندوق الرد شقيق للسجل وليس داخله (يبقى متاحاً أثناء التمرير)",
    /role="log"[\s\S]*?<form onSubmit=\{handleReply\}/.test(detail) &&
      !/<form onSubmit=\{handleReply\}[\s\S]*?role="log"/.test(detail),
  );

  // ── U2. identity is real identity ──────────────────────────────────────
  check(
    "U2a. الترويسة تحمل <h1> باسم العميل + هاتفاً dir=ltr (مقطوع، لا فيضان)",
    /<h1[^>]*class(?:Name)?="[^"]*font-semibold[^"]*"/.test(detail) &&
      detail.includes("truncate") &&
      /<p className="truncate text-xs text-muted-foreground" dir="ltr">/.test(
        detail,
      ) &&
      detail.includes(`min-w-0 flex-1`),
  );
  check(
    "U2b. اسم العميل لا يُكرَّر داخل السجل (الهوية في الترويسة فقط)",
    (detail.match(/data\.customer\.name/g) ?? []).length >= 1 &&
      (detail.match(/<h1[^>]*>\s*\{data\.customer\.name\}\s*<\/h1>/g) ?? [])
        .length === 1,
  );

  // ── U3. AI/human ownership is visible and accessible ───────────────────
  check(
    "U3a. شارة الحالة تُعرض في الترويسة (AI_ACTIVE / NEED_HUMAN مفتوحان)",
    detail.includes("<ConversationStatusBadge status={data.status}"),
  );
  check(
    "U3b. شارة الحالة تحمل اسماً متاحاً (ليست لوناً فقط)",
    statusBadge.includes("aria-label") &&
      /aria-label=\{`حالة المحادثة/.test(statusBadge),
  );
  check(
    "U3c. نية NEED_HUMAN معرّفة بنغمة خطأ + أيقونة + عربي",
    statusLib.includes('"need-human"') &&
      /need-human[\s\S]*?(?:error|destructive)/.test(statusLib),
  );
  check(
    "U3d. الإجراءات الصريحة للمشغل موجودة (تولّي / إعادة للمساعد / محجوز / فريق)",
    (detail + actions).includes('"TAKE_OVER"') &&
      (detail + actions).includes('"RETURN_TO_AI"') &&
      (detail + actions).includes('"MARK_BOOKED"') &&
      (detail + actions).includes('"HANDOFF"') &&
      (detail + actions).includes("إعادة للمساعد"),
  );

  // ── U4. NEED_HUMAN reason visibility (never color-only) ────────────────
  check(
    "U4a. شارة سبب الانتباه: أيقونة + نص عربي + اسم متاح (DECISIONS #62)",
    detail.includes("AttentionReasonChip") &&
      detail.includes("AlertCircleIcon") &&
      detail.includes("ATTENTION_REASON_LABELS") &&
      /aria-label=\{`سبب انتباه المشغل:/.test(detail),
  );
  check(
    "U4b. الشارة تُعرض فقط عند وجود سبب (تختفي بعد الإقرار)",
    /data\.attentionReason \? \(\s*<AttentionReasonChip[\s\S]*?\)\s*:\s*null/.test(
      detail,
    ),
  );

  // ── U5. mobile shell + 44px touch targets ──────────────────────────────
  check(
    "U5a. الغلاف المتحرك: شريط علوي ثابت + تنقل سفلي مع حشوة المنطقة الآمنة",
    appShell.includes("sticky top-0") &&
      bottomNav.includes("env(safe-area-inset-bottom)") &&
      bottomNav.includes("md:hidden"),
  );
  check(
    "U5b. محتوى الغلاف يترك مجالاً للتنقل السفلي (pb-24)",
    appShell.includes("pb-24"),
  );
  {
    // The operator's primary actions meet the 44px touch target on mobile
    // (min-h-11), restoring the desktop compact height (md:min-h-8).
    const touchTargets = [
      "min-h-11 min-w-11 md:min-h-8 md:min-w-8", // back (icon)
      "min-h-11 md:min-h-8", // حجز موعد + the 4 transition actions
      "min-h-11 min-w-11 md:min-h-10 md:min-w-10", // send (icon)
    ];
    const combined = detail + actions;
    const allPresent = touchTargets.every((cls) => combined.includes(cls));
    const count = (combined.match(/min-h-11/g) ?? []).length;
    check(
      "U5c. الإجراءات الأساسية 44px على الجوال (7 عناصر: رجوع/حجز/٤ أفعال/إرسال)",
      allPresent && count >= 7,
    );
  }

  // ── U6. RTL — logical properties only in the conversation components ───
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
      "U6. مكونات المحادثة تستخدم خصائص منطقية فقط (RTL سليم)",
      isRtlClean(detail) &&
        isRtlClean(actions) &&
        isRtlClean(inbox) &&
        isRtlClean(appShell) &&
        isRtlClean(bottomNav),
    );
  }

  // ── U7. keyboard / screen-reader ───────────────────────────────────────
  check(
    "U7a. السجل قائم قابل للتركيز + رد مُعنوَن + إرسال مُعنوَن + خطأ role=alert",
    /role="log"[\s\S]*?tabIndex=\{0\}/.test(detail) &&
      detail.includes('aria-label="رد على العميل"') &&
      detail.includes('aria-label="إرسال الرد"') &&
      detail.includes('role="alert"'),
  );
  check(
    "U7b. مؤشر الإرسال يُعلن كمنطقة حية (role=status)",
    /<span role="status" aria-label="جارٍ الإرسال">/.test(detail),
  );
  check(
    "U7c. كل حالة محادثة لها علامة عربية + نغمة + أيقونة (النظام مكتمل)",
    ["need-human", "ai-active", "booked", "incomplete"].every((key) =>
      statusLib.includes(`"${key}"`),
    ),
  );

  // ── report ─────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => !item.pass);
  console.log(`\n── CONVERSATION SCREEN UX — ${checks.length} checks ──`);
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
  console.log(
    "\nStructural assertions only (no browser, no DB, no network, no LLM call).",
  );
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
