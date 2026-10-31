import { LoginForm } from "@/features/auth/components/login-form";
import { Skeleton } from "@/components/ui/skeleton";
import type { Session } from "@/lib/auth";
import { resolveSafeRedirect } from "@/lib/safe-redirect";
import { getSession, isPlatformOperator } from "@/server/auth/guards";

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "تسجيل الدخول",
};

interface SignInPageProps {
  searchParams?: Promise<{ redirect?: string | string[] }>;
}

/**
 * Authoritative destination decision at the sign-in boundary (ISS-017).
 * - Null session -> null (render sign-in form)
 * - Inactive user -> /access-denied
 * - Platform Operator -> /platform
 * - Active user -> resolved internal redirect target (or "/" default)
 */
export async function getSignInDestination(
  session: Session | null,
  searchParams?: Promise<{ redirect?: string | string[] }>,
): Promise<string | null> {
  if (!session) {
    return null;
  }
  if (!session.user.isActive) {
    return "/access-denied";
  }
  if (isPlatformOperator(session.user)) {
    return "/platform";
  }
  const resolved = searchParams ? await searchParams : undefined;
  return resolveSafeRedirect(resolved?.redirect);
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  // Authoritative server-side session check (ISS-017).
  // If a genuinely valid session exists, skip the sign-in form and route
  // to the intended authenticated destination or role-appropriate boundary.
  // If the session is invalid, expired, or revoked, `getSession()` returns null,
  // allowing the sign-in form to render normally even if an obsolete cookie is present.
  const session = await getSession();
  const destination = await getSignInDestination(session, searchParams);

  if (destination) {
    redirect(destination);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">تسجيل الدخول</h1>
        <p className="text-muted-foreground text-sm">
          أهلاً بعودتك. أدخل بياناتك للمتابعة.
        </p>
      </div>

      <Suspense fallback={<LoginFormSkeleton />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}

function LoginFormSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-full" />
      </div>
      <Skeleton className="h-6 w-24" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}
