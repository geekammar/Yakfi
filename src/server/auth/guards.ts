/**
 * Server-side auth guards — the second (authoritative) protection tier.
 *
 * Use in layouts/pages:  requireUser / requireRole (redirect on failure).
 * Use in API handlers:   requireApiUser (returns a typed result union so the
 *                        route can send proper 401/403 JSON responses).
 * Server actions may use either; redirect() works inside actions too.
 */

import type { Session } from "@/lib/auth";
import { auth } from "@/lib/auth";
import type { UserRole } from "@/types/domain";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { cache } from "react";

/** Per-request cached session lookup. */
export const getSession = cache(async (): Promise<Session | null> => {
  const requestHeaders = await headers();
  return auth.api.getSession({ headers: requestHeaders });
});

async function loadActiveSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  // Platform/business separation (PROMPT-OPS-05): business guards never
  // admit the Platform Operator — it is redirected to its own control
  // surface instead of the business app.
  if (isPlatformOperator(session.user)) redirect("/platform");
  if (!session.user.isActive) {
    await signOutQuietly();
    redirect("/access-denied");
  }
  return session;
}

/**
 * Platform Operator check (DECISIONS #22, PROMPT-ARCH-02): the explicit
 * platform-level authorization marker on the persisted user — the ONLY
 * source of platform access. Never `businessId = null`, never a client
 * input, never a Business role.
 */
export function isPlatformOperator(user: {
  accountType?: string | null;
}): boolean {
  return user.accountType === "PLATFORM";
}

/** Any authenticated, active BUSINESS user. Protects the `(app)` area. */
export async function requireUser(): Promise<Session> {
  return loadActiveSession();
}

/**
 * Role-restricted area guard. `(admin)` → ADMIN, `(staff)` → STAFF.
 * Business roles are for BUSINESS users: a Platform Operator is not a
 * Business User (DECISIONS #22) and is refused here — operator
 * privileges are never reachable through a Business role area.
 */
export async function requireRole(role: UserRole): Promise<Session> {
  const session = await loadActiveSession();
  if (isPlatformOperator(session.user) || session.user.role !== role) {
    redirect("/access-denied");
  }
  return session;
}

/**
 * Platform Operator guard (PROMPT-ARCH-02 foundation; the control
 * surface is live since PROMPT-OPS-05). Loads the session WITHOUT the
 * business guards' operator redirect (an operator must never be pushed
 * away from /platform), then admits PLATFORM accounts only.
 */
export async function requirePlatformOperator(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  if (!session.user.isActive) redirect("/access-denied");
  if (!isPlatformOperator(session.user)) redirect("/access-denied");
  return session;
}

export type ApiGuardResult =
  { ok: true; session: Session } | { ok: false; response: NextResponse };

/** API-route/server-action variant: returns JSON errors instead of redirecting. */
export async function requireApiUser(options?: {
  role?: UserRole;
}): Promise<ApiGuardResult> {
  const session = await getSession();

  if (!session) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error: { code: "UNAUTHENTICATED", message: "يجب تسجيل الدخول" },
        },
        { status: 401 },
      ),
    };
  }

  if (!session.user.isActive) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          success: false,
          error: { code: "ACCOUNT_DISABLED", message: "الحساب معطل" },
        },
        { status: 403 },
      ),
    };
  }

  if (options?.role) {
    // Business roles apply to BUSINESS users only — a Platform Operator
    // is not a Business User and never obtains Business-role privileges.
    if (
      isPlatformOperator(session.user) ||
      session.user.role !== options.role
    ) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            success: false,
            error: { code: "FORBIDDEN", message: "لا تملك صلاحية الوصول" },
          },
          { status: 403 },
        ),
      };
    }
  }

  return { ok: true, session };
}

async function signOutQuietly(): Promise<void> {
  try {
    await auth.api.signOut({ headers: await headers() });
  } catch {
    // best-effort; the redirect below is what matters
  }
}
