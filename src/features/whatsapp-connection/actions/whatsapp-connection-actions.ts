"use server";

import {
  defaultWhatsAppConnectionServiceDeps,
  disconnectConnection,
  reactivateConnection,
  saveConnection,
  verifyConnection,
  type WhatsAppConnectionActor,
} from "@/features/whatsapp-connection/server/whatsapp-connection-service";
import type {
  WhatsAppConnectionActionResult,
  WhatsAppVerificationResult,
} from "@/features/whatsapp-connection/types";
import { refreshWhatsAppOnboardingReadiness } from "@/features/whatsapp-onboarding/server/whatsapp-onboarding-service";
import type { WhatsAppOnboardingActor } from "@/features/whatsapp-onboarding/types";
import { requireUser } from "@/server/auth/guards";
import { createDefaultMetaConnectionVerifier } from "@/server/integrations/whatsapp/meta-verify";
import {
  userRepository,
  whatsAppConnectionRepository,
} from "@/server/repositories";

import { revalidatePath } from "next/cache";

/**
 * Builds the authorization context from the authenticated session + the
 * database-backed user record. The Business is ALWAYS derived
 * server-side — a client-provided businessId can never override it
 * (the service layer re-checks role + scope on every operation).
 */
async function currentActor(): Promise<WhatsAppConnectionActor> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  return {
    userId: session.user.id,
    // No user record (deleted mid-session) → least privilege: STAFF
    // with no Business can never touch a WhatsApp connection.
    role: user?.role ?? "STAFF",
    businessId: user?.businessId ?? null,
  };
}

/** The same authenticated context, typed for the onboarding service. */
function onboardingActor(
  actor: WhatsAppConnectionActor,
): WhatsAppOnboardingActor {
  return {
    userId: actor.userId,
    role: actor.role,
    businessId: actor.businessId,
  };
}

/**
 * The Meta verifier is wired HERE (the action layer), exactly like the
 * Meta transport is wired at the Meta route: the feature service stays
 * provider-neutral and only the adapter owns Meta specifics.
 */
function deps() {
  return defaultWhatsAppConnectionServiceDeps(
    createDefaultMetaConnectionVerifier(),
  );
}

function revalidateConnectionSurfaces() {
  revalidatePath("/settings/whatsapp");
  revalidatePath("/settings");
  // Conversations depend on a resolvable connection for inbound/outbound.
  revalidatePath("/conversations");
}

export async function saveWhatsAppConnectionAction(
  input: unknown,
): Promise<WhatsAppConnectionActionResult> {
  const result = await saveConnection(deps(), await currentActor(), input);
  if (result.success) revalidateConnectionSurfaces();
  return result;
}

export async function verifyWhatsAppConnectionAction(
  connectionId: string,
): Promise<WhatsAppVerificationResult> {
  const actor = await currentActor();
  const result = await verifyConnection(deps(), actor, connectionId);
  if (result.success) {
    // A successful read-only verification is the ONLY path that
    // establishes operational readiness, so it also completes the
    // onboarding lifecycle when a provider authorization exists. The
    // onboarding write is guarded (CONNECTED + active + a
    // post-authorization state) and never affects the runtime gate.
    await refreshWhatsAppOnboardingReadiness(
      {
        connectionRepository: whatsAppConnectionRepository,
        now: () => new Date(),
      },
      onboardingActor(actor),
    );
    revalidateConnectionSurfaces();
  }
  return result;
}

export async function disconnectWhatsAppConnectionAction(
  connectionId: string,
): Promise<WhatsAppConnectionActionResult> {
  const result = await disconnectConnection(
    deps(),
    await currentActor(),
    connectionId,
  );
  if (result.success) revalidateConnectionSurfaces();
  return result;
}

export async function reactivateWhatsAppConnectionAction(
  connectionId: string,
): Promise<WhatsAppConnectionActionResult> {
  const result = await reactivateConnection(
    deps(),
    await currentActor(),
    connectionId,
  );
  if (result.success) revalidateConnectionSurfaces();
  return result;
}
