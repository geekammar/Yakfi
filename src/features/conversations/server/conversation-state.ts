/**
 * Conversation State foundation (PROMPT-AI-ARCH-04 — Slice 2).
 *
 * The ONE engine-owned, structured representation of conversation /task
 * understanding (docs/ai/TARGET_ARCHITECTURE.md §3.4 / §9). It is
 * orchestration/application state — NEVER authoritative domain state.
 *
 * Authority split (binding, §9):
 * - The Conversation Engine OWNS this value; it derives and merges it.
 * - The DOMAIN remains authoritative for availability, appointment
 *   validity, eligibility, conflicts, and every booking write. A fact in
 *   `ConversationState` (e.g. `selectedDate = "2026-10-02"`) is only the
 *   customer's stated intent; the domain decides whether it is bookable.
 * - The LLM may PROPOSE `factUpdates`; this module validates/merges them.
 *   The model is never the state authority and this module never calls it.
 *
 * This foundation was introduced observe-only in Slice 2. Slice 4
 * (PROMPT-AI-ARCH-06) makes it carry first-class CLARIFY state: the merge
 * RECORDS a clarification (pending `missingFacts` + `lastClarification`,
 * active task preserved) and RESOLVES it when the customer supplies the
 * missing fact on a later turn (resume). It still does NOT drive multi-intent
 * execution or handoff policy — those are later slices.
 *
 * Everything in this module is PURE and TOTAL: no I/O, no network, no DB,
 * no provider, no `process.env`, no secret, and ZERO model inference. The
 * same inputs always yield the same `ConversationState`
 * (`state + factUpdates → nextState`), so it is deterministic and
 * offline-testable in isolation.
 *
 * There is NO second state machine: `bookingStage` MIRRORS the booking
 * journey as a conversation fact for orchestration; execution still runs
 * through CORE-01/CORE-02 + `createWithConflictCheck`.
 */

import type {
  AiExtraction,
  AiFactUpdate,
  AiGoal,
  ConversationContextProjection,
} from "@/features/conversations/server/ai-contract";
import { conversationContextProjectionSchema } from "@/features/conversations/server/ai-contract";
import type { BookingOffer } from "@/features/conversations/server/booking-offer";
import {
  bookingOfferSchema,
  isOfferLive,
} from "@/features/conversations/server/booking-offer";
import type { OfferedBookingOption } from "@/features/conversations/server/booking-selection";
import { extractLastBookingOffer } from "@/features/conversations/server/booking-selection";
import {
  conversationFactKeys,
  isFactKey,
  isRemovableFactKey,
  removableFactKeys,
  type ConversationFactKey,
  type RemovableFactKey,
} from "@/features/conversations/server/conversation-facts";
import {
  dateRangeSchema,
  isValidIsoCalendarDate,
} from "@/features/conversations/server/temporal-context";

import { z } from "zod";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The booking-journey checkpoints this conversation fact mirrors. The names
 * are a bounded SUBSET aligned with the evaluation `BookingJourneyState`
 * vocabulary (`evaluation/schema/taxonomy.ts`) so a future `stateTransition`
 * observable scores cleanly — but production NEVER imports the evaluation
 * module (the alignment is by value, not by dependency). It is NOT a second
 * booking engine: it is a conversation-understanding label only.
 */
export const conversationBookingStageValues = [
  /** No booking/availability task is active in the conversation. */
  "NOT_APPLICABLE",
  /** The customer stated a booking/availability goal; no facts yet. */
  "GOAL_STATED",
  /** A service is known (customer-stated). */
  "SERVICE_SUPPLIED",
  /** A date is known (customer-stated). */
  "DATE_SUPPLIED",
  /** A time preference is known (customer-stated). */
  "TIME_SUPPLIED",
  /** The domain presented concrete options (a pending offer exists). */
  "AVAILABILITY_RESOLVED",
  /** The customer selected an offered option. */
  "SLOT_SELECTION",
  /** The booking was completed by the domain. */
  "COMPLETED",
  /** The active task is suspended by a topic switch. */
  "INTERRUPTED",
  /** The conversation returned to a previously-interrupted task. */
  "RECOVERING",
] as const;

export type ConversationBookingStage =
  (typeof conversationBookingStageValues)[number];

export {
  conversationFactKeys,
  isFactKey,
  isRemovableFactKey,
  removableFactKeys,
};
export type { ConversationFactKey, RemovableFactKey };

/** The intent families the DOMAIN executes (a booking-journey task). */
const taskGoalValues: ReadonlySet<string> = new Set([
  "BOOKING",
  "AVAILABILITY",
  "RESCHEDULE",
  "CANCELLATION",
]);

/** Whether a goal/intent label represents a domain-executed task. */
export function isTaskGoal(goal: string | null | undefined): boolean {
  return goal != null && taskGoalValues.has(goal);
}

// ─── Structure ─────────────────────────────────────────────────────────────

/** Customer-stated facts ONLY — never a domain-resolved id or slot. */
export type ConversationKnownFacts = {
  readonly service?: string;
  readonly date?: string;
  readonly dateRange?: {
    readonly startDate: string;
    readonly endDate: string;
  };
  readonly timePreference?: string;
  readonly exactTime?: string;
  readonly unresolvedTime?: {
    readonly hour: number;
    readonly minute: number;
  };
  readonly provider?: string;
  readonly customerName?: string;
  readonly followUpRequestId?: string;
};

/**
 * An append-only record of a fact that was superseded. `isRevision`
 * preserves the distinction the target requires: an EXPLICIT correction
 * (`isRevision: true`) vs an accidental contradiction (`isRevision: false`).
 * Either way the latest value becomes authoritative in `knownFacts`; the
 * old value never remains authoritative inside the state.
 */
export type ConversationFactRevision = {
  readonly key: ConversationFactKey;
  readonly from: string | null;
  readonly to: string | null;
  readonly isRevision: boolean;
  readonly turnId?: string;
};

/** A topic frame on the bounded interruption stack (§9 topic return). */
export type ConversationTopicFrame = {
  /** The goal/intent label this frame represents. */
  readonly goal: string;
  /** ACTIVE while pursued, INTERRUPTED when suspended, RECOVERING on return. */
  readonly suspendState: "ACTIVE" | "INTERRUPTED" | "RECOVERING";
  /** Where to resume the suspended task (the stage before interruption). */
  readonly returnStage?: ConversationBookingStage;
};

/**
 * A cached presentation of a domain (CORE-02) result — NOT authoritative.
 * It is re-verified against a fresh domain result at execution (exactly as
 * the existing deterministic selection seam already does).
 */
export type ConversationPendingOffer = {
  readonly serviceName: string;
  readonly date: string;
  readonly options: readonly OfferedBookingOption[];
  readonly followUpRequestId?: string | null;
};

/** One goal the conversation is pursuing (multi-intent FOUNDATION only). */
export type ConversationGoal = {
  readonly kind: string;
  readonly intent?: string;
  readonly priority?: number;
  /** Exactly one goal is active; the resolver (later slice) consumes this. */
  readonly active: boolean;
};

/**
 * The ONE coherent conversation-understanding value. Everything is readonly
 * so a merge always produces a NEW value (no hidden mutation side effects).
 */
export type ConversationState = {
  /** The currently-active goal/intent label (null when none). */
  readonly currentGoal: string | null;
  /** The task being pursued across turns (null when none). */
  readonly activeTask: {
    readonly kind: string;
    readonly stage: ConversationBookingStage;
  } | null;
  /** Customer-stated facts (latest wins). */
  readonly knownFacts: ConversationKnownFacts;
  /** Append-only revision log (distinguishes revision vs contradiction). */
  readonly revisions: readonly ConversationFactRevision[];
  /** Facts a future CLARIFY step may need (populated by later slices). */
  readonly missingFacts: readonly ConversationFactKey[];
  /** Booking-journey mirror (conversation fact only, never domain truth). */
  readonly bookingStage: ConversationBookingStage;
  /** Mirrors of `knownFacts` for the fields the target names explicitly. */
  readonly selectedService: string | null;
  readonly selectedDate: string | null;
  readonly dateRange?: {
    readonly startDate: string;
    readonly endDate: string;
  } | null;
  readonly selectedTimePref: string | null;
  readonly providerPreference: string | null;
  /** The bounded topic/interruption stack (topic switch + return). */
  readonly topics: readonly ConversationTopicFrame[];
  /** A cached, re-verifiable presentation of the last domain offer. */
  readonly pendingOffer: ConversationPendingOffer | null;
  /** Goals the conversation is pursuing (multi-intent foundation). */
  readonly goals: readonly ConversationGoal[];
  /**
   * Secondary DOMAIN/booking goal(s) the engine deferred by an
   * answer-and-continue turn and still owes the customer (PROMPT-AI-ARCH-09 —
   * Slice 5). A pending goal SURVIVES subsequent turns (topic interruption,
   * the current answer, next-turn continuation) until it is RESUMED (the
   * customer pursues it) or COMPLETED (a booking is written). It is
   * orchestration state only — never authoritative domain truth.
   */
  readonly pendingGoals: readonly ConversationGoal[];
  /** The last clarification the engine recorded (future slices populate). */
  readonly lastClarification: {
    readonly type: string;
    readonly turnId?: string;
    readonly unresolvedTime?: {
      readonly hour: number;
      readonly minute: number;
    };
  } | null;
  /**
   * CONV-CORE-01 — the RESOLVED service identity (server-matched against the
   * Business catalogue, never model output) and where it came from. A text
   * re-phrasing that resolves to the SAME id is not a service change.
   */
  readonly serviceId: string | null;
  readonly serviceSource: ConversationServiceSource | null;
  /**
   * CONV-CORE-01 — the current typed, validated offer (service list or slot
   * list) the customer is choosing from. `pendingOffer` above is the legacy
   * presentation mirror derived from it (or from history for legacy threads).
   */
  readonly offer: BookingOffer | null;
  readonly suspendedOffer?: BookingOffer | null;
  readonly completedTask: ConversationCompletedTask | null;
};

/** Where the resolved service came from. */
export type ConversationServiceSource = "CUSTOMER" | "DEFAULT";

/** The minimal, non-authoritative record of the last completed booking. */
export type ConversationCompletedTask = {
  readonly kind: "BOOKING";
  readonly appointmentId: string;
  readonly serviceId: string;
  readonly providerId: string | null;
  readonly date: string;
  readonly completedAt: string;
};

/** A single observed state transition (projected into Slice-0 observability). */
export type ConversationStateTransition = {
  readonly from: ConversationBookingStage;
  readonly to: ConversationBookingStage;
  readonly factKey?: ConversationFactKey;
  readonly isRevision?: boolean;
};

const MAX_TOPIC_FRAMES = 8;
const MAX_REVISIONS = 32;
const MAX_PENDING_GOALS = 8;

/** The canonical empty/initial state (a brand-new conversation). */
export function emptyConversationState(): ConversationState {
  return {
    currentGoal: null,
    activeTask: null,
    knownFacts: {},
    revisions: [],
    missingFacts: [],
    bookingStage: "NOT_APPLICABLE",
    selectedService: null,
    selectedDate: null,
    dateRange: null,
    selectedTimePref: null,
    providerPreference: null,
    topics: [],
    pendingOffer: null,
    goals: [],
    pendingGoals: [],
    lastClarification: null,
    serviceId: null,
    serviceSource: null,
    offer: null,
    suspendedOffer: null,
    completedTask: null,
  };
}

// ─── Fact-update normalization ───────────────────────────────────────────────

/**
 * Adapt the current turn's structured extraction into additive fact updates
 * (the EXISTING Slice-0 `factUpdates` shape). Extraction facts are never
 * flagged as revisions — a revision is an EXPLICIT `factUpdate` with
 * `isRevision: true`. This lets the engine feed both channels uniformly
 * through the ONE merge function without inventing a second fact model.
 */
export function factUpdatesFromExtraction(
  extraction: AiExtraction | null | undefined,
): AiFactUpdate[] {
  if (!extraction) return [];
  const updates: AiFactUpdate[] = [];
  if (extraction.service)
    updates.push({ key: "service", value: extraction.service });
  if (extraction.date) updates.push({ key: "date", value: extraction.date });
  if (extraction.timePreference)
    updates.push({ key: "timePreference", value: extraction.timePreference });
  if (extraction.exactTime && extraction.exactTime.type === "specific")
    updates.push({ key: "exactTime", value: extraction.exactTime.time });
  if (extraction.provider)
    updates.push({ key: "provider", value: extraction.provider });
  return updates;
}

/** Project the contract's goals into the state's goal foundation. */
function goalsFromDecision(
  goals: readonly AiGoal[] | undefined,
): ConversationGoal[] {
  if (!goals || goals.length === 0) return [];
  const sorted = [...goals].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0),
  );
  return sorted.map((goal, index) => ({
    kind: goal.kind,
    ...(goal.intent ? { intent: goal.intent } : {}),
    ...(goal.priority !== undefined ? { priority: goal.priority } : {}),
    // The lowest-priority (first) goal is active; the rest are context.
    active: index === 0,
  }));
}

// ─── Booking-stage derivation (pure, from facts) ─────────────────────────────

/**
 * Derive the booking-journey mirror from the known facts, the active task,
 * and the pending offer. Deterministic and recomputed on every merge; it
 * never regresses silently — interruption/return are explicit overrides.
 */
function deriveBookingStage(
  facts: ConversationKnownFacts,
  hasTaskGoal: boolean,
  pendingOffer: ConversationPendingOffer | null,
): ConversationBookingStage {
  if (!hasTaskGoal) return "NOT_APPLICABLE";
  if (pendingOffer) return "AVAILABILITY_RESOLVED";
  if (facts.timePreference) return "TIME_SUPPLIED";
  if (facts.date || facts.dateRange) return "DATE_SUPPLIED";
  if (facts.service) return "SERVICE_SUPPLIED";
  return "GOAL_STATED";
}

// ─── The merge (state + factUpdates → nextState) ─────────────────────────────

export type MergeConversationStateInput = {
  /** Proposed conversation-fact updates (the Slice-0 contract shape). */
  readonly factUpdates?: readonly AiFactUpdate[];
  /** The current turn's goal/intent label (drives topic + task tracking). */
  readonly turnGoal?: string | null;
  /** Structured goals the decision proposed (multi-intent foundation). */
  readonly goals?: readonly AiGoal[];
  /**
   * DOMAIN/booking goal(s) the engine DEFERRED this turn by answering a
   * knowledge goal (answer-and-continue, PROMPT-AI-ARCH-09 — Slice 5). They
   * are ADDED to `pendingGoals` and preserved across subsequent turns until
   * resumed or completed. Omit on a normal single-goal turn.
   */
  readonly deferredGoals?: readonly AiGoal[];
  /** A domain offer presented this turn (cached presentation, re-verified). */
  readonly pendingOffer?: ConversationPendingOffer | null;
  /** True when the customer completed a booking this turn. */
  readonly booked?: boolean;
  /** Opaque turn marker recorded on revisions (never message content). */
  readonly turnId?: string;
  /**
   * A clarification RECORDED this turn (PROMPT-AI-ARCH-06 — Slice 4). When
   * present, the merge marks the task pending: it sets `lastClarification` and
   * records `missingFacts` (minus any already-known fact). Omit it on turns
   * that do not ask a clarification; the merge then RESOLVES any outstanding
   * clarification whose missing facts the current turn supplied (resume).
   */
  readonly clarification?: {
    readonly type: string;
    readonly missingFacts?: readonly ConversationFactKey[];
    readonly unresolvedTime?: {
      readonly hour: number;
      readonly minute: number;
    };
  } | null;
  /**
   * CONV-CORE-01 — the service identity the ENGINE resolved this turn against
   * the Business catalogue (never model output). Drives dependency-aware
   * invalidation: a different id drops the provider + slot offer; the same id
   * (a re-phrasing) keeps them.
   */
  readonly resolvedService?: {
    readonly serviceId: string;
    readonly source: ConversationServiceSource;
  } | null;
  /**
   * Conversation facts to clear/drop (e.g. when explicitly negated in the turn without replacement).
   */
  readonly droppedFacts?: readonly ConversationFactKey[];
};

export type MergeConversationStateResult = {
  readonly state: ConversationState;
  readonly transitions: readonly ConversationStateTransition[];
};

/**
 * The ONE pure, deterministic merge: `state + factUpdates → nextState`.
 *
 * Fact semantics (per key):
 * - NEW fact        — key absent → set, no revision.
 * - UNCHANGED fact  — equal value → no-op.
 * - CORRECTED fact  — differing value with `isRevision: true` → replace,
 *                     log revision (`isRevision: true`).
 * - CONFLICTING fact— differing value with no `isRevision` → latest wins,
 *                     log revision (`isRevision: false`) so a contradiction
 *                     stays distinguishable from an explicit revision.
 *
 * The old value NEVER remains authoritative in `knownFacts`; the revision
 * log is append-only and preserves enough history to tell the two apart.
 */
export function mergeConversationState(
  state: ConversationState,
  input: MergeConversationStateInput,
): MergeConversationStateResult {
  const transitions: ConversationStateTransition[] = [];
  const fromStage = state.bookingStage;

  let knownFacts: ConversationKnownFacts = { ...state.knownFacts };
  const revisions: ConversationFactRevision[] = [...state.revisions];

  for (const update of input.factUpdates ?? []) {
    if (!isFactKey(update.key)) continue; // ignore unknown keys (no 2nd model)
    const key = update.key;

    const rawPrev = knownFacts[key] ?? null;
    const prevStr =
      typeof rawPrev === "string"
        ? rawPrev
        : rawPrev
          ? `${rawPrev.startDate}..${rawPrev.endDate}`
          : null;

    if (update.operation === "remove") {
      if (
        rawPrev !== null ||
        (key === "exactTime" && knownFacts.unresolvedTime !== undefined)
      ) {
        revisions.push({
          key,
          from: prevStr,
          to: null,
          isRevision: true,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
        const { [key]: _dropped, ...rest } = knownFacts;
        void _dropped;
        if (key === "exactTime") {
          const { unresolvedTime: _droppedUnr, ...cleanRest } = rest;
          void _droppedUnr;
          knownFacts = cleanRest;
        } else {
          knownFacts = rest;
        }
      }
      continue;
    }

    const nextValue = update.value;

    if (prevStr === nextValue) continue; // unchanged → no-op

    if (key === "date") {
      if (!isValidIsoCalendarDate(nextValue)) {
        // Reject malformed date factUpdates without corrupting state or clearing a valid prior selection
        continue;
      }
      if (rawPrev !== null) {
        revisions.push({
          key,
          from: prevStr,
          to: nextValue,
          isRevision: update.isRevision === true,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
      }
      const { dateRange: _droppedRange, ...rest } = knownFacts;
      void _droppedRange;
      knownFacts = { ...rest, [key]: nextValue };
    } else if (key === "dateRange") {
      let candidate: unknown = null;
      if (typeof nextValue === "string" && nextValue.includes("..")) {
        const [s, e] = nextValue.split("..");
        if (s && e) candidate = { startDate: s.trim(), endDate: e.trim() };
      } else if (typeof nextValue === "string") {
        try {
          candidate = JSON.parse(nextValue);
        } catch {
          candidate = null;
        }
      } else if (typeof nextValue === "object" && nextValue !== null) {
        candidate = nextValue;
      }
      const parsedRange = dateRangeSchema.safeParse(candidate);
      if (!parsedRange.success) {
        // Reject malformed dateRange factUpdates without corrupting state or clearing a valid prior selection
        continue;
      }
      if (rawPrev !== null) {
        revisions.push({
          key,
          from: prevStr,
          to: `${parsedRange.data.startDate}..${parsedRange.data.endDate}`,
          isRevision: update.isRevision === true,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
      }
      const { date: _droppedDate, ...rest } = knownFacts;
      void _droppedDate;
      knownFacts = {
        ...rest,
        dateRange: parsedRange.data,
      };
    } else if (key === "exactTime") {
      if (rawPrev !== null) {
        revisions.push({
          key,
          from: prevStr,
          to: nextValue,
          isRevision: update.isRevision === true,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
      }
      const { unresolvedTime: _droppedUnr, ...rest } = knownFacts;
      void _droppedUnr;
      knownFacts = { ...rest, exactTime: nextValue };
    } else {
      if (rawPrev !== null) {
        revisions.push({
          key,
          from: prevStr,
          to: nextValue,
          isRevision: update.isRevision === true,
          ...(input.turnId ? { turnId: input.turnId } : {}),
        });
      }
      knownFacts = { ...knownFacts, [key]: nextValue };
    }
  }

  if (input.droppedFacts && input.droppedFacts.length > 0) {
    for (const key of input.droppedFacts) {
      if (knownFacts[key] !== undefined) {
        const { [key]: _dropped, ...rest } = knownFacts;
        void _dropped;
        knownFacts = rest;
      }
    }
  }

  if (revisions.length > MAX_REVISIONS) {
    revisions.splice(0, revisions.length - MAX_REVISIONS);
  }

  // ── Dependency-aware invalidation (CONV-CORE-01) ─────────────────────────
  // A change to ONE dimension invalidates ONLY what depends on it:
  //   service identity → provider preference + slot offer (eligibility and
  //                      slots are per service)
  //   date / provider / time preference → slot offer only (service kept)
  // A service RE-PHRASING that resolves to the same id invalidates nothing.
  const changed = (key: ConversationFactKey) =>
    (state.knownFacts[key] != null || knownFacts[key] != null) &&
    state.knownFacts[key] !== knownFacts[key];
  let serviceId = state.serviceId;
  let serviceSource = state.serviceSource;
  let serviceIdentityChanged = false;
  if (input.resolvedService) {
    if (input.resolvedService.serviceId !== state.serviceId) {
      serviceIdentityChanged = state.serviceId != null;
      serviceId = input.resolvedService.serviceId;
      serviceSource = input.resolvedService.source;
    } else if (input.resolvedService.source === "CUSTOMER") {
      serviceSource = "CUSTOMER";
    }
  } else if (changed("service")) {
    // Text changed and the engine could not resolve an id this turn —
    // conservatively treat it as a new service.
    serviceIdentityChanged = true;
    serviceId = null;
    serviceSource = null;
  }
  const providerSuppliedThisTurn = (input.factUpdates ?? []).some(
    (u) => u.key === "provider" && u.operation !== "remove",
  );
  if (
    serviceIdentityChanged &&
    !providerSuppliedThisTurn &&
    knownFacts.provider
  ) {
    const { provider: _dropped, ...rest } = knownFacts;
    void _dropped;
    knownFacts = rest;
  }
  const unresolvedTimeChanged =
    Boolean(state.knownFacts.unresolvedTime || knownFacts.unresolvedTime) &&
    (state.knownFacts.unresolvedTime?.hour !==
      knownFacts.unresolvedTime?.hour ||
      state.knownFacts.unresolvedTime?.minute !==
        knownFacts.unresolvedTime?.minute);
  const slotDependencyChanged =
    serviceIdentityChanged ||
    changed("date") ||
    changed("dateRange") ||
    changed("provider") ||
    changed("timePreference") ||
    changed("exactTime") ||
    unresolvedTimeChanged;
  let offer: BookingOffer | null = state.offer;
  if (offer && offer.status === "ACTIVE") {
    const invalidate =
      offer.kind === "SLOT"
        ? slotDependencyChanged ||
          (serviceId != null && offer.serviceId !== serviceId)
        : // A service list is answered once a service is resolved.
          input.resolvedService != null;
    if (invalidate) offer = { ...offer, status: "INVALIDATED" };
  }

  // ── Suspended offer lifecycle (dependency invalidation & termination) ────
  let suspendedOffer: BookingOffer | null = state.suspendedOffer ?? null;
  if (input.booked) {
    suspendedOffer = null;
  } else if (suspendedOffer && suspendedOffer.status === "ACTIVE") {
    let invalidateSuspended = false;
    if (suspendedOffer.kind === "SLOT") {
      invalidateSuspended =
        slotDependencyChanged ||
        (serviceId != null && suspendedOffer.serviceId !== serviceId) ||
        (knownFacts.date != null && suspendedOffer.date !== knownFacts.date) ||
        knownFacts.date == null;
    } else if (suspendedOffer.kind === "DATE") {
      invalidateSuspended =
        serviceIdentityChanged ||
        changed("date") ||
        changed("provider") ||
        (serviceId != null && suspendedOffer.serviceId !== serviceId);
    } else if (suspendedOffer.kind === "PROVIDER") {
      invalidateSuspended =
        serviceIdentityChanged ||
        changed("provider") ||
        (serviceId != null && suspendedOffer.serviceId !== serviceId);
    } else if (suspendedOffer.kind === "SERVICE") {
      invalidateSuspended =
        input.resolvedService != null ||
        serviceId != null ||
        serviceIdentityChanged ||
        changed("service");
    }
    if (invalidateSuspended) {
      suspendedOffer = null;
    }
  }

  // ── Goals (multi-intent foundation) ──────────────────────────────────────
  const goals = input.goals ? goalsFromDecision(input.goals) : [...state.goals];

  // ── Pending (deferred) domain goals — answer-and-continue (Slice 5) ──────
  // Carry forward the pending DOMAIN goal(s) an earlier answer-and-continue
  // turn deferred, so a secondary booking goal SURVIVES the answer, a topic
  // interruption, and next-turn continuation. A pending goal is dropped only
  // when it is RESUMED (the current turn pursues the same task goal) or
  // COMPLETED (a booking is written). The turn goal is computed just below;
  // we read it after it is resolved so a resumption clears the matching
  // pending goal deterministically.
  const resumingGoal = input.turnGoal ?? null;
  const resumesTask = resumingGoal != null && isTaskGoal(resumingGoal);
  let pendingGoals: ConversationGoal[] = state.pendingGoals.filter((goal) => {
    if (input.booked) return false; // a completed booking clears domain pendings
    // Resumed: the customer is pursuing this (or an unlabeled) pending task.
    if (resumesTask && (goal.intent === resumingGoal || goal.intent == null))
      return false;
    return true;
  });
  if (input.deferredGoals && input.deferredGoals.length > 0) {
    for (const goal of input.deferredGoals) {
      const next: ConversationGoal = {
        kind: goal.kind,
        ...(goal.intent ? { intent: goal.intent } : {}),
        ...(goal.priority !== undefined ? { priority: goal.priority } : {}),
        active: false,
      };
      const duplicate = pendingGoals.some(
        (existing) =>
          existing.kind === next.kind && existing.intent === next.intent,
      );
      if (!duplicate) pendingGoals.push(next);
    }
    if (pendingGoals.length > MAX_PENDING_GOALS) {
      pendingGoals = pendingGoals.slice(
        pendingGoals.length - MAX_PENDING_GOALS,
      );
    }
  }

  // ── Active task + topic interruption / return ────────────────────────────
  const turnGoal = input.turnGoal ?? state.currentGoal ?? null;
  let activeTask = state.activeTask;
  let topics: ConversationTopicFrame[] = state.topics.map((frame) => ({
    ...frame,
  }));
  // Was the active task suspended coming into this turn?
  let interrupted = topics.some(
    (frame) =>
      activeTask != null &&
      frame.goal === activeTask.kind &&
      frame.suspendState === "INTERRUPTED",
  );
  let recovering = false;

  if (turnGoal && isTaskGoal(turnGoal)) {
    if (!activeTask) {
      activeTask = { kind: turnGoal, stage: "GOAL_STATED" };
      topics = pushTopic(topics, { goal: turnGoal, suspendState: "ACTIVE" });
    } else if (activeTask.kind === turnGoal && interrupted) {
      // Return to the previously-interrupted task.
      recovering = true;
      interrupted = false;
      topics = topics.map((frame) =>
        frame.goal === turnGoal
          ? { ...frame, suspendState: "RECOVERING" }
          : frame,
      );
    } else if (activeTask.kind !== turnGoal) {
      // A different task goal replaces the active one.
      activeTask = { kind: turnGoal, stage: "GOAL_STATED" };
      topics = pushTopic(topics, { goal: turnGoal, suspendState: "ACTIVE" });
      interrupted = false;
    }
  } else if (turnGoal && activeTask && !interrupted) {
    // A non-task goal (e.g. FAQ / GREETING) interrupts the active task.
    const returnStage = state.bookingStage;
    topics = topics.map((frame) =>
      frame.goal === activeTask!.kind
        ? { ...frame, suspendState: "INTERRUPTED", returnStage }
        : frame,
    );
    topics = pushTopic(topics, { goal: turnGoal, suspendState: "ACTIVE" });
    interrupted = true;
  }

  // ── Pending offer (cached presentation; domain re-verifies at execution) ─
  let pendingOffer =
    input.pendingOffer !== undefined ? input.pendingOffer : state.pendingOffer;
  if (state.offer && offer && offer.status !== "ACTIVE") pendingOffer = null;

  // ── Booking-stage derivation ─────────────────────────────────────────────
  const hasTaskGoal =
    isTaskGoal(turnGoal) ||
    activeTask != null ||
    knownFacts.service != null ||
    knownFacts.date != null ||
    knownFacts.dateRange != null ||
    knownFacts.timePreference != null;

  let bookingStage: ConversationBookingStage;
  if (input.booked) {
    bookingStage = "COMPLETED";
  } else if (interrupted) {
    bookingStage = "INTERRUPTED";
  } else if (recovering) {
    bookingStage = "RECOVERING";
  } else {
    bookingStage = deriveBookingStage(knownFacts, hasTaskGoal, pendingOffer);
  }

  if (activeTask) {
    activeTask = { ...activeTask, stage: bookingStage };
  }

  // ── Missing facts + pending clarification (Slice 4) ──────────────────────
  // RESOLVE first: drop any outstanding missing fact the current turn now
  // knows (never re-ask for information already supplied — §7). Then, if a
  // clarification is RECORDED this turn, set the pending missing facts (minus
  // already-known) and mark `lastClarification`. A clarification whose facts
  // are all resolved clears `lastClarification` → the pending task resumes.
  let missingFacts = state.missingFacts.filter(
    (key) => knownFacts[key] == null,
  );
  let lastClarification = state.lastClarification;
  if (input.clarification) {
    missingFacts = (input.clarification.missingFacts ?? []).filter(
      (key) => knownFacts[key] == null,
    );
    lastClarification = {
      type: input.clarification.type,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.clarification.unresolvedTime
        ? { unresolvedTime: input.clarification.unresolvedTime }
        : {}),
    };
  } else if (lastClarification && missingFacts.length === 0) {
    // The outstanding clarification's facts are all supplied → resume.
    lastClarification = null;
  }

  const nextState: ConversationState = {
    currentGoal: turnGoal,
    activeTask,
    knownFacts,
    revisions,
    missingFacts,
    bookingStage,
    selectedService: knownFacts.service ?? null,
    selectedDate: knownFacts.date ?? null,
    dateRange: knownFacts.dateRange ?? null,
    selectedTimePref: knownFacts.timePreference ?? null,
    providerPreference: knownFacts.provider ?? null,
    topics,
    pendingOffer,
    goals,
    pendingGoals,
    lastClarification,
    serviceId,
    serviceSource,
    offer,
    suspendedOffer,
    completedTask: state.completedTask,
  };

  // ── Transitions (projected into Slice-0 observability) ───────────────────
  const lastRevision =
    revisions.length > state.revisions.length
      ? revisions[revisions.length - 1]
      : null;
  if (fromStage !== bookingStage || lastRevision) {
    transitions.push({
      from: fromStage,
      to: bookingStage,
      ...(lastRevision
        ? { factKey: lastRevision.key, isRevision: lastRevision.isRevision }
        : {}),
    });
  }

  return { state: nextState, transitions };
}

function pushTopic(
  topics: ConversationTopicFrame[],
  frame: ConversationTopicFrame,
): ConversationTopicFrame[] {
  const next = [...topics, frame];
  if (next.length > MAX_TOPIC_FRAMES) {
    next.splice(0, next.length - MAX_TOPIC_FRAMES);
  }
  return next;
}

// ─── History-derived state ───────────────────────────────────────────────────

/**
 * Derive the INITIAL/current `ConversationState` from the bounded, already-
 * persisted conversation history (the EXISTING persistence seam — messages).
 * This is the migration-safe baseline the target requires (§9): the state is
 * reconstructed from history and used as the fallback, so no new storage is
 * required for the foundation and the derivation reproduces today's implicit
 * understanding (the last presented offer + its booking-journey stage).
 *
 * Pure and deterministic. It never calls the classifier/LLM: it reads only
 * the structured offer the engine itself authored (`extractLastBookingOffer`),
 * so the derived state can never diverge from what the domain presented.
 */
export function deriveConversationStateFromHistory(
  recentChronological: ReadonlyArray<{ senderType: string; content: string }>,
): ConversationState {
  const base = emptyConversationState();
  const offer = extractLastBookingOffer(recentChronological);
  if (!offer) return base;

  const pendingOffer: ConversationPendingOffer = {
    serviceName: offer.serviceName,
    date: offer.date,
    options: offer.options,
    followUpRequestId: offer.followUpRequestId ?? null,
  };
  return {
    ...base,
    currentGoal: "BOOKING",
    activeTask: { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" },
    knownFacts: {
      service: offer.serviceName,
      date: offer.date,
      ...(offer.followUpRequestId
        ? { followUpRequestId: offer.followUpRequestId }
        : {}),
    },
    bookingStage: "AVAILABILITY_RESOLVED",
    selectedService: offer.serviceName,
    selectedDate: offer.date,
    topics: [{ goal: "BOOKING", suspendState: "ACTIVE" }],
    pendingOffer,
  };
}

// ─── Offer + task transitions (CONV-CORE-01) ─────────────────────────────────
//
// Every offer lifecycle change goes through these PURE functions so the
// conversation state has exactly ONE owner of its shape. The engine decides
// WHEN; these decide WHAT the next state is.

/** The legacy presentation mirror of a typed slot offer. */
export function pendingOfferMirror(
  offer: BookingOffer,
): ConversationPendingOffer | null {
  if (offer.kind !== "SLOT") return null;
  return {
    serviceName: offer.serviceName,
    date: offer.date,
    options: offer.options.map((o) => ({
      index: o.index,
      displayName: o.displayName,
      startTime: o.startAt.slice(11, 16),
      endTime: o.endAt.slice(11, 16),
    })),
    followUpRequestId: offer.followUpRequestId,
  };
}

/**
 * Present a NEW offer: it REPLACES any previous offer (single current offer;
 * a stale callback carrying the old token no longer matches). A slot offer
 * also records the facts it was resolved from, so the state and the offer
 * can never disagree about service/date.
 */
export function withPresentedOffer(
  state: ConversationState,
  offer: BookingOffer,
): ConversationState {
  const isSlot = offer.kind === "SLOT";
  const isBookingAction =
    isSlot ||
    offer.kind === "DATE" ||
    offer.kind === "PROVIDER" ||
    (offer.kind === "SERVICE" && offer.purpose === "BOOKING");
  const isWelcomeOrInquiry =
    offer.kind === "WELCOME" ||
    offer.kind === "SERVICE_DETAIL" ||
    (offer.kind === "SERVICE" && offer.purpose === "INQUIRY");

  // If presenting welcome or inquiry while an active booking offer is live, preserve it in suspendedOffer
  let suspendedOffer = state.suspendedOffer ?? null;
  if (
    isWelcomeOrInquiry &&
    state.offer &&
    (state.offer.kind === "SLOT" ||
      state.offer.kind === "DATE" ||
      state.offer.kind === "PROVIDER" ||
      (state.offer.kind === "SERVICE" && state.offer.purpose === "BOOKING")) &&
    state.offer.status === "ACTIVE"
  ) {
    suspendedOffer = state.offer;
  } else if (isBookingAction) {
    suspendedOffer = null;
  }

  const facts: ConversationKnownFacts = isSlot
    ? {
        ...state.knownFacts,
        service: state.knownFacts.service ?? offer.serviceName,
        date: state.knownFacts.date ?? offer.date,
        ...(offer.followUpRequestId
          ? { followUpRequestId: offer.followUpRequestId }
          : {}),
      }
    : state.knownFacts;

  const pendingOffer = pendingOfferMirror(offer);

  let activeTask = state.activeTask;
  if (isWelcomeOrInquiry) {
    activeTask = state.activeTask ?? null;
  } else if (isSlot) {
    activeTask = {
      kind: "BOOKING",
      stage: "AVAILABILITY_RESOLVED",
    };
  } else if (isBookingAction) {
    activeTask = {
      kind: "BOOKING",
      stage: state.activeTask?.stage ?? "GOAL_STATED",
    };
  }

  return {
    ...state,
    knownFacts: facts,
    selectedService: facts.service ?? null,
    selectedDate: facts.date ?? null,
    offer,
    suspendedOffer,
    pendingOffer,
    ...(isSlot
      ? {
          serviceId: offer.serviceId,
          serviceSource: offer.serviceSource,
          bookingStage: "AVAILABILITY_RESOLVED" as const,
        }
      : {}),
    activeTask,
  };
}

/** Move the current offer to a terminal/claimed status (no-op if none). */
export function withOfferStatus(
  state: ConversationState,
  status: BookingOffer["status"],
): ConversationState {
  if (!state.offer) return state;
  return {
    ...state,
    offer: { ...state.offer, status },
    pendingOffer: status === "ACTIVE" ? state.pendingOffer : null,
  };
}

/**
 * Completed-task transition: the booking was written by the DOMAIN. The offer
 * is CONSUMED, the booking facts are cleared (a new request starts clean), and
 * a minimal completed-task record keeps post-booking continuity.
 */
export function completeBookingTask(
  state: ConversationState,
  completed: Omit<ConversationCompletedTask, "kind">,
): ConversationState {
  const base = withOfferStatus(state, "CONSUMED");
  return {
    ...base,
    knownFacts: base.knownFacts.customerName
      ? { customerName: base.knownFacts.customerName }
      : {},
    selectedService: null,
    selectedDate: null,
    dateRange: null,
    selectedTimePref: null,
    providerPreference: null,
    serviceId: null,
    serviceSource: null,
    missingFacts: [],
    lastClarification: null,
    pendingGoals: [],
    activeTask: null,
    currentGoal: null,
    bookingStage: "COMPLETED",
    pendingOffer: null,
    suspendedOffer: null,
    completedTask: { kind: "BOOKING", ...completed },
  };
}

/** The offer the customer may still select right now (null when none/expired). */
export function liveOffer(
  state: ConversationState,
  now: Date,
): BookingOffer | null {
  return isOfferLive(state.offer, now) ? state.offer : null;
}

// ─── Durable envelope (CONV-CORE-01) ─────────────────────────────────────────
//
// The persisted JSON shape. Bounded, Zod-validated on EVERY load: a row that
// fails validation (corruption, an incompatible future version, a tampered
// value) is treated as ABSENT and the engine falls back to the legacy,
// history-derived path — never trusted partially.

export const CONVERSATION_STATE_VERSION = 1;

const unresolvedTimeFactSchema = z.object({
  hour: z.number().int().min(1).max(12),
  minute: z.number().int().min(0).max(59),
});

const factsSchema = z
  .object({
    service: z.string().max(200).optional(),
    date: z.string().max(40).optional(),
    dateRange: dateRangeSchema.optional(),
    timePreference: z.string().max(80).optional(),
    exactTime: z.string().max(20).optional(),
    unresolvedTime: unresolvedTimeFactSchema.optional(),
    provider: z.string().max(200).optional(),
    customerName: z.string().max(200).optional(),
    followUpRequestId: z.string().max(200).optional(),
  })
  .strict();

const stageSchema = z.enum(conversationBookingStageValues);

const persistedStateSchema = z.object({
  version: z.literal(CONVERSATION_STATE_VERSION),
  currentGoal: z.string().max(40).nullable(),
  activeTask: z
    .object({ kind: z.string().max(40), stage: stageSchema })
    .nullable(),
  knownFacts: factsSchema,
  missingFacts: z.array(z.enum(conversationFactKeys)).max(8),
  bookingStage: stageSchema,
  pendingGoals: z
    .array(
      z.object({
        kind: z.string().max(40),
        intent: z.string().max(40).optional(),
        priority: z.number().int().optional(),
        active: z.boolean(),
      }),
    )
    .max(MAX_PENDING_GOALS),
  lastClarification: z
    .object({
      type: z.string().max(60),
      turnId: z.string().max(100).optional(),
      unresolvedTime: unresolvedTimeFactSchema.optional(),
    })
    .nullable(),
  serviceId: z.string().max(200).nullable(),
  serviceSource: z.enum(["CUSTOMER", "DEFAULT"]).nullable(),
  offer: bookingOfferSchema.nullable(),
  suspendedOffer: bookingOfferSchema.nullable().optional(),
  completedTask: z
    .object({
      kind: z.literal("BOOKING"),
      appointmentId: z.string().max(200),
      serviceId: z.string().max(200),
      providerId: z.string().max(200).nullable(),
      date: z.string().max(40),
      completedAt: z.iso.datetime(),
    })
    .nullable(),
});

export type PersistedConversationState = z.infer<typeof persistedStateSchema>;

/** State → bounded persisted JSON (drops derived mirrors + revision log). */
export function dehydrateConversationState(
  state: ConversationState,
): PersistedConversationState {
  return {
    version: CONVERSATION_STATE_VERSION,
    currentGoal: state.currentGoal,
    activeTask: state.activeTask,
    knownFacts: { ...state.knownFacts },
    missingFacts: [...state.missingFacts],
    bookingStage: state.bookingStage,
    pendingGoals: state.pendingGoals.map((g) => ({ ...g })),
    lastClarification: state.lastClarification
      ? {
          type: state.lastClarification.type,
          ...(state.lastClarification.turnId
            ? { turnId: state.lastClarification.turnId }
            : {}),
          ...(state.lastClarification.unresolvedTime
            ? { unresolvedTime: state.lastClarification.unresolvedTime }
            : {}),
        }
      : null,
    serviceId: state.serviceId,
    serviceSource: state.serviceSource,
    offer: state.offer,
    suspendedOffer: state.suspendedOffer ?? null,
    completedTask: state.completedTask,
  };
}

/**
 * Persisted JSON → state, VALIDATED and TENANT-CHECKED. Returns null (treat as
 * absent) on any schema violation or when the stored offer is scoped to a
 * different business/conversation than the one being served.
 */
export function hydrateConversationState(
  raw: unknown,
  scope: { readonly businessId: string; readonly conversationId: string },
): ConversationState | null {
  if (typeof raw !== "object" || raw === null) return null;

  // Hydration must preserve old-state compatibility while refusing invalid new range fields safely
  let candidateRaw = raw;
  const rawObj = raw as Record<string, unknown>;
  if (
    rawObj.knownFacts &&
    typeof rawObj.knownFacts === "object" &&
    rawObj.knownFacts !== null
  ) {
    const rawFacts = rawObj.knownFacts as Record<string, unknown>;
    if (rawFacts.dateRange !== undefined) {
      const rangeRes = dateRangeSchema.safeParse(rawFacts.dateRange);
      if (!rangeRes.success) {
        const { dateRange: _invalidRange, ...sanitizedFacts } = rawFacts;
        void _invalidRange;
        candidateRaw = {
          ...rawObj,
          knownFacts: sanitizedFacts,
        };
      }
    }
  }

  const parsed = persistedStateSchema.safeParse(candidateRaw);
  if (!parsed.success) return null;
  const p = parsed.data;
  if (
    p.offer &&
    (p.offer.businessId !== scope.businessId ||
      p.offer.conversationId !== scope.conversationId)
  ) {
    return null;
  }
  if (
    p.suspendedOffer &&
    (p.suspendedOffer.businessId !== scope.businessId ||
      p.suspendedOffer.conversationId !== scope.conversationId)
  ) {
    return null;
  }
  const facts: ConversationKnownFacts = p.knownFacts;
  const base: ConversationState = {
    ...emptyConversationState(),
    currentGoal: p.currentGoal,
    activeTask: p.activeTask,
    knownFacts: facts,
    missingFacts: p.missingFacts,
    bookingStage: p.bookingStage,
    selectedService: facts.service ?? null,
    selectedDate: facts.date ?? null,
    dateRange: facts.dateRange ?? null,
    selectedTimePref: facts.timePreference ?? null,
    providerPreference: facts.provider ?? null,
    topics: p.activeTask
      ? [{ goal: p.activeTask.kind, suspendState: "ACTIVE" }]
      : [],
    pendingGoals: p.pendingGoals,
    lastClarification: p.lastClarification,
    serviceId: p.serviceId,
    serviceSource: p.serviceSource,
    offer: p.offer,
    suspendedOffer: p.suspendedOffer ?? null,
    completedTask: p.completedTask,
  };
  return {
    ...base,
    pendingOffer:
      p.offer && p.offer.status === "ACTIVE"
        ? pendingOfferMirror(p.offer)
        : null,
  };
}

// ─── CONV-CORE-02: Bounded Context Projection for AI Interpretation ──────────

export { conversationContextProjectionSchema };
export type { ConversationContextProjection };

/**
 * Project a minimal, typed, bounded view of durable conversation state for AI interpretation
 * (CONV-CORE-02 Step 3).
 *
 * Invariants:
 * - Omits internal DB identifiers, tokens, credentials, staff notes, and offer claim nonces.
 * - Stale, consumed, expired, or invalidated offers are NEVER projected as active.
 * - Last completed task is strictly historical and never revives as active work.
 * - Safe for callers with null/undefined state (returns null).
 */
export function projectConversationState(
  state: ConversationState | null | undefined,
  options?: { now?: Date },
): ConversationContextProjection | null {
  if (!state) return null;
  const now = options?.now ?? new Date();

  // Freshness & offer guards: only LIVE, ACTIVE offers are projected as selectable
  let activeOffer: ConversationContextProjection["activeOffer"] = null;
  if (
    state.offer &&
    state.offer.status === "ACTIVE" &&
    isOfferLive(state.offer, now) &&
    (state.offer.kind === "SERVICE" || state.offer.kind === "SLOT")
  ) {
    activeOffer = {
      type: state.offer.kind,
      itemCount: Math.min(state.offer.options.length, 10),
      offeredDate:
        state.offer.kind === "SLOT" ? (state.offer.date ?? null) : null,
      offeredServiceName:
        state.offer.kind === "SLOT" ? (state.offer.serviceName ?? null) : null,
    };
  }

  // Pending clarification
  let pendingClarification: ConversationContextProjection["pendingClarification"] =
    null;
  if (
    state.lastClarification ||
    (state.missingFacts && state.missingFacts.length > 0)
  ) {
    pendingClarification = {
      type: state.lastClarification?.type ?? "MISSING_FACTS",
      missingFacts: state.missingFacts.slice(0, 8),
      ...(state.lastClarification?.unresolvedTime
        ? { unresolvedTime: state.lastClarification.unresolvedTime }
        : state.knownFacts.unresolvedTime
          ? { unresolvedTime: state.knownFacts.unresolvedTime }
          : {}),
    };
  }

  // Bounded pending goals (max 4)
  const pendingGoals = state.pendingGoals
    ? state.pendingGoals.slice(0, 4).map((g) => ({
        kind: g.kind,
        intent: g.intent,
      }))
    : undefined;

  // Last completed task (historical context only)
  let lastCompletedTask: ConversationContextProjection["lastCompletedTask"] =
    null;
  if (state.completedTask) {
    lastCompletedTask = {
      kind: "BOOKING",
      serviceId: state.completedTask.serviceId,
      date: state.completedTask.date,
      completedAt: state.completedTask.completedAt,
    };
  }

  const rawProjection = {
    activeTask: state.activeTask
      ? {
          kind: state.activeTask.kind,
          stage: state.activeTask.stage,
        }
      : null,
    bookingStage: state.bookingStage,
    currentGoal: state.currentGoal,
    knownService: state.knownFacts.service ?? state.selectedService ?? null,
    resolvedServiceId: state.serviceId ?? null,
    knownDate: state.knownFacts.date ?? state.selectedDate ?? null,
    knownDateRange: state.knownFacts.dateRange ?? state.dateRange ?? null,
    timePreference:
      state.knownFacts.timePreference ?? state.selectedTimePref ?? null,
    knownExactTime: state.knownFacts.exactTime ?? null,
    providerPreference:
      state.knownFacts.provider ?? state.providerPreference ?? null,
    pendingClarification,
    pendingGoals,
    activeOffer,
    lastCompletedTask,
  };

  return conversationContextProjectionSchema.parse(rawProjection);
}
