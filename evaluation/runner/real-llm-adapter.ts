/**
 * FlowPilot AI Evaluation — REAL-LLM offline-replay adapter (PROMPT-AI-EVAL-04B).
 *
 * Evaluation-only. NOT imported by production. Mirrors the production decision
 * flow for ONE turn but drives the CURRENT effective LLM provider/model instead
 * of the deterministic assistant, so the baseline measures real model inference:
 *
 *   turn → AiRequest (message + history + business context)
 *        → bypassDeterministicAi(request)        (production runs this FIRST)
 *        → policy-backed LLM ConversationAi       (REAL provider/model call)
 *        → enforceDisclosure({response, context}) (B-03 gate, unchanged)
 *
 * This is EXACTLY the chain the Conversation Engine runs for a live turn
 * (`conversation-engine.ts`: `bypassDeterministicAi(aiRequest)` → else
 * `deps.ai.respond(aiRequest)` where `deps.ai` is the policy-backed LLM → the
 * disclosure gate). No prompt, contract, provider policy, or engine logic is
 * modified — this module only WIRES the existing production pieces together for
 * offline replay and captures sanitized telemetry (provider, model, latency,
 * physical attempt count, fallback usage). It NEVER performs channel delivery,
 * NEVER prints keys, and NEVER records chain-of-thought.
 *
 * Fidelity note: production calls `createPolicyBackedAi` per turn (it re-reads
 * the policy each respond). The effective policy does not change across a run,
 * so this adapter resolves the policy ONCE and reuses the built LLM — the same
 * provider/model/fallback wiring, without re-reading the DB 2,782 times.
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
import { bypassDeterministicAi } from "@/features/conversations/server/conversation-ai";
import type { EffectiveAiPolicy } from "@/lib/validation/platform";
import { createLlmConversationAi } from "@/server/integrations/ai/conversation-ai";
import type { LlmConversationAi } from "@/server/integrations/ai/conversation-ai";
import {
  adaptersFromEffectivePolicy,
  type AiFactoryEnvDeps,
} from "@/server/integrations/ai/factory";
import type { AiTelemetry } from "@/server/integrations/ai/types";

const EVAL_BUSINESS_ID = "eval-tenant";

/** Sanitized per-turn telemetry captured from the real provider call. */
export type RealTurnTelemetry = {
  /** Which seam produced the turn. */
  finalProvider: string;
  finalModel: string | null;
  finalStatus: "SUCCESS" | "FAILURE" | "BYPASS";
  fallbackUsed: boolean;
  /** Physical provider attempts across the logical turn (incl. bounded retry). */
  physicalAttempts: number;
  /** Model round-trip latency reported by the provider (last attempt). */
  modelLatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Sanitized failure classification when the logical turn failed. */
  errorCode: string | null;
};

export type RealTurnOutcome = {
  response: AiResponse;
  source: "deterministic-bypass" | "llm" | "controlled-failure";
  disclosure: "disclosed" | "requires-human";
  disclosureReason: DisclosureRefusalReason | null;
  support: readonly string[];
  /** True when the logical turn ended in a provider/AI failure (null → human). */
  providerFailure: boolean;
  telemetry: RealTurnTelemetry;
  /** Total wall-clock for the turn (bypass, or the whole LLM logical turn). */
  totalLatencyMs: number;
};

export type RealLlmTurnInput = {
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

function buildRequestForTurn(input: RealLlmTurnInput): AiRequest {
  return {
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
}

function contextSourcesForTurn(input: RealLlmTurnInput) {
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

/** The controlled failure the engine maps to NEED_HUMAN when the LLM fails. */
const CONTROLLED_FAILURE_RESPONSE: AiResponse = {
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

export type RealLlmRunner = {
  /** The resolved effective identity (for the run manifest / report). */
  readonly identity: {
    primaryProvider: string;
    primaryModel: string;
    secondaryProvider: string | null;
    secondaryModel: string | null;
    fallbackEnabled: boolean;
  };
  runTurn(input: RealLlmTurnInput): Promise<RealTurnOutcome>;
};

/**
 * Build a real-LLM turn runner from the CURRENT effective policy. The LLM
 * ConversationAi is constructed once from the same `adaptersFromEffectivePolicy`
 * production uses, so provider/model/fallback wiring is identical.
 */
export function createRealLlmRunner(
  effective: EffectiveAiPolicy,
  env: AiFactoryEnvDeps,
): RealLlmRunner {
  const { primary, secondary, fallbackEnabled } = adaptersFromEffectivePolicy(
    effective,
    env,
  );
  const llm: LlmConversationAi = createLlmConversationAi({
    primary,
    secondary,
    fallbackEnabled,
  });

  const identity = {
    primaryProvider: effective.primaryProvider,
    primaryModel: effective.primaryModel,
    secondaryProvider: effective.secondary?.provider ?? null,
    secondaryModel: effective.secondary?.model ?? null,
    fallbackEnabled,
  };

  function telemetryFrom(
    tel: AiTelemetry | null,
    status: "SUCCESS" | "FAILURE",
    errorCode: string | null,
  ): RealTurnTelemetry {
    const attempts = tel?.attempts ?? [];
    const last = attempts[attempts.length - 1];
    // physical attempts: prefer the bounded-retry trace count; else the
    // orchestrator attempt count (1 per provider tried).
    const retryAttempts = tel?.retryTrace?.attempts.length ?? 0;
    const physicalAttempts = Math.max(retryAttempts, attempts.length, 1);
    return {
      finalProvider: tel?.finalProvider ?? identity.primaryProvider,
      finalModel: tel?.finalModel ?? identity.primaryModel,
      finalStatus: status,
      fallbackUsed: tel?.fallbackUsed ?? false,
      physicalAttempts,
      modelLatencyMs: last?.latencyMs ?? null,
      inputTokens: last?.inputTokens ?? null,
      outputTokens: last?.outputTokens ?? null,
      errorCode:
        errorCode ??
        (last?.status === "FAILURE" ? (last.errorCode ?? null) : null),
    };
  }

  return {
    identity,
    async runTurn(input: RealLlmTurnInput): Promise<RealTurnOutcome> {
      const request = buildRequestForTurn(input);
      const built = buildAiContext(contextSourcesForTurn(input));
      const started = Date.now();

      // Production runs the deterministic bypass FIRST (greetings / empty).
      const bypass = bypassDeterministicAi(request);
      if (bypass) {
        const gate = enforceDisclosure({
          response: bypass,
          context: { request: built.request, facts: built.facts },
        });
        return {
          response: bypass,
          source: "deterministic-bypass",
          disclosure: gate.kind,
          disclosureReason: gate.kind === "requires-human" ? gate.reason : null,
          support: gate.kind === "disclosed" ? gate.support : [],
          providerFailure: false,
          telemetry: {
            finalProvider: "deterministic-bypass",
            finalModel: null,
            finalStatus: "BYPASS",
            fallbackUsed: false,
            physicalAttempts: 0,
            modelLatencyMs: null,
            inputTokens: null,
            outputTokens: null,
            errorCode: null,
          },
          totalLatencyMs: Date.now() - started,
        };
      }

      let response: AiResponse;
      let source: RealTurnOutcome["source"];
      let providerFailure = false;
      let status: "SUCCESS" | "FAILURE" = "SUCCESS";
      let errorCode: string | null = null;
      try {
        response = await llm.respond(request);
        source = "llm";
      } catch (err) {
        // Mirror the engine's fail-safe: null → controlled NEED_HUMAN handoff.
        response = CONTROLLED_FAILURE_RESPONSE;
        source = "controlled-failure";
        providerFailure = true;
        status = "FAILURE";
        errorCode = (err as Error).message.slice(0, 60) || "AI_FAILURE";
      }
      const tel = llm.getLastTelemetry();
      const telemetry = telemetryFrom(tel, status, errorCode);

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
        providerFailure,
        telemetry,
        totalLatencyMs: Date.now() - started,
      };
    },
  };
}
