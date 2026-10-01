/**
 * FlowPilot AI Evaluation — Coverage matrix (PROMPT-AI-EVAL-DESIGN-01).
 *
 * The coverage matrix answers "which high-value combinations does this
 * dataset actually exercise, and which are empty?". It is deliberately NOT
 * the Cartesian product of the dimensions: that would explode into hundreds
 * of thousands of meaningless cells (every register × every edge × every
 * behavior). Instead each dimension is profiled INDEPENDENTLY, plus a small
 * set of CURATED JOINT CELLS — the combinations that actually carry signal —
 * are declared explicitly and checked for population.
 *
 * The 11 required dimensions (see `coverageDimensions`):
 *   1. Intent/goal          2. Language          3. Customer behavior
 *   4. Conversation length  5. Multi-intent      6. Ambiguity
 *   7. Knowledge            8. Booking state     9. Handoff
 *  10. Safety              11. Edge rarity
 *
 * How a future generator uses this (the binding discipline):
 * - NEVER enumerate the full product. Pick a TARGET cell from the curated
 *   joint set, find its empty members, and author scenarios only for those.
 * - A dimension member with zero cases is a GAP to fill, not a bug to fix —
 *   `describeCoverage` reports it as `{ populated: false }`.
 * - A curated joint cell with zero cases is the highest-value authoring
 *   target, because it names a combination that carries real risk.
 */

import type { EvaluationCase } from "./dataset-schema";
import type {
  BookingJourneyState,
  ClarificationType,
  CustomerBehavior,
  EdgeCategory,
  HandoffExpectation,
  KnowledgeRequirement,
  LanguageRegister,
  SafetyExpectation,
} from "./taxonomy";
import {
  bookingJourneyStateValues,
  customerBehaviorValues,
  edgeCategoryValues,
  handoffExpectationValues,
  knowledgeRequirementValues,
  languageRegisterValues,
  rarityValues,
  safetyExpectationValues,
} from "./taxonomy";

/**
 * One dimension of the matrix. `project` extracts the member label(s) a case
 * occupies on this dimension (a case may occupy several — multi-label
 * dimensions are first-class, which is what avoids forcing one cell per case).
 */
export type CoverageDimension = {
  /** The dimension name (stable across dataset versions). */
  name: string;
  /** Why the dimension exists — the risk under-measurement creates. */
  purpose: string;
  /** The full member vocabulary this dimension can address. */
  members: readonly string[];
  /** The member labels a given case occupies on this dimension. */
  project: (c: EvaluationCase) => string[];
  /**
   * True when a case occupies MORE than one member — a multi-label
   * dimension (multi-intent, edge categories, behavior). Multi-label
   * dimensions are profiled by occupancy, never by exclusive partition.
   */
  multiLabel: boolean;
};

/** The 11 required coverage dimensions. */
export const coverageDimensions: CoverageDimension[] = [
  {
    name: "intent",
    purpose: "What the customer wants — the goal space the assistant reads.",
    members: [
      "GREETING",
      "FAQ",
      "BOOKING",
      "AVAILABILITY",
      "RESCHEDULE",
      "CANCELLATION",
      "HUMAN_REQUEST",
      "AMBIGUOUS",
      "SERVICE_DISCOVERY",
      "SERVICE_INFO",
      "SERVICE_PRICE",
      "BUSINESS_INFO",
      "LOCATION",
      "HOURS",
      "CONFIRMATION",
      "FOLLOW_UP",
      "MULTI_INTENT",
      "TOPIC_SWITCH",
      "KNOWLEDGE_GAP",
      "CLARIFICATION_REQUIRED",
    ],
    project: (c) => [c.expectedSemanticLabel.primaryIntent],
    multiLabel: false,
  },
  {
    name: "language",
    purpose:
      "Egyptian language variation — the surface form must not change the label.",
    members: languageRegisterValues as readonly string[],
    project: (c) => [c.languageProfile.register],
    multiLabel: false,
  },
  {
    name: "customer-behavior",
    purpose:
      "HOW the customer behaves — vague, corrective, hurried, changing their mind.",
    members: customerBehaviorValues as readonly string[],
    project: (c) => {
      const out: string[] = [];
      if (c.customerBehavior) {
        out.push(...c.customerBehavior.dispositions);
        // `NONE` is a real member of the change-of-state vocabulary: it
        // asserts "the profile is present and no fact was revised". Emitting
        // it keeps the matrix honest — otherwise `NONE` is structurally
        // unpopulatable and always reported as a phantom gap.
        out.push(c.customerBehavior.changeOfState);
      }
      return out;
    },
    multiLabel: true,
  },
  {
    name: "conversation-length",
    purpose: "Single-turn, short/medium/long multi-turn, and long-context.",
    members: [
      "SINGLE_TURN",
      "TWO_TURN",
      "SHORT_MULTI_TURN",
      "MEDIUM_MULTI_TURN",
      "LONG_MULTI_TURN",
    ],
    project: (c) => [c.conversationType],
    multiLabel: false,
  },
  {
    name: "multi-intent",
    purpose: "Turns carrying more than one goal, and their priority ordering.",
    members: ["SINGLE_GOAL", "MULTI_GOAL"],
    project: (c) => [
      c.expectedSemanticLabel.secondaryIntents.length > 0
        ? "MULTI_GOAL"
        : "SINGLE_GOAL",
    ],
    multiLabel: false,
  },
  {
    name: "ambiguity",
    purpose:
      "Ambiguity the assistant must resolve or honestly escalate — never guess.",
    members: [
      "UNAMBIGUOUS",
      "AMBIGUOUS_CLARIFIABLE",
      "AMBIGUOUS_NEEDS_HUMAN",
      "AMBIGUOUS_STATE_RESOLVES",
    ],
    project: (c) => {
      const edges = new Set(c.edgeCategories);
      const clarifies: ClarificationType =
        c.expectedClarification?.type ?? "NONE";
      if (edges.has("AMBIGUOUS_NEEDS_HUMAN")) return ["AMBIGUOUS_NEEDS_HUMAN"];
      if (edges.has("AMBIGUOUS_CLARIFIABLE")) return ["AMBIGUOUS_CLARIFIABLE"];
      if (edges.has("AMBIGUOUS_STATE_RESOLVES")) {
        return ["AMBIGUOUS_STATE_RESOLVES"];
      }
      if (clarifies !== "NONE") return ["AMBIGUOUS_CLARIFIABLE"];
      if (edges.has("AMBIGUOUS")) return ["AMBIGUOUS_NEEDS_HUMAN"];
      return ["UNAMBIGUOUS"];
    },
    multiLabel: false,
  },
  {
    name: "knowledge",
    purpose: "What the turn must KNOW, and what happens when it does not.",
    members: knowledgeRequirementValues as readonly string[],
    project: (c) => [c.expectedKnowledgeRequirement],
    multiLabel: false,
  },
  {
    name: "booking-state",
    purpose:
      "The booking journey's causal progression, including interruption and recovery.",
    members: bookingJourneyStateValues as readonly string[],
    project: (c) => {
      const t = c.expectedStateTransition;
      const journey = t?.bookingJourneyState ?? t?.to;
      return journey ? [journey] : ["NOT_APPLICABLE"];
    },
    multiLabel: false,
  },
  {
    name: "handoff",
    purpose:
      "The true-vs-unnecessary handoff split — the primary robustness axis.",
    members: handoffExpectationValues as readonly string[],
    project: (c) => [c.expectedHandoff.expectation],
    multiLabel: false,
  },
  {
    name: "safety",
    purpose: "Sensitive and adversarial turns — the must-never-violate axis.",
    members: safetyExpectationValues as readonly string[],
    project: (c) => [c.safetyExpectation ?? "SAFE"],
    multiLabel: false,
  },
  {
    name: "edge-rarity",
    purpose:
      "Rare cases are represented ON PURPOSE — robustness is not average-case.",
    members: rarityValues as readonly string[],
    project: (c) => [c.rarity],
    multiLabel: false,
  },
];

export const COVERAGE_DIMENSION_NAMES = coverageDimensions.map((d) => d.name);

/**
 * One curated JOINT cell — a combination of (dimension → member) requirements
 * that carries real signal and is therefore worth authoring intentionally.
 * A case belongs to the cell when it satisfies EVERY requirement.
 */
export type CuratedCell = {
  /** Stable cell id — the authoring target a generator names in its plan. */
  id: string;
  /** Why this combination matters (the risk it exercises). */
  rationale: string;
  /** The (dimension name → required member) requirements. */
  requires: Record<string, string>;
};

/**
 * The curated joint cells for the Egyptian dataset. Kept small and
 * intentional: this is how the matrix stays a guidance tool instead of a
 * combinatorial explosion. Future generators ADD cells here; they never
 * compute the product.
 */
export const curatedCoverageCells: CuratedCell[] = [
  {
    id: "egyptian-booking-arabizi",
    rationale:
      "A booking intent in Latin-script Arabizi — script switching must not erase the goal.",
    requires: { intent: "BOOKING", language: "ARABIZI" },
  },
  {
    id: "egyptian-human-request-clitic",
    rationale:
      "An explicit human request with Egyptian clitic attachment — the known F1 root cause.",
    requires: {
      intent: "HUMAN_REQUEST",
      "customer-behavior": "REQUESTS_HUMAN_EXPLICITLY",
    },
  },
  {
    id: "egyptian-knowledge-gap-price",
    rationale:
      "A price question with no price knowledge — the assistant must not invent one.",
    requires: { intent: "SERVICE_PRICE", knowledge: "KNOWLEDGE_GAP" },
  },
  {
    id: "egyptian-clarification-ambiguous-booking",
    rationale:
      "An ambiguous booking the ideal assistant would clarify instead of escalate.",
    requires: {
      intent: "CLARIFICATION_REQUIRED",
      ambiguity: "AMBIGUOUS_CLARIFIABLE",
      handoff: "NOT_REQUIRED",
    },
  },
  {
    id: "egyptian-change-date-mid-journey",
    rationale:
      "A customer revising the date mid-journey — the expected state must move WITH the revision.",
    requires: {
      "customer-behavior": "CHANGES_DATE",
      "booking-state": "DATE_SUPPLIED",
      handoff: "ACCEPTABLE_EITHER",
    },
  },
  {
    id: "egyptian-sensitive-medical-handoff",
    rationale:
      "A medical-sensitivity turn that must reach a human and never be diagnosed.",
    requires: { safety: "SENSITIVE_MEDICAL", handoff: "REQUIRED" },
  },
  {
    id: "egyptian-prompt-injection-refusal",
    rationale:
      "An instruction-injection attempt that must be refused, not followed.",
    requires: { safety: "SECURITY_ATTEMPT", intent: "AMBIGUOUS" },
  },
  {
    id: "egyptian-long-context-topic-return",
    rationale:
      "A long conversation that returns to an earlier topic — memory across many turns.",
    requires: {
      "conversation-length": "LONG_MULTI_TURN",
      intent: "TOPIC_SWITCH",
    },
  },
  {
    id: "egyptian-multi-intent-discovery-plus-booking",
    rationale:
      "The canonical multi-intent turn: asking about services while booking.",
    requires: {
      "multi-intent": "MULTI_GOAL",
      intent: "SERVICE_DISCOVERY",
    },
  },
  {
    id: "egyptian-stt-fragmented-availability",
    rationale:
      "A speech-to-text fragment asking about availability — noise must not erase the intent.",
    requires: { intent: "AVAILABILITY", language: "EGYPTIAN_COLLOQUIAL" },
  },
];

/** The profile of one dimension member: how many cases occupy it. */
export type MemberProfile = {
  dimension: string;
  member: string;
  count: number;
  /** False when the vocabulary member has zero cases (a gap to fill). */
  populated: boolean;
  /** Example case ids, capped for triage readability. */
  exampleCaseIds: string[];
};

/** The coverage profile for a whole dataset. */
export type CoverageProfile = {
  datasetVersion: string;
  totalCases: number;
  perDimension: Record<
    string,
    {
      dimension: string;
      purpose: string;
      multiLabel: boolean;
      populatedMembers: number;
      totalMembers: number;
      members: MemberProfile[];
    }
  >;
  /** Members of the vocabulary with zero cases, grouped by dimension. */
  gaps: MemberProfile[];
  /** The curated joint cells and how many cases satisfy each. */
  curatedCells: {
    cell: CuratedCell;
    count: number;
    populated: boolean;
    exampleCaseIds: string[];
  }[];
  /** Curated cells with zero cases — the highest-value authoring targets. */
  emptyCuratedCells: CuratedCell[];
};

const EXAMPLE_CAP = 3;

/**
 * Compute the coverage profile of a dataset. Pure: given the same cases it
 * always returns the same profile, so it is reproducible offline.
 */
export function describeCoverage(
  cases: EvaluationCase[],
  datasetVersion = "unknown",
): CoverageProfile {
  const perDimension: CoverageProfile["perDimension"] = {};
  const gaps: MemberProfile[] = [];
  for (const dim of coverageDimensions) {
    const counts = new Map<string, string[]>();
    for (const c of cases) {
      for (const member of dim.project(c)) {
        const list = counts.get(member);
        if (list) list.push(c.caseId);
        else counts.set(member, [c.caseId]);
      }
    }
    const members: MemberProfile[] = dim.members.map((member) => {
      const ids = counts.get(member) ?? [];
      return {
        dimension: dim.name,
        member,
        count: ids.length,
        populated: ids.length > 0,
        exampleCaseIds: ids.slice(0, EXAMPLE_CAP),
      };
    });
    // A member the case data occupies but the vocabulary does not list is a
    // drift signal, not a gap; record it so the harness can fail loudly.
    for (const member of counts.keys()) {
      if (!dim.members.includes(member)) {
        const ids = counts.get(member) ?? [];
        members.push({
          dimension: dim.name,
          member: `[UNLISTED] ${member}`,
          count: ids.length,
          populated: true,
          exampleCaseIds: ids.slice(0, EXAMPLE_CAP),
        });
      }
    }
    perDimension[dim.name] = {
      dimension: dim.name,
      purpose: dim.purpose,
      multiLabel: dim.multiLabel,
      populatedMembers: members.filter((m) => m.populated).length,
      totalMembers: dim.members.length,
      members,
    };
    for (const m of members) {
      if (!m.populated) gaps.push(m);
    }
  }

  const cellResults = curatedCoverageCells.map((cell) => {
    const matching: string[] = [];
    for (const c of cases) {
      if (caseSatisfiesCell(c, cell)) matching.push(c.caseId);
    }
    return {
      cell,
      count: matching.length,
      populated: matching.length > 0,
      exampleCaseIds: matching.slice(0, EXAMPLE_CAP),
    };
  });

  return {
    datasetVersion,
    totalCases: cases.length,
    perDimension,
    gaps,
    curatedCells: cellResults,
    emptyCuratedCells: cellResults
      .filter((r) => !r.populated)
      .map((r) => r.cell),
  };
}

/** Does a case satisfy every requirement of a curated cell? */
export function caseSatisfiesCell(
  c: EvaluationCase,
  cell: CuratedCell,
): boolean {
  for (const [dimensionName, requiredMember] of Object.entries(cell.requires)) {
    const dimension = coverageDimensions.find((d) => d.name === dimensionName);
    if (!dimension) return false;
    const occupied = dimension.project(c);
    if (!occupied.includes(requiredMember)) return false;
  }
  return true;
}

/**
 * The authoring-plan contract for a future generator: given the current
 * profile and a target number of new scenarios, return the cells worth
 * filling first. Ordering rule: EMPTY curated cells first (highest signal),
 * then unpopulated vocabulary members (breadth), then the thinnest populated
 * members (depth). This is how the matrix prevents combinatorial explosion:
 * the generator never enumerates the product, it walks this ordered list.
 */
export function recommendAuthoringTargets(
  profile: CoverageProfile,
  limit = 10,
): string[] {
  const targets: { id: string; rank: number }[] = [];
  for (const cell of profile.emptyCuratedCells) {
    targets.push({ id: `cell:${cell.id}`, rank: 0 });
  }
  for (const gap of profile.gaps) {
    targets.push({ id: `${gap.dimension}:${gap.member}`, rank: 1 });
  }
  for (const dim of Object.values(profile.perDimension)) {
    for (const m of dim.members.filter((x) => x.populated && x.count < 5)) {
      targets.push({ id: `${dim.dimension}:${m.member}`, rank: 2 + m.count });
    }
  }
  targets.sort((a, b) => a.rank - b.rank);
  return targets.slice(0, limit).map((t) => t.id);
}

/** Convenience accessors for the typed vocabularies the matrix projects onto. */
export function edgeCategoryVocabulary(): readonly EdgeCategory[] {
  return edgeCategoryValues;
}
export function languageRegisterVocabulary(): readonly LanguageRegister[] {
  return languageRegisterValues;
}
export function knowledgeRequirementVocabulary(): readonly KnowledgeRequirement[] {
  return knowledgeRequirementValues;
}
export function handoffExpectationVocabulary(): readonly HandoffExpectation[] {
  return handoffExpectationValues;
}
export function safetyExpectationVocabulary(): readonly SafetyExpectation[] {
  return safetyExpectationValues;
}
export function customerBehaviorVocabulary(): readonly CustomerBehavior[] {
  return customerBehaviorValues;
}
export function bookingJourneyVocabulary(): readonly BookingJourneyState[] {
  return bookingJourneyStateValues;
}
