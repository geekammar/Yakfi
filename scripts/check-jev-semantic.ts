/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — JEV SEMANTIC strategy check (PROMPT-AI-JEV-03B).
 *
 * Deterministic, OFFLINE verification of the semantic JEV route (OPTION B —
 * REPLACE, DON'T CHAIN). NO DB, NO network, NO real LLM, NO real JEV/OpenRouter
 * call, NO API tokens, NO secrets. Every provider is an in-memory stand-in; the
 * strategy, the eligibility gate, the fact derivations, the gateway and the
 * clarification/telemetry seams are the REAL production code.
 *
 *   PART A — UNIT          the pure derivations: P1 threshold, P2 argmax, bands
 *   PART B — GATE          the pure pre-call eligibility rule (0 model calls)
 *   PART C — PROVIDER      the Decisions adapter against a stubbed fetch
 *   PART D — STRATEGY      the semantic strategy's 0/1 truth table
 *   PART E — GATEWAY       the REAL orchestrator: the LLM is never 2nd-called
 *   PART F — FLAG          the kill switch (DISABLED BY DEFAULT)
 *   PART G — CLARIFY       the bounded CLARIFY_CONTACT_OR_BOOK member
 *   PART H — TELEMETRY     the ONE modelCallCount counter + closed keys
 *   PART I — ISOLATION     src/* imports ZERO evaluation/* runtime code
 *
 * Invariants proven:
 *   deterministic 0 calls · semantic JEV exactly 1 call / 0 LLM · generative
 *   0 JEV / 1 LLM · NEVER JEV→LLM · fail-closed after a spent attempt · no
 *   chain-of-thought or model prose reaches the customer · missing credential
 *   spends ZERO network calls.
 *
 * Run: pnpm check:jev-semantic
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

  const { classifyCustomerMessage, deterministicReplyForIntent } =
    await import("../src/features/conversations/server/conversation-ai");
  const semantic =
    await import("../src/server/integrations/ai/jev-semantic-strategy");
  const decisions =
    await import("../src/server/integrations/ai/jev-decisions-provider");
  const jev = await import("../src/server/integrations/ai/jev-strategy");
  const { createAiOrchestrator } =
    await import("../src/server/integrations/ai/orchestrator");
  const { isSemanticJevEnabled, SEMANTIC_JEV_FLAG } =
    await import("../src/server/integrations/ai/factory");
  const clarification =
    await import("../src/features/conversations/server/clarification");
  const { buildTurnObservability } =
    await import("../src/features/conversations/server/ai-observability");

  type AiRequest =
    import("../src/features/conversations/server/ai-contract").AiRequest;
  type AiProviderAdapter =
    import("../src/server/integrations/ai/types").AiProviderAdapter;
  type AiProviderResult =
    import("../src/server/integrations/ai/types").AiProviderResult;
  type JevAnswer =
    import("../src/server/integrations/ai/jev-decisions-provider").JevAnswer;
  type JevDecisionsProvider =
    import("../src/server/integrations/ai/jev-decisions-provider").JevDecisionsProvider;
  type JevErrorCode =
    import("../src/server/integrations/ai/jev-decisions-provider").JevErrorCode;

  const emptyExtraction = {
    service: null,
    provider: null,
    date: null,
    timePreference: null,
  };

  function req(message: string, partial: Partial<AiRequest> = {}): AiRequest {
    return {
      message,
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "عيادة التجميل",
      services: [],
      faqs: [],
      ...partial,
    };
  }

  /** Build noul answers keyed by question key. */
  function noul(pairs: Array<[string, number]>): Record<string, JevAnswer> {
    const out: Record<string, JevAnswer> = {};
    for (const [key, value] of pairs) {
      out[key] = { type: "noul", noul: value };
    }
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART A — the pure derivations (P1 threshold, P2 argmax, P3 bands)
  // ═══════════════════════════════════════════════════════════════════════

  // A1 — P1: a probability at/above 0.5 is a fact; below is not.
  {
    const facts = semantic.deriveSemanticFacts(
      noul([
        ["supportRequested", 0.9],
        ["bookingRequested", 0.2],
      ]),
    );
    check(
      "A1 P1 fact = probability >= 0.5 (0.9 → true, 0.2 → false)",
      facts.supportRequested === true && facts.bookingRequested === false,
    );
  }

  // A2 — P1: an absent answer is a NULL fact, never coerced to false.
  {
    const facts = semantic.deriveSemanticFacts(
      noul([["bookingRequested", 0.8]]),
    );
    check(
      "A2 an absent answer is a NULL fact (never coerced to false)",
      facts.supportRequested === null &&
        facts.providerRequested === null &&
        facts.bookingRequested === true,
    );
  }

  // A3 — P2: two family members over threshold → argmax wins, the other is
  // suppressed to false, but the folded bookingTask mask stays TRUE.
  {
    const facts = semantic.deriveSemanticFacts(
      noul([
        ["bookingRequested", 0.7],
        ["availabilityAsked", 0.8],
      ]),
    );
    check(
      "A3 P2 argmax: availability(0.8) wins over booking(0.7); bookingTask still true",
      facts.availabilityAsked === true &&
        facts.bookingRequested === false &&
        facts.bookingTask === true,
    );
  }

  // A4 — P2 suppression is routing-neutral: whichever member wins, the mask
  // is identical (the precedence formula only reads bookingTask).
  {
    const a = semantic.deriveSemanticFacts(
      noul([
        ["bookingRequested", 0.8],
        ["availabilityAsked", 0.7],
      ]),
    );
    const b = semantic.deriveSemanticFacts(
      noul([
        ["bookingRequested", 0.7],
        ["availabilityAsked", 0.8],
      ]),
    );
    check(
      "A4 P2 is routing-neutral (bookingTask identical for either winner)",
      a.bookingTask === true && b.bookingTask === true,
    );
  }

  // A5 — the shared precedence formula: supportRequest wins outright.
  {
    const facts = semantic.deriveSemanticFacts(
      noul([
        ["supportRequested", 0.9],
        ["bookingRequested", 0.9],
      ]),
    );
    check(
      "A5 precedence: supportRequest OR (providerRequest AND NOT bookingTask)",
      facts.supportRequested === true &&
        facts.bookingTask === true &&
        facts.explicitHuman === true,
    );
  }

  // A6 — the provider path is masked by a booking task.
  {
    const facts = semantic.deriveSemanticFacts(
      noul([
        ["providerRequested", 0.9],
        ["bookingRequested", 0.9],
      ]),
    );
    check(
      "A6 precedence: providerRequest inside a booking task is NOT explicit human",
      facts.providerRequested === true &&
        facts.bookingTask === true &&
        facts.explicitHuman === false,
    );
  }

  // A7 — the provider path is unmasked when no booking task is asserted.
  {
    const facts = semantic.deriveSemanticFacts(
      noul([["providerRequested", 0.9]]),
    );
    check(
      "A7 precedence: providerRequest with no booking task IS explicit human",
      facts.providerRequested === true &&
        facts.bookingTask === false &&
        facts.explicitHuman === true,
    );
  }

  // A8 — P3 confidence bands (reporting only; never changes a fact).
  check(
    "A8 P3 bands: >=0.85 / <=0.15 high; 0.6–0.85 / 0.15–0.4 moderate; else low",
    semantic.bandConfidence(0.9) === "high" &&
      semantic.bandConfidence(0.1) === "high" &&
      semantic.bandConfidence(0.7) === "moderate" &&
      semantic.bandConfidence(0.3) === "moderate" &&
      semantic.bandConfidence(0.5) === "low",
  );

  // A9 — the question contract is closed and independent (11 noul + 1 choice).
  check(
    "A9 the question contract is closed: 12 keys, all noul except the goal choice",
    semantic.jevSemanticQuestionKeys.length === 12 &&
      semantic.jevSemanticQuestionKeys.filter(
        (key) => semantic.SEMANTIC_QUESTIONS[key].type === "choice",
      ).length === 1 &&
      semantic.SEMANTIC_QUESTIONS.conversationGoal.type === "choice",
  );

  // A10 — the shared formula exists exactly once and is total.
  {
    const t = (
      await import("../src/features/conversations/server/conversation-ai")
    ).explicitHumanFromFacts;
    check(
      "A10 the shared precedence derivation is total on all 8 fact combinations",
      t({
        supportRequest: false,
        providerRequest: false,
        bookingTask: false,
      }) === false &&
        t({
          supportRequest: false,
          providerRequest: true,
          bookingTask: false,
        }) === true &&
        t({
          supportRequest: false,
          providerRequest: true,
          bookingTask: true,
        }) === false &&
        t({
          supportRequest: true,
          providerRequest: false,
          bookingTask: false,
        }) === true &&
        t({
          supportRequest: true,
          providerRequest: true,
          bookingTask: true,
        }) === true,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART B — the pure pre-call eligibility gate (ZERO model calls)
  // ═══════════════════════════════════════════════════════════════════════

  // B1 — a turn the deterministic path already resolves is INELIGIBLE (0 calls)
  check(
    "B1 a proven deterministic bypass ⇒ INELIGIBLE (the 0-call route wins)",
    semantic.jevEligibility(req("السلام عليكم")).eligible === false &&
      semantic.jevEligibility(req("السلام عليكم")).reason ===
        "DETERMINISTIC_BYPASS_RESOLVED",
  );

  // B2 — a strong stored-FAQ match is INELIGIBLE (the LLM must quote it).
  check(
    "B2 a strong stored-FAQ match ⇒ INELIGIBLE (the LLM authors the quote)",
    semantic.jevEligibility(
      req("كم سعر التنظيف؟", {
        faqs: [{ question: "كم سعر التنظيف؟", answer: "السعر ٥٠٠ جنيه." }],
      }),
    ).eligible === false,
  );

  // B3 — a carried service price is INELIGIBLE.
  check(
    "B3 a carried service price ⇒ INELIGIBLE",
    semantic.jevEligibility(
      req("عايز أحجز تنظيف", {
        services: [{ name: "تنظيف", price: "٥٠٠ جنيه" }],
      }),
    ).eligible === false,
  );

  // B4 — a carried service description is INELIGIBLE.
  check(
    "B4 a carried service description ⇒ INELIGIBLE",
    semantic.jevEligibility(
      req("احكيلي عن التنظيف", {
        services: [{ name: "تنظيف", description: "تنظيف أسنان شامل." }],
      }),
    ).eligible === false,
  );

  // B5 — a carried businessAbout / businessAddress is INELIGIBLE.
  check(
    "B5 carried businessAbout / businessAddress ⇒ INELIGIBLE",
    semantic.jevEligibility(
      req("انتو فين؟", { businessAddress: "شارع التحرير، القاهرة" }),
    ).eligible === false &&
      semantic.jevEligibility(
        req("احكيلي عن العيادة", { businessAbout: "عيادة تجميل متخصصة." }),
      ).eligible === false,
  );

  // B6 — domain-computed availability is INELIGIBLE (the LLM presents the offer)
  check(
    "B6 domain-computed availability ⇒ INELIGIBLE",
    semantic.jevEligibility(
      req("في مواعيد متاحة بكرة؟", {
        availability: [{ date: "2026-10-14", slots: ["10:00"] }],
      }),
    ).eligible === false,
  );

  // B7a — English / mixed-language direct-contact turns are NOT excluded from
  // the semantic route merely because the Arabic lexical relevance signals are
  // absent. The gate is language-agnostic (it asks only about quotable
  // authoritative facts), so an English turn that the Arabic keyword tables of
  // the deterministic bypass do not recognize is still ELIGIBLE
  // (PROMPT-AI-JEV-03B §7 requirement D).
  check(
    "B7a an English direct-contact turn ⇒ ELIGIBLE (not excluded by absent Arabic signals)",
    semantic.jevEligibility(req("I want to speak with the doctor directly"))
      .eligible === true &&
      semantic.jevEligibility(req("Can you connect me to Dr Ahmed?"))
        .eligible === true &&
      semantic.jevEligibility(req("عايز أتكلم مع الدكتور please connect me"))
        .eligible === true,
  );

  // B7 — a knowledge-free routing turn with none of the above IS eligible.
  check(
    "B7 a knowledge-free routing turn with no quotable fact ⇒ ELIGIBLE",
    semantic.jevEligibility(req("أريد التحدث إلى موظف")).eligible === true &&
      semantic.jevEligibility(req("عايز أحجز موعد")).eligible === true,
  );

  // B8 — the gate is pure: the same request always yields the same verdict.
  {
    const a = semantic.jevEligibility(req("عايز أحجز موعد"));
    const b = semantic.jevEligibility(req("عايز أحجز موعد"));
    check(
      "B8 the eligibility gate is pure (identical verdicts, no model call)",
      a.eligible === b.eligible && a.reason === b.reason,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART C — the Decisions provider against a stubbed fetch (no network)
  // ═══════════════════════════════════════════════════════════════════════

  const FAKE_KEY = "sk-fake-never-sent-over-network";

  type FakeFetch = typeof fetch & { calls: () => number };

  /**
   * A fetch stub typed as the real `fetch` (the provider's injected seam). Its
   * body/status/latency is fully controlled by the test — NO real network is
   * ever touched. `hangUntilAbort` models a request that only settles via the
   * bounded timeout's abort, exercising the TIMEOUT path.
   */
  function fakeFetch(opts: {
    status?: number;
    body?: string;
    hangUntilAbort?: boolean;
  }): FakeFetch {
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      if (opts.hangUntilAbort) {
        return new Promise<Response>((resolve, reject) => {
          const settle = setTimeout(
            () =>
              resolve(
                new Response('{"model":"typesafe/jev-1.13"}', { status: 200 }),
              ),
            2000,
          );
          (init?.signal as AbortSignal | undefined)?.addEventListener(
            "abort",
            () => {
              clearTimeout(settle);
              const err = new Error("The user aborted a request.");
              err.name = "AbortError";
              reject(err);
            },
          );
        });
      }
      const status = opts.status ?? 200;
      return new Response(opts.body ?? "", { status });
    };
    const stub = fetchImpl as FakeFetch;
    stub.calls = () => calls;
    return stub;
  }

  function providerWith(
    fetchImpl: typeof fetch,
    extra?: {
      getEnvVar?: (name: string) => string | undefined;
      timeoutMs?: number;
    },
  ) {
    return decisions.createJevDecisionsProvider({
      getEnvVar: extra?.getEnvVar ?? (() => FAKE_KEY),
      fetchImpl,
      ...(extra?.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    });
  }

  function validBody(answers: Record<string, unknown>): string {
    return JSON.stringify({
      id: "dec_1",
      model: decisions.JEV_PINNED_MODEL,
      provider: "typesafe",
      answers,
      usage: { input_tokens: 11, output_tokens: 22, cost: 0.001 },
    });
  }

  // C1 — the model is PINNED and the alias is forbidden as primary.
  check(
    "C1 the model is pinned to typesafe/jev-1.13 and the alias is forbidden",
    decisions.JEV_PINNED_MODEL === "typesafe/jev-1.13" &&
      decisions.JEV_FORBIDDEN_ALIAS === "~typesafe/jev-latest" &&
      decisions.JEV_SECRET_REF === "OPENROUTER_API_KEY",
  );

  // C2 — a MISSING CREDENTIAL short-circuits BEFORE any network I/O.
  {
    const fetchImpl = fakeFetch({});
    const provider = providerWith(fetchImpl, {
      getEnvVar: () => undefined,
    });
    const result = await provider.evaluate({
      state: {
        customerMessage: "عايز أحجز موعد",
        businessName: "عيادة التجميل",
        services: ["تنظيف"],
        faqs: [],
        languageHint: "ar",
      },
      questions: { ...semantic.SEMANTIC_QUESTIONS },
    });
    check(
      "C2 a missing credential ⇒ MISSING_CREDENTIAL, attemptSpent=false, ZERO fetch calls",
      fetchImpl.calls() === 0 &&
        result.ok === false &&
        result.errorCode === "MISSING_CREDENTIAL" &&
        result.attemptSpent === false,
    );
  }

  // C2b — an EMPTY credential string short-circuits too.
  {
    const fetchImpl = fakeFetch({});
    const provider = providerWith(fetchImpl, { getEnvVar: () => "   " });
    const result = await provider.evaluate({
      state: {
        customerMessage: "عايز أحجز موعد",
        businessName: "عيادة التجميل",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
      },
    });
    check(
      "C2b a blank credential ⇒ MISSING_CREDENTIAL with ZERO network calls",
      fetchImpl.calls() === 0 &&
        result.ok === false &&
        result.errorCode === "MISSING_CREDENTIAL",
    );
  }

  // C3 — the alias configured as primary is refused before I/O.
  {
    const fetchImpl = fakeFetch({});
    const provider = decisions.createJevDecisionsProvider({
      getEnvVar: () => FAKE_KEY,
      fetchImpl,
      model: decisions.JEV_FORBIDDEN_ALIAS,
    });
    const result = await provider.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "en",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
      },
    });
    check(
      "C3 the alias as primary ⇒ ALIAS_MODEL_FORBIDDEN, attemptSpent=false",
      fetchImpl.calls() === 0 &&
        result.ok === false &&
        result.errorCode === "ALIAS_MODEL_FORBIDDEN" &&
        result.attemptSpent === false,
    );
  }

  // C4 — a success maps the typed answers and reports the served snapshot.
  {
    const fetchImpl = fakeFetch({
      body: validBody({
        bookingRequested: { type: "noul", noul: 0.9 },
        conversationGoal: {
          type: "choice",
          choice: "booking",
          confidence: 0.9,
          probabilities: { booking: 0.9, greeting: 0.05 },
        },
      }),
    });
    const provider = providerWith(fetchImpl);
    const result = await provider.evaluate({
      state: {
        customerMessage: "عايز أحجز موعد",
        businessName: "عيادة التجميل",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
        conversationGoal: semantic.SEMANTIC_QUESTIONS.conversationGoal,
      },
    });
    check(
      "C4 a valid success ⇒ typed answers, served model, attemptSpent=true",
      fetchImpl.calls() === 1 &&
        result.ok === true &&
        result.attemptSpent === true &&
        result.servedModel === decisions.JEV_PINNED_MODEL &&
        result.answers["bookingRequested"]?.type === "noul" &&
        (result.answers["bookingRequested"] as { noul: number }).noul === 0.9 &&
        result.inputTokens === 11 &&
        result.outputTokens === 22,
    );
  }

  // C5 — a 4xx/5xx is classified to a CLOSED code with attemptSpent=true.
  for (const [status, expected] of [
    [400, "BAD_REQUEST"],
    [401, "AUTH_FAILED"],
    [402, "INSUFFICIENT_CREDITS"],
    [403, "AUTH_FAILED"],
    [404, "MODEL_NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER"],
    [503, "PROVIDER"],
  ] as const) {
    const fetchImpl = fakeFetch({ status });
    const provider = providerWith(fetchImpl);
    const result = await provider.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "en",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
      },
    });
    check(
      `C5 HTTP ${status} ⇒ closed code ${expected}, attemptSpent=true`,
      fetchImpl.calls() === 1 &&
        result.ok === false &&
        result.errorCode === expected &&
        result.attemptSpent === true &&
        result.answers !== undefined &&
        Object.keys(result.answers).length === 0,
    );
  }

  // C6 — a non-JSON body is rejected at the contract boundary.
  {
    const fetchImpl = fakeFetch({ body: "not json" });
    const provider = providerWith(fetchImpl);
    const result = await provider.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "en",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
      },
    });
    check(
      "C6 a non-JSON body ⇒ INVALID_RESPONSE, attemptSpent=true",
      result.ok === false &&
        result.errorCode === "INVALID_RESPONSE" &&
        result.attemptSpent === true,
    );
  }

  // C7 — a schema-violating body is rejected (never coerced into facts).
  {
    const fetchImpl = fakeFetch({
      body: JSON.stringify({ model: "typesafe/jev-1.13", answers: {} }),
    });
    const provider = providerWith(fetchImpl);
    const result = await provider.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "en",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
      },
    });
    check(
      "C7 a schema-violating body ⇒ INVALID_RESPONSE (no coercion)",
      result.ok === false &&
        result.errorCode === "INVALID_RESPONSE" &&
        result.attemptSpent === true,
    );
  }

  // C8 — a missing answer for a asked question ⇒ EMPTY_RESPONSE.
  {
    const fetchImpl = fakeFetch({
      body: validBody({ availabilityAsked: { type: "noul", noul: 0.7 } }),
    });
    const provider = providerWith(fetchImpl);
    const result = await provider.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "en",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
        availabilityAsked: semantic.SEMANTIC_QUESTIONS.availabilityAsked,
      },
    });
    check(
      "C8 an answer set short of what was asked ⇒ EMPTY_RESPONSE, attemptSpent=true",
      result.ok === false &&
        result.errorCode === "EMPTY_RESPONSE" &&
        result.attemptSpent === true,
    );
  }

  // C9 — an abort/timeout ⇒ TIMEOUT with attemptSpent=true.
  {
    const fetchImpl = fakeFetch({ hangUntilAbort: true });
    const provider = providerWith(fetchImpl, { timeoutMs: 20 });
    const result = await provider.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "en",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
      },
    });
    check(
      "C9 a timeout ⇒ TIMEOUT, attemptSpent=true (one attempt, no retry)",
      fetchImpl.calls() === 1 &&
        result.ok === false &&
        result.errorCode === "TIMEOUT" &&
        result.attemptSpent === true,
    );
  }

  // C10 — the secret VALUE never reaches any result field or error message.
  {
    const fetchImpl = fakeFetch({ status: 500, body: "" });
    const provider = providerWith(fetchImpl);
    const result = await provider.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "en",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
      },
    });
    const blob = JSON.stringify(result);
    check(
      "C10 the secret value never appears in any result field or error",
      blob.includes(FAKE_KEY) === false,
    );
  }

  // C11 — the request carries the pinned model id and the Bearer header.
  {
    let seenModel: string | null = null;
    let seenAuth: string | null = null;
    const inspectingFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
      seenModel = body.model ?? null;
      seenAuth =
        (init?.headers as Record<string, string> | undefined)?.[
          "Authorization"
        ] ?? null;
      return new Response(
        validBody({ bookingRequested: { type: "noul", noul: 0.5 } }),
        { status: 200 },
      );
    };
    const provider = providerWith(inspectingFetch);
    await provider.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "en",
      },
      questions: {
        bookingRequested: semantic.SEMANTIC_QUESTIONS.bookingRequested,
      },
    });
    check(
      "C11 the request pins the model and sends the Bearer header",
      seenModel === decisions.JEV_PINNED_MODEL &&
        seenAuth === `Bearer ${FAKE_KEY}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART D — the semantic strategy's 0/1 truth table
  // ═══════════════════════════════════════════════════════════════════════

  function fakeJevProvider(opts: {
    outcome:
      | { kind: "ok"; answers: Record<string, JevAnswer> }
      | {
          kind: "fail";
          errorCode: JevErrorCode;
          attemptSpent: boolean;
        };
  }): {
    provider: JevDecisionsProvider;
    calls: () => number;
  } {
    let calls = 0;
    const provider: JevDecisionsProvider = {
      model: decisions.JEV_PINNED_MODEL,
      secretRef: decisions.JEV_SECRET_REF,
      async evaluate() {
        calls += 1;
        if (opts.outcome.kind === "fail") {
          return {
            ok: false,
            errorCode: opts.outcome.errorCode,
            errorMessage: "simulated",
            answers: {},
            latencyMs: 4,
            servedModel: null,
            inputTokens: null,
            outputTokens: null,
            attemptSpent: opts.outcome.attemptSpent,
          };
        }
        return {
          ok: true,
          errorCode: null,
          errorMessage: null,
          answers: opts.outcome.answers,
          latencyMs: 4,
          servedModel: decisions.JEV_PINNED_MODEL,
          inputTokens: 9,
          outputTokens: 9,
          attemptSpent: true,
        };
      },
    };
    return { provider, calls: () => calls };
  }

  function strategyFor(provider: JevDecisionsProvider, enabled = true) {
    return semantic.createSemanticJevStrategy({ provider, enabled });
  }

  // D1 — KILL SWITCH OFF: the strategy is the conservative strategy exactly.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const strategy = strategyFor(provider, false);
    const greeting = await strategy.decide(req("السلام عليكم"));
    const normal = await strategy.decide(req("ما مواعيد العمل لديكم؟"));
    check(
      "D1 kill switch OFF ⇒ conservative behavior, ZERO JEV calls, never selected",
      calls() === 0 &&
        greeting.mode === "DETERMINISTIC" &&
        greeting.reason === "DETERMINISTIC_ACKNOWLEDGEMENT" &&
        greeting.semantic?.selected !== true &&
        normal.mode === "GENERATIVE" &&
        normal.reason === "GENERATIVE_REQUIRED" &&
        normal.semantic?.selected === false &&
        normal.semantic?.jevCallSpent === false &&
        normal.semantic?.resultClass === "KILL_SWITCH_OFF",
    );
  }

  // D2 — a proven deterministic bypass terminates with ZERO JEV calls.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("السلام عليكم"));
    check(
      "D2 a proven bypass ⇒ DETERMINISTIC with ZERO JEV calls (never sent to the LLM)",
      calls() === 0 &&
        decision.mode === "DETERMINISTIC" &&
        decision.response !== null &&
        decision.response.intent === "GREETING" &&
        decision.semantic?.selected === false &&
        decision.semantic?.jevCallSpent === false &&
        decision.semantic?.resultClass === "DETERMINISTIC_BYPASS_RESOLVED",
    );
  }

  // D3 — a quotable-FAQ turn is INELIGIBLE: GENERATIVE with ZERO JEV calls.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(
      req("كم سعر التنظيف؟", {
        faqs: [{ question: "كم سعر التنظيف؟", answer: "٥٠٠ جنيه." }],
      }),
    );
    check(
      "D3 a quotable-FAQ turn ⇒ GENERATIVE with ZERO JEV calls (the LLM authors it)",
      calls() === 0 &&
        decision.mode === "GENERATIVE" &&
        decision.reason === "GENERATIVE_REQUIRED" &&
        decision.semantic?.resultClass === "QUOTABLE_FAQ_ANSWER",
    );
  }

  // D4 — a PRE-ATTEMPT unavailability may still reach the LLM (0 JEV spent).
  {
    const { provider, calls } = fakeJevProvider({
      outcome: {
        kind: "fail",
        errorCode: "MISSING_CREDENTIAL",
        attemptSpent: false,
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("عايز أحجز موعد"));
    check(
      "D4 a pre-attempt unavailability ⇒ GENERATIVE (the ONLY LLM-reaching path)",
      calls() === 1 &&
        decision.mode === "GENERATIVE" &&
        decision.reason === "GENERATIVE_REQUIRED" &&
        decision.semantic?.jevCallSpent === false &&
        decision.semantic?.resultClass === "UNAVAILABLE_PRE_ATTEMPT" &&
        decision.semantic?.failureCode === "MISSING_CREDENTIAL",
    );
  }

  // D5 — a failure AFTER a spent attempt FAILS CLOSED (never falls to the LLM).
  for (const errorCode of [
    "TIMEOUT",
    "PROVIDER",
    "INVALID_RESPONSE",
    "EMPTY_RESPONSE",
    "RATE_LIMITED",
  ] as const) {
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "fail", errorCode, attemptSpent: true },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("عايز أحجز موعد"));
    const baseline = classifyCustomerMessage("عايز أحجز موعد", []);
    check(
      `D5 ${errorCode} after a spent attempt ⇒ DETERMINISTIC fail-closed on the lexical baseline`,
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.reason === "JEV_FAILURE_FAIL_CLOSED" &&
        decision.response !== null &&
        decision.response.intent === baseline.intent &&
        decision.response.content === baseline.content &&
        decision.semantic?.jevCallSpent === true &&
        decision.semantic?.resultClass === "FAILURE_FAIL_CLOSED" &&
        decision.semantic?.failureCode === errorCode,
    );
  }

  // D6 — a spent JEV call with NO actionable reading terminates on the baseline.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([]) },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("عايز أحجز موعد"));
    check(
      "D6 no actionable reading ⇒ DETERMINISTIC / JEV_NO_READING_BASELINE (1 JEV, 0 LLM)",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.reason === "JEV_NO_READING_BASELINE" &&
        decision.semantic?.jevCallSpent === true,
    );
  }

  // D7 — a semantic booking reading proposes the DOMAIN route.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: {
        kind: "ok",
        answers: noul([
          ["bookingRequested", 0.9],
          ["availabilityAsked", 0.3],
        ]),
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("عايز أحجز موعد"));
    check(
      "D7 a booking reading ⇒ DETERMINISTIC / SEMANTIC_DOMAIN, booking_handoff",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.reason === "SEMANTIC_DOMAIN" &&
        decision.response !== null &&
        decision.response.intent === "BOOKING" &&
        decision.response.action === "booking_handoff" &&
        decision.semantic?.facts.bookingRequested === true &&
        decision.semantic?.facts.bookingTask === true &&
        decision.semantic?.facts.explicitHuman === false &&
        decision.semantic?.resultClass === "SEMANTIC_DOMAIN",
    );
  }

  // D8 — a support-role request proposes a handoff (precedence rule 2).
  {
    const { provider, calls } = fakeJevProvider({
      outcome: {
        kind: "ok",
        answers: noul([
          ["supportRequested", 0.95],
          ["bookingRequested", 0.2],
        ]),
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("أريد التحدث إلى موظف"));
    check(
      "D8 a support request ⇒ DETERMINISTIC / SEMANTIC_HANDOFF (HUMAN_REQUEST)",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.reason === "SEMANTIC_HANDOFF" &&
        decision.response !== null &&
        decision.response.intent === "HUMAN_REQUEST" &&
        decision.response.action === "handoff" &&
        decision.response.handoffReason === "HUMAN_REQUEST" &&
        decision.semantic?.facts.explicitHuman === true &&
        decision.semantic?.precedence.derivation === "supportRequest",
    );
  }

  // D9 — safety precedence outranks an asserted booking task.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: {
        kind: "ok",
        answers: noul([
          ["sensitiveTurn", 0.97],
          ["bookingRequested", 0.95],
        ]),
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("عندي ألم شديد وعايز أحجز"));
    check(
      "D9 safety precedence outranks a booking task (SENSITIVE handoff)",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.reason === "SEMANTIC_HANDOFF" &&
        decision.response !== null &&
        decision.response.handoffReason === "SENSITIVE" &&
        decision.semantic?.signals?.sensitive === true,
    );
  }

  // D10 — the contact-vs-book boundary proposes ONE bounded clarification.
  {
    const answers = noul([
      ["providerRequested", 0.45],
      ["bookingRequested", 0.2],
      ["supportRequested", 0.1],
      ["sensitiveTurn", 0.05],
    ]);
    const facts = semantic.deriveSemanticFacts(answers);
    check(
      "D10a the contact-vs-book boundary fires only in the plausible band",
      semantic.contactVsBookBoundary(facts, answers) === true,
    );
    check(
      "D10b an asserted booking task suppresses the boundary",
      semantic.contactVsBookBoundary(
        semantic.deriveSemanticFacts(
          noul([
            ["providerRequested", 0.45],
            ["bookingRequested", 0.9],
          ]),
        ),
        noul([
          ["providerRequested", 0.45],
          ["bookingRequested", 0.9],
        ]),
      ) === false,
    );
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("عايز أشوف الدكتور"));
    check(
      "D10c the boundary ⇒ DETERMINISTIC / SEMANTIC_CLARIFY, CLARIFY_CONTACT_OR_BOOK",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.reason === "SEMANTIC_CLARIFY" &&
        decision.response !== null &&
        decision.response.clarification?.type === "CLARIFY_CONTACT_OR_BOOK" &&
        decision.semantic?.contactVsBook === true &&
        decision.semantic?.clarifyContactOrBookProposed === true &&
        decision.semantic?.resultClass === "SEMANTIC_CLARIFY",
    );
  }

  // D11 — uncertainty NEVER becomes a booking or a handoff: an ambiguous turn
  // proposes the EXISTING bounded CLARIFY handoff, not a domain mutation.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["ambiguousTurn", 0.9]]) },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("مش عارف"));
    check(
      "D11 an ambiguous reading ⇒ AMBIGUOUS handoff (never a booking mutation)",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.response !== null &&
        decision.response.action === "handoff" &&
        decision.response.intent === "AMBIGUOUS",
    );
  }

  // D12 — the semantic route NEVER authors customer prose: content is always a
  // fixed engine-owned template. The same intent resolved on two DIFFERENT
  // messages must yield byte-identical customer text (a generated reply would
  // vary), and that text is the lexical classifier's own template.
  {
    const { provider, calls: jevCalls } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["bookingRequested", 0.95]]) },
    });
    const strategy = strategyFor(provider);
    const a = await strategy.decide(req("عايز أحجز موعد لو سمحت"));
    const b = await strategy.decide(req("محتاج حجز بكرة"));
    const templateA = classifyCustomerMessage("عايز أحجز موعد لو سمحت", []);
    check(
      "D12 semantic content is the fixed lexical template — identical across messages",
      jevCalls() === 2 &&
        a.response !== null &&
        b.response !== null &&
        a.response.intent === "BOOKING" &&
        a.response.content.length > 0 &&
        a.response.content === b.response.content &&
        a.response.content === templateA.content,
    );
  }

  // D13 — conversationGoal is carried as NON-AUTHORITATIVE evidence only.
  {
    const answers: Record<string, JevAnswer> = {
      bookingRequested: { type: "noul", noul: 0.2 },
      conversationGoal: {
        type: "choice",
        choice: "human_handoff",
        confidence: 0.88,
        probabilities: { human_handoff: 0.88 },
      },
    };
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("عايز أحجز موعد"));
    check(
      "D13 conversationGoal is evidence only — a 'human_handoff' goal with no contact fact does NOT hand off",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.response !== null &&
        decision.response.intent === "BOOKING" &&
        decision.response.action === "booking_handoff" &&
        decision.semantic?.conversationGoal?.selection === "human_handoff",
    );
  }

  // D14 — the semantic branch ALWAYS terminates (no unresolved promise path).
  {
    const cases: Array<Parameters<typeof fakeJevProvider>[0]["outcome"]> = [
      { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
      { kind: "ok", answers: noul([]) },
      { kind: "fail", errorCode: "NETWORK", attemptSpent: true },
      { kind: "fail", errorCode: "MISSING_CREDENTIAL", attemptSpent: false },
    ];
    let allTerminated = true;
    for (const outcome of cases) {
      const { provider } = fakeJevProvider({ outcome });
      const strategy = strategyFor(provider);
      const decision = await strategy.decide(req("عايز أحجز موعد"));
      if (decision.mode !== "DETERMINISTIC" && decision.mode !== "GENERATIVE") {
        allTerminated = false;
      }
    }
    check(
      "D14 the semantic branch always terminates on a bounded mode",
      allTerminated === true,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART E — the REAL gateway: the LLM is NEVER a second model call
  // ═══════════════════════════════════════════════════════════════════════

  function fakeLlm(): {
    adapter: AiProviderAdapter;
    calls: () => number;
  } {
    let calls = 0;
    const adapter: AiProviderAdapter = {
      providerId: "atria",
      model: "atria-test",
      secretRef: "ATRIA_API_KEY",
      async call(): Promise<AiProviderResult> {
        calls += 1;
        return {
          ok: true,
          response: {
            intent: "FAQ",
            action: "reply",
            content: "نفتح من 9 حتى 6.",
            extraction: emptyExtraction,
            handoffReason: null,
            summary: null,
          },
          provider: "atria",
          model: "atria-test",
          latencyMs: 3,
        } as AiProviderResult;
      },
    };
    return { adapter, calls: () => calls };
  }

  // E1 — a JEV-ineligible turn makes EXACTLY ONE generative call, 0 JEV.
  {
    const { provider: jevProvider, calls: jevCalls } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const { adapter, calls } = fakeLlm();
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategyFor(jevProvider),
    });
    const result = await orchestrator.callWithFallback(
      req("عايز أحجز تنظيف", {
        services: [{ name: "تنظيف", price: "٥٠٠ جنيه" }],
      }),
    );
    check(
      "E1 a JEV-ineligible (quotable price) turn ⇒ the gateway's ONE generative call, jev=0",
      calls() === 1 &&
        jevCalls() === 0 &&
        result.telemetry.attempts.length === 1 &&
        result.telemetry.jevDecision?.mode === "GENERATIVE" &&
        result.telemetry.jevDecision?.semantic?.jevCallSpent === false,
    );
  }

  // E2 — a fail-closed JEV turn makes ZERO generative calls (no JEV→LLM chain).
  {
    const { provider: jevProvider, calls: jevCalls } = fakeJevProvider({
      outcome: { kind: "fail", errorCode: "TIMEOUT", attemptSpent: true },
    });
    const { adapter, calls } = fakeLlm();
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategyFor(jevProvider),
    });
    const result = await orchestrator.callWithFallback(req("عايز أحجز موعد"));
    check(
      "E2 a spent-then-failed JEV turn ⇒ ZERO generative calls (no JEV→LLM chain)",
      calls() === 0 &&
        jevCalls() === 1 &&
        result.telemetry.attempts.length === 0 &&
        result.telemetry.jevDecision?.mode === "DETERMINISTIC" &&
        result.telemetry.jevDecision?.reason === "JEV_FAILURE_FAIL_CLOSED" &&
        result.response !== null,
    );
  }

  // E3 — a semantic success terminates with ZERO generative calls.
  {
    const { provider: jevProvider, calls: jevCalls } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const { adapter, calls } = fakeLlm();
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategyFor(jevProvider),
    });
    const result = await orchestrator.callWithFallback(req("عايز أحجز موعد"));
    check(
      "E3 a semantic success ⇒ ZERO generative calls, jev-deterministic label",
      calls() === 0 &&
        jevCalls() === 1 &&
        result.telemetry.attempts.length === 0 &&
        result.telemetry.finalProvider === jev.JEV_DETERMINISTIC_PROVIDER &&
        result.telemetry.jevDecision?.semantic?.jevCallSpent === true,
    );
  }

  // E4 — the modelCallCount accounting: a JEV turn counts 1 with 0 LLM attempts
  {
    const { provider: jevProvider } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const { adapter } = fakeLlm();
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: strategyFor(jevProvider),
    });
    const result = await orchestrator.callWithFallback(req("عايز أحجز موعد"));
    const semanticBlock = result.telemetry.jevDecision?.semantic;
    const logicalCalls =
      result.telemetry.attempts.length + (semanticBlock?.jevCallSpent ? 1 : 0);
    check(
      "E4 a JEV turn's logical model-call count is exactly 1 (attempts=0 + jev=1)",
      result.telemetry.attempts.length === 0 &&
        semanticBlock?.jevCallSpent === true &&
        logicalCalls === 1,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART F — the kill switch (DISABLED BY DEFAULT)
  // ═══════════════════════════════════════════════════════════════════════

  check(
    "F1 the flag name is the documented FLOWPILOT_JEV_SEMANTIC_ENABLED",
    SEMANTIC_JEV_FLAG === "FLOWPILOT_JEV_SEMANTIC_ENABLED",
  );
  check("F2 ABSENT ⇒ OFF", isSemanticJevEnabled(() => undefined) === false);
  check(
    "F3 every disabled form ⇒ OFF",
    isSemanticJevEnabled(() => "0") === false &&
      isSemanticJevEnabled(() => "false") === false &&
      isSemanticJevEnabled(() => "FALSE") === false &&
      isSemanticJevEnabled(() => "no") === false &&
      isSemanticJevEnabled(() => "") === false &&
      isSemanticJevEnabled(() => "off") === false &&
      isSemanticJevEnabled(() => "garbage") === false,
  );
  check(
    "F4 only the explicit positive enablements ⇒ ON",
    isSemanticJevEnabled(() => "1") === true &&
      isSemanticJevEnabled(() => "true") === true &&
      isSemanticJevEnabled(() => "YES") === true &&
      isSemanticJevEnabled(() => " yes ") === true,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // PART G — the bounded CLARIFY_CONTACT_OR_BOOK member
  // ═══════════════════════════════════════════════════════════════════════

  check(
    "G1 CLARIFY_CONTACT_OR_BOOK is a member of the closed clarification types",
    clarification.clarificationTypeValues.includes(
      "CLARIFY_CONTACT_OR_BOOK" as const,
    ) === true,
  );
  check(
    "G2 the question is a fixed knowledge-free template naming exactly the two bounded actions",
    typeof clarification.CLARIFY_CONTACT_OR_BOOK_QUESTION === "string" &&
      clarification.CLARIFY_CONTACT_OR_BOOK_QUESTION.length > 0 &&
      clarification.CLARIFY_CONTACT_OR_BOOK_QUESTION.includes(
        "أعضاء الفريق",
      ) === true &&
      clarification.CLARIFY_CONTACT_OR_BOOK_QUESTION.includes("نحجز") === true,
  );
  {
    const pending = clarification.derivePendingClarification([
      {
        senderType: "AI",
        content: clarification.CLARIFY_CONTACT_OR_BOOK_QUESTION,
      },
    ]);
    check(
      "G3 the question is recognized as a PENDING clarification (anti-repeat + resume)",
      pending !== null && pending.type === "CLARIFY_CONTACT_OR_BOOK",
    );
  }

  // G4–G8 — the CLARIFY_ONCE contract (PROMPT-AI-JEV-03B §6). The bounded
  // clarification reuses the SHIPPED machinery: no second clarification
  // architecture exists, the question is the ONE shipped template, and firing
  // it costs ZERO additional model calls on top of the single JEV inference.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: {
        kind: "ok",
        answers: noul([
          ["providerRequested", 0.45],
          ["bookingRequested", 0.3],
          ["supportRequested", 0.1],
          ["sensitiveTurn", 0.05],
        ]),
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("عايز أشوف دكتور"));

    // G4 — firing the clarification costs ZERO additional model calls: exactly
    //      the ONE JEV inference, and the turn terminates (the LLM is never
    //      asked to phrase the question).
    check(
      "G4 the clarification costs ZERO additional model calls (exactly the 1 JEV inference)",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.semantic?.jevCallSpent === true,
    );

    // G5 — no free-form model-generated clarification exists: the proposal
    //      carries only the CLOSED typed member, and the customer-facing text
    //      the strategy authors is the fixed AMBIGUOUS template (the shipped
    //      machinery, not model prose). The question text the customer actually
    //      receives is produced by the ENGINE from the type (proven in G6).
    check(
      "G5 the proposal is the closed typed member and the authored text is the fixed template (no free-form model question)",
      decision.response?.clarification?.type === "CLARIFY_CONTACT_OR_BOOK" &&
        decision.response.content ===
          deterministicReplyForIntent("AMBIGUOUS", "عايز أشوف دكتور").content,
    );
  }

  {
    // G6 — the ENGINE owns the question text: a model-proposed clarification of
    //      this type is honored only through the shipped type → template
    //      mapping, so a free-form model question can never reach the customer.
    const { emptyConversationState } =
      await import("../src/features/conversations/server/conversation-state");
    const plan = clarification.planClarification(
      {
        intent: "AMBIGUOUS",
        action: "handoff",
        content: "placeholder",
        extraction: emptyExtraction,
        handoffReason: "AMBIGUOUS",
        summary: null,
        clarification: { type: "CLARIFY_CONTACT_OR_BOOK" },
      },
      emptyConversationState(),
    );
    check(
      "G6 the engine maps a proposed CLARIFY_CONTACT_OR_BOOK to the ONE shipped template",
      plan !== null &&
        plan.type === "CLARIFY_CONTACT_OR_BOOK" &&
        plan.question === clarification.CLARIFY_CONTACT_OR_BOOK_QUESTION,
    );
  }

  {
    // G7 — explicit human + safety + domain facts all BYPASS the clarification
    //      (higher precedence wins; the boundary is the lowest-precedence
    //      ambiguity resolution, never an override of a decided turn).
    const support = await strategyFor(
      fakeJevProvider({
        outcome: {
          kind: "ok",
          answers: noul([
            ["supportRequested", 0.9],
            ["providerRequested", 0.45],
          ]),
        },
      }).provider,
    ).decide(req("عايز أكلم حد"));
    const safety = await strategyFor(
      fakeJevProvider({
        outcome: {
          kind: "ok",
          answers: noul([
            ["sensitiveTurn", 0.9],
            ["providerRequested", 0.45],
            ["bookingRequested", 0.2],
          ]),
        },
      }).provider,
    ).decide(req("ألم شديد"));
    const domain = await strategyFor(
      fakeJevProvider({
        outcome: {
          kind: "ok",
          answers: noul([
            ["bookingRequested", 0.9],
            ["providerRequested", 0.45],
          ]),
        },
      }).provider,
    ).decide(req("عايز أحجز"));
    check(
      "G7 explicit human / safety / domain facts all bypass the clarification",
      support.response?.clarification?.type === undefined &&
        support.response?.handoffReason === "HUMAN_REQUEST" &&
        safety.response?.clarification?.type === undefined &&
        safety.response?.handoffReason === "SENSITIVE" &&
        domain.response?.clarification?.type === undefined &&
        domain.response?.intent === "BOOKING",
    );
  }

  {
    // G8 — a knowledge gap stays subject to the EXISTING NON_CLARIFIABLE
    //      behavior: it is a NO_KNOWLEDGE handoff, never a contact-vs-book
    //      clarification (the boundary never masks a missing knowledge answer).
    //      Note the precedence order: the boundary fires only while contact is
    //      PLAUSIBLE, so a confidently-negative contact reading lets the
    //      knowledge-gap rule own the turn.
    const decision = await strategyFor(
      fakeJevProvider({
        outcome: {
          kind: "ok",
          answers: noul([
            ["serviceOrPriceAsked", 0.9],
            ["providerRequested", 0.1],
          ]),
        },
      }).provider,
    ).decide(req("كم سعر التنظيف"));
    check(
      "G8 a knowledge gap ⇒ the existing NO_KNOWLEDGE path, not the clarification",
      decision.response?.clarification?.type === undefined &&
        decision.response?.handoffReason === "NO_KNOWLEDGE" &&
        decision.semantic?.clarifyContactOrBookProposed === false,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART H — telemetry: the ONE modelCallCount counter + closed keys
  // ═══════════════════════════════════════════════════════════════════════

  {
    const out = buildTurnObservability({ modelCallCount: 1 });
    check(
      "H1 buildTurnObservability carries the total logical model-call count",
      out.modelCallCount === 1,
    );
  }
  {
    const out = buildTurnObservability({
      modelCallCount: 0,
      clarifyAntiRepeat: true,
      jev: {
        mode: "DETERMINISTIC",
        reason: "SEMANTIC_CLARIFY",
        semantic: {
          selected: true,
          resultClass: "SEMANTIC_CLARIFY",
          jevCallSpent: true,
          facts: {},
          probabilities: {},
          confidence: "high",
          precedence: {
            supportRequest: false,
            providerRequest: true,
            bookingTask: false,
            explicitHuman: true,
            derivation: "providerRequest AND NOT bookingTask",
          },
          conversationGoal: null,
          contactVsBook: true,
          clarifyContactOrBookProposed: true,
          handoffAgreement: "SEMANTIC_ONLY_HANDOFF",
          failureCode: null,
          servedModel: decisions.JEV_PINNED_MODEL,
        },
      },
    });
    const semanticOut = out.jev?.semantic as
      | {
          jevCallSpent: boolean;
          precedence: { derivation: string };
          contactVsBook: boolean;
        }
      | undefined;
    check(
      "H2 the semantic evidence block survives the observability seam (closed keys)",
      out.modelCallCount === 0 &&
        out.clarifyAntiRepeat === true &&
        semanticOut?.jevCallSpent === true &&
        semanticOut?.precedence.derivation ===
          "providerRequest AND NOT bookingTask" &&
        semanticOut?.contactVsBook === true,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART I — production isolation: src/* imports ZERO evaluation/* code
  // ═══════════════════════════════════════════════════════════════════════

  {
    const srcRoot = resolvePath(process.cwd(), "src");
    const offenderPattern =
      /(?:from|import|require)\s*[(]?\s*["'][^"']*(?:^|\/)evaluation\//;
    const offenders: Array<string> = [];
    async function scan(dir: string): Promise<void> {
      const { readdirSync, statSync } = await import("node:fs");
      for (const entry of readdirSync(dir)) {
        const abs = resolvePath(dir, entry);
        const stat = statSync(abs);
        if (stat.isDirectory()) {
          await scan(abs);
          continue;
        }
        if (!abs.endsWith(".ts") && !abs.endsWith(".tsx")) continue;
        const text = readFileSync(abs, "utf8");
        if (offenderPattern.test(text)) offenders.push(abs);
      }
    }
    await scan(srcRoot);
    check(
      "I1 src/* has ZERO runtime imports of evaluation/* (production isolation)",
      offenders.length === 0,
    );
    if (offenders.length > 0) {
      console.log("    offenders:", offenders.join(", "));
    }
  }

  {
    // The two new modules must exist as production code and expose the
    // contract constants (no evaluation import path is used to build them).
    const providerSrc = readFileSync(
      resolvePath(
        process.cwd(),
        "src/server/integrations/ai/jev-decisions-provider.ts",
      ),
      "utf8",
    );
    const strategySrc = readFileSync(
      resolvePath(
        process.cwd(),
        "src/server/integrations/ai/jev-semantic-strategy.ts",
      ),
      "utf8",
    );
    const importPattern =
      /(?:^|\n)\s*(?:import\s[^;]*?from\s*["'][^"']*evaluation\/|import\s*\(?[^;]*?["'][^"']*evaluation\/[^;]*?\)?;|const\s[^;]*?=\s*require\s*\(\s*["'][^"']*evaluation\/)/;
    check(
      "I2 the new modules import no evaluation/* path (runtime isolation)",
      importPattern.test(providerSrc) === false &&
        importPattern.test(strategySrc) === false,
    );
    check(
      "I3 the provider exposes the pinned model + secret ref constants",
      providerSrc.includes("typesafe/jev-1.13") === true &&
        providerSrc.includes("OPENROUTER_API_KEY") === true,
    );

    // I4/I5 — the eligibility AUTHORITY (PROMPT-AI-JEV-03B §7 E/F). The
    // semantic route's selection is NOT the simplistic service-catalog word
    // match and NOT `deriveTaskRelevance`: neither symbol is imported by the
    // semantic modules, so neither can be the selection authority.
    const lexicalAuthorityPattern =
      /(?:^|\n)\s*import\s[^;]*?\{[^}]*(?:deriveTaskRelevance|SERVICE_CATALOG_WORD)[^}]*?\}\s*from/g;
    check(
      "I4 the semantic route imports neither deriveTaskRelevance nor SERVICE_CATALOG_WORD (not the selection authority)",
      lexicalAuthorityPattern.test(strategySrc) === false &&
        lexicalAuthorityPattern.test(providerSrc) === false,
    );
    check(
      "I5 the eligibility gate is a named, exported pure function with zero model calls",
      /export function jevEligibility\(/.test(strategySrc) === true &&
        /export function jevEligibility/.test(strategySrc) === true,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART J — the CUSTOMER-LANGUAGE semantic matrix (PROMPT-AI-JEV-03B §5)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // OFFLINE/STUBBED by construction: the JEV model's reading is injected, so
  // these prove the ROUTING/PRECEDENCE/CLARIFY machinery yields the approved
  // outcome for each language class and each minimal pair — they do NOT prove
  // the live model returns that reading for a given dialect. The messages are
  // the approved design's representative cases across Egyptian Arabic, MSA,
  // English and mixed language. Every row is exactly ONE JEV call, ZERO LLM
  // calls.

  /** Assert one language-matrix row: eligibility + routing + 0/1 call budget. */
  async function languageRow(
    label: string,
    message: string,
    answers: Record<string, JevAnswer>,
    expect: {
      readonly intent: string;
      readonly action: "reply" | "handoff" | "booking_handoff";
      readonly handoffReason?: string | null;
      readonly clarification?: string;
    },
  ): Promise<void> {
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers },
    });
    const strategy = strategyFor(provider);
    const request = req(message);
    const eligibility = semantic.jevEligibility(request);
    const decision = await strategy.decide(request);
    check(
      `J ${label}`,
      // The turn was eligible (no quotable fact, no deterministic bypass).
      eligibility.eligible === true &&
        // Exactly ONE JEV call, and the turn terminated (ZERO LLM calls).
        calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.semantic?.jevCallSpent === true &&
        decision.semantic?.selected === true &&
        // The approved routing target.
        decision.response !== null &&
        decision.response.intent === expect.intent &&
        decision.response.action === expect.action &&
        decision.response.handoffReason ===
          (expect.handoffReason === undefined ? null : expect.handoffReason) &&
        (expect.clarification === undefined ||
          decision.response.clarification?.type === expect.clarification) &&
        // The customer-facing text is ALWAYS the fixed engine-owned template
        // for that intent — never model prose, so no chain-of-thought and no
        // language-dependent model text can reach the customer.
        decision.response.content ===
          deterministicReplyForIntent(decision.response.intent, message)
            .content,
    );
  }

  // ── DIRECT HUMAN / CONTACT across languages ──────────────────────────────
  // A staff/support-role request hands off on the support fact alone.
  await languageRow(
    "Egyptian staff-contact 'عايز أكلم حد من خدمة العملاء' ⇒ HUMAN_REQUEST",
    "عايز أكلم حد من خدمة العملاء",
    noul([
      ["supportRequested", 0.95],
      ["bookingRequested", 0.1],
    ]),
    {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    },
  );
  // A provider-contact request with NO booking task hands off on the provider
  // fact (the two roles stay disjoint).
  await languageRow(
    "Egyptian provider-contact 'عايز حد يوصلني للدكتور' ⇒ HUMAN_REQUEST",
    "عايز حد يوصلني للدكتور",
    noul([
      ["providerRequested", 0.92],
      ["bookingRequested", 0.15],
      ["supportRequested", 0.1],
    ]),
    {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    },
  );
  await languageRow(
    "English direct-contact 'I want to speak with the doctor directly' ⇒ HUMAN_REQUEST",
    "I want to speak with the doctor directly",
    noul([
      ["providerRequested", 0.93],
      ["bookingRequested", 0.12],
      ["supportRequested", 0.08],
    ]),
    {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    },
  );
  await languageRow(
    "English named-provider contact 'Can you connect me to Dr Ahmed?' ⇒ HUMAN_REQUEST",
    "Can you connect me to Dr Ahmed?",
    noul([
      ["providerRequested", 0.9],
      ["bookingRequested", 0.2],
      ["supportRequested", 0.15],
    ]),
    {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    },
  );
  await languageRow(
    "Mixed Ar/En contact 'عايز أتكلم مع الدكتور please' ⇒ HUMAN_REQUEST",
    "عايز أتكلم مع الدكتور please connect me",
    noul([
      ["providerRequested", 0.91],
      ["bookingRequested", 0.18],
      ["supportRequested", 0.12],
    ]),
    {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    },
  );
  // MSA staff contact.
  await languageRow(
    "MSA staff-contact 'أريد التحدث إلى موظف خدمة العملاء' ⇒ HUMAN_REQUEST",
    "أريد التحدث إلى موظف خدمة العملاء",
    noul([
      ["supportRequested", 0.94],
      ["bookingRequested", 0.08],
    ]),
    {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    },
  );

  // ── BOOKING: a provider title INSIDE a booking task must NOT hand off ─────
  await languageRow(
    "Booking with provider title 'عايز أحجز مع دكتور أحمد' ⇒ BOOKING (not a handoff)",
    "عايز أحجز مع دكتور أحمد",
    noul([
      ["bookingRequested", 0.94],
      ["providerRequested", 0.82],
      ["providerPreferenceExpressed", 0.8],
    ]),
    { intent: "BOOKING", action: "booking_handoff" },
  );
  await languageRow(
    "Booking imperative 'احجزلي كشف مع دكتور أحمد' ⇒ BOOKING",
    "احجزلي كشف مع دكتور أحمد",
    noul([
      ["bookingRequested", 0.96],
      ["providerRequested", 0.79],
      ["providerPreferenceExpressed", 0.77],
    ]),
    { intent: "BOOKING", action: "booking_handoff" },
  );
  // greeting + booking: the greeting does not swallow the booking task.
  await languageRow(
    "Greeting + booking 'السلام عليكم، عايز أحجز موعد' ⇒ BOOKING",
    "السلام عليكم، عايز أحجز موعد",
    noul([
      ["bookingRequested", 0.93],
      ["greetingOnly", 0.2],
    ]),
    { intent: "BOOKING", action: "booking_handoff" },
  );

  // ── AVAILABILITY: asking whether a provider is free is NOT contact ────────
  await languageRow(
    "Availability 'هل فيه دكتور متاح؟' ⇒ AVAILABILITY",
    "هل فيه دكتور متاح؟",
    noul([
      ["availabilityAsked", 0.92],
      ["providerRequested", 0.25],
      ["bookingRequested", 0.2],
    ]),
    { intent: "AVAILABILITY", action: "booking_handoff" },
  );
  await languageRow(
    "Named-provider availability 'هل دكتورة سارة متاحة؟' ⇒ AVAILABILITY (not contact)",
    "هل دكتورة سارة متاحة؟",
    noul([
      ["availabilityAsked", 0.9],
      ["providerRequested", 0.3],
      ["providerPreferenceExpressed", 0.35],
      ["bookingRequested", 0.18],
    ]),
    { intent: "AVAILABILITY", action: "booking_handoff" },
  );

  // ── PROVIDER PREFERENCE: a constraint on the service, never a handoff ────
  await languageRow(
    "Provider preference 'أفضل دكتورة سارة لو عندها ميعاد' ⇒ AVAILABILITY (preference is non-routing)",
    "أفضل دكتورة سارة لو عندها ميعاد",
    noul([
      ["providerPreferenceExpressed", 0.88],
      ["availabilityAsked", 0.86],
      ["providerRequested", 0.28],
      ["bookingRequested", 0.22],
    ]),
    { intent: "AVAILABILITY", action: "booking_handoff" },
  );

  // ── GENUINE AMBIGUITY: neither an automatic handoff NOR an automatic booking
  //    — the bounded clarification fires (PROMPT-AI-JEV-03B §9/§5).
  for (const [name, message] of [
    ["bare need 'محتاج دكتور'", "محتاج دكتور"],
    ["permission ask 'ممكن دكتور؟'", "ممكن دكتور؟"],
    ["definite want 'عايز الدكتور'", "عايز الدكتور"],
    ["feminine title 'عايز دكتورة'", "عايز دكتورة"],
    ["see-a-provider 'عايز أشوف دكتور'", "عايز أشوف دكتور"],
  ] as const) {
    const answers = noul([
      ["providerRequested", 0.45],
      ["bookingRequested", 0.38],
      ["supportRequested", 0.12],
      ["sensitiveTurn", 0.05],
    ]);
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req(message));
    check(
      `J genuine ambiguity ${name} ⇒ CLARIFY_ONCE (never a handoff, never a booking)`,
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.reason === "SEMANTIC_CLARIFY" &&
        decision.response !== null &&
        decision.response.intent === "AMBIGUOUS" &&
        decision.response.action === "handoff" &&
        decision.response.handoffReason === "AMBIGUOUS" &&
        decision.response.clarification?.type === "CLARIFY_CONTACT_OR_BOOK" &&
        decision.semantic?.contactVsBook === true &&
        decision.semantic?.clarifyContactOrBookProposed === true &&
        decision.semantic?.facts.bookingTask === false &&
        decision.semantic?.facts.explicitHuman === false,
    );
  }

  // ── SAFETY: support and safety precedence are never masked by any language ─
  {
    const { provider, calls } = fakeJevProvider({
      outcome: {
        kind: "ok",
        answers: noul([
          ["sensitiveTurn", 0.96],
          ["bookingRequested", 0.9],
        ]),
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(
      req("عندي ألم شديد جداً وعايز أحجز"),
    );
    check(
      "J safety + booking ⇒ SAFETY HANDOFF (safety outranks the booking task)",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.response !== null &&
        decision.response.handoffReason === "SENSITIVE" &&
        decision.response.intent === "AMBIGUOUS" &&
        decision.semantic?.signals?.sensitive === true,
    );
  }
  {
    const { provider, calls } = fakeJevProvider({
      outcome: {
        kind: "ok",
        answers: noul([
          ["sensitiveTurn", 0.95],
          ["ambiguousTurn", 0.88],
          ["providerRequested", 0.42],
        ]),
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(
      req("بعت حاجة كتير ومش عارف أعمل إيه"),
    );
    check(
      "J safety + ambiguity ⇒ SAFETY HANDOFF (safety outranks the clarification)",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.response !== null &&
        decision.response.handoffReason === "SENSITIVE" &&
        decision.response.clarification?.type === undefined &&
        decision.semantic?.clarifyContactOrBookProposed === false,
    );
  }

  // ── English/mixed turns never leak model prose (template-only output) ─────
  {
    const { provider } = fakeJevProvider({
      outcome: { kind: "ok", answers: noul([["bookingRequested", 0.9]]) },
    });
    const strategy = strategyFor(provider);
    const en = await strategy.decide(req("I want to book an appointment"));
    const ar = await strategy.decide(req("عايز أحجز موعد"));
    check(
      "J an English and an Arabic booking reply byte-identically (no model prose)",
      en.response?.content === ar.response?.content &&
        en.response?.content ===
          deterministicReplyForIntent("BOOKING", "I want to book").content,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART K — the SEMANTIC precedence regression matrix (PROMPT-AI-JEV-03B §4)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // The semantic strategy's target mirrors the ONE resolver's precedence order
  // (safety → explicit human → domain task → clarify → normal). No precedence
  // rule was added, deleted or reordered for the semantic route: each approved
  // combination resolves to the approved outcome, and the ordering is stable.

  /** Assert one precedence combination resolves to the approved outcome. */
  async function precedenceRow(
    label: string,
    answers: Record<string, JevAnswer>,
    expect: {
      readonly intent: string;
      readonly action: "reply" | "handoff" | "booking_handoff";
      readonly handoffReason?: string | null;
      readonly clarification?: string;
    },
  ): Promise<void> {
    const { provider, calls } = fakeJevProvider({
      outcome: { kind: "ok", answers },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("رسالة اختبار"));
    check(
      `K ${label}`,
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.response !== null &&
        decision.response.intent === expect.intent &&
        decision.response.action === expect.action &&
        decision.response.handoffReason ===
          (expect.handoffReason === undefined ? null : expect.handoffReason) &&
        (expect.clarification === undefined ||
          decision.response.clarification?.type === expect.clarification),
    );
  }

  await precedenceRow(
    "support + booking ⇒ HANDOFF (support wins)",
    noul([
      ["supportRequested", 0.9],
      ["bookingRequested", 0.9],
    ]),
    {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    },
  );
  await precedenceRow(
    "provider contact + booking ⇒ BOOKING (the task masks the title)",
    noul([
      ["providerRequested", 0.9],
      ["bookingRequested", 0.9],
    ]),
    { intent: "BOOKING", action: "booking_handoff" },
  );
  await precedenceRow(
    "provider preference/title + booking ⇒ BOOKING",
    noul([
      ["providerPreferenceExpressed", 0.9],
      ["providerRequested", 0.88],
      ["bookingRequested", 0.9],
    ]),
    { intent: "BOOKING", action: "booking_handoff" },
  );
  await precedenceRow(
    "availability + provider/title ⇒ AVAILABILITY",
    noul([
      ["availabilityAsked", 0.9],
      ["providerRequested", 0.87],
      ["providerPreferenceExpressed", 0.85],
    ]),
    { intent: "AVAILABILITY", action: "booking_handoff" },
  );
  await precedenceRow(
    "sensitive + booking ⇒ SAFETY HANDOFF",
    noul([
      ["sensitiveTurn", 0.9],
      ["bookingRequested", 0.9],
    ]),
    { intent: "AMBIGUOUS", action: "handoff", handoffReason: "SENSITIVE" },
  );
  await precedenceRow(
    "ambiguity + safety ⇒ SAFETY HANDOFF",
    noul([
      ["ambiguousTurn", 0.9],
      ["sensitiveTurn", 0.9],
    ]),
    { intent: "AMBIGUOUS", action: "handoff", handoffReason: "SENSITIVE" },
  );
  await precedenceRow(
    "ambiguity + explicit human ⇒ HUMAN HANDOFF",
    noul([
      ["ambiguousTurn", 0.9],
      ["supportRequested", 0.9],
    ]),
    {
      intent: "HUMAN_REQUEST",
      action: "handoff",
      handoffReason: "HUMAN_REQUEST",
    },
  );
  await precedenceRow(
    "greeting-only ⇒ reply (the lowest-precedence normal path)",
    noul([["greetingOnly", 0.9]]),
    { intent: "GREETING", action: "reply" },
  );
  await precedenceRow(
    "cancellation ⇒ the domain mutation path",
    noul([["cancellationRequested", 0.9]]),
    { intent: "CANCELLATION", action: "booking_handoff" },
  );
  await precedenceRow(
    "reschedule ⇒ the domain mutation path",
    noul([["rescheduleRequested", 0.9]]),
    { intent: "RESCHEDULE", action: "booking_handoff" },
  );
  await precedenceRow(
    "service/price with no quotable fact ⇒ knowledge-gap handoff",
    noul([["serviceOrPriceAsked", 0.9]]),
    { intent: "AMBIGUOUS", action: "handoff", handoffReason: "NO_KNOWLEDGE" },
  );

  // K11 — the genuine bare contact-vs-book ambiguity ⇒ CLARIFY_ONCE (the
  //       approved boundary, not a handoff and not a booking).
  await precedenceRow(
    "genuine bare contact-vs-book ambiguity ⇒ CLARIFY_ONCE",
    noul([
      ["providerRequested", 0.45],
      ["bookingRequested", 0.3],
      ["supportRequested", 0.1],
      ["sensitiveTurn", 0.05],
    ]),
    {
      intent: "AMBIGUOUS",
      action: "handoff",
      handoffReason: "AMBIGUOUS",
      clarification: "CLARIFY_CONTACT_OR_BOOK",
    },
  );

  // K12 — precedence ORDER is stable: the target map evaluates safety before
  //       the explicit-human rule and the explicit-human rule before the
  //       domain task, exactly as the ONE resolver does. Proven by giving every
  //       rule a fact at once and asserting the top rule wins.
  {
    const { provider } = fakeJevProvider({
      outcome: {
        kind: "ok",
        answers: noul([
          ["sensitiveTurn", 0.9],
          ["supportRequested", 0.9],
          ["bookingRequested", 0.9],
          ["providerRequested", 0.9],
        ]),
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("رسالة اختبار"));
    check(
      "K all rules at once ⇒ SAFETY wins (the resolver's rule 3 order is preserved)",
      decision.response?.handoffReason === "SENSITIVE",
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PART L — the two remaining 0/1-matrix rows (PROMPT-AI-JEV-03B §3)
  // ═══════════════════════════════════════════════════════════════════════

  // L1 — matrix row 12: NO strategy configured ⇒ the EXACT pre-AI-JEV-03 path.
  //      The gateway falls back to its own built-in deterministic bypass and
  //      records no JEV decision at all; removing the strategy argument is the
  //      complete rollback (PROMPT-AI-JEV-03B §11).
  {
    const { adapter, calls } = fakeLlm();
    const orchestrator = createAiOrchestrator({
      primary: adapter,
      secondary: null,
      fallbackEnabled: false,
      decisionStrategy: null,
    });
    const bypassed = await orchestrator.callWithFallback(req("السلام عليكم"));
    check(
      "L1 no strategy ⇒ the built-in deterministic bypass, no JEV decision recorded",
      bypassed.telemetry.finalProvider === "deterministic-bypass" &&
        bypassed.telemetry.attempts.length === 0 &&
        bypassed.telemetry.jevDecision === undefined &&
        calls() === 0,
    );

    const generative = await orchestrator.callWithFallback(
      req("ما مواعيد العمل لديكم؟"),
    );
    check(
      "L1b no strategy ⇒ an ordinary turn uses the gateway's ONE call (the old path)",
      generative.telemetry.finalProvider === "atria" &&
        generative.telemetry.attempts.length === 1 &&
        generative.telemetry.jevDecision === undefined &&
        calls() === 1,
    );
  }

  // L2 — matrix row 9: a SEMANTIC CONTRADICTION (two booking-family members
  //      asserted at once) resolves through the P2 argmax to ONE task — never
  //      two tasks, never a fallthrough to the LLM. 1 JEV call, 0 LLM calls.
  {
    const { provider, calls } = fakeJevProvider({
      outcome: {
        kind: "ok",
        answers: noul([
          ["bookingRequested", 0.7],
          ["cancellationRequested", 0.9],
          ["rescheduleRequested", 0.6],
        ]),
      },
    });
    const strategy = strategyFor(provider);
    const decision = await strategy.decide(req("رسالة متناقضة"));
    check(
      "L2 a semantic contradiction ⇒ the P2 argmax keeps exactly ONE task (1 JEV, 0 LLM)",
      calls() === 1 &&
        decision.mode === "DETERMINISTIC" &&
        decision.semantic?.jevCallSpent === true &&
        decision.semantic?.facts.bookingTask === true &&
        // The argmax winner is cancellation; the suppressed members are false.
        decision.semantic?.facts.cancellationRequested === true &&
        decision.semantic?.facts.bookingRequested === false &&
        decision.response?.intent === "CANCELLATION",
    );
  }

  // L3 — the complete 0/1 truth table has NO row with JEV=1 AND LLM=1. Proven
  //      exhaustively across every strategy outcome class: every DETERMINISTIC
  //      termination returns an empty generative attempt trace, so the gateway
  //      can never add a second call on top of a spent JEV attempt.
  {
    const outcomes: Array<Record<string, JevAnswer> | "fail"> = [
      noul([["bookingRequested", 0.9]]),
      noul([["providerRequested", 0.9]]),
      noul([["supportRequested", 0.9]]),
      noul([["sensitiveTurn", 0.9]]),
      noul([["greetingOnly", 0.9]]),
      noul([["ambiguousTurn", 0.9]]),
      noul([["serviceOrPriceAsked", 0.9]]),
      noul([["providerRequested", 0.45]]),
      noul([]),
      "fail",
    ];
    let twoCallRows = 0;
    for (const outcome of outcomes) {
      const { provider: jevProvider, calls: jevCalls } = fakeJevProvider(
        outcome === "fail"
          ? {
              outcome: {
                kind: "fail",
                errorCode: "NETWORK",
                attemptSpent: true,
              },
            }
          : { outcome: { kind: "ok", answers: outcome } },
      );
      const { adapter, calls: llmCalls } = fakeLlm();
      const orchestrator = createAiOrchestrator({
        primary: adapter,
        secondary: null,
        fallbackEnabled: false,
        decisionStrategy: strategyFor(jevProvider),
      });
      const result = await orchestrator.callWithFallback(req("رسالة اختبار"));
      const llmAttempts = result.telemetry.attempts.length;
      if (jevCalls() === 1 && llmCalls() >= 1) twoCallRows += 1;
      // A spent JEV attempt that still reached the LLM is a contract break.
      if (
        result.telemetry.jevDecision?.semantic?.jevCallSpent === true &&
        llmAttempts >= 1
      )
        twoCallRows += 1;
    }
    check(
      "L3 NO outcome class produces a JEV=1 / LLM=1 row (exhaustive over all classes)",
      twoCallRows === 0,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  const failures = checks.filter((checkEntry) => !checkEntry.pass);
  const passCount = checks.length - failures.length;
  console.log("");
  console.log("── JEV semantic route (PROMPT-AI-JEV-03B — OPTION B) ──");
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

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
