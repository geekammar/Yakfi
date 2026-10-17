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

import { businessSettingsSchema } from "@/features/settings/schemas/settings-schema";
import type {
  BusinessSettingsView,
  SettingsActionResult,
} from "@/features/settings/types";
import type { BusinessRepository } from "@/server/repositories";
import { businessRepository } from "@/server/repositories";
import type { Business, UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type SettingsActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type SettingsServiceDeps = {
  businessRepository: Pick<BusinessRepository, "findById" | "update">;
};

/** Production dependencies (app singletons). */
export const defaultSettingsServiceDeps: SettingsServiceDeps = {
  businessRepository,
};

const FORBIDDEN_MESSAGE = "الإعدادات متاحة للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const NOT_FOUND_MESSAGE = "تعذر العثور على المنشأة";

function resolveScope(
  actor: SettingsActor,
): { ok: true; businessId: string } | { ok: false; message: string } {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

function toView(business: Business): BusinessSettingsView {
  return {
    name: business.name,
    vertical: business.vertical ?? "other",
    city: business.city ?? "",
    whatsappNumber: business.whatsappNumber,
    timezone: business.timezone,
    about: business.about ?? "",
    address: business.address ?? "",
    confirmationMode: business.confirmationMode,
    cancellationPolicy: business.cancellationPolicy ?? "",
    slotDurationMinutes: business.slotDurationMinutes ?? 30,
  };
}

/** Read the actor's Business settings (ADMIN only, own Business only). */
export async function getBusinessSettings(
  deps: SettingsServiceDeps,
  actor: SettingsActor,
): Promise<BusinessSettingsView | { message: string }> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { message: scope.message };

  const business = await deps.businessRepository.findById(scope.businessId);
  if (!business) return { message: NOT_FOUND_MESSAGE };
  return toView(business);
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
      cancellationPolicy: parsed.data.cancellationPolicy,
      ...(parsed.data.slotDurationMinutes !== undefined
        ? { slotDurationMinutes: parsed.data.slotDurationMinutes }
        : {}),
    });
    return { success: true };
  } catch {
    return { success: false, message: "تعذر حفظ الإعدادات الآن" };
  }
}
