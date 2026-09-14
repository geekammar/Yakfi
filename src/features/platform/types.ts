import type { AiProviderId, EffectiveAiPolicy } from "@/lib/validation";

/**
 * Platform Control Plane types (PROMPT-OPS-05). All shapes exclude
 * `tokenHash`: the hash is a storage/lookup concern and must never
 * travel into feature results or UI. Secret references appear as
 * ENV-VAR NAMES only — never key values.
 */

/** Derived owner-invitation lifecycle (no persisted status enum). */
export type PlatformInvitationStatus =
  "PENDING" | "ACCEPTED" | "ACTIVATED" | "EXPIRED";

export type PlatformInvitationView = {
  id: string;
  email: string;
  businessName: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  activatedAt: Date | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PlatformInvitationListItem = PlatformInvitationView & {
  status: PlatformInvitationStatus;
};

export type CreateOwnerInvitationSuccess = {
  invitation: PlatformInvitationView;
  /** The deliverable credential — surfaced exactly once, never stored. */
  rawToken: string;
};

export type ListOwnerInvitationsSuccess = {
  items: PlatformInvitationListItem[];
};

export type GetOwnerInvitationByTokenSuccess = {
  invitation: PlatformInvitationView;
  status: PlatformInvitationStatus;
  businessName: string | null;
};

export type AcceptOwnerInvitationSuccess = {
  invitation: PlatformInvitationView;
};

export type ActivateOwnerAccountSuccess = {
  invitation: PlatformInvitationView;
  userId: string;
  identityCreated: boolean;
};

export type PlatformErrorCode =
  | "FORBIDDEN"
  | "INVALID_INPUT"
  | "INVALID_POLICY"
  | "INVITATION_ALREADY_OPEN"
  | "INVITATION_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_NOT_ACCEPTED"
  | "ACCOUNT_ALREADY_ACTIVATED"
  | "ACCOUNT_CONFLICT"
  | "IDENTITY_CREATION_FAILED"
  | "PERSISTENCE_FAILED";

export type PlatformServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: PlatformErrorCode; message: string } };

/** Server-action results consumed by the Platform UI. */
export type CreateOwnerInvitationResult =
  | { success: true; invitation: PlatformInvitationView; rawToken: string }
  | { success: false; error: { code: PlatformErrorCode; message: string } };

export type UpdateAiPolicyResult =
  | { success: true; policy: AiPolicyView }
  | { success: false; error: { code: PlatformErrorCode; message: string } };

/** Authorization context for platform operations (server-derived). */
export type PlatformActor = {
  userId: string;
  accountType: string;
};

/** The AI policy as displayed/edited in the Platform UI (refs only). */
export type AiPolicyView = {
  primaryProvider: AiProviderId;
  primaryModel: string;
  secondaryProvider: AiProviderId | null;
  secondaryModel: string | null;
  fallbackEnabled: boolean;
  primarySecretRef: string;
  secondarySecretRef: string | null;
  updatedAt: Date;
};

export type GetAiPolicySuccess = {
  policy: AiPolicyView;
  effective: EffectiveAiPolicy;
};

export type UpdateAiPolicySuccess = {
  policy: AiPolicyView;
};

/** Public activation UI result (mirrors the business invitation flow). */
export type OwnerActivationActionResult =
  | {
      status: "SUCCESS";
      email: string;
    }
  | {
      status: "VALIDATION_ERROR";
      message: string;
    }
  | {
      status: "NOTICE";
      state:
        | "INVALID_TOKEN"
        | "EXPIRED"
        | "ALREADY_ACTIVATED"
        | "CONFLICT"
        | "FAILED";
      message?: string;
    };
