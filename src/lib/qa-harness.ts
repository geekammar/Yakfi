import { isRenderProductionRuntime } from "@/lib/runtime-identity";

/**
 * QA Harness Availability Guard
 *
 * Rules:
 * 1. Must be unavailable by default.
 * 2. Production hosts (Vercel production or Render production web service) MUST
 *    reject the fixture route even if FLOWPILOT_ENABLE_QA_HARNESS is
 *    accidentally enabled in env.
 * 3. NODE_ENV=production alone does NOT reject the harness because CI tests
 *    run against a production build (pnpm start).
 * 4. Only available when FLOWPILOT_ENABLE_QA_HARNESS (or ENABLE_QA_HARNESS) is explicitly
 *    "true" or "1" and not running in a production host environment.
 */

export function isQaHarnessAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // 1. Production hosting MUST reject the fixture route even if the flag is enabled
  if (
    env.VERCEL_ENV === "production" ||
    env.NEXT_PUBLIC_VERCEL_ENV === "production" ||
    isRenderProductionRuntime(env)
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
