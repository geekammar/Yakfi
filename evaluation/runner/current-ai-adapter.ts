/**
 * FlowPilot AI Evaluation — CURRENT-AI offline adapter.
 *
 * Executes the CURRENT production FlowPilot AI behavior against an
 * evaluation case, with NO network, NO database, NO API keys, and NO
 * customer-facing infrastructure. This is what makes the baseline
 * reproducible on any machine.
 *
 * It replays the exact offline chain the engine runs for a turn:
 *
 *   case → AiRequest (message + history + business context)
 *        → bypassDeterministicAi(request)          (deterministic bypass)
 *        → deterministicConversationAi.respond()   (the safe assistant)
 *        → enforceDisclosure({response, ledger})   (B-03 gate)
 *
 * The policy-backed live provider (openrouter/agentrouter/atria) is a
 * RUNTIME selection; the deterministic classifier above is the engine's
 * documented safe fallback AND the implementation `bypassDeterministicAi`
 * consults, so it is the correct offline-reproducible subject for the
 * current-AI baseline. Live-provider evaluation is a separate mode (see
 * the README) and is intentionally not required for the baseline.
 */

import { buildAiContext } from "@/features/conversations/server/ai-context-builder";
import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import { enforceDisclosure } from "@/features/conversations/server/ai-disclosure";
import type {
  DisclosureDecision,
  DisclosureRefusalReason,
} from "@/features/conversations/server/ai-disclosure";
import {
  bypassDeterministicAi,
  deterministicConversationAi,
} from "@/features/conversations/server/conversation-ai";

import type { EvaluationCase } from "../schema/dataset-schema";

/** A fixed, fake-but-well-formed tenant id for offline provenance. */
const EVAL_BUSINESS_ID = "eval-tenant";

export type TurnOutcome = {
  /** The assistant's structured response. */
  response: AiResponse;
  /** Which path produced the response. */
  source: "deterministic-bypass" | "deterministic-assistant";
  /** The disclosure gate verdict for the reply. */
  disclosure: "disclosed" | "requires-human";
  disclosureReason: DisclosureRefusalReason | null;
  /** Which ledger facts backed the reply (diagnostics). */
  support: readonly string[];
};

/**
 * A single evaluated turn expressed in the neutral shape the runner replays:
 * the message under evaluation plus the ordered prior messages (`history`) and
 * the business knowledge. This is the same information a case carries, but
 * decoupled from `EvaluationCase` so the runner can replay a multi-turn
 * conversation one turn at a time (PROMPT-AI-EVAL-03).
 */
export type CurrentAiTurnInput = {
  message: string;
  history: ReadonlyArray<{
    senderType: "CUSTOMER" | "AI" | "STAFF";
    content: string;
  }>;
  businessContext: {
    businessName: string;
    services: ReadonlyArray<{ name: string; durationMinutes?: number | null }>;
    faqs: ReadonlyArray<{ question: string; answer: string }>;
  };
};

/** Build the production-shaped `AiRequest` for one evaluation case. */
export function buildRequestForCase(c: EvaluationCase): AiRequest {
  return buildRequestForTurn(turnInputFromCase(c));
}

/** Build the production-shaped `AiRequest` for one neutral turn input. */
function buildRequestForTurn(input: CurrentAiTurnInput): AiRequest {
  const request: AiRequest = {
    message: input.message,
    conversationStatus: "AI_ACTIVE",
    recentMessages: input.history.map((m) => ({
      senderType: m.senderType,
      content: m.content,
    })),
    businessName: input.businessContext.businessName,
    services: input.businessContext.services.map((s) => ({ name: s.name })),
    faqs: input.businessContext.faqs.map((f) => ({
      question: f.question,
      answer: f.answer,
    })),
  };
  return request;
}

/** Project the evaluated (last) turn of a case into the neutral turn input. */
function turnInputFromCase(c: EvaluationCase): CurrentAiTurnInput {
  const messages = [...c.messages];
  const evaluated = messages[messages.length - 1];
  return {
    message: evaluated?.content ?? "",
    history: messages.slice(0, -1).map((m) => ({
      senderType: m.senderType as "CUSTOMER" | "AI" | "STAFF",
      content: m.content,
    })),
    businessContext: {
      businessName: c.businessContext.businessName,
      services: c.businessContext.services,
      faqs: c.businessContext.faqs,
    },
  };
}

/** The turn's business context, shaped for `buildAiContext` provenance. */
function contextSourcesForTurn(input: CurrentAiTurnInput) {
  return {
    scope: { businessId: EVAL_BUSINESS_ID },
    sources: {
      business: {
        businessId: EVAL_BUSINESS_ID,
        name: input.businessContext.businessName,
        faqs: input.businessContext.faqs.map((f) => ({
          question: f.question,
          answer: f.answer,
        })),
      },
      services: input.businessContext.services.map((s, i) => ({
        id: `eval-service-${i}`,
        businessId: EVAL_BUSINESS_ID,
        name: s.name,
        durationMinutes: s.durationMinutes ?? null,
      })),
      conversation: {
        status: "AI_ACTIVE" as const,
        recentMessages: input.history.map((m) => ({
          senderType: m.senderType,
          content: m.content,
        })),
      },
      message: input.message,
    },
  };
}

/**
 * Execute the current AI pipeline for ONE turn (the shared seam). Never
 * throws: a provider error is recorded as a failure outcome, mirroring the
 * engine's fail-safe. This is the single place the real production chain
 * (`bypassDeterministicAi` → `deterministicConversationAi.respond` →
 * `enforceDisclosure`) is invoked; both the case-level baseline runner and the
 * PROMPT-AI-EVAL-03 target replay through it, so the AI logic is never
 * duplicated in evaluation code.
 */
export async function runCurrentAiTurn(
  input: CurrentAiTurnInput,
): Promise<TurnOutcome> {
  const request = buildRequestForTurn(input);
  const built = buildAiContext(contextSourcesForTurn(input));

  let response: AiResponse;
  let source: TurnOutcome["source"];
  try {
    const bypass = bypassDeterministicAi(request);
    if (bypass) {
      response = bypass;
      source = "deterministic-bypass";
    } else {
      response = await deterministicConversationAi.respond(request);
      source = "deterministic-assistant";
    }
  } catch {
    response = {
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: "AMBIGUOUS",
      summary: null,
    };
    source = "deterministic-assistant";
  }

  const gate = enforceDisclosure({
    response,
    context: { request: built.request, facts: built.facts },
  });
  const disclosure: DisclosureDecision = gate.kind;
  return {
    response,
    source,
    disclosure,
    disclosureReason: gate.kind === "requires-human" ? gate.reason : null,
    support: gate.kind === "disclosed" ? gate.support : [],
  };
}

/**
 * Execute the current AI pipeline for one case (evaluated = last turn). Kept
 * for the FOUNDATION baseline runner; delegates to `runCurrentAiTurn`.
 */
export async function runCurrentAiForCase(
  c: EvaluationCase,
): Promise<TurnOutcome> {
  return runCurrentAiTurn(turnInputFromCase(c));
}
