import { AppointmentAgenda } from "@/features/appointments/components/appointment-agenda";
import {
  getAppointmentAgenda,
  todayInTimezone,
} from "@/features/appointments/server/appointment-queries";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { appointmentDateSchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/guards";
import { businessRepository, providerRepository } from "@/server/repositories";

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "المواعيد",
};

export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; create?: string }>;
}) {
  const session = await requireUser();
  if (!session.user.businessId) redirect("/onboarding");
  const business = await businessRepository.findById(session.user.businessId);
  if (!business) redirect("/onboarding");
  const params = await searchParams;
  const today = todayInTimezone(business.timezone);
  const parsedDate = appointmentDateSchema.safeParse(params.date);
  const date = parsedDate.success ? parsedDate.data : today;
  if (params.create === "true") redirect(`/appointments/new?date=${date}`);
  const [appointments, providerProfiles] = await Promise.all([
    getAppointmentAgenda(business.id, date),
    providerRepository.listProfilesByBusiness(business.id),
  ]);
  const providers = providerProfiles.map((p) => ({
    id: p.id,
    name: p.name,
    displayName: p.displayName,
  }));

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="المواعيد"
        description="راجع مواعيد اليوم وتنقّل بين الأسابيع وتعامل مع الحجوزات بسرعة."
        actions={
          <Button asChild>
            <Link href={`/appointments/new?date=${date}`}>+ موعد جديد</Link>
          </Button>
        }
      />
      <AppointmentAgenda
        // A client-side day navigation (router.push to a new ?date=)
        // re-renders this page with fresh `initialItems` but — per the
        // framework's state-preservation model — does NOT reset the
        // client component's useState, so the previous day's list would
        // otherwise outlive the date change (stale agenda under a new
        // date header). Keying the agenda by its date makes React reset
        // the whole subtree per day: list, count, filter and error all
        // belong to the day actually shown.
        key={date}
        initialItems={appointments}
        date={date}
        today={today}
        workingHours={business.workingHours}
        slotDurationMinutes={business.slotDurationMinutes}
        providers={providers}
      />
    </div>
  );
}
