/**
 * FlowPilot — QA HARNESS ACCESS GUARD POLICY check
 *
 * Proves that:
 * 1. The fixture is UNAVAILABLE by default (no env vars set).
 * 2. The fixture is UNAVAILABLE in production configuration (VERCEL_ENV=production),
 *    even when FLOWPILOT_ENABLE_QA_HARNESS="true".
 * 3. The fixture is UNAVAILABLE in production when NEXT_PUBLIC_VERCEL_ENV=production.
 * 4. The fixture is AVAILABLE in the intended CI test configuration
 *    (FLOWPILOT_ENABLE_QA_HARNESS="true", NODE_ENV="production", VERCEL_ENV undefined).
 * 5. Broad /qa/ prefix is NOT public.
 * 6. Non-fixture /qa/* subroutes are NOT public.
 * 7. Product routes retain their exact authentication policy.
 *
 * Run: pnpm check:qa-harness
 */

import {
  QA_CONVERSATION_HEADER_PATH,
  isPublicPath,
} from "../src/lib/public-paths";
import { isQaHarnessAllowed } from "../src/lib/qa-harness";

type Check = { label: string; pass: boolean };

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

// 1. Fixture is UNAVAILABLE by default
check(
  "isQaHarnessAllowed({}) === false (غير متاح افتراضياً)",
  isQaHarnessAllowed({}) === false,
);
check(
  "isPublicPath(/qa/conversation-header, {}) === false (المسار غير عام افتراضياً)",
  isPublicPath(QA_CONVERSATION_HEADER_PATH, {}) === false,
);

// 2. Fixture is UNAVAILABLE in production configuration (even if flag enabled)
check(
  "isQaHarnessAllowed({ VERCEL_ENV: 'production', FLOWPILOT_ENABLE_QA_HARNESS: 'true' }) === false (محظور في إنتاج فيرسيل)",
  isQaHarnessAllowed({
    VERCEL_ENV: "production",
    FLOWPILOT_ENABLE_QA_HARNESS: "true",
  }) === false,
);
check(
  "isPublicPath(/qa/conversation-header) === false في إنتاج فيرسيل حتى مع تفعيل الراية",
  isPublicPath(QA_CONVERSATION_HEADER_PATH, {
    VERCEL_ENV: "production",
    FLOWPILOT_ENABLE_QA_HARNESS: "true",
  }) === false,
);
check(
  "isQaHarnessAllowed({ NEXT_PUBLIC_VERCEL_ENV: 'production', FLOWPILOT_ENABLE_QA_HARNESS: 'true' }) === false",
  isQaHarnessAllowed({
    NEXT_PUBLIC_VERCEL_ENV: "production",
    FLOWPILOT_ENABLE_QA_HARNESS: "true",
  }) === false,
);
check(
  "isPublicPath(/qa/conversation-header) === false مع NEXT_PUBLIC_VERCEL_ENV=production",
  isPublicPath(QA_CONVERSATION_HEADER_PATH, {
    NEXT_PUBLIC_VERCEL_ENV: "production",
    FLOWPILOT_ENABLE_QA_HARNESS: "true",
  }) === false,
);

// 3. Fixture is AVAILABLE in intended CI test configuration
check(
  "isQaHarnessAllowed with FLOWPILOT_ENABLE_QA_HARNESS='true' and NODE_ENV='production' === true (متاح في بيئة اختبار الـ CI لبناء الإنتاج)",
  isQaHarnessAllowed({
    NODE_ENV: "production",
    FLOWPILOT_ENABLE_QA_HARNESS: "true",
  }) === true,
);
check(
  "isPublicPath(/qa/conversation-header) === true في بيئة اختبار الـ CI",
  isPublicPath(QA_CONVERSATION_HEADER_PATH, {
    NODE_ENV: "production",
    FLOWPILOT_ENABLE_QA_HARNESS: "true",
  }) === true,
);
check(
  "isQaHarnessAllowed with FLOWPILOT_ENABLE_QA_HARNESS='1' === true",
  isQaHarnessAllowed({
    FLOWPILOT_ENABLE_QA_HARNESS: "1",
  }) === true,
);

// 4. Broad /qa/ prefix and unknown subroutes are NOT public
const ciEnv: Record<string, string | undefined> = {
  FLOWPILOT_ENABLE_QA_HARNESS: "true",
};
check("المسار العام /qa/ غير متاح", isPublicPath("/qa/", ciEnv) === false);
check("المسار العام /qa غير متاح", isPublicPath("/qa", ciEnv) === false);
check(
  "المسار الفرعي /qa/other غير متاح",
  isPublicPath("/qa/other", ciEnv) === false,
);
check(
  "المسار الفرعي /qa/admin غير متاح",
  isPublicPath("/qa/admin", ciEnv) === false,
);

// 5. Product routes authentication behavior unchanged
check("GET /sign-in عام", isPublicPath("/sign-in", ciEnv) === true);
check("GET /api/health عام", isPublicPath("/api/health", ciEnv) === true);
check(
  "GET /api/auth/sign-in/email عام",
  isPublicPath("/api/auth/sign-in/email", ciEnv) === true,
);
check(
  "GET /conversations محمي (غير عام)",
  isPublicPath("/conversations", ciEnv) === false,
);
check(
  "GET /appointments محمي (غير عام)",
  isPublicPath("/appointments", ciEnv) === false,
);
check(
  "GET /onboarding محمي (غير عام)",
  isPublicPath("/onboarding", ciEnv) === false,
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
  `\nسياسة حماية الـ QA Harness صحيحة ومحكمة: ${checks.length}/${checks.length} فحص ناجح.`,
);
