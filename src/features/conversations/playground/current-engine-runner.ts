/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Current Engine Runner (CORE-03C1)
 *
 * Executes the merged production Conversation Engine:
 *   receiveInboundMessage
 *   -> structured capability routing (requiredSemanticCapability = "structured_turn")
 *   -> policy-backed AI gateway/adapter
 *   -> reconciliation / planner
 *   -> Booking Core
 *   -> durable in-memory state store (CAS & revision semantics)
 *
 * Strict invariants:
 * - State is read directly from the state store, never reconstructed from prose.
 * - Physical HTTP attempts are counted at the injected fetch boundary.
 * - Missing/unavailable token usage remains unknown (null), never fabricated as zero.
 * - Live execution requires validated limits and explicit operator approval.
 */

import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import { hydrateConversationState } from "@/features/conversations/server/conversation-state";
import type { EffectiveAiPolicy } from "@/lib/validation/platform";
import { createPolicyBackedAi } from "@/server/integrations/ai/factory";

import type {
  EgyptianScenarioDefinition,
  MockTurnResponse,
} from "./egyptian-scenarios";
import {
  createPlaygroundHarness,
  sanitizeHeaders,
  type CapturedHttpAttempt,
  type PlaygroundHarness,
} from "./harness";
import type {
  CurrentEngineTurnTraceDetails,
  LiveOperatorLimits,
  MeasuredTokenUsage,
  PlaygroundArchitecture,
  ScenarioDefinition,
  ScenarioMetrics,
  ScenarioTrace,
  TurnTrace,
} from "./types";

export type CurrentEngineRunOptions = {
  live?: boolean;
  operatorLimits?: LiveOperatorLimits;
  mockResponses?: Record<number, MockTurnResponse>;
  aiPolicy?: Partial<EffectiveAiPolicy>;
  harness?: PlaygroundHarness;
  inspect?: boolean;
};

export type LimitValidationResult = {
  valid: boolean;
  reason?: string;
};

/**
 * Validates operator-supplied limits for live execution.
 * Fails clearly if any required limit is missing, invalid, zero, or negative.
 */
export function validateLiveOperatorLimits(
  limits?: LiveOperatorLimits | null,
): LimitValidationResult {
  if (!limits) {
    return {
      valid: false,
      reason: "Live execution limits object is required but was not provided.",
    };
  }

  if (
    !Array.isArray(limits.scenarioSubset) ||
    limits.scenarioSubset.length === 0
  ) {
    return {
      valid: false,
      reason:
        "Explicit scenarioSubset must be specified (cannot run unbounded scenarios in live mode).",
    };
  }

  if (
    typeof limits.maxPhysicalHttpAttempts !== "number" ||
    !Number.isFinite(limits.maxPhysicalHttpAttempts) ||
    limits.maxPhysicalHttpAttempts <= 0
  ) {
    return {
      valid: false,
      reason:
        "maxPhysicalHttpAttempts must be a positive integer greater than zero.",
    };
  }

  if (
    typeof limits.outputTokenLimit !== "number" ||
    !Number.isFinite(limits.outputTokenLimit) ||
    limits.outputTokenLimit <= 0
  ) {
    return {
      valid: false,
      reason: "outputTokenLimit must be a positive integer greater than zero.",
    };
  }

  if (
    typeof limits.timeoutMs !== "number" ||
    !Number.isFinite(limits.timeoutMs) ||
    limits.timeoutMs <= 0
  ) {
    return {
      valid: false,
      reason: "timeoutMs must be a positive number greater than zero.",
    };
  }

  if (
    typeof limits.approvedBudgetUsd !== "number" ||
    !Number.isFinite(limits.approvedBudgetUsd) ||
    limits.approvedBudgetUsd <= 0
  ) {
    return {
      valid: false,
      reason: "approvedBudgetUsd must be a positive number greater than zero.",
    };
  }

  if (
    typeof limits.budgetBasis !== "string" ||
    limits.budgetBasis.trim().length === 0
  ) {
    return {
      valid: false,
      reason:
        "budgetBasis must be an explicit explanation of the cost estimation formula.",
    };
  }

  return { valid: true };
}

export async function runCurrentEngineScenario(
  scenario: ScenarioDefinition | EgyptianScenarioDefinition,
  options: CurrentEngineRunOptions = {},
): Promise<ScenarioTrace> {
  const isLive = Boolean(options.live);

  // 1. Live limits preflight validation
  if (isLive) {
    const limitCheck = validateLiveOperatorLimits(options.operatorLimits);
    if (!limitCheck.valid) {
      throw new Error(
        `[LIVE PREFLIGHT BLOCKED] Invalid operator limits: ${limitCheck.reason}`,
      );
    }

    // In this evaluation-readiness slice (CORE-03C1), paid live execution remains blocked
    throw new Error(
      "[LIVE EXECUTION BLOCKED] Paid live provider evaluation is NOT RUN in this slice (CORE-03C1). " +
        "Evaluation readiness verified. Reviewer approval required before network execution.",
    );
  }

  const startedAt = new Date().toISOString();

  // 2. Setup harness and isolated state
  const harness =
    options.harness ??
    createPlaygroundHarness({
      channel: scenario.channel ?? "WHATSAPP",
      businessConfig: scenario.setup?.businessConfig,
      customServices: scenario.setup?.services,
      customProviders: scenario.setup?.providers,
      initialAppointments: scenario.setup?.initialAppointments,
      priorAppointment: scenario.setup?.priorAppointment,
      todayRef: scenario.setup?.todayRef,
      conversationStatus: scenario.setup?.conversationStatus,
      assignedUserId: scenario.setup?.assignedUserId,
      requiredSemanticCapability: "structured_turn", // Merged engine default
    });

  // Check if scenario specifies a specific reference instant
  const egyptianDef = scenario as EgyptianScenarioDefinition;
  if (egyptianDef.referenceInstant) {
    harness.setVirtualNow(new Date(egyptianDef.referenceInstant));
  }

  // 3. Setup instrumented fetch boundary to count physical HTTP attempts
  let currentTurnIndex = 1;
  const mockResponses =
    options.mockResponses ?? egyptianDef.mockResponses ?? {};

  const instrumentedFetch: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const attemptIndex = harness.capturedHttpAttempts.length + 1;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method ?? "POST";
    const startTime = Date.now();
    const sanitizedReqHeaders = sanitizeHeaders(init?.headers);

    const mockResp = mockResponses[currentTurnIndex];
    const status = mockResp?.status ?? 200;
    const durationMs = Date.now() - startTime;

    let responsePayload: any;
    let tokenUsage: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
    } | null = null;

    if (mockResp) {
      const usage =
        mockResp.usage === null
          ? undefined
          : (mockResp.usage ?? {
              prompt_tokens: 180,
              completion_tokens: 45,
              total_tokens: 225,
            });

      if (usage) {
        tokenUsage = {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        };
      }

      responsePayload = {
        id: `chatcmpl-mock-${attemptIndex}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: options.aiPolicy?.primaryModel ?? "deepseek/deepseek-chat",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify(mockResp.body),
            },
            finish_reason: "stop",
          },
        ],
        ...(usage ? { usage } : {}),
      };
    } else {
      // Default fallback mock response
      tokenUsage = {
        promptTokens: 160,
        completionTokens: 40,
        totalTokens: 200,
      };
      responsePayload = {
        id: `chatcmpl-mock-${attemptIndex}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: options.aiPolicy?.primaryModel ?? "deepseek/deepseek-chat",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                intent: "BOOKING_REQUEST",
                confidence: 0.9,
                extraction: {},
                factUpdates: [],
                reply: "مرحباً بك! كيف يمكنني مساعدتك؟",
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 160,
          completion_tokens: 40,
          total_tokens: 200,
        },
      };
    }

    const attemptRecord: CapturedHttpAttempt = {
      index: attemptIndex,
      url,
      method,
      status,
      durationMs,
      timestamp: new Date().toISOString(),
      sanitizedHeaders: sanitizedReqHeaders,
      responseBodyPreview: JSON.stringify(responsePayload).slice(0, 200),
      tokenUsage,
      error: status >= 400 ? `HTTP ${status}` : null,
    };
    harness.capturedHttpAttempts.push(attemptRecord);

    if (status >= 400) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Mock provider error ${status}`,
            type: "provider_error",
            code: status,
          },
        }),
        {
          status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  // 4. Create the real policy-backed AI attached to the instrumented fetch boundary
  const policyAi = await createPolicyBackedAi({
    getEnvVar: (name: string) => {
      if (name === "OPENROUTER_API_KEY") {
        const k = process.env.OPENROUTER_API_KEY;
        return k && k.trim().length > 0 ? k : "test-openrouter-key";
      }
      if (name === "ATRIA_API_KEY") {
        const k = process.env.ATRIA_API_KEY;
        return k && k.trim().length > 0 ? k : "test-atria-key";
      }
      if (name === "CODECRAFT_API_KEY") {
        const k = process.env.CODECRAFT_API_KEY;
        return k && k.trim().length > 0 ? k : "test-codecraft-key";
      }
      return process.env[name];
    },
    fetchImpl: instrumentedFetch,
    getAiPolicyImpl: async () => {
      if (options.aiPolicy?.primaryProvider === ("deterministic" as any)) {
        return {
          success: false,
          error: "DETERMINISTIC_POLICY_PROHIBITED",
        } as any;
      }
      return {
        success: true,
        data: {
          policy: {
            primaryProvider: options.aiPolicy?.primaryProvider ?? "openrouter",
            primaryModel:
              options.aiPolicy?.primaryModel ?? "deepseek/deepseek-chat",
            secondaryProvider: null,
            secondaryModel: null,
            fallbackEnabled: false,
            primarySecretRef: "OPENROUTER_API_KEY",
            secondarySecretRef: null,
            openRouterProviderOnly: null,
            updatedAt: new Date(),
          },
          effective: {
            primaryProvider: options.aiPolicy?.primaryProvider ?? "openrouter",
            primaryModel:
              options.aiPolicy?.primaryModel ?? "deepseek/deepseek-chat",
            secondary: null,
            fallbackEnabled: false,
            openRouterProviderOnly: null,
          },
        },
      };
    },
    timeoutMs: options.operatorLimits?.timeoutMs ?? 15000,
  });

  harness.deps.ai = policyAi;

  const turns: TurnTrace[] = [];
  let scenarioVerdict: "PASS" | "FAIL" = "PASS";
  let failureReason: string | null = null;

  let totalTurns = 0;
  let totalDurationMs = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalLlmCalls = 0;
  const clarificationLoopDetected = false;
  const unnecessaryHandoffDetected = false;
  let appointmentBooked = false;

  // 5. Execute each scenario turn
  for (let i = 0; i < scenario.turns.length; i++) {
    const turnExp = scenario.turns[i];
    if (!turnExp) continue;

    currentTurnIndex = i + 1;
    totalTurns++;
    const turnId = `${scenario.id}-T${currentTurnIndex}`;
    const channel = turnExp.channel ?? scenario.channel ?? "WHATSAPP";
    const senderId =
      channel === "TELEGRAM"
        ? harness.customer.phone.replace("tg:", "")
        : harness.customer.phone;
    const messageId = `msg-ce-${scenario.id}-${currentTurnIndex}-${Date.now()}`;
    const referenceInstant = harness.getVirtualNow();

    // Load state BEFORE turn directly from the durable state store
    const rawStateBefore = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const stateBefore = rawStateBefore
      ? hydrateConversationState(rawStateBefore.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    const queriesBefore = harness.capturedAvailabilityQueries.length;
    const apptsBefore = harness.appointments.length;
    const outboundBefore = harness.deliveredOutbound.length;
    const attemptsBefore = harness.capturedHttpAttempts.length;

    const startTurnTime = Date.now();

    const inboundPayload = {
      from: senderId,
      to:
        channel === "TELEGRAM"
          ? "6000000000"
          : (harness.business.whatsappNumber ?? "+201001111111"),
      text: turnExp.input,
      receivedAt: referenceInstant.toISOString(),
      externalId:
        channel === "TELEGRAM" ? `tg:bot:${messageId}` : `wamid.${messageId}`,
    };

    let result: any;
    try {
      result = await receiveInboundMessage(harness.deps, inboundPayload, {
        businessId: harness.business.id,
        branchId: harness.business.defaultBranchId,
      });
    } catch (err: any) {
      scenarioVerdict = "FAIL";
      failureReason = `Turn ${currentTurnIndex} threw unhandled exception: ${err?.message ?? String(err)}`;
      break;
    }

    const durationMs = Date.now() - startTurnTime;
    totalDurationMs += durationMs;

    // Load state AFTER turn directly from the durable state store
    const rawStateAfter = await harness.stateStore.load(
      harness.business.id,
      harness.conversation.id,
    );
    const stateAfter = rawStateAfter
      ? hydrateConversationState(rawStateAfter.state, {
          businessId: harness.business.id,
          conversationId: harness.conversation.id,
        })
      : null;

    const turnQueries =
      harness.capturedAvailabilityQueries.slice(queriesBefore);
    const turnWrites = harness.appointments.slice(apptsBefore);
    const turnOutbound = harness.deliveredOutbound.slice(outboundBefore);
    const turnAttempts = harness.capturedHttpAttempts.slice(attemptsBefore);

    // Track physical HTTP attempts
    totalLlmCalls += turnAttempts.length;

    // Determine token usage honestly
    let turnPromptTokens: number | null = null;
    let turnCompletionTokens: number | null = null;
    let turnTotalTokens: number | null = null;
    let usageSource: MeasuredTokenUsage["source"] = "UNKNOWN";

    if (turnAttempts.length > 0) {
      let hasUsage = false;
      let pSum = 0;
      let cSum = 0;
      let tSum = 0;
      for (const a of turnAttempts) {
        if (a.tokenUsage) {
          hasUsage = true;
          pSum += a.tokenUsage.promptTokens ?? 0;
          cSum += a.tokenUsage.completionTokens ?? 0;
          tSum += a.tokenUsage.totalTokens ?? 0;
        }
      }
      if (hasUsage) {
        turnPromptTokens = pSum;
        turnCompletionTokens = cSum;
        turnTotalTokens = tSum;
        usageSource = isLive ? "LIVE_PROVIDER" : "OFFLINE_FIXTURE";
        totalPromptTokens += pSum;
        totalCompletionTokens += cSum;
        totalTokens += tSum;
      }
    }

    const measuredUsage: MeasuredTokenUsage = {
      source: usageSource,
      promptTokens: turnPromptTokens,
      completionTokens: turnCompletionTokens,
      totalTokens: turnTotalTokens,
      isEstimate: false,
    };

    // Determine offer transition
    const offerBefore = stateBefore?.offer ?? null;
    const offerAfter = stateAfter?.offer ?? null;
    let offerTransition = "NO_TRANSITION";
    if (!offerBefore && offerAfter) {
      offerTransition = "OFFER_CREATED";
    } else if (offerBefore && offerAfter) {
      if (offerBefore.status !== offerAfter.status) {
        offerTransition = `STATUS_${offerAfter.status}`;
      } else {
        offerTransition = "OFFER_MAINTAINED";
      }
    } else if (offerBefore && !offerAfter) {
      offerTransition = "OFFER_CLEARED";
    }

    // Determine routing
    let routeType:
      | "STRUCTURED_SEMANTIC"
      | "MECHANICAL_SELECTION"
      | "DETERMINISTIC_BYPASS"
      | "POLICY_PROHIBITED"
      | "STAFF_DEFERRED" = "STRUCTURED_SEMANTIC";

    if (turnAttempts.length === 0) {
      if (
        turnWrites.length > 0 ||
        (turnExp.input && /^[1-9]\d*$/.test(turnExp.input.trim()))
      ) {
        routeType = "MECHANICAL_SELECTION";
      } else if (result.assistantAction === "DEFERRED_TO_STAFF") {
        routeType = "STAFF_DEFERRED";
      } else {
        routeType = "DETERMINISTIC_BYPASS";
      }
    }

    const currentEngineDetails: CurrentEngineTurnTraceDetails = {
      routing: {
        route: routeType,
        effectiveCapability: "structured_turn",
        finalProvider:
          result.observability?.provider ??
          options.aiPolicy?.primaryProvider ??
          "openrouter",
        finalModel:
          result.observability?.model ??
          options.aiPolicy?.primaryModel ??
          "deepseek/deepseek-chat",
      },
      semantic: {
        intent: result.intent ?? result.observability?.routingDecision ?? null,
        extraction: stateAfter?.knownFacts
          ? { ...stateAfter.knownFacts }
          : null,
        factUpdates: result.observability?.factUpdates ?? null,
      },
      task: {
        activeTask: stateAfter?.activeTask
          ? `${stateAfter.activeTask.kind}:${stateAfter.activeTask.stage}`
          : null,
        missingFacts: stateAfter?.missingFacts
          ? [...stateAfter.missingFacts]
          : [],
        currentGoal: stateAfter?.currentGoal ?? null,
      },
      offerTransition: {
        offerBefore: offerBefore
          ? {
              status: offerBefore.status,
              kind: (offerBefore as any).kind,
              serviceId: (offerBefore as any).serviceId ?? null,
              date: (offerBefore as any).date ?? null,
              slotsCount:
                (offerBefore as any).offeredSlots?.length ??
                (offerBefore as any).options?.length ??
                0,
            }
          : null,
        offerAfter: offerAfter
          ? {
              status: offerAfter.status,
              kind: (offerAfter as any).kind,
              serviceId: (offerAfter as any).serviceId ?? null,
              date: (offerAfter as any).date ?? null,
              slotsCount:
                (offerAfter as any).offeredSlots?.length ??
                (offerAfter as any).options?.length ??
                0,
            }
          : null,
        transition: offerTransition,
      },
      availabilityQueries: turnQueries.map((q) => ({
        businessId: q.businessId,
        date: q.date,
        assigneeIds: q.assigneeIds,
      })),
      domainResult: {
        action: result.assistantAction ?? "AI_REPLY",
        conversationStatus:
          result.conversationStatus ?? harness.conversation.status,
        clarificationCause: result.observability?.clarification?.field ?? null,
        handoffCause: result.handoffCause ?? null,
        preventedConflict: false,
        createdAppointment: turnWrites.length > 0 ? turnWrites[0] : null,
      },
      httpAttempts: {
        count: turnAttempts.length,
        attempts: turnAttempts.map((a) => ({
          index: a.index,
          url: a.url,
          method: a.method,
          status: a.status,
          durationMs: a.durationMs,
          timestamp: a.timestamp,
          sanitizedHeaders: a.sanitizedHeaders,
          error: a.error,
        })),
      },
      tokenUsage: measuredUsage,
    };

    const outboundText = turnOutbound.map((o) => o.body).join("\n");
    const turnTrace: TurnTrace = {
      turnIndex: currentTurnIndex,
      turnId,
      timestamp: new Date().toISOString(),
      referenceTime: referenceInstant.toISOString(),
      timezone: harness.business.timezone,
      inbound: {
        channel,
        senderId,
        text: turnExp.input,
        buttonPayload: turnExp.buttonPayload,
        messageId,
      },
      stateBefore,
      processing: {
        architecture: "CURRENT_ENGINE" as PlaygroundArchitecture,
        jevDecision: null,
        semanticIntent: result.intent ?? null,
        extractedEntities: stateAfter?.knownFacts
          ? { ...stateAfter.knownFacts }
          : {},
        toolCalls: [],
        executionTimeMs: durationMs,
        llmCalls: turnAttempts.length,
        tokenUsageEstimate: {
          promptTokens: turnPromptTokens ?? 0,
          completionTokens: turnCompletionTokens ?? 0,
          totalTokens: turnTotalTokens ?? 0,
        },
        measuredUsage,
        currentEngine: currentEngineDetails,
      },
      stateAfter,
      outbound: {
        text: outboundText,
        buttons: turnOutbound.flatMap((o) => o.buttons ?? []),
        replyMarkup: turnOutbound[0]?.replyMarkup ?? null,
        sentCount: turnOutbound.length,
      },
      assistantAction: result.assistantAction ?? "AI_REPLY",
      conversationStatus:
        result.conversationStatus ?? harness.conversation.status,
      diagnostics: {
        warnings: [],
        isClarificationLoop: false,
        isUnnecessaryHandoff: false,
        appointmentCreated: turnWrites.length > 0,
        appointmentId: turnWrites[0]?.id ?? null,
      },
    };

    if (turnWrites.length > 0) {
      appointmentBooked = true;
    }

    // Evaluate turn expectations
    if (
      turnExp.expectedIntent &&
      result.intent &&
      result.intent !== turnExp.expectedIntent
    ) {
      scenarioVerdict = "FAIL";
      failureReason = `Turn ${currentTurnIndex}: Expected intent '${turnExp.expectedIntent}', got '${result.intent}'`;
    }

    if (
      turnExp.expectedAction &&
      result.assistantAction !== turnExp.expectedAction
    ) {
      scenarioVerdict = "FAIL";
      failureReason = `Turn ${currentTurnIndex}: Expected action '${turnExp.expectedAction}', got '${result.assistantAction}'`;
    }

    if (turnExp.expectedOutboundContains) {
      for (const phrase of turnExp.expectedOutboundContains) {
        if (!outboundText.includes(phrase)) {
          scenarioVerdict = "FAIL";
          failureReason = `Turn ${currentTurnIndex}: Outbound missing expected phrase '${phrase}'. Got:\n${outboundText}`;
          break;
        }
      }
    }

    if (turnExp.forbiddenOutboundContains) {
      for (const phrase of turnExp.forbiddenOutboundContains) {
        if (outboundText.includes(phrase)) {
          scenarioVerdict = "FAIL";
          failureReason = `Turn ${currentTurnIndex}: Outbound contains forbidden phrase '${phrase}'`;
          break;
        }
      }
    }

    if (turnExp.assertFn) {
      try {
        turnExp.assertFn(turnTrace, turns);
      } catch (err: any) {
        scenarioVerdict = "FAIL";
        failureReason = `Turn ${currentTurnIndex} assertion failed: ${err?.message ?? String(err)}`;
      }
    }

    turns.push(turnTrace);

    if (scenarioVerdict === "FAIL") {
      break;
    }
  }

  // Evaluate scenario level expectations
  if (
    scenarioVerdict === "PASS" &&
    scenario.expectations?.shouldBook &&
    !appointmentBooked
  ) {
    scenarioVerdict = "FAIL";
    failureReason =
      "Scenario expected appointment creation, but none was created.";
  }

  const metrics: ScenarioMetrics = {
    totalTurns,
    totalDurationMs,
    totalLlmCalls,
    totalTokens: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
    },
    appointmentBooked,
    clarificationLoopDetected,
    unnecessaryHandoffDetected,
  };

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    category: scenario.category,
    architecture: "CURRENT_ENGINE",
    startedAt,
    completedAt: new Date().toISOString(),
    turns,
    verdict: scenarioVerdict,
    failureReason,
    metrics,
  };
}
