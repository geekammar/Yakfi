import { LoginForm } from "@/features/auth/components/login-form";
import { Skeleton } from "@/components/ui/skeleton";
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

export default async function SignInPage({ searchParams }: SignInPageProps) {
  // Authoritative server-side session check (ISS-017).
  // If a genuinely valid session exists, skip the sign-in form and route
  // to the intended authenticated destination or role-appropriate boundary.
  // If the session is invalid, expired, or revoked, `getSession()` returns null,
  // allowing the sign-in form to render normally even if an obsolete cookie is present.
  const session = await getSession();

  if (session) {
    if (!session.user.isActive) {
      redirect("/access-denied");
    }
    if (isPlatformOperator(session.user)) {
      redirect("/platform");
    }
    const resolved = searchParams ? await searchParams : undefined;
    const target = resolveSafeRedirect(resolved?.redirect);
    redirect(target);
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
