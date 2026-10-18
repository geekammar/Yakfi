import { AppointmentDetail } from "@/features/appointments/components/appointment-detail";
import {
  getAppointmentDetail,
  todayInTimezone,
} from "@/features/appointments/server/appointment-queries";
import { requireUser } from "@/server/auth/guards";
import {
  businessRepository,
  followUpRequestRepository,
  providerRepository,
  serviceRepository,
} from "@/server/repositories";

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
  searchParams?: Promise<{ reschedule?: string; followUp?: string }>;
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
  const [business, followUps, services, eligibleProviders] = await Promise.all([
    businessRepository.findById(session.user.businessId),
    followUpRequestRepository.listBySourceAppointment(
      session.user.businessId,
      id,
    ),
    serviceRepository.listByBusiness(session.user.businessId),
    providerRepository.listProfilesByBusiness(session.user.businessId),
  ]);
  if (!business) redirect("/onboarding");

  return (
    <AppointmentDetail
      initialData={appointment}
      today={todayInTimezone(business.timezone)}
      timezone={business.timezone}
      workingHours={business.workingHours}
      slotDurationMinutes={business.slotDurationMinutes}
      initialRescheduling={resolvedSearchParams?.reschedule === "true"}
      initialFollowUpOpen={resolvedSearchParams?.followUp === "true"}
      initialFollowUps={followUps}
      services={services
        .filter((s: { isActive: boolean }) => s.isActive)
        .map((s: { id: string; name: string; durationMinutes: number }) => ({
          id: s.id,
          name: s.name,
          durationMinutes: s.durationMinutes,
        }))}
      providers={eligibleProviders
        .filter((p: { isActive: boolean }) => p.isActive)
        .map((p: { id: string; name: string; displayName: string | null }) => ({
          id: p.id,
          name: p.name,
          displayName: p.displayName,
        }))}
    />
  );
}
