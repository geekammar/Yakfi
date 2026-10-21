/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — JEV DECISION STRATEGY check (PROMPT-AI-ARCH-17 — Slice 8).
 *
 * Deterministic, OFFLINE verification of the OPTIONAL JEV decision strategy
 * behind the EXISTING provider gateway (no DB, no network, no real LLM, no
 * API tokens, no secrets). It exercises THREE layers, all REAL production
 * code except the provider adapter (an in-memory stand-in for the vendor):
 *
 *   PART A — UNIT          the pure decision contract + conservative strategy
 *   PART B — GATEWAY       the REAL orchestrator (the one-call-budget owner)
 *   PART C — ENGINE        the REAL Conversation Engine end-to-end
 *
 * Invariants proven:
 *   zero-or-one generative call per turn · no second inference · no
 *   classifier→responder→judge chain · safety/handoff precedence stays
 *   authoritative · the Slice-7 typed handoff cause survives · one
 *   customer-visible send per turn · provider-neutral decisions.
 *
 * Run: pnpm check:jev
 */
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const { bypassDeterministicAi } =
    await import("../src/features/conversations/server/conversation-ai");
  const jev = await import("../src/server/integrations/ai/jev-strategy");
  const { createAiOrchestrator } =
    await import("../src/server/integrations/ai/orchestrator");
  const { createLlmConversationAi } =
    await import("../src/server/integrations/ai/conversation-ai");
  const { createConversationControl } =
    await import("../src/server/integrations/ai/conversation-control");

  type AiRequest =
    import("../src/features/conversations/server/ai-contract").AiRequest;
  type AiResponse =
    import("../src/features/conversations/server/ai-contract").AiResponse;
  type ConversationEngineDeps =
    import("../src/features/conversations/server/conversation-engine").ConversationEngineDeps;
  type InboundResult =
    import("../src/features/conversations/server/conversation-engine").InboundResult;
  type InboundSuccess =
    import("../src/features/conversations/server/conversation-engine").InboundSuccess;
  type AiProviderAdapter =
    import("../src/server/integrations/ai/types").AiProviderAdapter;
  type AiProviderResult =
    import("../src/server/integrations/ai/types").AiProviderResult;
  type AiTelemetry = import("../src/server/integrations/ai/types").AiTelemetry;
  type HandoffCause =
    import("../src/features/conversations/server/handoff-cause").HandoffCause;

  const WHATSAPP = "+201000000000";
  const now = new Date();
  const emptyExtraction = {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  };

  function isSuccess(result: InboundResult): result is InboundSuccess {
    return result.ok && !result.duplicate;
  }

  function reply(content: string, intent: AiResponse["intent"]): AiResponse {
    return {
      intent,
      action: "reply",
      content,
      extraction: emptyExtraction,
      handoffReason: null,
      summary: null,
    };
  }
  function handoff(
    handoffReason: AiResponse["handoffReason"],
    intent: AiResponse["intent"] = "AMBIGUOUS",
  ): AiResponse {
    return {
      intent,
      action: "handoff",
      content: "سيتواصل معك أحد أعضاء الفريق.",
      extraction: emptyExtraction,
      handoffReason,
      summary: null,
    };
  }

  function req(message: string): AiRequest {
    return {
      message,
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "عيادة التقييم",
      services: [{ name: "تنظيف أسنان" }],
      faqs: [{ question: "مواعيد العمل", answer: "من 9 صباحاً حتى 6 مساءً" }],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART A — UNIT: the pure decision contract + conservative strategy
  // ═══════════════════════════════════════════════════════════════════════

  const strategy = jev.createConservativeJevStrategy();

  // A1 — the contract is bounded (closed enums, exactly two modes). The reason
  // set is a fixed closed tuple: the 3 conservative reasons plus the 6 semantic
  // reasons a semantic JEV strategy terminates on (PROMPT-AI-JEV-03B §6/§7 —
  // every one of them is a ZERO-LLM-call DETERMINISTIC termination).
  check(
    "A1 the decision contract is bounded: 2 modes, 9 reasons, closed enums",
    jev.jevDecisionModeValues.length === 2 &&
      jev.jevDecisionModeValues.includes("DETERMINISTIC") &&
      jev.jevDecisionModeValues.includes("GENERATIVE") &&
      jev.jevDecisionReasonValues.length === 9 &&
      jev.jevDecisionReasonValues.includes("GENERATIVE_REQUIRED") &&
      jev.jevDecisionReasonValues.includes("JEV_FAILURE_FAIL_CLOSED") &&
      jev.jevDecisionReasonValues.includes("SEMANTIC_CLARIFY"),
  );

  // A2 — a proven deterministic greeting terminates with a complete response.
  {
    const d = await strategy.decide(req("السلام عليكم"));
    check(
      "A2 proven greeting → DETERMINISTIC / DETERMINISTIC_ACKNOWLEDGEMENT with a complete contract response",
      d.mode === "DETERMINISTIC" &&
        d.reason === "DETERMINISTIC_ACKNOWLEDGEMENT" &&
        d.response !== null &&
        d.response.intent === "GREETING" &&
        d.response.action === "reply",
    );
  }

  // A3 — a proven undecidable (too short) turn terminates as a safe ambiguity
  // handoff — never a guess, never a fabricated answer.
  {
    const d = await strategy.decide(req("م"));
    check(
      "A3 proven undecidable (too short) → DETERMINISTIC / DETERMINISTIC_UNDECIDABLE as a safe handoff",
      d.mode === "DETERMINISTIC" &&
        d.reason === "DETERMINISTIC_UNDECIDABLE" &&
        d.response !== null &&
        d.response.action === "handoff" &&
        d.response.handoffReason === "AMBIGUOUS",
    );
  }

  // A4 — a normal language-understanding turn continues to the generative call.
  {
    const d = await strategy.decide(req("ما مواعيد العمل لديكم؟"));
    check(
      "A4 normal question → GENERATIVE / GENERATIVE_REQUIRED, no fabricated response",
      d.mode === "GENERATIVE" &&
        d.reason === "GENERATIVE_REQUIRED" &&
        d.response === null,
    );
  }

  // A5 — an ambiguous natural-language turn does NOT bypass incorrectly.
  {
    const d = await strategy.decide(req("عايز أحجز موعد بكرة لو سمحت"));
    check(
      "A5 ambiguous booking language → GENERATIVE (never bypasses incorrectly)",
      d.mode === "GENERATIVE",
    );
  }

  // A6 — an explicit human request is never terminated by JEV (handoff path).
  {
    const d = await strategy.decide(req("أريد التحدث إلى موظف لو سمحت"));
    check(
      "A6 explicit human request → GENERATIVE (the existing handoff path owns it)",
      d.mode === "GENERATIVE",
    );
  }

  // A7 — a sensitive turn is never terminated by JEV (safety precedence).
  {
    const d = await strategy.decide(
      req("عندي ألم شديد جداً في أسناني ولا أعرف ماذا أفعل"),
    );
    check(
      "A7 sensitive turn → GENERATIVE (safety precedence is never bypassed)",
      d.mode === "GENERATIVE",
    );
  }

  // A8 — CONSERVATIVE CONTRACT: the strategy's deterministic set is EXACTLY
  //      the repository's already-proven zero-LLM set (bypassDeterministicAi).
  //      No new deterministic behaviour was introduced by the slice.
  {
    const corpus = [
      "السلام عليكم",
      "أهلاً",
      "صباح الخير",
      "م",
      "اه",
      "ما مواعيد العمل؟",
      "عايز أحجز موعد",
      "بكام التنظيف؟",
      "أريد التحدث إلى موظف",
      "عندي ألم شديد وعايز أحجز",
      "هل بتقدموا تقويم الأسنان؟",
      "تمام، عايز الساعة 10 بكرة",
      "اللهم صل على النبي",
      "محتار",
    ];
    let divergence = 0;
    for (const message of corpus) {
      const request = req(message);
      const proven = bypassDeterministicAi(request);
      const decision = await strategy.decide(request);
      const strategyTerminates = decision.mode === "DETERMINISTIC";
      if (proven === null && strategyTerminates) divergence += 1;
      if (proven !== null && !strategyTerminates) divergence += 1;
      // `bypassDeterministicAi` constructs a fresh response per call, so
      // compare by contract VALUE, not reference.
      if (
        proven !== null &&
        strategyTerminates &&
        decision.response !== null &&
        (decision.response.intent !== proven.intent ||
          decision.response.action !== proven.action ||
          decision.response.content !== proven.content ||
          decision.response.handoffReason !== proven.handoffReason)
      )
        divergence += 1;
    }
    check(
      `A8 the conservative strategy's deterministic set == the proven bypass set (0 divergence on ${corpus.length} messages — no new deterministic behaviour)`,
      divergence === 0,
    );
  }

  // A9 — the strategy introduces NO second resolver / judge / classifier: it
  //      imports only the contract + the shared deterministic classifier (plus
  //      a TYPE-ONLY sibling import for the semantic evidence block), and its
  //      decision performs no I/O. PROMPT-AI-JEV-03B §6 makes the SEAM async so
  //      a SEMANTIC strategy may spend its ONE JEV call; the CONSERVATIVE
  //      strategy still awaits nothing — `async` is the seam's shape only, and
  //      its body holds no provider call, no fetch and no model call.
  {
    const source = readFileSync(
      resolvePath(__dirname, "../src/server/integrations/ai/jev-strategy.ts"),
      "utf8",
    );
    // The only source imports must be the AI contract, the shared classifier,
    // or the type-only sibling evidence import. Statements (not lines) — the
    // contract import spans several lines.
    const importStatements =
      source.match(/import[\s\S]*?from\s*["'][^"']+["'];/g) ?? [];
    const forbiddenImport = importStatements.some(
      (statement) =>
        /\/(atria|openrouter|agentrouter|codecraft)["']/.test(statement) ||
        /\/(orchestrator|factory|conversation-control|prompt-registry|prompt)["']/.test(
          statement,
        ) ||
        /\/(turn-planner|conversation-state|conversation-engine|booking-|appointment-)/.test(
          statement,
        ),
    );
    const everyImportAllowed = importStatements.every(
      (statement) =>
        /ai-contract/.test(statement) ||
        /conversation-ai/.test(statement) ||
        /jev-semantic-strategy/.test(statement),
    );
    // The conservative body must perform no I/O: no await, no provider call,
    // no injected dependency — a pure value resolved on the same turn. The
    // slice is the strategy's own definition (the last export in the module).
    const conservativeBody = source.slice(
      source.indexOf("export function createConservativeJevStrategy"),
    );
    check(
      "A9 the JEV module adds no second resolver/judge/classifier (contract + classifier only; the conservative decide performs no I/O)",
      !forbiddenImport &&
        everyImportAllowed &&
        importStatements.length === 3 &&
        !/await\s/.test(conservativeBody) &&
        !/(\.call\(|fetchImpl|deps\.|\.evaluate\()/.test(conservativeBody) &&
        /async decide\(request: AiRequest\)/.test(conservativeBody),
    );
  }

  // A10 — provider NEUTRALITY: the decision is identical regardless of which
  //       vendor the gateway is configured for (the strategy never sees it).
  {
    const d1 = await strategy.decide(req("السلام عليكم"));
    const d2 = await strategy.decide(req("السلام عليكم"));
    check(
      "A10 the decision contract carries no provider identity and is stable across invocations",
      d1.mode === d2.mode &&
        d1.reason === d2.reason &&
        d1.response?.content === d2.response?.content,
    );
  }

  // A11 — the JEV deterministic telemetry label is a DISTINCT zero-call label.
  check(
    "A11 the JEV deterministic provider label is distinct from the engine's deterministic-bypass label",
    String(jev.JEV_DETERMINISTIC_PROVIDER) === "jev-deterministic" &&
      String(jev.JEV_DETERMINISTIC_PROVIDER) !== "deterministic-bypass" &&
      jev.isJevDeterministicProvider(jev.JEV_DETERMINISTIC_PROVIDER) &&
      !jev.isJevDeterministicProvider("deterministic-bypass" as string),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // PART B — GATEWAY: the REAL orchestrator with an in-memory provider
  // ═══════════════════════════════════════════════════════════════════════

  /** A minimal in-memory provider adapter stand-in for the vendor. */
  function fakeProvider(opts: {
    providerId?: AiProviderAdapter["providerId"];
    behavior:
      | { kind: "reply"; content: string; intent: AiResponse["intent"] }
      | {
          kind: "fail";
          code: AiProviderResult extends { ok: false } ? never : "TIMEOUT";
        };
  }): { adapter: AiProviderAdapter; calls: () => number } {
    let calls = 0;
    const providerId = opts.providerId ?? "atria";
    const adapter: AiProviderAdapter = {
      providerId,
      model: `${providerId}-test-model`,
      secretRef: `${providerId.toUpperCase()}_API_KEY`,
      async call(_request: AiRequest): Promise<AiProviderResult> {
        calls += 1;
        if (opts.behavior.kind === "fail") {
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: "simulated timeout",
              retryable: true,
              httpStatus: 504,
            },
            provider: providerId,
            model: `${providerId}-test-model`,
            latencyMs: 5,
          } as AiProviderResult;
        }
        return {
          ok: true,
          response: reply(opts.behavior.content, opts.behavior.intent),
          provider: providerId,
          model: `${providerId}-test-model`,
          latencyMs: 5,
        } as AiProviderResult;
      },
    };
    return { adapter, calls: () => calls };
  }

  // B1 — a JEV DETERMINISTIC turn spends ZERO provider calls at the gateway.
  {
    const { adapter, calls } = fakeProvider({
      behavior: { kind: "reply", content: "رد", intent: "FAQ" },
    });
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategy,
    });
    const result = await orchestrator.callWithFallback(req("السلام عليكم"));
    check(
      "B1 JEV DETERMINISTIC greeting → response returned, ZERO provider attempts, jev-deterministic label + DETERMINISTIC audit",
      calls() === 0 &&
        result.response !== null &&
        result.response.intent === "GREETING" &&
        result.telemetry.attempts.length === 0 &&
        result.telemetry.finalProvider === jev.JEV_DETERMINISTIC_PROVIDER &&
        result.telemetry.finalStatus === "SUCCESS" &&
        result.telemetry.jevDecision?.mode === "DETERMINISTIC" &&
        result.telemetry.jevDecision?.reason ===
          "DETERMINISTIC_ACKNOWLEDGEMENT",
    );
  }

  // B2 — a JEV GENERATIVE turn makes EXACTLY ONE provider call.
  {
    const { adapter, calls } = fakeProvider({
      behavior: { kind: "reply", content: "نفتح من 9 حتى 6.", intent: "FAQ" },
    });
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategy,
    });
    const result = await orchestrator.callWithFallback(
      req("ما مواعيد العمل لديكم؟"),
    );
    check(
      "B2 JEV GENERATIVE question → EXACTLY ONE provider call, GENERATIVE audit recorded",
      calls() === 1 &&
        result.response !== null &&
        result.telemetry.attempts.length === 1 &&
        result.telemetry.finalProvider === "atria" &&
        result.telemetry.jevDecision?.mode === "GENERATIVE" &&
        result.telemetry.jevDecision?.reason === "GENERATIVE_REQUIRED",
    );
  }

  // B3 — a provider failure is NOT masked: the gateway reports the failure and
  //      the JEV decision stayed GENERATIVE (no hidden retry, no second call).
  {
    const { adapter, calls } = fakeProvider({
      behavior: { kind: "fail", code: "TIMEOUT" },
    });
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategy,
    });
    const result = await orchestrator.callWithFallback(req("ما مواعيد العمل؟"));
    check(
      "B3 provider failure → response null, failure NOT masked, exactly ONE attempt, JEV did not retry",
      calls() === 1 &&
        result.response === null &&
        result.telemetry.finalStatus === "FAILURE" &&
        result.telemetry.attempts.length === 1 &&
        result.lastErrorCode === "TIMEOUT" &&
        result.telemetry.jevDecision?.mode === "GENERATIVE",
    );
  }

  // B4 — JEV is OPTIONAL: with the strategy absent, the gateway keeps its
  //      exact prior behaviour (built-in bypass, no JEV audit field).
  {
    const { adapter, calls } = fakeProvider({
      behavior: { kind: "reply", content: "رد", intent: "FAQ" },
    });
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: null,
    });
    const bypassed = await orchestrator.callWithFallback(req("السلام عليكم"));
    const generated = await orchestrator.callWithFallback(req("ما المواعيد؟"));
    check(
      "B4 decisionStrategy absent → prior behaviour: deterministic-bypass label, no jevDecision, one call on a generative turn",
      calls() === 1 &&
        bypassed.response !== null &&
        bypassed.telemetry.finalProvider === "deterministic-bypass" &&
        bypassed.telemetry.jevDecision === undefined &&
        generated.telemetry.jevDecision === undefined &&
        generated.telemetry.attempts.length === 1,
    );
  }

  // B5 — PROVIDER NEUTRALITY at the gateway: swapping the configured vendor
  //      changes nothing about the decision or the deterministic outcome.
  {
    const a = fakeProvider({
      providerId: "atria",
      behavior: { kind: "reply", content: "رد", intent: "FAQ" },
    });
    const b = fakeProvider({
      providerId: "codecraft",
      behavior: { kind: "reply", content: "رد", intent: "FAQ" },
    });
    const oA = createAiOrchestrator({
      primary: a.adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategy,
    });
    const oB = createAiOrchestrator({
      primary: b.adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategy,
    });
    const rA = await oA.callWithFallback(req("السلام عليكم"));
    const rB = await oB.callWithFallback(req("السلام عليكم"));
    check(
      "B5 provider swap (atria↔codecraft) → identical JEV decision, identical deterministic response, zero calls both",
      a.calls() === 0 &&
        b.calls() === 0 &&
        rA.telemetry.finalProvider === rB.telemetry.finalProvider &&
        rA.response?.content === rB.response?.content &&
        rA.telemetry.jevDecision?.mode === rB.telemetry.jevDecision?.mode,
    );
  }

  // B6 — the one-call budget holds across a mixed corpus: provider calls ==
  //      GENERATIVE decisions; a DETERMINISTIC turn never calls the provider.
  {
    const { adapter, calls } = fakeProvider({
      behavior: { kind: "reply", content: "رد", intent: "FAQ" },
    });
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategy,
    });
    const messages = [
      "السلام عليكم",
      "م",
      "ما مواعيد العمل؟",
      "عايز أحجز موعد",
      "أريد التحدث إلى موظف",
      "صباح الخير",
      "بكام التنظيف؟",
    ];
    let generative = 0;
    for (const message of messages) {
      const result = await orchestrator.callWithFallback(req(message));
      if (result.telemetry.jevDecision?.mode === "GENERATIVE") generative += 1;
    }
    check(
      `B6 mixed corpus (${messages.length} turns): provider calls == GENERATIVE decisions (${generative}); no multi-call turn`,
      calls() === generative && generative > 0 && generative < messages.length,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART C — ENGINE: the REAL Conversation Engine end-to-end
  // ═══════════════════════════════════════════════════════════════════════

  const business = {
    id: "11111111-1111-4111-8111-111111111111",
    name: "عيادة التقييم",
    vertical: null,
    city: null,
    whatsappNumber: WHATSAPP,
    timezone: "Africa/Cairo",
    about: null,
    workingHours: {},
    slotDurationMinutes: 30,
    confirmationMode: "manual",
    faqs: [{ question: "مواعيد العمل", answer: "من 9 صباحاً حتى 6 مساءً" }],
    cancellationPolicy: null,
    onboardingCompletedAt: now,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    assistantName: null,
    assistantStyle: null,
    defaultBranchId: "55555555-5555-4555-8555-555555555555",
  };
  const branch = {
    id: "55555555-5555-4555-8555-555555555555",
    businessId: business.id,
    name: "الفرع",
    isActive: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const customer = {
    id: "eval-customer-1",
    businessId: business.id,
    name: "عميل التقييم",
    phone: "+201234567890",
    notes: null,
    lastConversationAt: null,
    lastAppointmentAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const services = [
    {
      id: "service-1",
      businessId: business.id,
      name: "تنظيف أسنان",
      description: null,
      durationMinutes: 30,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      priceType: null,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: null,
    },
  ];

  /**
   * Build the engine deps with an `ai` that is the REAL
   * `createLlmConversationAi` over an in-memory provider, WITH the JEV
   * strategy wired exactly as the production factory wires it. The transport
   * counts customer-visible sends.
   */
  function makeHarness(opts: {
    providerBehavior:
      | { kind: "reply"; content: string; intent: AiResponse["intent"] }
      | {
          kind: "handoff";
          handoffReason: AiResponse["handoffReason"];
          intent?: AiResponse["intent"];
        }
      | { kind: "fail" };
    wrapControl?: boolean;
  }) {
    let providerCalls = 0;
    const providerId = "atria";
    let conversation: {
      id: string;
      businessId: string;
      status: string;
      assignedUserId: string | null;
      aiSummary: string | null;
    } | null = null;
    const messages: Array<{
      id: string;
      senderType: string;
      content: string;
      createdAt: string;
    }> = [];
    const sent: string[] = [];
    let mseq = 0;

    const rawPrimary: AiProviderAdapter = {
      providerId,
      model: "atria-test-model",
      secretRef: "ATRIA_API_KEY",
      async call(_request: AiRequest): Promise<AiProviderResult> {
        providerCalls += 1;
        if (opts.providerBehavior.kind === "fail") {
          return {
            ok: false,
            error: {
              code: "TIMEOUT",
              message: "simulated timeout",
              retryable: true,
              httpStatus: 504,
            },
            provider: providerId,
            model: "atria-test-model",
            latencyMs: 5,
          } as AiProviderResult;
        }
        return {
          ok: true,
          response:
            opts.providerBehavior.kind === "handoff"
              ? handoff(
                  opts.providerBehavior.handoffReason,
                  opts.providerBehavior.intent ?? "AMBIGUOUS",
                )
              : reply(
                  opts.providerBehavior.content,
                  opts.providerBehavior.intent,
                ),
          provider: providerId,
          model: "atria-test-model",
          latencyMs: 5,
        } as AiProviderResult;
      },
    };

    // Wrap with the REAL Conversation Control layer exactly as the production
    // factory does, so a failure is classified by the real policy (retry /
    // handoff reason) the engine maps onto the Slice-7 cause.
    const primary = opts.wrapControl
      ? (createConversationControl({
          provider: rawPrimary,
        }) as unknown as AiProviderAdapter)
      : rawPrimary;

    const ai = createLlmConversationAi({
      primary,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: jev.createConservativeJevStrategy(),
    });

    const deps = {
      businessRepository: {
        findByWhatsappNumber: async () => business,
        findById: async () => business,
      },
      branchRepository: {
        findDefaultByBusiness: async () => branch,
        findByIdWithinBusiness: async () => branch,
      },
      customerRepository: {
        upsertByPhone: async () => customer,
        touchConversation: async () => customer,
      },
      conversationRepository: {
        findLatestByCustomer: async () =>
          conversation ? { id: conversation.id } : null,
        findById: async () => conversation,
        create: async (input: {
          businessId: string;
          customerId: string;
          branchId: string | null;
        }) => {
          conversation = {
            id: "conv-1",
            businessId: input.businessId,
            status: "AI_ACTIVE",
            assignedUserId: null,
            aiSummary: null,
          };
          return conversation;
        },
        addMessage: async (
          input: { senderType: string; content: string },
          workflow?: { status?: string },
        ) => {
          mseq += 1;
          messages.push({
            id: `msg-${mseq}`,
            senderType: input.senderType,
            content: input.content,
            createdAt: now.toISOString(),
          });
          if (workflow?.status && conversation) {
            conversation = { ...conversation, status: workflow.status };
          }
          return { id: `msg-${mseq}`, createdAt: now.toISOString() };
        },
        getMessages: async () =>
          [...messages].reverse().map((message) => ({
            id: message.id,
            conversationId: conversation!.id,
            senderType: message.senderType,
            content: message.content,
            createdAt: message.createdAt,
          })),
        update: async () => conversation,
        updateWorkflow: async (id: string, patch: { status?: string }) => {
          if (conversation && conversation.id === id && patch.status) {
            conversation = { ...conversation, status: patch.status };
          }
          return conversation;
        },
      },
      serviceRepository: {
        listByBusiness: async () => services,
        findById: async () => services[0]!,
      },
      inboundDedupeRepository: {
        claim: async () => ({ status: "claimed" as const, claimId: "claim-1" }),
      },
      usageRepository: { record: async () => undefined },
      attentionRepository: { open: async () => ({ id: "attn-1" }) },
      providerRepository: {
        listEligibleForService: async () => [],
        listAssignmentSeams: async () => [],
      },
      appointmentRepository: {
        listBlockingByAssignees: async () => [],
        createWithConflictCheck: async () => ({ id: "appt-1" }),
      },
      ai,
      requiredSemanticCapability: null,
      transport: {
        providerName: "scripted",
        async send(input: { content: string }) {
          sent.push(input.content);
          return { provider: "scripted", delivered: true };
        },
      },
    } as unknown as ConversationEngineDeps;

    const run = async (text: string, externalId: string) =>
      engine.receiveInboundMessage(
        deps,
        {
          to: WHATSAPP,
          from: "+201234567890",
          text,
          receivedAt: now.toISOString(),
          externalId,
        },
        { businessId: business.id, connectionId: null, branchId: branch.id },
      );

    return {
      run,
      sent,
      providerCalls: () => providerCalls,
      telemetry: () =>
        (
          ai as unknown as { getLastTelemetry?: () => AiTelemetry | null }
        ).getLastTelemetry?.() ?? null,
      get conversation() {
        return conversation;
      },
    };
  }

  // C1 — a proven deterministic turn through the REAL engine: the engine's
  //      own deterministic fast path resolves it BEFORE the gateway (no policy
  //      read, no provider call), so the conservative JEV strategy and the
  //      fast path agree by construction (proven in A8/B1). Zero calls, one
  //      customer-visible send, stays AI_ACTIVE.
  {
    const h = makeHarness({
      providerBehavior: { kind: "reply", content: "رد", intent: "FAQ" },
    });
    const result = await h.run("السلام عليكم", "c1");
    const obs = (isSuccess(result) ? result.observability : null) as {
      routingDecision?: string;
      jev?: { mode?: string; reason?: string };
    } | null;
    check(
      "C1 proven deterministic greeting through the real engine → ZERO provider calls, one send, AI_ACTIVE, the proven deterministic fast path (which the conservative JEV strategy mirrors at the gateway — B1)",
      isSuccess(result) &&
        h.providerCalls() === 0 &&
        h.sent.length === 1 &&
        result.conversationStatus === "AI_ACTIVE" &&
        obs?.routingDecision === "DETERMINISTIC_BYPASS",
    );
  }

  // C2 — a normal language-understanding turn: EXACTLY ONE provider call.
  {
    const h = makeHarness({
      providerBehavior: {
        kind: "reply",
        content: "نفتح من 9 صباحاً حتى 6 مساءً.",
        intent: "FAQ",
      },
    });
    const result = await h.run("ما مواعيد العمل لديكم؟", "c2");
    const obs = (isSuccess(result) ? result.observability : null) as {
      jev?: { mode?: string };
    } | null;
    check(
      "C2 normal question through the real engine → EXACTLY ONE provider call, one send, GENERATIVE audit",
      isSuccess(result) &&
        h.providerCalls() === 1 &&
        h.sent.length === 1 &&
        result.conversationStatus === "AI_ACTIVE" &&
        obs?.jev?.mode === "GENERATIVE",
    );
  }

  // C3 — an ambiguous natural-language turn reaches the provider (does not
  //      bypass incorrectly) and resolves safely.
  {
    const h = makeHarness({
      providerBehavior: {
        kind: "reply",
        content: "سأساعدك في الحجز.",
        intent: "BOOKING",
      },
    });
    await h.run("عايز أحجز موعد بكرة لو سمحت", "c3");
    check(
      "C3 ambiguous booking language → the provider IS consulted (no incorrect bypass)",
      h.providerCalls() === 1,
    );
  }

  // C4 — explicit human request: the existing HANDOFF precedence wins and the
  //      Slice-7 typed cause survives; JEV never suppresses a NEED_HUMAN.
  {
    const h = makeHarness({
      providerBehavior: {
        kind: "reply",
        content: "حسناً.",
        intent: "HUMAN_REQUEST",
      },
    });
    const result = await h.run("أريد التحدث إلى موظف لو سمحت", "c4");
    check(
      "C4 explicit human request → NEED_HUMAN + CUSTOMER_REQUESTED_HUMAN (handoff precedence preserved; JEV did not suppress it)",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        (result.handoffCause as HandoffCause | null) ===
          "CUSTOMER_REQUESTED_HUMAN",
    );
  }

  // C5 — a sensitive turn: safety precedence preserved (NEED_HUMAN + cause).
  {
    const h = makeHarness({
      providerBehavior: {
        kind: "reply",
        content: "رد",
        intent: "FAQ",
      },
    });
    const result = await h.run(
      "عندي ألم شديد جداً في أسناني ولا أعرف ماذا أفعل",
      "c5",
    );
    check(
      "C5 sensitive turn → NEED_HUMAN + SENSITIVE_OR_RESTRICTED (safety precedence preserved)",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        (result.handoffCause as HandoffCause | null) ===
          "SENSITIVE_OR_RESTRICTED",
    );
  }

  // C6 — provider failure / retry exhaustion: JEV does NOT mask the existing
  //      handoff cause (PROVIDER_FAILURE, distinct from a knowledge gap).
  {
    const h = makeHarness({
      providerBehavior: { kind: "fail" },
      wrapControl: true,
    });
    const result = await h.run("ما مواعيد العمل لديكم؟", "c6");
    const cause = isSuccess(result) ? result.handoffCause : null;
    check(
      "C6 provider failure → NEED_HUMAN with a provider/runtime cause (never a mislabeled knowledge gap); JEV stayed GENERATIVE",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        (cause as HandoffCause | null) !== null &&
        (cause as HandoffCause | null) !== "KNOWLEDGE_GAP_UNRESOLVED" &&
        h.telemetry()?.jevDecision?.mode === "GENERATIVE",
    );
  }

  // C7 — the Slice-7 typed cause taxonomy still derives on the handoff paths.
  {
    const h = makeHarness({
      providerBehavior: {
        kind: "handoff",
        handoffReason: "NO_KNOWLEDGE",
        intent: "AMBIGUOUS",
      },
    });
    const result = await h.run(
      "هل بتقدموا خدمة التقويم الشفاف غير المرئي؟",
      "c7",
    );
    const cause = isSuccess(result) ? result.handoffCause : null;
    check(
      "C7 knowledge-gap handoff → NEED_HUMAN + KNOWLEDGE_GAP_UNRESOLVED (the Slice-7 typed cause survives the JEV wiring; the model's own reason is only a fallback)",
      isSuccess(result) &&
        result.conversationStatus === "NEED_HUMAN" &&
        (cause as HandoffCause | null) === "KNOWLEDGE_GAP_UNRESOLVED",
    );
  }

  // C7b — an unnecessary-handoff guard: a model handoff on an answerable FAQ
  //       question is still resolved through the ONE authoritative engine
  //       path; the JEV wiring never invents a second resolution.
  {
    const h2 = makeHarness({
      providerBehavior: {
        kind: "handoff",
        handoffReason: "AMBIGUOUS",
        intent: "AMBIGUOUS",
      },
    });
    const result2 = await h2.run("ما مواعيد العمل لديكم؟", "c7b");
    const status2 = isSuccess(result2)
      ? result2.conversationStatus
      : "engine-failed";
    check(
      "C7b a model handoff resolves through the ONE authoritative engine path (no JEV re-resolution)",
      isSuccess(result2) &&
        (status2 === "NEED_HUMAN" || status2 === "AI_ACTIVE") &&
        h2.providerCalls() === 1,
    );
  }

  // C8 — one customer-visible send invariant on a generative handoff turn.
  {
    const h = makeHarness({
      providerBehavior: {
        kind: "reply",
        content: "سيتواصل معك الفريق.",
        intent: "HUMAN_REQUEST",
      },
    });
    const result = await h.run("أريد التحدث إلى موظف", "c8");
    check(
      "C8 generative handoff turn → exactly ONE customer-visible send",
      isSuccess(result) && h.sent.length === 1 && h.providerCalls() === 1,
    );
  }

  // C9 — no second resolver / judge / classifier: a generative turn is ONE
  //      provider call and the deterministic turn is ZERO — never two.
  {
    const h = makeHarness({
      providerBehavior: { kind: "reply", content: "رد", intent: "FAQ" },
    });
    await h.run("السلام عليكم", "c9a");
    const callsAfterBypass = h.providerCalls();
    await h.run("ما مواعيد العمل؟", "c9b");
    check(
      "C9 no second inference: bypass turn = 0 calls, generative turn = 1 call (never 2)",
      callsAfterBypass === 0 && h.providerCalls() === 1,
    );
  }

  // C10 — the JEV decision is NEVER customer-visible: the reply text carries
  //       no internal decision metadata on any path.
  {
    const h = makeHarness({
      providerBehavior: {
        kind: "reply",
        content: "نفتح من 9 صباحاً حتى 6 مساءً.",
        intent: "FAQ",
      },
    });
    const result = await h.run("ما مواعيد العمل؟", "c10");
    const leaked =
      h.sent.some((text) =>
        /DETERMINISTIC|GENERATIVE|GENERATIVE_REQUIRED|JEV|jev-deterministic/.test(
          text,
        ),
      ) ||
      (isSuccess(result) &&
        /DETERMINISTIC_ACKNOWLEDGEMENT|DETERMINISTIC_UNDECIDABLE|GENERATIVE_REQUIRED/.test(
          String(result.observability?.provider ?? ""),
        ));
    check(
      "C10 the JEV decision metadata never reaches the customer-visible reply",
      isSuccess(result) && !leaked,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RESULT
  // ═══════════════════════════════════════════════════════════════════════
  const failures = checks.filter((checkEntry) => !checkEntry.pass);
  const passCount = checks.length - failures.length;
  console.log("");
  console.log("── JEV decision strategy (PROMPT-AI-ARCH-17 — Slice 8) ──");
  for (const checkEntry of checks) {
    console.log(`  ${checkEntry.pass ? "✓" : "✗"} ${checkEntry.label}`);
  }
  console.log("");
  console.log(
    `  RESULT: ${passCount}/${checks.length} passed` +
      (failures.length > 0
        ? ` — FAILED: ${failures.map((f) => f.label).join("; ")}`
        : " — ALL GREEN"),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
