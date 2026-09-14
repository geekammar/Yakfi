"use server";

import { activateOwnerInputSchema } from "@/features/platform/schemas/platform-schema";
import { updateAiPolicy } from "@/features/platform/server/ai-policy-service";
import {
  acceptOwnerInvitation,
  activateOwnerAccount,
  createOwnerInvitation,
} from "@/features/platform/server/owner-invitation-service";
import type {
  CreateOwnerInvitationResult,
  OwnerActivationActionResult,
  UpdateAiPolicyResult,
} from "@/features/platform/types";
import { requirePlatformOperator } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

import { revalidatePath } from "next/cache";

/**
 * Server-side authorization context derived from the authenticated
 * Platform Operator session + the database-backed user record. The
 * account type is ALWAYS derived from the persisted user — a client
 * can never choose it, and a stale session cannot grant platform
 * privileges.
 */
async function currentActor(): Promise<{
  userId: string;
  accountType: string;
} | null> {
  const session = await requirePlatformOperator();
  const user = await userRepository.findById(session.user.id);
  if (!user) return null;
  return { userId: user.id, accountType: user.accountType };
}

function toFailure(error: {
  code: string;
  message: string;
}): CreateOwnerInvitationResult {
  return {
    success: false,
    error: {
      code: error.code as Exclude<
        CreateOwnerInvitationResult,
        { success: true }
      >["error"]["code"],
      message: error.message,
    },
  };
}

/**
 * THE canonical Business Owner invitation action (PROMPT-OPS-05).
 * Platform Operator only; every rule (platform-only, one OPEN
 * invitation per email, hash-only token, 7-day expiry) lives in the
 * owner-invitation service. On success the raw token is returned
 * exactly once for one-time manual delivery.
 */
export async function createOwnerInvitationAction(
  input: unknown,
): Promise<CreateOwnerInvitationResult> {
  const actor = await currentActor();
  if (!actor) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
      },
    };
  }
  const result = await createOwnerInvitation(actor, input);
  if (!result.success) return toFailure(result.error);
  revalidatePath("/platform/invitations");
  return {
    success: true,
    invitation: result.data.invitation,
    rawToken: result.data.rawToken,
  };
}

/**
 * Updates the platform AI provider policy. Platform Operator only;
 * invalid provider/model configurations are rejected server-side.
 */
export async function updateAiPolicyAction(
  input: unknown,
): Promise<UpdateAiPolicyResult> {
  const actor = await currentActor();
  if (!actor) {
    return {
      success: false,
      error: {
        code: "FORBIDDEN",
        message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
      },
    };
  }
  const result = await updateAiPolicy(actor, input);
  if (!result.success) {
    return {
      success: false,
      error: {
        code: result.error.code as Exclude<
          UpdateAiPolicyResult,
          { success: true }
        >["error"]["code"],
        message: result.error.message,
      },
    };
  }
  revalidatePath("/platform/ai-policy");
  revalidatePath("/platform");
  return { success: true, policy: result.data.policy };
}

/**
 * Public server action behind the owner activation screen
 * (PROMPT-OPS-05). The invitee is not authenticated — the invitation
 * token itself is the credential, and the composed services enforce
 * its lifecycle server-side. One submission completes acceptance +
 * activation; the result renders as a typed Arabic UI state.
 */
export async function completeOwnerActivationAction(
  input: unknown,
): Promise<OwnerActivationActionResult> {
  const parsed = activateOwnerInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      status: "VALIDATION_ERROR",
      message: parsed.error.issues[0]?.message ?? "بيانات التفعيل غير صالحة",
    };
  }

  // Acceptance first — INVITATION-style "already accepted" is the
  // resume path of an interrupted activation (identity may exist).
  const accepted = await acceptOwnerInvitation({ token: parsed.data.token });
  if (
    !accepted.success &&
    accepted.error.code !== "ACCOUNT_ALREADY_ACTIVATED"
  ) {
    return toActivationNotice(accepted.error.code, accepted.error.message);
  }

  const activated = await activateOwnerAccount({
    token: parsed.data.token,
    name: parsed.data.name,
    password: parsed.data.password,
  });
  if (!activated.success) {
    return toActivationNotice(activated.error.code, activated.error.message);
  }

  revalidatePath("/platform/invitations");
  return { status: "SUCCESS", email: activated.data.invitation.email };
}

function toActivationNotice(
  code: string,
  message: string,
): OwnerActivationActionResult {
  switch (code) {
    case "INVITATION_NOT_FOUND":
      return { status: "NOTICE", state: "INVALID_TOKEN", message };
    case "INVITATION_EXPIRED":
      return { status: "NOTICE", state: "EXPIRED", message };
    case "ACCOUNT_ALREADY_ACTIVATED":
      return { status: "NOTICE", state: "ALREADY_ACTIVATED", message };
    case "ACCOUNT_CONFLICT":
      return { status: "NOTICE", state: "CONFLICT", message };
    default:
      return { status: "NOTICE", state: "FAILED", message };
  }
}
