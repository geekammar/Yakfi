/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — TypeSafe JEV Instrumented Runner
 * CONV-JEV-01: Real TypeSafe JEV Default Engine & Benchmark Harness.
 *
 * Runs scenarios through Goal-Driven State + TypeSafe JEV semantic engine.
 * Supports:
 *   - Live mode (--live): Real network requests to OpenRouter Decisions API
 *     using pinned model `typesafe/jev-1.13`.
 *   - Offline mode: Deterministic local simulation visibly labeled OFFLINE_SIMULATION / MOCK.
 *
 * Strict Rule: Never fabricate live metrics. If live JEV cannot run due to missing
 * key or budget block, returns REAL_JEV_BENCHMARK_BLOCKED.
 */

import { parseApprovedMonthlyBudget } from "@/server/integrations/ai/factory";
import {
  JEV_PINNED_MODEL,
  createJevDecisionsProvider,
  type JevDecisionsProvider,
  type JevDecisionsResult,
  type JevEvaluationRequest,
  type JevQuestion,
} from "@/server/integrations/ai/jev-decisions-provider";

import { normalizeArabic } from "./goal-driven-engine";
import { runGoalDrivenScenario } from "./goal-driven-runner";
import type { PlaygroundHarness } from "./harness";
import type { ScenarioDefinition, ScenarioTrace } from "./types";

/**
 * Creates an offline simulation provider visibly marked as MOCK.
 * Used for fast local unit testing without spending remote credits.
 */
export function createOfflineSimulatedJevProvider(): JevDecisionsProvider {
  return {
    model: JEV_PINNED_MODEL,
    secretRef: "MOCK",
    evaluate: async (
      request: JevEvaluationRequest,
    ): Promise<JevDecisionsResult> => {
      const rawText = String(request.state?.customerMessage ?? "");
      const normText = normalizeArabic(rawText);

      const answers: Record<string, any> = {};

      // Simulated atomic facts matching semantic contract
      for (const [key, rawQ] of Object.entries(request.questions)) {
        const q = rawQ as JevQuestion;
        if (q.type === "noul") {
          let p = 0.05;
          if (
            key === "is_booking_request" &&
            /(?:احجز|حجز|معاد|موعد|بكرة|النهاردة|دكتور|كشف|جلسة)/.test(normText)
          ) {
            p = 0.96;
          } else if (
            key === "is_emergency" &&
            /(?:نزيف|طارئ|طوارئ|حادث|الم\s+شديد|تسمم)/.test(normText)
          ) {
            p = 0.99;
          } else if (
            key === "is_human_request" &&
            /(?:موظف|انسان|شخص|خدمة\s+العملاء|مسؤول)/.test(normText)
          ) {
            p = 0.98;
          } else if (
            key === "is_cancellation" &&
            /(?:الغي|الغاء|كنسل|مش\s+هاحضر|مش\s+هقدر)/.test(normText)
          ) {
            p = 0.95;
          } else if (
            key === "is_catalog_faq" &&
            /(?:ايه\s+الخدمات|الاسعار|عنوانكم|مواعيد\s+العمل|تقويم)/.test(
              normText,
            )
          ) {
            p = 0.94;
          }
          answers[key] = {
            type: "noul",
            probability: p,
            criteria: q.criteria,
          };
        } else if (q.type === "choice") {
          let selection = "unknown";
          if (
            /(?:احجز|حجز|معاد|موعد|بكرة|النهاردة|دكتور|كشف|جلسة)/.test(normText)
          ) {
            selection = "booking";
          } else if (
            /(?:ايه\s+الخدمات|الاسعار|عنوانكم|مواعيد\s+العمل|تقويم)/.test(
              normText,
            )
          ) {
            selection = "catalog_faq";
          } else if (/(?:الغي|الغاء|كنسل)/.test(normText)) {
            selection = "cancellation";
          } else if (/(?:موظف|انسان|شخص)/.test(normText)) {
            selection = "human_request";
          }

          answers[key] = {
            type: "choice",
            selection,
            probabilities: {
              [selection]: 0.92,
              unknown: 0.08,
            },
          };
        }
      }

      return {
        ok: true,
        errorCode: null,
        errorMessage: null,
        answers,
        latencyMs: 15,
        servedModel: "SIMULATED_OFFLINE_JEV_MOCK",
        inputTokens: null, // Signals cost estimate
        outputTokens: null,
        attemptSpent: false,
      };
    },
  };
}

export type TypeSafeJevRunOptions = {
  live?: boolean;
  apiKey?: string;
  existingHarness?: PlaygroundHarness;
};

/**
 * Runs a scenario using Architecture C: TypeSafe JEV + Goal-Driven State.
 */
export async function runTypeSafeJevScenario(
  scenario: ScenarioDefinition,
  options: TypeSafeJevRunOptions = {},
): Promise<ScenarioTrace> {
  const isLive = Boolean(options.live);

  if (isLive) {
    const key = options.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!key || key.trim().length === 0) {
      const now = new Date().toISOString();
      return {
        scenarioId: scenario.id,
        title: scenario.title,
        category: scenario.category,
        architecture: "TYPESAFE_JEV_GOAL_DRIVEN",
        startedAt: now,
        completedAt: now,
        turns: [],
        verdict: "FAIL",
        failureReason:
          "REAL_JEV_BENCHMARK_BLOCKED: OPENROUTER_API_KEY is missing or empty",
        metrics: {
          totalTurns: 0,
          totalDurationMs: 0,
          totalLlmCalls: 0,
          totalTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          appointmentBooked: false,
          clarificationLoopDetected: false,
          unnecessaryHandoffDetected: false,
        },
      };
    }

    if (
      process.env.NODE_ENV === "production" &&
      parseApprovedMonthlyBudget(
        process.env.FLOWPILOT_JEV_APPROVED_MONTHLY_BUDGET,
      ) === null
    ) {
      const now = new Date().toISOString();
      return {
        scenarioId: scenario.id,
        title: scenario.title,
        category: scenario.category,
        architecture: "TYPESAFE_JEV_GOAL_DRIVEN",
        startedAt: now,
        completedAt: now,
        turns: [],
        verdict: "FAIL",
        failureReason:
          "REAL_JEV_BENCHMARK_BLOCKED: Production spending budget not approved",
        metrics: {
          totalTurns: 0,
          totalDurationMs: 0,
          totalLlmCalls: 0,
          totalTokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          appointmentBooked: false,
          clarificationLoopDetected: false,
          unnecessaryHandoffDetected: false,
        },
      };
    }

    const liveProvider = createJevDecisionsProvider({
      getEnvVar: (k) => (k === "OPENROUTER_API_KEY" ? key : process.env[k]),
      fetchImpl: globalThis.fetch,
    });

    return runGoalDrivenScenario(scenario, options.existingHarness, {
      jevProvider: liveProvider,
      architecture: "TYPESAFE_JEV_GOAL_DRIVEN",
    });
  }

  // Offline simulation mode
  const simulatedProvider = createOfflineSimulatedJevProvider();
  return runGoalDrivenScenario(scenario, options.existingHarness, {
    jevProvider: simulatedProvider,
    architecture: "TYPESAFE_JEV_GOAL_DRIVEN",
  });
}
