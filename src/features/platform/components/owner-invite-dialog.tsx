"use client";

import { createOwnerInvitationAction } from "@/features/platform/actions/platform-actions";
import {
  createOwnerInvitationInputSchema,
  type CreateOwnerInvitationInput,
} from "@/features/platform/schemas/platform-schema";
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

import { zodResolver } from "@hookform/resolvers/zod";
import {
  CheckIcon,
  CopyIcon,
  LoaderCircleIcon,
  MailPlusIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";

/** The owner activation route every invitation link points at. */
const OWNER_INVITE_ROUTE = "/owner-invite/";

function formatExpiry(iso: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

/**
 * Owner invitation creation dialog (PROMPT-OPS-05) — extremely simple:
 * business name + owner email → create invitation → secure link →
 * copy. The raw token is returned by the server exactly once and
 * displayed ONCE for manual delivery — never persisted, never logged,
 * never shown again. Business name is an optional operator memo; the
 * Business itself is created later by the owner through the canonical
 * onboarding wizard.
 */
export function OwnerInviteDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [createdExpiresAt, setCreatedExpiresAt] = useState<string | null>(null);
  const router = useRouter();
  const form = useForm<CreateOwnerInvitationInput>({
    resolver: zodResolver(createOwnerInvitationInputSchema),
    defaultValues: { email: "", businessName: "" },
  });

  async function copyLink() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      // Clipboard unavailable — the link stays selectable for manual copy.
      setCopied(false);
    }
  }

  function handleOpenChange(value: boolean) {
    if (!value) {
      // Reset the one-time link state when the dialog closes — the raw
      // link is never shown again.
      setOpen(false);
      setInviteUrl(null);
      setCreatedExpiresAt(null);
      setCopied(false);
      setError(null);
      form.reset();
      router.refresh();
      return;
    }
    setOpen(true);
  }

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    setSubmitting(true);
    let result: Awaited<ReturnType<typeof createOwnerInvitationAction>>;
    try {
      result = await createOwnerInvitationAction(data);
    } catch {
      result = {
        success: false,
        error: {
          code: "PERSISTENCE_FAILED",
          message: "تعذر إنشاء الدعوة الآن، حاول مرة أخرى",
        },
      };
    }
    setSubmitting(false);

    if (!result.success) {
      setError(result.error.message);
      return;
    }

    // The raw token is a credential returned exactly once — surface
    // the deliverable link now; it will never be retrievable again.
    setInviteUrl(
      `${window.location.origin}${OWNER_INVITE_ROUTE}${result.rawToken}`,
    );
    setCreatedExpiresAt(result.invitation.expiresAt.toISOString());
  });

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <MailPlusIcon aria-hidden />
        دعوة جديدة
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent>
          {createdExpiresAt && inviteUrl ? (
            <div role="status" className="space-y-5">
              <DialogHeader>
                <DialogTitle>تم إنشاء الدعوة</DialogTitle>
                <DialogDescription>
                  أرسل رابط الدعوة التالي إلى صاحب المنشأة عبر واتساب أو أي
                  وسيلة متاحة ليكمل تفعيل حسابه بنفسه.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2">
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
                  <p
                    dir="ltr"
                    className="min-w-0 flex-1 truncate text-start text-xs leading-5"
                  >
                    {inviteUrl}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copyLink()}
                    aria-label="نسخ رابط الدعوة"
                  >
                    {copied ? (
                      <CheckIcon aria-hidden className="size-4" />
                    ) : (
                      <CopyIcon aria-hidden className="size-4" />
                    )}
                    {copied ? "تم النسخ" : "نسخ"}
                  </Button>
                </div>
                <p className="text-xs leading-5 text-destructive">
                  لأسباب أمنية لن يظهر هذا الرابط مرة أخرى — انسخه الآن قبل
                  الإغلاق.
                </p>
                <p className="text-muted-foreground text-xs leading-5">
                  تنتهي صلاحية الدعوة في {formatExpiry(createdExpiresAt)} إن لم
                  يُكمل صاحب المنشأة تفعيل حسابه.
                </p>
              </div>

              <Button
                type="button"
                className="w-full"
                onClick={handleOpenChange.bind(null, false)}
              >
                تم
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-5" noValidate>
              <DialogHeader>
                <DialogTitle>دعوة مالك منشأة</DialogTitle>
                <DialogDescription>
                  أدخل بيانات صاحب المنشأة — سيصل الرابط إليه لتفعيل حسابه وبدء
                  إعداد منشأته. المنشأة نفسها تُنشأ من داخل التطبيق بعد التفعيل.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2">
                <Label htmlFor="owner-business-name">
                  اسم المنشأة (اختياري)
                </Label>
                <Input
                  id="owner-business-name"
                  type="text"
                  placeholder="مثال: عيادة الابتسامة"
                  aria-invalid={Boolean(form.formState.errors.businessName)}
                  {...form.register("businessName")}
                />
                {form.formState.errors.businessName ? (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.businessName.message}
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="owner-email">البريد الإلكتروني للمالك</Label>
                <Input
                  id="owner-email"
                  type="email"
                  dir="ltr"
                  autoComplete="off"
                  placeholder="name@example.com"
                  className="text-start"
                  aria-invalid={Boolean(form.formState.errors.email)}
                  {...form.register("email")}
                />
                {form.formState.errors.email ? (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.email.message}
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
                  onClick={() => handleOpenChange(false)}
                  disabled={submitting}
                >
                  إلغاء
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? (
                    <LoaderCircleIcon className="animate-spin" />
                  ) : (
                    <MailPlusIcon aria-hidden />
                  )}
                  {submitting ? "جارٍ الإنشاء…" : "إنشاء الدعوة"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
