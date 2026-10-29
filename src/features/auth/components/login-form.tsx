"use client";

import { loginSchema } from "@/features/auth/schemas/login-schema";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

import { EyeIcon, EyeOffIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, useTransition } from "react";

function safeInternalPath(value: string | null): string {
  return value && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  const emailInputRef = useRef<HTMLInputElement>(null);
  const passwordInputRef = useRef<HTMLInputElement>(null);
  const isSubmittingRef = useRef(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmittingRef.current || submitting || isPending) {
      return;
    }

    setFormError(null);

    const parsed = loginSchema.safeParse({
      email,
      password,
      rememberMe,
    });

    if (!parsed.success) {
      const nextFieldErrors: { email?: string; password?: string } = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "email" && !nextFieldErrors.email) {
          nextFieldErrors.email = issue.message;
        } else if (field === "password" && !nextFieldErrors.password) {
          nextFieldErrors.password = issue.message;
        }
      }

      setFieldErrors(nextFieldErrors);

      if (nextFieldErrors.email) {
        emailInputRef.current?.focus();
      } else if (nextFieldErrors.password) {
        passwordInputRef.current?.focus();
      }
      return;
    }

    setFieldErrors({});
    setSubmitting(true);
    isSubmittingRef.current = true;

    try {
      const { error: signInError } = await authClient.signIn.email({
        email: parsed.data.email,
        password: parsed.data.password,
        rememberMe: parsed.data.rememberMe,
      });

      if (signInError) {
        setFormError(
          signInError.status === 401
            ? "البريد الإلكتروني أو كلمة المرور غير صحيحة"
            : "تعذر تسجيل الدخول، حاول مرة أخرى",
        );
        return;
      }

      const target = safeInternalPath(searchParams.get("redirect"));
      startTransition(() => {
        router.replace(target);
        router.refresh();
      });
    } catch {
      setFormError("تعذر الاتصال بالخادم، حاول مرة أخرى");
    } finally {
      setSubmitting(false);
      isSubmittingRef.current = false;
    }
  }

  const busy = submitting || isPending;

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">البريد الإلكتروني</Label>
        <Input
          ref={emailInputRef}
          id="email"
          name="email"
          type="email"
          dir="ltr"
          autoComplete="email"
          placeholder="name@example.com"
          required
          className="text-start"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email) {
              setFieldErrors((prev) => ({ ...prev, email: undefined }));
            }
            if (formError) {
              setFormError(null);
            }
          }}
          aria-invalid={fieldErrors.email ? true : undefined}
          aria-describedby={fieldErrors.email ? "email-error" : undefined}
        />
        {fieldErrors.email ? (
          <p id="email-error" className="text-xs text-destructive">
            {fieldErrors.email}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">كلمة المرور</Label>
          {/* Placeholder — password reset arrives after Spec A. */}
          <Link
            href="/forgot-password"
            tabIndex={-1}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            نسيت كلمة المرور؟
          </Link>
        </div>
        <div className="relative">
          <Input
            ref={passwordInputRef}
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            dir="ltr"
            autoComplete="current-password"
            placeholder="••••••••"
            required
            className="text-start pe-10"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) {
                setFieldErrors((prev) => ({ ...prev, password: undefined }));
              }
              if (formError) {
                setFormError(null);
              }
            }}
            aria-invalid={fieldErrors.password ? true : undefined}
            aria-describedby={
              fieldErrors.password ? "password-error" : undefined
            }
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
        {fieldErrors.password ? (
          <p id="password-error" className="text-xs text-destructive">
            {fieldErrors.password}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Checkbox
          id="rememberMe"
          name="rememberMe"
          checked={rememberMe}
          onCheckedChange={(checked) => setRememberMe(checked === true)}
        />
        <Label
          htmlFor="rememberMe"
          className="text-sm font-normal cursor-pointer"
        >
          تذكرني
        </Label>
      </div>

      {formError ? (
        <p
          id="login-form-error"
          role="alert"
          className="text-destructive text-center text-sm"
        >
          {formError}
        </p>
      ) : null}

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? (
          <LoaderCircleIcon aria-hidden className="animate-spin" />
        ) : null}
        {busy ? "جارٍ الدخول…" : "تسجيل الدخول"}
      </Button>
    </form>
  );
}
