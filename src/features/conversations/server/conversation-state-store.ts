/**
 * Durable ConversationState store (CONV-CORE-01).
 *
 * The ONE place that turns the persisted JSON row into a validated
 * `ConversationState` and back. The engine opens a per-turn SESSION from it;
 * staff actions use `invalidateConversationOffer` when a human takes
 * ownership. Nobody else reads or writes the row.
 *
 * Degradation contract: when the repository seam is absent (offline harnesses)
 * or the table is not migrated yet, `enabled` is false and every operation is
 * a safe no-op, so the engine keeps its legacy history-derived behaviour.
 */
import type { BookingOffer } from "@/features/conversations/server/booking-offer";
import type { ConversationState } from "@/features/conversations/server/conversation-state";
import {
  dehydrateConversationState,
  hydrateConversationState,
  withOfferStatus,
} from "@/features/conversations/server/conversation-state";
import type { ConversationStateRepository } from "@/server/repositories/conversation-state.repository";

export type ConversationStateStore = Pick<
  ConversationStateRepository,
  "load" | "save"
>;

/**
 * Booking facts older than this are dropped on load (a "tomorrow" said two
 * days ago must not silently become a past date). The completed-task marker
 * and the offer (which has its own TTL) are kept.
 */
export const CONVERSATION_FACT_FRESHNESS_MS = 12 * 60 * 60 * 1000;
/** Stranded claims older than this are safely released or invalidated on load. */
export const OFFER_CLAIM_TIMEOUT_MS = 2 * 60 * 1000;

export type TurnStateSession = {
  /** False when no durable store is reachable — every call is a no-op. */
  readonly enabled: boolean;
  /** True when a valid row was loaded (a legacy thread has none yet). */
  readonly loaded: boolean;
  /** The working state for this turn (engine replaces it as the turn runs). */
  state: ConversationState | null;
  /**
   * Compare-and-swap commit of `state`. Returns false on a concurrent-write
   * conflict (another turn advanced the row) — the caller must NOT assume
   * its write landed.
   */
  commit(): Promise<boolean>;
  /**
   * Reload latest state and revision from durable store. Returns true if loaded,
   * false if row does not exist or store unreachable.
   */
  reload(): Promise<boolean>;
  /** Atomically CLAIM the current ACTIVE offer before a booking write. */
  claimOffer(): Promise<"claimed" | "conflict" | "no_offer">;
  /** Release a CLAIMED offer back to ACTIVE (e.g. invalid index / ambiguous time). */
  releaseClaim(): Promise<boolean>;
  /** Invalidate the current offer (e.g. booking failure / date change). */
  invalidateOffer(): Promise<boolean>;
};

function freshen(state: ConversationState, updatedAt: Date, now: Date) {
  let result = state;
  if (now.getTime() - updatedAt.getTime() > CONVERSATION_FACT_FRESHNESS_MS) {
    result = {
      ...result,
      knownFacts: result.knownFacts.customerName
        ? { customerName: result.knownFacts.customerName }
        : {},
      selectedService: null,
      selectedDate: null,
      selectedTimePref: null,
      providerPreference: null,
      serviceId: null,
      serviceSource: null,
      missingFacts: [],
      lastClarification: null,
      activeTask: null,
      currentGoal: null,
      bookingStage: "NOT_APPLICABLE" as const,
      topics: [],
    };
  }
  if (
    result.offer &&
    result.offer.status === "CLAIMED" &&
    now.getTime() - updatedAt.getTime() > OFFER_CLAIM_TIMEOUT_MS
  ) {
    const expired = Date.parse(result.offer.expiresAt) <= now.getTime();
    result = withOfferStatus(result, expired ? "INVALIDATED" : "ACTIVE");
  }
  return result;
}

export async function openTurnStateSession(
  store: ConversationStateStore | undefined,
  scope: { readonly businessId: string; readonly conversationId: string },
  now: Date,
): Promise<TurnStateSession> {
  const disabled: TurnStateSession = {
    enabled: false,
    loaded: false,
    state: null,
    commit: async () => true,
    reload: async () => false,
    claimOffer: async () => "no_offer",
    releaseClaim: async () => true,
    invalidateOffer: async () => true,
  };
  if (!store) return disabled;

  let revision: number | null = null;
  let loadedState: ConversationState | null = null;
  try {
    const row = await store.load(scope.businessId, scope.conversationId);
    if (row) {
      revision = row.revision;
      const hydrated = hydrateConversationState(row.state, scope);
      loadedState = hydrated ? freshen(hydrated, row.updatedAt, now) : null;
    }
  } catch {
    // Table not migrated / DB hiccup: legacy behaviour for this turn.
    return disabled;
  }

  let enabled = true;
  const session: TurnStateSession = {
    get enabled() {
      return enabled;
    },
    loaded: loadedState !== null,
    state: loadedState,
    async commit() {
      if (!enabled || !session.state) return true;
      try {
        const saved = await store.save(
          scope.businessId,
          scope.conversationId,
          revision,
          dehydrateConversationState(session.state),
        );
        if (saved.status === "conflict") return false;
        revision = saved.revision;
        return true;
      } catch {
        enabled = false;
        return false;
      }
    },
    async reload() {
      if (!enabled) return false;
      try {
        const row = await store.load(scope.businessId, scope.conversationId);
        if (row) {
          revision = row.revision;
          const hydrated = hydrateConversationState(row.state, scope);
          session.state = hydrated
            ? freshen(hydrated, row.updatedAt, now)
            : null;
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    async claimOffer() {
      const offer: BookingOffer | null = session.state?.offer ?? null;
      if (!enabled || !session.state || !offer || offer.status !== "ACTIVE") {
        return "no_offer";
      }
      const previous = session.state;
      session.state = withOfferStatus(previous, "CLAIMED");
      const ok = await session.commit();
      if (!ok) {
        session.state = previous;
        return "conflict";
      }
      return "claimed";
    },
    async releaseClaim() {
      if (
        !enabled ||
        !session.state ||
        session.state.offer?.status !== "CLAIMED"
      ) {
        return true;
      }
      session.state = withOfferStatus(session.state, "ACTIVE");
      return await session.commit();
    },
    async invalidateOffer() {
      if (!enabled || !session.state || !session.state.offer) {
        return true;
      }
      session.state = withOfferStatus(session.state, "INVALIDATED");
      return await session.commit();
    },
  };
  return session;
}

/**
 * Staff took ownership: the AI's current offer must not be selectable when
 * the thread later returns to the assistant. Best-effort and total.
 */
export async function invalidateConversationOffer(
  store: ConversationStateStore,
  scope: { readonly businessId: string; readonly conversationId: string },
): Promise<void> {
  try {
    const row = await store.load(scope.businessId, scope.conversationId);
    if (!row) return;
    const state = hydrateConversationState(row.state, scope);
    if (!state?.offer || state.offer.status !== "ACTIVE") return;
    await store.save(
      scope.businessId,
      scope.conversationId,
      row.revision,
      dehydrateConversationState(withOfferStatus(state, "INVALIDATED")),
    );
  } catch {
    // Orchestration state only; a failure never blocks a staff action.
  }
}
