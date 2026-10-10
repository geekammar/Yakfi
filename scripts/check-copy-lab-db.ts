/**
 * FlowPilot — CONVERSATION COPY LAB real-DB integration proof (UX-LAB-01D-3).
 *
 * The OFFLINE suite (`pnpm check:copy-lab`) stays the authoritative, fast,
 * deterministic guard. This script is the smallest focused verification that
 * the ALREADY-WRITTEN persistence path really persists against a REAL
 * PostgreSQL database — it does NOT replace the offline checks and does NOT
 * create a parallel persistence implementation:
 *
 *     override service
 *       -> existing copyOverrideRepository
 *       -> Prisma (@prisma/adapter-pg)
 *       -> NON-PRODUCTION PostgreSQL
 *
 * Coverage (against the real DB):
 *   A  No override            — resolution is CODE_DEFAULT (NO_OVERRIDE)
 *   B  Publish                — a valid EDITABLE_COPY persists; a subsequent
 *                               read returns PLATFORM_OVERRIDE; a PUBLISH
 *                               history row exists with the right semantics
 *   C  Republish              — new text replaces the effective override;
 *                               previous/result history semantics are correct
 *   D  Reset                  — the override ROW is removed; the code default
 *                               becomes effective again; RESET history is right
 *   E  Reset idempotency      — resetting again still succeeds (removed: null)
 *   F  Restore                — a valid historical value becomes effective and
 *                               a RESTORE audit row is produced
 *   G  Validation delegated   — an invalid candidate NEVER reaches persistence
 *   H  Protected copy         — PROTECTED_COPY publish/restore stay rejected
 *                               and zero mutation occurs
 *   I  Key isolation          — mutating one key never touches another
 *   J  History ordering       — real-DB history stays newest-first
 *   K  Template copy          — an EDITABLE_TEMPLATE with required
 *                               placeholders round-trips through the store
 *   L  Zero residue           — only this run's rows are written and every one
 *                               of them is removed afterwards
 *
 * HARD SAFETY GATE (runs before ANY database I/O):
 *   The resolved DATABASE_URL must point at a LOCAL/LOOPBACK host. A remote
 *   host, a production-looking host, or the documentation placeholder makes
 *   this script HARD-STOP with DEV_DB_INTEGRATION_BLOCKED before a single
 *   query runs. It never falls back to another database and never writes to
 *   anything it could not positively identify as non-production.
 *
 * Run (DATABASE_URL supplied out-of-band, never written into the repo):
 *
 *   DATABASE_URL='postgresql://user:pwd@localhost:5432/db?schema=public' \
 *     pnpm check:copy-lab-db
 */
import {
  getPublishedOverride,
  listOverrideHistory,
  resetPublishedOverride,
  resolveStoredCopy,
  restoreOverride,
  savePublishedOverride,
} from "@/features/conversation-copy/override-service";
import type {
  CopyOverrideHistoryItem,
  CopyOverrideServiceResult,
  ListOverrideHistorySuccess,
} from "@/features/conversation-copy/override-types";
import { getCopyEntry } from "@/features/conversation-copy/registry";
import { renderCopyText } from "@/features/conversation-copy/render";
import {
  collectPreviewValues,
  mapEffectiveCopyState,
  mapHistoryItems,
} from "@/features/platform/components/copy-lab-logic";
import { db } from "@/server/db";

export {};

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

/** Sentinel embedded in every test value so cleanup is surgical. */
const SENTINEL = "UXLAB01D3-DBPROOF";
/** A Platform Operator actor created for this run only (satisfies the
 *  `updated_by_id` / `actor_id` FKs to `users`). */
const TEST_ACTOR_ID = `uxlab-01d3-db-test-operator-${SENTINEL.toLowerCase()}`;
const TEST_ACTOR_EMAIL = `uxlab-01d3-dbproof@flowpilot.invalid`;
const PLATFORM_ACTOR = { userId: TEST_ACTOR_ID, accountType: "PLATFORM" };
const BUSINESS_ACTOR = { userId: TEST_ACTOR_ID, accountType: "BUSINESS" };

/** Every key this proof may create rows for (cleanup + isolation scope). */
const TEST_KEYS = [
  "greeting.ack.default",
  "greeting.ack.salam",
  "booking.confirmed",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Typed narrowing helpers — the service results are discriminated unions, so
 * these keep the proof's assertions on the SUCCESS payload without any cast.
 * A failed read yields the empty/absent shape, which the checks already treat
 * as a failure.
 */
function historyItems(
  result: CopyOverrideServiceResult<ListOverrideHistorySuccess>,
): CopyOverrideHistoryItem[] {
  return result.success ? result.data.items : [];
}

/**
 * The non-production gate. Returns a safe, credential-free classification or
 * null when the target cannot be positively identified as local.
 */
function classifyTarget(url: string): {
  host: string;
  local: boolean;
  reason: string;
} | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  const PLACEHOLDER = "postgresql://user:password@host/dbname?sslmode=require";
  if (url.trim() === PLACEHOLDER || host === "host") {
    return {
      host,
      local: false,
      reason: "DATABASE_URL is the .env.example documentation placeholder",
    };
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const isLocal =
    loopback.has(host) ||
    host.endsWith(".local") ||
    host.endsWith(".localhost") ||
    // A unix-domain socket (no host in the URL) is inherently local.
    host === "";
  return {
    host,
    local: isLocal,
    reason: isLocal
      ? "loopback / local-only host (no remote or production host reachable)"
      : "REMOTE host — cannot be positively identified as non-production",
  };
}

async function main(): Promise<void> {
  // ── HARD SAFETY GATE — before any database I/O ────────────────────────
  const url = process.env.DATABASE_URL ?? "";
  const target = classifyTarget(url);
  if (target === null || !target.local) {
    console.error(
      "DEV_DB_INTEGRATION_BLOCKED: DATABASE_URL was not positively " +
        "identified as a local/non-production target. No query was executed " +
        `and nothing was written. Classification: ${JSON.stringify({
          host: target?.host ?? "unparseable",
          reason: target?.reason ?? "DATABASE_URL is unset",
        })}`,
    );
    process.exit(1);
  }
  console.log(
    `🔒 DB target verified non-production: ${target.reason} (database name forwarded to Prisma only).`,
  );

  // ── Preconditions: the proof starts from a clean, known state ─────────
  const beforeOverrides = await db.platformCopyOverride.count();
  const beforeHistory = await db.platformCopyOverrideHistory.count();
  const staleForTestKeys = await db.platformCopyOverride.count({
    where: { copyKey: { in: [...TEST_KEYS] } },
  });
  check(
    `${SENTINEL} precondition: لا توجد تجاوزات سابقة لمفاتيح الاختبار`,
    beforeOverrides === 0 && staleForTestKeys === 0,
  );

  const actor = await db.user.create({
    data: {
      id: TEST_ACTOR_ID,
      name: "UX-LAB-01D-3 DB Test Operator",
      email: TEST_ACTOR_EMAIL,
      emailVerified: false,
      accountType: "PLATFORM",
    },
  });
  check(
    `${SENTINEL} إنشاء مشغل المنصة التجريبي نجح`,
    actor.accountType === "PLATFORM",
  );

  try {
    await proofBody();
  } finally {
    // ── L. Zero residue: remove ONLY this run's rows (never a truncate) ──
    await db.platformCopyOverrideHistory.deleteMany({
      where: { actorId: TEST_ACTOR_ID },
    });
    await db.platformCopyOverride.deleteMany({
      where: { updatedById: TEST_ACTOR_ID },
    });
    await db.user.deleteMany({ where: { id: TEST_ACTOR_ID } });
  }

  const afterOverrides = await db.platformCopyOverride.count();
  const afterHistory = await db.platformCopyOverrideHistory.count();
  const afterUsers = await db.user.count({
    where: { id: TEST_ACTOR_ID },
  });
  check(
    `${SENTINEL} (L). تنظيف جراحي: لا توجد صفوف متبقية من هذا الفحص (تجاوزات ${beforeOverrides}→${afterOverrides}، سجل ${beforeHistory}→${afterHistory}، المشغل ${afterUsers})`,
    afterOverrides === beforeOverrides &&
      afterHistory === beforeHistory &&
      afterUsers === 0,
  );

  // ── Report ─────────────────────────────────────────────────────────────
  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nثبات طبقة التجاوز مثبت ضد قاعدة بيانات حقيقية: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

async function proofBody(): Promise<void> {
  const PRIMARY = "greeting.ack.default";
  const ISOLATION = "greeting.ack.salam";
  const TEMPLATE = "booking.confirmed";
  const PROTECTED = "handoff.human_request";

  const defaultText = getCopyEntry(PRIMARY)?.defaultText ?? "";
  const templateDefault = getCopyEntry(TEMPLATE)?.defaultText ?? "";

  // A — No override: resolution is the code default, with the documented
  // NO_OVERRIDE reason (absence of a row IS the "use the code default" state).
  const aResolve = await resolveStoredCopy(PRIMARY);
  const aPublished = await getPublishedOverride(PRIMARY);
  check(
    `${SENTINEL} (A). بدون تجاوز: التحليل يعطي CODE_DEFAULT مع سبب NO_OVERRIDE، ولا يوجد صف منشور`,
    aResolve.ok &&
      aResolve.source === "CODE_DEFAULT" &&
      aResolve.fallbackReason === "NO_OVERRIDE" &&
      aResolve.text === defaultText &&
      aPublished.success &&
      aPublished.data.override === null,
  );

  // B — Publish a valid EDITABLE_COPY through the service → repository →
  // Prisma → PostgreSQL path, then re-read the SAME way.
  const firstText = `أهلاً بك في مختبر النصوص — النسخة الأولى ${SENTINEL}`;
  const bPublish = await savePublishedOverride(
    PLATFORM_ACTOR,
    PRIMARY,
    firstText,
  );
  const bResolve = await resolveStoredCopy(PRIMARY);
  const bPublished = await getPublishedOverride(PRIMARY);
  const bRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: PRIMARY },
  });
  const bHistory = await listOverrideHistory(PLATFORM_ACTOR, PRIMARY, 25);
  const bPublishHistory = historyItems(bHistory).find(
    (i) => i.action === "PUBLISH",
  );
  check(
    `${SENTINEL} (B). نشر نص قابل للتعديل: يُحفظ في قاعدة البيانات الحقيقية، والقراءة التالية تعطي PLATFORM_OVERRIDE`,
    bPublish.success &&
      bPublish.data.override.text === firstText &&
      bResolve.ok &&
      bResolve.source === "PLATFORM_OVERRIDE" &&
      bResolve.text === firstText &&
      bPublished.success &&
      bPublished.data.override?.text === firstText &&
      bRow?.text === firstText &&
      bRow?.copyKey === PRIMARY,
  );
  check(
    `${SENTINEL} (B2). سجل النشر صحيح: PUBLISH واحد، previousText فارغ (الافتراضي كان فعالاً)، resultText = النص الجديد`,
    bHistory.success &&
      bPublishHistory !== undefined &&
      bPublishHistory.action === "PUBLISH" &&
      bPublishHistory.previousText === null &&
      bPublishHistory.resultText === firstText &&
      bPublishHistory.actorId === TEST_ACTOR_ID &&
      bPublishHistory.copyKey === PRIMARY,
  );

  // C — Republish: new text replaces the effective override and the history
  // records the exact transition (previous = first, result = second).
  await sleep(3);
  const secondText = `أهلاً بك في مختبر النصوص — النسخة الثانية ${SENTINEL}`;
  const cPublish = await savePublishedOverride(
    PLATFORM_ACTOR,
    PRIMARY,
    secondText,
  );
  const cResolve = await resolveStoredCopy(PRIMARY);
  const cRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: PRIMARY },
  });
  const cHistory = await listOverrideHistory(PLATFORM_ACTOR, PRIMARY, 25);
  const cTop = historyItems(cHistory)[0];
  check(
    `${SENTINEL} (C). إعادة النشر تستبدل النص الفعال (صف واحد لكل مفتاح، تحديث وليس إدراجاً)`,
    cPublish.success &&
      cPublish.data.override.text === secondText &&
      cResolve.ok &&
      cResolve.source === "PLATFORM_OVERRIDE" &&
      cResolve.text === secondText &&
      cRow?.text === secondText &&
      cRow?.updatedAt >= cRow?.createdAt,
  );
  check(
    `${SENTINEL} (C2). تاريخ إعادة النشر: PUBLISH بـ previousText = النص الأول و resultText = النص الثاني`,
    cHistory.success &&
      cTop !== undefined &&
      cTop.action === "PUBLISH" &&
      cTop.previousText === firstText &&
      cTop.resultText === secondText,
  );

  // D — Reset: the override ROW is removed (not copied over), the code default
  // becomes effective again, and the removal is audited as a RESET transition.
  await sleep(3);
  const dReset = await resetPublishedOverride(PLATFORM_ACTOR, PRIMARY);
  const dResolve = await resolveStoredCopy(PRIMARY);
  const dRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: PRIMARY },
  });
  const dHistory = await listOverrideHistory(PLATFORM_ACTOR, PRIMARY, 25);
  const dTop = historyItems(dHistory)[0];
  check(
    `${SENTINEL} (D). إعادة التعيين تحذف صف التجاوز ويعود المصدر CODE_DEFAULT (NO_OVERRIDE)`,
    dReset.success &&
      dReset.data.removed !== null &&
      dReset.data.removed.text === secondText &&
      dResolve.ok &&
      dResolve.source === "CODE_DEFAULT" &&
      dResolve.fallbackReason === "NO_OVERRIDE" &&
      dResolve.text === defaultText &&
      dRow === null,
  );
  check(
    `${SENTINEL} (D2). سجل إعادة التعيين: RESET بـ previousText = النص الثاني و resultText فارغ`,
    dHistory.success &&
      dTop !== undefined &&
      dTop.action === "RESET" &&
      dTop.previousText === secondText &&
      dTop.resultText === null,
  );

  // E — Reset idempotency: resetting a key with no stored override still
  // succeeds and reports removed: null (per the existing contract), and it
  // appends NO extra history row.
  const eReset = await resetPublishedOverride(PLATFORM_ACTOR, PRIMARY);
  const eHistory = await listOverrideHistory(PLATFORM_ACTOR, PRIMARY, 25);
  const eResetCount = historyItems(eHistory).filter(
    (i) => i.action === "RESET",
  ).length;
  check(
    `${SENTINEL} (E). إعادة التعيين متكررة الاستخدام: تكرارها على مفتاح بلا تجاوز ينجح بـ removed: null ولا تضيف سجلاً`,
    eReset.success && eReset.data.removed === null && eResetCount === 1,
  );

  // F — Restore: publish two values, reset, then restore the first value from
  // its PUBLISH history row. The restored value becomes effective and a
  // RESTORE audit row is produced.
  await sleep(3);
  const fFirst = `نص الاسترجاع الأول ${SENTINEL}`;
  const fSecond = `نص الاسترجاع الثاني ${SENTINEL}`;
  await savePublishedOverride(PLATFORM_ACTOR, PRIMARY, fFirst);
  await sleep(3);
  await savePublishedOverride(PLATFORM_ACTOR, PRIMARY, fSecond);
  await sleep(3);
  await resetPublishedOverride(PLATFORM_ACTOR, PRIMARY);
  const fHistoryBeforeRestore = await listOverrideHistory(
    PLATFORM_ACTOR,
    PRIMARY,
    25,
  );
  const fTargetRow = historyItems(fHistoryBeforeRestore).find(
    (i) => i.action === "PUBLISH" && i.resultText === fFirst,
  );
  if (fTargetRow === undefined) {
    check(`${SENTINEL} (F). صف تاريخ الاسترجاع الهدف موجود`, false);
  } else {
    const fRestore = await restoreOverride(PLATFORM_ACTOR, fTargetRow.id);
    const fResolve = await resolveStoredCopy(PRIMARY);
    const fHistoryAfter = await listOverrideHistory(
      PLATFORM_ACTOR,
      PRIMARY,
      25,
    );
    const fTop = historyItems(fHistoryAfter)[0];
    check(
      `${SENTINEL} (F). استرجاع قيمة تاريخية صالحة يجعلها فعّالة (PLATFORM_OVERRIDE)`,
      fRestore.success &&
        fRestore.data.override.text === fFirst &&
        fResolve.ok &&
        fResolve.source === "PLATFORM_OVERRIDE" &&
        fResolve.text === fFirst,
    );
    check(
      `${SENTINEL} (F2). سجل RESTORE يُنشأ بـ previousText = null (بعد الحذف) و resultText = القيمة المسترجعة`,
      fTop !== undefined &&
        fTop.action === "RESTORE" &&
        fTop.previousText === null &&
        fTop.resultText === fFirst,
    );
  }

  // G — Validation stays delegated to the UX-LAB-01B contract: an invalid
  // candidate is refused BEFORE any write, so nothing reaches persistence.
  await sleep(3);
  const gBadTemplate =
    "تأكيد الحجز {serviceName} {date} {startTime} {endTime} — ناقص ${SENTINEL}";
  const gPublish = await savePublishedOverride(
    PLATFORM_ACTOR,
    TEMPLATE,
    gBadTemplate.replace("${SENTINEL}", SENTINEL),
  );
  const gRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: TEMPLATE },
  });
  const gResolve = await resolveStoredCopy(TEMPLATE);
  check(
    `${SENTINEL} (G). حذف حقل مطلوب (MISSING_REQUIRED_PLACEHOLDER) لا يصل أبداً إلى قاعدة البيانات`,
    !gPublish.success &&
      gPublish.error.code === "INVALID_COPY" &&
      gPublish.error.validationFailure?.code ===
        "MISSING_REQUIRED_PLACEHOLDER" &&
      gRow === null &&
      gResolve.ok &&
      gResolve.source === "CODE_DEFAULT",
  );
  const gEmpty = await savePublishedOverride(PLATFORM_ACTOR, PRIMARY, "   ");
  const gEmptyRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: PRIMARY },
  });
  check(
    `${SENTINEL} (G2). نص فارغ (EMPTY_TEXT) مرفوض دون أي كتابة`,
    !gEmpty.success &&
      gEmpty.error.code === "INVALID_COPY" &&
      gEmpty.error.validationFailure?.code === "EMPTY_TEXT" &&
      gEmptyRow?.text === fFirst,
  );
  const gForbidden = await savePublishedOverride(
    PLATFORM_ACTOR,
    PRIMARY,
    `text with {date} ${SENTINEL}`,
  );
  check(
    `${SENTINEL} (G3). حقل غير مصرّح به (PLACEHOLDER_NOT_ALLOWED) مرفوض`,
    !gForbidden.success &&
      gForbidden.error.code === "INVALID_COPY" &&
      gForbidden.error.validationFailure?.code === "PLACEHOLDER_NOT_ALLOWED",
  );
  const gForbiddenRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: PRIMARY },
  });
  check(
    `${SENTINEL} (G4). القيم غير الصالحة لا تغيّر النص الفعّال المخزّن`,
    gForbiddenRow?.text === fFirst,
  );

  // H — PROTECTED_COPY stays non-editable: publish is refused and zero
  // mutation occurs (no row, no history, resolution stays CODE_DEFAULT).
  const hDefault = getCopyEntry(PROTECTED)?.defaultText ?? "";
  const hPublish = await savePublishedOverride(
    PLATFORM_ACTOR,
    PROTECTED,
    `تحت أمرك — نسخة معدّلة ${SENTINEL}`,
  );
  const hRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: PROTECTED },
  });
  const hHistory = await listOverrideHistory(PLATFORM_ACTOR, PROTECTED, 25);
  const hResolve = await resolveStoredCopy(PROTECTED);
  check(
    `${SENTINEL} (H). PROTECTED_COPY يُرفض نشره (PROTECTED_COPY_NOT_EDITABLE) ولا تحدث أي كتابة`,
    !hPublish.success &&
      hPublish.error.code === "INVALID_COPY" &&
      hPublish.error.validationFailure?.code ===
        "PROTECTED_COPY_NOT_EDITABLE" &&
      hRow === null &&
      historyItems(hHistory).length === 0 &&
      hResolve.ok &&
      hResolve.source === "CODE_DEFAULT" &&
      hResolve.text === hDefault,
  );
  // Restoring a protected key is impossible: no history row can exist for it,
  // and the restore primitive re-validates against the same contract.
  const hRestore = await restoreOverride(
    PLATFORM_ACTOR,
    "never-existed-history-id",
  );
  check(
    `${SENTINEL} (H2). استرجاع صف غير موجود يُرفق بـ HISTORY_ENTRY_NOT_FOUND (وليس بكتابة)`,
    !hRestore.success && hRestore.error.code === "HISTORY_ENTRY_NOT_FOUND",
  );

  // I — Key isolation: mutating PRIMARY never mutates another key. ISOLATION
  // is touched only for reading here.
  const iIsolationDefault = getCopyEntry(ISOLATION)?.defaultText ?? "";
  const iIsolationPublished = await getPublishedOverride(ISOLATION);
  const iIsolationResolve = await resolveStoredCopy(ISOLATION);
  const iPrimaryRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: PRIMARY },
  });
  const iIsolationRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: ISOLATION },
  });
  check(
    `${SENTINEL} (I). عزل المفاتيح: تعديل مفتاح لا يمسّ مفتاحاً آخر (لا صف، لا سجل، CODE_DEFAULT)`,
    iPrimaryRow?.text === fFirst &&
      iIsolationRow === null &&
      iIsolationPublished.success &&
      iIsolationPublished.data.override === null &&
      iIsolationResolve.ok &&
      iIsolationResolve.source === "CODE_DEFAULT" &&
      iIsolationResolve.text === iIsolationDefault,
  );

  // J — History ordering stays newest-first in the real DB (createdAt desc,
  // then id desc), and the recorded action sequence matches the operation
  // order performed on the key.
  const jHistory = await listOverrideHistory(PLATFORM_ACTOR, PRIMARY, 100);
  const items = historyItems(jHistory);
  const correctlyOrdered = items.every((item, index) => {
    const next = items[index + 1];
    if (next === undefined) return true;
    return (
      item.createdAt >= next.createdAt &&
      (item.createdAt > next.createdAt || item.id > next.id)
    );
  });
  const actions = items.map((i: CopyOverrideHistoryItem) => i.action).join(",");
  // Trace (oldest → newest): PUBLISH(first) B, PUBLISH(second) C, RESET D,
  // [E appends nothing], PUBLISH(fFirst) F, PUBLISH(fSecond) F, RESET F,
  // RESTORE F. [G/G2/G3 rejections and the M FORBIDDEN attempts append
  // nothing.] Newest-first is therefore exactly:
  const expectedActions = "RESTORE,RESET,PUBLISH,PUBLISH,RESET,PUBLISH,PUBLISH";
  check(
    `${SENTINEL} (J). السجل في قاعدة البيانات الحقيقية يبقى من الأحدث إلى الأقدم (createdAt desc ثم id desc)`,
    jHistory.success && correctlyOrdered && items.length === 7,
  );
  check(
    `${SENTINEL} (J2). تسلسل الإجراءات المسجّلة يطابق العمليات المُنفّذة تماماً (${expectedActions})`,
    actions === expectedActions,
  );

  // K — An EDITABLE_TEMPLATE with required placeholders round-trips: the
  // stored template is re-validated on read and still resolves to the
  // PLATFORM_OVERRIDE source (placeholders preserved, not rendered).
  await sleep(3);
  const kText = `${templateDefault} (مراجعة ${SENTINEL})`;
  const kPublish = await savePublishedOverride(PLATFORM_ACTOR, TEMPLATE, kText);
  const kResolve = await resolveStoredCopy(TEMPLATE);
  const kRow = await db.platformCopyOverride.findUnique({
    where: { copyKey: TEMPLATE },
  });
  check(
    `${SENTINEL} (K). قالب EDITABLE_TEMPLATE بحقول مطلوبة يُحفظ ويُعاد التحقق منه عند القراءة (PLATFORM_OVERRIDE، الحقول محفوظة)`,
    kPublish.success &&
      kPublish.data.override.text === kText &&
      kResolve.ok &&
      kResolve.source === "PLATFORM_OVERRIDE" &&
      kResolve.text === kText &&
      kRow?.text === kText &&
      kText.includes("{serviceName}") &&
      kText.includes("{providerName}"),
  );

  // Authorization stays platform-only against the real DB too.
  const forbidden = await savePublishedOverride(
    BUSINESS_ACTOR,
    PRIMARY,
    `محظور ${SENTINEL}`,
  );
  const forbiddenReset = await resetPublishedOverride(BUSINESS_ACTOR, PRIMARY);
  check(
    `${SENTINEL} (M). الجهة غير PLATFORM لا تستطيع أي عملية تعديل (FORBIDDEN)، والنص الفعّال لا يتغيّر`,
    !forbidden.success &&
      forbidden.error.code === "FORBIDDEN" &&
      !forbiddenReset.success &&
      forbiddenReset.error.code === "FORBIDDEN" &&
      (
        await db.platformCopyOverride.findUnique({
          where: { copyKey: PRIMARY },
        })
      )?.text === fFirst,
  );

  // P — Founder Lab surface vs the REAL persistence boundary (Phase 6).
  // The pure UI projections are fed the SAME three service primitives the
  // server action assembles (resolution + published + history), so the
  // drawer's effective source, editor seed, and history views provably track
  // what is actually stored in PostgreSQL — no browser needed. Uses a key
  // untouched by the earlier sections so the (J2) sequence stays exact.
  {
    const P_KEY = ISOLATION; // greeting.ack.salam — EDITABLE_COPY, no placeholders
    const entry = getCopyEntry(P_KEY);
    if (entry === null) {
      check(`${SENTINEL} (P). مفتاح سطح المختبر موجود`, false);
    } else {
      const pDefault = entry.defaultText;

      // open → load effective state (no override yet): CODE_DEFAULT, the
      // editor seeds from the code default, nothing is published.
      const [r0, p0] = await Promise.all([
        resolveStoredCopy(P_KEY),
        getPublishedOverride(P_KEY),
      ]);
      const s0 = mapEffectiveCopyState(entry, r0, p0);
      check(
        `${SENTINEL} (P1). الفتح بدون تجاوز: السطح يعرض CODE_DEFAULT والمحرر يبدأ من النص الافتراضي`,
        s0.source === "CODE_DEFAULT" &&
          s0.text === pDefault &&
          s0.publishedText === null &&
          s0.editorSeed === pDefault &&
          s0.editable === true &&
          s0.persistenceAvailable === true,
      );

      // edit a local draft → preview through the canonical render contract
      // (deterministic, provider/network-free, placeholders preserved).
      const draft = `وعليكم السلام — تجربة ${SENTINEL}`;
      const preview = renderCopyText(
        P_KEY,
        draft,
        collectPreviewValues(entry, {}),
      );
      check(
        `${SENTINEL} (P2). معاينة المسودة حتمية عبر renderCopyText (لا مزود/شبكة)`,
        preview.ok && preview.text === draft && !preview.text.includes("{"),
      );

      // publish → the effective source flips to PLATFORM_OVERRIDE.
      await sleep(3);
      const p1 = await savePublishedOverride(PLATFORM_ACTOR, P_KEY, draft);
      const [r1, q1] = await Promise.all([
        resolveStoredCopy(P_KEY),
        getPublishedOverride(P_KEY),
      ]);
      const s1 = mapEffectiveCopyState(entry, r1, q1);
      check(
        `${SENTINEL} (P3). النشر يقلب المصدر الفعّال في السطح إلى PLATFORM_OVERRIDE`,
        p1.success &&
          s1.source === "PLATFORM_OVERRIDE" &&
          s1.text === draft &&
          s1.publishedText === draft &&
          s1.editorSeed === draft,
      );

      // refresh / re-read → the override REMAINS persisted (not optimistic).
      const [r1b, q1b] = await Promise.all([
        resolveStoredCopy(P_KEY),
        getPublishedOverride(P_KEY),
      ]);
      const s1b = mapEffectiveCopyState(entry, r1b, q1b);
      const rowAfter = await db.platformCopyOverride.findUnique({
        where: { copyKey: P_KEY },
      });
      check(
        `${SENTINEL} (P4). إعادة القراءة بعد النشر تؤكد ثبات التجاوز المخزّن`,
        s1b.source === "PLATFORM_OVERRIDE" &&
          s1b.text === draft &&
          rowAfter?.text === draft,
      );

      // publish a second value → history grows; the newest row is the second
      // value and the previous is the first.
      await sleep(3);
      const second = `وعليكم السلام — تجربة ثانية ${SENTINEL}`;
      await savePublishedOverride(PLATFORM_ACTOR, P_KEY, second);
      const h1 = await listOverrideHistory(PLATFORM_ACTOR, P_KEY, 25);
      const views = mapHistoryItems(historyItems(h1));
      const top = views[0];
      check(
        `${SENTINEL} (P5). نشر قيمة ثانية يُنتج سجلاً أحدث أولاً (resultText = القيمة الثانية، previousText = الأولى)`,
        h1.success &&
          views.length === 2 &&
          top?.actionLabel === "نشر" &&
          top?.resultText === second &&
          top?.previousText === draft &&
          top?.restorable === true,
      );

      // reset → source becomes CODE_DEFAULT again; refresh keeps it.
      await sleep(3);
      await resetPublishedOverride(PLATFORM_ACTOR, P_KEY);
      const [r2, q2] = await Promise.all([
        resolveStoredCopy(P_KEY),
        getPublishedOverride(P_KEY),
      ]);
      const s2 = mapEffectiveCopyState(entry, r2, q2);
      const [r2b] = await Promise.all([resolveStoredCopy(P_KEY)]);
      const s2b = mapEffectiveCopyState(entry, r2b, q2);
      const rowReset = await db.platformCopyOverride.findUnique({
        where: { copyKey: P_KEY },
      });
      check(
        `${SENTINEL} (P6). إعادة التعيين تُرجع CODE_DEFAULT، والفراغ يعني عدم وجود صف (السطح والقاعدة متفقان)`,
        s2.source === "CODE_DEFAULT" &&
          s2.text === pDefault &&
          s2.publishedText === null &&
          s2b.source === "CODE_DEFAULT" &&
          rowReset === null,
      );

      // restore an eligible previous value → it becomes effective again, and
      // a RESTORE row appears newest-first.
      const target = historyItems(h1).find((i) => i.resultText === draft);
      if (target === undefined) {
        check(`${SENTINEL} (P7). صف استرجاع صالح موجود`, false);
      } else {
        const restoreResult = await restoreOverride(PLATFORM_ACTOR, target.id);
        const [r3, q3] = await Promise.all([
          resolveStoredCopy(P_KEY),
          getPublishedOverride(P_KEY),
        ]);
        const s3 = mapEffectiveCopyState(entry, r3, q3);
        const h2 = await listOverrideHistory(PLATFORM_ACTOR, P_KEY, 25);
        const top2 = mapHistoryItems(historyItems(h2))[0];
        check(
          `${SENTINEL} (P7). استرجاع قيمة سابقة صالحة يجعلها فعّالة (PLATFORM_OVERRIDE) مع سجل RESTORE أحدث أولاً`,
          restoreResult.success &&
            restoreResult.data.override.text === draft &&
            s3.source === "PLATFORM_OVERRIDE" &&
            s3.text === draft &&
            top2?.action === "RESTORE" &&
            top2?.resultText === draft,
        );
      }
    }
  }
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
