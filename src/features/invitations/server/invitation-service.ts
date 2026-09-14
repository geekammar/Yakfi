import type { Invitation, UserRole } from "@/generated/prisma/client";

import {
  acceptInvitationInputSchema,
  activateAdminAccountInputSchema,
  createInvitationInputSchema,
  listInvitationsInputSchema,
  revokeInvitationInputSchema,
} from "@/features/invitations/schemas/invitation-schema";
import type {
  AcceptInvitationSuccess,
  ActivateInvitedAccountSuccess,
  CreateInvitationSuccess,
  GetInvitationByTokenSuccess,
  InvitationErrorCode,
  InvitationListItem,
  InvitationServiceResult,
  InvitationView,
  ListInvitationsSuccess,
  RevokeInvitationSuccess,
} from "@/features/invitations/types";
import { auth } from "@/lib/auth";
import {
  businessRepository,
  invitationRepository,
  userRepository,
} from "@/server/repositories";
import type { BusinessRepository } from "@/server/repositories/business.repository";
import type {
  ActivateInvitedMemberOutcome,
  InvitationRepository,
} from "@/server/repositories/invitation.repository";
import { InvitationActivationConflictError } from "@/server/repositories/invitation.repository";
import type { UserRepository } from "@/server/repositories/user.repository";
import {
  generateInvitationToken,
  hashInvitationToken,
} from "@/server/security/invitation-token";

import { APIError } from "better-auth/api";

/**
 * Invitation creation + acceptance + invited-account activation
 * (DECISIONS #22 / #23 / #24; STAFF activation generalized in
 * PROMPT-16): secure token creation (hash-only persistence),
 * business-scoped listing, revocation, one-time token-based
 * acceptance, and activation of an accepted invitation into a real
 * Better Auth identity with the Business membership the invitation
 * carries (ADMIN or STAFF — the persisted invitation is the role
 * authority). Delivery is manual (the raw token is surfaced exactly
 * once to the inviting ADMIN); there is no email infrastructure.
 *
 * Security invariants:
 * - The raw token is generated here and returned ONCE in the creation
 *   result. It is never persisted, logged, or included in errors.
 * - Acceptance/activation hash the caller's raw token with the existing
 *   security utility and locate the invitation by `tokenHash` only.
 * - Everything returned to callers excludes `tokenHash`.
 * - Creation/revocation are business-scoped; acceptance/activation are
 *   token-scoped by design (the caller is not yet authenticated).
 * - Activation never creates a second identity for an email, never
 *   resets an existing password, and never silently changes a role.
 *
 * Repository collaborators are injectable (defaulting to the app
 * singletons) so the workflow logic can be verified without a live
 * database — the database-backed guarantees remain the repository's
 * responsibility and are verified against a real database at
 * integration/deploy time.
 */

/** Centralized expiry policy: expiresAt = createdAt + TTL. */
export const INVITATION_EXPIRY_DAYS = 7;

export function invitationExpiresAt(from: Date = new Date()): Date {
  return new Date(
    from.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );
}

/**
 * Derived lifecycle status (no persisted enum). Precedence:
 * accepted (activated) > accepted > revoked > expired > pending.
 * `expiresAt <= now` means expired; "open" invitations are exactly the
 * PENDING ones. ACTIVATED = accepted + account activation completed
 * (`activatedAt` set exactly once by the activation workflow).
 */
export function deriveInvitationStatus(
  invitation: Pick<
    Invitation,
    "acceptedAt" | "revokedAt" | "expiresAt" | "activatedAt"
  >,
  now: Date = new Date(),
): InvitationListItem["status"] {
  if (invitation.acceptedAt) {
    return invitation.activatedAt ? "ACTIVATED" : "ACCEPTED";
  }
  if (invitation.revokedAt) return "REVOKED";
  if (invitation.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "PENDING";
}

function toView(invitation: Invitation): InvitationView {
  return {
    id: invitation.id,
    businessId: invitation.businessId,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    revokedAt: invitation.revokedAt,
    activatedAt: invitation.activatedAt,
    invitedById: invitation.invitedById,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
  };
}

function toListItem(invitation: Invitation, now: Date): InvitationListItem {
  return {
    ...toView(invitation),
    status: deriveInvitationStatus(invitation, now),
  };
}

function invalidInput(issues: { message: string }[]) {
  return {
    success: false as const,
    error: {
      code: "INVALID_INPUT" as const,
      message: issues[0]?.message ?? "بيانات الدعوة غير صالحة",
    },
  };
}

function failure(code: InvitationErrorCode, message: string) {
  return { success: false as const, error: { code, message } };
}

/**
 * Outcome of the identity-creation dependency. `EXISTS` is a race-safe
 * signal (identity appeared between the pre-check and creation); the
 * workflow re-reads and classifies it — it never creates a duplicate.
 */
export type CreateIdentityResult =
  | { status: "CREATED"; userId: string }
  | { status: "EXISTS" }
  | { status: "INVALID_PASSWORD" }
  | { status: "FAILED" };

/**
 * Narrow boundary to Better Auth for email/password identity creation.
 * The default implementation uses the installed version's official
 * server-side endpoint (`auth.api.signUpEmail`) — Better Auth owns the
 * password hash, the credential account row, and any session. Only the
 * safe `user.id` crosses back into the domain; the session token is
 * discarded and never logged.
 */
export type IdentityCreator = (input: {
  email: string;
  name: string;
  password: string;
}) => Promise<CreateIdentityResult>;

/**
 * The default Better Auth identity creator — the SINGLE source of
 * server-side credential creation (shared with the Platform Control
 * Plane's owner-invitation activation, PROMPT-OPS-05).
 */
export const defaultCreateIdentity: IdentityCreator = async (input) => {
  try {
    const result = await auth.api.signUpEmail({
      body: {
        email: input.email,
        name: input.name,
        password: input.password,
      },
    });
    return { status: "CREATED", userId: result.user.id };
  } catch (error) {
    if (error instanceof APIError) {
      const code = error.body?.code;
      if (
        code === "USER_ALREADY_EXISTS" ||
        code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
      ) {
        return { status: "EXISTS" };
      }
      if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") {
        return { status: "INVALID_PASSWORD" };
      }
    }
    return { status: "FAILED" };
  }
};

/** Narrow repository surface the service depends on (injectable). */
export type InvitationServiceDeps = Readonly<{
  invitations: Pick<
    InvitationRepository,
    | "createIfNoOpenInvitation"
    | "findByIdWithinBusiness"
    | "listByBusiness"
    | "revoke"
    | "findByTokenHash"
    | "acceptPendingInvitation"
    | "activateInvitedMember"
  >;
  businesses: Pick<BusinessRepository, "findById">;
  users: Pick<UserRepository, "findByEmail">;
  createIdentity: IdentityCreator;
}>;

const defaultDeps: InvitationServiceDeps = {
  invitations: invitationRepository,
  businesses: businessRepository,
  users: userRepository,
  createIdentity: defaultCreateIdentity,
};

/**
 * Creates an invitation for one Business. Duplicate OPEN invitations
 * (same Business + normalized email, not accepted/revoked/expired) are
 * rejected; expired, revoked, and accepted invitations never block a
 * new one. On success the raw token is returned exactly once — the
 * caller delivers it; only its hash was persisted.
 */
export async function createInvitation(
  input: unknown,
  deps: InvitationServiceDeps = defaultDeps,
): Promise<InvitationServiceResult<CreateInvitationSuccess>> {
  const parsed = createInvitationInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const business = await deps.businesses.findById(parsed.data.businessId);
  if (!business) {
    return failure("BUSINESS_NOT_FOUND", "المنشأة غير موجودة");
  }

  const { rawToken, tokenHash } = generateInvitationToken();

  let invitation: Invitation | null;
  try {
    invitation = await deps.invitations.createIfNoOpenInvitation({
      businessId: parsed.data.businessId,
      email: parsed.data.email,
      role: parsed.data.role,
      tokenHash,
      expiresAt: invitationExpiresAt(),
      ...(parsed.data.invitedById !== undefined
        ? { invitedById: parsed.data.invitedById }
        : {}),
    });
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر إنشاء الدعوة الآن");
  }
  if (!invitation) {
    return failure(
      "INVITATION_ALREADY_OPEN",
      "توجد دعوة فعالة لهذا البريد بالفعل",
    );
  }

  return { success: true, data: { invitation: toView(invitation), rawToken } };
}

/**
 * Business-scoped listing (newest first, paginated). There is no global
 * invitation listing. Items carry the derived lifecycle status and never
 * include the token hash.
 */
export async function listInvitations(
  input: unknown,
  deps: InvitationServiceDeps = defaultDeps,
): Promise<InvitationServiceResult<ListInvitationsSuccess>> {
  const parsed = listInvitationsInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  let invitations: Invitation[];
  try {
    invitations = await deps.invitations.listByBusiness(
      parsed.data.businessId,
      {
        page: parsed.data.page,
        pageSize: parsed.data.pageSize,
      },
    );
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر تحميل الدعوات الآن");
  }

  const now = new Date();
  return {
    success: true,
    data: { items: invitations.map((i) => toListItem(i, now)) },
  };
}

/**
 * Revokes an invitation within the Business scope.
 * - unknown id / other Business → not found
 * - accepted → invalid state (acceptance is terminal)
 * - already revoked → idempotent success (no destructive repeat)
 * - pending (including expired-pending) → revoked
 * Acceptance is NOT implemented here.
 */
export async function revokeInvitation(
  input: unknown,
  deps: InvitationServiceDeps = defaultDeps,
): Promise<InvitationServiceResult<RevokeInvitationSuccess>> {
  const parsed = revokeInvitationInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const invitation = await deps.invitations.findByIdWithinBusiness(
    parsed.data.invitationId,
    parsed.data.businessId,
  );
  if (!invitation) {
    return failure("INVITATION_NOT_FOUND", "الدعوة غير موجودة");
  }
  if (invitation.acceptedAt) {
    return failure("INVALID_INVITATION_STATE", "لا يمكن إلغاء دعوة تم قبولها");
  }
  if (invitation.revokedAt) {
    return { success: true, data: { invitation: toView(invitation) } };
  }

  let revoked: Invitation | null;
  try {
    revoked = await deps.invitations.revoke(
      parsed.data.invitationId,
      parsed.data.businessId,
    );
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر إلغاء الدعوة الآن");
  }
  if (!revoked) {
    return failure("INVITATION_NOT_FOUND", "الدعوة غير موجودة");
  }

  return { success: true, data: { invitation: toView(revoked) } };
}

/**
 * Classifies a located invitation that is no longer acceptable.
 * Distinct codes (already accepted / revoked / expired) are safe to
 * reveal only because the caller already presented the valid token;
 * an unknown token never reaches this helper. An ACTIVATED invitation
 * was necessarily accepted first.
 */
function classifyUnacceptableInvitation(
  invitation: Invitation,
): InvitationServiceResult<never> {
  const status = deriveInvitationStatus(invitation);
  switch (status) {
    case "ACCEPTED":
    case "ACTIVATED":
      return failure(
        "INVITATION_ALREADY_ACCEPTED",
        "تم قبول هذه الدعوة بالفعل",
      );
    case "REVOKED":
      return failure("INVITATION_REVOKED", "تم إلغاء هذه الدعوة");
    default:
      return failure("INVITATION_EXPIRED", "انتهت صلاحية هذه الدعوة");
  }
}

/**
 * Accepts an invitation by RAW token — one-time, atomic, token-scoped.
 *
 * Flow: validate → hash (existing security utility) → locate by
 * tokenHash → enforce the lifecycle (pending + unrevoked + unexpired;
 * the centralized expiry policy is already applied at creation and
 * enforced here at the workflow layer) → conditionally transition to
 * ACCEPTED in a single repository transaction → return the safe
 * invitation context for the next step (account activation).
 *
 * Security properties:
 * - The token is the lookup boundary: no caller-supplied
 *   businessId/email/role exists on this path, and the persisted
 *   invitation is the sole authority for those values.
 * - Unknown/invalid tokens get one generic not-found error — the
 *   message does not help differentiate token states.
 * - One-time acceptance: a second attempt (sequential or concurrent)
 *   fails with INVITATION_ALREADY_ACCEPTED. If a concurrent request
 *   won the conditional update, the current state is re-read and
 *   classified; acceptance never succeeds twice.
 * - The result excludes the raw token and the token hash; neither is
 *   ever logged.
 */
export async function acceptInvitation(
  input: unknown,
  deps: InvitationServiceDeps = defaultDeps,
): Promise<InvitationServiceResult<AcceptInvitationSuccess>> {
  const parsed = acceptInvitationInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const tokenHash = hashInvitationToken(parsed.data.token);

  const invitation = await deps.invitations.findByTokenHash(tokenHash);
  if (!invitation) {
    return failure(
      "INVITATION_NOT_FOUND",
      "الدعوة غير موجودة أو الرمز غير صالح",
    );
  }
  if (deriveInvitationStatus(invitation) !== "PENDING") {
    return classifyUnacceptableInvitation(invitation);
  }

  let accepted: Invitation | null;
  try {
    accepted = await deps.invitations.acceptPendingInvitation(tokenHash);
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر قبول الدعوة الآن");
  }
  if (!accepted) {
    // Zero rows updated: a concurrent request accepted, revoked, or
    // expired the invitation between the pre-check and the conditional
    // update. Fail safely by classifying the persisted state now.
    const current = await deps.invitations.findByTokenHash(tokenHash);
    if (!current) {
      return failure(
        "INVITATION_NOT_FOUND",
        "الدعوة غير موجودة أو الرمز غير صالح",
      );
    }
    return classifyUnacceptableInvitation(current);
  }

  return { success: true, data: { invitation: toView(accepted) } };
}

/**
 * Classifies an existing identity found for the invitation email.
 * Safe to link (returns the userId) only when the identity belongs to
 * no Business (never-assigned — the interrupted-activation recovery
 * path) or is already a member of the invitation's own Business with
 * the invitation's own role (idempotent resume). Everything else is a
 * typed conflict — the identity is never silently moved, and its role
 * is never silently changed.
 */
function classifyExistingUser(
  user: { id: string; businessId: string | null; role: UserRole },
  invitation: Invitation,
): { userId: string } | { failure: ReturnType<typeof failure> } {
  if (user.businessId !== null && user.businessId !== invitation.businessId) {
    return {
      failure: failure(
        "ACCOUNT_CONFLICT",
        "هذا البريد مرتبط بحساب في منشأة أخرى",
      ),
    };
  }
  if (
    user.businessId === invitation.businessId &&
    user.role !== invitation.role
  ) {
    return {
      failure: failure(
        "ACCOUNT_CONFLICT",
        "هذا البريد مرتبط بالمنشأة بدور مختلف",
      ),
    };
  }
  return { userId: user.id };
}

/**
 * Read-only invitation lookup by RAW token for the activation screen
 * (PROMPT-06). Performs NO mutation — the one-time acceptance runs at
 * submit time, never on page load. Hashes the token with the existing
 * security utility and locates the invitation by `tokenHash` only.
 *
 * Security properties:
 * - Token-scoped like acceptance: the persisted invitation is the sole
 *   authority for email/businessId/role.
 * - Unknown/malformed tokens get the same generic not-found error as
 *   acceptance — the message does not help differentiate token states.
 * - The result excludes the raw token and the token hash; neither is
 *   ever logged.
 * - Distinct lifecycle states (accepted / revoked / expired) are safe
 *   to reveal only because the caller already presented a valid token.
 */
export async function getInvitationByToken(
  input: unknown,
  deps: InvitationServiceDeps = defaultDeps,
): Promise<InvitationServiceResult<GetInvitationByTokenSuccess>> {
  const parsed = acceptInvitationInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const tokenHash = hashInvitationToken(parsed.data.token);

  let invitation: Invitation | null;
  try {
    invitation = await deps.invitations.findByTokenHash(tokenHash);
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر تحميل الدعوة الآن");
  }
  if (!invitation) {
    return failure(
      "INVITATION_NOT_FOUND",
      "الدعوة غير موجودة أو الرمز غير صالح",
    );
  }

  const business = await deps.businesses.findById(invitation.businessId);

  return {
    success: true,
    data: {
      invitation: toView(invitation),
      status: deriveInvitationStatus(invitation),
      businessName: business?.name ?? null,
    },
  };
}

/**
 * Activates the account of an ACCEPTED invitation by RAW token
 * (PROMPT-16: generalized from the ADMIN-only original — the persisted
 * invitation's own role drives the membership; DECISIONS #24's
 * consistency model applies unchanged).
 *
 * Flow: validate → hash (existing security utility) → locate by
 * tokenHash → enforce eligibility (accepted, not revoked, not yet
 * activated; expiry only gates PENDING invitations — the acceptance
 * already ran inside the validity window) → handle identity
 * collisions → create the Better Auth identity when none exists →
 * atomically mark the invitation activated and attach the Business
 * membership with the invitation's role → return the safe activation
 * result.
 *
 * Security properties:
 * - Token-scoped, like acceptance: the persisted invitation is the
 *   sole authority for businessId/email/role — callers cannot override
 *   them (Zod strips every unknown key). A caller can never escalate
 *   to a role the invitation does not carry.
 * - One identity per email: an existing identity is never duplicated,
 *   its password is never reset, and its role is never silently
 *   changed. Members of the same Business with a different role and
 *   users of other Businesses get a typed conflict.
 * - One activation per invitation: the repository's conditional
 *   `activatedAt` guard makes repeated and concurrent attempts fail
 *   with ACCOUNT_ALREADY_ACTIVATED.
 * - Interrupted activations are resumable: if the identity exists but
 *   the membership was never attached (crash between the two phases),
 *   a retry completes the membership without creating a second
 *   identity and without touching the existing password.
 * - The result carries safe data only — never the raw token, the hash,
 *   the password, or any session token.
 */
export async function activateInvitedAccount(
  input: unknown,
  deps: InvitationServiceDeps = defaultDeps,
): Promise<InvitationServiceResult<ActivateInvitedAccountSuccess>> {
  const parsed = activateAdminAccountInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const tokenHash = hashInvitationToken(parsed.data.token);

  const invitation = await deps.invitations.findByTokenHash(tokenHash);
  if (!invitation) {
    return failure(
      "INVITATION_NOT_FOUND",
      "الدعوة غير موجودة أو الرمز غير صالح",
    );
  }

  // Revocation is checked first — even for an impossible
  // accepted-and-revoked record, a revoked invitation never activates.
  if (invitation.revokedAt) {
    return failure("INVITATION_REVOKED", "تم إلغاء هذه الدعوة");
  }

  switch (deriveInvitationStatus(invitation)) {
    case "EXPIRED":
      return failure("INVITATION_EXPIRED", "انتهت صلاحية هذه الدعوة");
    case "PENDING":
      return failure(
        "INVITATION_NOT_ACCEPTED",
        "يجب قبول الدعوة أولاً قبل تفعيل الحساب",
      );
    case "ACTIVATED":
      return failure("ACCOUNT_ALREADY_ACTIVATED", "تم تفعيل هذا الحساب بالفعل");
  }

  // ── Identity collision handling (one identity per email) ──
  let userId: string;
  let identityCreated: boolean;
  const existing = await deps.users.findByEmail(invitation.email);
  if (existing) {
    const classified = classifyExistingUser(existing, invitation);
    if ("failure" in classified) return classified.failure;
    userId = classified.userId;
    identityCreated = false;
  } else {
    const created = await deps.createIdentity({
      email: invitation.email,
      name: parsed.data.name,
      password: parsed.data.password,
    });
    switch (created.status) {
      case "INVALID_PASSWORD":
        return failure(
          "INVALID_INPUT",
          "كلمة المرور لا تفي بالحد الأدنى المطلوب",
        );
      case "FAILED":
        return failure(
          "IDENTITY_CREATION_FAILED",
          "تعذر إنشاء حساب الدخول الآن",
        );
      case "EXISTS": {
        // Race: the identity appeared between the pre-check and the
        // creation attempt. Re-read and classify — resume when safely
        // attachable, typed conflict otherwise. Never a duplicate.
        const raced = await deps.users.findByEmail(invitation.email);
        if (!raced) {
          return failure(
            "IDENTITY_CREATION_FAILED",
            "تعذر إنشاء حساب الدخول الآن",
          );
        }
        const classified = classifyExistingUser(raced, invitation);
        if ("failure" in classified) return classified.failure;
        userId = classified.userId;
        identityCreated = false;
        break;
      }
      case "CREATED":
        userId = created.userId;
        identityCreated = true;
        break;
    }
  }

  // ── Atomic activation: invitation mark + Business membership ──
  let outcome: ActivateInvitedMemberOutcome;
  try {
    outcome = await deps.invitations.activateInvitedMember({
      invitationId: invitation.id,
      userId,
      businessId: invitation.businessId,
    });
  } catch (error) {
    if (error instanceof InvitationActivationConflictError) {
      return failure(
        "ACCOUNT_CONFLICT",
        "هذا الحساب غير متاح للتفعيل لهذه المنشأة",
      );
    }
    return failure("PERSISTENCE_FAILED", "تعذر تفعيل الحساب الآن");
  }

  switch (outcome.status) {
    case "ACTIVATED":
      return {
        success: true,
        data: {
          invitation: toView(outcome.invitation),
          userId: outcome.userId,
          identityCreated,
        },
      };
    case "ALREADY_ACTIVATED":
      return failure("ACCOUNT_ALREADY_ACTIVATED", "تم تفعيل هذا الحساب بالفعل");
    case "NOT_ACCEPTED":
      return failure(
        "INVITATION_NOT_ACCEPTED",
        "يجب قبول الدعوة أولاً قبل تفعيل الحساب",
      );
    case "CONFLICT":
      return failure(
        "ACCOUNT_CONFLICT",
        "هذا الحساب غير متاح للتفعيل لهذه المنشأة",
      );
    default:
      // USER_MISSING / NOT_FOUND: the row state changed mid-transaction —
      // a persistence anomaly, reported without internals.
      return failure("PERSISTENCE_FAILED", "تعذر تفعيل الحساب الآن");
  }
}
