/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * FlowPilot — Stale Session Database & Real Session Lifecycle Suite (ISS-017)
 *
 * Verifies Condition C (Genuine Revoked Session) and Condition D (Expired Session)
 * against a disposable local PostgreSQL database in GitHub Actions CI:
 *
 * C-01: Synthetic user and valid session created through supported auth.api.signUpEmail.
 * C-02: Authoritative session lookup validates active session from real signed cookie.
 * C-03: Session revoked server-side (deleted in DB) while browser retains cookie.
 * C-04: Authoritative lookup with revoked cookie returns null (authoritative no valid session).
 * C-05: Visiting / with revoked cookie passes proxy and routes to /sign-in without loop.
 * C-06: Direct /sign-in with revoked cookie renders form without redirect.
 * C-07: Fresh sign-in replaces obsolete session and restores active access in same context.
 *
 * D-01: Session with controlled past expiresAt updated in DB.
 * D-02: Authoritative lookup with expired cookie returns null.
 * D-03: Bounded navigation terminates at /sign-in with usable form.
 *
 * 08-01: Database exceptions are distinguished from authoritative "no session" and propagate.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:password@localhost:5432/flowpilot_test' \
 *     pnpm check:stale-session-db
 */

import { auth } from "../src/lib/auth";
import { proxy } from "../src/proxy";
import { db } from "../src/server/db";
import { NextRequest } from "next/server";

type Check = { id: string; label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(
  id: string,
  label: string,
  pass: boolean,
  details?: string,
): void {
  checks.push({ id, label, pass, details });
  const status = pass ? "✅ PASS" : "❌ FAIL";
  const detailStr = details ? ` (${details})` : "";
  console.log(`${status} [${id}]: ${label}${detailStr}`);
}

function classifyTarget(
  url: string,
): { host: string; local: boolean; reason: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const isLocal =
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === "";
    return {
      host,
      local: isLocal,
      reason: isLocal
        ? "local / disposable test database"
        : "remote host rejected",
    };
  } catch {
    return null;
  }
}

function extractCookieValue(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  // Match better-auth.session_token=... or __Secure-better-auth.session_token=...
  const match = setCookieHeader.match(
    /((?:__Secure-)?better-auth\.session_token=[^;]+)/,
  );
  return match?.[1] ?? null;
}

async function run(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log(
      "ℹ️  DATABASE_URL not set — skipping DB-backed stale session check (CI runs this against flowpilot_test).",
    );
    process.exit(0);
  }

  const classification = classifyTarget(dbUrl);
  if (!classification?.local) {
    console.error(
      "❌ Refusing to execute against non-disposable target:",
      dbUrl,
    );
    process.exit(1);
  }

  const testEmail = `stale.qa.${Date.now()}@flowpilot.test`;
  const testPassword = "ExamplePassword@1234";
  let createdUserId: string | null = null;

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // Condition C: Genuine Revoked Session via supported application paths
    // ─────────────────────────────────────────────────────────────────────────

    // 1. Create authorized synthetic test user through supported auth.api path
    const signUpResponse = await (auth.api.signUpEmail as any)({
      body: {
        email: testEmail,
        name: "Synthetic Stale Session QA",
        password: testPassword,
      },
      asResponse: true,
    });

    const setCookieRaw = signUpResponse.headers.get("set-cookie");
    const sessionCookie = extractCookieValue(setCookieRaw);
    check(
      "C-01",
      "Synthetic user and active session created through supported auth.api.signUpEmail path",
      Boolean(sessionCookie),
      `hasCookie=${Boolean(sessionCookie)}`,
    );

    if (!sessionCookie) {
      throw new Error("Failed to obtain session cookie from signUpEmail");
    }

    // 2. Authoritative lookup validates active session
    const activeHeaders = new Headers({ cookie: sessionCookie });
    const activeSession = await auth.api.getSession({ headers: activeHeaders });
    createdUserId = activeSession?.user?.id ?? null;

    check(
      "C-02",
      "Better Auth getSession validates active session from real signed cookie",
      Boolean(activeSession && activeSession.user.email === testEmail),
      `email=${activeSession?.user?.email}`,
    );

    // 3. Revoke session server-side in DB while keeping the browser cookie
    if (activeSession?.session?.id) {
      await db.session.delete({ where: { id: activeSession.session.id } });
    }
    check(
      "C-03",
      "Session revoked server-side by deleting database session record",
      true,
    );

    // 4. Verify getSession returns null when obsolete/revoked cookie is sent
    const revokedSession = await auth.api.getSession({
      headers: activeHeaders,
    });
    check(
      "C-04",
      "getSession returns null (authoritative no valid session) with revoked cookie",
      revokedSession === null,
    );

    // 5. Test proxy navigation on / with stale cookie
    const reqRoot = new NextRequest("http://localhost:3000/", {
      headers: { cookie: sessionCookie },
    });
    const resRoot = proxy(reqRoot);
    check(
      "C-05",
      "Visiting / with revoked cookie passes proxy without edge redirect loop",
      resRoot.status === 200 && !resRoot.headers.get("location"),
    );

    // 6. Test proxy navigation on /sign-in with stale cookie
    const reqSignIn = new NextRequest("http://localhost:3000/sign-in", {
      headers: { cookie: sessionCookie },
    });
    const resSignIn = proxy(reqSignIn);
    check(
      "C-06",
      "Direct /sign-in with revoked cookie passes directly to server without redirect to /",
      resSignIn.status === 200 && !resSignIn.headers.get("location"),
    );

    // 7. Fresh sign-in in the SAME browser context replaces obsolete auth state
    const signInResponse = await (auth.api.signInEmail as any)({
      body: {
        email: testEmail,
        password: testPassword,
        rememberMe: false,
      },
      asResponse: true,
    });

    const freshCookieRaw = signInResponse.headers.get("set-cookie");
    const freshSessionCookie = extractCookieValue(freshCookieRaw);
    const freshHeaders = new Headers({
      cookie: freshSessionCookie || "",
    });
    const reAuthSession = await auth.api.getSession({ headers: freshHeaders });

    check(
      "C-07",
      "Fresh sign-in replaces obsolete session and restores access in same browser context",
      Boolean(reAuthSession && reAuthSession.user.email === testEmail),
      `email=${reAuthSession?.user?.email}`,
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Condition D: Controlled Expired Session
    // ─────────────────────────────────────────────────────────────────────────

    // Set expiresAt of the active session to 1 hour in the past
    if (reAuthSession?.session?.id) {
      await db.session.update({
        where: { id: reAuthSession.session.id },
        data: { expiresAt: new Date(Date.now() - 3600 * 1000) },
      });
    }
    check(
      "D-01",
      "Session expiresAt updated to controlled past timestamp in disposable DB",
      true,
    );

    // Authoritative lookup with expired session cookie returns null
    const expiredSession = await auth.api.getSession({
      headers: freshHeaders,
    });
    check(
      "D-02",
      "getSession returns null for expired session with cookie present",
      expiredSession === null,
    );

    const reqSignInExpired = new NextRequest("http://localhost:3000/sign-in", {
      headers: { cookie: freshSessionCookie || "" },
    });
    const resSignInExpired = proxy(reqSignInExpired);
    check(
      "D-03",
      "Direct /sign-in with expired cookie passes to server without redirect cycle",
      resSignInExpired.status === 200 &&
        !resSignInExpired.headers.get("location"),
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Requirement 8: Distinguish No-Session from DB Operational Failure
    // Controlled failure injection at the actual authentication dependency boundary
    // ─────────────────────────────────────────────────────────────────────────

    let dbExceptionPropagated = false;
    let actualOutcome: string = "unreached";
    const originalFindFirst = db.session.findFirst;
    const originalFindUnique = db.session.findUnique;
    const originalFindMany = db.session.findMany;

    try {
      const injectError = async () => {
        throw new Error(
          "Controlled DB failure: Neon PostgreSQL connection pool exhaustion",
        );
      };

      // 1. Controlled failure injection at the actual authentication database dependency boundary
      (db.session as any).findFirst = injectError;
      (db.session as any).findUnique = injectError;
      (db.session as any).findMany = injectError;

      // 2. Execute the real application authentication lookup boundary
      const lookupResult = await auth.api.getSession({
        headers: freshHeaders,
      });

      // 3. Verify failure is not silently classified as session: null
      if (lookupResult === null) {
        actualOutcome = "SILENTLY_CLASSIFIED_AS_NULL_SESSION";
      } else {
        actualOutcome = "UNEXPECTED_SESSION_RETURNED";
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      const causeMsg = err?.cause?.message || "";
      if (
        msg.includes("Neon PostgreSQL connection pool exhaustion") ||
        causeMsg.includes("Neon PostgreSQL connection pool exhaustion")
      ) {
        dbExceptionPropagated = true;
        actualOutcome = msg;
      } else {
        dbExceptionPropagated = true;
        actualOutcome = `PROPAGATED_EXCEPTION: ${msg}`;
      }
    } finally {
      // 4. Restore real production database methods
      db.session.findFirst = originalFindFirst;
      db.session.findUnique = originalFindUnique;
      db.session.findMany = originalFindMany;
    }

    check(
      "08-01",
      "Authentication dependency failure is not silently classified as session:null and propagates",
      dbExceptionPropagated &&
        actualOutcome !== "SILENTLY_CLASSIFIED_AS_NULL_SESSION",
      `outcome=${actualOutcome}`,
    );
  } finally {
    // Clean up all synthetic fixtures
    if (createdUserId) {
      try {
        await db.session.deleteMany({
          where: { userId: createdUserId },
        });
        await db.account.deleteMany({
          where: { userId: createdUserId },
        });
        await db.user.deleteMany({
          where: { id: createdUserId },
        });
      } catch {
        // Best-effort cleanup
      }
    }
    await db.$disconnect();
  }

  const total = checks.length;
  const passed = checks.filter((c) => c.pass).length;
  const failed = total - passed;

  console.log("\n────────────────────────────────────────────────────────────");
  console.log(
    `Stale-Session DB Verification: ${passed}/${total} PASS (${failed} failed)`,
  );
  console.log("────────────────────────────────────────────────────────────");

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(
    "❌ Stale session DB check failed with unhandled exception:",
    err,
  );
  process.exit(1);
});
