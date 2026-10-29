"use client";

import { createCustomerAction } from "@/features/customers/actions/customer-actions";
import {
  customerFormSchema,
  type CustomerFormInput,
} from "@/features/customers/schemas/customer-schema";
import type { CustomerCreated } from "@/features/customers/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";

export type CustomerFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created customer after a server-confirmed success. */
  onCreated: (customer: CustomerCreated) => void;
  /**
   * Optional initial values (e.g. the text the user already typed into a
   * customer search). Applied as form defaults only — every value is
   * re-validated on submit by the same schema the server enforces, so
   * prefilling can never bypass validation.
   */
  prefill?: { name?: string; phone?: string };
  /**
   * Explicit control to restore focus to on dialog closure.
   * If omitted, falls back to the element that had focus when the dialog opened.
   */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * Fallback focus target if the opener control has unmounted or disappeared.
   */
  fallbackFocusRef?: React.RefObject<HTMLElement | null>;
};

/**
 * Small create-customer form: name, phone, optional notes. The ONE
 * creation surface — the customers directory and the Smart Create
 * flow's Step 1 both render this dialog (composed at the route layer)
 * and submit through the canonical `createCustomerAction`. The
 * parent remounts it (key change) on every open so it always starts
 * from the supplied prefill.
 */
export function CustomerFormDialog({
  open,
  onOpenChange,
  onCreated,
  prefill,
  returnFocusRef,
  fallbackFocusRef,
}: CustomerFormDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const capturedOpenerRef = useRef<HTMLElement | null>(null);

  // Capture active element when dialog opens as fallback if returnFocusRef is omitted
  useEffect(() => {
    if (open) {
      if (capturedOpenerRef.current == null) {
        const active = document.activeElement;
        if (active instanceof HTMLElement && active !== document.body) {
          capturedOpenerRef.current = active;
        }
      }
    } else {
      capturedOpenerRef.current = null;
    }
  }, [open]);

  function handleCloseAutoFocus(event: Event) {
    event.preventDefault();
    const opener = returnFocusRef?.current ?? capturedOpenerRef.current;
    if (opener && opener.isConnected && typeof opener.focus === "function") {
      opener.focus();
      return;
    }
    if (
      fallbackFocusRef?.current &&
      fallbackFocusRef.current.isConnected &&
      typeof fallbackFocusRef.current.focus === "function"
    ) {
      fallbackFocusRef.current.focus();
      return;
    }
    if (typeof document !== "undefined") {
      const fallback = document.querySelector<HTMLElement>(
        'main button:not([disabled]), main [href], main input:not([disabled]), [tabindex="0"]',
      );
      fallback?.focus();
    }
  }
  const form = useForm<CustomerFormInput>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: {
      name: prefill?.name ?? "",
      phone: prefill?.phone ?? "",
      notes: "",
    },
  });

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    setSubmitting(true);
    const result = await createCustomerAction({
      name: data.name,
      phone: data.phone,
      ...(data.notes ? { notes: data.notes } : {}),
    });
    setSubmitting(false);
    if (!result.success) {
      setError(result.message);
      return;
    }
    onOpenChange(false);
    onCreated(result.customer);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={handleCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>إضافة عميل</DialogTitle>
          <DialogDescription>
            أضف بيانات العميل الأساسية — الاسم ورقم الهاتف — ليصبح متاحاً للحجز
            والمتابعة.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="customer-name">اسم العميل</Label>
            <Input
              id="customer-name"
              placeholder="مثال: أحمد محمود"
              autoComplete="off"
              aria-invalid={Boolean(form.formState.errors.name)}
              {...form.register("name")}
            />
            {form.formState.errors.name ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.name.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="customer-phone">رقم الهاتف</Label>
            <Input
              id="customer-phone"
              type="tel"
              dir="ltr"
              inputMode="tel"
              placeholder="+20 100 000 0000"
              className="text-start"
              aria-invalid={Boolean(form.formState.errors.phone)}
              {...form.register("phone")}
            />
            {form.formState.errors.phone ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.phone.message}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                يجب أن يكون الرقم فريداً — لا يمكن لعميلين مشاركة الرقم نفسه.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="customer-notes">
              ملاحظات <span className="text-muted-foreground">(اختياري)</span>
            </Label>
            <Textarea
              id="customer-notes"
              rows={3}
              placeholder="تفاصيل تساعد الفريق عند التعامل مع العميل…"
              aria-invalid={Boolean(form.formState.errors.notes)}
              {...form.register("notes")}
            />
            {form.formState.errors.notes ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.notes.message}
              </p>
            ) : null}
          </div>

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
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : null}
              حفظ العميل
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
