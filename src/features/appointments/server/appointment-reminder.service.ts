/**
 * Appointment Reminders execution and lifecycle service (BOOK-REM-01).
 *
 * Implements:
 * - Scheduler batch processing with atomic claiming (SKIP LOCKED).
 * - Multi-tenant isolation and stale-data reload.
 * - WhatsApp approved template delivery and Telegram transport delivery.
 * - Appointment lifecycle hooks: create, reschedule, cancel.
 * - Bounded retry policy for transient transport failures.
 */

import {
  WHATSAPP_REMINDER_TEMPLATE_LANG,
  WHATSAPP_REMINDER_TEMPLATE_NAME,
  calculateReminderDueTime,
  getReminderTemplateParams,
  isLateBooking,
  renderReminderContent,
} from "@/lib/scheduling/reminder-time";
import { createTelegramMessageTransport } from "@/server/integrations/telegram/telegram-transport";
import { createDefaultMetaWhatsAppTransport } from "@/server/integrations/whatsapp/meta-client";
import {
  appointmentReminderRepository,
  appointmentRepository,
  businessRepository,
  customerRepository,
  serviceRepository,
  telegramConnectionRepository,
  whatsAppConnectionRepository,
  type AppointmentReminderRepository,
  type AppointmentRepository as ApptRepo,
  type BusinessRepository as BizRepo,
  type CustomerRepository as CustRepo,
  type ServiceRepository as SvcRepo,
  type TelegramConnectionRepository as TgRepo,
  type WhatsAppConnectionRepository as WaRepo,
} from "@/server/repositories";
import type {
  MessageTransport,
  OutboundMessage,
  TransportSendResult,
} from "@/server/transport/whatsapp-transport";
import type {
  Appointment,
  AppointmentReminder,
  Business,
  Customer,
} from "@/types/domain";

export type AppointmentReminderServiceDeps = {
  appointmentReminderRepository: Pick<
    AppointmentReminderRepository,
    | "claimDueReminders"
    | "markSent"
    | "markFailed"
    | "create"
    | "cancelActiveByAppointment"
    | "findActiveByAppointmentId"
  >;
  appointmentRepository: Pick<ApptRepo, "findById">;
  businessRepository: Pick<BizRepo, "findById">;
  customerRepository: Pick<CustRepo, "findById">;
  serviceRepository: Pick<SvcRepo, "findById">;
  whatsAppConnectionRepository?: Pick<WaRepo, "listByBusiness">;
  telegramConnectionRepository?: Pick<TgRepo, "listByBusiness">;
  whatsAppTransportFactory?: () => MessageTransport;
  telegramTransportFactory?: () => MessageTransport;
  now?: () => Date;
};

export const defaultAppointmentReminderServiceDeps: AppointmentReminderServiceDeps =
  {
    appointmentReminderRepository,
    appointmentRepository,
    businessRepository,
    customerRepository,
    serviceRepository,
    whatsAppConnectionRepository,
    telegramConnectionRepository,
    whatsAppTransportFactory: () => createDefaultMetaWhatsAppTransport(),
    telegramTransportFactory: () => createTelegramMessageTransport(),
  };

export type ProcessDueRemindersResult = {
  claimed: number;
  sent: number;
  failed: number;
  suppressed: number;
};

function toTimeString(time: Date): string {
  return time.toISOString().slice(11, 16);
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Detects whether a customer handle is a numeric Telegram chat id
 * (vs an E.164 international phone number starting with +).
 */
export function isTelegramHandle(phone: string): boolean {
  const trimmed = phone.trim();
  // Standard phone numbers start with +, 00, or have E.164 phone characteristics
  if (trimmed.startsWith("+") || trimmed.startsWith("00")) return false;
  // Pure digits without + or international prefix
  return /^[0-9]{5,15}$/.test(trimmed);
}

/**
 * Resolves the outbound messaging channel and active connection for a customer reminder.
 */
export async function resolveReminderDeliveryChannel(
  deps: AppointmentReminderServiceDeps,
  businessId: string,
  customer: Customer,
): Promise<
  | { ok: true; channel: "WHATSAPP"; connectionId: string }
  | { ok: true; channel: "TELEGRAM"; connectionId: string }
  | {
      ok: false;
      error: string;
      code: "NO_ACTIVE_CHANNEL" | "CUSTOMER_UNREACHABLE";
    }
> {
  const isTg = isTelegramHandle(customer.phone);

  if (isTg) {
    if (!deps.telegramConnectionRepository) {
      return {
        ok: false,
        error: "مزود تيليجرام غير متاح",
        code: "NO_ACTIVE_CHANNEL",
      };
    }
    const connections =
      await deps.telegramConnectionRepository.listByBusiness(businessId);
    const activeTg = connections.find(
      (c) => c.status === "CONNECTED" && c.isActive,
    );
    if (!activeTg) {
      return {
        ok: false,
        error: "بوت تيليجرام للمنشأة غير متصل حالياً",
        code: "NO_ACTIVE_CHANNEL",
      };
    }
    return { ok: true, channel: "TELEGRAM", connectionId: activeTg.id };
  }

  // Otherwise WhatsApp channel
  if (!deps.whatsAppConnectionRepository) {
    return {
      ok: false,
      error: "مزود واتساب غير متاح",
      code: "NO_ACTIVE_CHANNEL",
    };
  }
  const connections =
    await deps.whatsAppConnectionRepository.listByBusiness(businessId);
  const activeWa = connections.find(
    (c) => c.status === "CONNECTED" && c.isActive,
  );
  if (!activeWa) {
    return {
      ok: false,
      error: "اتصال واتساب للمنشأة غير متصل حالياً",
      code: "NO_ACTIVE_CHANNEL",
    };
  }
  return { ok: true, channel: "WHATSAPP", connectionId: activeWa.id };
}

/**
 * Processes one batch of due reminders atomically.
 */
export async function processDueReminders(
  deps: AppointmentReminderServiceDeps = defaultAppointmentReminderServiceDeps,
  options: { batchSize?: number; leaseTimeoutMinutes?: number } = {},
): Promise<ProcessDueRemindersResult> {
  const now = deps.now ? deps.now() : new Date();
  const reminders = await deps.appointmentReminderRepository.claimDueReminders({
    batchSize: options.batchSize,
    now,
    leaseTimeoutMinutes: options.leaseTimeoutMinutes,
  });

  const result: ProcessDueRemindersResult = {
    claimed: reminders.length,
    sent: 0,
    failed: 0,
    suppressed: 0,
  };

  for (const reminder of reminders) {
    // 1. Reload the current appointment state directly from database
    const appointment = await deps.appointmentRepository.findById(
      reminder.appointmentId,
    );
    if (!appointment) {
      await deps.appointmentReminderRepository.markFailed(reminder.id, {
        error: "APPOINTMENT_NOT_FOUND",
        retryable: false,
      });
      result.suppressed += 1;
      continue;
    }

    // 2. Confirm the appointment is still eligible for reminders
    // Only CONFIRMED appointments are reminded. If cancelled, completed, or no-show, suppress.
    if (appointment.status !== "CONFIRMED") {
      await deps.appointmentReminderRepository.cancelActiveByAppointment(
        appointment.id,
        `SUPPRESSED_STATUS_${appointment.status}`,
      );
      result.suppressed += 1;
      continue;
    }

    // 3. Check configured business reminder policy
    const business = await deps.businessRepository.findById(
      reminder.businessId,
    );
    if (!business || !business.isActive) {
      await deps.appointmentReminderRepository.markFailed(reminder.id, {
        error: "BUSINESS_INACTIVE",
        retryable: false,
      });
      result.suppressed += 1;
      continue;
    }

    if (!business.reminderEnabled) {
      // Admin disabled reminders in the meantime
      await deps.appointmentReminderRepository.cancelActiveByAppointment(
        appointment.id,
        "REMINDERS_DISABLED_BY_BUSINESS",
      );
      result.suppressed += 1;
      continue;
    }

    // 4. Check customer channel eligibility and consent
    const customer = await deps.customerRepository.findById(
      appointment.customerId,
    );
    if (!customer) {
      await deps.appointmentReminderRepository.markFailed(reminder.id, {
        error: "CUSTOMER_NOT_FOUND",
        retryable: false,
      });
      result.failed += 1;
      continue;
    }

    // 5. Verify selected channel and readiness
    const channelResolution = await resolveReminderDeliveryChannel(
      deps,
      business.id,
      customer,
    );
    if (!channelResolution.ok) {
      await deps.appointmentReminderRepository.markFailed(reminder.id, {
        error: channelResolution.error,
        retryable: false,
      });
      result.failed += 1;
      continue;
    }

    // 6. Resolve service details
    const service = await deps.serviceRepository.findById(
      appointment.serviceId,
    );
    const serviceName = service?.name ?? "الموعد";
    const dateStr = toDateString(appointment.date);
    const timeStr = toTimeString(appointment.startTime);
    const templateId =
      business.reminderTemplateId ?? reminder.templateId ?? "standard";

    const content = renderReminderContent({
      templateId,
      businessName: business.name,
      date: dateStr,
      startTime: timeStr,
      serviceName,
    });

    let sendResult: TransportSendResult;

    if (channelResolution.channel === "WHATSAPP") {
      const templateParams = getReminderTemplateParams({
        businessName: business.name,
        date: dateStr,
        startTime: timeStr,
        serviceName,
      });

      const outbound: OutboundMessage = {
        to: customer.phone,
        businessId: business.id,
        businessName: business.name,
        conversationId: "",
        correlationId: reminder.id,
        connectionId: channelResolution.connectionId,
        kind: "TEMPLATE",
        content,
        template: {
          name: WHATSAPP_REMINDER_TEMPLATE_NAME,
          language: WHATSAPP_REMINDER_TEMPLATE_LANG,
          parameters: templateParams,
        },
      };

      const transport = deps.whatsAppTransportFactory
        ? deps.whatsAppTransportFactory()
        : createDefaultMetaWhatsAppTransport();

      sendResult = await transport.send(outbound);
    } else {
      // TELEGRAM channel
      const outbound: OutboundMessage = {
        to: customer.phone,
        businessId: business.id,
        businessName: business.name,
        conversationId: "",
        correlationId: reminder.id,
        connectionId: channelResolution.connectionId,
        kind: "TEXT",
        content,
      };

      const transport = deps.telegramTransportFactory
        ? deps.telegramTransportFactory()
        : createTelegramMessageTransport();

      sendResult = await transport.send(outbound);
    }

    // 7. Record actual outcome
    if (sendResult.delivered) {
      await deps.appointmentReminderRepository.markSent(
        reminder.id,
        sendResult.providerMessageId,
      );
      result.sent += 1;
    } else {
      const isRetryable =
        sendResult.errorCode === "TRANSIENT_TRANSPORT_FAILURE";
      await deps.appointmentReminderRepository.markFailed(reminder.id, {
        error: sendResult.error ?? "DELIVERY_FAILED",
        retryable: isRetryable,
      });
      result.failed += 1;
    }
  }

  return result;
}

/**
 * Automatically schedules a reminder when a new appointment is created.
 */
export async function scheduleReminderOnAppointmentCreated(
  deps: AppointmentReminderServiceDeps = defaultAppointmentReminderServiceDeps,
  appointment: Appointment,
  business: Business,
): Promise<AppointmentReminder | null> {
  if (!business.reminderEnabled) return null;

  const leadHours = business.reminderLeadHours ?? 24;
  const dateStr = toDateString(appointment.date);
  const timeStr = toTimeString(appointment.startTime);
  const now = deps.now ? deps.now() : new Date();

  // Check late booking: if appointment was created less than lead time before start, skip
  if (
    isLateBooking({
      date: dateStr,
      startTime: timeStr,
      leadHours,
      timezone: business.timezone,
      now,
    })
  ) {
    return null;
  }

  const dueAt = calculateReminderDueTime({
    date: dateStr,
    startTime: timeStr,
    leadHours,
    timezone: business.timezone,
  });

  return deps.appointmentReminderRepository.create({
    businessId: business.id,
    appointmentId: appointment.id,
    dueAt,
    leadHours,
    templateId: business.reminderTemplateId ?? "standard",
    status: "PENDING",
  });
}

/**
 * Handles rescheduling: cancels existing active reminder and schedules a new one.
 */
export async function handleAppointmentRescheduled(
  deps: AppointmentReminderServiceDeps = defaultAppointmentReminderServiceDeps,
  params: {
    appointmentId: string;
    newDate: string;
    newStartTime: string;
  },
): Promise<AppointmentReminder | null> {
  // 1. Invalidate obsolete active reminders
  await deps.appointmentReminderRepository.cancelActiveByAppointment(
    params.appointmentId,
    "RESCHEDULED",
  );

  // 2. Load appointment and business
  const appointment = await deps.appointmentRepository.findById(
    params.appointmentId,
  );
  if (!appointment) return null;

  const business = await deps.businessRepository.findById(
    appointment.businessId,
  );
  if (!business || !business.reminderEnabled) return null;

  const leadHours = business.reminderLeadHours ?? 24;
  const now = deps.now ? deps.now() : new Date();

  if (
    isLateBooking({
      date: params.newDate,
      startTime: params.newStartTime,
      leadHours,
      timezone: business.timezone,
      now,
    })
  ) {
    return null;
  }

  const dueAt = calculateReminderDueTime({
    date: params.newDate,
    startTime: params.newStartTime,
    leadHours,
    timezone: business.timezone,
  });

  return deps.appointmentReminderRepository.create({
    businessId: business.id,
    appointmentId: appointment.id,
    dueAt,
    leadHours,
    templateId: business.reminderTemplateId ?? "standard",
    status: "PENDING",
  });
}

/**
 * Handles appointment cancellation: suppresses any pending reminders.
 */
export async function handleAppointmentCancelled(
  deps: AppointmentReminderServiceDeps = defaultAppointmentReminderServiceDeps,
  appointmentId: string,
): Promise<number> {
  return deps.appointmentReminderRepository.cancelActiveByAppointment(
    appointmentId,
    "APPOINTMENT_CANCELLED",
  );
}
