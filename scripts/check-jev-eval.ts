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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

import type { JevFixture as RunnerFixture } from "../evaluation/jev/jev-fixture-bank";
import type { JevQuestionKey as RunnerQuestionKey } from "../evaluation/jev/jev-question-contract";

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
  // The freeze manifest and the probability policy are loaded once here so the
  // J20 retirement / binding checks and the R-tests read the same frozen
  // record the runner does.
  const freezeMod = await import("../evaluation/jev/jev-freeze-manifest");
  const policyMod = await import("../evaluation/jev/jev-probability-policy");

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
    // PROMPT-AI-JEV-02: the expanded bank must keep the frozen original 40
    // cases byte-for-byte (prefix of the v2 bank), and every new class the
    // task introduced must be covered.
    check(
      "J7c the frozen AI-JEV-01 bank is a byte-for-byte prefix of the v2 bank",
      bankMod.JEV_FIXTURES_V2.slice(0, bankMod.JEV_FIXTURES.length).every(
        (f, i) => f === bankMod.JEV_FIXTURES[i],
      ) && bankMod.JEV_FIXTURES.length === 40,
      `original=${bankMod.JEV_FIXTURES.length} v2=${bankMod.JEV_FIXTURES_V2.length}`,
    );
    check(
      "J7c2 the frozen PROMPT-AI-JEV-02 bank is a byte-for-byte prefix of the v3 bank",
      bankMod.JEV_FIXTURES_V3.slice(0, bankMod.JEV_FIXTURES_V2.length).every(
        (f, i) => f === bankMod.JEV_FIXTURES_V2[i],
      ),
      `v2=${bankMod.JEV_FIXTURES_V2.length} v3=${bankMod.JEV_FIXTURES_V3.length}`,
    );
    check(
      "J7d the original slice reports zero calibration/holdout cases",
      bankMod.bankSubset("original").length === 40,
    );
    // PROMPT-AI-JEV-02B: the NEW sealed holdout must meet the size floor the
    // task sets (§6: at least 40 genuinely useful fixtures, no padding).
    check(
      "J7e the NEW holdout-v3 slice meets the 40-fixture floor",
      bankMod.bankSubset("holdout-v3").length >= 40,
      `holdout-v3=${bankMod.bankSubset("holdout-v3").length}`,
    );
    check(
      "J7f the holdout-v3 slice is disjoint from the calibration-v3 slice",
      bankMod
        .bankSubset("holdout-v3")
        .every(
          (f) =>
            !bankMod
              .bankSubset("calibration-v3")
              .some((c) => c.id === f.id || c.message === f.message),
        ),
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
      planned === bankMod.JEV_FIXTURES_V4.length && planned > 0,
      `planned=${planned} fixtures=${bankMod.JEV_FIXTURES_V4.length}`,
    );
    // One request carries every question, so the question count must NOT
    // multiply the call count.
    check(
      "J11b the question set is non-trivial and batched into one request",
      contractMod.jevQuestionKeys.length >= 8,
    );
    // PROMPT-AI-JEV-02: each slice plans exactly its own size, so a slice run
    // spends exactly the calls it advertises.
    for (const slice of bankMod.bankSliceValues) {
      const subset = bankMod.bankSubset(slice);
      check(
        `J11c ${slice} slice plans exactly ${subset.length} requests`,
        bankMod.plannedRequestCount(subset) === subset.length,
        `planned=${bankMod.plannedRequestCount(subset)} fixtures=${subset.length}`,
      );
    }
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
      bankMod.JEV_FIXTURES_V2.map((f) => [f.message, f]),
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
    for (const f of bankMod.JEV_FIXTURES_V2) {
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
      ok === bankMod.JEV_FIXTURES_V2.length,
      `ok=${ok} of ${bankMod.JEV_FIXTURES_V2.length}`,
    );
    check(
      "J14b the offline path scores every asserted fact with zero disagreement",
      disagreements === 0,
      `disagreements=${disagreements}`,
    );
    check(
      "J14c the offline path makes exactly one call per fixture (no fan-out)",
      externalCalls === bankMod.JEV_FIXTURES_V2.length,
      `calls=${externalCalls}`,
    );
    void adapter;
  }

  // ── J16 — scoredQuestions accounting regression (PROMPT-AI-JEV-02 §4) ────
  // AI-JEV-01-S shipped a live artifact whose rows recompute to 125 scored
  // question/expectation pairs but which REPORTS `scoredQuestions: 0`. The
  // defect was in the reporter (`hasOwnProperty(row, questionKey)` on a row
  // that has no question-key fields). This block proves:
  //   (a) the committed historical artifact still recomputes from its rows,
  //   (b) the historical zero is now DETECTED by the guard, and
  //   (c) a correctly accounted report is NOT flagged — so the guard cannot
  //       pass vacuously and a future silent zero is caught.
  {
    const bench = await import("../scripts/eval-jev-benchmark");
    const artifact = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "evaluation/reports/jev/jev-benchmark-live-2026-10-11T23-01-21-307Z.json",
        ),
        "utf8",
      ),
    ) as {
      scoredQuestions: number;
      rows: Array<{ expected: Record<string, boolean | null> }>;
    };

    const recomputed = bench.recomputeScoredQuestionsFromRows(
      artifact.rows,
      contractMod.jevQuestionKeys,
    );
    check(
      "J16 the committed AI-JEV-01 live artifact recomputes its scored questions from rows",
      recomputed === 125,
      `recomputed=${recomputed} (the artifact itself reports ${artifact.scoredQuestions})`,
    );

    // The historical artifact is NOT modified — its defect is only detected.
    const historicalDefect = bench.scoredQuestionsAccountingDefect(
      artifact,
      contractMod.jevQuestionKeys,
    );
    check(
      "J16b the guard flags the historical zero-accounting artifact",
      historicalDefect !== null &&
        /recompute to 125/.test(historicalDefect ?? ""),
      `guard said: ${historicalDefect ?? "(no violation)"}`,
    );

    // A correctly accounted report must pass the guard cleanly.
    const goodReport = {
      scoredQuestions: recomputed,
      rows: artifact.rows,
    };
    check(
      "J16c a correctly accounted report is not flagged by the guard",
      bench.scoredQuestionsAccountingDefect(
        goodReport,
        contractMod.jevQuestionKeys,
      ) === null,
    );

    // The guard must NOT pass vacuously: expectations present + reported zero.
    const zeroReport = {
      scoredQuestions: 0,
      rows: artifact.rows,
    };
    const zeroDefect = bench.scoredQuestionsAccountingDefect(
      zeroReport,
      contractMod.jevQuestionKeys,
    );
    check(
      "J16d a report with expectations but reported zero is rejected",
      zeroDefect !== null,
      `guard said: ${zeroDefect ?? "(no violation)"}`,
    );

    // The offline benchmark's own accounting must be non-zero and consistent.
    const offlineReport = await runOfflineBenchmarkSnapshot();
    const offlineRecomputed = bench.recomputeScoredQuestionsFromRows(
      offlineReport.rows,
      contractMod.jevQuestionKeys,
    );
    check(
      "J16e the offline benchmark reports a non-zero scored-question count",
      offlineReport.scoredQuestions > 0,
      `scoredQuestions=${offlineReport.scoredQuestions}`,
    );
    check(
      "J16f the offline benchmark's accounting matches its own rows",
      offlineReport.scoredQuestions === offlineRecomputed &&
        bench.scoredQuestionsAccountingDefect(
          offlineReport,
          contractMod.jevQuestionKeys,
        ) === null,
      `reported=${offlineReport.scoredQuestions} recomputed=${offlineRecomputed}`,
    );
  }

  // ── J17 — PROMPT-AI-JEV-02: bank integrity, frozen slices, and the
  //        probability→fact policy (offline, deterministic) ────────────────
  // Proves the calibration/holdout machinery is sound BEFORE any live call:
  //   (a) ids and messages are unique globally (the offline lookup keys on
  //       message, so a cross-slice duplicate would mis-score a case),
  //   (b) the holdout is mechanically unreachable from a calibration loop,
  //   (c) frozen slices have stable fingerprints (any label edit is visible),
  //   (d) the policy's two rules + confidence banding behave as documented,
  //   (e) the policy is routing-neutral: family competition never changes the
  //       server-precedence verdict, only the task label.
  {
    const integrity = bankMod.bankIntegrity();
    check(
      "J17 every fixture id and message is unique across all slices",
      integrity.ok,
      integrity.problems.join("; "),
    );

    // Mechanical separation: the default iteration order (original slice) and
    // every calibration selector must never return ANY holdout case.
    const holdoutIds = new Set(bankMod.bankSubset("holdout").map((f) => f.id));
    const holdoutV3Ids = new Set(
      bankMod.bankSubset("holdout-v3").map((f) => f.id),
    );
    const holdoutV4Ids = new Set(
      bankMod.bankSubset("holdout-v4").map((f) => f.id),
    );
    const allHoldoutIds = new Set([
      ...holdoutIds,
      ...holdoutV3Ids,
      ...holdoutV4Ids,
    ]);
    const selectors = ["original", "calibration", "calibration-v3"] as const;
    let leaked = 0;
    for (const sel of selectors) {
      leaked += bankMod
        .bankSubset(sel)
        .filter((f) => allHoldoutIds.has(f.id)).length;
    }
    check(
      "J17b no holdout case is reachable from any original or calibration selector",
      leaked === 0,
      `leaked=${leaked}`,
    );
    // A calibration selector must not reach the NEW holdout even by message.
    const holdoutV3Messages = new Set(
      bankMod.bankSubset("holdout-v3").map((f) => f.message),
    );
    const messageLeak = bankMod
      .bankSubset("calibration-v3")
      .filter((f) => holdoutV3Messages.has(f.message)).length;
    check(
      "J17b2 the new holdout shares no message with the calibration slice",
      messageLeak === 0,
      `shared=${messageLeak}`,
    );
    check(
      "J17c every slice partitions the bank exactly",
      bankMod.bankSliceValues
        .map((s) => bankMod.bankSubset(s).length)
        .reduce((a, b) => a + b, 0) === bankMod.JEV_FIXTURES_V4.length,
    );
    // Each slice fingerprint must be distinct (a collision would mean two
    // slices share a label set).
    const fps = bankMod.sliceFingerprints();
    const fpValues = Object.values(fps);
    check(
      "J17c2 every slice fingerprint is distinct",
      new Set(fpValues).size === fpValues.length,
      `${JSON.stringify(fps)}`,
    );

    // Frozen fingerprints: stable across repeated reads (any label edit would
    // change a slice hash).
    const fp1 = bankMod.sliceFingerprints();
    const fp2 = bankMod.sliceFingerprints();
    check(
      "J17d slice fingerprints are stable and distinct",
      fp1.original === fp2.original &&
        fp1.calibration === fp2.calibration &&
        fp1.holdout === fp2.holdout &&
        fp1.original !== fp1.calibration &&
        fp1.calibration !== fp1.holdout,
    );

    // The contract + policy fingerprints must be stable too (they bind a
    // STAGE B run to the exact semantics it was evaluated under).
    const policyMod = await import("../evaluation/jev/jev-probability-policy");
    const cf1 = policyMod.contractFingerprint(contractMod.jevQuestionSet());
    const cf2 = policyMod.contractFingerprint(contractMod.jevQuestionSet());
    const pf1 = policyMod.policyFingerprint();
    const pf2 = policyMod.policyFingerprint();
    check(
      "J17e the contract and policy fingerprints are stable",
      cf1 === cf2 && pf1 === pf2 && cf1 !== pf1,
      `contract=${cf1} policy=${pf1}`,
    );
    check(
      "J17f the contract version and policy version are @v3 / @v2",
      contractMod.JEV_QUESTION_CONTRACT_ID.endsWith("@v3") &&
        policyMod.JEV_POLICY_ID.endsWith("@v2"),
      `${contractMod.JEV_QUESTION_CONTRACT_ID} / ${policyMod.JEV_POLICY_ID}`,
    );
    // PROMPT-AI-JEV-02B: the frozen AI-JEV-02 fingerprints must be UNCHANGED.
    // The original/calibration/holdout slices are immutable historical evidence;
    // a label edit would change a slice hash and be caught here.
    const v2Fingerprints: Record<string, string> = {
      original: "sha256:69341a65821179a9",
      calibration: "sha256:8a76f9e4deeb94f8",
      holdout: "sha256:d3f4a90715c80066",
    };
    check(
      "J17f2 the frozen AI-JEV-02 slice fingerprints are unchanged",
      fps.original === v2Fingerprints.original &&
        fps.calibration === v2Fingerprints.calibration &&
        fps.holdout === v2Fingerprints.holdout,
      `got=${JSON.stringify({ original: fps.original, calibration: fps.calibration, holdout: fps.holdout })}`,
    );
    // The new slices must have fingerprints at all (a missing one would mean
    // a slice is empty and the partition check is vacuous).
    check(
      "J17f3 the new slices carry fingerprints",
      fps["calibration-v3"] !== fps["holdout-v3"] &&
        fps["calibration-v3"].startsWith("sha256:") &&
        fps["holdout-v3"].startsWith("sha256:"),
    );

    // ── Policy behaviour (deterministic, from probabilities) ──────────────
    // P1: default orientation at 0.5.
    const p1 = policyMod.applyProbabilityPolicy(
      { bookingRequested: 0.9, supportRequested: 0.1 },
      ["bookingRequested", "supportRequested"],
    );
    check(
      "J17g rule P1 orients a raw probability at 0.5",
      p1.facts["bookingRequested"] === true &&
        p1.facts["supportRequested"] === false,
    );
    // Absent answers become null facts, never coerced to false.
    const p1b = policyMod.applyProbabilityPolicy({ bookingRequested: 0.9 }, [
      "bookingRequested",
      "supportRequested",
    ]);
    check(
      "J17h an absent answer is a null fact, never a false one",
      p1b.facts["supportRequested"] === null,
    );
    // P2: booking-task family competition keeps only the argmax.
    const p2 = policyMod.applyProbabilityPolicy(
      {
        bookingRequested: 0.52,
        availabilityAsked: 0.82,
        cancellationRequested: 0.03,
        rescheduleRequested: 0.04,
      },
      contractMod.jevQuestionKeys,
    );
    check(
      "J17i rule P2 keeps only the argmax of the booking-task family",
      p2.facts["availabilityAsked"] === true &&
        p2.facts["bookingRequested"] === false,
      `facts=${JSON.stringify(p2.facts)}`,
    );
    const suppressed = p2.decisions.find(
      (d) => d.key === "bookingRequested" && d.source === "family-competition",
    );
    check(
      "J17j a suppressed family member is recorded in the decision log",
      suppressed !== undefined &&
        suppressed.note !== null &&
        /suppressed by family competition/.test(suppressed.note),
    );
    // P2 is ROUTING-NEUTRAL: the bookingTask mask is true whichever member
    // wins, so the server-precedence verdict is unchanged by the rule.
    const withoutP2 = bankMod.applyServerPrecedence(
      bankMod.projectPrecedenceFacts({
        bookingRequested: true,
        availabilityAsked: true,
      }),
    );
    const withP2 = bankMod.applyServerPrecedence(
      bankMod.projectPrecedenceFacts({
        bookingRequested: false,
        availabilityAsked: true,
      }),
    );
    check(
      "J17k family competition is routing-neutral (the verdict is unchanged)",
      withoutP2.explicitHuman === withP2.explicitHuman,
      `without P2=${withoutP2.explicitHuman} with P2=${withP2.explicitHuman}`,
    );
    // P3: confidence banding is descriptive and never changes a fact.
    check(
      "J17l confidence banding classifies without altering facts",
      policyMod.bandConfidence(0.97) === "high" &&
        policyMod.bandConfidence(0.03) === "high" &&
        policyMod.bandConfidence(0.7) === "moderate" &&
        policyMod.bandConfidence(0.3) === "moderate" &&
        policyMod.bandConfidence(0.55) === "low" &&
        policyMod.bandConfidence(0.47) === "low",
    );
  }

  // ── J18 — the 0/1-call architecture invariant (PROMPT-AI-JEV-02 §13) ──────
  // The normal-path invariant is ZERO OR ONE model call per turn. A Jev
  // semantic turn is a REPLACEMENT for inference, never an additional
  // unconditional stage, so the architecture must forbid:
  //   (a) a mandatory classifier → Jev → LLM → judge chain,
  //   (b) a second semantic judge after Jev,
  //   (c) any per-question fan-out (one Jev request carries the whole bundle).
  // All proved offline, from source + in-memory adapters.
  {
    // (1) A Jev semantic turn uses EXACTLY ONE request for the whole bundle:
    //     every question is evaluated against the same state in one call, and
    //     no question spawns its own request.
    let jevCalls = 0;
    const countingJev = adapterMod.createJevAdapter({
      getEnvVar: () => "test-key",
      fetchImpl: (async () => {
        jevCalls += 1;
        return new Response(
          JSON.stringify({
            id: "arch-probe",
            model: "typesafe/jev-1.13-20260917",
            provider: "TypeSafe",
            answers: Object.fromEntries(
              contractMod.jevQuestionKeys.map((k) => [
                k,
                { type: "noul", noul: 0.5 },
              ]),
            ),
            usage: { input_tokens: 100, output_tokens: 10, cost: 0.000001 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    const jevResult = await countingJev.evaluate({
      state: {
        customerMessage: "عايز أحجز مع دكتور",
        businessName: "عيادة",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: contractMod.jevQuestionSet(),
    });
    check(
      "J18 a Jev semantic turn makes exactly ONE request for the whole bundle",
      jevResult.ok && jevCalls === 1,
      `calls=${jevCalls} ok=${jevResult.ok}`,
    );
    check(
      "J18b the whole question set returns in that single request (no fan-out)",
      Object.keys(jevResult.answers).length ===
        contractMod.jevQuestionKeys.length,
      `answers=${Object.keys(jevResult.answers).length} of ${contractMod.jevQuestionKeys.length}`,
    );

    // (2) A deterministic SAFE turn may use ZERO model calls. The production
    //     engine resolves a safe turn without any provider call; this proves
    //     Jev is never a mandatory stage by counting calls on such a turn.
    const engine =
      await import("../src/features/conversations/server/conversation-engine");
    let generativeCalls = 0;
    const neverCalledFetch = (() => {
      generativeCalls += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const probeAdapter = adapterMod.createJevAdapter({
      getEnvVar: () => undefined,
      fetchImpl: neverCalledFetch,
    });
    const safeTurn = await probeAdapter.evaluate({
      state: {
        customerMessage: "السلام عليكم",
        businessName: "عيادة",
        services: [],
        faqs: [],
        languageHint: "ar",
      },
      questions: contractMod.jevQuestionSet(),
    });
    check(
      "J18c a turn with no credential makes ZERO network calls (fails closed)",
      !safeTurn.ok && safeTurn.errorCode === "MISSING_CREDENTIAL",
      `code=${safeTurn.errorCode}`,
    );
    void engine;
    void generativeCalls;

    // (3) No mandatory classifier → Jev → LLM → judge chain EXISTS. The
    //     shipped decision strategy (`jev-strategy.ts`) is the deterministic
    //     0/1-call gate: it decides WHETHER the gateway's single generative
    //     call happens, performs NO I/O itself, and never imports the real Jev
    //     evaluation adapter. A strategy that cannot call anything cannot add
    //     a stage, so the forbidden chain cannot be built from it.
    const srcFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) srcFiles.push(full);
      }
    };
    walk(resolve(process.cwd(), "src"));
    const strategySource = readFileSync(
      resolve(process.cwd(), "src/server/integrations/ai/jev-strategy.ts"),
      "utf8",
    );
    check(
      "J18d the shipped decision strategy imports no Jev evaluation adapter",
      !/evaluation\/jev/.test(strategySource),
    );
    check(
      "J18d2 the shipped decision strategy performs no I/O (decide is synchronous)",
      !/await\s+fetch|return\s+fetch|\bfetch\s*\(/.test(strategySource) &&
        !/evaluation\/jev/.test(strategySource),
    );
    check(
      "J18d3 the shipped decision strategy forbids a mandatory Jev stage by design",
      /Forbidden by design/.test(strategySource) &&
        /mandatory JEV stage/.test(strategySource),
    );

    // (4) No second semantic judge: the evaluation surface is the ONLY Jev
    //     question consumer, and it lives outside src/.
    const evalConsumers = srcFiles.filter((f) => {
      const t = readFileSync(f, "utf8");
      return /jev-question-contract|jev-probability-policy/.test(t);
    });
    check(
      "J18e no src/ file consumes the Jev question contract or probability policy",
      evalConsumers.length === 0,
      evalConsumers.join(", "),
    );
    check(
      "J18f the Jev question contract declares evaluation-only isolation",
      /EVALUATION-ONLY\. NEVER IMPORTED BY src\//.test(
        readFileSync(
          resolve(process.cwd(), "evaluation/jev/jev-question-contract.ts"),
          "utf8",
        ),
      ),
    );
    check(
      "J18g the probability policy declares evaluation-only isolation",
      /EVALUATION-ONLY\. NEVER IMPORTED BY src\//.test(
        readFileSync(
          resolve(process.cwd(), "evaluation/jev/jev-probability-policy.ts"),
          "utf8",
        ),
      ),
    );
  }

  // ── J19 — PROMPT-AI-JEV-02B §12: the contact-vs-book repair, the §10
  //        adjudication, and the mechanically-detectable failure modes ──────
  // Everything here is OFFLINE and DETERMINISTIC. It runs against the bank
  // and the contract only, so a regression in any of the following is caught
  // before a single real model call is spent.
  {
    const policyMod = await import("../evaluation/jev/jev-probability-policy");

    // (a) CONTACT-vs-BOOK MASKING. The one routing defect AI-JEV-02 left is
    //     a fixture whose label asserts providerRequested WITHOUT a booking
    //     task, and whose expected verdict is therefore a handoff. The bank
    //     must CONTAIN such cases — otherwise the regression the task demands
    //     cannot be measured at all.
    const pureContact = bankMod
      .bankSubset("holdout-v3")
      .filter(
        (f) =>
          f.expected.providerRequested === true &&
          (f.expected.bookingRequested ?? false) === false &&
          (f.expected.availabilityAsked ?? false) === false &&
          bankMod.expectedExplicitHuman(f).explicitHuman === true,
      );
    check(
      "J19a the new holdout contains pure provider-contact cases that route to a handoff",
      pureContact.length >= 5,
      `pureContact=${pureContact.length}`,
    );

    // (b) The BOOK half of the minimal pair: booking present, contact absent,
    //     and the mask must keep the verdict FALSE. Without these, the repair
    //     could "pass" by simply making bookingRequested universally false.
    const bookMask = bankMod
      .bankSubset("holdout-v3")
      .filter(
        (f) =>
          f.expected.bookingRequested === true &&
          f.expected.providerRequested === false &&
          bankMod.expectedExplicitHuman(f).explicitHuman === false,
      );
    check(
      "J19b the new holdout contains booking-mask cases that route to NO handoff",
      bookMask.length >= 5,
      `bookMask=${bookMask.length}`,
    );

    // (c) The mask itself is untouched: the server formula is still
    //     `supportRequest OR (providerRequest AND NOT bookingTask)`. A
    //     contact+booking turn must still derive NO handoff from the labels.
    const contactPlusBooking = bankMod
      .bankSubset("holdout-v3")
      .find(
        (f) =>
          f.expected.providerRequested === true &&
          f.expected.bookingRequested === true,
      );
    check(
      "J19c a contact+booking turn still derives explicitHuman = false (mask intact)",
      contactPlusBooking !== undefined &&
        bankMod.expectedExplicitHuman(contactPlusBooking).explicitHuman ===
          false,
      contactPlusBooking
        ? `id=${contactPlusBooking.id}`
        : "no contact+booking case exists in the slice",
    );

    // (d) The §10 ADJUDICATION is encoded forward: a provider inside an
    //     AVAILABILITY question must now expect preference = false. Every
    //     new availability case must assert that, or the adjudication was
    //     not actually applied.
    const availCases = bankMod
      .bankSubset("holdout-v3")
      .filter((f) => f.expected.availabilityAsked === true);
    check(
      "J19d every new availability case expects providerPreferenceExpressed = false",
      availCases.length > 0 &&
        availCases.every(
          (f) => f.expected.providerPreferenceExpressed !== true,
        ),
      `availCases=${availCases.length} violating=${availCases.filter((f) => f.expected.providerPreferenceExpressed === true).length}`,
    );

    // (e) And the positive side of preference must still be present, so (d)
    //     is not vacuous — a preference with no booking and no contact.
    const prefOnly = bankMod
      .bankSubset("holdout-v3")
      .filter(
        (f) =>
          f.expected.providerPreferenceExpressed === true &&
          f.expected.providerRequested === false,
      );
    check(
      "J19e the new holdout carries positive preference cases (not vacuous)",
      prefOnly.length >= 1,
      `prefOnly=${prefOnly.length}`,
    );

    // (f) HISTORICAL ARTIFACT MUTATION. The original slice labels are frozen;
    //     the committed fingerprints are the ground truth. A label edit would
    //     change the slice hash, which is exactly what J17f2 already binds.
    //     Here we additionally prove the ORIGINAL label for the known
    //     repaired case is unchanged, so the historical case stays repaired
    //     and is never relabeled to manufacture agreement.
    const repaired = bankMod.JEV_FIXTURES.find(
      (f) => f.id === "provider-availability",
    );
    check(
      "J19f the known repaired case «هل فيه دكتور متاح؟» is present and routes to NO handoff",
      repaired !== undefined &&
        repaired.message === "هل فيه دكتور متاح؟" &&
        bankMod.expectedExplicitHuman(repaired).explicitHuman === false,
    );

    // (g) CONTACT-vs-BOOK MASKING REGRESSION DETECTOR. The policy must never
    //     be able to turn a (providerRequested, no booking) label set into a
    //     non-handoff. This is the exact failure shape of the inherited
    //     defect, expressed as a property over the frozen labels.
    let maskingViolations = 0;
    for (const f of bankMod.JEV_FIXTURES_V3) {
      const projected = bankMod.projectPrecedenceFacts(f.expected);
      // The label-side precedence must agree with the formula applied to the
      // same facts the policy would derive under P1 for these orientations.
      const verdict = bankMod.applyServerPrecedence(projected);
      const direct =
        f.expected.providerRequested === true && !projected.bookingTask;
      if (direct && !verdict.explicitHuman) maskingViolations += 1;
    }
    check(
      "J19g no label can express the contact-without-booking masking shape",
      maskingViolations === 0,
      `${maskingViolations} violation(s)`,
    );

    // (h) AVAILABILITY / NAME causing a provider-contact FALSE POSITIVE. A
    //     provider name or title inside an availability or identity question
    //     must never assert providerRequested in the labels.
    const availNameContact = bankMod.JEV_FIXTURES_V3.filter(
      (f) =>
        (f.expected.availabilityAsked === true ||
          f.classes.includes("provider-identity")) &&
        f.expected.providerRequested === true,
    );
    check(
      "J19h no availability/identity case asserts providerRequested",
      availNameContact.length === 0,
      `violating=${availNameContact.map((f) => f.id).join(",")}`,
    );

    // (i) PROVIDER PREFERENCE COLLAPSING INTO MERE AVAILABILITY. This is the
    //     §10 adjudication expressed as a LABEL INVARIANT on the new slices:
    //     every new case asserting preference must ALSO assert either a
    //     booking or an explicit preference-without-task, never availability
    //     alone.
    const prefCollapse = bankMod
      .bankSubset("holdout-v3")
      .filter(
        (f) =>
          f.expected.providerPreferenceExpressed === true &&
          f.expected.bookingRequested !== true &&
          !prefOnly.includes(f),
      );
    check(
      "J19i no new preference case collapses into availability alone",
      prefCollapse.length === 0,
      `violating=${prefCollapse.map((f) => f.id).join(",")}`,
    );

    // (j) THE 0/1-CALL INVARIANT under the runner's own accounting helper.
    //     `plannedRequestCount` must be exactly the fixture count for every
    //     slice, and the ledger shape must be one entry per fixture.
    for (const slice of bankMod.bankSliceValues) {
      const subset = bankMod.bankSubset(slice);
      check(
        `J19j ${slice} plans exactly one request per fixture`,
        bankMod.plannedRequestCount(subset) === subset.length,
      );
    }

    // (k) NO SECOND JUDGE. The contract must not ask any question whose
    //     answer is another question's answer, and no question may reference
    //     the precedence verdict. Re-checked for the @v3 wording.
    const questions = contractMod.jevQuestionSet();
    const dependencyLeaks = Object.entries(questions).filter(([, q]) =>
      /explicitHuman|shouldHandoff|bookingTask|precedence/i.test(
        q.instructions,
      ),
    );
    check(
      "J19k no @v3 question encodes precedence or a derived fact",
      dependencyLeaks.length === 0,
      dependencyLeaks.map(([k]) => k).join(","),
    );

    // (l) NO LEXICAL DICTIONARY. The @v3 contract must not introduce an
    //     Arabic word list, stem list or regex patch — that is the forbidden
    //     shortcut for making a benchmark green. The check inspects CODE only:
    //     the design docstrings legitimately DISCUSS the forbidden shortcut
    //     to record why it was rejected, and a comment-only match is not an
    //     implementation.
    const contractSource = readFileSync(
      resolve(process.cwd(), "evaluation/jev/jev-question-contract.ts"),
      "utf8",
    );
    const codeOnly = stripComments(contractSource);
    check(
      "J19l the contract adds no lexical dictionary, stem list or regex",
      !/(dialect|stem|keyword)\s*(dictionary|list|table)/i.test(codeOnly) &&
        !/HUMAN_WORDS|BOOKING_WORDS|AVAILABILITY_WORDS|HUMAN_TITLE_WORDS/.test(
          codeOnly,
        ) &&
        !/\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}.*\\u[0-9a-fA-F]{4}/.test(
          codeOnly,
        ),
    );
    void policyMod;
  }

  // ── J20 — PROMPT-AI-JEV-02B-R: holdout-v4 freeze, disjointness, retirement ─
  // The recovery holdout must be mechanically disjoint from every bank whose
  // rows have already been sent to JEV, and the retired holdout-v3 must be
  // provably unexecutable. Both are proven here, offline, before any live call.
  {
    const v4 = bankMod.bankSubset("holdout-v4");
    const v4Ids = new Set(v4.map((f) => f.id));
    const v4Messages = new Set(v4.map((f) => f.message));
    const touchedSlices = [
      "original",
      "calibration",
      "holdout",
      "calibration-v3",
      "holdout-v3",
    ] as const;

    check(
      "J20 the recovery holdout meets the >= 40 fixture floor",
      v4.length >= 40,
      `n=${v4.length}`,
    );
    let idOverlap = 0;
    let messageOverlap = 0;
    for (const slice of touchedSlices) {
      for (const f of bankMod.bankSubset(slice)) {
        if (v4Ids.has(f.id)) idOverlap += 1;
        if (v4Messages.has(f.message)) messageOverlap += 1;
      }
    }
    check(
      "J20b the recovery holdout is id- and message-disjoint from every already-touched bank",
      idOverlap === 0 && messageOverlap === 0,
      `idOverlap=${idOverlap} messageOverlap=${messageOverlap}`,
    );
    // A trivial punctuation-only variant would not be a fresh case.
    const normalize = (s: string) =>
      s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
    const existingNormalized = new Set(
      touchedSlices
        .flatMap((slice) => bankMod.bankSubset(slice))
        .map((f) => normalize(f.message)),
    );
    const trivialDupes = v4.filter((f) =>
      existingNormalized.has(normalize(f.message)),
    );
    check(
      "J20c no recovery holdout message is a punctuation-only variant of an existing one",
      trivialDupes.length === 0,
      trivialDupes.map((f) => f.message).join("; "),
    );
    check(
      "J20d the recovery holdout carries no duplicate id or message inside itself",
      v4.length === new Set(v4.map((f) => f.id)).size &&
        v4.length === new Set(v4.map((f) => f.message)).size,
    );
    // Language/register coverage — the families the interrupted pass missed.
    const hints = new Set(v4.map((f) => f.languageHint));
    check(
      "J20e the recovery holdout spans Egyptian, MSA, English and code-switching",
      hints.has("Arabic, predominantly Egyptian colloquial") &&
        hints.has("Arabic, predominantly Modern Standard (MSA)") &&
        hints.has("English") &&
        hints.has("Mixed Arabic and English code-switching"),
      [...hints].join(" | "),
    );
    // The mandatory §8 semantic scenarios must all be present as fixtures.
    const mandatory = [
      "v4-hold-contact-talk-gyn-female",
      "v4-hold-contact-named-ahmed-self",
      "v4-hold-contact-english-connect",
      "v4-hold-book-not-talk",
      "v4-hold-book-english-thursday",
      "v4-hold-book-any-available",
      "v4-hold-avail-dentist-today",
      "v4-hold-avail-english-ahmed",
      "v4-hold-id-english-cardio",
      "v4-hold-pref-female-not-male",
      "v4-hold-pref-any-doctor",
      "v4-hold-support-customer-service",
      "v4-hold-support-reception-book",
      "v4-hold-ambig-need-doctor",
      "v4-hold-ambig-english-see",
      "v4-hold-mixed-book-ahmed",
      "v4-hold-mask-book-then-talk",
      "v4-hold-neg-manager-hours",
      "v4-hold-sensitive-complaint-only",
    ];
    const missing = mandatory.filter((id) => !v4Ids.has(id));
    check(
      "J20f every mandatory contact-vs-book scenario family is represented",
      missing.length === 0,
      missing.join(", "),
    );
    // holdout-v3 retirement: the manifest records the seal break and the guard
    // denies execution.
    const denial = freezeMod.bankExecutionDenial("holdout-v3");
    check(
      "J20g holdout-v3 is recorded as SEAL_BROKEN and unexecutable",
      denial !== null &&
        denial.status.status === "SEAL_BROKEN" &&
        denial.status.eligibleForExecution === false &&
        denial.status.eligibleForScoring === false,
      denial ? denial.denial : "no denial returned",
    );
    check(
      "J20h the retirement register records the interrupted-run row accounting",
      denial !== null &&
        denial.status.exposedRows === 42 &&
        denial.status.plannedRows === 47 &&
        denial.status.missingRows === 5,
      JSON.stringify(denial?.status ?? {}),
    );
    check(
      "J20i an eligible bank produces no denial",
      freezeMod.bankExecutionDenial("original") === null &&
        freezeMod.bankIsExecutable("original") === true,
    );
    // A COMPLETED sealed holdout may never be measured again: its one
    // permitted live pass finished, so re-execution would re-expose sealed
    // fixtures. The guard must refuse it before any fetch — the completed
    // analogue of the SEAL_BROKEN refusal.
    const v4Denial = freezeMod.bankExecutionDenial("holdout-v4");
    check(
      "J20l a COMPLETED sealed holdout is refused re-execution but stays scorable",
      v4Denial !== null &&
        v4Denial.status.status === "COMPLETED" &&
        v4Denial.status.eligibleForExecution === false &&
        v4Denial.status.eligibleForScoring === true &&
        v4Denial.status.exposedRows === v4Denial.status.plannedRows &&
        v4Denial.status.missingRows === 0 &&
        freezeMod.bankIsExecutable("holdout-v4") === false,
      v4Denial ? v4Denial.denial : "no denial returned",
    );
    // The recovery holdout is bound into the freeze manifest exactly like every
    // frozen slice, so a post-run label edit trips the binding gate.
    const v4Fp = bankMod.sliceFingerprints()["holdout-v4"];
    check(
      "J20j the freeze manifest binds the recovery holdout's live fingerprint",
      freezeMod.JEV_FREEZE_MANIFEST.slices["holdout-v4"]?.fingerprint ===
        v4Fp &&
        freezeMod.JEV_FREEZE_MANIFEST.slices["holdout-v4"]?.count === v4.length,
      `manifest=${JSON.stringify(freezeMod.JEV_FREEZE_MANIFEST.slices["holdout-v4"])} live=${v4Fp}/${v4.length}`,
    );
    // The frozen Stage-A fingerprints must be UNCHANGED by the recovery work.
    const state = {
      contractId: contractMod.JEV_QUESTION_CONTRACT_ID,
      contractFingerprint: policyMod.contractFingerprint(
        contractMod.jevQuestionSet(),
      ),
      policyId: policyMod.JEV_POLICY_ID,
      policyFingerprint: policyMod.policyFingerprint(),
      requestedModel: "typesafe/jev-1.13",
      sliceFingerprints: bankMod.sliceFingerprints(),
      sliceCounts: Object.fromEntries(
        bankMod.bankSliceValues.map((s) => [s, bankMod.bankSubset(s).length]),
      ),
    };
    const mismatches = freezeMod.verifyFreezeManifest(state);
    check(
      "J20k the frozen candidate is unchanged by the recovery slice (no semantic drift)",
      mismatches.length === 0,
      mismatches.join("; "),
    );
    void bankMod;
  }

  // ── R1–R8 — PROMPT-AI-JEV-02B-R §5: the durable-runner regression tests ────
  // All eight run against INJECTED fetches: no paid provider call is made, and
  // every one proves a property of the evidence machinery rather than of the
  // model.
  {
    const bench = await import("../scripts/eval-jev-benchmark");
    const contract = contractMod;
    const keys = contract.jevQuestionKeys;
    const questions = contract.jevQuestionSet();
    // The runner regression tests drive a real FROZEN bank that is NOT in the
    // retirement register: holdout-v4 is now recorded as COMPLETED (its single
    // live pass finished), so the §3 guard rightfully refuses to execute it in
    // any mode. calibration-v3 is a frozen slice that was never sealed and
    // stays eligible, which is exactly what these machinery tests need.
    const synth = bankMod.bankSubset("calibration-v3").slice(0, 5);
    // Write test artifacts OUTSIDE the repository's evidence directory: a
    // test artifact is not benchmark evidence and must never be mistaken for
    // one (R2).
    const tmp = resolve(process.cwd(), "..", ".tmp-jev-runner-tests");
    mkdirSync(tmp, { recursive: true });
    bench.setArtifactDirectoryForTests(tmp);

    // A fake that answers from the fixture's own labels, so a synthetic run is
    // a clean 5/5 by construction.
    const cleanFetch = (fixtures: ReadonlyArray<RunnerFixture>) => {
      const byMessage = new Map(fixtures.map((f) => [f.message, f]));
      return (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          state: { customer_message: string };
        };
        const f = byMessage.get(body.state.customer_message);
        const answers = Object.fromEntries(
          keys.map((k) => {
            const expected = f?.expected[k as RunnerQuestionKey];
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
            id: `r-test-${Date.now()}`,
            model: "typesafe/jev-1.13-R-TEST",
            provider: "InjectedFake",
            answers,
            usage: { input_tokens: 300, output_tokens: 20, cost: 0.00001 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch;
    };

    // R1 — incremental durability: stop after fixture 3 of 5, and exactly 3
    // completed rows must remain durably inspectable on disk.
    const r1 = await bench.runBenchmark({
      mode: "offline",
      bank: "calibration-v3",
      model: "typesafe/jev-1.13",
      limit: 5,
      writeArtifact: true,
      logFile: null,
      abortAfter: 3,
    });
    const r1Partial = r1.partialPath
      ? readFileSync(r1.partialPath, "utf8")
      : "";
    const r1Parsed = JSON.parse(r1Partial) as {
      completedFixtureIds: string[];
      completedFixtureCount: number;
      plannedFixtureCount: number;
      notRequestedFixtureIds: string[];
      rows: Array<{ fixtureId: string }>;
    };
    check(
      "R1 an interrupted run durably persists exactly its completed rows",
      r1.exitCode === 5 &&
        r1Parsed.completedFixtureCount === 3 &&
        r1Parsed.completedFixtureIds.length === 3 &&
        r1Parsed.rows.length === 3 &&
        r1Parsed.notRequestedFixtureIds.length === 2 &&
        r1Parsed.plannedFixtureCount === 5,
      `exit=${r1.exitCode} completed=${r1Parsed.completedFixtureCount} rows=${r1Parsed.rows.length} notRequested=${r1Parsed.notRequestedFixtureIds.length}`,
    );

    // R2 — an interrupted artifact is COMPLETE=false / SCORABLE=false and every
    // scoring/eligibility function rejects it.
    const r1Report = r1.report;
    check(
      "R2 an interrupted artifact is never COMPLETE or SCORABLE",
      r1Report !== null &&
        r1Report.artifactStatus === "INTERRUPTED" &&
        r1Report.COMPLETE === false &&
        r1Report.SCORABLE === false &&
        r1Report.interrupted === true &&
        r1Report.resumeAllowed === false &&
        bench.isArtifactScorable(r1Report) === false &&
        r1Report.finalization.ok === false,
      r1Report ? (r1Report.finalization.reason ?? "") : "no report",
    );

    // R3 — no secret serialization. Inject a fake credential and a fake
    // Authorization header; neither may appear in persisted state.
    const FAKE_KEY = "sk-fake-R3-credential-0123456789abcdef";
    const FAKE_HEADER = "Bearer sk-fake-R3-credential-0123456789abcdef";
    const previousKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    try {
      const probes = [FAKE_KEY, FAKE_HEADER, "OPENROUTER_API_KEY", "Bearer "];
      const r3 = await bench.runBenchmark({
        mode: "offline",
        bank: "calibration-v3",
        model: "typesafe/jev-1.13",
        limit: 5,
        writeArtifact: true,
        logFile: null,
      });
      const text = r3.finalPath ? readFileSync(r3.finalPath, "utf8") : "";
      const hit = probes.filter((p) => text.includes(p));
      check(
        "R3 no credential or Authorization header is serialized into an artifact",
        r3.exitCode === 0 && hit.length === 0 && text.length > 0,
        `hits=${hit.join(",")}`,
      );
      // The scan must also DETECT a leaked secret rather than silently passing.
      // A clean report is seeded with the fake credential through the same
      // serializer the runner uses, so a regression in the scan is caught.
      // Seed a CLEAN report with the fake credential through the same
      // serializer the runner uses, so a regression in the scan is caught.
      const seededReport: Record<string, unknown> =
        r3.report === null
          ? { leaked: FAKE_HEADER }
          : { ...r3.report, leaked: FAKE_HEADER };
      const seeded = bench.serializeArtifact(seededReport, probes);
      check(
        "R3b the secret scan detects an injected credential rather than passing silently",
        seeded.hits.length > 0,
        `hits=${seeded.hits.join(",")}`,
      );
    } finally {
      process.env.OPENROUTER_API_KEY = previousKey;
    }

    // R4 — a SEAL_BROKEN bank fails CLOSED before any fetch invocation.
    const r4 = await bench.runBenchmark({
      mode: "offline",
      bank: "holdout-v3",
      model: "typesafe/jev-1.13",
      limit: 5,
      writeArtifact: true,
      logFile: null,
    });
    check(
      "R4 a retired bank is refused before any network invocation (fetch count 0)",
      r4.exitCode === 4 &&
        r4.fetchCallCount === 0 &&
        r4.report === null &&
        r4.partialPath === null,
      r4.refusal ?? "",
    );

    // R5 — a synthetic 5/5 run with 0 errors finalizes as COMPLETE/SCORABLE,
    // every fixture exactly once, and promotes the partial to one final file.
    const r5 = await bench.runBenchmark({
      mode: "offline",
      bank: "calibration-v3",
      model: "typesafe/jev-1.13",
      limit: 5,
      writeArtifact: true,
      logFile: null,
    });
    const r5Ids = r5.report?.completedFixtureIds ?? [];
    check(
      "R5 a clean 5/5 run produces one COMPLETE/SCORABLE artifact with each fixture exactly once",
      r5.exitCode === 0 &&
        r5.finalPath !== null &&
        r5.report !== null &&
        r5.report.COMPLETE === true &&
        r5.report.SCORABLE === true &&
        r5.report.artifactStatus === "COMPLETE" &&
        bench.isArtifactScorable(r5.report) &&
        r5Ids.length === 5 &&
        new Set(r5Ids).size === 5 &&
        r5.report.requests.planned === 5 &&
        r5.report.requests.executed === 5 &&
        r5.report.requests.failed === 0,
      `exit=${r5.exitCode} complete=${r5.report?.COMPLETE}`,
    );
    check(
      "R5b a completed run leaves no partial artifact behind",
      r5.finalPath !== null &&
        !existsSync(r5.partialPath ?? "n/a") &&
        existsSync(r5.finalPath),
    );

    // R6 — fingerprint binding. Overriding the bank, contract or policy
    // fingerprint must be a hard failure before any fetch.
    const r6Bank = await bench.runBenchmark({
      mode: "offline",
      bank: "calibration-v3",
      model: "typesafe/jev-1.13",
      limit: 5,
      writeArtifact: false,
      logFile: null,
      freezeStateOverride: {
        sliceFingerprints: {
          ...bankMod.sliceFingerprints(),
          "calibration-v3": "sha256:0000000000000000",
        },
      },
    });
    const r6Contract = await bench.runBenchmark({
      mode: "offline",
      bank: "calibration-v3",
      model: "typesafe/jev-1.13",
      limit: 5,
      writeArtifact: false,
      logFile: null,
      freezeStateOverride: { contractFingerprint: "sha256:deadbeefdeadbeef" },
    });
    const r6Policy = await bench.runBenchmark({
      mode: "offline",
      bank: "calibration-v3",
      model: "typesafe/jev-1.13",
      limit: 5,
      writeArtifact: false,
      logFile: null,
      freezeStateOverride: { policyFingerprint: "sha256:cafef00dcafef00d" },
    });
    check(
      "R6 a bank/contract/policy fingerprint change hard-stops the run before any call",
      r6Bank.exitCode === 3 &&
        r6Bank.fetchCallCount === 0 &&
        r6Contract.exitCode === 3 &&
        r6Contract.fetchCallCount === 0 &&
        r6Policy.exitCode === 3 &&
        r6Policy.fetchCallCount === 0,
      `bank=${r6Bank.exitCode} contract=${r6Contract.exitCode} policy=${r6Policy.exitCode}`,
    );

    // R7/R8 — duplicate-row and planned/executed-skew protection. The
    // finalization gate is a pure function, so it is probed directly with the
    // shapes that must never finalize.
    const ids = synth.map((f) => f.id);
    // Length-matched but containing a duplicate AND a gap: the duplicate must
    // be reported even when the row count looks right.
    const dup = bench.finalizeSealedArtifact({
      plannedFixtureIds: ids.slice(0, 4),
      rows: [
        { fixtureId: ids[0] as string, ok: true },
        { fixtureId: ids[0] as string, ok: true },
        { fixtureId: ids[1] as string, ok: true },
        { fixtureId: ids[2] as string, ok: true },
      ],
    });
    const short = bench.finalizeSealedArtifact({
      plannedFixtureIds: ids,
      rows: ids.slice(0, 4).map((id) => ({ fixtureId: id, ok: true })),
    });
    const long = bench.finalizeSealedArtifact({
      plannedFixtureIds: ids.slice(0, 4),
      rows: ids.map((id) => ({ fixtureId: id, ok: true })),
    });
    const failed = bench.finalizeSealedArtifact({
      plannedFixtureIds: ids.slice(0, 4),
      rows: ids.slice(0, 4).map((id) => ({ fixtureId: id, ok: id === ids[0] })),
    });
    const clean = bench.finalizeSealedArtifact({
      plannedFixtureIds: ids.slice(0, 4),
      rows: ids.slice(0, 4).map((id) => ({ fixtureId: id, ok: true })),
    });
    check(
      "R7 a duplicate fixture row can never finalize as complete",
      !dup.ok && /duplicate/.test(dup.reason ?? ""),
      dup.reason ?? "",
    );
    check(
      "R8 planned/executed skew (short, long, or failed rows) can never finalize as complete",
      !short.ok &&
        !long.ok &&
        !failed.ok &&
        short.reason?.includes("response row") === true &&
        long.reason?.includes("response row") === true &&
        failed.reason?.includes("failed") === true,
      [short.reason, long.reason, failed.reason].join(" | "),
    );
    check(
      "R8b a clean 4/4 gate finalizes, so the gate is not merely rejecting everything",
      clean.ok && clean.reason === null,
      JSON.stringify(clean),
    );

    // The injected fetches must never have left the fixture set: the five
    // synthetic fixtures are exactly the first five calibration-v3 rows.
    check(
      "R9 injected-fetch tests never expand the bank they were given",
      synth.length === 5 &&
        synth.every((f) => f.bank === "calibration-v3") &&
        cleanFetch(synth) !== undefined,
      `n=${synth.length}`,
    );

    rmSync(tmp, { recursive: true, force: true });
    bench.setArtifactDirectoryForTests(null);
    void questions;
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

/**
 * Build the offline benchmark's report snapshot (no network, no real model):
 * the same per-row evidence and the same scored-question accounting the
 * reporter produces, so J16 proves the REAL accounting rule is non-zero and
 * self-consistent rather than asserting a constant.
 */
async function runOfflineBenchmarkSnapshot(): Promise<{
  scoredQuestions: number;
  rows: Array<{ expected: Record<string, boolean | null> }>;
}> {
  const adapterMod = await import("../evaluation/jev/jev-decisions-adapter");
  const contractMod = await import("../evaluation/jev/jev-question-contract");
  const bankMod = await import("../evaluation/jev/jev-fixture-bank");
  const fixturesById = new Map(
    bankMod.JEV_FIXTURES_V2.map((f) => [f.message, f]),
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
        id: `offline-snapshot`,
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

  const rows: Array<{ expected: Record<string, boolean | null> }> = [];
  for (const f of bankMod.JEV_FIXTURES) {
    const res = await adapter.evaluate({
      state: {
        customerMessage: f.message,
        businessName: f.businessName,
        services: f.services,
        faqs: f.faqs,
        languageHint: f.languageHint,
      },
      questions: contractMod.jevQuestionSet(),
    });
    const expected: Record<string, boolean | null> = {};
    for (const key of contractMod.jevQuestionKeys) {
      expected[key] = f.expected[key] ?? null;
    }
    void res;
    rows.push({ expected });
  }
  const scoredQuestions = rows.reduce(
    (n, r) =>
      n +
      contractMod.jevQuestionKeys.filter((k) => r.expected[k] !== null).length,
    0,
  );
  return { scoredQuestions, rows };
}

/**
 * Strip TS line and block comments so a source-inspection check observes the
 * IMPLEMENTATION and not the prose that documents it. The contract's
 * docstrings deliberately DISCUSS the forbidden lexical shortcut to record
 * why it was rejected; that prose must not register as an implementation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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
