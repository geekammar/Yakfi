import type {
  AppointmentAgendaItem,
  AppointmentDetailData,
} from "@/features/appointments/types";
import {
  appointmentRepository,
  conversationRepository,
} from "@/server/repositories";

function serializeAppointment(appointment: {
  id: string;
  date: Date;
  startTime: Date;
  endTime: Date;
  status: AppointmentAgendaItem["status"];
  notes: string | null;
  customer: AppointmentAgendaItem["customer"];
  service: AppointmentAgendaItem["service"];
  provider?: { id: string; name: string; displayName?: string | null } | null;
}): AppointmentAgendaItem {
  return {
    id: appointment.id,
    date: appointment.date.toISOString().slice(0, 10),
    startTime: appointment.startTime.toISOString(),
    endTime: appointment.endTime.toISOString(),
    status: appointment.status,
    notes: appointment.notes,
    customer: appointment.customer,
    service: appointment.service,
    provider: appointment.provider
      ? {
          id: appointment.provider.id,
          name: appointment.provider.name,
          displayName: appointment.provider.displayName ?? null,
        }
      : null,
  };
}

export async function getAppointmentAgenda(businessId: string, date: string) {
  const appointments = await appointmentRepository.listAgenda(businessId, date);
  return appointments.map(serializeAppointment);
}

export async function searchBusinessAppointments(
  businessId: string,
  query: string,
  limit = 20,
) {
  const appointments = await appointmentRepository.searchAppointments(
    businessId,
    query,
    limit,
  );
  return appointments.map(serializeAppointment);
}

export async function getAppointmentDetail(
  businessId: string,
  appointmentId: string,
): Promise<AppointmentDetailData | null> {
  const appointment = await appointmentRepository.findWithRelationsByBusiness(
    appointmentId,
    businessId,
  );
  if (!appointment) return null;
  const conversation = await conversationRepository.findLatestByCustomer(
    businessId,
    appointment.customerId,
  );

  return {
    ...serializeAppointment(appointment),
    conversationId: conversation?.id ?? null,
  };
}

export function todayInTimezone(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
