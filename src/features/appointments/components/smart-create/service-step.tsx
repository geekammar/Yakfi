"use client";

import type { BookingServiceOption } from "@/features/appointments/types";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

import { Clock3Icon, LayersIcon } from "lucide-react";
import Link from "next/link";

/**
 * Step 2 — الخدمة. Active services only (the page loads them through
 * the booking-flow service, which excludes inactive services — they
 * are not bookable). Radio-cards make the selected state obvious and
 * easy to change.
 */
export function ServiceStep({
  services,
  selectedId,
  onSelect,
  canManageServices,
}: {
  services: BookingServiceOption[];
  selectedId: string | null;
  onSelect: (serviceId: string) => void;
  /** ADMIN sees the manage-services action; STAFF gets plain guidance. */
  canManageServices: boolean;
}) {
  if (services.length === 0) {
    return (
      <EmptyState
        icon={LayersIcon}
        title="لا توجد خدمات نشطة"
        description={
          canManageServices
            ? "أضف خدمة وحدّد مدتها لتظهر هنا كخيار للحجز."
            : "اطلب من مدير المنشأة إضافة الخدمات أو تنشيطها."
        }
        action={
          canManageServices ? (
            <Button asChild size="sm" variant="outline">
              <Link href="/services">
                <LayersIcon aria-hidden className="size-4" />
                إدارة الخدمات
              </Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <fieldset>
      <legend className="sr-only">اختر الخدمة</legend>
      <RadioGroup
        value={selectedId ?? undefined}
        onValueChange={onSelect}
        className="gap-2.5"
      >
        {services.map((service) => (
          <Label
            key={service.id}
            htmlFor={`booking-service-${service.id}`}
            className="flex cursor-pointer items-center gap-3 rounded-xl border bg-card p-3.5 font-normal transition-colors hover:bg-accent/60 has-data-checked:border-primary has-data-checked:bg-primary/5"
          >
            <RadioGroupItem
              id={`booking-service-${service.id}`}
              value={service.id}
              className="mt-0"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {service.name}
              </span>
            </span>
            {service.readinessStatus === "SETUP_REQUIRED" ? (
              <span className="shrink-0 rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                تحتاج إعداد
              </span>
            ) : service.readinessStatus === "READY_TO_BOOK" ? (
              <span className="shrink-0 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                جاهزة للحجز
              </span>
            ) : null}
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3Icon aria-hidden className="size-3.5" />
              <span className="tabular-nums">{service.durationMinutes}</span>
              دقيقة
            </span>
          </Label>
        ))}
      </RadioGroup>
    </fieldset>
  );
}
