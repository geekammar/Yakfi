import type { PlatformInvitation } from "@/generated/prisma/client";

import type { CreatePlatformInvitationDto } from "@/lib/validation";
import { paginationSchema, paginationToSkipTake } from "@/lib/validation";
import { db } from "@/server/db";

/**
 * PlatformInvitation — the PLATFORM-scoped, pre-Business owner
 * invitation (PROMPT-OPS-05). Separate from the business-scoped
 * `Invitation` (the Business does not exist yet; the membership is
 * attached later by the canonical onboarding wizard). Reuses the same
 * token security utility as business invitations; only the HASH is
 * stored.
 *
 * Conventions (mirroring the Invitation repository):
 * - Only the token HASH is stored; the raw token never reaches the DB.
 * - Lifecycle is derived (acceptedAt/expiresAt/activatedAt) — no
 *   persisted status enum.
 * - Platform-scoped: listAll is the platform operator's view.
 * - Duplicate-OPEN protection is per email, workflow-level
 *   (transaction-scoped check-then-create, DECISIONS #23 semantics —
 *   no DB unique constraint on email).
 */

/**
 * Thrown inside the activation transaction when the user row cannot be
 * attached (missing, or already a Business member). Rolling back also
 * reverts the invitation's activatedAt mark.
 */
export class PlatformOwnerActivationConflictError extends Error {
  constructor() {
    super("platform owner activation conflict");
    this.name = "PlatformOwnerActivationConflictError";
  }
}

export type ActivateOwnerOutcome =
  | { status: "ACTIVATED"; invitation: PlatformInvitation; userId: string }
  | { status: "ALREADY_ACTIVATED" }
  | { status: "NOT_ACCEPTED" }
  | { status: "USER_MISSING" }
  | { status: "CONFLICT" }
  | { status: "NOT_FOUND" };

export class PlatformInvitationRepository {
  async create(data: CreatePlatformInvitationDto): Promise<PlatformInvitation> {
    return db.platformInvitation.create({ data });
  }

  /**
   * Creates an owner invitation unless an OPEN one already exists for
   * the same email (open = not accepted, unexpired). Returns null when
   * an open invitation exists — the workflow maps that to its typed
   * conflict. Expired and accepted invitations never block creation.
   */
  async createIfNoOpenInvitation(
    data: CreatePlatformInvitationDto,
  ): Promise<PlatformInvitation | null> {
    return db.$transaction(async (tx) => {
      const open = await tx.platformInvitation.findFirst({
        where: {
          email: data.email,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (open) return null;
      return tx.platformInvitation.create({ data });
    });
  }

  async findByTokenHash(tokenHash: string): Promise<PlatformInvitation | null> {
    return db.platformInvitation.findUnique({ where: { tokenHash } });
  }

  /** Platform operator listing (newest first, paginated). */
  async listAll(rawPagination?: unknown): Promise<PlatformInvitation[]> {
    const pagination = paginationSchema.parse(rawPagination ?? {});
    return db.platformInvitation.findMany({
      orderBy: [{ createdAt: "desc" }],
      ...paginationToSkipTake(pagination),
    });
  }

  /**
   * Atomically transitions a token-hash-located invitation from PENDING
   * to ACCEPTED. The conditional UPDATE carries the full guard
   * (pending + unexpired) — a concurrent acceptance or expiry between
   * the workflow's pre-check and this call updates zero rows and
   * safely returns null.
   */
  async acceptPendingInvitation(
    tokenHash: string,
  ): Promise<PlatformInvitation | null> {
    return db.$transaction(async (tx) => {
      const result = await tx.platformInvitation.updateMany({
        where: {
          tokenHash,
          acceptedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { acceptedAt: new Date() },
      });
      if (result.count === 0) return null;
      return tx.platformInvitation.findUnique({ where: { tokenHash } });
    });
  }

  /**
   * Atomically completes owner credential activation for an accepted,
   * unactivated invitation (PROMPT-OPS-05):
   *
   * 1. Validation reads inside the transaction (invitation still
   *    accepted + unactivated; user row exists and is attachable —
   *    businessId null, i.e. never assigned to a Business).
   * 2. One-time guard: a conditional UPDATE sets `activatedAt` only
   *    while it is null. Two concurrent activations serialize here.
   * 3. The invited user becomes ADMIN (role = ADMIN, businessId stays
   *    null): the Business itself is created by the canonical
   *    onboarding wizard, whose `createForUser` attaches the ADMIN
   *    membership + Default Branch — never a manual Business shortcut.
   *    The conditional update matches `businessId IS NULL` only, so a
   *    Business-attached user is never silently moved or promoted.
   *
   * The user's password is never touched here — credentials belong to
   * Better Auth; this primitive only persists FlowPilot domain state.
   */
  async activateOwner(input: {
    invitationId: string;
    userId: string;
  }): Promise<ActivateOwnerOutcome> {
    return db.$transaction(async (tx) => {
      const invitation = await tx.platformInvitation.findUnique({
        where: { id: input.invitationId },
      });
      if (!invitation) return { status: "NOT_FOUND" } as const;
      if (invitation.activatedAt) {
        return { status: "ALREADY_ACTIVATED" } as const;
      }
      if (!invitation.acceptedAt) {
        return { status: "NOT_ACCEPTED" } as const;
      }

      const user = await tx.user.findUnique({
        where: { id: input.userId },
      });
      if (!user) return { status: "USER_MISSING" } as const;
      // Only a never-assigned identity can be activated as the owner;
      // a Business-attached user is never moved or promoted.
      if (user.businessId !== null) {
        return { status: "CONFLICT" } as const;
      }

      const guard = await tx.platformInvitation.updateMany({
        where: {
          id: input.invitationId,
          acceptedAt: { not: null },
          activatedAt: null,
        },
        data: { activatedAt: new Date() },
      });
      if (guard.count === 0) {
        return { status: "ALREADY_ACTIVATED" } as const;
      }

      const promoted = await tx.user.updateMany({
        where: { id: input.userId, businessId: null },
        data: { role: "ADMIN", isActive: true },
      });
      if (promoted.count === 0) {
        // Raced with a conflicting membership change — undo the
        // activatedAt mark and report the conflict.
        throw new PlatformOwnerActivationConflictError();
      }

      const activated = await tx.platformInvitation.findUnique({
        where: { id: input.invitationId },
      });
      if (!activated) return { status: "NOT_FOUND" } as const;
      return {
        status: "ACTIVATED" as const,
        invitation: activated,
        userId: input.userId,
      };
    });
  }
}
