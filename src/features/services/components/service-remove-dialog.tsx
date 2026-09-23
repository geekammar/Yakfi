"use client";

import type {
  ServiceActionResult,
  ServiceListItem,
} from "@/features/services/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

/**
 * Remove confirmation — one small destructive action, confirmed
 * explicitly so a mis-tap on mobile never removes a service silently.
 * Removal is a soft delete: the service stops being bookable, and the
 * appointments already taken for it stay intact.
 */
export function ServiceRemoveDialog({
  open,
  onOpenChange,
  service,
  submit,
  onRemoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The service pending removal (present while the dialog is open). */
  service: ServiceListItem | null;
  /** Runs the actual server action (remove by id). */
  submit: () => Promise<ServiceActionResult>;
  onRemoved: (service: ServiceListItem) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirm() {
    if (!service) return;
    setError(null);
    setSubmitting(true);
    const result = await submit();
    setSubmitting(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    onOpenChange(false);
    onRemoved(result.service);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>حذف الخدمة</DialogTitle>
          <DialogDescription>
            هتتم إزالة «{service?.name}» من قائمة خدماتك — مش هتظهر للعملاء في
            الحجز بعد كده. المواعيد اللي اتحجزت على الخدمة دي قبل كده محفوظة زي
            ما هي.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            إلغاء
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={submitting}
          >
            {submitting ? <LoaderCircleIcon className="animate-spin" /> : null}
            حذف الخدمة
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
