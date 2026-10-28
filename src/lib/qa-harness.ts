/**
 * QA Harness Availability Guard
 *
 * Rules:
 * 1. Must be unavailable by default.
 * 2. Vercel production deployment MUST reject the fixture route even if
 *    FLOWPILOT_ENABLE_QA_HARNESS is accidentally enabled in env (VERCEL_ENV === "production"
 *    or NEXT_PUBLIC_VERCEL_ENV === "production").
 * 3. NODE_ENV=production alone does NOT reject the harness because CI tests
 *    run against a production build (pnpm start).
 * 4. Only available when FLOWPILOT_ENABLE_QA_HARNESS (or ENABLE_QA_HARNESS) is explicitly
 *    "true" or "1" and not running in Vercel production.
 */

export function isQaHarnessAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // 1. Vercel production MUST reject the fixture route even if the flag is enabled
  if (
    env.VERCEL_ENV === "production" ||
    env.NEXT_PUBLIC_VERCEL_ENV === "production"
  ) {
    return false;
  }

  // 2. Allowed in verified Vercel preview environments (where automated browser QA runs)
  if (env.VERCEL_ENV === "preview") {
    return true;
  }

  // 3. Unavailable by default; allowed when explicit server-side test flag is enabled
  const flag = env.FLOWPILOT_ENABLE_QA_HARNESS ?? env.ENABLE_QA_HARNESS;
  return flag === "true" || flag === "1";
}
