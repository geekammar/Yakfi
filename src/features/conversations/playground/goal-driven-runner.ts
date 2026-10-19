/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Goal-Driven Hybrid Instrumented Runner
 *
 * Runs scenarios through the Goal-Driven Hybrid Prototype engine (goal-driven-engine.ts).
 * Collects full turn traces, state transitions, option resolution metrics, and diagnostics.
 */

import { deriveConversationStateFromHistory } from "@/features/conversations/server/conversation-state";
import type { JevDecisionsProvider } from "@/server/integrations/ai/jev-decisions-provider";

import { processGoalDrivenTurn } from "./goal-driven-engine";
import { createPlaygroundHarness, type PlaygroundHarness } from "./harness";
import type {
  PlaygroundArchitecture,
  ScenarioDefinition,
  ScenarioMetrics,
  ScenarioTrace,
  TurnTrace,
} from "./types";

export type GoalDrivenRunOptions = {
  jevProvider?: JevDecisionsProvider | null;
  architecture?: PlaygroundArchitecture;
};

export async function runGoalDrivenScenario(
  scenario: ScenarioDefinition,
  existingHarness?: PlaygroundHarness,
  options?: GoalDrivenRunOptions,
): Promise<ScenarioTrace> {
  const startedAt = new Date().toISOString();
  const harness =
    existingHarness ??
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
    });

  const turns: TurnTrace[] = [];
  let scenarioVerdict: "PASS" | "FAIL" = "PASS";
  let failureReason: string | null = null;

  let totalLlmCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let clarificationLoopDetected = false;
  let unnecessaryHandoffDetected = false;

  for (let i = 0; i < scenario.turns.length; i++) {
    const turnExp = scenario.turns[i];
    if (!turnExp) continue;
    const turnIndex = i + 1;
    const channel = turnExp.channel ?? scenario.channel ?? "WHATSAPP";
    const senderId =
      channel === "TELEGRAM"
        ? harness.customer.phone.replace("tg:", "")
        : harness.customer.phone;
    const messageId = `msg-in-${scenario.id}-${turnIndex}-${Date.now()}`;

    // 1. Capture state before
    const stateBefore = deriveConversationStateFromHistory(
      harness.messages.map((m) => ({
        senderType: m.senderType,
        content: m.content,
      })),
    );

    const prevApptsLen = harness.appointments.length;
    const startTurnTime = Date.now();

    // 2. Add customer message to conversation history
    const wasBooked = harness.conversation.status === "BOOKED";
    const nextStatus =
      wasBooked && !harness.conversation.assignedUserId
        ? "AI_ACTIVE"
        : harness.conversation.status;

    await harness.deps.conversationRepository.addMessage(
      {
        conversationId: harness.conversation.id,
        senderType: "CUSTOMER",
        content: turnExp.input,
      },
      { status: nextStatus },
    );

    // 3. Process turn via Goal-Driven Engine Prototype
    let result: any;
    if (harness.conversation.status !== "AI_ACTIVE") {
      harness.conversation.status = "NEED_HUMAN";
      result = {
        assistantAction: "DEFERRED_TO_STAFF",
        conversationStatus: "NEED_HUMAN",
        intent: null,
        handoffCause: null,
        replyText: "",
        buttons: [],
        llmCalls: 0,
      };
    } else {
      const services = await harness.deps.serviceRepository.listByBusiness(
        harness.business.id,
      );

      try {
        result = await processGoalDrivenTurn(
          harness.deps,
          {
            text: turnExp.input,
            buttonPayload: turnExp.buttonPayload,
            from: harness.customer.phone,
          },
          {
            business: harness.business,
            customer: harness.customer,
            conversationId: harness.conversation.id,
            services,
            virtualNow: harness.getVirtualNow(),
            jevProvider: options?.jevProvider,
            architecture: options?.architecture,
          },
        );
      } catch (err: any) {
        scenarioVerdict = "FAIL";
        failureReason = `Turn ${turnIndex} threw unhandled exception: ${err?.message ?? String(err)}`;
        break;
      }
    }

    const durationMs = Date.now() - startTurnTime;

    // 4. Record outbound response
    const outboundText = result.replyText;
    const outboundButtons = result.buttons ?? [];
    const replyMarkup = result.replyMarkup;

    await harness.deps.conversationRepository.addMessage(
      {
        conversationId: harness.conversation.id,
        senderType: "AI",
        content: outboundText,
      },
      { status: result.conversationStatus },
    );

    await (harness.deps.transport as any).send({
      to: harness.customer.phone,
      content: outboundText,
      buttons: outboundButtons,
      replyMarkup,
    });

    // 5. Capture state after
    const stateAfter = deriveConversationStateFromHistory(
      harness.messages.map((m) => ({
        senderType: m.senderType,
        content: m.content,
      })),
    );

    // 6. Diagnostics
    const newAppts = harness.appointments.slice(prevApptsLen);
    const appointmentCreated = result.appointmentCreated ?? newAppts.length > 0;
    const appointmentId = result.appointmentId ?? newAppts[0]?.id ?? null;

    const turnLlmCalls = result.llmCalls ?? 0;
    const turnPromptTokens = turnLlmCalls > 0 ? 180 : 0;
    const turnCompletionTokens = turnLlmCalls > 0 ? 60 : 0;
    const turnTotalTokens = turnPromptTokens + turnCompletionTokens;

    totalLlmCalls += turnLlmCalls;
    totalPromptTokens += turnPromptTokens;
    totalCompletionTokens += turnCompletionTokens;
    totalTokens += turnTotalTokens;

    // Clarification loop check
    const prevTurn = turns[turns.length - 1];
    const isClarificationLoop = Boolean(
      prevTurn &&
      prevTurn.outbound.text.length > 0 &&
      prevTurn.outbound.text === outboundText &&
      !appointmentCreated,
    );

    if (isClarificationLoop) {
      clarificationLoopDetected = true;
    }

    // Unnecessary handoff check
    const isUnnecessaryHandoff =
      result.assistantAction === "AI_HANDOFF" &&
      turnExp.expectedAction === "AI_REPLY";

    if (isUnnecessaryHandoff) {
      unnecessaryHandoffDetected = true;
    }

    const isContextLoss = Boolean(
      stateBefore?.selectedService &&
      !stateAfter?.selectedService &&
      !turnExp.input.includes("خدمة") &&
      !turnExp.input.includes("اغير"),
    );
    const isDuplicateBookingAttempt = Boolean(
      wasBooked &&
      !appointmentCreated &&
      (turnExp.input.trim() === "1" || /^[1-9]$/.test(turnExp.input.trim())),
    );

    const warnings: string[] = [];
    if (isClarificationLoop) {
      warnings.push("CLARIFICATION_LOOP_DETECTED");
    }
    if (isUnnecessaryHandoff) {
      warnings.push("UNNECESSARY_HANDOFF_DETECTED");
    }
    if (isContextLoss) {
      warnings.push("CONTEXT_LOSS_DETECTED");
    }
    if (isDuplicateBookingAttempt) {
      warnings.push("DUPLICATE_BOOKING_PREVENTED");
    }

    const turnTrace: TurnTrace = {
      turnIndex,
      turnId: `${scenario.id}-turn-${turnIndex}`,
      timestamp: new Date().toISOString(),
      inbound: {
        channel,
        senderId,
        text: turnExp.input,
        buttonPayload: turnExp.buttonPayload,
        messageId,
      },
      stateBefore,
      processing: {
        architecture: options?.architecture ?? "GOAL_DRIVEN_HYBRID",
        jevDecision: result.typeSafeJevDecision
          ? {
              status:
                result.typeSafeJevDecision.source === "TYPESAFE_JEV"
                  ? "JEV_EVALUATED"
                  : "FALLBACK",
              route: result.typeSafeJevDecision.reason,
              confidence: result.typeSafeJevDecision.confidence,
              strategy: result.typeSafeJevDecision.source,
            }
          : {
              status: "GOAL_DRIVEN_RESOLVED",
              route: "SEMANTIC_GOAL_PROJECTION",
              confidence: 1.0,
            },
        typeSafeJevDecision: result.typeSafeJevDecision ?? null,
        baselineDecision: result.baselineDecision ?? null,
        decisionDifference: result.decisionDifference ?? null,
        goalStateBefore: result.goalStateBefore ?? null,
        goalStateAfter: result.goalStateAfter ?? null,
        bookingCoreAction: result.bookingCoreAction ?? null,
        reasonForFallbackOrHandoff: result.reasonForFallbackOrHandoff ?? null,
        latencyAndCost: result.latencyAndCost,
        semanticIntent: result.intent ?? "BOOKING",
        extractedEntities: {
          service: stateAfter.selectedService,
          date: stateAfter.selectedDate,
          provider: stateAfter.providerPreference,
        },
        toolCalls: [],
        executionTimeMs: durationMs,
        llmCalls: turnLlmCalls,
        jevCalls: result.jevCalls ?? 0,
        tokenUsageEstimate: {
          promptTokens: turnPromptTokens,
          completionTokens: turnCompletionTokens,
          totalTokens: turnTotalTokens,
        },
      },
      stateAfter,
      outbound: {
        text: outboundText,
        buttons: outboundButtons,
        replyMarkup,
        sentCount: 1,
      },
      assistantAction: result.assistantAction ?? "AI_REPLY",
      conversationStatus:
        result.conversationStatus ?? harness.conversation.status,
      diagnostics: {
        warnings,
        isClarificationLoop,
        isUnnecessaryHandoff,
        isContextLoss,
        isDuplicateBookingAttempt,
        appointmentCreated,
        appointmentId,
      },
    };

    turns.push(turnTrace);

    // 7. Assertions for this turn
    if (
      turnExp.expectedAction &&
      turnTrace.assistantAction !== turnExp.expectedAction
    ) {
      scenarioVerdict = "FAIL";
      failureReason = `Turn ${turnIndex}: expected action ${turnExp.expectedAction}, got ${turnTrace.assistantAction}`;
      break;
    }

    if (
      turnExp.expectedIntent &&
      result.intent &&
      result.intent !== turnExp.expectedIntent
    ) {
      scenarioVerdict = "FAIL";
      failureReason = `Turn ${turnIndex}: expected intent ${turnExp.expectedIntent}, got ${result.intent}`;
      break;
    }

    if (turnExp.expectedOutboundContains) {
      for (const phrase of turnExp.expectedOutboundContains) {
        if (!outboundText.includes(phrase)) {
          scenarioVerdict = "FAIL";
          failureReason = `Turn ${turnIndex}: outbound missing expected phrase '${phrase}'. Got:\n${outboundText}`;
          break;
        }
      }
      if (scenarioVerdict === "FAIL") break;
    }

    if (turnExp.forbiddenOutboundContains) {
      for (const phrase of turnExp.forbiddenOutboundContains) {
        if (outboundText.includes(phrase)) {
          scenarioVerdict = "FAIL";
          failureReason = `Turn ${turnIndex}: outbound contains forbidden phrase '${phrase}'. Got:\n${outboundText}`;
          break;
        }
      }
      if (scenarioVerdict === "FAIL") break;
    }

    if (turnExp.assertFn) {
      try {
        turnExp.assertFn(turnTrace, turns);
      } catch (err: any) {
        scenarioVerdict = "FAIL";
        failureReason = `Turn ${turnIndex} custom assertion failed: ${err?.message ?? String(err)}`;
        break;
      }
    }
  }

  // 8. Overall scenario expectations
  if (scenarioVerdict === "PASS") {
    if (scenario.expectations.shouldBook) {
      const booked =
        harness.appointments.length >
        (scenario.setup?.initialAppointments?.length ??
          (scenario.setup?.priorAppointment ? 1 : 0));
      if (!booked) {
        scenarioVerdict = "FAIL";
        failureReason = `Scenario expected appointment creation, but none was created`;
      }
    }

    if (
      scenario.expectations.maxLlmCalls !== undefined &&
      totalLlmCalls > scenario.expectations.maxLlmCalls
    ) {
      scenarioVerdict = "FAIL";
      failureReason = `Exceeded max allowed LLM calls: got ${totalLlmCalls}, max ${scenario.expectations.maxLlmCalls}`;
    }
  }

  const completedAt = new Date().toISOString();
  const totalDurationMs = turns.reduce(
    (sum, t) => sum + t.processing.executionTimeMs,
    0,
  );

  const metrics: ScenarioMetrics = {
    totalTurns: turns.length,
    totalDurationMs,
    totalLlmCalls,
    totalTokens: {
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens,
    },
    appointmentBooked:
      harness.appointments.length >
      (scenario.setup?.initialAppointments?.length ??
        (scenario.setup?.priorAppointment ? 1 : 0)),
    clarificationLoopDetected,
    unnecessaryHandoffDetected,
  };

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    category: scenario.category,
    architecture: options?.architecture ?? "GOAL_DRIVEN_HYBRID",
    startedAt,
    completedAt,
    turns,
    verdict: scenarioVerdict,
    failureReason,
    metrics,
  };
}
