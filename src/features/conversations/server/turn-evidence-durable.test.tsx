// @vitest-environment node
/**
 * FlowPilot — REAL durable turn evidence on disposable PostgreSQL.
 *
 * These tests exercise the REAL repository and the REAL conversation engine
 * against the job-local CI database. Only the AI adapter and outbound
 * transport are controlled seams; tenant/customer/conversation/message/
 * usage/evidence writes are REAL PostgreSQL.
 *
 * Safety: refuses any non-loopback DATABASE_URL before touching fixtures.
 * No runtime/Neon credentials are ever used by automatic PR validation.
 */
import { randomUUID } from "node:crypto";

import type { AiResponse } from "@/features/conversations/server/ai-contract";
import {
  defaultConversationEngineDeps,
  receiveInboundMessage,
  type ConversationEngineDeps,
  type InboundResult,
} from "@/features/conversations/server/conversation-engine";
import { buildDurableTurnEvidence } from "@/features/conversations/server/durable-turn-evidence";
import type { TurnEvidence } from "@/features/conversations/server/turn-evidence";
import { db } from "@/server/db";
import type { AiTelemetry } from "@/server/integrations/ai/types";
import { turnEvidenceRepository } from "@/server/repositories";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Fixture = {
  businessId: string;
  branchId: string;
  whatsappNumber: string;
};

type EvidenceRepo = NonNullable<
  ConversationEngineDeps["turnEvidenceRepository"]
>;

const createdBusinessIds: string[] = [];
const createdUserIds: string[] = [];

function classifyLocalDatabaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    return (
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === ""
    );
  } catch {
    return false;
  }
}

function randomPhone(prefix: string): string {
  return `${prefix}${String(Math.floor(Math.random() * 100000000)).padStart(8, "0")}`;
}

async function createFixture(name: string): Promise<Fixture> {
  const businessId = randomUUID();
  const branchId = randomUUID();
  const whatsappNumber = randomPhone("+2010");
  createdBusinessIds.push(businessId);
  await db.business.create({
    data: {
      id: businessId,
      name,
      whatsappNumber,
      timezone: "Africa/Cairo",
      confirmationMode: "automatic",
      appointmentTimeDisplay: "START_ONLY",
      isActive: true,
    },
  });
  await db.branch.create({
    data: { id: branchId, businessId, name: "الفرع الرئيسي" },
  });
  await db.business.update({
    where: { id: businessId },
    data: { defaultBranchId: branchId },
  });
  return { businessId, branchId, whatsappNumber };
}

const SAFE_HANDOFF: AiResponse = {
  intent: "FAQ",
  action: "handoff",
  content: "سيتواصل معك أحد أعضاء الفريق.",
  extraction: {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  },
  handoffReason: "NO_KNOWLEDGE",
  summary: null,
  safetyAssessment: "safe",
};

type AttemptInput = {
  provider: "openrouter" | "agentrouter";
  model: string;
  status: "SUCCESS" | "FAILURE";
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  httpAttempts?: number | null;
  errorCode?: "TIMEOUT" | "PERMANENT";
  httpStatus?: number;
};

function buildTelemetry(
  attempts: AttemptInput[],
  costs: {
    totalCostUsd: number | null;
    knownCostSubtotalUsd: number | null;
    costCompleteness: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  },
): AiTelemetry {
  const resolvedHttpAttempts = attempts.map((attempt) =>
    attempt.httpAttempts === null ? undefined : (attempt.httpAttempts ?? 1),
  );
  const allHttpKnown = resolvedHttpAttempts.every(
    (value) => typeof value === "number",
  );
  const totalHttpAttempts = allHttpKnown
    ? resolvedHttpAttempts.reduce((sum, value) => sum + (value ?? 0), 0)
    : undefined;
  const retryAttempts = attempts.map((attempt, index) => ({
    attempt: index + 1,
    outcome: attempt.status,
    provider: attempt.provider,
    model: attempt.model,
    latencyMs: 10,
    ...(typeof resolvedHttpAttempts[index] === "number"
      ? { httpAttempts: resolvedHttpAttempts[index] }
      : {}),
    inputTokens: attempt.inputTokens,
    outputTokens: attempt.outputTokens,
    costUsd: attempt.costUsd,
    errorCode: attempt.errorCode,
    httpStatus: attempt.httpStatus,
  }));
  return {
    attempts: attempts.map((attempt, index) => ({
      provider: attempt.provider,
      model: attempt.model,
      latencyMs: 10,
      ...(typeof resolvedHttpAttempts[index] === "number"
        ? { httpAttempts: resolvedHttpAttempts[index] }
        : {}),
      inputTokens: attempt.inputTokens,
      outputTokens: attempt.outputTokens,
      costUsd: attempt.costUsd,
      status: attempt.status,
      errorCode: attempt.errorCode,
      httpStatus: attempt.httpStatus,
    })),
    fallbackUsed: attempts.length > 1,
    finalProvider: attempts[attempts.length - 1]?.provider ?? "openrouter",
    finalModel: attempts[attempts.length - 1]?.model ?? null,
    finalStatus: attempts[attempts.length - 1]?.status ?? "FAILURE",
    totalHttpAttempts,
    totalCostUsd: costs.totalCostUsd,
    knownCostSubtotalUsd: costs.knownCostSubtotalUsd,
    costCompleteness: costs.costCompleteness,
    retryTrace: {
      provider: attempts[0]?.provider ?? "openrouter",
      maxAttempts: 3,
      attempts: retryAttempts,
      retryAttempted: attempts.length > 1,
      retryTriggerCode:
        attempts.find((attempt) => attempt.errorCode)?.errorCode ?? null,
      retrySkippedReason: "NONE",
      deadlineMs: 0,
      retryTimeoutMs: 10_000,
      finalOutcome: attempts[attempts.length - 1]?.status ?? "FAILURE",
      totalElapsedMs: 20,
      totalHttpAttempts,
      totalCostUsd: costs.totalCostUsd,
      knownCostSubtotalUsd: costs.knownCostSubtotalUsd,
      costCompleteness: costs.costCompleteness,
    },
  };
}

type SuccessResult = Extract<InboundResult, { ok: true; duplicate: false }>;

type TurnRun = {
  result: SuccessResult;
  aiCalls: number;
  sends: number;
  emitted: TurnEvidence[];
  deps: ConversationEngineDeps;
};

async function runTurn(
  fixture: Fixture,
  options: {
    text?: string;
    externalId?: string;
    phone?: string;
    aiResponse?: AiResponse | null;
    telemetry?: AiTelemetry | null;
    telemetryPresent?: boolean;
    repo?: EvidenceRepo;
    requiredSemanticCapability?: "structured_turn" | null;
    trafficPool?: ConversationEngineDeps["trafficPool"];
  } = {},
): Promise<TurnRun> {
  let aiCalls = 0;
  let sends = 0;
  const emitted: TurnEvidence[] = [];
  const ai = {
    providerName: "fake-ai",
    async respond(): Promise<AiResponse> {
      aiCalls += 1;
      if (!options.aiResponse) throw new Error("simulated provider failure");
      return options.aiResponse;
    },
    ...(options.telemetryPresent === false
      ? {}
      : { getLastTelemetry: () => options.telemetry ?? null }),
  } as unknown as ConversationEngineDeps["ai"];
  const transport = {
    providerName: "fake-transport",
    async send() {
      sends += 1;
      return { provider: "fake-transport", delivered: true };
    },
  } as unknown as ConversationEngineDeps["transport"];

  const deps: ConversationEngineDeps = {
    ...defaultConversationEngineDeps,
    ai,
    transport,
    turnTelemetry: { emit: (record) => emitted.push(record) },
    turnEvidenceRepository: options.repo ?? turnEvidenceRepository,
    trafficPool: options.trafficPool ?? "TEST",
    ...(options.requiredSemanticCapability !== undefined
      ? { requiredSemanticCapability: options.requiredSemanticCapability }
      : {}),
  };

  const result = await receiveInboundMessage(deps, {
    to: fixture.whatsappNumber,
    from: options.phone ?? randomPhone("+2011"),
    text: options.text ?? "ما هي الخدمات المتاحة؟",
    receivedAt: new Date().toISOString(),
    externalId: options.externalId ?? randomUUID(),
  });
  if (!result.ok || result.duplicate) {
    throw new Error("EXPECTED_SUCCESSFUL_TURN");
  }
  return { result, aiCalls, sends, emitted, deps };
}

async function findEvidence(businessId: string, customerMessageId: string) {
  return db.turnEvidenceRecord.findUnique({
    where: {
      businessId_customerMessageId: { businessId, customerMessageId },
    },
    include: { attempts: { orderBy: { attemptIndex: "asc" } } },
  });
}

function windowForNow(): { from: Date; to: Date } {
  const now = Date.now();
  return {
    from: new Date(now - 60 * 60 * 1000),
    to: new Date(now + 60 * 60 * 1000),
  };
}

beforeAll(async () => {
  if (!classifyLocalDatabaseUrl(process.env.DATABASE_URL ?? "")) {
    throw new Error(
      "DEV_DB_INTEGRATION_BLOCKED: DATABASE_URL must point to a local disposable test database.",
    );
  }
});

afterAll(async () => {
  for (const businessId of createdBusinessIds) {
    await db.turnEvidenceRecord.deleteMany({ where: { businessId } });
    await db.usageRecord.deleteMany({ where: { businessId } });
    await db.inboundMessageDedupe.deleteMany({ where: { businessId } });
    await db.conversationStateRecord.deleteMany({ where: { businessId } });
    await db.knowledgeGap.deleteMany({ where: { businessId } });
    await db.operatorAttention.deleteMany({ where: { businessId } });
    await db.message.deleteMany({
      where: { conversation: { businessId } },
    });
    await db.conversation.deleteMany({ where: { businessId } });
    await db.customer.deleteMany({ where: { businessId } });
    await db.service.deleteMany({ where: { businessId } });
    await db.business.updateMany({
      where: { id: businessId },
      data: { defaultBranchId: null },
    });
    await db.branch.deleteMany({ where: { businessId } });
    await db.business.deleteMany({ where: { id: businessId } });
  }
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

describe("durable turn evidence (disposable PostgreSQL)", () => {
  it("persists one successful attempt with reported cost and links AI_TURN", async () => {
    const fixture = await createFixture("منشأة التكلفة");
    const cost = 0.0001234;
    const telemetry = buildTelemetry(
      [
        {
          provider: "openrouter",
          model: "model-1",
          status: "SUCCESS",
          costUsd: cost,
          inputTokens: 123,
          outputTokens: 45,
        },
      ],
      {
        totalCostUsd: cost,
        knownCostSubtotalUsd: cost,
        costCompleteness: "COMPLETE",
      },
    );
    const run = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      telemetry,
    });

    const row = await findEvidence(
      fixture.businessId,
      run.result.customerMessageId,
    );
    expect(row).not.toBeNull();
    expect(row?.trafficPool).toBe("TEST");
    expect(row?.attempts).toHaveLength(1);
    expect(row?.attempts[0]?.provider).toBe("openrouter");
    expect(row?.attempts[0]?.costUsd).toBe(cost);
    expect(row?.attempts[0]?.inputTokens).toBe(123);
    expect(row?.attempts[0]?.outputTokens).toBe(45);
    expect(row?.attempts[0]?.costCompleteness).toBe("KNOWN");
    expect(row?.attempts[0]?.costCurrency).toBe("USD");
    expect(row?.attempts[0]?.attemptIdentity).toBe(
      `${run.result.observability?.traceId}:attempt:1`,
    );
    expect(row?.totalCostUsd).toBe(cost);
    expect(row?.knownCostSubtotalUsd).toBe(cost);
    expect(row?.costCompleteness).toBe("COMPLETE");

    const aiUsage = await db.usageRecord.findMany({
      where: {
        businessId: fixture.businessId,
        kind: "AI_TURN",
      },
      select: { messageId: true },
    });
    expect(aiUsage).toHaveLength(1);
    expect(aiUsage[0]?.messageId).toBe(run.result.customerMessageId);

    const window = windowForNow();
    const reconciliation = await turnEvidenceRepository.reconcile({
      businessId: fixture.businessId,
      trafficPool: "TEST",
      ...window,
    });
    expect(reconciliation.scope.trafficPool).toBe("TEST");
    expect(reconciliation.evidence.logicalTurns).toBe(1);
    expect(reconciliation.evidence.physicalAttemptRecords).toBe(1);
    expect(reconciliation.evidence.confirmedHttpDispatches).toBe(1);
    expect(reconciliation.evidence.unknownDispatchAttempts).toBe(0);
    expect(reconciliation.evidence.executionEvidence.recorded).toBe(1);
    expect(reconciliation.usage.window.aiTurn).toBe(1);
    expect(reconciliation.usage.aiTurnLinks.linkedScoped).toBe(1);
    expect(reconciliation.usage.aiTurnLinks.missingMessageId).toBe(0);
    expect(reconciliation.evidence.cost.knownCostSubtotalUsd).toBe(cost);
    expect(reconciliation.evidence.cost.completeTurnTotalUsd).toBe(cost);
    expect(reconciliation.evidence.cost.scopedWindowTotalCostUsd).toBe(cost);
    expect(reconciliation.evidence.cost.scopedWindowCostStatus).toBe(
      "COMPLETE",
    );
    expect(reconciliation.evidence.cost.invoiceReconciliation).toBe(
      "NOT_PERFORMED",
    );
  });

  it("persists multiple fallback attempts with stable identities and the full total", async () => {
    const fixture = await createFixture("منشأة التبديل");
    const telemetry = buildTelemetry(
      [
        {
          provider: "openrouter",
          model: "model-1",
          status: "FAILURE",
          costUsd: 0.0004,
          errorCode: "TIMEOUT",
          httpStatus: 504,
        },
        {
          provider: "agentrouter",
          model: "model-2",
          status: "SUCCESS",
          costUsd: 0.0006,
        },
      ],
      {
        totalCostUsd: 0.001,
        knownCostSubtotalUsd: 0.001,
        costCompleteness: "COMPLETE",
      },
    );
    const run = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      telemetry,
    });

    const row = await findEvidence(
      fixture.businessId,
      run.result.customerMessageId,
    );
    expect(row?.attempts).toHaveLength(2);
    expect(row?.attempts.map((attempt) => attempt.provider)).toEqual([
      "openrouter",
      "agentrouter",
    ]);
    expect(row?.attempts.map((attempt) => attempt.status)).toEqual([
      "FAILURE",
      "SUCCESS",
    ]);
    expect(row?.attempts.map((attempt) => attempt.attemptIdentity)).toEqual([
      `${run.result.observability?.traceId}:attempt:1`,
      `${run.result.observability?.traceId}:attempt:2`,
    ]);
    expect(row?.totalCostUsd).toBe(0.001);
    expect(row?.costCompleteness).toBe("COMPLETE");
  });

  it("keeps known + unknown attempts PARTIAL and never states a complete total", async () => {
    const fixture = await createFixture("منشأة الجزئي");
    const telemetry = buildTelemetry(
      [
        {
          provider: "openrouter",
          model: "model-1",
          status: "FAILURE",
          costUsd: 0.0002,
        },
        {
          provider: "agentrouter",
          model: "model-2",
          status: "FAILURE",
        },
      ],
      {
        totalCostUsd: null,
        knownCostSubtotalUsd: 0.0002,
        costCompleteness: "PARTIAL",
      },
    );
    const run = await runTurn(fixture, {
      aiResponse: null,
      telemetry,
    });

    const row = await findEvidence(
      fixture.businessId,
      run.result.customerMessageId,
    );
    expect(row?.costCompleteness).toBe("PARTIAL");
    expect(row?.totalCostUsd).toBeNull();
    expect(row?.knownCostSubtotalUsd).toBe(0.0002);
    expect(row?.attempts[1]?.costUsd).toBeNull();
    expect(row?.attempts[1]?.costCompleteness).toBe("UNKNOWN");
  });

  it("keeps real zero distinct from unknown", async () => {
    const fixture = await createFixture("منشأة الصفر");
    const zeroRun = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      externalId: randomUUID(),
      telemetry: buildTelemetry(
        [
          {
            provider: "openrouter",
            model: "model-zero",
            status: "SUCCESS",
            costUsd: 0,
          },
        ],
        {
          totalCostUsd: 0,
          knownCostSubtotalUsd: 0,
          costCompleteness: "COMPLETE",
        },
      ),
    });
    const zero = await findEvidence(
      fixture.businessId,
      zeroRun.result.customerMessageId,
    );
    expect(zero?.totalCostUsd).toBe(0);
    expect(zero?.costCurrency).toBe("USD");
    expect(zero?.attempts[0]?.costCompleteness).toBe("KNOWN");
    expect(zero?.attempts[0]?.costUsd).toBe(0);

    const unknownRun = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      externalId: randomUUID(),
      phone: randomPhone("+2013"),
      telemetry: buildTelemetry(
        [
          {
            provider: "openrouter",
            model: "model-unknown",
            status: "FAILURE",
          },
        ],
        {
          totalCostUsd: null,
          knownCostSubtotalUsd: null,
          costCompleteness: "UNAVAILABLE",
        },
      ),
    });
    const unknown = await findEvidence(
      fixture.businessId,
      unknownRun.result.customerMessageId,
    );
    expect(unknown?.totalCostUsd).toBeNull();
    expect(unknown?.knownCostSubtotalUsd).toBeNull();
    expect(unknown?.costCurrency).toBeNull();
    expect(unknown?.attempts[0]?.costCompleteness).toBe("UNKNOWN");
    expect(unknown?.attempts[0]?.costUsd).toBeNull();
  });

  it("creates no paid attempt for deterministic and deferred no-call turns", async () => {
    const fixture = await createFixture("منشأة بلا استدعاء");

    const deterministic = await runTurn(fixture, {
      text: "السلام عليكم",
      aiResponse: null,
      requiredSemanticCapability: null,
      externalId: randomUUID(),
    });
    expect(deterministic.aiCalls).toBe(0);
    const deterministicRow = await findEvidence(
      fixture.businessId,
      deterministic.result.customerMessageId,
    );
    expect(deterministicRow?.attempts).toHaveLength(0);
    expect(deterministicRow?.executionEvidence).toBe("PROVEN_NO_CALL");
    expect(deterministicRow?.totalCostUsd).toBeNull();
    expect(deterministicRow?.knownCostSubtotalUsd).toBeNull();
    expect(deterministicRow?.costCompleteness).toBeNull();
    expect(
      await db.usageRecord.count({
        where: {
          businessId: fixture.businessId,
          kind: "AI_TURN",
          messageId: deterministic.result.customerMessageId,
        },
      }),
    ).toBe(0);

    const customerPhone = randomPhone("+2014");
    const customer = await db.customer.create({
      data: {
        businessId: fixture.businessId,
        name: "عميل محوّل",
        phone: customerPhone,
      },
    });
    const userId = randomUUID();
    createdUserIds.push(userId);
    await db.user.create({
      data: {
        id: userId,
        name: "موظف",
        email: `${userId}@flowpilot.invalid`,
        emailVerified: false,
        accountType: "BUSINESS",
        businessId: fixture.businessId,
        role: "STAFF",
        isActive: true,
      },
    });
    await db.conversation.create({
      data: {
        businessId: fixture.businessId,
        customerId: customer.id,
        branchId: fixture.branchId,
        assignedUserId: userId,
        status: "NEED_HUMAN",
      },
    });

    const deferred = await runTurn(fixture, {
      aiResponse: null,
      phone: customerPhone,
      externalId: randomUUID(),
    });
    expect(deferred.result.assistantAction).toBe("DEFERRED_TO_STAFF");
    expect(deferred.aiCalls).toBe(0);
    const deferredRow = await findEvidence(
      fixture.businessId,
      deferred.result.customerMessageId,
    );
    expect(deferredRow?.attempts).toHaveLength(0);
    expect(deferredRow?.executionEvidence).toBe("PROVEN_NO_CALL");
    expect(deferredRow?.totalCostUsd).toBeNull();
    expect(deferredRow?.costCompleteness).toBeNull();
  });

  it("does not duplicate accounting on replay and flags conflicting facts", async () => {
    const fixture = await createFixture("منشأة التكرار");
    const telemetry = buildTelemetry(
      [
        {
          provider: "openrouter",
          model: "model-1",
          status: "SUCCESS",
          costUsd: 0.0005,
        },
      ],
      {
        totalCostUsd: 0.0005,
        knownCostSubtotalUsd: 0.0005,
        costCompleteness: "COMPLETE",
      },
    );
    const run = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      telemetry,
    });

    const evidence = run.emitted[0];
    expect(evidence).toBeDefined();
    const dto = buildDurableTurnEvidence(evidence!, "TEST");
    const replay = await turnEvidenceRepository.record(dto);
    expect(replay.status).toBe("DUPLICATE");

    const original = await findEvidence(
      fixture.businessId,
      run.result.customerMessageId,
    );
    expect(original?.replayCount).toBe(1);
    expect(original?.attempts).toHaveLength(1);

    const conflicting = {
      ...dto,
      totalCostUsd: 0.0009,
      knownCostSubtotalUsd: 0.0009,
      attempts: dto.attempts.map((attempt) => ({
        ...attempt,
        costUsd: 0.0009,
      })),
    };
    const conflict = await turnEvidenceRepository.record(conflicting);
    expect(conflict.status).toBe("CONFLICT");

    const afterConflict = await findEvidence(
      fixture.businessId,
      run.result.customerMessageId,
    );
    expect(afterConflict?.totalCostUsd).toBe(0.0005);
    expect(afterConflict?.attempts[0]?.costUsd).toBe(0.0005);
    expect(afterConflict?.conflictCount).toBe(1);
    expect(afterConflict?.lastConflictAt).not.toBeNull();
    expect(
      await db.turnEvidenceRecord.count({
        where: { businessId: fixture.businessId },
      }),
    ).toBe(1);
  });

  it("isolates concurrent turns by authoritative identity and cost", async () => {
    const fixture = await createFixture("منشأة التوازي");
    const [first, second] = await Promise.all([
      runTurn(fixture, {
        aiResponse: SAFE_HANDOFF,
        externalId: randomUUID(),
        phone: randomPhone("+2015"),
        telemetry: buildTelemetry(
          [
            {
              provider: "openrouter",
              model: "model-a",
              status: "SUCCESS",
              costUsd: 0.00011,
              inputTokens: 11,
            },
          ],
          {
            totalCostUsd: 0.00011,
            knownCostSubtotalUsd: 0.00011,
            costCompleteness: "COMPLETE",
          },
        ),
      }),
      runTurn(fixture, {
        aiResponse: SAFE_HANDOFF,
        externalId: randomUUID(),
        phone: randomPhone("+2016"),
        telemetry: buildTelemetry(
          [
            {
              provider: "agentrouter",
              model: "model-b",
              status: "SUCCESS",
              costUsd: 0.00022,
              inputTokens: 22,
            },
          ],
          {
            totalCostUsd: 0.00022,
            knownCostSubtotalUsd: 0.00022,
            costCompleteness: "COMPLETE",
          },
        ),
      }),
    ]);

    const firstRow = await findEvidence(
      fixture.businessId,
      first.result.customerMessageId,
    );
    const secondRow = await findEvidence(
      fixture.businessId,
      second.result.customerMessageId,
    );
    expect(firstRow?.conversationId).toBe(first.result.conversationId);
    expect(secondRow?.conversationId).toBe(second.result.conversationId);
    expect(firstRow?.attempts[0]?.provider).toBe("openrouter");
    expect(firstRow?.attempts[0]?.inputTokens).toBe(11);
    expect(firstRow?.totalCostUsd).toBe(0.00011);
    expect(secondRow?.attempts[0]?.provider).toBe("agentrouter");
    expect(secondRow?.attempts[0]?.inputTokens).toBe(22);
    expect(secondRow?.totalCostUsd).toBe(0.00022);
  });

  it("rejects cross-tenant identity and keeps tenant reconciliation isolated", async () => {
    const fixtureA = await createFixture("منشأة أ");
    const fixtureB = await createFixture("منشأة ب");
    const telemetryB = buildTelemetry(
      [
        {
          provider: "openrouter",
          model: "model-b",
          status: "SUCCESS",
          costUsd: 0.0007,
        },
      ],
      {
        totalCostUsd: 0.0007,
        knownCostSubtotalUsd: 0.0007,
        costCompleteness: "COMPLETE",
      },
    );
    const runB = await runTurn(fixtureB, {
      aiResponse: SAFE_HANDOFF,
      telemetry: telemetryB,
    });
    const evidenceB = runB.emitted[0];
    expect(evidenceB).toBeDefined();
    const dtoB = buildDurableTurnEvidence(evidenceB!, "TEST");

    await expect(
      turnEvidenceRepository.record({
        ...dtoB,
        businessId: fixtureA.businessId,
      }),
    ).rejects.toThrow("TURN_EVIDENCE_IDENTITY_MISMATCH");
    await expect(
      turnEvidenceRepository.record({
        ...dtoB,
        conversationId: randomUUID(),
      }),
    ).rejects.toThrow("TURN_EVIDENCE_IDENTITY_MISMATCH");
    expect(
      await db.turnEvidenceRecord.count({
        where: {
          businessId: fixtureA.businessId,
          customerMessageId: runB.result.customerMessageId,
        },
      }),
    ).toBe(0);

    const window = windowForNow();
    const reconciliationA = await turnEvidenceRepository.reconcile({
      businessId: fixtureA.businessId,
      trafficPool: "TEST",
      ...window,
    });
    expect(reconciliationA.evidence.logicalTurns).toBe(0);
    expect(reconciliationA.evidence.cost.knownCostSubtotalUsd).toBeNull();

    const reconciliationB = await turnEvidenceRepository.reconcile({
      businessId: fixtureB.businessId,
      trafficPool: "TEST",
      ...window,
    });
    expect(reconciliationB.evidence.logicalTurns).toBe(1);
    expect(reconciliationB.evidence.cost.knownCostSubtotalUsd).toBe(0.0007);
  });

  it("preserves the customer outcome when durable storage fails", async () => {
    const fixture = await createFixture("منشأة فشل التخزين");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failingRepo: EvidenceRepo = {
      record: async () => {
        throw new Error("simulated storage outage with sensitive detail");
      },
    };
    const telemetry = buildTelemetry(
      [
        {
          provider: "openrouter",
          model: "model-1",
          status: "SUCCESS",
          costUsd: 0.0003,
        },
      ],
      {
        totalCostUsd: 0.0003,
        knownCostSubtotalUsd: 0.0003,
        costCompleteness: "COMPLETE",
      },
    );
    const run = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      telemetry,
      repo: failingRepo,
    });
    expect(run.aiCalls).toBe(1);
    expect(run.sends).toBe(1);
    expect(run.emitted).toHaveLength(1);
    expect(run.result.delivery?.delivered).toBe(true);
    expect(
      await db.turnEvidenceRecord.count({
        where: { businessId: fixture.businessId },
      }),
    ).toBe(0);
    const failureLogs = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("turn.evidence.durable.failed"));
    expect(failureLogs).toHaveLength(1);
    expect(failureLogs[0]).not.toContain("sensitive detail");
    warn.mockRestore();
  });

  it("round-trips high-precision and nullable cost semantics", async () => {
    const fixture = await createFixture("منشأة الدقة");
    const tiny = 1.23456789012345e-7;
    const run = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      telemetry: buildTelemetry(
        [
          {
            provider: "openrouter",
            model: "model-1",
            status: "SUCCESS",
            costUsd: tiny,
          },
        ],
        {
          totalCostUsd: tiny,
          knownCostSubtotalUsd: tiny,
          costCompleteness: "COMPLETE",
        },
      ),
    });
    const row = await findEvidence(
      fixture.businessId,
      run.result.customerMessageId,
    );
    expect(row?.totalCostUsd).toBe(tiny);
    expect(row?.knownCostSubtotalUsd).toBe(tiny);
    expect(row?.attempts[0]?.costUsd).toBe(tiny);
    expect(row?.attempts[0]?.costCurrency).toBe("USD");
  });

  it("strips non-allowlisted fields and rejects unbounded payloads", async () => {
    const fixture = await createFixture("منشأة التنقيح");
    const forbiddenText = "CUSTOMER-TEXT-MUST-NOT-PERSIST";
    const run = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      telemetry: buildTelemetry(
        [
          {
            provider: "openrouter",
            model: "model-1",
            status: "SUCCESS",
            costUsd: 0.0001,
          },
        ],
        {
          totalCostUsd: 0.0001,
          knownCostSubtotalUsd: 0.0001,
          costCompleteness: "COMPLETE",
        },
      ),
    });
    const evidence = run.emitted[0];
    expect(evidence).toBeDefined();
    const dto = buildDurableTurnEvidence(evidence!, "TEST");
    const withHostileExtras = {
      ...dto,
      messageText: forbiddenText,
      prompt: forbiddenText,
      rawProviderPayload: forbiddenText,
    };
    // The same stable identity was already recorded by the engine above, so
    // this replay is idempotent and the extras never reach a column.
    const result = await turnEvidenceRepository.record(withHostileExtras);
    expect(result.status).toBe("DUPLICATE");
    const row = await findEvidence(
      fixture.businessId,
      run.result.customerMessageId,
    );
    expect(JSON.stringify(row)).not.toContain(forbiddenText);

    await expect(
      turnEvidenceRepository.record({
        ...dto,
        customerMessageId: randomUUID(),
        attempts: Array.from({ length: 17 }, (_, index) => ({
          ...dto.attempts[0]!,
          attemptIndex: index + 1,
          attemptIdentity: `trace:${index + 1}`,
        })),
      }),
    ).rejects.toThrow();
  });

  it("represents missing execution telemetry as UNAVAILABLE, never as no-call", async () => {
    const fixture = await createFixture("منشأة بلا تليمتري");
    const run = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      telemetryPresent: false,
    });
    const row = await findEvidence(
      fixture.businessId,
      run.result.customerMessageId,
    );
    expect(row?.executionEvidence).toBe("UNAVAILABLE");
    expect(row?.attempts).toHaveLength(0);
    expect(row?.logicalAttemptCount).toBe(0);
    expect(row?.confirmedHttpDispatches).toBe(0);
    expect(row?.unknownDispatchAttemptCount).toBe(0);

    const window = windowForNow();
    const reconciliation = await turnEvidenceRepository.reconcile({
      businessId: fixture.businessId,
      trafficPool: "TEST",
      ...window,
    });
    expect(reconciliation.evidence.executionEvidence.unavailable).toBe(1);
    expect(reconciliation.evidence.cost.scopedWindowCostStatus).toBe(
      "UNAVAILABLE",
    );
    expect(reconciliation.evidence.cost.scopedWindowTotalCostUsd).toBeNull();
    expect(reconciliation.evidence.executionEvidence.provenNoCall).toBe(0);
  });

  it("keeps unknown HTTP dispatch separate from confirmed and prevented dispatch", async () => {
    const fixture = await createFixture("منشأة الإرسال");
    const unknownRun = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      externalId: randomUUID(),
      telemetry: buildTelemetry(
        [
          {
            provider: "openrouter",
            model: "model-unknown-http",
            status: "SUCCESS",
            httpAttempts: null,
            costUsd: 0.0005,
          },
        ],
        {
          totalCostUsd: 0.0005,
          knownCostSubtotalUsd: 0.0005,
          costCompleteness: "COMPLETE",
        },
      ),
    });
    const unknownRow = await findEvidence(
      fixture.businessId,
      unknownRun.result.customerMessageId,
    );
    expect(unknownRow?.executionEvidence).toBe("RECORDED");
    expect(unknownRow?.logicalAttemptCount).toBe(1);
    expect(unknownRow?.confirmedHttpDispatches).toBe(0);
    expect(unknownRow?.unknownDispatchAttemptCount).toBe(1);
    expect(unknownRow?.preventedAttemptCount).toBe(0);
    expect(unknownRow?.attempts[0]?.dispatchState).toBe("UNKNOWN");
    expect(unknownRow?.attempts[0]?.httpAttempts).toBeNull();
    expect(unknownRow?.attempts[0]?.costCompleteness).toBe("KNOWN");

    const preventedRun = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      externalId: randomUUID(),
      phone: randomPhone("+2017"),
      telemetry: buildTelemetry(
        [
          {
            provider: "openrouter",
            model: "model-prevented",
            status: "FAILURE",
            httpAttempts: 0,
          },
        ],
        {
          totalCostUsd: null,
          knownCostSubtotalUsd: null,
          costCompleteness: "UNAVAILABLE",
        },
      ),
    });
    const preventedRow = await findEvidence(
      fixture.businessId,
      preventedRun.result.customerMessageId,
    );
    expect(preventedRow?.executionEvidence).toBe("RECORDED");
    expect(preventedRow?.logicalAttemptCount).toBe(1);
    expect(preventedRow?.confirmedHttpDispatches).toBe(0);
    expect(preventedRow?.unknownDispatchAttemptCount).toBe(0);
    expect(preventedRow?.preventedAttemptCount).toBe(1);
    expect(preventedRow?.attempts[0]?.dispatchState).toBe("PREVENTED");
    expect(preventedRow?.attempts[0]?.httpAttempts).toBe(0);
    expect(preventedRow?.attempts[0]?.costUsd).toBe(0);
    expect(preventedRow?.attempts[0]?.costProvenance).toBe(
      "ZERO_DISPATCH_PREVENTED",
    );
  });

  it("keeps same-tenant TEST and SERVING evidence/cost metrics separate", async () => {
    const fixture = await createFixture("منشأة المزج");
    const testRun = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      externalId: randomUUID(),
      trafficPool: "TEST",
      telemetry: buildTelemetry(
        [
          {
            provider: "openrouter",
            model: "model-test",
            status: "SUCCESS",
            costUsd: 0.0001,
          },
        ],
        {
          totalCostUsd: 0.0001,
          knownCostSubtotalUsd: 0.0001,
          costCompleteness: "COMPLETE",
        },
      ),
    });
    const servingRun = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      externalId: randomUUID(),
      phone: randomPhone("+2018"),
      trafficPool: "SERVING",
      telemetry: buildTelemetry(
        [
          {
            provider: "agentrouter",
            model: "model-serving",
            status: "SUCCESS",
            costUsd: 0.0002,
          },
        ],
        {
          totalCostUsd: 0.0002,
          knownCostSubtotalUsd: 0.0002,
          costCompleteness: "COMPLETE",
        },
      ),
    });
    const window = windowForNow();
    const testReport = await turnEvidenceRepository.reconcile({
      businessId: fixture.businessId,
      trafficPool: "TEST",
      ...window,
    });
    const servingReport = await turnEvidenceRepository.reconcile({
      businessId: fixture.businessId,
      trafficPool: "SERVING",
      ...window,
    });
    expect(testReport.evidence.logicalTurns).toBe(1);
    expect(testReport.evidence.cost.knownCostSubtotalUsd).toBe(0.0001);
    expect(testReport.usage.aiTurnLinks.linkedScoped).toBe(1);
    expect(testReport.usage.aiTurnLinks.linkedOtherPool).toBe(1);
    expect(servingReport.evidence.logicalTurns).toBe(1);
    expect(servingReport.evidence.cost.knownCostSubtotalUsd).toBe(0.0002);
    expect(servingReport.usage.aiTurnLinks.linkedScoped).toBe(1);
    expect(servingReport.usage.aiTurnLinks.linkedOtherPool).toBe(1);
    expect(
      await findEvidence(
        fixture.businessId,
        servingRun.result.customerMessageId,
      ).then((row) => row?.trafficPool),
    ).toBe("SERVING");
    expect(
      await findEvidence(
        fixture.businessId,
        testRun.result.customerMessageId,
      ).then((row) => row?.trafficPool),
    ).toBe("TEST");
  });

  it("reports exact full-window aggregates and truthful bounded page/links", async () => {
    const fixture = await createFixture("منشأة النافذة");
    const normalRun = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      externalId: randomUUID(),
      telemetry: buildTelemetry(
        [
          {
            provider: "openrouter",
            model: "model-normal",
            status: "SUCCESS",
            costUsd: 0.0003,
          },
        ],
        {
          totalCostUsd: 0.0003,
          knownCostSubtotalUsd: 0.0003,
          costCompleteness: "COMPLETE",
        },
      ),
    });
    const noCallRun = await runTurn(fixture, {
      text: "السلام عليكم",
      aiResponse: null,
      requiredSemanticCapability: null,
      externalId: randomUUID(),
      phone: randomPhone("+2019"),
    });
    const missingUsageRun = await runTurn(fixture, {
      aiResponse: SAFE_HANDOFF,
      externalId: randomUUID(),
      phone: randomPhone("+2020"),
      telemetry: buildTelemetry(
        [
          {
            provider: "agentrouter",
            model: "model-missing-usage",
            status: "SUCCESS",
            costUsd: 0.0004,
          },
        ],
        {
          totalCostUsd: 0.0004,
          knownCostSubtotalUsd: 0.0004,
          costCompleteness: "COMPLETE",
        },
      ),
    });

    // Move the normal turn's usage outside the evidence window. The link is
    // still present in the database and must NOT be called missing.
    await db.usageRecord.updateMany({
      where: {
        businessId: fixture.businessId,
        kind: "AI_TURN",
        messageId: normalRun.result.customerMessageId,
      },
      data: { occurredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
    });
    // A genuinely missing usage row for an execution-recorded turn.
    await db.usageRecord.deleteMany({
      where: {
        businessId: fixture.businessId,
        kind: "AI_TURN",
        messageId: missingUsageRun.result.customerMessageId,
      },
    });
    // A usage row with no evidence at all.
    await db.usageRecord.create({
      data: {
        businessId: fixture.businessId,
        kind: "AI_TURN",
        conversationId: normalRun.result.conversationId,
        messageId: randomUUID(),
        provider: "openrouter",
        status: "SUCCESS",
        occurredAt: new Date(),
      },
    });
    // A historical usage row with no authoritative message id.
    await db.usageRecord.create({
      data: {
        businessId: fixture.businessId,
        kind: "AI_TURN",
        messageId: null,
        provider: "openrouter",
        status: "FAILURE",
        occurredAt: new Date(),
      },
    });

    // Keep all three evidence rows inside the window.
    const now = Date.now();
    const window = {
      from: new Date(now - 60 * 60 * 1000),
      to: new Date(now + 60 * 60 * 1000),
    };
    const report = await turnEvidenceRepository.reconcile({
      businessId: fixture.businessId,
      trafficPool: "TEST",
      ...window,
    });
    expect(report.evidence.logicalTurns).toBe(3);
    expect(report.evidence.executionEvidence.recorded).toBe(2);
    expect(report.evidence.executionEvidence.provenNoCall).toBe(1);
    expect(report.usage.window.aiTurn).toBe(2);
    expect(report.usage.aiTurnLinks.linkedScoped).toBe(0);
    expect(report.usage.aiTurnLinks.withoutEvidence).toBe(1);
    expect(report.usage.aiTurnLinks.missingMessageId).toBe(1);
    expect(report.usage.evidenceWithoutAiTurn.expectedNoCall).toBe(1);
    expect(report.usage.evidenceWithoutAiTurn.unresolved).toBe(1);
    expect(report.usage.unresolvedHistoricalIdentity).toBe(1);
    expect(report.usage.unresolvedMissingEvidence).toBe(1);
    expect(report.evidence.cost.scopedWindowCostStatus).toBe("PARTIAL");
    expect(report.evidence.cost.scopedWindowTotalCostUsd).toBeNull();

    const page = await turnEvidenceRepository.listByConversationWindow({
      businessId: fixture.businessId,
      trafficPool: "TEST",
      ...window,
      limit: 2,
    });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const fullPage = await turnEvidenceRepository.listByConversationWindow({
      businessId: fixture.businessId,
      trafficPool: "TEST",
      ...window,
      limit: 10,
    });
    expect(fullPage.items).toHaveLength(3);
    expect(fullPage.hasMore).toBe(false);
  });
});
