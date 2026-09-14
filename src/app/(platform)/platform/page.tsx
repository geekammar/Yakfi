import { getAiPolicy } from "@/features/platform/server/ai-policy-service";
import { listOwnerInvitations } from "@/features/platform/server/owner-invitation-service";
import { AI_PROVIDER_LABELS } from "@/features/platform/server/provider-labels";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformOperator } from "@/server/auth/guards";

import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "المنصة — نظرة عامة",
};

/**
 * Platform overview (PROMPT-OPS-05) — the smallest Platform Operator
 * control surface: the current AI provider policy and the state of
 * owner invitations. No analytics, no vanity widgets.
 */
export default async function PlatformPage() {
  await requirePlatformOperator();

  const [policyResult, invitationsResult] = await Promise.all([
    getAiPolicy(),
    listOwnerInvitations(),
  ]);

  const openInvitations = invitationsResult.success
    ? invitationsResult.data.items.filter(
        (item) => item.status === "PENDING" || item.status === "ACCEPTED",
      )
    : [];

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="منصة FlowPilot"
        description="لوحة تحكم مشغل المنصة — الدعوات وسياسة مزود الذكاء الاصطناعي."
      />

      <section className="space-y-3">
        <h2 className="text-base font-semibold">سياسة الذكاء الاصطناعي</h2>
        {policyResult.success ? (
          <div className="bg-card rounded-xl border p-5">
            <dl className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">المزود الأساسي</dt>
                <dd className="font-medium">
                  {providerLabel(policyResult.data.policy.primaryProvider)}
                  <span
                    dir="ltr"
                    className="text-muted-foreground ms-2 font-mono text-xs"
                  >
                    {policyResult.data.policy.primaryModel}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">المزود الاحتياطي</dt>
                <dd className="font-medium">
                  {policyResult.data.policy.secondaryProvider
                    ? providerLabel(policyResult.data.policy.secondaryProvider)
                    : "بدون"}
                  {policyResult.data.policy.secondaryModel ? (
                    <span
                      dir="ltr"
                      className="text-muted-foreground ms-2 font-mono text-xs"
                    >
                      {policyResult.data.policy.secondaryModel}
                    </span>
                  ) : null}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">التراجع للاحتياطي</dt>
                <dd>
                  {policyResult.data.policy.fallbackEnabled ? "مفعّل" : "معطّل"}
                </dd>
              </div>
            </dl>
            <Link
              href="/platform/ai-policy"
              prefetch={false}
              className="text-primary mt-4 inline-block text-sm underline-offset-4 hover:underline"
            >
              تعديل السياسة
            </Link>
          </div>
        ) : (
          <EmptyState
            className="bg-card"
            icon={CircleAlertIcon}
            title="تعذر تحميل السياسة"
            description={policyResult.error.message}
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">دعوات الملاك</h2>
        <div className="bg-card rounded-xl border p-5 text-sm">
          <p>
            الدعوات الفعالة:{" "}
            <span className="font-medium">{openInvitations.length}</span>
          </p>
          <Link
            href="/platform/invitations"
            prefetch={false}
            className="text-primary mt-4 inline-block underline-offset-4 hover:underline"
          >
            إدارة الدعوات
          </Link>
        </div>
      </section>
    </div>
  );
}

function providerLabel(provider: string): string {
  return (
    AI_PROVIDER_LABELS[provider as keyof typeof AI_PROVIDER_LABELS] ?? provider
  );
}
