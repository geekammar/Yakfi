import { AiPolicyForm } from "@/features/platform/components/ai-policy-form";
import { getAiPolicy } from "@/features/platform/server/ai-policy-service";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformOperator } from "@/server/auth/guards";

import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "المنصة — سياسة الذكاء",
};

/**
 * AI Provider Policy (PROMPT-OPS-05) — the platform-level LLM provider
 * configuration (primary/secondary provider + model + fallback).
 * Policy changes are DB-backed and runtime-readable — no deployment.
 * API keys are environment secrets (never shown here — only their
 * env-var reference names).
 */
export default async function PlatformAiPolicyPage() {
  await requirePlatformOperator();

  const result = await getAiPolicy();

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="سياسة الذكاء الاصطناعي"
        description="المزود الأساسي والاحتياطي ومعرفات النماذج — تُطبق فوراً دون إعادة نشر."
      />

      {result.success ? (
        <AiPolicyForm policy={result.data.policy} />
      ) : (
        <EmptyState
          className="bg-card min-h-72"
          icon={CircleAlertIcon}
          title="تعذر تحميل السياسة"
          description={result.error.message}
          action={
            <Link
              href="/platform/ai-policy"
              prefetch={false}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              إعادة المحاولة
            </Link>
          }
        />
      )}
    </div>
  );
}
