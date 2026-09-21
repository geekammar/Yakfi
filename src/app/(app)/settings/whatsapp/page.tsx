import { WhatsAppConnectionScreen } from "@/features/whatsapp-connection/components/whatsapp-connection-screen";
import {
  defaultWhatsAppConnectionServiceDeps,
  listConnections,
  type WhatsAppConnectionActor,
} from "@/features/whatsapp-connection/server/whatsapp-connection-service";
import type { WhatsAppConnectionView } from "@/features/whatsapp-connection/types";
import { WhatsAppOnboardingStatus } from "@/features/whatsapp-onboarding/components/whatsapp-onboarding-status";
import { getOnboardingStatus } from "@/features/whatsapp-onboarding/server/whatsapp-onboarding-service";
import type { WhatsAppOnboardingActor } from "@/features/whatsapp-onboarding/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireRole } from "@/server/auth/guards";
import { createDefaultMetaConnectionVerifier } from "@/server/integrations/whatsapp/meta-verify";
import { whatsAppConnectionRepository } from "@/server/repositories";

import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "واتساب",
};

/**
 * WhatsApp connection onboarding — ADMIN-only (STAFF is redirected to
 * access-denied), a settings sub-route exactly like knowledge. The
 * Business is ALWAYS the actor's own, derived from the authenticated
 * session; the service layer enforces the role + tenant scoping server-
 * side on every read and write.
 *
 * MANAGED MODEL: this route composes the managed authorization launch
 * (`WhatsAppOnboardingStatus` — "Connect WhatsApp" → provider
 * authorization → server-side provisioning) with the read-only
 * connection surface (`WhatsAppConnectionScreen` — state + verify /
 * disconnect / reactivate). The customer never types a Meta identifier,
 * a token, an environment-variable name, or a webhook setting.
 */
export default async function WhatsAppConnectionPage() {
  const session = await requireRole("ADMIN");
  if (!session.user.businessId) redirect("/onboarding");

  const actor: WhatsAppConnectionActor = {
    userId: session.user.id,
    role: "ADMIN", // asserted by the guard above
    businessId: session.user.businessId,
  };

  const result = await listConnections(
    defaultWhatsAppConnectionServiceDeps(createDefaultMetaConnectionVerifier()),
    actor,
  );

  if (!("connections" in result)) {
    return (
      <div className="animate-fade-in-up space-y-6">
        <PageHeader
          title="واتساب"
          description="اربط رقم واتساب الخاص بمنشأتك لاستقبال رسائل العملاء والرد عليهم تلقائياً."
        />
        <EmptyState
          className="bg-card min-h-72"
          icon={CircleAlertIcon}
          title="تعذر تحميل اتصالات واتساب"
          description="حدث خطأ أثناء تحميل الاتصالات. حاول مرة أخرى."
          action={
            <Link
              href="/settings/whatsapp"
              prefetch={false}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              إعادة المحاولة
            </Link>
          }
        />
      </div>
    );
  }

  const connections: WhatsAppConnectionView[] = result.connections;

  // The managed lifecycle view (simplified label + the single next
  // action). Non-secret by construction; the connection surface below
  // shows the operational detail.
  const onboardingActor: WhatsAppOnboardingActor = {
    userId: actor.userId,
    role: actor.role,
    businessId: actor.businessId,
  };
  const whatsappStatus = await getOnboardingStatus(
    { connectionRepository: whatsAppConnectionRepository },
    onboardingActor,
  );

  return (
    <div className="animate-fade-in-up space-y-8">
      <PageHeader
        title="واتساب"
        description="اربط رقم واتساب الخاص بمنشأتك لاستقبال رسائل العملاء والرد عليهم تلقائياً."
      />
      <WhatsAppOnboardingStatus status={whatsappStatus} hideLinkCta />
      <WhatsAppConnectionScreen initialConnections={connections} />
    </div>
  );
}
