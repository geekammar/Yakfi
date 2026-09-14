import { OwnerInviteDialog } from "@/features/platform/components/owner-invite-dialog";
import { listOwnerInvitations } from "@/features/platform/server/owner-invitation-service";
import type { PlatformInvitationListItem } from "@/features/platform/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformOperator } from "@/server/auth/guards";

import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "المنصة — دعوات الملاك",
};

const STATUS_LABELS: Record<PlatformInvitationListItem["status"], string> = {
  PENDING: "بانتظار القبول",
  ACCEPTED: "تم القبول",
  ACTIVATED: "تم التفعيل",
  EXPIRED: "منتهية",
};

/**
 * Owner invitations (PROMPT-OPS-05) — the Platform Operator's
 * invitation-first onboarding entry point: create an invitation for a
 * new Business Owner, deliver the secure link manually (one-time),
 * and track activation states. Extremely simple by design.
 */
export default async function PlatformInvitationsPage() {
  await requirePlatformOperator();

  const result = await listOwnerInvitations();

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="دعوات الملاك"
        description="أنشئ دعوة لصاحب منشأة جديد ليبدأ عبر رابط آمن للاستخدام مرة واحدة."
      />

      <OwnerInviteSection result={result} />
    </div>
  );
}

function OwnerInviteSection({
  result,
}: {
  result: Awaited<ReturnType<typeof listOwnerInvitations>>;
}) {
  if (!result.success) {
    return (
      <EmptyState
        className="bg-card min-h-72"
        icon={CircleAlertIcon}
        title="تعذر تحميل الدعوات"
        description="حدث خطأ أثناء تحميل الدعوات. حاول مرة أخرى."
        action={
          <Link
            href="/platform/invitations"
            prefetch={false}
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            إعادة المحاولة
          </Link>
        }
      />
    );
  }

  const items = result.data.items;

  return (
    <div className="space-y-4">
      <OwnerInviteDialog />

      {items.length === 0 ? (
        <EmptyState
          className="bg-card min-h-72"
          title="لا توجد دعوات بعد"
          description="أنشئ أول دعوة لصاحب منشأة ليرتفع إلى نظام FlowPilot عبر رابط آمن."
        />
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="bg-card flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {item.businessName ? `${item.businessName} — ` : ""}
                  <span dir="ltr">{item.email}</span>
                </p>
                <p className="text-muted-foreground text-xs">
                  تُنشئ في{" "}
                  {new Intl.DateTimeFormat("ar-EG", {
                    day: "numeric",
                    month: "long",
                  }).format(item.createdAt)}
                </p>
              </div>
              <span className="text-muted-foreground text-xs">
                {STATUS_LABELS[item.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
