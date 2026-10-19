/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Experimental Full Agent C Benchmark Harness
 * Non-negotiable DECISION 0.2: Experimental benchmark only (MOCK_ONLY by default).
 * Strict execution limits: max 5 model calls, max 10 tool calls, max 4000 tokens, 5s timeout.
 */

import { createPlaygroundHarness, type PlaygroundHarness } from "./harness";
import type {
  ScenarioDefinition,
  ScenarioMetrics,
  ScenarioTrace,
  ToolCallRecord,
  TurnTrace,
} from "./types";

export type AgentCToolSandbox = {
  listServices: () => Promise<any[]>;
  listEligibleProviders: (serviceId: string) => Promise<any[]>;
  listAvailableTimes: (
    serviceId: string,
    providerId?: string,
    date?: string,
  ) => Promise<any[]>;
  confirmBooking: (
    serviceId: string,
    providerId: string | null,
    date: string,
    time: string,
  ) => Promise<any>;
  clarify: (prompt: string, options?: string[]) => Promise<any>;
};

export function createAgentCSandbox(
  harness: PlaygroundHarness,
): AgentCToolSandbox {
  return {
    listServices: async () => {
      return harness.deps.serviceRepository.listByBusiness(harness.business.id);
    },
    listEligibleProviders: async (serviceId: string) => {
      if (harness.deps.providerRepository?.listEligibleForService) {
        return harness.deps.providerRepository.listEligibleForService(
          harness.business.id,
          serviceId,
        );
      }
      return [];
    },
    listAvailableTimes: async (
      _serviceId: string,
      _providerId?: string,
      _date?: string,
    ) => {
      return [
        { time: "10:00", available: true },
        { time: "10:30", available: true },
        { time: "11:00", available: true },
      ];
    },
    confirmBooking: async (
      serviceId: string,
      providerId: string | null,
      date: string,
      time: string,
    ) => {
      if (!harness.deps.appointmentRepository?.createWithConflictCheck) {
        throw new Error("createWithConflictCheck not implemented in harness");
      }
      return harness.deps.appointmentRepository.createWithConflictCheck({
        businessId: harness.business.id,
        branchId: harness.business.defaultBranchId ?? "default-branch",
        customerId: harness.customer.id,
        serviceId,
        providerId: providerId ?? undefined,
        assignedUserId: providerId ?? "assigned-user",
        date,
        startTime: time,
        endTime: "10:30",
        status: "CONFIRMED",
      });
    },
    clarify: async (prompt: string, options?: string[]) => {
      return { prompt, options: options ?? [] };
    },
  };
}

/**
 * Agent C Turn Simulator (MOCK_ONLY)
 * Reproducibly executes tool calls according to conversational intent
 * following the exact tool calling loop of an LLM agent.
 */
async function simulateAgentCTurn(
  input: string,
  sandbox: AgentCToolSandbox,
  harness: PlaygroundHarness,
  _priorTurns: TurnTrace[],
): Promise<{
  outboundText: string;
  toolCalls: ToolCallRecord[];
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  appointmentCreated: boolean;
  appointmentId?: string | null;
  action: "AI_REPLY" | "AI_HANDOFF" | "DEFERRED_TO_STAFF";
}> {
  const toolCalls: ToolCallRecord[] = [];
  let modelCalls = 1;
  let promptTokens = 350;
  let completionTokens = 90;
  let outboundText = "";
  let appointmentCreated = false;
  let appointmentId: string | null = null;
  let action: "AI_REPLY" | "AI_HANDOFF" | "DEFERRED_TO_STAFF" = "AI_REPLY";

  const lower = input.trim();

  // Guard: Safety / Emergency / Human request
  if (
    lower.includes("حد") ||
    lower.includes("موظف") ||
    lower.includes("انسان")
  ) {
    action = "AI_HANDOFF";
    outboundText = "تم تحويل المحادثة إلى أحد موظفي العيادة للمتابعة معك.";
    return {
      outboundText,
      toolCalls,
      modelCalls,
      promptTokens,
      completionTokens,
      appointmentCreated,
      appointmentId,
      action,
    };
  }

  if (lower.includes("نزيف") || lower.includes("طوارئ")) {
    action = "AI_HANDOFF";
    outboundText =
      "هذه حالة طبية طارئة، يرجى التوجه فوراً لأقرب مستشفى أو الاتصال بالطوارئ. تم إخطار الفريق الطبي.";
    return {
      outboundText,
      toolCalls,
      modelCalls,
      promptTokens,
      completionTokens,
      appointmentCreated,
      appointmentId,
      action,
    };
  }

  // Check if customer asked for catalog
  if (lower.includes("الخدمات") || lower.includes("ايه الخدمات")) {
    const t0 = Date.now();
    const services = await sandbox.listServices();
    toolCalls.push({
      tool: "listServices",
      args: {},
      result: services.map((s) => ({ id: s.id, name: s.name, price: s.price })),
      durationMs: Date.now() - t0,
    });
    modelCalls++;
    promptTokens += 200;
    completionTokens += 80;
    outboundText =
      `الخدمات المتاحة لدينا:\n` +
      services
        .map((s, idx) => `${idx + 1}. ${s.name} (${s.price} ${s.currency})`)
        .join("\n") +
      `\n\nهل تود حجز موعد لأي من هذه الخدمات؟`;
    return {
      outboundText,
      toolCalls,
      modelCalls,
      promptTokens,
      completionTokens,
      appointmentCreated,
      appointmentId,
      action,
    };
  }

  // Check for slot selection (ordinals or numbers e.g. "1", "الأول", "التاني")
  const isSelection =
    /^(1|2|3|الأول|الاول|التاني|الثاني|التالت|الثالث|opt_1|slot_1)$/.test(
      lower,
    ) ||
    lower.includes("10:00") ||
    lower.includes("10:30");

  if (isSelection) {
    // Model calls confirmBooking tool
    const t0 = Date.now();
    const services = await sandbox.listServices();
    const defaultServiceId =
      harness.business.defaultServiceBookingEnabled &&
      harness.business.defaultBookingServiceId
        ? harness.business.defaultBookingServiceId
        : services[0]?.id;

    const appt = await sandbox.confirmBooking(
      defaultServiceId ?? services[0]?.id,
      null,
      "2026-10-21",
      "10:00",
    );
    toolCalls.push({
      tool: "confirmBooking",
      args: { serviceId: defaultServiceId, date: "2026-10-21", time: "10:00" },
      result: { id: appt.id, status: appt.status },
      durationMs: Date.now() - t0,
    });
    modelCalls++;
    promptTokens += 220;
    completionTokens += 95;
    appointmentCreated = true;
    appointmentId = appt.id;
    outboundText = `تم تأكيد حجزك بنجاح لدى ${harness.business.name}!\nالموعد: 2026-10-21 الساعة 10:00.`;
    return {
      outboundText,
      toolCalls,
      modelCalls,
      promptTokens,
      completionTokens,
      appointmentCreated,
      appointmentId,
      action,
    };
  }

  // Booking intent: tool calling loop (listServices -> listAvailableTimes)
  const t0 = Date.now();
  const services = await sandbox.listServices();
  toolCalls.push({
    tool: "listServices",
    args: {},
    result: services.map((s) => ({ id: s.id, name: s.name })),
    durationMs: Date.now() - t0,
  });
  modelCalls++;
  promptTokens += 150;
  completionTokens += 60;

  // Decide service
  let chosenService = null;
  if (lower.includes("تنظيف")) {
    chosenService = services.find((s) => s.name.includes("تنظيف"));
  } else if (lower.includes("كشف")) {
    chosenService = services.find((s) => s.name.includes("كشف"));
  } else if (
    harness.business.defaultServiceBookingEnabled &&
    harness.business.defaultBookingServiceId
  ) {
    chosenService = services.find(
      (s) => s.id === harness.business.defaultBookingServiceId,
    );
  } else if (services.length === 1) {
    chosenService = services[0];
  }

  if (!chosenService && services.length > 1) {
    // Clarify service
    const tClar = Date.now();
    await sandbox.clarify(
      "الرجاء اختيار الخدمة",
      services.map((s) => s.name),
    );
    toolCalls.push({
      tool: "clarify",
      args: { prompt: "الرجاء تحديد الخدمة المطلوبة" },
      result: { ok: true },
      durationMs: Date.now() - tClar,
    });
    outboundText =
      `يسعدنا مساعدتك في الحجز. يرجى اختيار الخدمة المطلوبة:\n` +
      services.map((s, idx) => `${idx + 1}. ${s.name}`).join("\n");
    return {
      outboundText,
      toolCalls,
      modelCalls,
      promptTokens,
      completionTokens,
      appointmentCreated,
      appointmentId,
      action,
    };
  }

  // We have a service, query times
  const servId = chosenService?.id ?? services[0]?.id;
  const tTimes = Date.now();
  const times = await sandbox.listAvailableTimes(servId);
  toolCalls.push({
    tool: "listAvailableTimes",
    args: { serviceId: servId },
    result: times.slice(0, 3),
    durationMs: Date.now() - tTimes,
  });
  modelCalls++;
  promptTokens += 250;
  completionTokens += 110;

  outboundText =
    `المواعيد المتاحة لخدمة (${chosenService?.name ?? "كشف أسنان"}):\n` +
    `1. 10:00 صباحاً\n2. 10:30 صباحاً\n3. 11:00 صباحاً\n\nيرجى الرد برقم الموعد المناسب.`;

  return {
    outboundText,
    toolCalls,
    modelCalls,
    promptTokens,
    completionTokens,
    appointmentCreated,
    appointmentId,
    action,
  };
}

export async function runAgentCScenario(
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

  const sandbox = createAgentCSandbox(harness);
  const turns: TurnTrace[] = [];
  let scenarioVerdict: "PASS" | "FAIL" = "PASS";
  let failureReason: string | null = null;

  let totalLlmCalls = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;

  for (let i = 0; i < scenario.turns.length; i++) {
    const turnExp = scenario.turns[i];
    if (!turnExp) continue;
    const turnIndex = i + 1;
    const channel = turnExp.channel ?? scenario.channel ?? "WHATSAPP";
    const senderId = harness.customer.phone;
    const messageId = `msg-c-${scenario.id}-${turnIndex}-${Date.now()}`;

    // Add inbound customer message to history
    await harness.deps.conversationRepository.addMessage({
      conversationId: harness.conversation.id,
      senderType: "CUSTOMER",
      content: turnExp.input,
    });

    const startTurnTime = Date.now();

    // Execute Agent C turn with strict limits
    const simResult = await simulateAgentCTurn(
      turnExp.input,
      sandbox,
      harness,
      turns,
    );

    const durationMs = Date.now() - startTurnTime;

    // Hard bounds enforcement
    if (simResult.modelCalls > 5) {
      scenarioVerdict = "FAIL";
      failureReason = `Agent C exceeded max model calls per turn: ${simResult.modelCalls} > 5`;
      break;
    }
    if (simResult.toolCalls.length > 10) {
      scenarioVerdict = "FAIL";
      failureReason = `Agent C exceeded max tool calls per turn: ${simResult.toolCalls.length} > 10`;
      break;
    }
    const turnTotalTokens = simResult.promptTokens + simResult.completionTokens;
    if (turnTotalTokens > 4000) {
      scenarioVerdict = "FAIL";
      failureReason = `Agent C exceeded max tokens per turn: ${turnTotalTokens} > 4000`;
      break;
    }
    if (durationMs > 5000) {
      scenarioVerdict = "FAIL";
      failureReason = `Agent C turn timed out: ${durationMs}ms > 5000ms`;
      break;
    }

    // Add outbound to harness delivered
    harness.deliveredOutbound.push({
      to: senderId,
      body: simResult.outboundText,
      channel,
      sentAt: harness.getVirtualNow(),
    });

    // Add outbound assistant message to history
    await harness.deps.conversationRepository.addMessage({
      conversationId: harness.conversation.id,
      senderType: "AI",
      content: simResult.outboundText,
    });

    totalLlmCalls += simResult.modelCalls;
    totalPromptTokens += simResult.promptTokens;
    totalCompletionTokens += simResult.completionTokens;
    totalTokens += turnTotalTokens;

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
      stateBefore: null,
      processing: {
        architecture: "AGENT_C",
        jevDecision: null,
        semanticIntent: null,
        extractedEntities: {},
        toolCalls: simResult.toolCalls,
        executionTimeMs: durationMs,
        llmCalls: simResult.modelCalls,
        tokenUsageEstimate: {
          promptTokens: simResult.promptTokens,
          completionTokens: simResult.completionTokens,
          totalTokens: turnTotalTokens,
        },
      },
      stateAfter: null,
      outbound: {
        text: simResult.outboundText,
        buttons: [],
        sentCount: 1,
      },
      assistantAction: simResult.action,
      conversationStatus:
        simResult.action === "AI_HANDOFF" ? "NEED_HUMAN" : "AI_ACTIVE",
      diagnostics: {
        warnings: ["EXPERIMENTAL_AGENT_C_BENCHMARK", "MOCK_ONLY"],
        isClarificationLoop: false,
        isUnnecessaryHandoff: false,
        appointmentCreated: simResult.appointmentCreated,
        appointmentId: simResult.appointmentId,
      },
    };

    turns.push(turnTrace);

    // Turn assertions
    if (
      turnExp.expectedAction &&
      turnTrace.assistantAction !== turnExp.expectedAction
    ) {
      scenarioVerdict = "FAIL";
      failureReason = `Turn ${turnIndex}: expected action ${turnExp.expectedAction}, got ${turnTrace.assistantAction}`;
      break;
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
    clarificationLoopDetected: false,
    unnecessaryHandoffDetected: false,
  };

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    category: scenario.category,
    architecture: "AGENT_C",
    startedAt,
    completedAt,
    turns,
    verdict: scenarioVerdict,
    failureReason,
    metrics,
  };
}
