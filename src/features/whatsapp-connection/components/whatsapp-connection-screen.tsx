"use client";

import {
  disconnectWhatsAppConnectionAction,
  reactivateWhatsAppConnectionAction,
  saveWhatsAppConnectionAction,
  verifyWhatsAppConnectionAction,
} from "@/features/whatsapp-connection/actions/whatsapp-connection-actions";
import {
  saveWhatsAppConnectionSchema,
  type SaveWhatsAppConnectionInput,
} from "@/features/whatsapp-connection/schemas/whatsapp-connection-schema";
import type { WhatsAppConnectionView } from "@/features/whatsapp-connection/types";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  CircleCheckIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

/**
 * WhatsApp connection setup screen (Business Admin onboarding).
 *
 * Shows the clear lifecycle states (not connected / configured /
 * verified / disconnected) and NEVER displays a secret: only the
 * provider, the display number, the MASKED provider connection id
 * (phone_number_id), the status, and the last change time are shown.
 * The `credentialsRef` field accepts an environment-variable NAME
 * only — the raw access token is stored by the operator in the
 * deployment environment and never enters the database.
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
    <div className="animate-fade-in-up space-y-8">
      <PageHeader
        title="واتساب"
        description="اربط رقم واتساب الخاص بمنشأتك لاستقبال رسائل العملاء والرد عليهم تلقائياً."
      />

      <ConnectionStateCard state={state} />

      <ConnectionForm initial={primary} />

      <OperatorNote />
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
            املأ البيانات بالأسفل لربط رقمك. لا يُرسل أي شيء للعملاء أثناء
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

function ConnectionForm({ initial }: { initial?: WhatsAppConnectionView }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<SaveWhatsAppConnectionInput>({
    resolver: zodResolver(saveWhatsAppConnectionSchema),
    defaultValues: {
      connectionId: initial?.id,
      displayName: initial?.displayName ?? "",
      phoneNumber: initial?.phoneNumber ?? "",
      externalId: initial?.externalId ?? "",
      // The reference is shown only when already persisted — never
      // echoed back typed secrets.
      credentialsRef: "",
    },
    mode: "onChange",
  });

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    setSaved(false);
    setIsSubmitting(true);
    const result = await saveWhatsAppConnectionAction(data);
    setIsSubmitting(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setSaved(true);
  });

  const fieldError = (message?: string) =>
    message ? (
      <p className="text-xs text-destructive" role="alert">
        {message}
      </p>
    ) : null;

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <section
        aria-labelledby="whatsapp-connection-section"
        className="rounded-xl border bg-card p-5 shadow-xs sm:p-6"
      >
        <SectionHeader
          title={initial ? "تعديل بيانات الاتصال" : "ربط رقم واتساب"}
          description="الهوية المعتمدة للاتصال هي معرّف الرقم (phone_number_id) — رقم العرض مجرد عنوان."
        />
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="whatsapp-display-name">اسم توضيحي للاتصال</Label>
            <Input
              id="whatsapp-display-name"
              placeholder="مثال: رقم الاستقبال"
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.displayName)}
              {...form.register("displayName")}
            />
            {fieldError(form.formState.errors.displayName?.message)}
          </div>

          <div className="space-y-2">
            <Label htmlFor="whatsapp-phone">رقم العرض</Label>
            <Input
              id="whatsapp-phone"
              type="tel"
              dir="ltr"
              autoComplete="tel"
              className="text-start"
              placeholder="+201000000000"
              aria-invalid={Boolean(form.formState.errors.phoneNumber)}
              {...form.register("phoneNumber")}
            />
            {fieldError(form.formState.errors.phoneNumber?.message)}
          </div>

          <div className="space-y-2">
            <Label htmlFor="whatsapp-external-id">
              معرّف الرقم (phone_number_id)
            </Label>
            <Input
              id="whatsapp-external-id"
              dir="ltr"
              className="text-start font-mono text-sm"
              placeholder="1286861067846638"
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.externalId)}
              {...form.register("externalId")}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              تجده في لوحة تحكم واتساب (Meta) ضمن بيانات الرقم. هذا هو المعرّف
              المعتمد للاتصال.
            </p>
            {fieldError(form.formState.errors.externalId?.message)}
          </div>

          <div className="space-y-2">
            <Label htmlFor="whatsapp-credentials-ref">
              اسم متغيّر البيئة السري
            </Label>
            <Input
              id="whatsapp-credentials-ref"
              dir="ltr"
              className="text-start font-mono text-sm"
              placeholder="WHATSAPP_META_ACCESS_TOKEN"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={Boolean(form.formState.errors.credentialsRef)}
              {...form.register("credentialsRef")}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              اسم متغيّر البيئة الذي يخزّن رمز الوصول — وليس الرمز نفسه. يضيفه
              مشغّل النظام في بيئة التشغيل.
            </p>
            {fieldError(form.formState.errors.credentialsRef?.message)}
          </div>
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p
          role="status"
          className="flex items-center gap-1.5 text-sm text-success"
        >
          <CircleCheckIcon aria-hidden className="size-4" />
          تم حفظ بيانات الاتصال — تحقق منه لتشغيله.
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          لا تُحفظ رموز الوصول في قاعدة البيانات — تُخزّن كمتغيّرات بيئة سرّية.
        </p>
        <Button type="submit" size="lg" disabled={isSubmitting}>
          {isSubmitting ? (
            <LoaderCircleIcon aria-hidden className="animate-spin" />
          ) : null}
          حفظ بيانات الاتصال
        </Button>
      </div>
    </form>
  );
}

function OperatorNote() {
  return (
    <section className="rounded-xl border bg-muted/30 p-5 text-sm leading-7 sm:p-6">
      <h2 className="mb-2 font-semibold">متطلّبات من مشغّل النظام</h2>
      <ul className="list-inside list-disc space-y-1.5 text-muted-foreground">
        <li>
          تطبيق Meta مُفعّل مع منتج واتساب وحساب عمل (WhatsApp Business
          Account).
        </li>
        <li>رقم مُسجّل ومُتحقق منه، مع رمز وصول دائم بصلاحية المراسلة.</li>
        <li>
          رمز الوصول مخزّن في بيئة التشغيل تحت اسم متغيّر البيئة المُدخل أعلاه.
        </li>
        <li>
          ربط الويبهوك (Webhook) مع رمز التحقق وسر التطبيق في بيئة التشغيل.
        </li>
      </ul>
    </section>
  );
}
