"use client";

import { cancelFollowUpRequest } from "@/features/appointments/actions/follow-up-actions";
import { formatArabicDate } from "@/features/appointments/components/smart-create/date-format";
import { Button } from "@/components/ui/button";
import type { FollowUpRequestWithRelations } from "@/types/domain";

import {
  CalendarDaysIcon,
  CalendarPlusIcon,
  CheckCircle2Icon,
  CircleXIcon,
  ClockIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

export function FollowUpList({
  followUps,
  onRefresh,
}: {
  followUps: FollowUpRequestWithRelations[];
  onRefresh?: () => void;
}) {
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!followUps || followUps.length === 0) {
    return null;
  }

  function handleCancel(id: string) {
    setError(null);
    setCancellingId(id);
    startTransition(async () => {
      const res = await cancelFollowUpRequest({ id });
      setCancellingId(null);
      if (!res.success) {
        setError(res.message);
      } else {
        onRefresh?.();
      }
    });
  }

  return (
    <section className="rounded-xl border bg-card p-4 sm:p-5 shadow-xs space-y-4">
      <div className="flex items-center justify-between border-b pb-3">
        <div className="flex items-center gap-2 font-semibold text-base sm:text-lg">
          <CalendarDaysIcon className="size-5 text-primary" />
          <h2>المتابعات المرتبطة ({followUps.length})</h2>
        </div>
        <span className="text-xs text-muted-foreground">
          طلبات المتابعة المسجلة للمريض
        </span>
      </div>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="divide-y divide-border/60">
        {followUps.map((item) => {
          const isPendingStatus = item.status === "PENDING";
          const isScheduled = item.status === "SCHEDULED";

          const hasRange = !!item.startDate && !!item.endDate;
          const startStr = item.startDate
            ? typeof item.startDate === "string"
              ? item.startDate
              : item.startDate.toISOString().slice(0, 10)
            : null;
          const endStr = item.endDate
            ? typeof item.endDate === "string"
              ? item.endDate
              : item.endDate.toISOString().slice(0, 10)
            : null;

          return (
            <div
              key={item.id}
              className="py-3.5 first:pt-0 last:pb-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {item.customer.name}
                  </span>
                  {item.service ? (
                    <span className="text-xs bg-muted px-2 py-0.5 rounded-md text-muted-foreground">
                      {item.service.name}
                    </span>
                  ) : null}

                  {/* Status Badge */}
                  {isPendingStatus ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2.5 py-0.5 text-xs font-semibold">
                      <ClockIcon className="size-3" />
                      بانتظار تحديد موعد
                    </span>
                  ) : isScheduled ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-2.5 py-0.5 text-xs font-semibold">
                      <CheckCircle2Icon className="size-3" />
                      تم تحديد الموعد
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted text-muted-foreground px-2.5 py-0.5 text-xs font-medium">
                      <CircleXIcon className="size-3" />
                      ملغاة
                    </span>
                  )}
                </div>

                <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                  <div>
                    <span className="font-medium">الفترة:</span>{" "}
                    {hasRange && startStr && endStr
                      ? `من ${formatArabicDate(startStr)} إلى ${formatArabicDate(endStr)}`
                      : "دون تاريخ محدد"}
                  </div>
                  {item.preferredProvider ? (
                    <div>
                      <span className="font-medium">المزود:</span>{" "}
                      {item.preferredProvider.displayName ||
                        item.preferredProvider.name}
                    </div>
                  ) : null}
                  {item.notes ? (
                    <div>
                      <span className="font-medium">ملاحظات:</span> {item.notes}
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center gap-2 self-start sm:self-center shrink-0">
                {isPendingStatus ? (
                  <>
                    <Button asChild size="sm" className="gap-1.5 h-9">
                      <Link
                        href={`/appointments/new?customerId=${item.customerId}&followUpId=${item.id}${item.serviceId ? `&serviceId=${item.serviceId}` : ""}${item.preferredProviderId ? `&providerId=${item.preferredProviderId}` : ""}`}
                      >
                        <CalendarPlusIcon className="size-3.5" />
                        اختيار موعد
                      </Link>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleCancel(item.id)}
                      disabled={isPending && cancellingId === item.id}
                      className="text-xs text-destructive hover:bg-destructive/10 h-9"
                    >
                      {isPending && cancellingId === item.id ? (
                        <LoaderCircleIcon className="size-3.5 animate-spin" />
                      ) : (
                        "إلغاء المتابعة"
                      )}
                    </Button>
                  </>
                ) : isScheduled && item.scheduledAppointmentId ? (
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="gap-1.5 h-9"
                  >
                    <Link href={`/appointments/${item.scheduledAppointmentId}`}>
                      <ExternalLinkIcon className="size-3.5" />
                      عرض الموعد المحدد
                    </Link>
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
