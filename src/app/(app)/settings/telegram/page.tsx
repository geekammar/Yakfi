import { TelegramConnectionScreen } from "@/features/telegram-connection/components/telegram-connection-screen";
import {
  getTelegramConnectionStatus,
  resolveManagerBotUsername,
  type TelegramConnectionActor,
} from "@/features/telegram-connection/server/telegram-connection-service";
import type { TelegramConnectionView } from "@/features/telegram-connection/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { env } from "@/lib/env";
import { requireRole } from "@/server/auth/guards";
import { defaultRuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import { defaultTelegramApiDeps } from "@/server/integrations/telegram/telegram-client";
import {
  businessRepository,
  telegramConnectionRepository,
  telegramProvisioningLedgerRepository,
} from "@/server/repositories";

import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "تيليجرام",
};

/**
 * Telegram connection settings — ADMIN-only (STAFF is redirected to
 * access-denied), a settings sub-route exactly like WhatsApp. The
 * Business is ALWAYS the actor's own, derived from the authenticated
 * session; the service layer enforces the role + tenant scoping server-
 * side on every read and write.
 *
 * MANAGED MODEL (DECISIONS #63 (B)/#66): the Admin opens a FlowPilot-minted
 * deep link → STARTs the Manager Bot → confirms the bot's creation inside
 * Telegram's own UI → the `managed_bot` event completes provisioning
 * server-side. The customer never types a token, never visits BotFather,
 * never configures a webhook, and never sees a technical identifier.
 */
export default async function TelegramConnectionPage() {
  const session = await requireRole("ADMIN");
  if (!session.user.businessId) redirect("/onboarding");

  const actor: TelegramConnectionActor = {
    userId: session.user.id,
    role: "ADMIN", // asserted by the guard above
    businessId: session.user.businessId,
  };

  const result = await getTelegramConnectionStatus(
    {
      api: defaultTelegramApiDeps,
      ledgerRepository: telegramProvisioningLedgerRepository,
      connectionRepository: telegramConnectionRepository,
      credentialStore: defaultRuntimeCredentialStore,
      businessRepository,
      getEnvVar: (name: string) => process.env[name],
      webhookBaseUrl: env.NEXT_PUBLIC_APP_URL,
      managerBotUsername: resolveManagerBotUsername(
        (name) => process.env[name],
      ),
      now: () => new Date(),
    },
    actor,
  );

  if (!result.success) {
    return (
      <div className="animate-fade-in-up space-y-6">
        <PageHeader
          title="تيليجرام"
          description="اربط بوت تيليجرام الخاص بمنشأتك لاستقبال رسائل العملاء والرد عليهم تلقائياً."
        />
        <EmptyState
          className="bg-card min-h-72"
          icon={CircleAlertIcon}
          title="تعذر تحميل حالة تيليجرام"
          description="حدث خطأ أثناء تحميل الاتصال. حاول مرة أخرى."
          action={
            <Link
              href="/settings/telegram"
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

  const view: TelegramConnectionView = result.view;

  return (
    <div className="animate-fade-in-up space-y-8">
      <PageHeader
        title="تيليجرام"
        description="اربط بوت تيليجرام الخاص بمنشأتك لاستقبال رسائل العملاء والرد عليهم تلقائياً."
      />
      <TelegramConnectionScreen initialView={view} />
    </div>
  );
}
