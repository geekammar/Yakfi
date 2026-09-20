import { db } from "@/server/db";
import type { WhatsAppOnboardingAuthorization } from "@/types/domain";

/**
 * WhatsApp onboarding authorization ledger primitives
 * (WHATSAPP-ONBOARDING-01).
 *
 * One row per LAUNCHED provider authorization attempt. The provider
 * callback carries ONLY the opaque `stateRef`; the target Business +
 * connection are resolved from THIS server-persisted row — never from a
 * query parameter, a client payload, or a session claim. Replay
 * protection and cross-tenant rejection are both structural:
 * `consume` is a conditional update on (stateRef, connectionId,
 * businessId, unconsumed, unexpired), so a replayed or hostile callback
 * matches no row and nothing is written.
 */

/** Lifetime of one authorization attempt (short — it is a browser redirect). */
export const ONBOARDING_AUTHORIZATION_EXPIRY_MINUTES = 15;

export type NewOnboardingAuthorization = {
  businessId: string;
  connectionId: string;
  stateRef: string;
  expiresAt: Date;
};

export type OnboardingAuthorizationRecord = Pick<
  WhatsAppOnboardingAuthorization,
  "id" | "businessId" | "connectionId" | "stateRef" | "expiresAt" | "consumedAt"
>;

export class WhatsAppOnboardingAuthorizationRepository {
  async create(
    input: NewOnboardingAuthorization,
  ): Promise<OnboardingAuthorizationRecord> {
    return db.whatsAppOnboardingAuthorization.create({
      data: input,
      select: {
        id: true,
        businessId: true,
        connectionId: true,
        stateRef: true,
        expiresAt: true,
        consumedAt: true,
      },
    });
  }

  async findByStateRef(
    stateRef: string,
  ): Promise<OnboardingAuthorizationRecord | null> {
    return db.whatsAppOnboardingAuthorization.findUnique({
      where: { stateRef },
      select: {
        id: true,
        businessId: true,
        connectionId: true,
        stateRef: true,
        expiresAt: true,
        consumedAt: true,
      },
    });
  }

  /**
   * The in-flight (unconsumed, unexpired) attempt for a connection —
   * the resume target of a relaunched flow. Returns null when the
   * previous attempt was consumed, expired, or never existed.
   */
  async findActiveByConnection(
    connectionId: string,
    now: Date = new Date(),
  ): Promise<OnboardingAuthorizationRecord | null> {
    return db.whatsAppOnboardingAuthorization.findFirst({
      where: {
        connectionId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        businessId: true,
        connectionId: true,
        stateRef: true,
        expiresAt: true,
        consumedAt: true,
      },
    });
  }

  /**
   * Consume the attempt EXACTLY ONCE: a conditional update matching the
   * unconsumed, unexpired row for this `stateRef` within the claimed
   * Business + connection. Returns whether THIS call was the consumer —
   * a replay (already consumed), an expired attempt, or a hostile
   * stateRef that never existed all fail to match and the caller
   * records a normalized failure instead of provisioning anything.
   */
  async consume(
    stateRef: string,
    businessId: string,
    connectionId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const result = await db.whatsAppOnboardingAuthorization.updateMany({
      where: {
        stateRef,
        businessId,
        connectionId,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    return result.count === 1;
  }
}
