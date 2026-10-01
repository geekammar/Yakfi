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
} from "@/features/conversations/server/ai-contract";
import type { OfferedBookingOption } from "@/features/conversations/server/booking-selection";
import { extractLastBookingOffer } from "@/features/conversations/server/booking-selection";

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

/**
 * The closed set of conversation fact keys this state tracks. Unknown keys
 * on an incoming `factUpdate` are ignored (never a second fact model).
 */
export const conversationFactKeys = [
  "service",
  "date",
  "timePreference",
  "provider",
  "customerName",
] as const;

export type ConversationFactKey = (typeof conversationFactKeys)[number];

const factKeySet: ReadonlySet<string> = new Set(conversationFactKeys);

function isFactKey(key: string): key is ConversationFactKey {
  return factKeySet.has(key);
}

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
  readonly timePreference?: string;
  readonly provider?: string;
  readonly customerName?: string;
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
  readonly to: string;
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
  readonly selectedTimePref: string | null;
  readonly providerPreference: string | null;
  /** The bounded topic/interruption stack (topic switch + return). */
  readonly topics: readonly ConversationTopicFrame[];
  /** A cached, re-verifiable presentation of the last domain offer. */
  readonly pendingOffer: ConversationPendingOffer | null;
  /** Goals the conversation is pursuing (multi-intent foundation). */
  readonly goals: readonly ConversationGoal[];
  /** The last clarification the engine recorded (future slices populate). */
  readonly lastClarification: {
    readonly type: string;
    readonly turnId?: string;
  } | null;
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
    selectedTimePref: null,
    providerPreference: null,
    topics: [],
    pendingOffer: null,
    goals: [],
    lastClarification: null,
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
  if (facts.date) return "DATE_SUPPLIED";
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
  } | null;
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
    const nextValue = update.value;
    const prevValue = knownFacts[key] ?? null;

    if (prevValue === nextValue) continue; // unchanged → no-op

    if (prevValue !== null) {
      // Corrected or conflicting: the latest value wins, but we log WHY.
      revisions.push({
        key,
        from: prevValue,
        to: nextValue,
        isRevision: update.isRevision === true,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      });
    }
    knownFacts = { ...knownFacts, [key]: nextValue };
  }

  if (revisions.length > MAX_REVISIONS) {
    revisions.splice(0, revisions.length - MAX_REVISIONS);
  }

  // ── Goals (multi-intent foundation) ──────────────────────────────────────
  const goals = input.goals ? goalsFromDecision(input.goals) : [...state.goals];

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
  const pendingOffer =
    input.pendingOffer !== undefined ? input.pendingOffer : state.pendingOffer;

  // ── Booking-stage derivation ─────────────────────────────────────────────
  const hasTaskGoal =
    isTaskGoal(turnGoal) ||
    activeTask != null ||
    knownFacts.service != null ||
    knownFacts.date != null ||
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
    selectedTimePref: knownFacts.timePreference ?? null,
    providerPreference: knownFacts.provider ?? null,
    topics,
    pendingOffer,
    goals,
    lastClarification,
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
  };
  return {
    ...base,
    currentGoal: "BOOKING",
    activeTask: { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" },
    knownFacts: { service: offer.serviceName, date: offer.date },
    bookingStage: "AVAILABILITY_RESOLVED",
    selectedService: offer.serviceName,
    selectedDate: offer.date,
    topics: [{ goal: "BOOKING", suspendState: "ACTIVE" }],
    pendingOffer,
  };
}
