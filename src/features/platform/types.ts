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
  | "BUSINESS_NOT_FOUND"
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
  /**
   * The OPTIONAL OpenRouter provider endpoint pin
   * (PROMPT-AI-OPS-28 — e.g. `decart/fp4`). A routing slug only: not a
   * secret, not a key, not a credential. Null ⇒ OpenRouter default routing.
   */
  openRouterProviderOnly: string | null;
  updatedAt: Date;
};

export type GetAiPolicySuccess = {
  policy: AiPolicyView;
  effective: EffectiveAiPolicy;
};

export type UpdateAiPolicySuccess = {
  policy: AiPolicyView;
};

// ─── Business onboarding read model (WHATSAPP-ONBOARDING-01) ────────────────

/**
 * Safe, explicitly-projected read model for the platform operator —
 * a DB row NEVER reaches the UI. Secrets are structurally absent: no
 * `credentialsRef` (the reference itself is omitted; only its KIND
 * appears), no provider token, no authorization code, no raw provider
 * response. Provider identities appear MASKED.
 */
export type BusinessOnboardingOverview = {
  business: {
    businessId: string;
    displayName: string;
    /** Non-secret display reference of the Business's first ADMIN. */
    adminName: string | null;
    adminEmail: string | null;
    isActive: boolean;
    onboardingCompletedAt: string | null;
    createdAt: string;
  };
  whatsapp: {
    connectionExists: boolean;
    /** Safe correlation id for support — NOT a provider id. */
    connectionId: string | null;
    provider: string | null;
    /** MASKED display phone (never the raw E.164 line). */
    displayPhoneMasked: string | null;
    /** MASKED provider connection identity (phone_number_id). */
    externalIdMasked: string | null;
    operationalStatus: string | null;
    isActive: boolean | null;
    credentialKind: string | null;
  };
  metaProvenance: {
    metaBusinessId: string | null;
    wabaId: string | null;
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    metaReviewStatus: string | null;
  };
  onboarding: {
    onboardingState: string;
    onboardingActor: string;
    onboardingReasonCode: string | null;
    onboardingReasonSummary: string | null;
    onboardingRetryable: boolean | null;
    onboardingStateChangedAt: string | null;
    onboardingCompletedAt: string | null;
    onboardingFailedAt: string | null;
  };
  operations: {
    /** Last verification outcome (existing convention: status). */
    lastVerificationResult: string | null;
    /** Last verification time (existing convention: updatedAt). */
    lastVerificationAt: string | null;
    /** Last onboarding lifecycle move where derivable. */
    lastProvisioningSignalAt: string | null;
    /** The existing safe correlation identifier. */
    operationRef: string | null;
  };
};

export type BusinessOnboardingListItem = Pick<
  BusinessOnboardingOverview,
  "business"
> & {
  connectionExists: boolean;
  provider: string | null;
  displayPhoneMasked: string | null;
  operationalStatus: string | null;
  whatsappIsActive: boolean | null;
  onboardingState: string;
  onboardingReasonSummary: string | null;
  onboardingRetryable: boolean | null;
  onboardingCompletedAt: string | null;
};

export type ListBusinessOnboardingSuccess = {
  items: BusinessOnboardingListItem[];
  total: number;
  page: number;
  pageSize: number;
};

export type GetBusinessOnboardingOverviewSuccess = {
  overview: BusinessOnboardingOverview;
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
