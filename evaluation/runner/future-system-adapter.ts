/**
 * FlowPilot AI Evaluation — FUTURE_SYSTEM engine bridge adapter
 * (PROMPT-AI-EVAL-06).
 *
 * Evaluation-ONLY. NOT imported by production. This is the bridge the existing
 * `real-llm-adapter.ts` could not provide: it drives ONE customer turn through
 * the REAL Conversation Engine (`receiveInboundMessage`) — the SAME production
 * entry point a live WhatsApp turn uses — so the turn actually traverses:
 *
 *   real AI request/context construction (ai-context-builder)
 *     → deterministic bypass OR policy-backed LLM (REAL provider adapter)
 *     → AI response normalization / parseAiResponse
 *     → Conversation Engine
 *     → ConversationState (derived from persisted history)
 *     → resolveTurnPlan()           (turn-planner.ts, Slice 3)
 *     → CLARIFY / existing decision  (clarification.ts, Slice 4)
 *     → clarification handler        (engine-owned, AI_ACTIVE)
 *     → TurnObservability            (ai-observability.ts, Slice 0)
 *     → observable outcome
 *
 * It reuses the EXISTING production seams verbatim — there is NO second
 * Conversation Engine, resolver, ConversationState, clarification module, AI
 * contract, or prompt pipeline here. The ONLY thing this adapter supplies is
 * the EVALUATION BOUNDARY around them:
 *
 *  - The engine's repository dependencies are satisfied by ISOLATED in-memory
 *    stubs (`ConversationEngineDeps`), so NO production data is read or
 *    written: no appointment/booking/customer/provider/tenant/conversation
 *    persistence ever reaches a real database. The stubs ONLY isolate the
 *    external side effects — the real decision path runs unchanged.
 *  - The injected `ai` is the REAL policy-backed LLM ConversationAi (built by
 *    the CLI from the live provider/model via the existing provider factory).
 *    The adapter never mocks inference and never swaps the provider.
 *  - Per-case state PERSISTS across turns in the in-memory conversation, so a
 *    multi-turn case lets the engine resume a pending clarification from the
 *    history IT ACTUALLY AUTHORED (the migration-safe §9 derivation seam).
 *
 * The adapter captures ONLY sanitized observables (routing, turn plan,
 * clarification type + missing facts, provider/model machine keys, retry/
 * fallback counters, latency). It NEVER captures secrets, auth headers, raw
 * provider payloads, prompts, or chain-of-thought.
 */

import { randomUUID } from "node:crypto";

import type { AiResponse } from "@/features/conversations/server/ai-contract";
import { parseAiResponse } from "@/features/conversations/server/ai-contract";
import { derivePendingClarification } from "@/features/conversations/server/clarification";
import type { ConversationAi } from "@/features/conversations/server/conversation-ai";
import type {
  ConversationEngineDeps,
  InboundResult,
} from "@/features/conversations/server/conversation-engine";
import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import { deriveConversationStateFromHistory } from "@/features/conversations/server/conversation-state";
import type { AiTelemetry } from "@/server/integrations/ai/types";

import type { PendingStateSeedSpec } from "./pending-state-seed";

/** A fixed, eval-only tenant identity (never a real tenant). */
const EVAL_WHATSAPP_NUMBER = "+990000000000";
const EVAL_CUSTOMER_PHONE = "+990000000001";
const EVAL_BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const EVAL_BRANCH_ID = "44444444-4444-4444-8444-444444444444";
const EVAL_PROVIDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const EVAL_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

export type FutureTurnBusinessContext = {
  businessName: string;
  services: ReadonlyArray<{
    name: string;
    durationMinutes?: number | null;
    // Structured, OPTIONAL price columns (PROMPT-AI-ARCH-13 — Slice 6).
    // Evaluation-only overlay: a priced fixture carries these so the REAL
    // context builder exposes the price exactly as production would. Absent
    // ⇒ no price ⇒ the assistant must hand off a price question (NO_KNOWLEDGE).
    priceType?: string | null;
    priceAmount?: number | null;
    priceMaxAmount?: number | null;
    priceCurrency?: string | null;
    priceNote?: string | null;
  }>;
  faqs: ReadonlyArray<{ question: string; answer: string }>;
};

export type FutureTurnInput = {
  /** The evaluation case id — keys the per-case in-memory conversation. */
  caseId: string;
  /** The message's position in the full conversation. */
  turnIndex: number;
  /** The evaluated customer message. */
  message: string;
  /** The ordered messages BEFORE this one (causal context). */
  history: ReadonlyArray<{
    senderType: "CUSTOMER" | "AI" | "STAFF";
    content: string;
  }>;
  businessContext: FutureTurnBusinessContext;
};

/** Sanitized per-turn telemetry projected from the real provider call. */
export type FutureTurnTelemetry = {
  finalProvider: string;
  finalModel: string | null;
  fallbackUsed: boolean;
  /** Physical provider attempts across the logical turn (incl. bounded retry). */
  physicalAttempts: number;
  /** Bounded-retry count (attempts − 1, never negative). */
  retryCount: number;
  modelLatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  errorCode: string | null;
};

export type FutureTurnOutcome = {
  /** The REAL engine result for the turn (never thrown — captured). */
  engine: InboundResult;
  /** The LAST AI decision the engine's AI produced this turn (null = bypass). */
  decision: AiResponse | null;
  /** The decision was returned but violated the contract (engine → AI_FAILURE). */
  validatedNull: boolean;
  /** The provider/AI call threw (controlled failure → provider failure). */
  providerFailure: boolean;
  /** Generative model round-trips this turn (bypass = 0, normal = 1). */
  modelCallsThisTurn: number;
  telemetry: FutureTurnTelemetry;
  /** Total wall-clock for the engine turn. */
  totalLatencyMs: number;
};

/**
 * The AUDIT of an engine-authored pending-state seed (PROMPT-AI-EVAL-09). It
 * is explicit + sanitized (template text + machine keys only, never secrets or
 * chain-of-thought) and records BOTH what the engine actually authored AND what
 * the production reconstruction seams recover from that authored history, so a
 * reviewer can confirm the seed established the intended state through the SAME
 * path the real turn uses — never a second state representation.
 */
export type PendingStateSeedAudit = {
  readonly caseId: string;
  readonly specId: string;
  readonly specKind: string;
  readonly intendedClarification: string | null;
  readonly intendedMissingFacts: readonly string[];
  /** Setup turns the engine replayed (deterministic, no real inference). */
  readonly seededTurns: number;
  /** Real-provider calls made DURING seeding (MUST be 0 — deterministic). */
  readonly seedRealModelCalls: number;
  /** The messages the ENGINE authored into the per-case history (sanitized). */
  readonly authoredMessages: ReadonlyArray<{
    readonly senderType: string;
    readonly content: string;
  }>;
  /** What `derivePendingClarification` reconstructs from the authored history. */
  readonly reconstructedClarification: {
    readonly type: string;
    readonly missingFacts: readonly string[];
  } | null;
  /** What `deriveConversationStateFromHistory` reconstructs (active task). */
  readonly reconstructedActiveTask: {
    readonly kind: string;
    readonly stage: string;
  } | null;
  /** Whether the reconstruction matches the spec's intent (seed is valid). */
  readonly seedValid: boolean;
};

export type FutureSystemRunner = {
  /** The resolved identity (for the run manifest / report). */
  readonly identity: {
    primaryProvider: string;
    primaryModel: string;
    secondaryProvider: string | null;
    secondaryModel: string | null;
    fallbackEnabled: boolean;
  };
  runTurn(input: FutureTurnInput): Promise<FutureTurnOutcome>;
  /**
   * Establish an ENGINE-AUTHORED pending clarification / task state for a case
   * BEFORE a real-LLM turn (PROMPT-AI-EVAL-09). It replays the spec's
   * DETERMINISTIC setup turns through the REAL Conversation Engine with an
   * in-memory AI (ZERO real inference), so the engine authors its own
   * clarification / booking-offer templates into the per-case history. A later
   * `runTurn` on the SAME `caseId` then resumes from that history through the
   * production reconstruction seams — never a second state representation.
   */
  seedPendingState(input: {
    caseId: string;
    businessContext: FutureTurnBusinessContext;
    spec: PendingStateSeedSpec;
  }): Promise<PendingStateSeedAudit>;
  /** Drop any accumulated per-case state (used between independent runs). */
  reset(): void;
};

/** The injected AI — the production ConversationAi contract plus telemetry. */
export type InjectedConversationAi = ConversationAi & {
  getLastTelemetry?: () => AiTelemetry | null;
};

type InMemoryMessage = { senderType: string; content: string };

type CaseEnv = {
  messages: InMemoryMessage[];
  /** Stable per-service UUIDs (the eligibility seam validates id shape). */
  serviceIds: string[];
  conversation: {
    id: string;
    businessId: string;
    customerId: string;
    branchId: string | null;
    status: string;
    assignedUserId: null;
    aiSummary: string | null;
    lastMessageAt: Date;
    createdAt: Date;
    updatedAt: Date;
  } | null;
};

function openWeek(): Record<string, unknown> {
  const hours: Record<string, unknown> = {};
  for (const day of ["sat", "sun", "mon", "tue", "wed", "thu", "fri"]) {
    hours[day] = { open: "09:00", close: "18:00", closed: false };
  }
  return hours;
}

/**
 * Build the FUTURE_SYSTEM runner. The `ai` MUST be the real policy-backed LLM
 * for an evaluation run (built by the CLI from the live provider factory); the
 * structural check injects a stub ONLY to validate the wiring (never scored as
 * an evaluation result). The runner builds ONE isolated in-memory environment
 * per case and persists it across turns so multi-turn resume reflects the real
 * engine's own clarification.
 */
export function createFutureSystemRunner(params: {
  ai: InjectedConversationAi;
  identity: FutureSystemRunner["identity"];
}): FutureSystemRunner {
  const { ai, identity } = params;

  // Per-case persisted environment (the engine's own outputs accumulate here).
  const byCase = new Map<string, CaseEnv>();

  // Per-turn capture (reset before each engine turn).
  let modelCalls = 0;
  let lastDecision: AiResponse | null = null;
  let providerFailure = false;

  // The injected AI, WRAPPED to count generative round-trips and capture the
  // last decision + whether it threw. The engine calls `respond` at most once
  // per turn (zero on a deterministic bypass); the wrapper enforces nothing —
  // it only OBSERVES, so the zero-or-one invariant is measured, not imposed.
  const wrappedAi: InjectedConversationAi = {
    get providerName() {
      return ai.providerName;
    },
    async respond(request) {
      modelCalls += 1;
      try {
        const response = await ai.respond(request);
        lastDecision = response;
        return response;
      } catch (error) {
        providerFailure = true;
        throw error;
      }
    },
    getLastTelemetry() {
      return ai.getLastTelemetry ? ai.getLastTelemetry() : null;
    },
  };

  function telemetryFrom(tel: AiTelemetry | null): FutureTurnTelemetry {
    const attempts = tel?.attempts ?? [];
    const last = attempts[attempts.length - 1];
    const retryAttempts = tel?.retryTrace?.attempts.length ?? 0;
    const physicalAttempts =
      modelCalls === 0 ? 0 : Math.max(retryAttempts, attempts.length, 1);
    return {
      finalProvider:
        tel?.finalProvider ??
        (modelCalls === 0 ? "deterministic-bypass" : identity.primaryProvider),
      finalModel:
        tel?.finalModel ?? (modelCalls === 0 ? null : identity.primaryModel),
      fallbackUsed: tel?.fallbackUsed ?? false,
      physicalAttempts,
      retryCount: Math.max(0, physicalAttempts - 1),
      modelLatencyMs: last?.latencyMs ?? null,
      inputTokens: last?.inputTokens ?? null,
      outputTokens: last?.outputTokens ?? null,
      errorCode: last?.status === "FAILURE" ? (last.errorCode ?? null) : null,
    };
  }

  function buildDeps(
    env: CaseEnv,
    businessContext: FutureTurnBusinessContext,
    aiForTurn: InjectedConversationAi,
  ): ConversationEngineDeps {
    const now = new Date();
    const services = businessContext.services.map((service, index) => ({
      id: env.serviceIds[index] ?? (env.serviceIds[index] = randomUUID()),
      businessId: EVAL_BUSINESS_ID,
      name: service.name,
      description: null,
      durationMinutes: service.durationMinutes ?? 30,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      // Structured price columns (PROMPT-AI-ARCH-13 — Slice 6). Null unless a
      // priced eval overlay supplied them; the REAL context builder then
      // formats + task-gates them exactly as production does.
      priceType: service.priceType ?? null,
      priceAmount: service.priceAmount ?? null,
      priceMaxAmount: service.priceMaxAmount ?? null,
      priceCurrency: service.priceCurrency ?? null,
      priceNote: service.priceNote ?? null,
    }));
    const business = {
      id: EVAL_BUSINESS_ID,
      name: businessContext.businessName,
      vertical: null,
      city: null,
      whatsappNumber: EVAL_WHATSAPP_NUMBER,
      timezone: "Africa/Cairo",
      about: null,
      workingHours: openWeek(),
      slotDurationMinutes: 30,
      confirmationMode: "manual",
      faqs: businessContext.faqs.map((faq) => ({
        question: faq.question,
        answer: faq.answer,
      })),
      cancellationPolicy: null,
      onboardingCompletedAt: now,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      defaultBranchId: EVAL_BRANCH_ID,
    };
    const customer = {
      id: "eval-customer-1",
      businessId: EVAL_BUSINESS_ID,
      name: "عميل التقييم",
      phone: EVAL_CUSTOMER_PHONE,
      notes: null,
      lastConversationAt: null,
      lastAppointmentAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    const branch = {
      id: EVAL_BRANCH_ID,
      businessId: EVAL_BUSINESS_ID,
      name: "فرع التقييم",
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    let claimSeq = 0;
    let conversationSeq = 0;
    let appointmentSeq = 0;

    const deps = {
      businessRepository: {
        findByWhatsappNumber: async () => business,
        findById: async () => business,
      },
      branchRepository: {
        findDefaultByBusiness: async () => branch,
        findByIdWithinBusiness: async () => branch,
      },
      customerRepository: {
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () =>
          env.conversation ? { id: env.conversation.id } : null,
        findById: async () => env.conversation,
        create: async (input: {
          businessId: string;
          customerId: string;
          branchId: string | null;
        }) => {
          conversationSeq += 1;
          env.conversation = {
            id: `eval-conv-${conversationSeq}`,
            businessId: input.businessId,
            customerId: input.customerId,
            branchId: input.branchId,
            status: "AI_ACTIVE",
            assignedUserId: null,
            aiSummary: null,
            lastMessageAt: now,
            createdAt: now,
            updatedAt: now,
          };
          return env.conversation;
        },
        addMessage: async (
          input: { senderType: string; content: string },
          workflow?: { status?: string },
        ) => {
          env.messages.push({
            senderType: input.senderType,
            content: input.content,
          });
          if (workflow?.status && env.conversation) {
            env.conversation = { ...env.conversation, status: workflow.status };
          }
          return { id: `eval-msg-${env.messages.length}`, createdAt: now };
        },
        getMessages: async () => [...env.messages].reverse(),
        update: async (_id: string, patch: { aiSummary?: string | null }) => {
          if (env.conversation && patch.aiSummary !== undefined) {
            env.conversation = {
              ...env.conversation,
              aiSummary: patch.aiSummary ?? null,
            };
          }
          return env.conversation;
        },
        updateWorkflow: async (id: string, patch: { status: string }) => {
          if (env.conversation && env.conversation.id === id) {
            env.conversation = { ...env.conversation, status: patch.status };
          }
          return env.conversation;
        },
      },
      serviceRepository: {
        listByBusiness: async () => services,
        findById: async (id: string) =>
          services.find((service) => service.id === id) ?? null,
      },
      inboundDedupeRepository: {
        claim: async () => {
          claimSeq += 1;
          return {
            status: "claimed" as const,
            claimId: `eval-claim-${claimSeq}`,
          };
        },
      },
      usageRepository: {
        // Usage telemetry is best-effort; the eval boundary discards it.
        record: async (input: unknown) => input,
      },
      attentionRepository: {
        // Operator-attention is a notification layer; the eval boundary just
        // acknowledges it (no real queue, no real operator).
        open: async () => ({ id: "eval-attention-1" }),
      },
      providerRepository: {
        listEligibleForService: async () => [
          {
            id: EVAL_PROVIDER_ID,
            displayName: "مُقدّم التقييم",
            user: { name: "مُقدّم التقييم" },
          },
        ],
        listAssignmentSeams: async () => [
          { providerId: EVAL_PROVIDER_ID, userId: EVAL_USER_ID },
        ],
      },
      appointmentRepository: {
        listBlockingByAssignees: async () => [],
        createWithConflictCheck: async () => {
          // ISOLATED in-memory "write": returns a synthetic id so a booking
          // close-the-loop can complete during measurement WITHOUT ever
          // touching a real database. Never a production mutation.
          appointmentSeq += 1;
          return { id: `eval-appointment-${appointmentSeq}` };
        },
      },
      ai: aiForTurn,
      transport: {
        providerName: "eval-no-delivery",
        // NEVER performs live channel delivery — the eval boundary captures the
        // structured outcome only.
        send: async () => ({ provider: "eval-no-delivery", delivered: true }),
      },
    };

    return deps as unknown as ConversationEngineDeps;
  }

  return {
    identity,
    reset() {
      byCase.clear();
    },
    async seedPendingState(input: {
      caseId: string;
      businessContext: FutureTurnBusinessContext;
      spec: PendingStateSeedSpec;
    }): Promise<PendingStateSeedAudit> {
      const { caseId, businessContext, spec } = input;
      // A fresh per-case environment: the seed owns the pre-first-turn history
      // the engine will later resume from.
      let env = byCase.get(caseId);
      if (!env) {
        env = { messages: [], serviceIds: [], conversation: null };
        byCase.set(caseId, env);
      }

      // DETERMINISTIC seed AI (ZERO real inference): returns the spec's
      // normalized decision. It NEVER reaches a provider, so seeding adds no
      // real model round-trip by construction (invariant: harness adds no call).
      const seedRealModelCalls = 0;
      let seedDecision: AiResponse | null = null;
      const seedAi: InjectedConversationAi = {
        get providerName() {
          return "eval-seed-deterministic";
        },
        async respond() {
          // The seed must NEVER perform a real inference. The decision is the
          // spec's pre-authored normalized AI contract value.
          if (seedDecision === null) {
            throw new Error("seed decision missing for setup turn");
          }
          return seedDecision;
        },
        getLastTelemetry() {
          return null;
        },
      };

      // Replay each setup turn through the REAL engine so the ENGINE authors its
      // own clarification / offer template into the per-case history.
      for (let i = 0; i < spec.turns.length; i += 1) {
        const turn = spec.turns[i]!;
        seedDecision = turn.decision;
        const deps = buildDeps(env, businessContext, seedAi);
        await receiveInboundMessage(deps, {
          to: EVAL_WHATSAPP_NUMBER,
          from: EVAL_CUSTOMER_PHONE,
          text: turn.message,
          receivedAt: new Date().toISOString(),
          externalId: `${caseId}#seed#${i}#${env.messages.length}`,
        });
      }

      // Reconstruct state through the SAME production seams a real turn uses, so
      // the audit proves the seed established the intended state (never a second
      // representation). `getMessages` returns newest-first; the derivation
      // seams consume chronological order.
      const chronological = [...env.messages];
      const pending = derivePendingClarification(chronological);
      const derived = deriveConversationStateFromHistory(chronological);
      const reconstructedActiveTask = derived.activeTask
        ? { kind: derived.activeTask.kind, stage: derived.activeTask.stage }
        : null;

      const clarifyMatches =
        spec.intendedClarification === null
          ? pending === null
          : pending !== null && pending.type === spec.intendedClarification;
      const taskMatches =
        spec.kind === "RESUMABLE_BOOKING_OFFER"
          ? reconstructedActiveTask !== null
          : true;

      return {
        caseId,
        specId: spec.id,
        specKind: spec.kind,
        intendedClarification: spec.intendedClarification,
        intendedMissingFacts: spec.intendedMissingFacts,
        seededTurns: spec.turns.length,
        seedRealModelCalls,
        authoredMessages: env.messages.map((m) => ({
          senderType: m.senderType,
          content: m.content,
        })),
        reconstructedClarification: pending
          ? { type: pending.type, missingFacts: [...pending.missingFacts] }
          : null,
        reconstructedActiveTask,
        seedValid: clarifyMatches && taskMatches,
      };
    },
    async runTurn(input: FutureTurnInput): Promise<FutureTurnOutcome> {
      let env = byCase.get(input.caseId);
      if (!env) {
        // First turn for this case: seed the pre-first-customer causal context
        // (e.g. a leading AI offer) into the in-memory conversation so the
        // engine derives state from the SAME history the dataset presents.
        env = { messages: [], serviceIds: [], conversation: null };
        for (const message of input.history) {
          env.messages.push({
            senderType: message.senderType,
            content: message.content,
          });
        }
        byCase.set(input.caseId, env);
      }
      // On a subsequent turn the engine already accumulated its OWN prior
      // outputs in `env.messages`; the dataset's scripted AI lines are NOT
      // re-seeded, so the engine resumes from the clarification it actually
      // authored. When `seedPendingState` ran first, that history IS the
      // engine-authored pending state the real turn now resumes.

      const deps = buildDeps(env, input.businessContext, wrappedAi);

      // Reset per-turn capture.
      modelCalls = 0;
      lastDecision = null;
      providerFailure = false;

      const started = Date.now();
      const engineResult = await receiveInboundMessage(deps, {
        to: EVAL_WHATSAPP_NUMBER,
        from: EVAL_CUSTOMER_PHONE,
        text: input.message,
        receivedAt: new Date().toISOString(),
        externalId: `${input.caseId}#${input.turnIndex}#${env.messages.length}`,
      });
      const totalLatencyMs = Date.now() - started;

      const telemetry = telemetryFrom(wrappedAi.getLastTelemetry?.() ?? null);
      // A decision that was returned but violates the contract → engine maps to
      // a safe NEED_HUMAN (AI_FAILURE channel). parseAiResponse is the SAME
      // gate the engine uses.
      const validatedNull =
        !providerFailure &&
        lastDecision !== null &&
        parseAiResponse(lastDecision) === null;

      return {
        engine: engineResult,
        decision: lastDecision,
        validatedNull,
        providerFailure,
        modelCallsThisTurn: modelCalls,
        telemetry,
        totalLatencyMs,
      };
    },
  };
}
