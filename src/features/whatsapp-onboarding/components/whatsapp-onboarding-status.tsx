"use client";

import {
  beginWhatsAppOnboardingAction,
  getWhatsAppOnboardingStatusAction,
} from "@/features/whatsapp-onboarding/actions/whatsapp-onboarding-actions";
import type {
  WhatsAppOnboardingCta,
  WhatsAppOnboardingView,
} from "@/features/whatsapp-onboarding/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import {
  CircleCheckIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

/**
 * WhatsApp onboarding status + CTA (WHATSAPP-ONBOARDING-01).
 *
 * Customer-facing surface: the simplified lifecycle label only — never
 * WABA ids, phone_number_id, system users, access tokens, or provider
 * error text. `/settings/whatsapp` stays the canonical connection
 * surface; this card only surfaces the state and the next action.
 */

const CTA_HREF = "/settings/whatsapp";

const CTA_LINK_LABELS: Partial<Record<WhatsAppOnboardingCta, string>> = {
  CONFIGURE: "إعداد واتساب",
  VERIFY: "تحقق من الاتصال",
  ACT: "مراجعة الإجراء المطلوب",
};

const ACTION_LABELS: Partial<Record<WhatsAppOnboardingCta, string>> = {
  BEGIN: "اربط رقم واتساب",
  RESUME: "أكمل ربط واتساب",
  RETRY: "أعد محاولة الربط",
};

const DESCRIPTIONS: Record<WhatsAppOnboardingCta, string> = {
  CONFIGURE:
    "اربط رقم واتساب الخاص بمنشأتك لاستقبال رسائل العملاء والرد عليهم تلقائياً.",
  BEGIN:
    "سيأخذك رابط آمن إلى مزوّد واتساب لتفويض الرقم — لا نُرسل أي رسالة أثناء الإعداد.",
  RESUME: "تفويض واتساب قيد الإجراء — أكمله للعودة إلى هنا.",
  VERIFY: "اكتملت هوية الرقم — تحقق من الاتصال لتشغيله.",
  ACT: "يحتاج الرقم إلى إجراء من جهتك قبل التشغيل — راجع الإعدادات.",
  RETRY: "تعذّر إكمال الربط — يمكنك المحاولة مرة أخرى.",
  DONE: "واتساب جاهز لاستقبال رسائل العملاء والرد عليها تلقائياً.",
};

export function WhatsAppOnboardingStatus({
  status,
}: {
  status: WhatsAppOnboardingView;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const actionLabel = ACTION_LABELS[status.cta];
  const linkLabel = CTA_LINK_LABELS[status.cta];

  const launch = () => {
    setError(null);
    startTransition(async () => {
      const result = await beginWhatsAppOnboardingAction();
      if (!result.success) {
        setError(result.message);
        return;
      }
      if (result.launched) {
        // A provider-owned URL: the browser leaves the app and returns
        // to our callback route with the opaque state.
        window.location.href = result.authorizationUrl;
        return;
      }
      // Already ready — the caller's status is authoritative again.
      await getWhatsAppOnboardingStatusAction();
    });
  };

  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs sm:p-6">
      <div className="flex items-start gap-3">
        <span
          className={
            status.operationallyConnected
              ? "text-success"
              : status.cta === "DONE"
                ? "text-success"
                : "text-muted-foreground"
          }
        >
          {status.operationallyConnected ? (
            <CircleCheckIcon aria-hidden className="size-5 shrink-0" />
          ) : (
            <MessageCircleIcon aria-hidden className="size-5 shrink-0" />
          )}
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="text-base font-semibold tracking-tight">
            واتساب — {status.statusLabel}
          </h2>
          <p className="text-muted-foreground text-sm leading-6">
            {DESCRIPTIONS[status.cta]}
          </p>
          {status.reasonSummary && status.cta !== "DONE" ? (
            <p className="text-muted-foreground text-xs leading-5">
              {status.reasonSummary}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap">
        {actionLabel ? (
          <Button
            type="button"
            disabled={isPending}
            onClick={launch}
            variant={
              status.cta === "RESUME" || status.cta === "RETRY"
                ? "secondary"
                : "default"
            }
          >
            {isPending ? (
              <LoaderCircleIcon aria-hidden className="animate-spin" />
            ) : null}
            {actionLabel}
          </Button>
        ) : null}
        {linkLabel ? (
          <Button type="button" variant="ghost" asChild>
            <Link href={CTA_HREF} prefetch={false}>
              {linkLabel}
            </Link>
          </Button>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive" className="mt-4">
          <TriangleAlertIcon aria-hidden className="size-4" />
          <AlertTitle>تعذر بدء الربط</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
