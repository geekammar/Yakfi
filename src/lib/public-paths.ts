/**
 * Public-path policy for the route proxy (tier 1 of the two-tier
 * protection model — see `src/proxy.ts` and `docs/DECISIONS.md` #13).
 *
 * Extracted from the proxy so the routing policy is independently
 * verifiable: unauthenticated access to protected areas (e.g.
 * `/onboarding`) must be redirected to `/sign-in`, while the
 * token-scoped invitation activation routes (`/invite/<token>` and
 * the platform owner activation `/owner-invite/<token>`) stay
 * public — the invitation token itself is the credential there, and
 * the invitation services enforce their lifecycles server-side.
 */

const PUBLIC_PATHS = [
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/unauthorized",
  "/access-denied",
] as const;

const PUBLIC_PATH_PREFIXES = [
  "/invite/",
  "/owner-invite/",
  "/api/auth",
  "/api/whatsapp/meta",
  // The Telegram webhook endpoints (DECISIONS #63 (E)/#66). Telegram's
  // servers POST here with NO FlowPilot session cookie, so leaving these
  // behind the session gate made `src/proxy.ts` answer every delivery with a
  // 307 redirect to /sign-in (proven live against v0.31.0) — which silently
  // killed the `/start` binding, the `managed_bot` completion, and every
  // inbound customer message. Public here does NOT mean unauthenticated: the
  // request credential is Telegram's own `X-Telegram-Bot-Api-Secret-Token`,
  // which each handler verifies with a constant-time compare and answers 401
  // BEFORE any parsing or processing (the same model as `/invite/<token>`,
  // where the token in the path is the credential).
  "/api/telegram",
  // Provider-neutral inbound webhook / operator test ingress (PROMPT-19 /
  // PROMPT-AI-JEV-03F-I). Authenticated via FLOWPILOT_TEST_INGRESS_TOKEN or
  // INBOUND_WEBHOOK_TOKEN header; failing closed 401/503 before any processing.
  "/api/conversations/inbound",
] as const;

export function isPublicPath(pathname: string): boolean {
  // /api/health is the public liveness probe (deployment validation).
  return (
    PUBLIC_PATHS.includes(pathname as (typeof PUBLIC_PATHS)[number]) ||
    pathname === "/api/health" ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

// ─── Public signup closure (PROMPT-OPS-05) ──────────────────────────────────

/**
 * The public Better Auth email sign-up endpoints. PUBLIC SIGNUP IS
 * CLOSED: anonymous visitors cannot create arbitrary accounts. The
 * block is METHOD-scoped (POST) and enforced by the route proxy —
 * internal server-side calls (`auth.api.signUpEmail` behind the
 * invitation activation flows) do NOT traverse the proxy, so the
 * canonical invitation-first account creation stays fully functional.
 * Better Auth's own `disableSignUp` cannot be used (it also blocks the
 * internal endpoint).
 */
const BLOCKED_SIGNUP_PATHS = ["/api/auth/sign-up/email", "/api/auth/sign-up"];

export function isBlockedSignupRequest(
  method: string,
  pathname: string,
): boolean {
  return (
    method === "POST" &&
    BLOCKED_SIGNUP_PATHS.includes(
      pathname as (typeof BLOCKED_SIGNUP_PATHS)[number],
    )
  );
}
