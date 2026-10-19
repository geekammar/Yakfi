/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Structured Trace & Scenario Types
 * Non-negotiable DECISION 0.1, 0.2, 0.3 (CONV-PLAY-01)
 */

import type { ConversationState } from "@/features/conversations/server/conversation-state";
import type { Business, ConversationStatus } from "@/types/domain";

export type PlaygroundArchitecture = "HYBRID_B" | "GOAL_DRIVEN_HYBRID" | "AGENT_C";

export type InboundChannel = "WHATSAPP" | "TELEGRAM";

export type TurnInbound = {
  channel: InboundChannel;
  senderId: string;
  text: string;
  buttonPayload?: string;
  messageId: string;
};

export type ToolCallRecord = {
  tool: string;
  args: Record<string, any>;
  result: any;
  durationMs: number;
};

export type TurnProcessing = {
  architecture: PlaygroundArchitecture;
  jevDecision: {
    status: string;
    route?: string;
    confidence?: number;
    strategy?: string;
    reason?: string;
  } | null;
  semanticIntent: string | null;
  extractedEntities: Record<string, any>;
  toolCalls: ToolCallRecord[];
  executionTimeMs: number;
  llmCalls: number;
  tokenUsageEstimate: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

export type TurnOutbound = {
  text: string;
  buttons: Array<{ label: string; payload: string }>;
  replyMarkup?: any;
  sentCount: number;
};

export type TurnDiagnostics = {
  warnings: string[];
  isClarificationLoop: boolean;
  isUnnecessaryHandoff: boolean;
  appointmentCreated: boolean;
  appointmentId?: string | null;
};

export type TurnTrace = {
  turnIndex: number; // 1-based index
  turnId: string;
  timestamp: string; // ISO
  inbound: TurnInbound;
  stateBefore: Partial<ConversationState> | null;
  processing: TurnProcessing;
  stateAfter: Partial<ConversationState> | null;
  outbound: TurnOutbound;
  assistantAction: "AI_REPLY" | "AI_HANDOFF" | "DEFERRED_TO_STAFF";
  conversationStatus: ConversationStatus;
  diagnostics: TurnDiagnostics;
};

export type ScenarioTurnExpectation = {
  input: string;
  buttonPayload?: string;
  channel?: InboundChannel;
  expectedIntent?: string;
  expectedAction?: "AI_REPLY" | "AI_HANDOFF" | "DEFERRED_TO_STAFF";
  expectedOutboundContains?: string[];
  forbiddenOutboundContains?: string[];
  assertFn?: (turn: TurnTrace, allTurns: TurnTrace[]) => void;
};

export type ScenarioDefinition = {
  id: string;
  title: string;
  category:
    | "STANDARD_BOOKING"
    | "RELATIVE_DATES"
    | "PROVIDER_SELECTION"
    | "CLARIFICATION_RECOVERY"
    | "SLOT_NAVIGATION"
    | "CATALOG_INQUIRY"
    | "CHANNEL_FORMATTING"
    | "SAFETY_HANDOFF";
  description: string;
  channel?: InboundChannel;
  setup?: {
    businessConfig?: Partial<Business>;
    services?: any[];
    providers?: any[];
    initialAppointments?: any[];
    priorAppointment?: boolean;
    todayRef?: string;
  };
  turns: ScenarioTurnExpectation[];
  expectations: {
    shouldBook?: boolean;
    expectedServiceId?: string;
    maxLlmCalls?: number;
    maxTurns?: number;
  };
};

export type ScenarioMetrics = {
  totalTurns: number;
  totalDurationMs: number;
  totalLlmCalls: number;
  totalTokens: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  appointmentBooked: boolean;
  clarificationLoopDetected: boolean;
  unnecessaryHandoffDetected: boolean;
};

export type ScenarioTrace = {
  scenarioId: string;
  title: string;
  category: string;
  architecture: PlaygroundArchitecture;
  startedAt: string;
  completedAt: string;
  turns: TurnTrace[];
  verdict: "PASS" | "FAIL";
  failureReason: string | null;
  metrics: ScenarioMetrics;
};

export type ScenarioComparison = {
  scenarioId: string;
  title: string;
  category: string;
  hybridVerdict: "PASS" | "FAIL";
  goalDrivenVerdict?: "PASS" | "FAIL";
  agentCVerdict: "PASS" | "FAIL";
  hybridDurationMs: number;
  goalDrivenDurationMs?: number;
  agentCDurationMs: number;
  hybridLlmCalls: number;
  goalDrivenLlmCalls?: number;
  agentCLlmCalls: number;
  notes?: string;
};

export type BenchmarkComparisonReport = {
  timestamp: string;
  totalScenarios: number;
  hybridPassed: number;
  goalDrivenPassed?: number;
  agentCPassed: number;
  hybridAvgDurationMs: number;
  goalDrivenAvgDurationMs?: number;
  agentCAvgDurationMs: number;
  hybridTotalLlmCalls: number;
  goalDrivenTotalLlmCalls?: number;
  agentCTotalLlmCalls: number;
  hybridTotalTokens: number;
  goalDrivenTotalTokens?: number;
  agentCTotalTokens: number;
  comparisons: ScenarioComparison[];
};
