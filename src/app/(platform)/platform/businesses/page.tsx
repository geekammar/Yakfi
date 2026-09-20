import { platformListBusinessInputSchema } from "@/features/platform/schemas/platform-schema";
import { listBusinessOnboardingOverviews } from "@/features/platform/server/business-onboarding-service";
import type { BusinessOnboardingListItem } from "@/features/platform/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformOperator } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

import { Building2Icon, CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "المنصة — المنشآت",
};

const STATE_LABELS: Record<string, string> = {
  NOT_STARTED: "غير مبدوء",
  AUTHORIZING: "جاري الربط",
  PROVISIONING: "جاري التجهيز",
  ACTION_REQUIRED: "يحتاج إجراء",
  READY: "جاهز",
  FAILED: "تعذّر الإكمال",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "مُهيأ — لم يُتحقق",
  CONNECTED: "موصول",
  DISCONNECTED: "غير موصول",
};

/**
 * Platform Business list (WHATSAPP-ONBOARDING-01) — the operator's
 * read-only directory of Businesses and their WhatsApp onboarding
 * state. Platform Operator only; every target is server-derived; the
 * rows are projected, never spread, into the UI.
 */
export default async function PlatformBusinessesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await requirePlatformOperator();
  const user = await userRepository.findById(session.user.id);
  const actor = {
    userId: user?.id ?? session.user.id,
    accountType: user?.accountType ?? "BUSINESS",
  };

  const params = await searchParams;
  const parsed = platformListBusinessInputSchema.safeParse({
    search: typeof params.search === "string" ? params.search : undefined,
    page: typeof params.page === "string" ? params.page : undefined,
  });
  const result = await listBusinessOnboardingOverviews(
    actor,
    parsed.success ? parsed.data : {},
  );

  const search = parsed.success ? (parsed.data.search ?? "") : "";

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="المنشآت"
        description="دليل قراءة فقط لمنشآات النظام وحالة ربط واتساب لكل منها."
      />

      <form className="flex gap-2" action="/platform/businesses" method="get">
        <input
          name="search"
          defaultValue={search}
          placeholder="ابحث بالاسم أو رقم واتساب"
          className="bg-card h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm"
          aria-label="بحث عن منشأة"
        />
        <button
          type="submit"
          className="bg-primary text-primary-foreground h-10 shrink-0 rounded-lg px-4 text-sm font-medium"
        >
          بحث
        </button>
      </form>

      <BusinessList result={result} search={search} />
    </div>
  );
}

function BusinessList({
  result,
  search,
}: {
  result: Awaited<ReturnType<typeof listBusinessOnboardingOverviews>>;
  search: string;
}) {
  if (!result.success) {
    return (
      <EmptyState
        className="bg-card min-h-72"
        icon={CircleAlertIcon}
        title="تعذر تحميل المنشآت"
        description={result.error.message}
        action={
          <Link
            href="/platform/businesses"
            prefetch={false}
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            إعادة المحاولة
          </Link>
        }
      />
    );
  }

  const { items, total, page, pageSize } = result.data;
  if (items.length === 0) {
    return (
      <EmptyState
        className="bg-card min-h-72"
        icon={Building2Icon}
        title="لا توجد منشآت"
        description="لم يُعثر على منشآات تطابق البحث الحالي."
      />
    );
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {total} منشأة — صفحة {page} من {pages}
      </p>
      <ul className="space-y-2">
        {items.map((item) => (
          <BusinessRow key={item.business.businessId} item={item} />
        ))}
      </ul>
      <Pagination page={page} pages={pages} search={search} />
    </div>
  );
}

function BusinessRow({ item }: { item: BusinessOnboardingListItem }) {
  return (
    <li className="bg-card flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <Link
        href={`/platform/businesses/${item.business.businessId}`}
        prefetch={false}
        className="min-w-0 flex-1 hover:underline"
      >
        <p className="truncate font-medium">{item.business.displayName}</p>
        <p className="text-muted-foreground text-xs">
          {item.business.adminName ?? "—"} ·{" "}
          <span dir="ltr">{item.business.adminEmail ?? "—"}</span>
        </p>
      </Link>
      <div className="flex items-center gap-3 text-xs">
        <span className="text-muted-foreground">
          {item.connectionExists
            ? (STATUS_LABELS[item.operationalStatus ?? ""] ??
              item.operationalStatus)
            : "لا يوجد اتصال"}
        </span>
        <span
          className={
            item.onboardingState === "READY"
              ? "text-success font-medium"
              : item.onboardingState === "FAILED" ||
                  item.onboardingState === "ACTION_REQUIRED"
                ? "text-warning font-medium"
                : "text-muted-foreground"
          }
        >
          {STATE_LABELS[item.onboardingState] ?? item.onboardingState}
        </span>
      </div>
    </li>
  );
}

function Pagination({
  page,
  pages,
  search,
}: {
  page: number;
  pages: number;
  search: string;
}) {
  if (pages <= 1) return null;
  const query = search ? `&search=${encodeURIComponent(search)}` : "";
  return (
    <div className="flex items-center justify-center gap-4 pt-2 text-sm">
      {page > 1 ? (
        <Link
          href={`/platform/businesses?page=${page - 1}${query}`}
          prefetch={false}
          className="text-primary underline-offset-4 hover:underline"
        >
          السابقة
        </Link>
      ) : null}
      <span className="text-muted-foreground">
        {page} / {pages}
      </span>
      {page < pages ? (
        <Link
          href={`/platform/businesses?page=${page + 1}${query}`}
          prefetch={false}
          className="text-primary underline-offset-4 hover:underline"
        >
          التالية
        </Link>
      ) : null}
    </div>
  );
}
