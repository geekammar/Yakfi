"use client";

import { ActivationNotice } from "@/features/invitations/components/activation-notice";
import { completeOwnerActivationAction } from "@/features/platform/actions/platform-actions";
import { activateOwnerInputSchema } from "@/features/platform/schemas/platform-schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  CircleCheckIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const OWNER_SIGNIN_HANDOFF = "/sign-in?redirect=/onboarding";

/**
 * Owner activation form (PROMPT-OPS-05) — the owner credential step of
 * the invitation-first lifecycle. The raw invitation token travels
 * ONLY through the hidden form field to the server action — never
 * displayed, logged, or persisted here. Submission composes
 * acceptance + activation server-side; the owner becomes ADMIN of the
 * Business created through the canonical onboarding wizard afterwards.
 */
export function OwnerActivationForm({
  token,
  email,
  businessName,
}: {
  token: string;
  email: string;
  businessName: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof completeOwnerActivationAction>
  > | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const formData = new FormData(event.currentTarget);
    const parsed = activateOwnerInputSchema.safeParse({
      token: String(formData.get("token") ?? ""),
      name: String(formData.get("name") ?? ""),
      password: String(formData.get("password") ?? ""),
    });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "بيانات غير صالحة");
      return;
    }

    setSubmitting(true);
    let actionResult: Awaited<ReturnType<typeof completeOwnerActivationAction>>;
    try {
      actionResult = await completeOwnerActivationAction(parsed.data);
    } catch {
      actionResult = {
        status: "NOTICE",
        state: "FAILED",
        message: "تعذر إتمام التفعيل الآن، حاول مرة أخرى",
      };
    }
    setSubmitting(false);

    if (actionResult.status === "VALIDATION_ERROR") {
      setError(actionResult.message);
      return;
    }
    setResult(actionResult);
  }

  if (result?.status === "SUCCESS") {
    return (
      <div
        role="status"
        className="flex flex-col items-center gap-3 py-6 text-center"
      >
        <div className="bg-success/10 text-success flex size-11 items-center justify-center rounded-full">
          <CircleCheckIcon aria-hidden className="size-5" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">
            تم تفعيل حسابك بنجاح
          </h2>
          <p className="text-muted-foreground mx-auto max-w-xs text-sm leading-6">
            سجّل الدخول الآن بكلمة المرور التي اخترتها لإكمال إعداد منشأتك.
          </p>
          <p className="text-muted-foreground text-sm">
            البريد:
            <span dir="ltr" className="font-medium">
              {" "}
              {result.email}{" "}
            </span>
          </p>
        </div>
        <Button asChild className="mt-1">
          <Link href={OWNER_SIGNIN_HANDOFF}>تسجيل الدخول وإكمال الإعداد</Link>
        </Button>
      </div>
    );
  }

  if (result?.status === "NOTICE") {
    return <ActivationNotice state={result.state} message={result.message} />;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <input type="hidden" name="token" value={token} />

      <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
        {businessName ? (
          <p>
            دعوة لإدارة
            <span className="font-medium"> {businessName} </span>
            على FlowPilot
          </p>
        ) : (
          <p>دعوة لإدارة منشأتك على FlowPilot</p>
        )}
        <p className="text-muted-foreground">
          البريد المدعو:
          <span dir="ltr" className="text-foreground font-medium">
            {" "}
            {email}
          </span>
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="owner-name">الاسم</Label>
        <Input
          id="owner-name"
          name="name"
          type="text"
          autoComplete="name"
          placeholder="الاسم الكامل"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="owner-password">كلمة المرور</Label>
        <div className="relative">
          <Input
            id="owner-password"
            name="password"
            type={showPassword ? "text" : "password"}
            dir="ltr"
            autoComplete="new-password"
            placeholder="••••••••"
            required
            minLength={8}
            className="text-start pe-10"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={
              showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"
            }
            className="text-muted-foreground hover:text-foreground absolute end-2 top-1/2 -translate-y-1/2 rounded-sm p-1 transition-colors"
          >
            {showPassword ? (
              <EyeOffIcon aria-hidden className="size-4" />
            ) : (
              <EyeIcon aria-hidden className="size-4" />
            )}
          </button>
        </div>
        <p className="text-muted-foreground text-xs">
          8 أحرف على الأقل — ستستخدمها لتسجيل الدخول لاحقاً.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-center text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? (
          <LoaderCircleIcon aria-hidden className="animate-spin" />
        ) : null}
        {submitting ? "جارٍ التفعيل…" : "تفعيل الحساب"}
      </Button>

      <p className="text-muted-foreground text-center text-xs leading-5">
        بعد التفعيل سننقلك إلى تسجيل الدخول لإكمال إعداد منشأتك.
      </p>
    </form>
  );
}
