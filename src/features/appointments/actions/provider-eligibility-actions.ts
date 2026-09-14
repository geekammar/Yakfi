"use server";

import {
  defaultProviderEligibilityServiceDeps,
  resolveEligibleProviders,
  type ProviderEligibilityActor,
} from "@/features/appointments/server/provider-eligibility-service";
import type { ProviderEligibilityResult } from "@/features/appointments/types";
import { requireUser } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

/**
 * Provider eligibility read action (PROMPT-CORE-01) — the integration
 * hook for the Conversation layer and the Any-Provider flow (CORE-02).
 * Thin wrapper only: the actor's Business is ALWAYS derived
 * server-side from the persisted user (a client-provided businessId
 * can never override it), and all rules live in the eligibility
 * resolver.
 */
export async function resolveEligibleProvidersAction(
  input: unknown,
): Promise<ProviderEligibilityResult> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  // No user record (deleted mid-session) → least privilege: no
  // Business can never read eligibility.
  const actor: ProviderEligibilityActor = {
    businessId: user?.businessId ?? null,
  };
  return resolveEligibleProviders(
    defaultProviderEligibilityServiceDeps,
    actor,
    input,
  );
}
