import { AppointmentDetail } from "@/features/appointments/components/appointment-detail";
import {
  getAppointmentDetail,
  todayInTimezone,
} from "@/features/appointments/server/appointment-queries";
import { requireUser } from "@/server/auth/guards";
import { businessRepository } from "@/server/repositories";

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "تفاصيل الموعد",
};

export default async function AppointmentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ reschedule?: string }>;
}) {
  const session = await requireUser();
  if (!session.user.businessId) redirect("/onboarding");
  const { id } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const appointment = await getAppointmentDetail(session.user.businessId, id);
  if (!appointment) notFound();

  // `today` is business-local so the reschedule date step never counts
  // days from the device timezone; the timezone travels as a
  // server-derived display property (B-08 reuse of the B-07 pattern).
  const business = await businessRepository.findById(session.user.businessId);
  if (!business) redirect("/onboarding");

  return (
    <AppointmentDetail
      initialData={appointment}
      today={todayInTimezone(business.timezone)}
      timezone={business.timezone}
      workingHours={business.workingHours}
      slotDurationMinutes={business.slotDurationMinutes}
      initialRescheduling={resolvedSearchParams?.reschedule === "true"}
    />
  );
}
