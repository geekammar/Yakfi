import type { PlatformInvitation } from "@/generated/prisma/client";

import {
  INVITATION_EXPIRY_DAYS,
  defaultCreateIdentity,
  type IdentityCreator,
} from "@/features/invitations/server/invitation-service";
import {
  activateOwnerInputSchema,
  createOwnerInvitationInputSchema,
} from "@/features/platform/schemas/platform-schema";
import type {
  AcceptOwnerInvitationSuccess,
  ActivateOwnerAccountSuccess,
  CreateOwnerInvitationSuccess,
  GetOwnerInvitationByTokenSuccess,
  ListOwnerInvitationsSuccess,
  PlatformActor,
  PlatformErrorCode,
  PlatformInvitationListItem,
  PlatformInvitationStatus,
  PlatformInvitationView,
  PlatformServiceResult,
} from "@/features/platform/types";
import {
  platformInvitationRepository,
  userRepository,
} from "@/server/repositories";
import type { PlatformInvitationRepository } from "@/server/repositories/platform-invitation.repository";
import { PlatformOwnerActivationConflictError } from "@/server/repositories/platform-invitation.repository";
import type { UserRepository } from "@/server/repositories/user.repository";
import {
  generateInvitationToken,
  hashInvitationToken,
} from "@/server/security/invitation-token";

/**
 * Platform Owner Invitation service (PROMPT-OPS-05) — the
 * invitation-first onboarding entry point:
 *
 * Platform Operator → invitation → secure one-time activation link →
 * owner credential (Better Auth identity, role ADMIN, businessId null)
 * → canonical onboarding (Business + Default Branch + ADMIN ownership
 * via `createForUser`).
 *
 * Reuses the EXISTING invitation architecture — no second invitation
 * system: the same token security utility (hash-only persistence),
 * the same `INVITATION_EXPIRY_DAYS` policy, the same `IdentityCreator`
 * boundary to Better Auth, and the same duplicate-OPEN semantics
 * (DECISIONS #23). The platform variant is PRE-Business: activation
 * never creates a Business and never attaches a membership — the
 * canonical onboarding wizard does that after the owner signs in.
 *
 * Security invariants:
 * - The raw token is returned ONCE from creation; only its SHA-256
 *   hash is persisted; never logged, never in errors.
 * - Acceptance/activation locate the invitation by `tokenHash` only.
 * - The actor must be a PLATFORM operator (server-derived from the
 *   persisted user record — never a client input).
 * - Business ADMIN/STAFF can never create platform invitations.
 * - Results carry safe data only — never the hash, never a password.
 *
 * Collaborators are injectable so the workflow logic can be verified
 * without a live database.
 */

export function derivePlatformInvitationStatus(
  invitation: Pick<
    PlatformInvitation,
    "acceptedAt" | "expiresAt" | "activatedAt"
  >,
  now: Date = new Date(),
): PlatformInvitationStatus {
  if (invitation.acceptedAt) {
    return invitation.activatedAt ? "ACTIVATED" : "ACCEPTED";
  }
  if (invitation.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "PENDING";
}

function toView(invitation: PlatformInvitation): PlatformInvitationView {
  return {
    id: invitation.id,
    email: invitation.email,
    businessName: invitation.businessName,
    expiresAt: invitation.expiresAt,
    acceptedAt: invitation.acceptedAt,
    activatedAt: invitation.activatedAt,
    createdById: invitation.createdById,
    createdAt: invitation.createdAt,
    updatedAt: invitation.updatedAt,
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

function failure(
  code: PlatformErrorCode,
  message: string,
): { success: false; error: { code: PlatformErrorCode; message: string } } {
  return { success: false, error: { code, message } };
}

/** Narrow repository surface (injectable). */
export type OwnerInvitationServiceDeps = Readonly<{
  invitations: Pick<
    PlatformInvitationRepository,
    | "createIfNoOpenInvitation"
    | "findByTokenHash"
    | "listAll"
    | "acceptPendingInvitation"
    | "activateOwner"
  >;
  users: Pick<UserRepository, "findByEmail">;
  createIdentity: IdentityCreator;
}>;

const defaultDeps: OwnerInvitationServiceDeps = {
  invitations: platformInvitationRepository,
  users: userRepository,
  createIdentity: defaultCreateIdentity,
};

/**
 * Creates an owner invitation. PLATFORM operators only; one OPEN
 * invitation per email; 7-day expiry (the centralized invitation
 * policy). On success the raw token is returned exactly once.
 */
export async function createOwnerInvitation(
  actor: PlatformActor,
  input: unknown,
  deps: OwnerInvitationServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<CreateOwnerInvitationSuccess>> {
  if (actor.accountType !== "PLATFORM") {
    return failure("FORBIDDEN", "هذه الصلاحية متاحة لمشغل المنصة فقط");
  }

  const parsed = createOwnerInvitationInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const { rawToken, tokenHash } = generateInvitationToken();
  const expiresAt = new Date(
    Date.now() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  );

  let invitation: PlatformInvitation | null;
  try {
    invitation = await deps.invitations.createIfNoOpenInvitation({
      email: parsed.data.email,
      businessName: parsed.data.businessName ?? null,
      tokenHash,
      expiresAt,
      createdById: actor.userId,
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

/** Platform-scoped listing (newest first). Hashes never returned. */
export async function listOwnerInvitations(
  deps: OwnerInvitationServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<ListOwnerInvitationsSuccess>> {
  let invitations: PlatformInvitation[];
  try {
    invitations = await deps.invitations.listAll();
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر تحميل الدعوات الآن");
  }

  const now = new Date();
  const items: PlatformInvitationListItem[] = invitations.map((invitation) => ({
    ...toView(invitation),
    status: derivePlatformInvitationStatus(invitation, now),
  }));
  return { success: true, data: { items } };
}

/**
 * Read-only lookup by RAW token for the owner activation screen — NO
 * mutation on GET (the one-time acceptance runs at submit time).
 * Hash-only lookup; unknown tokens get the generic not-found error.
 */
export async function getOwnerInvitationByToken(
  input: unknown,
  deps: OwnerInvitationServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<GetOwnerInvitationByTokenSuccess>> {
  const parsed = activateOwnerInputSchema.shape.token.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const tokenHash = hashInvitationToken(parsed.data);

  let invitation: PlatformInvitation | null;
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

  return {
    success: true,
    data: {
      invitation: toView(invitation),
      status: derivePlatformInvitationStatus(invitation),
      businessName: invitation.businessName,
    },
  };
}

/**
 * Accepts an owner invitation by RAW token — one-time, atomic,
 * token-scoped. Unknown tokens get one generic error; a second
 * acceptance attempt fails safely by classifying the persisted state.
 */
export async function acceptOwnerInvitation(
  input: unknown,
  deps: OwnerInvitationServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<AcceptOwnerInvitationSuccess>> {
  const parsed = activateOwnerInputSchema.shape.token.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const tokenHash = hashInvitationToken(parsed.data);

  const invitation = await deps.invitations.findByTokenHash(tokenHash);
  if (!invitation) {
    return failure(
      "INVITATION_NOT_FOUND",
      "الدعوة غير موجودة أو الرمز غير صالح",
    );
  }
  if (derivePlatformInvitationStatus(invitation) !== "PENDING") {
    return classifyUnacceptable(invitation);
  }

  let accepted: PlatformInvitation | null;
  try {
    accepted = await deps.invitations.acceptPendingInvitation(tokenHash);
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر قبول الدعوة الآن");
  }
  if (!accepted) {
    const current = await deps.invitations.findByTokenHash(tokenHash);
    if (!current) {
      return failure(
        "INVITATION_NOT_FOUND",
        "الدعوة غير موجودة أو الرمز غير صالح",
      );
    }
    return classifyUnacceptable(current);
  }

  return { success: true, data: { invitation: toView(accepted) } };
}

function classifyUnacceptable(
  invitation: PlatformInvitation,
): PlatformServiceResult<never> {
  const status = derivePlatformInvitationStatus(invitation);
  switch (status) {
    case "ACCEPTED":
    case "ACTIVATED":
      return failure("ACCOUNT_ALREADY_ACTIVATED", "تم تفعيل هذه الدعوة بالفعل");
    default:
      return failure("INVITATION_EXPIRED", "انتهت صلاحية هذه الدعوة");
  }
}

/**
 * Activates the owner credential for an ACCEPTED invitation by RAW
 * token: one Better Auth identity per email (created via the SHARED
 `IdentityCreator` — no second credential path), then the atomic
 * one-time activation marks the invitation ACTIVATED and promotes the
 * identity to ADMIN (businessId stays null — the Business is created
 * by the canonical onboarding wizard afterwards).
 *
 * Security properties:
 * - Token-scoped: the persisted invitation is the sole authority.
 * - One identity per email: an existing identity is never duplicated
 *   or password-reset; a Business-attached identity is a typed
 *   conflict (never silently moved or promoted).
 * - One activation per invitation: the conditional `activatedAt`
 *   guard makes repeated/concurrent attempts fail safely.
 */
export async function activateOwnerAccount(
  input: unknown,
  deps: OwnerInvitationServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<ActivateOwnerAccountSuccess>> {
  const parsed = activateOwnerInputSchema.safeParse(input);
  if (!parsed.success) return invalidInput(parsed.error.issues);

  const tokenHash = hashInvitationToken(parsed.data.token);

  const invitation = await deps.invitations.findByTokenHash(tokenHash);
  if (!invitation) {
    return failure(
      "INVITATION_NOT_FOUND",
      "الدعوة غير موجودة أو الرمز غير صالح",
    );
  }

  switch (derivePlatformInvitationStatus(invitation)) {
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
    const classified = classifyExistingUser(existing);
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
        const raced = await deps.users.findByEmail(invitation.email);
        if (!raced) {
          return failure(
            "IDENTITY_CREATION_FAILED",
            "تعذر إنشاء حساب الدخول الآن",
          );
        }
        const classified = classifyExistingUser(raced);
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

  // ── Atomic activation: invitation mark + owner promotion (ADMIN) ──
  let outcome: Awaited<
    ReturnType<OwnerInvitationServiceDeps["invitations"]["activateOwner"]>
  >;
  try {
    outcome = await deps.invitations.activateOwner({
      invitationId: invitation.id,
      userId,
    });
  } catch (error) {
    if (error instanceof PlatformOwnerActivationConflictError) {
      return failure(
        "ACCOUNT_CONFLICT",
        "هذا الحساب غير متاح للتفعيل كمالك منشأة",
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
        "هذا الحساب غير متاح للتفعيل كمالك منشأة",
      );
    default:
      return failure("PERSISTENCE_FAILED", "تعذر تفعيل الحساب الآن");
  }
}

/**
 * A never-assigned identity (businessId null — the interrupted
 * activation recovery path) resumes safely; a Business-attached
 * identity is never moved or promoted (typed conflict).
 */
function classifyExistingUser(user: {
  id: string;
  businessId: string | null;
}): { userId: string } | { failure: ReturnType<typeof failure> } {
  if (user.businessId !== null) {
    return {
      failure: failure(
        "ACCOUNT_CONFLICT",
        "هذا البريد مرتبط بحساب في منشأة أخرى",
      ),
    };
  }
  return { userId: user.id };
}
