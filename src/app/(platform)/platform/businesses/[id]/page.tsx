import { platformBusinessIdentitySchema } from "@/features/platform/schemas/platform-schema";
import { getBusinessOnboardingOverview } from "@/features/platform/server/business-onboarding-service";
import type { BusinessOnboardingOverview } from "@/features/platform/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SectionHeader } from "@/components/shared/section-header";
import { requirePlatformOperator } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "المنصة — تفاصيل المنشأة",
};

const ONBOARDING_STATE_LABELS: Record<string, string> = {
  NOT_STARTED: "غير مبدوء",
  AUTHORIZING: "جاري الربط",
  PROVISIONING: "جاري التجهيز",
  ACTION_REQUIRED: "يحتاج إجراء",
  READY: "جاهز",
  FAILED: "تعذّر الإكمال",
};

const ACTOR_LABELS: Record<string, string> = {
  CUSTOMER: "صاحب المنشأة",
  META: "المزوّد",
  FLOWPILOT: "النظام",
  NONE: "—",
};

/**
 * Platform Business drill-down (WHATSAPP-ONBOARDING-01) — read-only
 * operational detail for ONE Business. The id from the link is
 * VALIDATED and re-resolved server-side; the operator never sees a
 * secret: the projection carries no credential reference value, and
 * every provider identity is masked.
 */
export default async function PlatformBusinessDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePlatformOperator();
  const user = await userRepository.findById(session.user.id);
  const actor = {
    userId: user?.id ?? session.user.id,
    accountType: user?.accountType ?? "BUSINESS",
  };

  const { id } = await params;
  const parsed = platformBusinessIdentitySchema.safeParse({ businessId: id });
  if (!parsed.success) notFound();

  const result = await getBusinessOnboardingOverview(
    actor,
    parsed.data.businessId,
  );
  if (!result.success) {
    if (result.error.code === "BUSINESS_NOT_FOUND") notFound();
    return (
      <div className="animate-fade-in-up space-y-6">
        <PageHeader title="تفاصيل المنشأة" />
        <EmptyState
          className="bg-card min-h-72"
          icon={CircleAlertIcon}
          title="تعذر تحميل المنشأة"
          description={result.error.message}
          action={
            <Link
              href="/platform/businesses"
              prefetch={false}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              العودة إلى القائمة
            </Link>
          }
        />
      </div>
    );
  }

  return <BusinessDetail overview={result.data.overview} />;
}

function BusinessDetail({
  overview,
}: {
  overview: BusinessOnboardingOverview;
}) {
  const { business, whatsapp, metaProvenance, onboarding, operations } =
    overview;

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title={business.displayName}
        description={`منشأة ${business.isActive ? "نشطة" : "متوقفة"} — تفاصيل تشغيلية للقراءة فقط.`}
        actions={
          <Link
            href="/platform/businesses"
            prefetch={false}
            className="text-muted-foreground text-sm underline-offset-4 hover:underline"
          >
            كل المنشآت
          </Link>
        }
      />

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <SectionHeader title="بيانات المنشأة" />
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Field label="المدير" value={business.adminName} />
          <Field label="البريد" value={business.adminEmail} ltr />
          <Field
            label="إكمال تهيئة المنشأة"
            value={
              business.onboardingCompletedAt
                ? new Date(business.onboardingCompletedAt).toLocaleString(
                    "ar-EG",
                  )
                : "غير مكتملة"
            }
          />
          <Field
            label="تاريخ الإنشاء"
            value={new Date(business.createdAt).toLocaleString("ar-EG")}
          />
        </dl>
      </section>

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <SectionHeader
          title="اتصال واتساب"
          description={
            whatsapp.connectionExists
              ? "الحالة التشغيلية للرقم."
              : "لا يوجد اتصال واتساب لهذه المنشأة بعد."
          }
        />
        {whatsapp.connectionExists ? (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            <Field label="المزوّد" value={whatsapp.provider} />
            <Field
              label="رقم العرض (مموّه)"
              value={whatsapp.displayPhoneMasked}
              ltr
            />
            <Field
              label="معرّف الرقم (مموّه)"
              value={whatsapp.externalIdMasked}
              ltr
            />
            <Field
              label="الحالة التشغيلية"
              value={whatsapp.operationalStatus}
            />
            <Field label="نشط" value={whatsapp.isActive ? "نعم" : "لا"} />
            <Field
              label="نوع مرجع بيانات الاعتماد"
              value={whatsapp.credentialKind}
            />
          </dl>
        ) : null}
      </section>

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <SectionHeader
          title="بيانات المزوّد"
          description="مراجع غير سرية يُبلغ عنها المزوّد — لا تمنح أي صلاحية."
        />
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Field
            label="معرّف عمل Meta"
            value={metaProvenance.metaBusinessId}
            ltr
          />
          <Field label="معرّف حساب واتساب" value={metaProvenance.wabaId} ltr />
          <Field
            label="رقم العرض"
            value={metaProvenance.displayPhoneNumber}
            ltr
          />
          <Field label="الاسم الموثّق" value={metaProvenance.verifiedName} />
          <Field
            label="حالة المراجعة"
            value={metaProvenance.metaReviewStatus}
          />
        </dl>
      </section>

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <SectionHeader
          title="دورة ربط واتساب"
          description="دورة منفصلة عن البوابة التشغيلية — لا تُستخدم في الإرسال أو الاستقبال."
        />
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Field
            label="الحالة"
            value={
              ONBOARDING_STATE_LABELS[onboarding.onboardingState] ??
              onboarding.onboardingState
            }
          />
          <Field
            label="آخر جهة فعلت"
            value={
              ACTOR_LABELS[onboarding.onboardingActor] ??
              onboarding.onboardingActor
            }
          />
          <Field
            label="رمز السبب"
            value={onboarding.onboardingReasonCode}
            ltr
          />
          <Field
            label="قابل لإعادة المحاولة"
            value={
              onboarding.onboardingRetryable === null
                ? "—"
                : onboarding.onboardingRetryable
                  ? "نعم"
                  : "لا"
            }
          />
          <Field
            label="وقته"
            value={
              onboarding.onboardingStateChangedAt
                ? new Date(onboarding.onboardingStateChangedAt).toLocaleString(
                    "ar-EG",
                  )
                : "—"
            }
          />
          <Field
            label="الاكتمال"
            value={
              onboarding.onboardingCompletedAt
                ? new Date(onboarding.onboardingCompletedAt).toLocaleString(
                    "ar-EG",
                  )
                : "—"
            }
          />
          <Field
            label="آخر فشل"
            value={
              onboarding.onboardingFailedAt
                ? new Date(onboarding.onboardingFailedAt).toLocaleString(
                    "ar-EG",
                  )
                : "—"
            }
          />
        </dl>
        {onboarding.onboardingReasonSummary ? (
          <p className="text-muted-foreground mt-3 border-t pt-3 text-xs leading-6">
            {onboarding.onboardingReasonSummary}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border bg-card p-5 sm:p-6">
        <SectionHeader title="العمليات" />
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Field
            label="آخر نتيجة تحقق"
            value={operations.lastVerificationResult}
          />
          <Field
            label="آخر تحقق"
            value={
              operations.lastVerificationAt
                ? new Date(operations.lastVerificationAt).toLocaleString(
                    "ar-EG",
                  )
                : "—"
            }
          />
          <Field
            label="آخر إشارة تجهيز"
            value={
              operations.lastProvisioningSignalAt
                ? new Date(operations.lastProvisioningSignalAt).toLocaleString(
                    "ar-EG",
                  )
                : "—"
            }
          />
          <Field label="مرجع العملية" value={operations.operationRef} ltr />
        </dl>
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  ltr,
}: {
  label: string;
  value: string | null | undefined;
  ltr?: boolean;
}) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`font-medium ${ltr ? "font-mono text-xs" : ""}`}
        {...(ltr ? { dir: "ltr", style: { textAlign: "start" } } : {})}
      >
        {value && value.length > 0 ? value : "—"}
      </dd>
    </div>
  );
}
