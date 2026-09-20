"use server";

import { whatsappOnboardingValidation } from "@/features/whatsapp-onboarding/schemas/whatsapp-onboarding-schema";
import { deterministicConnectionAuthorizer } from "@/features/whatsapp-onboarding/server/deterministic-connection-authorizer";
import {
  beginWhatsAppOnboarding,
  getOnboardingStatus,
  handleWhatsAppAuthorizationCallback,
  resolveOnboardingCallbackUrl,
  type WhatsAppOnboardingServiceDeps,
} from "@/features/whatsapp-onboarding/server/whatsapp-onboarding-service";
import type {
  BeginWhatsAppOnboardingResult,
  HandleWhatsAppAuthorizationCallbackResult,
  WhatsAppOnboardingActor,
  WhatsAppOnboardingView,
} from "@/features/whatsapp-onboarding/types";
import { requireUser } from "@/server/auth/guards";
import { createMetaEmbeddedSignupConnectionAuthorizer } from "@/server/integrations/whatsapp/meta-embedded-signup-authorizer";
import { resolveMetaOnboardingConfig } from "@/server/integrations/whatsapp/meta-onboarding-config";
import {
  businessRepository,
  userRepository,
  whatsAppConnectionRepository,
  whatsAppOnboardingAuthorizationRepository,
} from "@/server/repositories";

import { revalidatePath } from "next/cache";

/**
 * Server-side authorization context derived from the authenticated
 * session + the database-backed user record. The Business is ALWAYS
 * derived server-side — a client-provided businessId can never override
 * it (the service layer re-checks role + scope on every operation).
 */
async function currentActor(): Promise<WhatsAppOnboardingActor> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  return {
    userId: session.user.id,
    // No user record (deleted mid-session) → least privilege: STAFF
    // with no Business can never start a WhatsApp onboarding.
    role: user?.role ?? "STAFF",
    businessId: user?.businessId ?? null,
  };
}

/**
 * Production dependencies. The authorizer is resolved per request:
 *
 * - when the operator-owned Meta Embedded Signup configuration resolves
 *   (`WHATSAPP_META_APP_ID` + `WHATSAPP_META_APP_SECRET` +
 *   `WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID`), the REAL Meta adapter is
 *   wired — a real OAuth dialog launch, a real server-side code exchange,
 *   and opaque runtime credential persistence;
 * - otherwise the DETERMINISTIC stand-in stays wired, so the offline
 *   harness and any environment without the configuration keep behaving
 *   exactly as before (no invented values, no fake success path is
 *   added by this resolution).
 *
 * Both implement the same provider-neutral `ConnectionAuthorizer` port —
 * no feature change either way.
 */
function resolveConnectionAuthorizer() {
  return resolveMetaOnboardingConfig().ok
    ? createMetaEmbeddedSignupConnectionAuthorizer()
    : deterministicConnectionAuthorizer;
}

function deps(): WhatsAppOnboardingServiceDeps {
  return {
    connectionRepository: whatsAppConnectionRepository,
    authorizationRepository: whatsAppOnboardingAuthorizationRepository,
    businessRepository,
    authorizer: resolveConnectionAuthorizer(),
    generateStateRef: () => crypto.randomUUID(),
    now: () => new Date(),
  };
}

function revalidateOnboardingSurfaces() {
  revalidatePath("/onboarding/review");
  revalidatePath("/settings/whatsapp");
  revalidatePath("/settings");
}

export async function getWhatsAppOnboardingStatusAction(): Promise<WhatsAppOnboardingView> {
  return getOnboardingStatus(
    { connectionRepository: whatsAppConnectionRepository },
    await currentActor(),
  );
}

/**
 * Launch the provider authorization for the actor's own Business
 * (ADMIN only). Only safe launch information crosses to the client —
 * no token, no provider internals.
 */
export async function beginWhatsAppOnboardingAction(): Promise<BeginWhatsAppOnboardingResult> {
  const result = await beginWhatsAppOnboarding(deps(), await currentActor(), {
    redirectUri: resolveOnboardingCallbackUrl(),
  });
  if (result.success) revalidateOnboardingSurfaces();
  return result;
}

/**
 * Complete the provider authorization from the app's own callback
 * route. The target Business comes EXCLUSIVELY from the persisted
 * authorization attempt — never from the payload or the session.
 */
export async function completeWhatsAppAuthorizationAction(
  input: unknown,
): Promise<HandleWhatsAppAuthorizationCallbackResult> {
  const parsed = whatsappOnboardingValidation.callback.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "AUTHORIZATION_STATE_UNKNOWN",
      message: "بيانات تفويض واتساب غير صالحة",
    };
  }
  const result = await handleWhatsAppAuthorizationCallback(deps(), {
    stateRef: parsed.data.state,
    code: parsed.data.code,
    redirectUri: resolveOnboardingCallbackUrl(),
  });
  if (result.success) revalidateOnboardingSurfaces();
  return result;
}
