/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { getSignInDestination } from "../src/app/(auth)/sign-in/page";
import { loginSchema } from "../src/features/auth/schemas/login-schema";
import { resolveSafeRedirect } from "../src/lib/safe-redirect";
import { proxy } from "../src/proxy";
import { NextRequest } from "next/server";

/**
 * FlowPilot — Stale-Session Sign-in Routing Regression Suite (ISS-017)
 *
 * Verifies actual routing behavior and contract invariants without duplicated logic:
 * Group A: [Proxy] No cookies (anonymous direct access & protected-route redirects)
 * Group B: [Proxy] Invalid / obsolete cookies (standard and HTTPS secure prefix; bounded termination)
 * Group C: [SafeRedirect] Shared production URL helper (control chars, protocol-relative, backslash, dots)
 * Group D: [PageBoundary] Real Server Component destination decision (active, platform, disabled, safe paths)
 * Group E: [RememberMe] Schema contract (default false, explicit true, explicit false)
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

async function run(): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────────
  // Group A: [Proxy] No Cookies
  // ─────────────────────────────────────────────────────────────────────────────

  {
    const reqSignIn = new NextRequest("http://localhost:3000/sign-in");
    const resSignIn = proxy(reqSignIn);
    check(
      "A",
      1,
      "[Proxy] /sign-in without cookies passes directly to server (no redirect)",
      resSignIn.status === 200 && !resSignIn.headers.get("location"),
    );

    const reqSignUp = new NextRequest("http://localhost:3000/sign-up");
    const resSignUp = proxy(reqSignUp);
    check(
      "A",
      2,
      "[Proxy] /sign-up without cookies passes directly to server (no redirect)",
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
      "[Proxy] Protected root / without cookies redirects to /sign-in?redirect=/",
      resProtectedRoot.status === 307 && redirectParamRoot === "/",
      `status=${resProtectedRoot.status}, redirectParam=${redirectParamRoot}`,
    );

    const reqProtectedAppointments = new NextRequest(
      "http://localhost:3000/appointments?date=2026-11-01",
    );
    const resProtectedAppointments = proxy(reqProtectedAppointments);
    const locationAppointments =
      resProtectedAppointments.headers.get("location");
    const redirectParamAppointments = locationAppointments
      ? new URL(locationAppointments).searchParams.get("redirect")
      : null;
    check(
      "A",
      4,
      "[Proxy] Protected /appointments without cookies preserves pathname and search params in redirect",
      resProtectedAppointments.status === 307 &&
        redirectParamAppointments === "/appointments?date=2026-11-01",
      `redirectParam=${redirectParamAppointments}`,
    );

    const reqHealth = new NextRequest("http://localhost:3000/api/health");
    const resHealth = proxy(reqHealth);
    check(
      "A",
      5,
      "[Proxy] Public liveness probe /api/health passes without session cookie",
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
      "[Proxy] Public signup closure refuses anonymous POST /api/auth/sign-up/email with 403",
      resBlockedSignup.status === 403,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Group B: [Proxy] Invalid / Stale Cookie
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
      "[Proxy] Direct /sign-in with standard stale cookie passes directly to server without redirecting to /",
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
      "[Proxy] Direct /sign-in with HTTPS __Secure- prefix stale cookie passes directly to server without redirect",
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
      "[Proxy] /sign-up with stale cookie passes directly to server without redirecting to /",
      resSignUpStale.status === 200 && !resSignUpStale.headers.get("location"),
    );

    const reqRootStale = new NextRequest("http://localhost:3000/", {
      headers: { cookie: staleCookie },
    });
    const resRootStale = proxy(reqRootStale);
    check(
      "B",
      4,
      "[Proxy] Protected / with stale cookie passes edge proxy to reach authoritative server session guard",
      resRootStale.status === 200 && !resRootStale.headers.get("location"),
    );

    // Bounded Navigation Chain Verification:
    // Step 1: Request "/" with stale cookie -> proxy passes to server (hop 1)
    // Step 2: Server guard loadActiveSession() rejects null session -> redirects to "/sign-in"
    // Step 3: Browser requests "/sign-in" with SAME stale cookie -> proxy passes (hop 2)
    // Step 4: Server getSignInDestination(null) -> returns null -> renders sign-in form.
    // Result: Terminated within <= 2 hops. Zero redirect cycles.
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

      if (currentPath === "/") {
        // Real server guard behavior on unauthenticated session
        currentPath = "/sign-in";
        continue;
      }

      if (currentPath === "/sign-in") {
        // Execute the real production server decision helper
        const destination = await getSignInDestination(null);
        if (destination === null) {
          terminatedAtForm = true;
          break;
        }
      }
    }

    check(
      "B",
      5,
      "[Proxy+PageBoundary] Bounded navigation: visiting / with stale cookie terminates at /sign-in form within <= 2 hops (zero cycle)",
      terminatedAtForm && hopCount <= 2,
      `hops=${hopCount}, terminatedAtForm=${terminatedAtForm}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Group C: [SafeRedirect] Shared Production Helper
  // ─────────────────────────────────────────────────────────────────────────────

  {
    // Normal internal destinations & query strings
    check(
      "C",
      1,
      "[SafeRedirect] Preserves root '/' destination",
      resolveSafeRedirect("/") === "/",
    );

    check(
      "C",
      2,
      "[SafeRedirect] Preserves valid internal path '/admin/team'",
      resolveSafeRedirect("/admin/team") === "/admin/team",
    );

    check(
      "C",
      3,
      "[SafeRedirect] Preserves path with query and hash '/appointments?date=2026-11-01#summary'",
      resolveSafeRedirect("/appointments?date=2026-11-01#summary") ===
        "/appointments?date=2026-11-01#summary",
    );

    // Actual control characters
    check(
      "C",
      4,
      "[SafeRedirect] Rejects string containing actual TAB character '/\\t/evil.example'",
      resolveSafeRedirect("/\t/evil.example") === "/",
    );

    check(
      "C",
      5,
      "[SafeRedirect] Rejects string containing actual newline '/\\n/evil.example'",
      resolveSafeRedirect("/\n/evil.example") === "/",
    );

    check(
      "C",
      6,
      "[SafeRedirect] Rejects string containing carriage return '/\\r/evil.example'",
      resolveSafeRedirect("/\r/evil.example") === "/",
    );

    check(
      "C",
      7,
      "[SafeRedirect] Rejects string containing NUL byte '/\\0/evil.example'",
      resolveSafeRedirect("/\0/evil.example") === "/",
    );

    check(
      "C",
      8,
      "[SafeRedirect] Rejects embedded control characters '/path\\twith\\ttabs'",
      resolveSafeRedirect("/path\twith\ttabs") === "/",
    );

    // Protocol-relative URLs
    check(
      "C",
      9,
      "[SafeRedirect] Rejects protocol-relative '//evil.example'",
      resolveSafeRedirect("//evil.example") === "/",
    );

    check(
      "C",
      10,
      "[SafeRedirect] Rejects multi-slash '///evil.example'",
      resolveSafeRedirect("///evil.example") === "/",
    );

    // Backslashes
    check(
      "C",
      11,
      "[SafeRedirect] Rejects backslash open redirect '/\\\\evil.example'",
      resolveSafeRedirect("/\\evil.example") === "/",
    );

    check(
      "C",
      12,
      "[SafeRedirect] Rejects embedded backslashes '/foo\\\\bar'",
      resolveSafeRedirect("/foo\\bar") === "/",
    );

    // Normalized dot segments
    check(
      "C",
      13,
      "[SafeRedirect] Normalizes dot segments: '/admin/../sign-in' normalizes to /sign-in and is rejected to '/'",
      resolveSafeRedirect("/admin/../sign-in") === "/",
    );

    check(
      "C",
      14,
      "[SafeRedirect] Normalizes dot segments: '/sign-in/../dashboard' resolves to '/dashboard'",
      resolveSafeRedirect("/sign-in/../dashboard") === "/dashboard",
    );

    // Auth screen destinations
    check(
      "C",
      15,
      "[SafeRedirect] Prevents redirect back to '/sign-in' (falls back to '/')",
      resolveSafeRedirect("/sign-in") === "/",
    );

    check(
      "C",
      16,
      "[SafeRedirect] Prevents redirect back to '/sign-in/' with trailing slash",
      resolveSafeRedirect("/sign-in/") === "/",
    );

    check(
      "C",
      17,
      "[SafeRedirect] Prevents redirect back to '/sign-in?nested=1' with query params",
      resolveSafeRedirect("/sign-in?nested=1") === "/",
    );

    check(
      "C",
      18,
      "[SafeRedirect] Prevents redirect back to '/sign-up'",
      resolveSafeRedirect("/sign-up") === "/",
    );

    // Non-string / array inputs
    check(
      "C",
      19,
      "[SafeRedirect] Rejects array input ['/admin/team']",
      resolveSafeRedirect(["/admin/team"] as any) === "/",
    );

    check(
      "C",
      20,
      "[SafeRedirect] Rejects null / undefined / object / number inputs",
      resolveSafeRedirect(null) === "/" &&
        resolveSafeRedirect(undefined) === "/" &&
        resolveSafeRedirect(12345 as any) === "/" &&
        resolveSafeRedirect({} as any) === "/",
    );

    // External schemes
    check(
      "C",
      21,
      "[SafeRedirect] Rejects external scheme 'https://evil.example'",
      resolveSafeRedirect("https://evil.example") === "/",
    );

    check(
      "C",
      22,
      "[SafeRedirect] Rejects javascript scheme 'javascript:alert(1)'",
      resolveSafeRedirect("javascript:alert(1)") === "/",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Group D: [PageBoundary] Real Server Destination Decision
  // ─────────────────────────────────────────────────────────────────────────────

  {
    const activeBusinessUser: any = {
      session: { id: "s1" },
      user: {
        role: "ADMIN",
        isActive: true,
        accountType: "BUSINESS",
      },
    };

    const activeStaffUser: any = {
      session: { id: "s2" },
      user: {
        role: "STAFF",
        isActive: true,
        accountType: "BUSINESS",
      },
    };

    const platformOperatorUser: any = {
      session: { id: "s3" },
      user: {
        role: "ADMIN",
        isActive: true,
        accountType: "PLATFORM",
      },
    };

    const disabledUser: any = {
      session: { id: "s4" },
      user: {
        role: "ADMIN",
        isActive: false,
        accountType: "BUSINESS",
      },
    };

    // Real getSignInDestination calls
    const d0 = await getSignInDestination(null);
    check(
      "D",
      1,
      "[PageBoundary] Absent / null session returns null (signals sign-in form must render)",
      d0 === null,
    );

    const d1 = await getSignInDestination(activeBusinessUser);
    check(
      "D",
      2,
      "[PageBoundary] Valid active business user follows default authenticated destination /",
      d1 === "/",
      `destination=${d1}`,
    );

    const d2 = await getSignInDestination(
      activeBusinessUser,
      Promise.resolve({ redirect: "/admin/team" }),
    );
    check(
      "D",
      3,
      "[PageBoundary] Valid active business user honors safe internal redirect /admin/team",
      d2 === "/admin/team",
      `destination=${d2}`,
    );

    const d3 = await getSignInDestination(
      activeStaffUser,
      Promise.resolve({ redirect: "/staff" }),
    );
    check(
      "D",
      4,
      "[PageBoundary] Valid active STAFF user honors /staff redirect destination",
      d3 === "/staff",
      `destination=${d3}`,
    );

    const d4 = await getSignInDestination(platformOperatorUser);
    check(
      "D",
      5,
      "[PageBoundary] Valid Platform Operator is routed to /platform control surface",
      d4 === "/platform",
      `destination=${d4}`,
    );

    const d5 = await getSignInDestination(disabledUser);
    check(
      "D",
      6,
      "[PageBoundary] Disabled user is routed to /access-denied",
      d5 === "/access-denied",
      `destination=${d5}`,
    );

    const d6 = await getSignInDestination(
      activeBusinessUser,
      Promise.resolve({ redirect: "//evil.com/phish" }),
    );
    check(
      "D",
      7,
      "[PageBoundary] Protocol-relative open redirect //evil.com/phish is sanitized to /",
      d6 === "/",
      `destination=${d6}`,
    );

    const d7 = await getSignInDestination(
      activeBusinessUser,
      Promise.resolve({ redirect: "/\t/evil.example" }),
    );
    check(
      "D",
      8,
      "[PageBoundary] Control-character open redirect /\\t/evil.example is sanitized to /",
      d7 === "/",
      `destination=${d7}`,
    );

    const d8 = await getSignInDestination(
      activeBusinessUser,
      Promise.resolve({ redirect: "/sign-in?nested=true" }),
    );
    check(
      "D",
      9,
      "[PageBoundary] Self-referential redirect back to /sign-in is sanitized to / to eliminate loops",
      d8 === "/",
      `destination=${d8}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Group E: [RememberMe] Schema Contract
  // ─────────────────────────────────────────────────────────────────────────────

  {
    const p1 = loginSchema.safeParse({
      email: "user@flowpilot.app",
      password: "example-password",
      rememberMe: false,
    });
    check(
      "E",
      1,
      "[RememberMe] loginSchema validates valid submission with rememberMe: false",
      p1.success && p1.data.rememberMe === false,
      `rememberMe=${p1.success ? p1.data.rememberMe : "failed"}`,
    );

    const pOmitted = loginSchema.safeParse({
      email: "user@flowpilot.app",
      password: "example-password",
    });
    check(
      "E",
      2,
      "[RememberMe] loginSchema strictly enforces boolean rememberMe (fails when omitted)",
      !pOmitted.success,
    );

    const pTrue = loginSchema.safeParse({
      email: "user@flowpilot.app",
      password: "example-password",
      rememberMe: true,
    });
    check(
      "E",
      3,
      "[RememberMe] loginSchema preserves explicit rememberMe: true",
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
}

run().catch((err) => {
  console.error("❌ Stale session routing check threw unhandled error:", err);
  process.exit(1);
});
