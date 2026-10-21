/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CapturedHttpAttempt } from "./harness";
import type { LiveOperatorLimits } from "./types";

export type CostModelConfig = {
  provider: string;
  model: string;
  pricingSource: string;
  inputPricePerMillionUsd: number;
  outputPricePerMillionUsd: number;
  conservativeInputTokenBoundPerRequest: number;
  outputTokenLimit: number;
};

export const DEEPSEEK_V3_OPENROUTER_COST_CONFIG: CostModelConfig = {
  provider: "openrouter",
  model: "deepseek/deepseek-chat",
  pricingSource:
    "OpenRouter official deepseek/deepseek-chat pricing (verified 2026-10)",
  inputPricePerMillionUsd: 0.14,
  outputPricePerMillionUsd: 0.28,
  conservativeInputTokenBoundPerRequest: 5000,
  outputTokenLimit: 500,
};

export function calculateConservativeCostCeiling(
  maxAttempts: number,
  costConfig: CostModelConfig = DEEPSEEK_V3_OPENROUTER_COST_CONFIG,
): {
  maxCostPerAttemptUsd: number;
  totalCostCeilingUsd: number;
  explanation: string;
} {
  const maxInputCostPerCall =
    (costConfig.conservativeInputTokenBoundPerRequest *
      costConfig.inputPricePerMillionUsd) /
    1_000_000;
  const maxOutputCostPerCall =
    (costConfig.outputTokenLimit * costConfig.outputPricePerMillionUsd) /
    1_000_000;
  const maxCostPerAttemptUsd = maxInputCostPerCall + maxOutputCostPerCall;
  const totalCostCeilingUsd = maxAttempts * maxCostPerAttemptUsd;

  const explanation =
    `${maxAttempts} max attempts * (${costConfig.conservativeInputTokenBoundPerRequest} in @ $${costConfig.inputPricePerMillionUsd}/M + ` +
    `${costConfig.outputTokenLimit} out @ $${costConfig.outputPricePerMillionUsd}/M) = ` +
    `$${maxCostPerAttemptUsd.toFixed(6)}/call -> $${totalCostCeilingUsd.toFixed(4)} USD conservative ceiling`;

  return {
    maxCostPerAttemptUsd,
    totalCostCeilingUsd,
    explanation,
  };
}

export type PreflightAuditResult = {
  status: "BLOCKED" | "READY_FOR_OPERATOR_APPROVAL";
  reasons: string[];
  resolvedConfig: {
    provider: string;
    model: string;
    pricingSource: string;
    targetScenarios: string[];
    maxPhysicalHttpAttempts: number;
    outputTokenLimit: number;
    timeoutMs: number;
    conservativeInputBoundTokens: number;
    conservativeCostCeilingUsd: number;
    approvedBudgetUsd: number;
    costBasis: string;
    providerSideHardLimitSupport: string;
  };
};

export function auditPreflightLimits(
  limits: Partial<LiveOperatorLimits> | undefined,
  targetScenarioIds: string[],
  costConfig: CostModelConfig = DEEPSEEK_V3_OPENROUTER_COST_CONFIG,
  allowLivePaidExecution = false,
): PreflightAuditResult {
  const reasons: string[] = [];

  if (!limits) {
    return {
      status: "BLOCKED",
      reasons: ["Operator limits object is undefined or null."],
      resolvedConfig: {
        provider: costConfig.provider,
        model: costConfig.model,
        pricingSource: costConfig.pricingSource,
        targetScenarios: targetScenarioIds,
        maxPhysicalHttpAttempts: 0,
        outputTokenLimit: costConfig.outputTokenLimit,
        timeoutMs: 0,
        conservativeInputBoundTokens:
          costConfig.conservativeInputTokenBoundPerRequest,
        conservativeCostCeilingUsd: 0,
        approvedBudgetUsd: 0,
        costBasis: "Unspecified",
        providerSideHardLimitSupport: "UNSUPPORTED_BY_PROVIDER_API",
      },
    };
  }

  // 1. Strict integer parsing for attempts
  if (
    typeof limits.maxPhysicalHttpAttempts !== "number" ||
    !Number.isInteger(limits.maxPhysicalHttpAttempts) ||
    limits.maxPhysicalHttpAttempts <= 0
  ) {
    reasons.push(
      "maxPhysicalHttpAttempts must be a strict positive integer greater than zero.",
    );
  }

  // 2. Strict integer parsing for output tokens
  if (
    typeof limits.outputTokenLimit !== "number" ||
    !Number.isInteger(limits.outputTokenLimit) ||
    limits.outputTokenLimit <= 0
  ) {
    reasons.push(
      "outputTokenLimit must be a strict positive integer greater than zero.",
    );
  }

  // 3. Strict integer parsing for timeout
  if (
    typeof limits.timeoutMs !== "number" ||
    !Number.isInteger(limits.timeoutMs) ||
    limits.timeoutMs <= 0
  ) {
    reasons.push(
      "timeoutMs must be a strict positive integer greater than zero.",
    );
  }

  // 4. Budget number check
  if (
    typeof limits.approvedBudgetUsd !== "number" ||
    !Number.isFinite(limits.approvedBudgetUsd) ||
    limits.approvedBudgetUsd <= 0
  ) {
    reasons.push(
      "approvedBudgetUsd must be a positive number greater than zero.",
    );
  }

  // 5. Budget basis explanation
  if (
    typeof limits.budgetBasis !== "string" ||
    limits.budgetBasis.trim().length === 0
  ) {
    reasons.push(
      "budgetBasis must be an explicit explanation of the cost estimation formula.",
    );
  }

  // 6. Scenario subset
  if (
    !Array.isArray(limits.scenarioSubset) ||
    limits.scenarioSubset.length === 0
  ) {
    reasons.push("scenarioSubset must be a non-empty array of scenario IDs.");
  }

  const maxAttempts =
    Number.isInteger(limits.maxPhysicalHttpAttempts) &&
    (limits.maxPhysicalHttpAttempts ?? 0) > 0
      ? (limits.maxPhysicalHttpAttempts as number)
      : 0;

  const costCalc = calculateConservativeCostCeiling(maxAttempts, {
    ...costConfig,
    outputTokenLimit:
      Number.isInteger(limits.outputTokenLimit) &&
      (limits.outputTokenLimit ?? 0) > 0
        ? (limits.outputTokenLimit as number)
        : costConfig.outputTokenLimit,
  });

  if (
    typeof limits.approvedBudgetUsd === "number" &&
    limits.approvedBudgetUsd > 0 &&
    limits.approvedBudgetUsd < costCalc.totalCostCeilingUsd
  ) {
    reasons.push(
      `approvedBudgetUsd ($${limits.approvedBudgetUsd.toFixed(4)}) is less than conservative cost ceiling ($${costCalc.totalCostCeilingUsd.toFixed(4)}). Increase budget or reduce maxPhysicalHttpAttempts.`,
    );
  }

  // Honest monetary enforcement notice:
  // OpenRouter does NOT support per-request dollar webhooks/limits.
  if (!allowLivePaidExecution) {
    reasons.push(
      "Live paid provider execution is BLOCKED in this evaluation-readiness slice (CORE-03C1). " +
        "OpenRouter does not support per-request real-time monetary spending webhooks; client-side attempt ceiling ($" +
        `${costCalc.totalCostCeilingUsd.toFixed(4)} USD bound) requires operator approval before network activation.`,
    );
  }

  const status =
    reasons.length === 0 ? "READY_FOR_OPERATOR_APPROVAL" : "BLOCKED";

  return {
    status,
    reasons,
    resolvedConfig: {
      provider: costConfig.provider,
      model: costConfig.model,
      pricingSource: costConfig.pricingSource,
      targetScenarios: limits.scenarioSubset ?? targetScenarioIds,
      maxPhysicalHttpAttempts: maxAttempts,
      outputTokenLimit: limits.outputTokenLimit ?? costConfig.outputTokenLimit,
      timeoutMs: limits.timeoutMs ?? 15000,
      conservativeInputBoundTokens:
        costConfig.conservativeInputTokenBoundPerRequest,
      conservativeCostCeilingUsd: costCalc.totalCostCeilingUsd,
      approvedBudgetUsd: limits.approvedBudgetUsd ?? 0,
      costBasis: limits.budgetBasis ?? costCalc.explanation,
      providerSideHardLimitSupport:
        "UNSUPPORTED_BY_PROVIDER_API (Spending is bounded by client-side physical attempt ceiling and max_tokens parameter, not a provider-side dollar webhook)",
    },
  };
}

export class CurrentEngineExecutionSession {
  private totalAttempts = 0;
  private allAttempts: CapturedHttpAttempt[] = [];
  public readonly isLive: boolean;
  public readonly operatorLimits?: LiveOperatorLimits;
  public readonly costConfig: CostModelConfig;
  public readonly liveFetchImpl?: typeof fetch;
  public readonly configuredProvider: string;
  public readonly configuredModel: string;

  constructor(
    options: {
      live?: boolean;
      operatorLimits?: LiveOperatorLimits;
      costConfig?: CostModelConfig;
      liveFetchImpl?: typeof fetch;
      primaryProvider?: string;
      primaryModel?: string;
      allowLivePaidCalls?: boolean;
    } = {},
  ) {
    this.isLive = Boolean(options.live);
    this.operatorLimits = options.operatorLimits;
    this.costConfig = options.costConfig ?? DEEPSEEK_V3_OPENROUTER_COST_CONFIG;
    this.liveFetchImpl = options.liveFetchImpl;
    this.configuredProvider =
      options.primaryProvider ?? this.costConfig.provider;
    this.configuredModel = options.primaryModel ?? this.costConfig.model;

    if (this.isLive) {
      const audit = auditPreflightLimits(
        this.operatorLimits,
        this.operatorLimits?.scenarioSubset ?? [],
        this.costConfig,
        Boolean(options.allowLivePaidCalls || this.liveFetchImpl),
      );
      if (audit.status === "BLOCKED") {
        throw new Error(
          `[LIVE PREFLIGHT BLOCKED] Cannot initialize live session:\n${audit.reasons.map((r) => `  - ${r}`).join("\n")}`,
        );
      }
    }
  }

  public get attemptCount(): number {
    return this.totalAttempts;
  }

  public get capturedAttempts(): ReadonlyArray<CapturedHttpAttempt> {
    return this.allAttempts;
  }

  public get maxAttempts(): number {
    return this.operatorLimits?.maxPhysicalHttpAttempts ?? 100;
  }

  public get outputTokenLimit(): number {
    return (
      this.operatorLimits?.outputTokenLimit ?? this.costConfig.outputTokenLimit
    );
  }

  public get timeoutMs(): number {
    return this.operatorLimits?.timeoutMs ?? 15000;
  }

  /**
   * Creates an instrumented fetch boundary tied to this shared run session.
   * Enforces whole-run attempt ceiling before dispatch, counts every attempt (including failures/retries),
   * and records attempt records in a finally-safe manner.
   */
  public createInstrumentedFetch(options: {
    mockResponses?: Record<
      number,
      { body: unknown; status?: number; usage?: any }
    >;
    getTurnIndex: () => number;
  }): typeof fetch {
    const { mockResponses = {}, getTurnIndex } = options;

    return async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      // 1. Check whole-run ceiling before dispatch
      if (this.totalAttempts >= this.maxAttempts) {
        throw new Error(
          `[RUN_LIMIT_EXCEEDED] Whole-run physical HTTP attempt ceiling reached (${this.maxAttempts} attempts). Next request blocked.`,
        );
      }

      // 2. Count attempt before dispatch
      this.totalAttempts += 1;
      const attemptIndex = this.totalAttempts;

      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? "POST";
      const startTime = Date.now();
      const sanitizedReqHeaders: Record<string, string> = {};

      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            sanitizedReqHeaders[k] =
              k.toLowerCase() === "authorization" ? "Bearer [REDACTED]" : v;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) {
            sanitizedReqHeaders[k] =
              k.toLowerCase() === "authorization" ? "Bearer [REDACTED]" : v;
          }
        } else {
          for (const [k, v] of Object.entries(
            init.headers as Record<string, string>,
          )) {
            sanitizedReqHeaders[k] =
              k.toLowerCase() === "authorization" ? "Bearer [REDACTED]" : v;
          }
        }
      }

      let capturedStatus = 0;
      let capturedError: string | null = null;
      let responseBodyPreview = "";
      let tokenUsage: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      } | null = null;

      try {
        if (this.isLive && this.liveFetchImpl) {
          // Live code path using injected upstream fetch
          const resp = await this.liveFetchImpl(input, init);
          capturedStatus = resp.status;
          const cloned = resp.clone();
          try {
            const json = await cloned.json();
            responseBodyPreview = JSON.stringify(json).slice(0, 250);
            if (json?.usage) {
              tokenUsage = {
                promptTokens: json.usage.prompt_tokens,
                completionTokens: json.usage.completion_tokens,
                totalTokens: json.usage.total_tokens,
              };
            }
          } catch {
            responseBodyPreview = `[Non-JSON or unreadable stream, status=${resp.status}]`;
          }
          return resp;
        }

        if (this.isLive && !this.liveFetchImpl) {
          // Paid live calls without injected fetch are strictly blocked in CORE-03C1
          throw new Error(
            "[LIVE EXECUTION BLOCKED] Live paid provider execution is blocked in this slice. Pass a test injected liveFetchImpl.",
          );
        }

        // Offline fixture transport
        const currentTurn = getTurnIndex();
        const mockResp = mockResponses[currentTurn];
        const status = mockResp?.status ?? 200;
        capturedStatus = status;

        let responsePayload: any;
        if (mockResp) {
          const usage = mockResp.usage === null ? undefined : mockResp.usage;
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
            model: this.configuredModel,
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
          // Default fallback mock response without fabricating fake usage
          responsePayload = {
            id: `chatcmpl-mock-${attemptIndex}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: this.configuredModel,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    intent: "BOOKING",
                    action: "reply",
                    content: "مرحباً بك! كيف يمكنني مساعدتك؟",
                    extraction: {},
                    factUpdates: [],
                  }),
                },
                finish_reason: "stop",
              },
            ],
          };
        }

        responseBodyPreview = JSON.stringify(responsePayload).slice(0, 250);

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
      } catch (err: any) {
        capturedError = err?.message ?? String(err);
        throw err;
      } finally {
        const durationMs = Date.now() - startTime;
        const attemptRecord: CapturedHttpAttempt = {
          index: attemptIndex,
          url,
          method,
          status: capturedStatus,
          durationMs,
          timestamp: new Date().toISOString(),
          sanitizedHeaders: sanitizedReqHeaders,
          responseBodyPreview,
          tokenUsage,
          error: capturedError,
        };
        this.allAttempts.push(attemptRecord);
      }
    };
  }
}
