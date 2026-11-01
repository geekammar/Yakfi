/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot — Verification of Provider-Failure Lexical Authority Removal.
 *
 * Verifies:
 * 1. Provider retry decisions are based strictly on technical failure classification
 *    and bounded retry policy, not customer-message wording.
 * 2. When no validated semantic decision exists, system does not assert that customer
 *    explicitly requested a human.
 * 3. Neutral, safe failure acknowledgments are used on all provider/AI failures.
 * 4. Terminal NEED_HUMAN transition is preserved across all failure classes.
 * 5. Technical retry limits (max 2 attempts) and budgets are strictly preserved.
 * 6. Same technical failure + different customer wording = same retry & failure policy.
 * 7. Normal structured semantic routing is preserved when model succeeds.
 * 8. Real Engine execution via receiveInboundMessage & createPlaygroundHarness.
 *
 * Run: pnpm check:provider-failure-lexical-authority
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createPlaygroundHarness } from "@/features/conversations/playground/harness";
import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import {
  SAFE_HANDOFF_REPLIES,
  resolveSafeFailureReply,
} from "@/features/conversations/server/conversation-ai";
import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import {
  HANDOFF_MESSAGES,
  createConversationControl,
} from "@/server/integrations/ai/conversation-control";
import type {
  AiCallOptions,
  AiProviderAdapter,
  AiProviderErrorCode,
  AiProviderResult,
} from "@/server/integrations/ai/types";

let failureCount = 0;
const checks: { label: string; pass: boolean }[] = [];

function check(label: string, condition: boolean): void {
  checks.push({ label, pass: condition });
  if (condition) {
    console.log(`✔ ${label}`);
  } else {
    console.error(`✘ ${label}`);
    failureCount += 1;
  }
}

// ── Test fixtures ────────────────────────────────────────────────────────────

const VALID_REPLY: AiResponse = {
  intent: "FAQ",
  action: "reply",
  content: "ساعات العمل من 9 صباحاً حتى 6 مساءً.",
  extraction: {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  },
  handoffReason: null,
  summary: null,
  safetyAssessment: "safe",
};

const SEMANTIC_HUMAN_REPLY: AiResponse = {
  intent: "HUMAN_REQUEST",
  action: "handoff",
  content: "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق.",
  extraction: {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  },
  handoffReason: "HUMAN_REQUEST",
  summary: null,
  safetyAssessment: "safe",
};

const baseRequest: AiRequest = {
  message: "ما هي ساعات العمل؟",
  conversationStatus: "AI_ACTIVE",
  recentMessages: [],
  businessName: "عيادة د. نور",
  services: [],
  faqs: [{ question: "ما هي ساعات العمل؟", answer: "من 9 حتى 6" }],
};

const humanWordingRequest: AiRequest = {
  ...baseRequest,
  message: "أريد التحدث إلى موظف من فضلك",
};

const bookingWordingRequest: AiRequest = {
  ...baseRequest,
  message: "عاوز احجز كشف أسنان بكرة",
};

type Step =
  | { kind: "success"; response: AiResponse }
  | { kind: "failure"; code: AiProviderErrorCode; httpStatus?: number };

function controlWith(steps: Step[]) {
  let callCount = 0;
  const adapter: AiProviderAdapter = {
    providerId: "openrouter",
    model: "mock-model",
    secretRef: "OPENROUTER_API_KEY",
    async call(
      _req: AiRequest,
      _opt?: AiCallOptions,
    ): Promise<AiProviderResult> {
      const idx = Math.min(callCount, steps.length - 1);
      callCount += 1;
      const step = steps[idx];
      if (!step || step.kind === "failure") {
        return {
          ok: false,
          provider: "openrouter",
          model: "mock-model",
          latencyMs: 10,
          error: {
            code: step?.code ?? "CONTROLLED_FAILURE",
            message: "mock failure",
            retryable: step?.code === "TIMEOUT" || step?.code === "RETRYABLE",
            ...(step?.httpStatus !== undefined
              ? { httpStatus: step.httpStatus }
              : {}),
          },
        };
      }
      return {
        ok: true,
        provider: "openrouter",
        model: "mock-model",
        latencyMs: 10,
        response: step.response,
      };
    },
  };

  const control = createConversationControl({
    provider: adapter,
    settings: {
      conversationControl: {
        enabled: true,
        retryEnabled: true,
        maxAttempts: 2,
        handoffOnRetryExhausted: true,
        handoffOnProviderUnavailable: true,
        handoffOnAiRequested: true,
        handoffOnCustomerRequest: true,
      },
      notifications: {
        handoff: true,
        aiUnavailable: true,
        retryExhausted: true,
        configurationFailure: true,
        quotaFailure: true,
      },
    },
  });

  return { control, calls: () => callCount };
}

async function main(): Promise<void> {
  console.log("=== Provider-Failure Lexical Authority Verification ===\n");

  // ── Area 1: Static Code Integrity (Zero Lexical Authority in Control Layer) ──
  console.log("Area 1: Static Code Integrity");
  const ccPath = path.join(
    process.cwd(),
    "src/server/integrations/ai/conversation-control/conversation-control.ts",
  );
  const ccSource = await fs.readFile(ccPath, "utf8");
  check(
    "1.1 conversation-control does NOT import classifyCustomerMessage",
    !ccSource.includes("classifyCustomerMessage"),
  );
  check(
    "1.2 failure branch in executeTurn never overrides handoffReason with CUSTOMER_REQUESTED_HUMAN",
    !ccSource.includes('handoffReason = "CUSTOMER_REQUESTED_HUMAN";\n    }'),
  );

  // ── Area 2: Technical Failure Classification & Bounded Retries ─────────────
  console.log("\nArea 2: Technical Failure Classification & Bounded Retries");

  // 2a. Provider Timeout retried and succeeds on attempt 2 (regardless of customer wording)
  {
    const fixture = controlWith([
      { kind: "failure", code: "TIMEOUT" },
      { kind: "success", response: VALID_REPLY },
    ]);
    const outcome = await fixture.control.executeTurn(humanWordingRequest);
    check(
      "2a. TIMEOUT under human wording is retried and succeeds on attempt 2",
      outcome.result.ok === true &&
        fixture.calls() === 2 &&
        outcome.retryTrace.retryAttempted === true &&
        outcome.handoffReason === null,
    );
  }

  // 2b. Terminal Timeout Exhaustion maps to RETRY_EXHAUSTED (never CUSTOMER_REQUESTED_HUMAN)
  {
    const fixture = controlWith([
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
    ]);
    const outcome = await fixture.control.executeTurn(humanWordingRequest);
    check(
      "2b. Terminal TIMEOUT exhaustion under human wording yields RETRY_EXHAUSTED",
      !outcome.result.ok &&
        fixture.calls() === 2 &&
        outcome.retryTrace.retrySkippedReason === "MAX_ATTEMPTS_REACHED" &&
        outcome.handoffReason === "RETRY_EXHAUSTED" &&
        outcome.handoffMessage === HANDOFF_MESSAGES.RETRY_EXHAUSTED,
    );
  }

  // 2c. HTTP 5xx non-retryable failure maps to PROVIDER_UNAVAILABLE
  {
    const fixture = controlWith([
      { kind: "failure", code: "RETRYABLE", httpStatus: 503 },
    ]);
    const outcome = await fixture.control.executeTurn(humanWordingRequest);
    check(
      "2c. HTTP 503 under human wording yields PROVIDER_UNAVAILABLE (1 call)",
      !outcome.result.ok &&
        fixture.calls() === 1 &&
        outcome.handoffReason === "PROVIDER_UNAVAILABLE" &&
        outcome.handoffMessage === HANDOFF_MESSAGES.PROVIDER_UNAVAILABLE,
    );
  }

  // 2d. Non-retryable technical failure (CONFIG_ERROR) maps to AUTH_OR_CONFIGURATION_FAILURE
  {
    const fixture = controlWith([{ kind: "failure", code: "CONFIG_ERROR" }]);
    const outcome = await fixture.control.executeTurn(humanWordingRequest);
    check(
      "2d. CONFIG_ERROR under human wording yields AUTH_OR_CONFIGURATION_FAILURE (1 call)",
      !outcome.result.ok &&
        fixture.calls() === 1 &&
        outcome.handoffReason === "AUTH_OR_CONFIGURATION_FAILURE" &&
        outcome.handoffMessage ===
          HANDOFF_MESSAGES.AUTH_OR_CONFIGURATION_FAILURE,
    );
  }

  // 2e. Malformed response (INVALID_RESPONSE) maps to UNSUPPORTED_REQUEST
  {
    const fixture = controlWith([
      { kind: "failure", code: "INVALID_RESPONSE" },
    ]);
    const outcome = await fixture.control.executeTurn(humanWordingRequest);
    check(
      "2e. INVALID_RESPONSE under human wording yields UNSUPPORTED_REQUEST (1 call)",
      !outcome.result.ok &&
        fixture.calls() === 1 &&
        outcome.handoffReason === "UNSUPPORTED_REQUEST" &&
        outcome.handoffMessage === HANDOFF_MESSAGES.UNSUPPORTED_REQUEST,
    );
  }

  // ── Area 3: Same Technical Failure + Different Customer Wording = Same Policy
  console.log(
    "\nArea 3: Invariance Across Customer Wording (Same Failure = Same Policy)",
  );
  {
    // Run identical TIMEOUT exhaustion across 3 distinct customer wordings
    const fHuman = controlWith([
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
    ]);
    const fGeneral = controlWith([
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
    ]);
    const fBooking = controlWith([
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
    ]);

    const outHuman = await fHuman.control.executeTurn(humanWordingRequest);
    const outGeneral = await fGeneral.control.executeTurn(baseRequest);
    const outBooking = await fBooking.control.executeTurn(
      bookingWordingRequest,
    );

    check(
      "3.1 TIMEOUT exhaustion: identical attempt counts across distinct wordings",
      fHuman.calls() === 2 && fGeneral.calls() === 2 && fBooking.calls() === 2,
    );
    check(
      "3.2 TIMEOUT exhaustion: identical retrySkippedReason across distinct wordings",
      outHuman.retryTrace.retrySkippedReason === "MAX_ATTEMPTS_REACHED" &&
        outGeneral.retryTrace.retrySkippedReason === "MAX_ATTEMPTS_REACHED" &&
        outBooking.retryTrace.retrySkippedReason === "MAX_ATTEMPTS_REACHED",
    );
    check(
      "3.3 TIMEOUT exhaustion: identical handoffReason across distinct wordings",
      outHuman.handoffReason === "RETRY_EXHAUSTED" &&
        outGeneral.handoffReason === "RETRY_EXHAUSTED" &&
        outBooking.handoffReason === "RETRY_EXHAUSTED",
    );
    check(
      "3.4 TIMEOUT exhaustion: identical neutral handoffMessage across distinct wordings",
      outHuman.handoffMessage === outGeneral.handoffMessage &&
        outGeneral.handoffMessage === outBooking.handoffMessage &&
        outHuman.handoffMessage === HANDOFF_MESSAGES.RETRY_EXHAUSTED,
    );
  }

  // ── Area 4: Preserved Structured Semantic Routing on Model Success ──────────
  console.log(
    "\nArea 4: Preserved Normal Structured Semantic Routing on Success",
  );
  {
    const fixture = controlWith([
      { kind: "success", response: SEMANTIC_HUMAN_REPLY },
    ]);
    const outcome = await fixture.control.executeTurn(humanWordingRequest);
    check(
      "4.1 Valid model HUMAN_REQUEST handoff preserves CUSTOMER_REQUESTED_HUMAN decision",
      outcome.result.ok === true &&
        fixture.calls() === 1 &&
        outcome.handoffReason === "CUSTOMER_REQUESTED_HUMAN" &&
        outcome.notifications.length === 1 &&
        outcome.notifications[0]?.event === "HUMAN_HANDOFF_REQUESTED",
    );
  }

  // ── Area 5: Real Engine Inbound Message Execution & Neutral Handoff ─────────
  console.log("\nArea 5: Real Engine Inbound Message Execution");

  // 5a. Engine Provider Timeout Terminal Failure
  {
    const harness = createPlaygroundHarness({ channel: "WHATSAPP" });
    const control = controlWith([
      { kind: "failure", code: "TIMEOUT" },
      { kind: "failure", code: "TIMEOUT" },
    ]).control;

    harness.deps.ai = {
      providerName: "openrouter",
      respond: async (req: any) => {
        const result = await control.call(req);
        (harness.deps.ai as any)._lastTelemetry = {
          finalProvider: result.provider,
          finalModel: result.model,
          attempts: result.retryTrace?.attempts ?? [],
          retryTrace: result.retryTrace,
          conversationControl: (result as any).conversationControl,
        };
        if (!result.ok) return null;
        return result.response;
      },
      getLastTelemetry: () => (harness.deps.ai as any)._lastTelemetry,
    } as any;

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: "+201011112222",
      text: "أريد التحدث إلى موظف من فضلك",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-engine-timeout",
    });

    check("5a.1 Engine completes turn on timeout", res.ok === true);
    check(
      "5a.2 Engine status transitions to NEED_HUMAN",
      (res as any).conversationStatus === "NEED_HUMAN",
    );
    check(
      "5a.3 Engine handoffCause is RETRY_EXHAUSTED (not CUSTOMER_REQUESTED_HUMAN)",
      (res as any).handoffCause === "RETRY_EXHAUSTED",
    );
    const sent = harness.messages.filter((m) => m.senderType === "ASSISTANT");
    check(
      "5a.4 Assistant reply is neutral SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE",
      sent.length === 1 &&
        sent[0]?.content === SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE,
    );
    check(
      "5a.5 Reply never asserts customer human request",
      !sent[0]?.content.includes("تحت أمرك — جارٍ تحويلك"),
    );
  }

  // 5b. Engine Provider HTTP 503 Failure
  {
    const harness = createPlaygroundHarness({ channel: "WHATSAPP" });
    const control = controlWith([
      { kind: "failure", code: "RETRYABLE", httpStatus: 503 },
    ]).control;

    harness.deps.ai = {
      providerName: "openrouter",
      respond: async (req: any) => {
        const result = await control.call(req);
        (harness.deps.ai as any)._lastTelemetry = {
          finalProvider: result.provider,
          finalModel: result.model,
          attempts: result.retryTrace?.attempts ?? [],
          retryTrace: result.retryTrace,
          conversationControl: (result as any).conversationControl,
        };
        if (!result.ok) return null;
        return result.response;
      },
      getLastTelemetry: () => (harness.deps.ai as any)._lastTelemetry,
    } as any;

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: "+201011112222",
      text: "عايز موظف مسؤول حالا",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-engine-503",
    });

    check("5b.1 Engine completes turn on HTTP 503", res.ok === true);
    check(
      "5b.2 Engine status is NEED_HUMAN",
      (res as any).conversationStatus === "NEED_HUMAN",
    );
    check(
      "5b.3 Engine handoffCause is PROVIDER_FAILURE",
      (res as any).handoffCause === "PROVIDER_FAILURE",
    );
    const sent = harness.messages.filter((m) => m.senderType === "ASSISTANT");
    check(
      "5b.4 Assistant reply is neutral PROVIDER_FAILURE acknowledgment",
      sent.length === 1 &&
        sent[0]?.content === SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE,
    );
  }

  // 5c. Engine Missing safetyAssessment (Schema / Validation Failure)
  {
    const harness = createPlaygroundHarness({ channel: "WHATSAPP" });
    // Valid reply JSON but missing required safetyAssessment
    const malformedReply: any = {
      intent: "FAQ",
      action: "reply",
      content: "مرحبا بك",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
      // safetyAssessment missing!
    };

    harness.deps.ai = {
      providerName: "openrouter",
      respond: async () => malformedReply,
      getLastTelemetry: () => ({
        finalProvider: "openrouter",
        finalModel: "mock-model",
        attempts: [],
      }),
    } as any;

    const res = await receiveInboundMessage(harness.deps, {
      to: harness.business.whatsappNumber ?? "+201001111111",
      from: "+201011112222",
      text: "عايز موظف ضروري",
      receivedAt: new Date().toISOString(),
      externalId: "ext-msg-engine-schema",
    });

    check("5c.1 Missing safetyAssessment completes turn", res.ok === true);
    check(
      "5c.2 Status transitions to NEED_HUMAN",
      (res as any).conversationStatus === "NEED_HUMAN",
    );
    check(
      "5c.3 Handoff cause is AI_FAILURE (never CUSTOMER_REQUESTED_HUMAN)",
      (res as any).handoffCause === "AI_FAILURE",
    );
    const sent = harness.messages.filter((m) => m.senderType === "ASSISTANT");
    check(
      "5c.4 Assistant reply is neutral SAFE_HANDOFF_REPLIES.INVALID_OUTPUT",
      sent.length === 1 &&
        sent[0]?.content === SAFE_HANDOFF_REPLIES.INVALID_OUTPUT,
    );
  }

  // 5d. Engine Invariance: Compare human wording vs inquiry wording under timeout
  {
    const harnessA = createPlaygroundHarness({ channel: "WHATSAPP" });
    const harnessB = createPlaygroundHarness({ channel: "WHATSAPP" });

    const setupFail = (harness: any) => {
      const c = controlWith([
        { kind: "failure", code: "TIMEOUT" },
        { kind: "failure", code: "TIMEOUT" },
      ]).control;
      harness.deps.ai = {
        providerName: "openrouter",
        respond: async (req: any) => {
          const result = await c.call(req);
          (harness.deps.ai as any)._lastTelemetry = {
            finalProvider: result.provider,
            finalModel: result.model,
            attempts: result.retryTrace?.attempts ?? [],
            retryTrace: result.retryTrace,
            conversationControl: (result as any).conversationControl,
          };
          if (!result.ok) return null;
          return result.response;
        },
        getLastTelemetry: () => (harness.deps.ai as any)._lastTelemetry,
      } as any;
    };

    setupFail(harnessA);
    setupFail(harnessB);

    const resA = await receiveInboundMessage(harnessA.deps, {
      to: harnessA.business.whatsappNumber ?? "+201001111111",
      from: "+201011112222",
      text: "أريد التحدث إلى موظف من فضلك",
      receivedAt: new Date().toISOString(),
      externalId: "ext-inv-a",
    });

    const resB = await receiveInboundMessage(harnessB.deps, {
      to: harnessB.business.whatsappNumber ?? "+201001111111",
      from: "+201011113333",
      text: "ما هي مواعيد العمل لديكم؟",
      receivedAt: new Date().toISOString(),
      externalId: "ext-inv-b",
    });

    check(
      "5d.1 Engine handoffCause identical across wordings",
      (resA as any).handoffCause === (resB as any).handoffCause &&
        (resA as any).handoffCause === "RETRY_EXHAUSTED",
    );
    const sentA = harnessA.messages.filter((m) => m.senderType === "ASSISTANT");
    const sentB = harnessB.messages.filter((m) => m.senderType === "ASSISTANT");
    check(
      "5d.2 Assistant reply text identical across wordings",
      sentA[0]?.content === sentB[0]?.content &&
        sentA[0]?.content === SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE,
    );
  }

  // ── Area 6: Pure resolveSafeFailureReply Invariants ─────────────────────────
  console.log("\nArea 6: Pure resolveSafeFailureReply Invariants");
  {
    check(
      "6.1 RETRY_EXHAUSTED maps to PROVIDER_FAILURE reply",
      resolveSafeFailureReply({
        controlHandoffReason: "RETRY_EXHAUSTED",
        failureCause: "RETRY_EXHAUSTED",
      }) === SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE,
    );
    check(
      "6.2 PROVIDER_UNAVAILABLE maps to PROVIDER_FAILURE reply",
      resolveSafeFailureReply({
        controlHandoffReason: "PROVIDER_UNAVAILABLE",
        failureCause: "PROVIDER_FAILURE",
      }) === SAFE_HANDOFF_REPLIES.PROVIDER_FAILURE,
    );
    check(
      "6.3 AI_FAILURE / UNSUPPORTED_REQUEST maps to INVALID_OUTPUT reply",
      resolveSafeFailureReply({
        controlHandoffReason: "UNSUPPORTED_REQUEST",
        failureCause: "AI_FAILURE",
      }) === SAFE_HANDOFF_REPLIES.INVALID_OUTPUT,
    );
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(
    `\n=== Results: ${checks.length - failureCount}/${checks.length} passed, ${failureCount} failed ===\n`,
  );
  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Verification crashed:", err);
  process.exit(1);
});
