import { YakfiSymbol } from "@/components/shared/yakfi-symbol";
import { APP_DESCRIPTION, APP_NAME } from "@/lib/app-config";

import Link from "next/link";

/**
 * Auth layout — centered card on a calm backdrop.
 * RTL by default; forms inside must use logical spacing utilities.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main
      id="main-content"
      className="bg-background flex min-h-dvh flex-col items-center justify-center px-4 py-10"
    >
      <div className="animate-fade-in-up w-full max-w-sm space-y-8">
        <div className="space-y-2 text-center">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight transition-colors hover:text-primary"
          >
            <YakfiSymbol className="size-6 shrink-0" aria-hidden="true" />
            <span>{APP_NAME}</span>
          </Link>
          <p className="text-muted-foreground text-sm">{APP_DESCRIPTION}</p>
        </div>
        <div className="bg-card shadow-md rounded-xl border p-6">
          {children}
        </div>
      </div>
    </main>
  );
}
