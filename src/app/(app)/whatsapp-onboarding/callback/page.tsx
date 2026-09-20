import { completeWhatsAppAuthorizationAction } from "@/features/whatsapp-onboarding/actions/whatsapp-onboarding-actions";
import { WhatsAppOnboardingStatus } from "@/features/whatsapp-onboarding/components/whatsapp-onboarding-status";
import {
  ONBOARDING_STATUS_LABELS,
  getOnboardingStatus,
} from "@/features/whatsapp-onboarding/server/whatsapp-onboarding-service";
import type { WhatsAppOnboardingActor } from "@/features/whatsapp-onboarding/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireUser } from "@/server/auth/guards";
import {
  userRepository,
  whatsAppConnectionRepository,
} from "@/server/repositories";

import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "تفويض واتساب",
};

/**
 * The provider authorization callback route
 * (WHATSAPP-ONBOARDING-01). The browser returns here after the Business
 * Admin authorizes the number with the provider, carrying ONLY the
 * opaque `state` + the provider `code`.
 *
 * The target Business is resolved EXCLUSIVELY from the persisted
 * authorization attempt inside the service — NOT from this route's
 * query string and NOT from the session (the session only authenticates
 * that a Business user is present). The same use case serves the real
 * Meta redirect URI when the adapter lands; no provider concept lives
 * in this route.
 */
export default async function WhatsAppOnboardingCallbackPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  const actor: WhatsAppOnboardingActor = {
    userId: session.user.id,
    // No user record (deleted mid-session) → least privilege.
    role: user?.role ?? "STAFF",
    businessId: user?.businessId ?? null,
  };

  const params = await searchParams;
  const state = typeof params.state === "string" ? params.state : "";
  const code = typeof params.code === "string" ? params.code : "";

  const result = await completeWhatsAppAuthorizationAction({ state, code });
  const status = await getOnboardingStatus(
    { connectionRepository: whatsAppConnectionRepository },
    actor,
  );

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="تفويض واتساب"
        description="نتيجة ربط رقم واتساب الخاص بمنشأتك."
      />
      {result.success ? (
        <EmptyState
          className="bg-card min-h-56"
          icon={CircleCheckIcon}
          title={ONBOARDING_STATUS_LABELS[result.onboardingState]}
          description={result.summary}
          action={
            <Link
              href="/settings/whatsapp"
              prefetch={false}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              الذهاب إلى إعدادات واتساب
            </Link>
          }
        />
      ) : (
        <EmptyState
          className="bg-card min-h-56"
          icon={CircleAlertIcon}
          title="تعذّر إكمال الربط"
          description={result.message}
          action={
            <Link
              href="/settings/whatsapp"
              prefetch={false}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              العودة إلى إعدادات واتساب
            </Link>
          }
        />
      )}
      <WhatsAppOnboardingStatus status={status} />
    </div>
  );
}
