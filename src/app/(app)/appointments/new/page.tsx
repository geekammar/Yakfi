import { SmartCreateAppointment } from "@/features/appointments/components/smart-create/smart-create-appointment";
import { todayInTimezone } from "@/features/appointments/server/appointment-queries";
import {
  defaultBookingFlowServiceDeps,
  deriveInitialBookingScreen,
  listBookingServices,
  resolveBookingContext,
  searchBookingCustomers,
  type BookingFlowActor,
} from "@/features/appointments/server/booking-flow-service";
import { CustomerFormDialog } from "@/features/customers/components/customer-form-dialog";
import { PageHeader } from "@/components/shared/page-header";
import { appointmentDateSchema, uuidSchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/guards";
import { businessRepository } from "@/server/repositories";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "إنشاء موعد",
};

/**
 * Smart Create Appointment flow (PROMPT-11 Steps 1–3 + PROMPT-12
 * Step 4 + PROMPT-13 Step 5 + PROMPT-14 Step 6 + B-07 smart context /
 * relative scheduling / follow-up). The Business is derived from the
 * authenticated session (never client input), the initial customers +
 * active services are read through the booking-flow service
 * (tenant-scoped), `today` is business-local, and the Business
 * timezone / confirmation mode travel to Step 6 as server-derived
 * display properties. The route composes the customers feature's
 * create dialog into Step 1 (PROMPT-15) so a customer can be created
 * when no existing one is available.
 *
 * B-07 §A — the entry context (`?customerId=` from a customer page or
 * conversation, `?serviceId=` from a service page) is resolved through
 * `resolveBookingContext` against the actor's OWN Business: a foreign
 * or inactive id prefills nothing (the wizard asks for it normally),
 * and a valid one opens the flow already past that step.
 */
export default async function NewAppointmentPage({
  searchParams,
}: {
  searchParams: Promise<{
    date?: string;
    customerId?: string;
    serviceId?: string;
    providerId?: string;
    followUpId?: string;
  }>;
}) {
  const session = await requireUser();
  if (!session.user.businessId) redirect("/onboarding");
  const business = await businessRepository.findById(session.user.businessId);
  if (!business) redirect("/onboarding");

  const params = await searchParams;
  const parsedDate = appointmentDateSchema.safeParse(params.date);
  const today = todayInTimezone(business.timezone);

  // Session role normalization: anything non-ADMIN behaves as STAFF
  // (least privilege — same fallback as the availability action).
  const role = session.user.role === "ADMIN" ? "ADMIN" : "STAFF";
  const actor: BookingFlowActor = {
    userId: session.user.id,
    role,
    businessId: business.id,
  };
  const [customerResult, serviceResult, prefill] = await Promise.all([
    searchBookingCustomers(defaultBookingFlowServiceDeps, actor, { query: "" }),
    listBookingServices(defaultBookingFlowServiceDeps, actor),
    resolveBookingContext(defaultBookingFlowServiceDeps, actor, {
      // Zod re-validates shape at the service boundary; the optional
      // ids are only ever prefilled after a same-Business re-check.
      customerId: uuidSchema.safeParse(params.customerId).success
        ? params.customerId
        : undefined,
      serviceId: uuidSchema.safeParse(params.serviceId).success
        ? params.serviceId
        : undefined,
      providerId: uuidSchema.safeParse(params.providerId).success
        ? params.providerId
        : undefined,
      followUpId: uuidSchema.safeParse(params.followUpId).success
        ? params.followUpId
        : undefined,
    }),
  ]);

  let defaultDate = parsedDate.success ? parsedDate.data : today;
  if (!parsedDate.success && prefill.followUpContext?.startDate) {
    defaultDate =
      prefill.followUpContext.startDate >= today
        ? prefill.followUpContext.startDate
        : today;
  }

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="إنشاء موعد"
        description="أنشئ الموعد في خطوات واضحة: العميل، ثم الخدمة، ثم التاريخ، ثم الوقت المتاح، ثم المراجعة والتأكيد."
      />
      <div className="rounded-xl border bg-card p-4 shadow-xs sm:p-6">
        <SmartCreateAppointment
          initialCustomers={
            customerResult.success ? customerResult.customers : []
          }
          services={Array.isArray(serviceResult) ? serviceResult : []}
          defaultDate={defaultDate}
          today={todayInTimezone(business.timezone)}
          canManageServices={role === "ADMIN"}
          businessTimezone={business.timezone}
          confirmationMode={
            business.confirmationMode === "automatic" ? "automatic" : "manual"
          }
          initialCustomer={prefill.customer}
          initialServiceId={prefill.serviceId}
          initialProviderId={prefill.providerId}
          initialScreen={deriveInitialBookingScreen(prefill)}
          CustomerCreateDialog={CustomerFormDialog}
          workingHours={business.workingHours}
          slotDurationMinutes={business.slotDurationMinutes}
          followUpContext={prefill.followUpContext}
        />
      </div>
    </div>
  );
}
