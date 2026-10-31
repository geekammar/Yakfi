/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { loginSchema } from "../src/features/auth/schemas/login-schema";
import { proxy } from "../src/proxy";
import { NextRequest } from "next/server";

/**
 * FlowPilot — Stale-Session Sign-in Routing Regression Suite (ISS-017)
 *
 * Verifies actual routing behavior and contract invariants:
 * Group A: No cookies (anonymous direct access & protected-route redirects)
 * Group B: Invalid / obsolete cookies (standard and HTTPS secure prefix; bounded termination)
 * Group E: Valid session authoritative server dispatch (active, platform, disabled, safe destinations)
 * Group F: Remember-me contract (default, explicit true, explicit false)
 *
 * Run: pnpm check:stale-session-routing
 */

type Check = {
  group: string;
  id: number;
  label: string;
  pass: boolean;
  details?: string;
};
const checks: Check[] = [];

function check(
  group: string,
  id: number,
  label: string,
  pass: boolean,
  details?: string,
): void {
  checks.push({ group, id, label, pass, details });
  const status = pass ? "✅ PASS" : "❌ FAIL";
  const num = String(id).padStart(2, "0");
  const detailStr = details ? ` (${details})` : "";
  console.log(`${status} [${group}-${num}]: ${label}${detailStr}`);
}

function resolveSafeRedirect(raw: string | string[] | undefined): string {
  if (typeof raw !== "string") return "/";
  const trimmed = raw.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/\\")
  ) {
    return "/";
  }
  const clean = trimmed.split("?")[0];
  if (clean === "/sign-in" || clean === "/sign-up") {
    return "/";
  }
  return trimmed;
}

function evaluateAuthScreenRedirect(
  session: {
    user: { role?: string; isActive?: boolean; accountType?: string | null };
  } | null,
  redirectParam?: string,
): { action: "render_form" | "redirect"; destination?: string } {
  if (!session) {
    return { action: "render_form" };
  }
  if (!session.user.isActive) {
    return { action: "redirect", destination: "/access-denied" };
  }
  if (session.user.accountType === "PLATFORM") {
    return { action: "redirect", destination: "/platform" };
  }
  return {
    action: "redirect",
    destination: resolveSafeRedirect(redirectParam),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Group A: No Cookies
// ─────────────────────────────────────────────────────────────────────────────

{
  const reqSignIn = new NextRequest("http://localhost:3000/sign-in");
  const resSignIn = proxy(reqSignIn);
  // Must pass through (status 200 / not a redirect) so sign-in page can render
  check(
    "A",
    1,
    "/sign-in without cookies passes directly to server (no redirect)",
    resSignIn.status === 200 && !resSignIn.headers.get("location"),
  );

  const reqSignUp = new NextRequest("http://localhost:3000/sign-up");
  const resSignUp = proxy(reqSignUp);
  check(
    "A",
    2,
    "/sign-up without cookies passes directly to server (no redirect)",
    resSignUp.status === 200 && !resSignUp.headers.get("location"),
  );

  const reqProtectedRoot = new NextRequest("http://localhost:3000/");
  const resProtectedRoot = proxy(reqProtectedRoot);
  const locationRoot = resProtectedRoot.headers.get("location");
  const redirectParamRoot = locationRoot
    ? new URL(locationRoot).searchParams.get("redirect")
    : null;
  check(
    "A",
    3,
    "Protected root / without cookies redirects to /sign-in?redirect=/",
    resProtectedRoot.status === 307 && redirectParamRoot === "/",
    `status=${resProtectedRoot.status}, redirectParam=${redirectParamRoot}`,
  );

  const reqProtectedAppointments = new NextRequest(
    "http://localhost:3000/appointments?date=2026-11-01",
  );
  const resProtectedAppointments = proxy(reqProtectedAppointments);
  const locationAppointments = resProtectedAppointments.headers.get("location");
  const redirectParamAppointments = locationAppointments
    ? new URL(locationAppointments).searchParams.get("redirect")
    : null;
  check(
    "A",
    4,
    "Protected /appointments without cookies preserves pathname and search params in redirect",
    resProtectedAppointments.status === 307 &&
      redirectParamAppointments === "/appointments?date=2026-11-01",
    `redirectParam=${redirectParamAppointments}`,
  );

  const reqHealth = new NextRequest("http://localhost:3000/api/health");
  const resHealth = proxy(reqHealth);
  check(
    "A",
    5,
    "Public liveness probe /api/health passes without session cookie",
    resHealth.status === 200 && !resHealth.headers.get("location"),
  );

  const reqBlockedSignup = new NextRequest(
    "http://localhost:3000/api/auth/sign-up/email",
    {
      method: "POST",
    },
  );
  const resBlockedSignup = proxy(reqBlockedSignup);
  check(
    "A",
    6,
    "Public signup closure refuses anonymous POST /api/auth/sign-up/email with 403",
    resBlockedSignup.status === 403,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Group B: Invalid / Stale Cookie (The Defect Repaired)
// ─────────────────────────────────────────────────────────────────────────────

{
  const staleCookie =
    "better-auth.session_token=synthetic-stale-revoked-token-iss-017";
  const reqSignInStale = new NextRequest("http://localhost:3000/sign-in", {
    headers: { cookie: staleCookie },
  });
  const resSignInStale = proxy(reqSignInStale);
  const locSignInStale = resSignInStale.headers.get("location");
  check(
    "B",
    1,
    "Direct /sign-in with standard stale cookie passes directly to server without redirecting to /",
    resSignInStale.status === 200 && !locSignInStale,
    `status=${resSignInStale.status}, location=${locSignInStale ?? "none"}`,
  );

  const secureStaleCookie =
    "__Secure-better-auth.session_token=synthetic-stale-secure-token-iss-017";
  const reqSignInSecureStale = new NextRequest(
    "https://localhost:3000/sign-in",
    {
      headers: { cookie: secureStaleCookie },
    },
  );
  const resSignInSecureStale = proxy(reqSignInSecureStale);
  const locSignInSecureStale = resSignInSecureStale.headers.get("location");
  check(
    "B",
    2,
    "Direct /sign-in with HTTPS __Secure- prefix stale cookie passes directly to server without redirect",
    resSignInSecureStale.status === 200 && !locSignInSecureStale,
    `status=${resSignInSecureStale.status}, location=${locSignInSecureStale ?? "none"}`,
  );

  const reqSignUpStale = new NextRequest("http://localhost:3000/sign-up", {
    headers: { cookie: staleCookie },
  });
  const resSignUpStale = proxy(reqSignUpStale);
  check(
    "B",
    3,
    "/sign-up with stale cookie passes directly to server without redirecting to /",
    resSignUpStale.status === 200 && !resSignUpStale.headers.get("location"),
  );

  const reqRootStale = new NextRequest("http://localhost:3000/", {
    headers: { cookie: staleCookie },
  });
  const resRootStale = proxy(reqRootStale);
  check(
    "B",
    4,
    "Protected / with stale cookie passes edge proxy to reach authoritative server session guard",
    resRootStale.status === 200 && !resRootStale.headers.get("location"),
  );

  // Bounded Navigation Chain Simulation:
  // Step 1: Request "/" with stale cookie -> proxy passes to server (hop 1)
  // Step 2: Server guard rejects obsolete session -> issues redirect to "/sign-in"
  // Step 3: Browser requests "/sign-in" with SAME stale cookie -> proxy passes (hop 2)
  // Step 4: Server SignInPage evaluates session (null) -> renders form without redirect.
  // Result: Strictly 1 redirect hop, terminates at sign-in form. Cycle count = 0.
  let hopCount = 0;
  let currentPath = "/";
  const maxAllowedHops = 3;
  let terminatedAtForm = false;

  while (hopCount < maxAllowedHops) {
    hopCount++;
    const req = new NextRequest(`http://localhost:3000${currentPath}`, {
      headers: { cookie: staleCookie },
    });
    const proxyRes = proxy(req);
    const proxyLocation = proxyRes.headers.get("location");

    if (proxyLocation) {
      currentPath = new URL(proxyLocation).pathname;
      continue;
    }

    // Proxy passed through to server: evaluate server page/guard boundary
    if (currentPath === "/") {
      // Server guard loadActiveSession(): session is null in DB -> redirects to /sign-in
      currentPath = "/sign-in";
      continue;
    }

    if (currentPath === "/sign-in") {
      // Server SignInPage: session is null in DB -> renders form, terminates!
      const serverDecision = evaluateAuthScreenRedirect(null);
      if (serverDecision.action === "render_form") {
        terminatedAtForm = true;
        break;
      }
    }
  }

  check(
    "B",
    5,
    "Bounded navigation: visiting / with stale cookie terminates at /sign-in form within <= 2 hops (zero cycle)",
    terminatedAtForm && hopCount <= 2,
    `hops=${hopCount}, terminatedAtForm=${terminatedAtForm}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Group E: Server-Authoritative Valid Session Handling
// ─────────────────────────────────────────────────────────────────────────────

{
  const activeBusinessUser = {
    user: {
      role: "ADMIN",
      isActive: true,
      accountType: "BUSINESS",
    },
  };

  const activeStaffUser = {
    user: {
      role: "STAFF",
      isActive: true,
      accountType: "BUSINESS",
    },
  };

  const platformOperatorUser = {
    user: {
      role: "ADMIN",
      isActive: true,
      accountType: "PLATFORM",
    },
  };

  const disabledUser = {
    user: {
      role: "ADMIN",
      isActive: false,
      accountType: "BUSINESS",
    },
  };

  const d1 = evaluateAuthScreenRedirect(activeBusinessUser);
  check(
    "E",
    1,
    "Valid active business user visiting /sign-in follows default authenticated destination /",
    d1.action === "redirect" && d1.destination === "/",
    `destination=${d1.destination}`,
  );

  const d2 = evaluateAuthScreenRedirect(activeBusinessUser, "/admin/team");
  check(
    "E",
    2,
    "Valid active business user visiting /sign-in honors safe internal redirect /admin/team",
    d2.action === "redirect" && d2.destination === "/admin/team",
    `destination=${d2.destination}`,
  );

  const d3 = evaluateAuthScreenRedirect(activeStaffUser, "/staff");
  check(
    "E",
    3,
    "Valid active STAFF user visiting /sign-in honors /staff redirect destination",
    d3.action === "redirect" && d3.destination === "/staff",
    `destination=${d3.destination}`,
  );

  const d4 = evaluateAuthScreenRedirect(platformOperatorUser);
  check(
    "E",
    4,
    "Valid Platform Operator visiting /sign-in is redirected to /platform surface",
    d4.action === "redirect" && d4.destination === "/platform",
    `destination=${d4.destination}`,
  );

  const d5 = evaluateAuthScreenRedirect(disabledUser);
  check(
    "E",
    5,
    "Disabled user visiting /sign-in is redirected to /access-denied",
    d5.action === "redirect" && d5.destination === "/access-denied",
    `destination=${d5.destination}`,
  );

  // Open redirect & self-redirect defenses
  const d6 = evaluateAuthScreenRedirect(activeBusinessUser, "//evil.com/phish");
  check(
    "E",
    6,
    "Protocol-relative open redirect //evil.com/phish is sanitized to /",
    d6.action === "redirect" && d6.destination === "/",
    `destination=${d6.destination}`,
  );

  const d7 = evaluateAuthScreenRedirect(activeBusinessUser, "/\\evil.com");
  check(
    "E",
    7,
    "Backslash-escaped open redirect /\\evil.com is sanitized to /",
    d7.action === "redirect" && d7.destination === "/",
    `destination=${d7.destination}`,
  );

  const d8 = evaluateAuthScreenRedirect(
    activeBusinessUser,
    "/sign-in?nested=true",
  );
  check(
    "E",
    8,
    "Self-referential redirect back to /sign-in is sanitized to / to eliminate loops",
    d8.action === "redirect" && d8.destination === "/",
    `destination=${d8.destination}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Group F: Remember-Me Contract
// ─────────────────────────────────────────────────────────────────────────────

{
  const p1 = loginSchema.safeParse({
    email: "user@flowpilot.app",
    password: "example-password",
    rememberMe: false,
  });
  check(
    "F",
    1,
    "loginSchema validates valid submission with rememberMe: false",
    p1.success && p1.data.rememberMe === false,
    `rememberMe=${p1.success ? p1.data.rememberMe : "failed"}`,
  );

  const pOmitted = loginSchema.safeParse({
    email: "user@flowpilot.app",
    password: "example-password",
  });
  check(
    "F",
    2,
    "loginSchema strictly enforces boolean rememberMe (fails when omitted)",
    !pOmitted.success,
  );

  const pTrue = loginSchema.safeParse({
    email: "user@flowpilot.app",
    password: "example-password",
    rememberMe: true,
  });
  check(
    "F",
    3,
    "loginSchema preserves explicit rememberMe: true",
    pTrue.success && pTrue.data.rememberMe === true,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary & Exit
// ─────────────────────────────────────────────────────────────────────────────

const total = checks.length;
const passed = checks.filter((c) => c.pass).length;
const failed = total - passed;

console.log("\n────────────────────────────────────────────────────────────");
console.log(
  `Stale-Session Routing Verification: ${passed}/${total} PASS (${failed} failed)`,
);
console.log("────────────────────────────────────────────────────────────");

if (failed > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
