"use client";

import {
  removeServiceAction,
  setServiceActiveAction,
} from "@/features/services/actions/service-actions";
import { ServiceFormDialog } from "@/features/services/components/service-form-dialog";
import { ServiceRemoveDialog } from "@/features/services/components/service-remove-dialog";
import type { ServiceListItem } from "@/features/services/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { SERVICE_NOUNS, arabicCount } from "@/lib/arabic";

import {
  CalendarPlusIcon,
  CheckCircleIcon,
  Clock3Icon,
  LayersIcon,
  PauseCircleIcon,
  PencilIcon,
  PlayCircleIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

/**
 * Services management screen: what the business offers, how long each
 * service takes, and its active state. One primary action (إضافة
 * خدمة), one small create/edit dialog, an explicit activate/deactivate
 * action per service, and a confirmed removal.
 *
 * The Service Catalog is canonical domain data, not a second Knowledge
 * Base: the customer-facing identity (name/description) reaches the AI
 * through the B-02 context builder under the B-01 policy, while
 * `durationMinutes` stays an operational scheduling fact the owner
 * sees here but the assistant never repeats (B-03).
 */
export function ServicesScreen({
  initialServices,
}: {
  initialServices: ServiceListItem[];
}) {
  const [services, setServices] = useState(initialServices);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceListItem | null>(null);
  const [dialogSession, setDialogSession] = useState(0);
  const [removing, setRemoving] = useState<ServiceListItem | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setError(null);
    setDialogSession((count) => count + 1);
    setDialogOpen(true);
  }

  function openEdit(service: ServiceListItem) {
    setEditing(service);
    setError(null);
    setDialogSession((count) => count + 1);
    setDialogOpen(true);
  }

  function openRemove(service: ServiceListItem) {
    setRemoving(service);
    setRemoveOpen(true);
  }

  function handleSaved(service: ServiceListItem) {
    setServices((current) => {
      const exists = current.some((item) => item.id === service.id);
      const next = exists
        ? current.map((item) => (item.id === service.id ? service : item))
        : [...current, service];
      return next.sort((a, b) => a.name.localeCompare(b.name, "ar"));
    });
    setSuccess("تم حفظ الخدمة");
  }

  function handleRemoved(service: ServiceListItem) {
    setServices((current) => current.filter((item) => item.id !== service.id));
    setRemoving(null);
    setSuccess("تم حذف الخدمة");
  }

  function toggleActive(service: ServiceListItem) {
    const nextActive = !service.isActive;
    setError(null);
    // Optimistic transition — rolled back if the server rejects it.
    setServices((current) =>
      current.map((item) =>
        item.id === service.id ? { ...item, isActive: nextActive } : item,
      ),
    );
    void setServiceActiveAction({ id: service.id, isActive: nextActive }).then(
      (result) => {
        if (!result.success) {
          setServices((current) =>
            current.map((item) =>
              item.id === service.id
                ? { ...item, isActive: service.isActive }
                : item,
            ),
          );
          setError(result.message);
        }
      },
    );
  }

  const submitRemove = () =>
    removing
      ? removeServiceAction({ id: removing.id })
      : Promise.resolve({
          success: false,
          message: "لا توجد خدمة محددة للحذف",
        } as const);

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="الخدمات"
        description="قائمة خدمات منشأتك. أسماء الخدمات هي ما يراه العملاء عند الحجز، أما مدة كل خدمة فهي معلومة تشغيلية لحساب المواعيد لا تُعرض للعملاء تلقائياً."
        actions={
          <Button onClick={openCreate}>
            <PlusIcon />
            إضافة خدمة
          </Button>
        }
      />

      {services.length > 0 ? (
        <>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {arabicCount(services.length, SERVICE_NOUNS)}
          </p>
          {success ? (
            <p
              role="status"
              className="flex items-center gap-1.5 text-sm text-success"
            >
              <CheckCircleIcon aria-hidden className="size-4" />
              {success}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <ul className="space-y-3">
            {services.map((service) => (
              <li key={service.id}>
                <article className="rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate font-semibold">
                          {service.name}
                        </h2>
                        <StatusBadge
                          status={service.isActive ? "active" : "inactive"}
                        />
                      </div>
                      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Clock3Icon aria-hidden className="size-3.5" />
                        <span className="tabular-nums">
                          {service.durationMinutes}
                        </span>{" "}
                        دقيقة
                      </p>
                      {service.description ? (
                        <p className="mt-2 line-clamp-2 text-sm leading-6 text-muted-foreground">
                          {service.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {/* B-07 §A — the service is already known context:
                       * book it directly; the flow prefills الخطوة 2
                       * and asks only for العميل والتاريخ. Inactive
                       * services are not bookable, so the action is
                       * offered for active services only. */}
                      {service.isActive ? (
                        <Button asChild variant="outline" size="sm">
                          <Link
                            href={`/appointments/new?serviceId=${service.id}`}
                          >
                            <CalendarPlusIcon aria-hidden className="size-4" />
                            حجز
                          </Link>
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openEdit(service)}
                      >
                        <PencilIcon />
                        تعديل
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => toggleActive(service)}
                      >
                        {service.isActive ? (
                          <>
                            <PauseCircleIcon />
                            إيقاف
                          </>
                        ) : (
                          <>
                            <PlayCircleIcon />
                            تنشيط
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => openRemove(service)}
                      >
                        <TrashIcon />
                        حذف
                      </Button>
                    </div>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <EmptyState
          className="bg-card min-h-72"
          icon={LayersIcon}
          title="لم تُضف أي خدمات بعد"
          description="الخدمات هي ما يحجزه عملاؤك — أضف أول خدمة باسمها ومدتها لتظهر في خيارات الحجز."
          action={
            <Button size="sm" onClick={openCreate}>
              <PlusIcon aria-hidden className="size-4" />
              إضافة خدمة
            </Button>
          }
        />
      )}

      {/* key → the dialog remounts on every open, so create starts
          blank and edit prefills the selected service. */}
      <ServiceFormDialog
        key={dialogSession}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        service={editing ?? undefined}
        onSaved={handleSaved}
      />

      <ServiceRemoveDialog
        open={removeOpen}
        onOpenChange={(open) => {
          setRemoveOpen(open);
          if (!open) setRemoving(null);
        }}
        service={removing}
        submit={submitRemove}
        onRemoved={handleRemoved}
      />
    </div>
  );
}
