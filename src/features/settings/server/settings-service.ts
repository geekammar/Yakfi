/**
 * Business Settings workflow (operator PROMPT-09).
 *
 * The service layer enforces the authorization rules the route layer
 * relies on: only Business ADMIN users read/mutate Business settings,
 * and the target Business is ALWAYS the actor's own (derived from the
 * trusted session → user record, never from client input). Repository
 * collaborators are injectable so the workflow logic can be verified
 * without a live database (services/invitations-feature pattern).
 */

import { areAppointmentRemindersOperational } from "@/features/appointments/server/reminder-config";
import { businessSettingsSchema } from "@/features/settings/schemas/settings-schema";
import type {
  BusinessSettingsView,
  SettingsActionResult,
} from "@/features/settings/types";
import type {
  BusinessRepository,
  ServiceRepository,
  TelegramConnectionRepository,
  WhatsAppConnectionRepository,
} from "@/server/repositories";
import {
  businessRepository,
  serviceRepository,
  telegramConnectionRepository,
  whatsAppConnectionRepository,
} from "@/server/repositories";
import type { Business, UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type SettingsActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type SettingsServiceDeps = {
  businessRepository: Pick<BusinessRepository, "findById" | "update">;
  serviceRepository?: Pick<ServiceRepository, "findByIdWithinBusiness">;
  whatsAppConnectionRepository?: Pick<
    WhatsAppConnectionRepository,
    "listByBusiness"
  >;
  telegramConnectionRepository?: Pick<
    TelegramConnectionRepository,
    "listByBusiness"
  >;
};

/** Production dependencies (app singletons). */
export const defaultSettingsServiceDeps: SettingsServiceDeps = {
  businessRepository,
  serviceRepository,
  whatsAppConnectionRepository,
  telegramConnectionRepository,
};

const FORBIDDEN_MESSAGE = "الإعدادات متاحة للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const NOT_FOUND_MESSAGE = "تعذر العثور على المنشأة";
const CHANNEL_REQUIRED_FOR_REMINDERS_MESSAGE =
  "يجب ربط واتساب أو تيليجرام أولاً لتفعيل التذكير التلقائي";

function resolveScope(
  actor: SettingsActor,
): { ok: true; businessId: string } | { ok: false; message: string } {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

async function resolveChannelReadiness(
  deps: SettingsServiceDeps,
  businessId: string,
): Promise<{
  whatsapp: boolean;
  telegram: boolean;
  hasActiveChannel: boolean;
}> {
  let whatsapp = false;
  let telegram = false;

  try {
    if (deps.whatsAppConnectionRepository) {
      const connections =
        await deps.whatsAppConnectionRepository.listByBusiness(businessId);
      whatsapp = connections.some(
        (c) => c.status === "CONNECTED" && c.isActive,
      );
    }
  } catch {
    whatsapp = false;
  }

  try {
    if (deps.telegramConnectionRepository) {
      const connections =
        await deps.telegramConnectionRepository.listByBusiness(businessId);
      telegram = connections.some(
        (c) => c.status === "CONNECTED" && c.isActive,
      );
    }
  } catch {
    telegram = false;
  }

  return {
    whatsapp,
    telegram,
    hasActiveChannel: whatsapp || telegram,
  };
}

function toView(
  business: Business & {
    reminderEnabled?: boolean;
    reminderLeadHours?: number;
    reminderTemplateId?: string;
    defaultServiceBookingEnabled?: boolean;
    defaultBookingServiceId?: string | null;
    appointmentTimeDisplay?: string | null;
  },
  channelReadiness: {
    whatsapp: boolean;
    telegram: boolean;
    hasActiveChannel: boolean;
  },
): BusinessSettingsView {
  return {
    name: business.name,
    vertical: business.vertical ?? "other",
    city: business.city ?? "",
    whatsappNumber: business.whatsappNumber,
    timezone: business.timezone,
    about: business.about ?? "",
    address: business.address ?? "",
    confirmationMode: business.confirmationMode,
    appointmentTimeDisplay:
      business.appointmentTimeDisplay === "FULL_RANGE"
        ? "FULL_RANGE"
        : "START_ONLY",
    cancellationPolicy: business.cancellationPolicy ?? "",
    slotDurationMinutes: business.slotDurationMinutes ?? 30,
    reminderEnabled: business.reminderEnabled ?? false,
    reminderLeadHours: business.reminderLeadHours ?? 24,
    reminderTemplateId: business.reminderTemplateId ?? "standard",
    remindersOperational: areAppointmentRemindersOperational(),
    defaultServiceBookingEnabled:
      business.defaultServiceBookingEnabled ?? false,
    defaultBookingServiceId: business.defaultBookingServiceId ?? null,
    channelReadiness,
  };
}

/** Read the actor's Business settings (ADMIN only, own Business only). */
export async function getBusinessSettings(
  deps: SettingsServiceDeps,
  actor: SettingsActor,
): Promise<BusinessSettingsView | { message: string }> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { message: scope.message };

  const [business, channelReadiness] = await Promise.all([
    deps.businessRepository.findById(scope.businessId),
    resolveChannelReadiness(deps, scope.businessId),
  ]);
  if (!business) return { message: NOT_FOUND_MESSAGE };
  return toView(business, channelReadiness);
}

/** Update the actor's Business settings (ADMIN only, own Business only). */
export async function updateBusinessSettings(
  deps: SettingsServiceDeps,
  actor: SettingsActor,
  input: unknown,
): Promise<SettingsActionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  // Zod strips every unknown key (businessId / role / isActive overrides
  // from hostile payloads never become trusted input).
  const parsed = businessSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "بيانات الإعدادات غير صالحة",
    };
  }

  const business = await deps.businessRepository.findById(scope.businessId);
  if (!business) return { success: false, message: NOT_FOUND_MESSAGE };

  // Validate configured default service if provided
  if (parsed.data.defaultBookingServiceId) {
    if (deps.serviceRepository) {
      const service = await deps.serviceRepository.findByIdWithinBusiness(
        parsed.data.defaultBookingServiceId,
        scope.businessId,
      );
      if (!service || !service.isActive || service.deletedAt) {
        return {
          success: false,
          message: "الخدمة الافتراضية المحددة غير صالحة أو غير مفعّلة",
        };
      }
    }
  }

  const remindersOperational = areAppointmentRemindersOperational();
  const effectiveReminderEnabled = remindersOperational
    ? parsed.data.reminderEnabled
    : false;

  // If operational and enabling reminders, verify that at least one messaging channel is connected & ready
  if (effectiveReminderEnabled) {
    const readiness = await resolveChannelReadiness(deps, scope.businessId);
    if (!readiness.hasActiveChannel) {
      return {
        success: false,
        message: CHANNEL_REQUIRED_FOR_REMINDERS_MESSAGE,
      };
    }
  }

  try {
    // The update targets ONLY the actor's own businessId — a client-
    // supplied businessId cannot redirect this write. `about`/`address` are
    // optional AI information (PROMPT-AI-OPS-21): a blank value is stored as
    // an EMPTY string (the same convention `saveBusinessSetup` uses for
    // `about`), which reads back as "not set" everywhere — readiness treats
    // a blank field as missing and the context builder never carries it.
    const blankToEmpty = (value: string | undefined): string =>
      typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
    await deps.businessRepository.update(scope.businessId, {
      name: parsed.data.name,
      vertical: parsed.data.vertical,
      city: parsed.data.city,
      whatsappNumber: parsed.data.whatsappNumber,
      timezone: parsed.data.timezone,
      about: blankToEmpty(parsed.data.about),
      address: blankToEmpty(parsed.data.address),
      confirmationMode: parsed.data.confirmationMode,
      appointmentTimeDisplay:
        parsed.data.appointmentTimeDisplay ?? "START_ONLY",
      cancellationPolicy: parsed.data.cancellationPolicy,
      reminderEnabled: effectiveReminderEnabled,
      reminderLeadHours: parsed.data.reminderLeadHours,
      reminderTemplateId: parsed.data.reminderTemplateId,
      defaultServiceBookingEnabled:
        parsed.data.defaultServiceBookingEnabled ?? false,
      defaultBookingServiceId: parsed.data.defaultBookingServiceId ?? null,
      ...(parsed.data.slotDurationMinutes !== undefined
        ? { slotDurationMinutes: parsed.data.slotDurationMinutes }
        : {}),
    });
    return { success: true };
  } catch {
    return { success: false, message: "تعذر حفظ الإعدادات الآن" };
  }
}
