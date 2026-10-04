/**
 * Assistant Settings workflow (PROMPT-AI-UX-01).
 *
 * The service layer enforces the authorization rules the route layer relies
 * on: only Business ADMIN users read/mutate the assistant configuration, and
 * the target Business is ALWAYS the actor's own (derived from the trusted
 * session → user record, never from client input). The persisted style is
 * validated against the CLOSED assistant-style enums before any write, so a
 * hostile payload can never widen a dimension or store free text. Repository
 * collaborators are injectable so the workflow logic can be verified without
 * a live database (the settings/knowledge feature pattern).
 */

import {
  assistantSettingsSchema,
  type AssistantSettingsInput,
} from "@/features/assistant/schemas/assistant-schema";
import { HANDOFF_BEHAVIORS } from "@/features/assistant/server/handoff-behaviors";
import type {
  AssistantSettingsActionResult,
  AssistantSettingsView,
} from "@/features/assistant/types";
import type { BusinessRepository } from "@/server/repositories";
import { businessRepository } from "@/server/repositories";
import type { Business, UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type AssistantActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type AssistantServiceDeps = {
  businessRepository: Pick<BusinessRepository, "findById" | "update">;
};

/** Production dependencies (app singletons). */
export const defaultAssistantServiceDeps: AssistantServiceDeps = {
  businessRepository,
};

const FORBIDDEN_MESSAGE = "إعدادات المساعد متاحة للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const NOT_FOUND_MESSAGE = "تعذر العثور على المنشأة";

function resolveScope(
  actor: AssistantActor,
): { ok: true; businessId: string } | { ok: false; message: string } {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

/**
 * Narrow the stored `Business.assistantStyle` JSON through the closed schema
 * itself. Malformed stored JSON (an array, a scalar, a legacy/unknown key, an
 * out-of-set value) degrades to an EMPTY validated object — never throws —
 * so the view reports the resident defaults and a corrupt row can never block
 * a later save.
 */
function readStoredStyle(stored: unknown): AssistantSettingsInput {
  const parsed = assistantSettingsSchema.safeParse(stored);
  return parsed.success ? parsed.data : {};
}

/**
 * Read the business-owned assistant configuration as a serializable view.
 * Malformed/legacy stored JSON degrades to the resident default per
 * dimension (never throws); a null dimension is reported as `null` so the UI
 * can mark it "تلقائي — الإعداد الافتراضي".
 */
function toView(business: Business): AssistantSettingsView {
  const parsed = readStoredStyle(business.assistantStyle);
  const text = (key: keyof AssistantSettingsInput): string | null => {
    const value = parsed[key];
    return typeof value === "string" ? value : null;
  };
  return {
    name: business.assistantName ?? "",
    language: text("language"),
    tone: text("tone"),
    detail: text("detail"),
    emoji: text("emoji"),
  };
}

/**
 * The read-only handoff behaviors (SECTION F). Re-exported from the pure
 * module so the page has one import surface; see
 * `src/features/assistant/server/handoff-behaviors.ts` for the binding rules
 * (platform-enforced, never switchable by a Business Admin).
 */
export { HANDOFF_BEHAVIORS };

/** Read the actor's assistant settings (ADMIN only, own Business only). */
export async function getAssistantSettings(
  deps: AssistantServiceDeps,
  actor: AssistantActor,
): Promise<AssistantSettingsView | { message: string }> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { message: scope.message };

  const business = await deps.businessRepository.findById(scope.businessId);
  if (!business) return { message: NOT_FOUND_MESSAGE };
  return toView(business);
}

/**
 * Update the actor's assistant settings (ADMIN only, own Business only).
 * A PARTIAL save is valid: only the sent dimensions are overwritten; every
 * other dimension keeps its current value (or the resident default).
 */
export async function updateAssistantSettings(
  deps: AssistantServiceDeps,
  actor: AssistantActor,
  input: unknown,
): Promise<AssistantSettingsActionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  // Zod strips every unknown key and validates every dimension against its
  // CLOSED enum — a hostile payload carrying a provider, a model, a prompt,
  // or an out-of-set style value can never become trusted input.
  const parsed = assistantSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message:
        parsed.error.issues[0]?.message ?? "بيانات إعدادات المساعد غير صالحة",
    };
  }

  const business = await deps.businessRepository.findById(scope.businessId);
  if (!business) return { success: false, message: NOT_FOUND_MESSAGE };

  try {
    // The update targets ONLY the actor's own businessId — a client-supplied
    // businessId cannot redirect this write. `name` is display copy: a blank
    // value clears the stored name so the fallback «المساعد الذكي» applies.
    const nextName =
      typeof parsed.data.name === "string" && parsed.data.name.trim().length > 0
        ? parsed.data.name.trim()
        : null;

    // Merge the sent dimensions over the CURRENT validated style so a partial
    // save never erases a previously saved dimension and a corrupt row can
    // never block the save. Both halves are already validated, so the merged
    // object can only ever hold in-set values; the final parse re-validates
    // and strips any residual key (never throws).
    const merged = assistantSettingsSchema.parse({
      ...readStoredStyle(business.assistantStyle),
      ...parsed.data,
    });

    await deps.businessRepository.update(scope.businessId, {
      assistantName: nextName,
      assistantStyle: merged,
    });
    return { success: true };
  } catch {
    return { success: false, message: "تعذر حفظ إعدادات المساعد الآن" };
  }
}
