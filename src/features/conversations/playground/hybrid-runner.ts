/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Hybrid B Instrumented Runner
 * Non-negotiable DECISION 0.1: Context-Aware Hybrid Conversation Architecture.
 */

import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import { deriveConversationStateFromHistory } from "@/features/conversations/server/conversation-state";

import { createPlaygroundHarness, type PlaygroundHarness } from "./harness";
import type {
  ScenarioDefinition,
  ScenarioMetrics,
  ScenarioTrace,
  TurnTrace,
} from "./types";

export async function runHybridScenario(
  scenario: ScenarioDefinition,
  existingHarness?: PlaygroundHarness,
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

    const prevOutboundLen = harness.deliveredOutbound.length;
    const prevApptsLen = harness.appointments.length;
    const prevLlmCalls = harness.llmStats.callCount;
    const prevPromptTokens = harness.llmStats.promptTokens;
    const prevCompletionTokens = harness.llmStats.completionTokens;

    const startTurnTime = Date.now();

    // 2. Format inbound payload
    const inboundPayload = {
      from: senderId,
      to:
        channel === "TELEGRAM"
          ? "6000000000"
          : (harness.business.whatsappNumber ?? "+201001111111"),
      text: turnExp.input,
      receivedAt: harness.getVirtualNow().toISOString(),
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
      failureReason = `Turn ${turnIndex} threw unhandled exception: ${err?.message ?? String(err)}`;
      break;
    }

    const durationMs = Date.now() - startTurnTime;

    // 3. Capture state after
    const stateAfter = deriveConversationStateFromHistory(
      harness.messages.map((m) => ({
        senderType: m.senderType,
        content: m.content,
      })),
    );

    // 4. Capture outbound message(s)
    const newOutbound = harness.deliveredOutbound.slice(prevOutboundLen);
    const outboundText = newOutbound.map((o) => o.body).join("\n\n");
    const outboundButtons = newOutbound.flatMap((o) => o.buttons ?? []);
    const replyMarkup = newOutbound[newOutbound.length - 1]?.replyMarkup;

    // 5. Diagnostics
    const newAppts = harness.appointments.slice(prevApptsLen);
    const appointmentCreated = newAppts.length > 0;
    const appointmentId = newAppts[0]?.id ?? null;

    const turnLlmCalls = harness.llmStats.callCount - prevLlmCalls;
    const turnPromptTokens = harness.llmStats.promptTokens - prevPromptTokens;
    const turnCompletionTokens =
      harness.llmStats.completionTokens - prevCompletionTokens;
    const turnTotalTokens = turnPromptTokens + turnCompletionTokens;

    totalLlmCalls += turnLlmCalls;
    totalPromptTokens += turnPromptTokens;
    totalCompletionTokens += turnCompletionTokens;
    totalTokens += turnTotalTokens;

    // Clarification loop check: check if last turn asked identical question
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

    const warnings: string[] = [];
    if (isClarificationLoop) {
      warnings.push("CLARIFICATION_LOOP_DETECTED");
    }
    if (isUnnecessaryHandoff) {
      warnings.push("UNNECESSARY_HANDOFF_DETECTED");
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
        architecture: "HYBRID_B",
        jevDecision: result.observability?.routingDecision
          ? {
              status: result.observability.routingDecision,
              route: result.observability.turnPlan?.route,
              confidence: result.observability.turnPlan?.confidence,
            }
          : null,
        semanticIntent: result.intent ?? null,
        extractedEntities: {
          service: stateAfter.selectedService,
          date: stateAfter.selectedDate,
          provider: stateAfter.providerPreference,
        },
        toolCalls: [],
        executionTimeMs: durationMs,
        llmCalls: turnLlmCalls,
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
        sentCount: newOutbound.length,
      },
      assistantAction: result.assistantAction ?? "AI_REPLY",
      conversationStatus:
        result.conversationStatus ?? harness.conversation.status,
      diagnostics: {
        warnings,
        isClarificationLoop,
        isUnnecessaryHandoff,
        appointmentCreated,
        appointmentId,
      },
    };

    turns.push(turnTrace);

    // 6. Assertions for this turn
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

  // 7. Overall scenario expectations
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
    architecture: "HYBRID_B",
    startedAt,
    completedAt,
    turns,
    verdict: scenarioVerdict,
    failureReason,
    metrics,
  };
}
