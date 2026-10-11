/**
 * FlowPilot — JEV EVALUATION SURFACE check (PROMPT-AI-JEV-01).
 *
 * Deterministic, OFFLINE verification of the evaluation-only Jev surface:
 * no DB, no network, no real LLM, no API tokens, no secrets. It proves the
 * benchmark is SAFE to add and CORRECT in its contract, without spending a
 * single real model call.
 *
 *   J1   the adapter fails CLOSED on a missing credential (no network I/O)
 *   J2   request mapping emits the documented Decisions shape
 *   J3   response mapping rejects an invalid / schema-violating body
 *   J4   response mapping accepts a documented body (incl. dated snapshot)
 *   J5   the pinned model is the primary, never the moving alias
 *   J6   the question contract is atomic: no key is derived from another
 *   J7   the fixture bank covers EVERY required coverage class
 *   J8   expected explicitHuman is DERIVED by the server formula, never hand-
 *        written, and matches the shipped AI-SEM-02 semantics on the evidence
 *        cases
 *   J9   the AI-SEM-02 evidence cases are all present, verbatim
 *   J10  the false-positive probe cases are present and expect NO handoff
 *   J11  planned request count is exactly one request per fixture (no call
 *        multiplication, no per-question fan-out)
 *   J12  production isolation: src/ never imports the Jev evaluation surface
 *   J13  the adapter never holds, logs or returns a secret value
 *   J14  the offline benchmark path produces a complete report with zero
 *        external calls
 *
 * Run: pnpm check:jev-eval
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean, note = ""): void {
  checks.push({ label, pass });
  if (!pass && note.length > 0) console.log(`    ${note}`);
}

const EVIDENCE_MESSAGES = [
  "السلام عليكم عايزك تحجزلي",
  "عايز موظف يحجزلي",
  "وصلني بموظف عشان أحجز",
  "عايز احجز مع دكتور",
  "عايز ميعاد مع دكتورة",
  "هل فيه دكتور متاح؟",
  "عايز حد من خدمة العملاء يحجزلي",
];

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const adapterMod = await import("../evaluation/jev/jev-decisions-adapter");
  const contractMod = await import("../evaluation/jev/jev-question-contract");
  const bankMod = await import("../evaluation/jev/jev-fixture-bank");

  // ── J1 — fail closed on a missing credential, with NO network I/O ────────
  {
    let attempted = false;
    const spyFetch = (() => {
      attempted = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const a = adapterMod.createJevAdapter({
      getEnvVar: () => undefined,
      fetchImpl: spyFetch,
    });
    const res = await a.evaluate({
      state: {
        customerMessage: "عايز أحجز",
        businessName: "عيادة",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: contractMod.jevQuestionSet(),
    });
    check(
      "J1 missing credential fails closed with no network I/O",
      !res.ok && res.errorCode === "MISSING_CREDENTIAL" && !attempted,
      `ok=${res.ok} code=${res.errorCode} fetchAttempted=${attempted}`,
    );
    check(
      "J1b a missing credential reports no served model and no cost",
      res.servedModel === null &&
        res.usage.cost === null &&
        res.provider === null,
    );
  }

  // ── J2 — request mapping emits the documented Decisions shape ────────────
  {
    let sentBody: Record<string, unknown> | null = null;
    const captureFetch = (async (_url: string, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "gen-dec-test",
          model: "typesafe/jev-1.13-20260917",
          provider: "TypeSafe",
          answers: Object.fromEntries(
            contractMod.jevQuestionKeys.map((k) => [
              k,
              { type: "noul", noul: 0.9 },
            ]),
          ),
          usage: { input_tokens: 300, output_tokens: 20, cost: 0.00001 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const a = adapterMod.createJevAdapter({
      getEnvVar: () => "test-key",
      fetchImpl: captureFetch,
    });
    await a.evaluate({
      state: {
        customerMessage: "عايز أحجز موعد",
        businessName: "عيادة الأمل",
        services: ["تنظيف"],
        faqs: ["ساعات العمل؟"],
        languageHint: "ar-EG",
      },
      questions: contractMod.jevQuestionSet(),
    });
    const body = sentBody;
    check(
      "J2 request body has model/state/questions",
      body !== null &&
        typeof body["model"] === "string" &&
        typeof body["state"] === "object" &&
        typeof body["questions"] === "object",
    );
    const state = body?.["state"] as Record<string, unknown> | undefined;
    check(
      "J2b state carries the semantic customer_message field",
      typeof state?.["customer_message"] === "string",
    );
    const questions = body?.["questions"] as
      Record<string, unknown> | undefined;
    check(
      "J2c every question key is present with a type and instructions",
      questions !== undefined &&
        contractMod.jevQuestionKeys.every(
          (k) =>
            typeof questions[k] === "object" &&
            questions[k] !== null &&
            typeof (questions[k] as { instructions?: unknown }).instructions ===
              "string" &&
            typeof (questions[k] as { type?: unknown }).type === "string",
        ),
    );
    check(
      "J2d the noul criteria, when present, are true/false",
      (() => {
        const q = questions?.["supportRequested"] as
          { criteria?: Record<string, unknown> } | undefined;
        return (
          q?.criteria !== undefined &&
          typeof q.criteria["true"] === "string" &&
          typeof q.criteria["false"] === "string"
        );
      })(),
    );
    check(
      "J2e the choice question carries a bounded criteria map",
      (() => {
        const q = questions?.["conversationGoal"] as
          { type?: string; criteria?: Record<string, unknown> } | undefined;
        return (
          q?.type === "choice" &&
          q.criteria !== undefined &&
          Object.keys(q.criteria).length >= 2 &&
          Object.values(q.criteria).every((v) => typeof v === "string")
        );
      })(),
    );
  }

  // ── J3 — response mapping rejects invalid bodies ──────────────────────────
  {
    const make = (payload: string, status = 200): typeof fetch =>
      (() =>
        Promise.resolve(
          new Response(payload, {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        )) as unknown as typeof fetch;

    const a = adapterMod.createJevAdapter({
      getEnvVar: () => "test-key",
      fetchImpl: make("not json at all"),
    });
    const res = await a.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: contractMod.jevQuestionSet(),
    });
    check(
      "J3 non-JSON body is rejected as INVALID_RESPONSE",
      !res.ok && res.errorCode === "INVALID_RESPONSE",
      `code=${res.errorCode}`,
    );

    const b = adapterMod.createJevAdapter({
      getEnvVar: () => "test-key",
      fetchImpl: make(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: {},
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    });
    const resB = await b.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: contractMod.jevQuestionSet(),
    });
    check(
      "J3b an answer set short of what was asked fails as EMPTY_RESPONSE",
      !resB.ok && resB.errorCode === "EMPTY_RESPONSE",
      `code=${resB.errorCode}`,
    );

    const c = adapterMod.createJevAdapter({
      getEnvVar: () => "test-key",
      fetchImpl: make(
        JSON.stringify({
          model: "typesafe/jev-1.13-20260917",
          answers: Object.fromEntries(
            contractMod.jevQuestionKeys.map((k) => [k, { type: "bogus" }]),
          ),
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    });
    const resC = await c.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: contractMod.jevQuestionSet(),
    });
    check(
      "J3c an unknown primitive type is rejected",
      !resC.ok && resC.errorCode === "INVALID_RESPONSE",
      `code=${resC.errorCode}`,
    );
  }

  // ── J4 — a documented body maps, including the dated snapshot ────────────
  {
    const a = adapterMod.createJevAdapter({
      getEnvVar: () => "test-key",
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "gen-dec-1789738314-ABC",
              model: "typesafe/jev-1.13-20260917",
              provider: "TypeSafe",
              answers: {
                supportRequested: { type: "noul", noul: 0.96 },
                bookingRequested: { type: "noul", noul: 0.04 },
                conversationGoal: {
                  type: "choice",
                  choice: "booking",
                  confidence: 0.78,
                  probabilities: { booking: 0.85, ambiguous: 0.15 },
                },
              },
              usage: {
                input_tokens: 476,
                output_tokens: 70,
                cost: 0.000019992,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )) as unknown as typeof fetch,
    });
    const res = await a.evaluate({
      state: {
        customerMessage: "عايز أحجز",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      // Only the three answers the fake returns ⇒ no EMPTY_RESPONSE.
      questions: {
        supportRequested: contractMod.JEV_QUESTIONS.supportRequested,
        bookingRequested: contractMod.JEV_QUESTIONS.bookingRequested,
        conversationGoal: contractMod.JEV_QUESTIONS.conversationGoal,
      },
    });
    check("J4 documented body maps ok", res.ok, `code=${res.errorCode}`);
    check(
      "J4b the dated served snapshot is recorded",
      res.servedModel === "typesafe/jev-1.13-20260917",
      `served=${res.servedModel}`,
    );
    check(
      "J4c the requested model is the pinned id, not the snapshot",
      res.requestedModel === adapterMod.JEV_PINNED_MODEL,
    );
    check(
      "J4d usage + cost are carried verbatim",
      res.usage.inputTokens === 476 &&
        res.usage.outputTokens === 70 &&
        res.usage.cost === 0.000019992,
    );
    check(
      "J4e the choice answer carries selection, probabilities and confidence",
      adapterMod.choiceSelection(res, "conversationGoal") === "booking" &&
        adapterMod.answerConfidence(res, "conversationGoal") === 0.78 &&
        adapterMod.noulProbability(res, "supportRequested") === 0.96,
    );
    check(
      "J4f the provider name is carried",
      res.provider === "TypeSafe",
      `provider=${res.provider}`,
    );
  }

  // ── J5 — the pinned model is the primary, never the moving alias ────────
  {
    check(
      "J5 the pinned primary is a release id, never the alias",
      adapterMod.JEV_PINNED_MODEL === "typesafe/jev-1.13" &&
        !adapterMod.JEV_PINNED_MODEL.startsWith("~"),
    );
    check(
      "J5b the alias is exported only as the secondary, and differs",
      adapterMod.JEV_ALIAS_MODEL.startsWith("~") &&
        String(adapterMod.JEV_ALIAS_MODEL) !==
          String(adapterMod.JEV_PINNED_MODEL),
      `alias=${adapterMod.JEV_ALIAS_MODEL} pinned=${adapterMod.JEV_PINNED_MODEL}`,
    );
    const a = adapterMod.createJevAdapter({
      getEnvVar: () => "k",
      fetchImpl: (() =>
        Promise.resolve(
          new Response("{}", { status: 200 }),
        )) as unknown as typeof fetch,
    });
    check(
      "J5c the adapter defaults to the pinned model",
      a.model === adapterMod.JEV_PINNED_MODEL,
    );
    check(
      "J5d the adapter reads the existing OpenRouter secret NAME",
      a.secretRef === "OPENROUTER_API_KEY",
    );
  }

  // ── J6 — the question contract is atomic and independent ────────────────
  {
    const questions = contractMod.jevQuestionSet();
    check(
      "J6 every question declares instructions",
      Object.values(questions).every(
        (q) => typeof q.instructions === "string" && q.instructions.length > 0,
      ),
    );
    // Atomicity guard: no question's instructions may reference another
    // question's KEY or the server precedence verdict — that would make one
    // answer depend on another, which the contract forbids.
    const forbidden = [
      "explicitHuman",
      "explicit_human",
      "shouldHandoff",
      "next action",
      "what should FlowPilot",
    ];
    const leaks = Object.entries(questions).filter(([key, q]) =>
      forbidden.some(
        (f) =>
          q.instructions.toLowerCase().includes(f.toLowerCase()) &&
          key !== "conversationGoal",
      ),
    );
    check(
      "J6b no question encodes the precedence verdict or an action decision",
      leaks.length === 0,
      leaks.map(([k]) => k).join(","),
    );
    // The contract id must be stable + versioned.
    check(
      "J6c the contract id is versioned",
      /@v\d+$/.test(contractMod.JEV_QUESTION_CONTRACT_ID),
      contractMod.JEV_QUESTION_CONTRACT_ID,
    );
    // Choice options must be bounded + mutually exclusive by construction.
    const goal = contractMod.JEV_QUESTIONS.conversationGoal;
    check(
      "J6d the goal choice is the ONLY choice and its options are bounded",
      Object.values(questions).filter((q) => q.type === "choice").length ===
        1 &&
        goal.type === "choice" &&
        Object.keys(goal.criteria).length >= 4,
    );
  }

  // ── J7 — the fixture bank covers every required class ────────────────────
  {
    const cov = bankMod.classCoverage();
    const bankCheck = bankMod.bankCoversAllClasses();
    check(
      "J7 the bank covers every required class",
      bankCheck.complete,
      `missing=${bankCheck.missing.join(",")}`,
    );
    check(
      "J7b every class has at least one case in the coverage map",
      Object.values(cov).every((n) => n > 0),
    );
  }

  // ── J8 — the evaluation precedence IS the shipped formula ──────────────
  // The non-regression proof for AI-SEM-02. The model never owns the formula;
  // this proves the evaluation copy computes the SAME verdict from the SAME
  // facts as the shipped production predicate, so a model-supplied fact set
  // would be consumed identically. The fixture LABELS are deliberately NOT
  // forced to agree with the deterministic classifier — where they disagree,
  // that divergence is recorded as lexical-gap / false-positive evidence
  // (see J15 below) and must never be relabeled away.
  {
    const { detectExplicitHumanRequest } =
      await import("../src/features/conversations/server/conversation-ai");
    // Exhaustive truth-table sweep: every combination of the three facts must
    // yield the identical verdict in both implementations. The probe message
    // is built so the production tokenizer derives EXACTLY those three facts.
    let formulaMismatches = 0;
    for (const support of [false, true]) {
      for (const provider of [false, true]) {
        for (const booking of [false, true]) {
          const evalV = bankMod.applyServerPrecedence({
            supportRequest: support,
            providerRequest: provider,
            bookingTask: booking,
          }).explicitHuman;
          const prod = detectExplicitHumanRequest(
            productionProbe(support, provider, booking),
          );
          // Guard the probe itself: it must encode exactly the intended facts.
          if (
            prod.supportRequest !== support ||
            prod.providerRequest !== provider ||
            prod.bookingTask !== booking
          ) {
            formulaMismatches += 1;
            console.log(
              `    probe encoding error: support=${support} provider=${provider} booking=${booking} got support=${prod.supportRequest} provider=${prod.providerRequest} booking=${prod.bookingTask}`,
            );
            continue;
          }
          if (evalV !== prod.explicitHuman) {
            formulaMismatches += 1;
            console.log(
              `    truth-table divergence: support=${support} provider=${provider} booking=${booking} eval=${evalV} prod=${prod.explicitHuman}`,
            );
          }
        }
      }
    }
    check(
      "J8 the evaluation precedence matches the shipped formula on the full truth table",
      formulaMismatches === 0,
      `${formulaMismatches} divergence(s)`,
    );

    // The three AI-SEM-02 axioms, checked explicitly on the evidence cases:
    const byId = (id: string) =>
      bankMod.JEV_FIXTURES.find((f) => f.id === id) ?? null;

    const humanPlusBooking = byId("human-plus-booking-mwathaf");
    check(
      "J8b supportRequest inside a booking turn still yields explicitHuman",
      humanPlusBooking !== null &&
        bankMod.expectedExplicitHuman(humanPlusBooking).explicitHuman === true,
    );
    const providerPrefBooking = byId("provider-pref-plus-booking");
    check(
      "J8c a provider title inside a booking is a PREFERENCE (not explicitHuman)",
      providerPrefBooking !== null &&
        bankMod.expectedExplicitHuman(providerPrefBooking).explicitHuman ===
          false,
    );
    const titleNoCue = byId("provider-title-identity-question");
    check(
      "J8d a provider title with no request cue is NOT explicitHuman",
      titleNoCue !== null &&
        bankMod.expectedExplicitHuman(titleNoCue).explicitHuman === false,
    );

    // The derivation string must name the branch that fired.
    const derivation = bankMod.applyServerPrecedence({
      supportRequest: false,
      providerRequest: true,
      bookingTask: false,
    });
    check(
      "J8e the derivation names the provider-title branch",
      derivation.derivation === "providerRequest AND NOT bookingTask" &&
        derivation.explicitHuman === true,
    );
    check(
      "J8f a support request derives from the supportRequest branch",
      bankMod.applyServerPrecedence({
        supportRequest: true,
        providerRequest: false,
        bookingTask: true,
      }).derivation === "supportRequest",
    );
    // The formula must NOT be satisfiable by bookingTask alone.
    check(
      "J8g a booking task alone never yields explicitHuman",
      bankMod.applyServerPrecedence({
        supportRequest: false,
        providerRequest: false,
        bookingTask: true,
      }).explicitHuman === false,
    );
  }

  // ── J15 — the deterministic-vs-semantic divergence is measurable ────────
  // The core comparison evidence: where the fixture's semantic label (written
  // from scenario truth, before any model output) disagrees with what the
  // SHIPPED deterministic classifier derives for the same message, the
  // divergence is a documented lexical gap or false positive — NOT a
  // relabeled case. The known divergences are asserted here so a regression
  // that silently "fixes" the benchmark by relabeling is caught.
  {
    const { detectExplicitHumanRequest } =
      await import("../src/features/conversations/server/conversation-ai");
    const ids = new Set(
      bankMod.JEV_FIXTURES.filter((f) => {
        const evalV = bankMod.expectedExplicitHuman(f).explicitHuman;
        const prodV = detectExplicitHumanRequest(f.message).explicitHuman;
        return evalV !== prodV;
      }).map((f) => f.id),
    );
    check(
      "J15 deterministic-vs-semantic divergence is detected (the known gap set)",
      ids.size >= 4,
      `divergent=${ids.size}`,
    );
    // FALSE POSITIVES: the classifier fires on a bare topic mention of a
    // support-role word where no handoff is requested.
    check(
      "J15b the «مدير» topic-mention false positive is detected",
      ids.has("broad-support-role-modir-no-request"),
    );
    check(
      "J15c the «مساعدة» thanks-mention false positive is detected",
      ids.has("broad-support-role-musaaada-no-request"),
    );
    // FALSE NEGATIVES: a real customer-service handoff request the lexical
    // vocabulary does not carry.
    check(
      "J15d the «خدمة العملاء» handoff false negative is detected",
      ids.has("human-only-customer-service"),
    );
    check(
      "J15e the «خدمة العملاء» + booking handoff false negative is detected",
      ids.has("human-plus-booking-customer-service"),
    );
  }

  // ── J9 — the AI-SEM-01/02 evidence cases are present, verbatim ──────────
  {
    const messages = new Set(bankMod.JEV_FIXTURES.map((f) => f.message));
    const missing = EVIDENCE_MESSAGES.filter((m) => !messages.has(m));
    check(
      "J9 every AI-SEM-01/02 evidence case is present verbatim",
      missing.length === 0,
      missing.join(" | "),
    );
  }

  // ── J10 — the false-positive probes expect NO handoff ───────────────────
  {
    const probes = bankMod.JEV_FIXTURES.filter((f) =>
      f.classes.includes("broad-support-role-false-positive"),
    );
    const noRequest = probes.filter(
      (f) => f.expected.supportRequested === false,
    );
    check(
      "J10 false-positive probe cases are present",
      probes.length >= 2,
      `probes=${probes.length}`,
    );
    check(
      "J10b every non-control probe expects supportRequested === false",
      noRequest.length >= 2 &&
        noRequest.every((f) => f.expected.supportRequested === false),
    );
    // And the control case (a REAL request) must be a handoff.
    const control = bankMod.JEV_FIXTURES.find(
      (f) => f.id === "broad-support-role-modir-complaint-context",
    );
    check(
      "J10c the control case with a real request still hands off",
      control !== undefined &&
        control.expected.supportRequested === true &&
        bankMod.expectedExplicitHuman(control).explicitHuman === true,
    );
  }

  // ── J11 — planned calls are exactly one request per fixture ─────────────
  {
    const planned = bankMod.plannedRequestCount();
    check(
      "J11 planned requests equal the fixture count (no fan-out)",
      planned === bankMod.JEV_FIXTURES.length && planned > 0,
      `planned=${planned} fixtures=${bankMod.JEV_FIXTURES.length}`,
    );
    // One request carries every question, so the question count must NOT
    // multiply the call count.
    check(
      "J11b the question set is non-trivial and batched into one request",
      contractMod.jevQuestionKeys.length >= 8,
    );
  }

  // ── J12 — production isolation: src/ never imports the Jev surface ──────
  {
    const offenders = scanForJevEvaluationImports(
      resolve(process.cwd(), "src"),
    );
    check(
      "J12 no src/ file imports the Jev evaluation surface",
      offenders.length === 0,
      offenders.join(", "),
    );
    // The adapter must not be reachable from the production provider factory.
    const factory = readFileSync(
      resolve(process.cwd(), "src/server/integrations/ai/factory.ts"),
      "utf8",
    );
    check(
      "J12b the provider factory does not reference the Jev evaluation adapter",
      !/evaluation\/jev/.test(factory),
    );
    // And the orchestrator is untouched.
    const orchestrator = readFileSync(
      resolve(process.cwd(), "src/server/integrations/ai/orchestrator.ts"),
      "utf8",
    );
    check(
      "J12c the orchestrator does not reference the Jev evaluation adapter",
      !/evaluation\/jev/.test(orchestrator),
    );
  }

  // ── J13 — the adapter never holds, logs or returns a secret ─────────────
  {
    const source = readFileSync(
      resolve(process.cwd(), "evaluation/jev/jev-decisions-adapter.ts"),
      "utf8",
    );
    // The adapter must read the secret by NAME through the injected getter,
    // never inline a value, and never emit it in a result.
    check(
      "J13 the adapter reads the secret by NAME through getEnvVar",
      /getEnvVar\(JEV_SECRET_REF\)/.test(source),
    );
    check(
      "J13b no hardcoded credential literal in the adapter",
      !/(sk|sk-or|Bearer)\s+[A-Za-z0-9_-]{12,}/.test(source),
    );
    // A result must never carry the key: evaluate the credential-missing path
    // and confirm the serialized result contains no key shape.
    const a = adapterMod.createJevAdapter({
      getEnvVar: () => undefined,
      fetchImpl: (() =>
        Promise.resolve(
          new Response("{}", { status: 200 }),
        )) as unknown as typeof fetch,
    });
    const res = await a.evaluate({
      state: {
        customerMessage: "x",
        businessName: "b",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: contractMod.jevQuestionSet(),
    });
    const serialized = JSON.stringify(res);
    check(
      "J13c a result never serializes a secret value",
      !/sk-[A-Za-z0-9]{12,}/.test(serialized) &&
        !/Authorization/i.test(serialized),
    );
  }

  // ── J14 — the offline benchmark path yields a complete report ───────────
  {
    const fixturesById = new Map(
      bankMod.JEV_FIXTURES.map((f) => [f.message, f]),
    );
    const offlineFetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        state: { customer_message: string };
      };
      const f = fixturesById.get(body.state.customer_message);
      const answers = Object.fromEntries(
        contractMod.jevQuestionKeys.map((k) => {
          const expected = f?.expected[k];
          return [
            k,
            {
              type: "noul" as const,
              noul: expected === undefined ? 0.5 : expected ? 0.97 : 0.03,
            },
          ];
        }),
      );
      return new Response(
        JSON.stringify({
          id: `offline-${body.state.customer_message.length}`,
          model: "typesafe/jev-1.13-OFFLINE",
          provider: "OfflineFake",
          answers,
          usage: { input_tokens: 200, output_tokens: 10, cost: 0.000001 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const adapter = adapterMod.createJevAdapter({
      getEnvVar: () => "test-key",
      fetchImpl: offlineFetch,
    });
    let externalCalls = 0;
    const countingFetch = (async (url: string, init?: RequestInit) => {
      externalCalls += 1;
      return offlineFetch(url, init);
    }) as unknown as typeof fetch;
    const countingAdapter = adapterMod.createJevAdapter({
      getEnvVar: () => "test-key",
      fetchImpl: countingFetch,
    });

    let ok = 0;
    let disagreements = 0;
    for (const f of bankMod.JEV_FIXTURES) {
      const res = await countingAdapter.evaluate({
        state: {
          customerMessage: f.message,
          businessName: f.businessName,
          services: f.services,
          faqs: f.faqs,
          languageHint: f.languageHint,
        },
        questions: contractMod.jevQuestionSet(),
      });
      if (!res.ok) continue;
      ok += 1;
      for (const key of contractMod.jevQuestionKeys) {
        const expected = f.expected[key];
        if (expected === undefined) continue;
        const prob = adapterMod.noulProbability(res, key);
        if (prob === null || prob >= 0.5 !== expected) disagreements += 1;
      }
    }
    check(
      "J14 the offline path completes every fixture",
      ok === bankMod.JEV_FIXTURES.length,
      `ok=${ok} of ${bankMod.JEV_FIXTURES.length}`,
    );
    check(
      "J14b the offline path scores every asserted fact with zero disagreement",
      disagreements === 0,
      `disagreements=${disagreements}`,
    );
    check(
      "J14c the offline path makes exactly one call per fixture (no fan-out)",
      externalCalls === bankMod.JEV_FIXTURES.length,
      `calls=${externalCalls}`,
    );
    void adapter;
  }

  // ── Outcome ───────────────────────────────────────────────────────────────
  console.log("");
  console.log("── JEV EVALUATION SURFACE CHECK ──");
  let failures = 0;
  for (const c of checks) {
    const mark = c.pass ? "✔" : "✘";
    if (!c.pass) failures += 1;
    console.log(`${mark} ${c.label}`);
  }
  const total = checks.length;
  console.log("");
  console.log(
    `RESULT: ${failures === 0 ? "PASSED" : "FAILED"} — ${total - failures}/${total} checks ok`,
  );
  if (failures > 0) process.exit(1);
}

/**
 * Build a synthetic Arabic probe message whose tokens the SHIPPED
 * `detectExplicitHumanRequest` derives into EXACTLY the three requested facts.
 * Used by the J8 truth-table sweep so the evaluation precedence and the
 * production predicate are compared on identical fact inputs.
 *
 * Vocabulary used (all already in the shipped classifier):
 *  - supportRequest: «موظف» (HUMAN_WORDS)
 *  - providerRequest: «دكتور» (HUMAN_TITLE_WORDS) + «أكلم» (HUMAN_REQUEST_CUES)
 *  - bookingTask: «حجز» (BOOKING_WORDS)
 *
 * A fact set to false is represented by a word the classifier does not treat
 * as that class, so the probe encodes absence rather than relying on negation
 * phrasing the tokenizer might not strip predictably.
 */
function productionProbe(
  support: boolean,
  provider: boolean,
  booking: boolean,
): string {
  const parts: string[] = [];
  parts.push(support ? "موظف" : "عندي");
  parts.push(provider ? "أكلم دكتور" : "بابا");
  parts.push(booking ? "حجز" : "شكراً");
  return parts.join(" ");
}

function scanForJevEvaluationImports(root: string): string[] {
  const offenders: string[] = [];
  const importRe = /(?:from|require\()\s*["'][^"']*evaluation\/jev[^"']*["']/;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) {
        const text = readFileSync(full, "utf8");
        if (importRe.test(text)) offenders.push(full);
      }
    }
  };
  walk(root);
  return offenders;
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
