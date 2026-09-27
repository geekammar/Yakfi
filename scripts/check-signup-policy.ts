/**
 * FlowPilot — PUBLIC SIGNUP POLICY check (PROMPT-OPS-05).
 *
 * Proves the signup/invitation distinction at the policy boundary
 * (pure functions — no DB, no network):
 *   - the public Better Auth email sign-up endpoints are BLOCKED (POST);
 *   - the invitation activation routes stay PUBLIC (the token is the
 *     credential — the invitation-first lifecycle is untouched);
 *   - everything else behaves exactly as before (sign-in public,
 *     protected areas non-public, other auth endpoints untouched).
 *
 * Run: pnpm check:signup
 */

import { isBlockedSignupRequest, isPublicPath } from "../src/lib/public-paths";

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

// 1. Public signup is CLOSED for anonymous POSTs.
check(
  "POST /api/auth/sign-up/email مرفوض (التسجيل العام مغلق)",
  isBlockedSignupRequest("POST", "/api/auth/sign-up/email") === true,
);
check(
  "POST /api/auth/sign-up مرفوض",
  isBlockedSignupRequest("POST", "/api/auth/sign-up") === true,
);

// 2. Internal auth.api endpoints are untouched (invitation activation
//    calls these SERVER-SIDE, outside the proxy — still functional).
check(
  "POST /api/auth/sign-in/email غير ممنوع (الدخول يعمل)",
  isBlockedSignupRequest("POST", "/api/auth/sign-in/email") === false,
);
check(
  "POST /api/auth/sign-out غير ممنوع",
  isBlockedSignupRequest("POST", "/api/auth/sign-out") === false,
);
check(
  "POST /api/auth/get-session غير ممنوع",
  isBlockedSignupRequest("POST", "/api/auth/get-session") === false,
);

// 3. The block is method-scoped: only anonymous account CREATION is closed.
check(
  "GET على مسارات sign-up غير ممنوع (المنهج فقط)",
  isBlockedSignupRequest("GET", "/api/auth/sign-up/email") === false,
);

// 4. Invitation activation stays OPEN (token = credential).
check(
  "GET /invite/<token> عام (تفعيل دعوة المنشأة يعمل)",
  isPublicPath("/invite/some-token") === true,
);
check(
  "GET /owner-invite/<token> عام (تفعيل مالك منشأة يعمل)",
  isPublicPath("/owner-invite/some-token") === true,
);

// 5. Existing behavior unchanged.
check("GET /sign-in عام", isPublicPath("/sign-in") === true);
check(
  "GET /api/auth/* عام (حظر التسجيل عبر الحظر المستهدف فقط)",
  isPublicPath("/api/auth/sign-in/email") === true,
);
check("GET /api/health عام", isPublicPath("/api/health") === true);
check("GET /platform غير عام (محمي)", isPublicPath("/platform") === false);
check("GET / غير عام (محمي)", isPublicPath("/") === false);

// 6. Provider webhooks must stay REACHABLE. Telegram's servers carry no
//    FlowPilot session cookie, so a session-gated webhook route makes the
//    route proxy answer 307 → /sign-in and the delivery never arrives
//    (proven live on v0.31.0). Public here is not "unauthenticated": each
//    handler still verifies the provider's secret-token header first and
//    answers 401 before any parsing.
check(
  "POST /api/telegram/webhook يصل (تسليم تيليجرام غير محجوب بجلسة)",
  isPublicPath("/api/telegram/webhook") === true,
);
check(
  "POST /api/telegram/manager/webhook يصل (binding + managed_bot)",
  isPublicPath("/api/telegram/manager/webhook") === true,
);
check(
  "مسارات تيليجرام الفرعية تتبع نفس البوابة العامة",
  isPublicPath("/api/telegram/webhook") === true &&
    isPublicPath("/api/telegram/manager/webhook") === true,
);
check(
  "GET /api/conversations غير عام (محمي)",
  isPublicPath("/api/conversations") === false,
);
check(
  "GET /settings/telegram غير عام (محمي بجلسة)",
  isPublicPath("/settings/telegram") === false,
);

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
  `\nسياسة التسجيل صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
);
