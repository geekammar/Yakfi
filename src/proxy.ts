import { isBlockedSignupRequest, isPublicPath } from "@/lib/public-paths";

import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * FlowPilot route protection (Next.js 16 `proxy`, successor of middleware).
 *
 * Two-tier protection model (see docs/DECISIONS.md #13):
 *  1. THIS file gates on session-cookie presence only — cheap, edge-friendly.
 *     Unauthenticated users are redirected to /sign-in before any render.
 *     Public paths (auth screens, /api/health, /api/auth, and the
 *     token-scoped invitation activation routes /invite/<token> and
 *     /owner-invite/<token>) are exempt: the invitation token itself is the
 *     credential there and its lifecycle is enforced by the invitation
 *     service, not by a session.
 *  2. Role checks (ADMIN/STAFF) and isActive validation run server-side in
 *     layout guards (`src/server/auth/guards.ts`) because sessions are
 *     DB-backed and cannot be fully verified here without a DB round-trip.
 *
 * PUBLIC SIGNUP IS CLOSED (PROMPT-OPS-05): this file also refuses public
 * POSTs to the Better Auth sign-up endpoints. Internal server-side
 * `auth.api.signUpEmail` calls (invitation activation) do not traverse
 * the proxy, so the invitation-first lifecycle stays functional.
 */

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const method = request.method;

  // Public signup closure — anonymous account creation is refused.
  if (isBlockedSignupRequest(method, pathname)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "SIGNUP_CLOSED",
          message: "التسجيل العام مغلق — إنشاء الحسابات يتم عبر الدعوات فقط",
        },
      },
      { status: 403 },
    );
  }

  const hasSessionCookie = Boolean(getSessionCookie(request));

  // Signed-in users skip the auth screens.
  if (
    hasSessionCookie &&
    (pathname === "/sign-in" || pathname === "/sign-up")
  ) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (hasSessionCookie || isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const signInUrl = new URL("/sign-in", request.url);
  signInUrl.searchParams.set("redirect", `${pathname}${search}`);
  return NextResponse.redirect(signInUrl);
}

export const config = {
  matcher: [
    // Everything except static assets and PWA files.
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|icons/|sw.js|offline.html|manifest.webmanifest|robots.txt|sitemap.xml).*)",
  ],
};
