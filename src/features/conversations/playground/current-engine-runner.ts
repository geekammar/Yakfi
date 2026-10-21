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
 * - Live provider transport and offline fixture transport are strictly decoupled.
 * - Model extraction and factUpdates are captured separately from durable saved state.
 * - Offer replacement is detected by offer identity (id !== id) as well as status.
 */

import type {
  AiRequest,
  AiResponse,
  ConversationAi,
} from "@/features/conversations/server/conversation-ai";
import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import { hydrateConversationState } from "@/features/conversations/server/conversation-state";
import type { EffectiveAiPolicy } from "@/lib/validation/platform";
import { createPolicyBackedAi } from "@/server/integrations/ai/factory";

import { CurrentEngineExecutionSession } from "./current-engine-session";
import type {
  EgyptianScenarioDefinition,
  MockTurnResponse,
} from "./egyptian-scenarios";
import { createPlaygroundHarness, type PlaygroundHarness } from "./harness";
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
  session?: CurrentEngineExecutionSession;
  upstreamFetch?: typeof fetch;
};

export type LimitValidationResult = {
  valid: boolean;
  reason?: string;
};

/**
 * Validates operator-supplied limits for live execution.
 * Fails clearly if any required limit is missing, invalid, zero, or negative.
 * Uses strict Number.isInteger checks for attempts, tokens, and timeout.
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
    !Number.isInteger(limits.maxPhysicalHttpAttempts) ||
    limits.maxPhysicalHttpAttempts <= 0
  ) {
    return {
      valid: false,
      reason:
        "maxPhysicalHttpAttempts must be a strict positive integer greater than zero.",
    };
  }

  if (
    typeof limits.outputTokenLimit !== "number" ||
    !Number.isInteger(limits.outputTokenLimit) ||
    limits.outputTokenLimit <= 0
  ) {
    return {
      valid: false,
      reason:
        "outputTokenLimit must be a strict positive integer greater than zero.",
    };
  }

  if (
    typeof limits.timeoutMs !== "number" ||
    !Number.isInteger(limits.timeoutMs) ||
    limits.timeoutMs <= 0
  ) {
    return {
      valid: false,
      reason: "timeoutMs must be a strict positive integer greater than zero.",
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
    // unless an explicit upstreamFetch was injected for integration testing.
    if (!options.upstreamFetch) {
      throw new Error(
        "[LIVE EXECUTION BLOCKED] Paid live provider evaluation is NOT RUN in this slice (CORE-03C1). " +
          "Evaluation readiness verified. Reviewer approval required before network execution.",
      );
    }
  }

  const startedAt = new Date().toISOString();

  // 2. Setup or reuse execution session
  const configuredProvider = options.aiPolicy?.primaryProvider ?? "openrouter";
  const configuredModel =
    options.aiPolicy?.primaryModel ?? "deepseek/deepseek-chat";

  const session =
    options.session ??
    new CurrentEngineExecutionSession({
      live: isLive,
      operatorLimits: options.operatorLimits,
      liveFetchImpl: options.upstreamFetch,
      primaryProvider: configuredProvider,
      primaryModel: configuredModel,
      allowLivePaidCalls: Boolean(options.upstreamFetch),
    });

  // 3. Setup harness and isolated state
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

  // 4. Setup instrumented fetch boundary tied to execution session
  let currentTurnIndex = 1;
  const mockResponses =
    options.mockResponses ?? egyptianDef.mockResponses ?? {};

  const instrumentedFetch = session.createInstrumentedFetch({
    mockResponses,
    getTurnIndex: () => currentTurnIndex,
  });

  // 5. Create policy-backed AI and capture model outputs at the boundary
  const outputTokenLimit =
    session.outputTokenLimit ?? options.operatorLimits?.outputTokenLimit ?? 500;
  const timeoutMs =
    session.timeoutMs ?? options.operatorLimits?.timeoutMs ?? 15000;

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
    maxTokens: outputTokenLimit,
    timeoutMs,
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
            primaryProvider: configuredProvider,
            primaryModel: configuredModel,
            secondaryProvider: null,
            secondaryModel: null,
            fallbackEnabled: false,
            primarySecretRef: "OPENROUTER_API_KEY",
            secondarySecretRef: null,
            openRouterProviderOnly: null,
            updatedAt: new Date(),
          },
          effective: {
            primaryProvider: configuredProvider,
            primaryModel: configuredModel,
            secondary: null,
            fallbackEnabled: false,
            openRouterProviderOnly: null,
          },
        },
      };
    },
  });

  // Instrumentation seam to capture actual parsed AiResponse without changing production engine,
  // while preserving and forwarding the assistant's getLastTelemetry() interface
  const turnAiCapture = { response: null as AiResponse | null };
  const getCapturedAi = (): AiResponse | null => turnAiCapture.response;
  const instrumentedAi: ConversationAi & { getLastTelemetry(): any } = {
    providerName: policyAi.providerName,
    async respond(request: AiRequest): Promise<AiResponse> {
      const response = await policyAi.respond(request);
      turnAiCapture.response = response;
      return response;
    },
    getLastTelemetry() {
      return (policyAi as any).getLastTelemetry?.() ?? null;
    },
  };

  harness.deps.ai = instrumentedAi;

  const turns: TurnTrace[] = [];
  let scenarioVerdict: "PASS" | "FAIL" = "PASS";
  let failureReason: string | null = null;

  let totalTurns = 0;
  let totalDurationMs = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalLlmCalls = 0;
  let totalKnownTokens = 0;
  let hasAnyKnownTokens = false;
  let hasAnyUnknownTokens = false;
  let appointmentBooked = false;

  // 6. Execute each scenario turn
  for (let i = 0; i < scenario.turns.length; i++) {
    const turnExp = scenario.turns[i];
    if (!turnExp) continue;

    currentTurnIndex = i + 1;
    totalTurns++;
    turnAiCapture.response = null;

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
    const sessionAttemptsBefore = session.attemptCount;

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
    const turnAttempts = session.capturedAttempts.slice(sessionAttemptsBefore);

    // Keep harness capturedHttpAttempts synchronized
    harness.capturedHttpAttempts.push(...turnAttempts);

    // Track physical HTTP attempts
    totalLlmCalls += turnAttempts.length;

    // Determine token usage honestly per attempt
    let turnKnownAttempts = 0;
    let turnUnknownAttempts = 0;
    let pSum = 0;
    let cSum = 0;
    let tSum = 0;

    for (const a of turnAttempts) {
      if (
        a.tokenUsage &&
        typeof a.tokenUsage.totalTokens === "number" &&
        !Number.isNaN(a.tokenUsage.totalTokens)
      ) {
        turnKnownAttempts++;
        pSum += a.tokenUsage.promptTokens ?? 0;
        cSum += a.tokenUsage.completionTokens ?? 0;
        tSum += a.tokenUsage.totalTokens;
      } else {
        turnUnknownAttempts++;
      }
    }

    let turnPromptTokens: number | null = null;
    let turnCompletionTokens: number | null = null;
    let turnTotalTokens: number | null = null;
    let usageSource: MeasuredTokenUsage["source"] = "UNKNOWN";
    let turnCompleteness: MeasuredTokenUsage["completeness"] = "NOT_APPLICABLE";

    if (turnAttempts.length === 0) {
      usageSource = "NOT_APPLICABLE";
      turnCompleteness = "NOT_APPLICABLE";
      turnPromptTokens = null;
      turnCompletionTokens = null;
      turnTotalTokens = null;
    } else if (turnUnknownAttempts === 0) {
      // All attempts have known usage
      usageSource = isLive ? "LIVE_PROVIDER" : "OFFLINE_FIXTURE";
      turnCompleteness = "COMPLETE";
      turnPromptTokens = pSum;
      turnCompletionTokens = cSum;
      turnTotalTokens = tSum;
      totalPromptTokens += pSum;
      totalCompletionTokens += cSum;
      totalTokens += tSum;
      totalKnownTokens += tSum;
      hasAnyKnownTokens = true;
    } else if (turnKnownAttempts > 0 && turnUnknownAttempts > 0) {
      // Turn with a failed attempt (no usage) and retry (usage) -> PARTIAL
      usageSource = isLive ? "LIVE_PROVIDER" : "OFFLINE_FIXTURE";
      turnCompleteness = "PARTIAL";
      turnPromptTokens = null;
      turnCompletionTokens = null;
      turnTotalTokens = null;
      totalPromptTokens += pSum;
      totalCompletionTokens += cSum;
      totalKnownTokens += tSum;
      hasAnyKnownTokens = true;
      hasAnyUnknownTokens = true;
    } else {
      // No attempt had token usage
      usageSource = "UNKNOWN";
      turnCompleteness = "UNKNOWN";
      turnPromptTokens = null;
      turnCompletionTokens = null;
      turnTotalTokens = null;
      hasAnyUnknownTokens = true;
    }

    const measuredUsage: MeasuredTokenUsage = {
      source: usageSource,
      promptTokens: turnPromptTokens,
      completionTokens: turnCompletionTokens,
      totalTokens: turnTotalTokens,
      isEstimate: false,
      completeness: turnCompleteness,
      knownAttemptsCount: turnKnownAttempts,
      unknownAttemptsCount: turnUnknownAttempts,
    };

    // Determine offer transition with strict identity check (id !== id -> OFFER_REPLACED)
    const offerBefore = stateBefore?.offer ?? null;
    const offerAfter = stateAfter?.offer ?? null;
    let offerTransition = "NO_TRANSITION";
    if (!offerBefore && offerAfter) {
      offerTransition = "OFFER_CREATED";
    } else if (offerBefore && offerAfter) {
      if (offerBefore.id !== offerAfter.id) {
        offerTransition = "OFFER_REPLACED";
      } else if (offerBefore.status !== offerAfter.status) {
        offerTransition = `STATUS_${offerAfter.status}`;
      } else {
        offerTransition = "OFFER_MAINTAINED";
      }
    } else if (offerBefore && !offerAfter) {
      offerTransition = "OFFER_CLEARED";
    }

    const isPolicyProhibited =
      options.aiPolicy?.primaryProvider === ("deterministic" as any);
    const telemetry = (instrumentedAi as any).getLastTelemetry?.();
    const capturedAi = getCapturedAi();

    // Determine routing strictly from actual engine/gateway evidence (NO digits regex)
    let routeType: CurrentEngineTurnTraceDetails["routing"]["route"] =
      "UNKNOWN";

    if (isPolicyProhibited) {
      routeType = "POLICY_PROHIBITED";
    } else if (result.assistantAction === "DEFERRED_TO_STAFF") {
      routeType = "STAFF_DEFERRED";
    } else if (
      turnAttempts.length > 0 ||
      result.observability?.routingDecision === "LLM"
    ) {
      routeType = "STRUCTURED_SEMANTIC";
    } else if (
      result.observability?.routingDecision === "DETERMINISTIC_BYPASS"
    ) {
      routeType = "DETERMINISTIC_BYPASS";
    } else if (
      turnWrites.length > 0 ||
      (offerBefore &&
        (offerAfter?.status === "CONSUMED" ||
          offerAfter?.status === "CLAIMED" ||
          offerTransition === "OFFER_CLEARED" ||
          result.intent === "BOOKING"))
    ) {
      routeType = "MECHANICAL_SELECTION";
    } else {
      routeType = "UNKNOWN";
    }

    // Determine observed provider and model from actual telemetry / engine observability ONLY
    let observedProvider: string | null = null;
    let observedModel: string | null = null;
    let finalProvider: string | null = null;
    let finalModel: string | null = null;

    if (
      !isPolicyProhibited &&
      (turnAttempts.length > 0 ||
        (telemetry &&
          telemetry.finalProvider !== "deterministic" &&
          telemetry.finalProvider !== "deterministic-bypass"))
    ) {
      observedProvider =
        telemetry?.finalProvider ?? result.observability?.provider ?? null;
      observedModel =
        telemetry?.finalModel ?? result.observability?.model ?? null;
      finalProvider = observedProvider;
      finalModel = observedModel;
    } else if (
      result.observability?.routingDecision === "DETERMINISTIC_BYPASS"
    ) {
      finalProvider = "deterministic-bypass";
      finalModel = null;
    }

    // Capture model outputs separately from durable state
    const capturedModelExtraction =
      capturedAi && !isPolicyProhibited && capturedAi.extraction
        ? { ...capturedAi.extraction }
        : null;
    const capturedModelFactUpdates =
      capturedAi && !isPolicyProhibited && capturedAi.factUpdates
        ? (capturedAi.factUpdates as any[])
        : null;
    const reconciledFacts = stateAfter?.knownFacts
      ? { ...stateAfter.knownFacts }
      : null;

    const currentEngineDetails: CurrentEngineTurnTraceDetails = {
      routing: {
        route: routeType,
        effectiveCapability: "structured_turn",
        configuredProvider,
        configuredModel,
        observedProvider,
        observedModel,
        finalProvider,
        finalModel,
      },
      semantic: {
        intent: result.intent ?? result.observability?.routingDecision ?? null,
        modelExtraction: capturedModelExtraction,
        modelFactUpdates: capturedModelFactUpdates,
        reconciledKnownFacts: reconciledFacts,
        extraction: capturedModelExtraction ?? reconciledFacts,
        factUpdates:
          capturedModelFactUpdates ?? result.observability?.factUpdates ?? null,
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
        extractedEntities: capturedModelExtraction ?? reconciledFacts ?? {},
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
    if (turnExp.expectedIntent && result.intent !== turnExp.expectedIntent) {
      scenarioVerdict = "FAIL";
      failureReason = `Turn ${currentTurnIndex}: Expected intent '${turnExp.expectedIntent}', got '${result.intent ?? "null"}'`;
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

  // Calculate token completeness
  let tokenCompleteness: ScenarioMetrics["tokenCompleteness"] =
    "NOT_APPLICABLE";
  let finalTotalTokens: ScenarioMetrics["totalTokens"] = null;

  if (totalLlmCalls === 0) {
    tokenCompleteness = "NOT_APPLICABLE";
    finalTotalTokens = {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  } else if (!hasAnyKnownTokens && hasAnyUnknownTokens) {
    tokenCompleteness = "UNKNOWN";
    finalTotalTokens = null;
  } else if (hasAnyKnownTokens && hasAnyUnknownTokens) {
    tokenCompleteness = "PARTIAL";
    finalTotalTokens = null;
  } else {
    tokenCompleteness = "COMPLETE";
    finalTotalTokens = {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
    };
  }

  const metrics: ScenarioMetrics = {
    totalTurns,
    totalDurationMs,
    totalLlmCalls,
    totalTokens: finalTotalTokens,
    tokenCompleteness,
    knownTokensSubtotal: hasAnyKnownTokens
      ? {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalKnownTokens,
        }
      : null,
    appointmentBooked,
    clarificationLoopDetected: false,
    unnecessaryHandoffDetected: false,
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
