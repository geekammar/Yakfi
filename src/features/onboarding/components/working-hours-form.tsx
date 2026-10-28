"use client";

import { saveWorkingHours } from "@/features/onboarding/actions/onboarding-actions";
import { SaveIndicator } from "@/features/onboarding/components/save-indicator";
import { useAutosave } from "@/features/onboarding/hooks/use-autosave";
import {
  DAYS,
  workingHoursStepSchema,
  type WorkingHoursStepInput,
} from "@/features/onboarding/schemas/onboarding-schema";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeftIcon, ArrowRightIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

export function WorkingHoursForm({
  defaultValues,
}: {
  defaultValues: WorkingHoursStepInput;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<WorkingHoursStepInput>({
    resolver: zodResolver(workingHoursStepSchema),
    defaultValues,
    mode: "onChange",
  });
  const values = useWatch({ control: form.control }) as WorkingHoursStepInput;
  const autosave = useAutosave({
    value: values,
    enabled: form.formState.isValid,
    save: saveWorkingHours,
  });

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    autosave.setState("saving");
    const result = await saveWorkingHours(data);
    if (!result.success) {
      autosave.setState("error");
      setError(result.message);
      return;
    }
    autosave.setState("saved");
    startTransition(() => router.push("/onboarding/booking"));
  });

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <fieldset className="space-y-3">
        <legend className="mb-3 text-sm font-medium">أيام وساعات العمل</legend>
        {DAYS.map((day) => {
          const closed = values.workingHours[day.key].closed;
          return (
            <div
              key={day.key}
              className="grid items-center gap-3 rounded-lg border bg-card p-3 sm:grid-cols-[110px_1fr_1fr]"
            >
              <div className="flex items-center gap-2">
                <Controller
                  control={form.control}
                  name={`workingHours.${day.key}.closed`}
                  render={({ field }) => (
                    <Checkbox
                      id={`day-${day.key}`}
                      checked={!field.value}
                      onCheckedChange={(checked) => field.onChange(!checked)}
                    />
                  )}
                />
                <Label htmlFor={`day-${day.key}`}>{day.label}</Label>
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor={`working-hours-${day.key}-open`}
                  className="text-xs text-muted-foreground"
                >
                  من
                  <span className="sr-only"> (بداية العمل يوم {day.label})</span>
                </Label>
                <Input
                  id={`working-hours-${day.key}-open`}
                  type="time"
                  dir="ltr"
                  disabled={closed}
                  aria-label={`بداية العمل يوم ${day.label}`}
                  {...form.register(`workingHours.${day.key}.open`)}
                />
              </div>
              <div className="space-y-1">
                <Label
                  htmlFor={`working-hours-${day.key}-close`}
                  className="text-xs text-muted-foreground"
                >
                  إلى
                  <span className="sr-only"> (نهاية العمل يوم {day.label})</span>
                </Label>
                <Input
                  id={`working-hours-${day.key}-close`}
                  type="time"
                  dir="ltr"
                  disabled={closed}
                  aria-label={`نهاية العمل يوم ${day.label}`}
                  aria-invalid={Boolean(
                    form.formState.errors.workingHours?.[day.key]?.close,
                  )}
                  {...form.register(`workingHours.${day.key}.close`)}
                />
                {form.formState.errors.workingHours?.[day.key]?.close ? (
                  <p className="text-xs text-destructive">
                    {
                      form.formState.errors.workingHours[day.key]?.close
                        ?.message
                    }
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
        {typeof form.formState.errors.workingHours?.message === "string" ? (
          <p role="alert" className="text-xs text-destructive">
            {form.formState.errors.workingHours.message}
          </p>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-4 border-t pt-5">
        <Button type="button" variant="outline" size="lg" asChild>
          <Link href="/onboarding/business">
            <ArrowRightIcon />
            رجوع
          </Link>
        </Button>
        <div className="flex flex-col items-end gap-1.5">
          <Button type="submit" size="lg" disabled={isPending}>
            {isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
            حفظ ومتابعة
            <ArrowLeftIcon />
          </Button>
          <SaveIndicator state={autosave.state} />
        </div>
      </div>
    </form>
  );
}
