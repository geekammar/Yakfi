"use client";

import { YakfiBrandText } from "@/components/shared/yakfi-brand-text";
import { YakfiSymbol } from "@/components/shared/yakfi-symbol";
import { cn } from "@/lib/utils";

import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const STEPS = [
  { href: "/onboarding/business", label: "بيانات المنشأة" },
  { href: "/onboarding/hours", label: "ساعات العمل" },
  { href: "/onboarding/booking", label: "إعدادات الحجز" },
  { href: "/onboarding/review", label: "المراجعة والتشغيل" },
] as const;

export function OnboardingShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const currentIndex = Math.max(
    0,
    STEPS.findIndex((step) => step.href === pathname),
  );
  const progress = ((currentIndex + 1) / STEPS.length) * 100;

  return (
    <div className="min-h-dvh bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-4xl items-center px-4 sm:px-6">
          <Link
            href="/onboarding"
            className="flex items-center gap-2 text-sm font-semibold tracking-tight transition-colors hover:text-primary"
          >
            <YakfiSymbol className="size-6 shrink-0" aria-hidden="true" />
            <YakfiBrandText />
          </Link>
          <span className="ms-auto text-xs text-muted-foreground">
            الخطوة {currentIndex + 1} من {STEPS.length}
            <span className="hidden sm:inline"> — إعداد منشأتك</span>
          </span>
        </div>
        <div
          className="h-1 bg-muted"
          role="progressbar"
          aria-label="تقدم إعداد الحساب"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={currentIndex + 1}
        >
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
      </header>

      <nav aria-label="خطوات الإعداد" className="border-b bg-card">
        <ol className="mx-auto grid max-w-4xl grid-cols-4 px-2 sm:px-6">
          {STEPS.map((step, index) => {
            const complete = index < currentIndex;
            const current = index === currentIndex;
            const content = (
              <>
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums",
                    current &&
                      "border-primary bg-primary text-primary-foreground",
                    complete &&
                      "border-success bg-success text-success-foreground",
                  )}
                >
                  {complete ? <CheckIcon className="size-3" /> : index + 1}
                </span>
                <span className="hidden truncate sm:inline">{step.label}</span>
              </>
            );
            const className = cn(
              "flex h-12 w-full items-center justify-center gap-1.5 border-b-2 border-transparent px-1 text-xs text-muted-foreground",
              current && "border-primary font-medium text-foreground",
              complete && "text-foreground hover:text-primary",
            );
            return (
              <li key={step.href} className="min-w-0">
                {complete ? (
                  <Link
                    href={step.href}
                    className={className}
                    aria-label={`العودة إلى خطوة: ${step.label}`}
                  >
                    {content}
                  </Link>
                ) : (
                  <div
                    aria-current={current ? "step" : undefined}
                    className={className}
                  >
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <main
        id="main-content"
        className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12"
      >
        {children}
      </main>
    </div>
  );
}
