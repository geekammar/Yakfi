"use client";

import { saveBookingBasics } from "@/features/onboarding/actions/onboarding-actions";
import { SaveIndicator } from "@/features/onboarding/components/save-indicator";
import { useAutosave } from "@/features/onboarding/hooks/use-autosave";
import {
  bookingBasicsSchema,
  type BookingBasicsInput,
} from "@/features/onboarding/schemas/onboarding-schema";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { BOOKING_INTERVAL_OPTIONS } from "@/lib/validation";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeftIcon, ArrowRightIcon, LoaderCircleIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

const SLOT_OPTIONS = BOOKING_INTERVAL_OPTIONS;

export function BookingBasicsForm({
  defaultValues,
}: {
  defaultValues: BookingBasicsInput;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<BookingBasicsInput>({
    resolver: zodResolver(bookingBasicsSchema),
    defaultValues,
    mode: "onChange",
  });
  const values = useWatch({ control: form.control }) as BookingBasicsInput;
  const autosave = useAutosave({
    value: values,
    enabled: form.formState.isValid,
    save: saveBookingBasics,
  });

  const submit = form.handleSubmit(async (data) => {
    setError(null);
    autosave.setState("saving");
    const result = await saveBookingBasics(data);
    if (!result.success) {
      autosave.setState("error");
      setError(result.message);
      return;
    }
    autosave.setState("saved");
    startTransition(() => router.push("/onboarding/review"));
  });

  return (
    <form onSubmit={submit} className="space-y-6" noValidate>
      <div className="max-w-sm space-y-2">
        <Label htmlFor="slot-duration">مدة الحجز الافتراضية</Label>
        <Controller
          control={form.control}
          name="slotDurationMinutes"
          render={({ field }) => (
            <Select
              value={String(field.value)}
              onValueChange={(value) => field.onChange(Number(value))}
            >
              <SelectTrigger id="slot-duration" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SLOT_OPTIONS.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutes} دقيقة
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
        <p className="text-xs leading-5 text-muted-foreground">
          الفترة الزمنية التي تُعرض على العميل عند اقتراح موعد.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="cancellation-policy">سياسة الإلغاء</Label>
        <Textarea
          id="cancellation-policy"
          rows={3}
          placeholder="مثال: يمكن الإلغاء أو التعديل قبل الموعد بـ 24 ساعة."
          aria-invalid={Boolean(form.formState.errors.cancellationPolicy)}
          {...form.register("cancellationPolicy")}
        />
        {form.formState.errors.cancellationPolicy ? (
          <p className="text-xs text-destructive">
            {form.formState.errors.cancellationPolicy.message}
          </p>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-4 border-t pt-5">
        <Button type="button" variant="outline" size="lg" asChild>
          <Link href="/onboarding/hours">
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
