"use client";

import {
  disconnectWhatsAppConnectionAction,
  reactivateWhatsAppConnectionAction,
  verifyWhatsAppConnectionAction,
} from "@/features/whatsapp-connection/actions/whatsapp-connection-actions";
import type { WhatsAppConnectionView } from "@/features/whatsapp-connection/types";
import { SectionHeader } from "@/components/shared/section-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import {
  LoaderCircleIcon,
  MessageCircleIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState, useTransition } from "react";

/**
 * WhatsApp connection setup screen (Business Admin onboarding).
 *
 * MANAGED MODEL (WHATSAPP-ONBOARDING-01): the provider identity
 * (`phone_number_id`) and the credential reference are provisioned
 * SERVER-SIDE by the authorization callback. The customer never types a
 * Meta technical identifier, an access token, an environment-variable
 * name, or a webhook setting — FlowPilot derives everything from the
 * provider authorization.
 *
 * This surface is therefore READ-ONLY + operational actions: it shows
 * the connection state (provider, display number, MASKED provider
 * connection id, status, last change time) and the lifecycle actions
 * (verify / disconnect / reactivate). The managed launch ("Connect
 * WhatsApp") is composed at the ROUTE layer
 * (`WhatsAppOnboardingStatus`), keeping the feature boundary intact.
 *
 * Page chrome (the `PageHeader`) is owned by the route, not here: the
 * card is composable alongside the managed lifecycle view.
 */
type ConnectionState =
  | { kind: "none" }
  | { kind: "configured"; connection: WhatsAppConnectionView }
  | { kind: "verified"; connection: WhatsAppConnectionView }
  | { kind: "disconnected"; connection: WhatsAppConnectionView };

function stateOf(connection: WhatsAppConnectionView): ConnectionState {
  if (!connection.isActive || connection.status === "DISCONNECTED")
    return { kind: "disconnected", connection };
  if (connection.status === "CONNECTED")
    return { kind: "verified", connection };
  return { kind: "configured", connection };
}

const VERIFICATION_LABELS: Record<string, string> = {
  INVALID_CREDENTIALS: "بيانات اعتماد واتساب غير صالحة أو منتهية",
  INVALID_CONNECTION: "اتصال واتساب غير صالح أو غير مملوك لهذه المنشأة",
  UNREACHABLE: "تعذر الوصول إلى خدمة واتساب حالياً",
};

export function WhatsAppConnectionScreen({
  initialConnections,
}: {
  initialConnections: WhatsAppConnectionView[];
}) {
  const [connections] = useState(initialConnections);
  const primary = connections[0];
  const state = primary
    ? stateOf(primary)
    : ({ kind: "none" } as ConnectionState);

  return (
    <div className="space-y-8">
      <ConnectionStateCard state={state} />
    </div>
  );
}

function ConnectionStateCard({ state }: { state: ConnectionState }) {
  if (state.kind === "none") {
    return (
      <section className="rounded-xl border bg-card p-5 shadow-xs sm:p-6">
        <SectionHeader
          title="حالة الاتصال"
          description="لم يُربط أي رقم واتساب بهذه المنشأة بعد."
        />
        <div className="flex items-center gap-3 rounded-lg border border-dashed p-4">
          <MessageCircleIcon
            aria-hidden
            className="size-5 shrink-0 text-muted-foreground"
          />
          <p className="text-sm leading-6 text-muted-foreground">
            ابدأ ربط رقمك من خلال زر «اربط رقم واتساب» — يتولّى النظام تهيئة
            هوية الرقم وبيانات الاعتماد تلقائياً. لا يُرسل أي شيء للعملاء أثناء
            الإعداد أو التحقق.
          </p>
        </div>
      </section>
    );
  }

  const { connection } = state;
  const badge =
    state.kind === "verified"
      ? { label: "متصل ومُتحقق منه", className: "text-success" }
      : state.kind === "configured"
        ? { label: "مُهيأ — لم يُتحقق منه", className: "text-warning" }
        : { label: "غير موصول", className: "text-muted-foreground" };
  const lastChanged = new Date(connection.updatedAt).toLocaleString("ar-EG", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs sm:p-6">
      <SectionHeader title="حالة الاتصال" description={badge.label} />
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">مزوّد الخدمة</dt>
          <dd className="font-medium">{connection.provider ?? "—"}</dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">رقم العرض</dt>
          <dd className="font-medium" dir="ltr" style={{ textAlign: "start" }}>
            {connection.phoneNumber}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">
            معرّف الرقم (phone_number_id)
          </dt>
          <dd className="font-mono text-xs" dir="ltr">
            {connection.externalIdMasked ?? "—"}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="text-xs text-muted-foreground">آخر تغيير</dt>
          <dd className="font-medium">{lastChanged}</dd>
        </div>
      </dl>
      {state.kind === "configured" ? (
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          الاتصال مُهيأ لكنه لم يُتحقق منه بعد — اضغط «تحقق من الاتصال» لتشغيله.
        </p>
      ) : null}
      <ConnectionActions connection={connection} state={state} />
    </section>
  );
}

function ConnectionActions({
  connection,
  state,
}: {
  connection: WhatsAppConnectionView;
  state: ConnectionState;
}) {
  const [isPending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<string | null>(null);

  const run =
    (
      action: (
        id: string,
      ) => Promise<
        | { success: true }
        | { success: false; message: string; verificationCode?: string }
      >,
    ) =>
    () => {
      setOutcome(null);
      startTransition(async () => {
        const result = await action(connection.id);
        if (!result.success) {
          setOutcome(
            VERIFICATION_LABELS[result.verificationCode ?? ""] ??
              result.message,
          );
        }
        // success → revalidatePath reloads fresh server data
      });
    };

  return (
    <div className="mt-5 space-y-3 border-t pt-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {state.kind !== "disconnected" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={isPending}
            onClick={run(verifyWhatsAppConnectionAction)}
          >
            {isPending ? (
              <LoaderCircleIcon aria-hidden className="animate-spin" />
            ) : (
              <ShieldAlertIcon aria-hidden />
            )}
            تحقق من الاتصال
          </Button>
        ) : null}
        {state.kind === "verified" ? (
          <Button
            type="button"
            variant="ghost"
            disabled={isPending}
            onClick={run(disconnectWhatsAppConnectionAction)}
          >
            إلغاء التفعيل
          </Button>
        ) : null}
        {state.kind === "disconnected" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={isPending}
            onClick={run(reactivateWhatsAppConnectionAction)}
          >
            إعادة التفعيل
          </Button>
        ) : null}
      </div>
      {outcome ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden className="size-4" />
          <AlertTitle>تعذر التحقق من الاتصال</AlertTitle>
          <AlertDescription>{outcome}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
