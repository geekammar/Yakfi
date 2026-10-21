/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Structured Trace & Scenario Types
 * Non-negotiable DECISION 0.1, 0.2, 0.3 (CONV-PLAY-01)
 */

import type { ConversationState } from "@/features/conversations/server/conversation-state";
import type { Business, ConversationStatus } from "@/types/domain";

export type PlaygroundArchitecture =
  | "HYBRID_B"
  | "GOAL_DRIVEN_HYBRID"
  | "TYPESAFE_JEV_GOAL_DRIVEN"
  | "AGENT_C"
  | "DETERMINISTIC_BASELINE"
  | "FULL_AGENT"
  | "CURRENT_ENGINE";

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

export type TypeSafeJevTurnDiagnostic = {
  intent: string;
  confidence: number;
  source: "TYPESAFE_JEV" | "DETERMINISTIC_BASELINE" | "FALLBACK";
  reason: string;
  isAbstention?: boolean;
  fallbackReason?: string | null;
  rawProbabilities?: Record<string, number>;
  conversationGoal?: string | null;
  latencyMs?: number;
  tokens?: { input: number; output: number };
  costUsd?: number;
  isCostEstimate?: boolean;
};

export type BaselineTurnDiagnostic = {
  intent: string;
  action: string;
  reason?: string;
};

export type BookingCoreActionDiagnostic = {
  action:
    "NONE" | "SLOTS_RESOLVED" | "APPOINTMENT_CREATED" | "CONFLICT_PREVENTED";
  serviceId?: string | null;
  providerId?: string | null;
  slotStartTime?: string | null;
  slotDate?: string | null;
  appointmentId?: string | null;
  preventedConflict?: boolean;
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
  /** CONV-JEV-01 Step F.3: TypeSafe JEV decision, if actually called */
  typeSafeJevDecision?: TypeSafeJevTurnDiagnostic | null;
  /** CONV-JEV-01 Step F.4: Deterministic Baseline decision */
  baselineDecision?: BaselineTurnDiagnostic | null;
  /** CONV-JEV-01 Step F.5: Difference between the two decisions */
  decisionDifference?: string | null;
  /** CONV-JEV-01 Step F.2: Goal and context before processing */
  goalStateBefore?: Record<string, any> | null;
  /** CONV-JEV-01 Step F.6: Goal and context after processing */
  goalStateAfter?: Record<string, any> | null;
  /** CONV-JEV-01 Step F.7: Booking Core action, if any */
  bookingCoreAction?: BookingCoreActionDiagnostic | null;
  /** CONV-JEV-01 Step F.9: Reason for fallback or handoff */
  reasonForFallbackOrHandoff?: string | null;
  /** CONV-JEV-01 Step F.10: Latency and cost */
  latencyAndCost?: {
    latencyMs: number;
    costUsd: number;
    isEstimate: boolean;
  };
  semanticIntent: string | null;
  extractedEntities: Record<string, any>;
  toolCalls: ToolCallRecord[];
  executionTimeMs: number;
  llmCalls: number;
  jevCalls?: number;
  tokenUsageEstimate: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** CORE-03C1: Explicit measurement classification */
  measuredUsage?: MeasuredTokenUsage;
  /** CORE-03C1: Current Engine detailed execution record */
  currentEngine?: CurrentEngineTurnTraceDetails;
};

export type MeasuredTokenUsageSource =
  | "OFFLINE_FIXTURE"
  | "LIVE_PROVIDER"
  | "ESTIMATE"
  | "UNKNOWN"
  | "NOT_APPLICABLE";

export type MeasuredTokenUsage = {
  source: MeasuredTokenUsageSource;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  isEstimate: boolean;
  completeness?: "COMPLETE" | "PARTIAL" | "UNKNOWN" | "NOT_APPLICABLE";
  unknownAttemptsCount?: number;
  knownAttemptsCount?: number;
};

export type CurrentEngineHttpAttemptTrace = {
  index: number;
  url: string;
  method: string;
  status: number;
  durationMs: number;
  timestamp: string;
  sanitizedHeaders: Record<string, string>;
  error?: string | null;
};

export type CurrentEngineTurnTraceDetails = {
  routing: {
    route:
      | "STRUCTURED_SEMANTIC"
      | "MECHANICAL_SELECTION"
      | "DETERMINISTIC_BYPASS"
      | "POLICY_PROHIBITED"
      | "STAFF_DEFERRED"
      | "UNKNOWN";
    effectiveCapability: string;
    configuredProvider: string;
    configuredModel: string;
    observedProvider: string | null;
    observedModel: string | null;
    finalProvider?: string | null;
    finalModel?: string | null;
  };
  semantic: {
    intent: string | null;
    /** Captured directly from parsed AiResponse.extraction, NOT saved state */
    modelExtraction: Record<string, string | null> | null;
    /** Captured directly from parsed AiResponse.factUpdates */
    modelFactUpdates: Array<{
      key: string;
      operation?: string;
      value?: string;
    }> | null;
    /** Reconciled durable facts after turn from state store knownFacts */
    reconciledKnownFacts: Record<string, string | null> | null;
    /** Compatibility alias for legacy access */
    extraction?: Record<string, string | null> | null;
    factUpdates?: Array<{
      key: string;
      operation?: string;
      value?: string;
    }> | null;
  };
  task: {
    activeTask: string | null;
    missingFacts: string[];
    currentGoal: string | null;
  };
  offerTransition: {
    offerBefore: any | null;
    offerAfter: any | null;
    transition: string;
  };
  availabilityQueries: Array<{
    businessId: string;
    date: string;
    assigneeIds?: string[];
  }>;
  domainResult: {
    action: "AI_REPLY" | "AI_HANDOFF" | "DEFERRED_TO_STAFF";
    conversationStatus: ConversationStatus;
    clarificationCause?: string | null;
    handoffCause?: string | null;
    preventedConflict?: boolean;
    createdAppointment?: any | null;
  };
  httpAttempts: {
    count: number;
    attempts: CurrentEngineHttpAttemptTrace[];
  };
  tokenUsage: MeasuredTokenUsage;
};

export type LiveOperatorLimits = {
  scenarioSubset: string[];
  maxPhysicalHttpAttempts: number;
  outputTokenLimit: number;
  timeoutMs: number;
  approvedBudgetUsd: number;
  budgetBasis: string;
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
  isContextLoss?: boolean;
  isDuplicateBookingAttempt?: boolean;
  appointmentCreated: boolean;
  appointmentId?: string | null;
};

export type TurnTrace = {
  turnIndex: number; // 1-based index
  turnId: string;
  timestamp: string; // ISO
  referenceTime?: string;
  timezone?: string;
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
    | "SAFETY_HANDOFF"
    | "POST_BOOKING_CONTINUITY";
  description: string;
  channel?: InboundChannel;
  setup?: {
    businessConfig?: Partial<Business>;
    services?: any[];
    providers?: any[];
    initialAppointments?: any[];
    priorAppointment?: boolean;
    todayRef?: string;
    conversationStatus?: ConversationStatus;
    assignedUserId?: string | null;
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
  totalJevCalls?: number;
  totalCostUsd?: number | null;
  isCostEstimate?: boolean;
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  totalTokens: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  } | null;
  tokenCompleteness?: "COMPLETE" | "PARTIAL" | "UNKNOWN" | "NOT_APPLICABLE";
  knownTokensSubtotal?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  unknownAttemptsCount?: number;
  appointmentBooked: boolean;
  clarificationLoopDetected: boolean;
  unnecessaryHandoffDetected: boolean;
  contextLossDetected?: boolean;
  duplicateBookingPrevented?: boolean;
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
  /** Architecture A: Deterministic Baseline */
  hybridVerdict: "PASS" | "FAIL";
  /** Architecture B: Goal-Driven Hybrid */
  goalDrivenVerdict?: "PASS" | "FAIL";
  /** Architecture C: Real TypeSafe JEV + Goal-Driven State */
  typeSafeJevVerdict?: "PASS" | "FAIL";
  /** Architecture D (Optional): Full Agent C */
  agentCVerdict: "PASS" | "FAIL";
  hybridDurationMs: number;
  goalDrivenDurationMs?: number;
  typeSafeJevDurationMs?: number;
  agentCDurationMs: number;
  hybridLlmCalls: number;
  goalDrivenLlmCalls?: number;
  typeSafeJevLlmCalls?: number;
  typeSafeJevCalls?: number;
  typeSafeJevCostUsd?: number;
  agentCLlmCalls: number;
  notes?: string;
};

export type BenchmarkComparisonReport = {
  timestamp: string;
  evaluationMode: "LIVE_TYPESAFE_JEV" | "OFFLINE_SIMULATION" | "HYBRID_ONLY";
  totalScenarios: number;
  hybridPassed: number;
  goalDrivenPassed?: number;
  typeSafeJevPassed?: number;
  agentCPassed: number;
  hybridAvgDurationMs: number;
  goalDrivenAvgDurationMs?: number;
  typeSafeJevAvgDurationMs?: number;
  agentCAvgDurationMs: number;
  hybridTotalLlmCalls: number;
  goalDrivenTotalLlmCalls?: number;
  typeSafeJevTotalLlmCalls?: number;
  typeSafeJevTotalCalls?: number;
  typeSafeJevTotalCostUsd?: number;
  agentCTotalLlmCalls: number;
  hybridTotalTokens: number;
  goalDrivenTotalTokens?: number;
  typeSafeJevTotalTokens?: number;
  agentCTotalTokens: number;
  comparisons: ScenarioComparison[];
};
