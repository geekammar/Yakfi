"use client";

import { updateAiPolicyAction } from "@/features/platform/actions/platform-actions";
import {
  updateAiPolicyInputSchema,
  type UpdateAiPolicyInput,
} from "@/features/platform/schemas/platform-schema";
import { AI_PROVIDER_OPTIONS } from "@/features/platform/server/provider-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

type PolicyFormState = {
  primaryProvider: UpdateAiPolicyInput["primaryProvider"];
  primaryModel: string;
  secondaryProvider: UpdateAiPolicyInput["secondaryProvider"];
  secondaryModel: UpdateAiPolicyInput["secondaryModel"];
  fallbackEnabled: boolean;
  primarySecretRef: string;
  secondarySecretRef: string | null;
};

/**
 * AI Provider Policy form (PROMPT-OPS-05) — the ONE primary action per
 * view: save the policy. Policy/config changes are DB-backed and apply
 * at runtime; API keys are NOT shown (only their env-var reference
 * names, for the operator's deployment configuration).
 */
export function AiPolicyForm({ policy }: { policy: PolicyFormState }) {
  const router = useRouter();
  const [state, setState] = useState<PolicyFormState>(policy);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const hasSecondary = state.secondaryProvider !== null;

  function update(patch: Partial<PolicyFormState>) {
    setSaved(false);
    setState((current) => ({ ...current, ...patch }));
  }

  function setSecondaryProvider(value: string) {
    if (value === "none") {
      update({
        secondaryProvider: null,
        secondaryModel: null,
        fallbackEnabled: false,
      });
      return;
    }
    update({
      secondaryProvider: value as UpdateAiPolicyInput["secondaryProvider"],
    });
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = updateAiPolicyInputSchema.safeParse({
      primaryProvider: state.primaryProvider,
      primaryModel: state.primaryModel,
      secondaryProvider: state.secondaryProvider,
      secondaryModel: state.secondaryModel,
      fallbackEnabled: state.fallbackEnabled,
    } satisfies UpdateAiPolicyInput);

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "بيانات السياسة غير صالحة");
      return;
    }

    setSubmitting(true);
    let result: Awaited<ReturnType<typeof updateAiPolicyAction>>;
    try {
      result = await updateAiPolicyAction(parsed.data);
    } catch {
      result = {
        success: false,
        error: {
          code: "PERSISTENCE_FAILED",
          message: "تعذر حفظ السياسة الآن، حاول مرة أخرى",
        },
      };
    }
    setSubmitting(false);

    if (!result.success) {
      setError(result.error.message);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">المزود الأساسي</CardTitle>
          <CardDescription>
            المزود الذي تُنفَّذ من خلاله تفاعلات الذكاء الاصطناعي.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="primary-provider">المزود</Label>
            <Select
              value={state.primaryProvider}
              onValueChange={(value) =>
                update({
                  primaryProvider:
                    value as UpdateAiPolicyInput["primaryProvider"],
                })
              }
            >
              <SelectTrigger id="primary-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AI_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="primary-model">معرّف النموذج</Label>
            <Input
              id="primary-model"
              dir="ltr"
              className="text-start font-mono text-xs"
              value={state.primaryModel}
              onChange={(event) => update({ primaryModel: event.target.value })}
              aria-invalid={Boolean(error) && !state.primaryModel.trim()}
            />
          </div>

          <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs">
            <p className="text-muted-foreground">
              مفتاح المزود الأساسي يُدار كمتغير بيئة:
              <span dir="ltr" className="text-foreground ms-1 font-mono">
                {state.primarySecretRef}
              </span>
            </p>
            <p className="text-muted-foreground">
              تغيير المفتاح نفسه يتم في متغيرات البيئة (Vercel) ويحتاج إعادة نشر
              — تغيير السياسة هنا يُطبق فوراً.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">المزود الاحتياطي</CardTitle>
          <CardDescription>
            يُستخدم عند تعذر تنفيذ الطلب عبر المزود الأساسي.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="secondary-provider">المزود</Label>
            <Select
              value={state.secondaryProvider ?? "none"}
              onValueChange={setSecondaryProvider}
            >
              <SelectTrigger id="secondary-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">بدون</SelectItem>
                {AI_PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {hasSecondary ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="secondary-model">معرّف النموذج</Label>
                <Input
                  id="secondary-model"
                  dir="ltr"
                  className="text-start font-mono text-xs"
                  value={state.secondaryModel ?? ""}
                  onChange={(event) =>
                    update({ secondaryModel: event.target.value })
                  }
                />
              </div>

              <div className="flex items-start gap-2">
                <Checkbox
                  id="fallback-enabled"
                  checked={state.fallbackEnabled}
                  onCheckedChange={(checked) =>
                    update({ fallbackEnabled: checked === true })
                  }
                />
                <Label
                  htmlFor="fallback-enabled"
                  className="text-sm leading-5 font-normal"
                >
                  تفعيل التراجع للاحتياطي عند فشل المزود الأساسي
                </Label>
              </div>

              <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs">
                <p className="text-muted-foreground">
                  مفتاح المزود الاحتياطي يُدار كمتغير بيئة:
                  <span dir="ltr" className="text-foreground ms-1 font-mono">
                    {state.secondarySecretRef}
                  </span>
                </p>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting ? <LoaderCircleIcon className="animate-spin" /> : null}
          {submitting ? "جارٍ الحفظ…" : "حفظ السياسة"}
        </Button>
        {saved ? <Badge>تم الحفظ — تُطبق فوراً</Badge> : null}
      </div>
    </form>
  );
}
