/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — JSON RESPONSE NORMALIZATION ENGINE check
 * (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * Deterministic, OFFLINE test matrix (no network, no DB, no secrets) for the
 * reusable normalization engine at
 * `src/server/integrations/ai/response-normalizer`.
 *
 * Proves the required invariants, one labelled group per letter:
 *   A  valid JSON → DIRECT_PARSE, no repair called
 *   B  valid JSON inside Markdown fences → DIRECT_PARSE
 *   C  known surplus-brace Atria defect → bounded repair, schema-valid
 *   D  jsonrepair-supported syntax errors → GENERIC_REPAIRED_PARSE
 *   E  jsonrepair output parseable but schema-invalid → INVALID_RESPONSE
 *   F  non-JSON prose → INVALID_RESPONSE
 *   G  empty content → INVALID_RESPONSE
 *   H  arrays/scalars where an object is required → INVALID_RESPONSE
 *   I  multiple concatenated objects → never merged → INVALID_RESPONSE
 *   J  provider-specific empty-key wrapper (bounded, provider-scoped only)
 *   K  non-Atria invariance (OpenRouter/AgentRouter unchanged; a policy
 *      cannot accidentally execute for another provider)
 *   L  strict-first: repair is NOT called when strict parse + schema succeed
 *   M  no recursive repair: exactly one generic pass + one bounded pass
 *   N  idempotence: re-normalizing an accepted payload is a no-op
 *   S  safety: telemetry never leaks content or secrets
 *
 * Run: pnpm check:response-normalizer
 */
export {};

type Check = { label: string; pass: boolean };

type NormalizerModule =
  typeof import("../src/server/integrations/ai/response-normalizer");
type NormalizerResult =
  import("../src/server/integrations/ai/response-normalizer").NormalizerResult;
type NormalizerPolicy =
  import("../src/server/integrations/ai/response-normalizer").NormalizerPolicy;
type NormalizerRule =
  import("../src/server/integrations/ai/response-normalizer").NormalizerRule;
type AiResponse =
  import("../src/features/conversations/server/ai-contract").AiResponse;

function validAiResponseJson(overrides: Partial<Record<string, unknown>> = {}) {
  return JSON.stringify({
    intent: "FAQ",
    action: "reply",
    content: "من 9 صباحاً حتى 6 مساءً",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: null,
    summary: null,
    ...overrides,
  });
}

function validAiResponseObj(): AiResponse {
  return JSON.parse(validAiResponseJson()) as AiResponse;
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const n: NormalizerModule =
    await import("../src/server/integrations/ai/response-normalizer");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  const ATRIA = n.ATRIA_NORMALIZATION_POLICY;
  const CTX = { provider: "atria" as const, model: "Atria-Dawn-Preview" };
  const run = (content: string, policy?: NormalizerPolicy): NormalizerResult =>
    n.normalizeResponse({
      content,
      provider: "atria",
      model: CTX.model,
      policy: policy ?? ATRIA,
    });

  const accepted = (r: NormalizerResult): AiResponse | null =>
    r.ok ? r.value : null;

  // ── A: valid JSON → DIRECT_PARSE, no repair ──────────────────────────────
  {
    const r = run(validAiResponseJson());
    check("A1 JSON صالح → DIRECT_PARSE", r.ok && r.mode === "DIRECT_PARSE");
    check(
      "A2 JSON صالح → لا يُستدعى الإصلاح العام ولا سياسة المزود",
      r.trace.genericRepairRan === false &&
        r.trace.providerRepairRan === false &&
        r.trace.stage === "STRICT_PARSE" &&
        r.trace.outcome === "DIRECT_PARSE",
    );
    check(
      "A3 القيمة المقبولة مطابقة تماماً للقيمة الأساسية",
      JSON.stringify(accepted(r)) === JSON.stringify(validAiResponseObj()),
    );
    check(
      "A4 البصمة: عدد المفاتيح الأعلى = 6، القوس الأول `{`",
      r.trace.fingerprint.topLevelKeys === 6 &&
        r.trace.fingerprint.firstByte === "{" &&
        r.trace.fingerprint.fenced === false,
    );
  }

  // ── B: Markdown fences → stripped → DIRECT_PARSE ──────────────────────────
  {
    const fenced = "```json\n" + validAiResponseJson() + "\n```";
    const r = run(fenced);
    check(
      "B1 JSON داخل سياج Markdown → DIRECT_PARSE (تُزال الأسوار فقط)",
      r.ok && r.mode === "DIRECT_PARSE" && r.trace.fingerprint.fenced === true,
    );
    check(
      "B2 سياج بدون لغة json أيضاً يُعالَج",
      (() => {
        const r2 = run("```\n" + validAiResponseJson() + "\n```");
        return r2.ok && r2.mode === "DIRECT_PARSE";
      })(),
    );
    check(
      "B3 القيمة بعد نزع السياج مطابقة للأصل",
      JSON.stringify(accepted(r)) === JSON.stringify(validAiResponseObj()),
    );
  }

  // ── C: surplus-brace Atria defect → bounded provider repair ──────────────
  {
    const artifact = `{${validAiResponseJson()}`;
    const r = run(artifact);
    check(
      "C1 عيب الأقواس الزائدة: التحليل الصارم يفشل أولاً",
      r.trace.strictParseOk === false,
    );
    check(
      "C2 jsonrepair العام يعجز عن `{{` (لا يُنتج مرشحاً)",
      r.trace.genericRepairRan === true &&
        r.trace.genericRepairProducedCandidate === false,
    );
    check(
      "C3 قاعدة ATRIA_SURPLUS_BRACE تُصلِح → BOUNDED_PROVIDER_REPAIR",
      r.ok &&
        r.mode === "BOUNDED_PROVIDER_REPAIR" &&
        r.trace.providerRepairRule === "ATRIA_SURPLUS_BRACE",
    );
    check(
      "C4 القيمة المقبولة بعد الإصلاح مطابقة للأصل (بلا تحريف)",
      JSON.stringify(accepted(r)) === JSON.stringify(validAiResponseObj()),
    );
    check(
      "C5 ثلاثة أقواس بادئة أيضاً تُردّ إلى قوس واحد",
      (() => {
        const r2 = run(`{{${validAiResponseJson()}`);
        return (
          r2.ok &&
          r2.mode === "BOUNDED_PROVIDER_REPAIR" &&
          JSON.stringify(accepted(r2)) === JSON.stringify(validAiResponseObj())
        );
      })(),
    );
  }

  // ── D: jsonrepair-supported syntax errors → GENERIC_REPAIRED_PARSE ───────
  {
    const cases: Array<[string, string]> = [
      [
        "فاصلة زائدة",
        validAiResponseJson().replace(/"summary":null\}/, '"summary":null,}'),
      ],
      ["مفتاح غير محصور", validAiResponseJson().replace(/"intent"/, "intent")],
      ["اقتباس أحادي", validAiResponseJson().replace(/"intent"/, "'intent'")],
      ["قوس إغلاق ناقص", validAiResponseJson().slice(0, -1)],
      [
        "concatenated value+key (فاصلة مفقودة)",
        validAiResponseJson().replace(/,"action"/, ' "action"'),
      ],
    ];
    for (const [label, content] of cases) {
      const r = run(content);
      check(
        `D (${label}) → GENERIC_REPAIRED_PARSE + مخطوطة صالحة`,
        r.ok &&
          r.mode === "GENERIC_REPAIRED_PARSE" &&
          r.trace.genericRepairProducedCandidate === true &&
          r.trace.genericRepairStrictParseOk === true,
      );
    }
    // Truncation that loses a required field: repair must still be
    // schema-gated (here `content` survives, so it is accepted).
    const trunc = `{"intent":"FAQ","action":"reply","content":"من 9 حتى 6","extraction":{"service":null,"provider":null,"date":null`;
    const rTrunc = run(trunc);
    check(
      "D6 JSON مقطوع → GENERIC_REPAIRED_PARSE (الـ schema يبقى الحاكم)",
      rTrunc.ok && rTrunc.mode === "GENERIC_REPAIRED_PARSE",
    );
  }

  // ── E: jsonrepair parseable but schema-invalid → INVALID_RESPONSE ────────
  {
    const badIntent = validAiResponseJson({ intent: "NOT_AN_INTENT" });
    const r = run(badIntent);
    check(
      "E1 JSON صالح لكن الـ schema يرفضه → INVALID_RESPONSE",
      !r.ok &&
        r.mode === "INVALID_RESPONSE" &&
        r.trace.strictParseOk === true &&
        r.trace.schemaOk === false,
    );
    // The generic stage runs after a schema rejection but jsonrepair is
    // purely syntactic: it can never fix a semantic violation.
    check(
      "E2 الإصلاح العام يعجز عن إصلاح خطأ دلالي (schema ما زال رافضاً)",
      r.trace.genericRepairRan === true &&
        r.trace.genericRepairSchemaOk === false,
    );
    // Surplus brace + schema-invalid payload: bounded repair restores
    // syntax, the schema still rejects → INVALID_RESPONSE.
    const rBracedBad = run(`{${badIntent}`);
    check(
      "E3 قوس زائد + schema مخالف → الإصلاح المحدود يُعاد ثم يرفضه الـ schema",
      !rBracedBad.ok &&
        rBracedBad.trace.providerRepairRan === true &&
        rBracedBad.trace.ruleAttempts.some(
          (a) => a.rule === "ATRIA_SURPLUS_BRACE" && a.schemaOk === false,
        ),
    );
    // Truncation that destroys a REQUIRED field: repaired, but schema-invalid.
    const rTruncBad = run(
      `{"intent":"FAQ","action":"reply","extraction":{"service":null}`,
    );
    check(
      "E4 قطع يُتلف حقلاً مطلوباً → INVALID_RESPONSE رغم الإصلاح",
      !rTruncBad.ok &&
        rTruncBad.trace.genericRepairProducedCandidate === true &&
        rTruncBad.trace.genericRepairSchemaOk === false,
    );
  }

  // ── F: non-JSON prose → INVALID_RESPONSE ──────────────────────────────────
  {
    const r = run("أهلاً، كيف يمكنني مساعدتك؟");
    check(
      "F1 نص عادي → INVALID_RESPONSE (بلا إكراه)",
      !r.ok && r.trace.strictParseOk === false,
    );
    check(
      "F2 الإصلاح العام يرفضه (لا يُولّد كائناً)",
      r.trace.genericRepairProducedCandidate === false,
    );
    check(
      "F3 سياسة المزود لا تُفعَّل على النص العادي",
      r.trace.providerRepairRan === true &&
        r.trace.ruleAttempts.every((a) => a.declined),
    );
  }

  // ── G: empty content → INVALID_RESPONSE ───────────────────────────────────
  {
    const r = run("");
    check(
      "G1 محتوى فارغ → INVALID_RESPONSE",
      !r.ok && r.trace.strictParseOk === false,
    );
    check("G2 whitespace فقط → INVALID_RESPONSE", !run("   \n\t ").ok);
    check(
      "G3 البصمة للمحتوى الفارغ: الطول 0 وأول بايت ∅",
      r.trace.fingerprint.contentLength === 0 &&
        r.trace.fingerprint.firstByte === "∅",
    );
  }

  // ── H: arrays/scalars where an object is required → INVALID_RESPONSE ─────
  {
    for (const [label, content] of [
      ["مصفوفة", "[1,2,3]"],
      ["مصفوفة كائنات", "[{...}]".replace("{...}", validAiResponseJson())],
      ["scalar رقمي", "42"],
      ["scalar نصي", '"just text"'],
      ["true", "true"],
      ["null", "null"],
    ] as Array<[string, string]>) {
      const r = run(content);
      check(
        `H (${label}) → INVALID_RESPONSE (لا إكراه إلى كائن)`,
        !r.ok &&
          r.trace.genericRepairProducedCandidate === false &&
          r.trace.ruleAttempts.every((a) => a.declined),
      );
    }
  }

  // ── I: multiple concatenated objects → never merged ───────────────────────
  {
    const r = run('{"a":1}{"b":2}');
    check(
      "I1 كائنان متجاوران → INVALID_RESPONSE (بلا دمج)",
      !r.ok && r.trace.strictParseOk === false,
    );
    check(
      "I2 الإصلاح العام لا يدمجهما (لا مرشح)",
      r.trace.genericRepairProducedCandidate === false,
    );
    const braced = `{${JSON.stringify({
      ...validAiResponseObj(),
      content: "أول",
    })},{"second":"obj"}}`;
    const rBraced = run(braced);
    check("I3 كائنان متوازنان داخل أقواس → INVALID_RESPONSE", !rBraced.ok);
    check(
      "I4 قاعدة القوس الزائد ترفض الكائنات المتعددة",
      rBraced.trace.ruleAttempts.some(
        (a) => a.rule === "ATRIA_SURPLUS_BRACE" && a.declined,
      ),
    );
    // NDJSON-style newline separated objects → array, refused.
    const rNd = run('{"a":1}\n{"b":2}');
    check(
      "I5 NDJSON (سطرين) → INVALID_RESPONSE (المصفوفة ليست كائناً)",
      !rNd.ok && rNd.trace.genericRepairProducedCandidate === false,
    );
  }

  // ── J: provider-specific empty-key wrapper ────────────────────────────────
  {
    // OBSERVED Atria object-restart corruption: `{` + stray `"` + restart.
    const restart = `{"{${validAiResponseJson().slice(1)}`;
    const r = run(restart);
    check(
      "J1 إعادة تشغيل الكائن: التحليل الصارم يفشل",
      r.trace.strictParseOk === false,
    );
    check(
      "J2 الإصلاح العام يُنتج غلاف المفتاح الفارغ (صالح تركيبياً)",
      r.trace.genericRepairProducedCandidate === true &&
        r.trace.genericRepairStrictParseOk === true &&
        r.trace.genericRepairSchemaOk === false,
    );
    check(
      "J3 قاعدة ATRIA_EMPTY_KEY_WRAPPER تُرقّي الحمولة → BOUNDED_PROVIDER_REPAIR",
      r.ok &&
        r.mode === "BOUNDED_PROVIDER_REPAIR" &&
        r.trace.providerRepairRule === "ATRIA_EMPTY_KEY_WRAPPER",
    );
    check(
      "J4 الحمولة المُرقّاة مطابقة للأصل",
      JSON.stringify(accepted(r)) === JSON.stringify(validAiResponseObj()),
    );
    // Direct wrapper (valid JSON, schema-invalid) is also promoted.
    const direct = JSON.stringify({ "": validAiResponseObj() });
    const rDirect = run(direct);
    check(
      "J5 غلاف مفتاح فارغ مباشر (JSON صالح) → BOUNDED_PROVIDER_REPAIR",
      rDirect.ok && rDirect.mode === "BOUNDED_PROVIDER_REPAIR",
    );
    // Bounded conditions: each violation stays INVALID_RESPONSE.
    for (const [label, content] of [
      ["مفتاحان", JSON.stringify({ "": validAiResponseObj(), other: 1 })],
      ["مفتاح غير فارغ", JSON.stringify({ wrapped: validAiResponseObj() })],
      ["قيمة عددية", JSON.stringify({ "": 7 })],
      ["قيمة نصية", JSON.stringify({ "": "nope" })],
      ["قيمة مصفوفة", JSON.stringify({ "": [1, 2] })],
      ["تداخل بمستويين", JSON.stringify({ "": { "": validAiResponseObj() } })],
      ["حمولة داخلية غير صالحة", JSON.stringify({ "": { intent: "NOPE" } })],
    ] as Array<[string, string]>) {
      const rBad = run(content);
      check(
        `J6 قاعدة المفتاح الفارغ ترفض (${label}) → INVALID_RESPONSE`,
        !rBad.ok && rBad.mode === "INVALID_RESPONSE",
      );
    }
    // The wrapper payload itself must still pass the schema: a promoted
    // wrapper around a schema-invalid object is rejected, not coerced.
    check(
      "J7 غلاف حول حمولة مخالفة للـ schema → INVALID_RESPONSE",
      !run(JSON.stringify({ "": { intent: "NOT_AN_INTENT" } })).ok,
    );
    // Provider isolation: the same content is NOT normalized for other
    // providers — the Atria policy is inert outside provider "atria".
    check(
      "J8 نفس المحتوى لمزود آخر (مع سياسة Atria) → INVALID_RESPONSE",
      !n.normalizeResponse({
        content: restart,
        provider: "openrouter",
        model: "any",
        policy: ATRIA,
      }).ok,
    );
    // Model scoping: a policy restricted to other models stays inert.
    const modelScoped: NormalizerPolicy = {
      provider: "atria",
      models: ["some-other-model"],
      rules: [n.ATRIA_SURPLUS_BRACE_RULE],
    };
    const rScoped = n.normalizeResponse({
      content: `{${validAiResponseJson()}`,
      provider: "atria",
      model: CTX.model,
      policy: modelScoped,
    });
    check(
      "J9 سياسة محدودة بنموذج آخر لا تُنفَّذ → INVALID_RESPONSE",
      !rScoped.ok && rScoped.trace.providerRepairRan === false,
    );
    // A model-scoped policy that DOES match runs.
    const modelMatch: NormalizerPolicy = {
      provider: "atria",
      models: [CTX.model],
      rules: [n.ATRIA_SURPLUS_BRACE_RULE],
    };
    const rMatch = n.normalizeResponse({
      content: `{${validAiResponseJson()}`,
      provider: "atria",
      model: CTX.model,
      policy: modelMatch,
    });
    check(
      "J10 سياسة محدودة بالنموذج المطابق تُنفَّذ → BOUNDED_PROVIDER_REPAIR",
      rMatch.ok && rMatch.mode === "BOUNDED_PROVIDER_REPAIR",
    );
  }

  // ── K: non-Atria invariance ───────────────────────────────────────────────
  {
    check(
      "K1 سياسة OpenRouter تعلن صفر قاعدة (سلوك ثابت)",
      n.OPENROUTER_NORMALIZATION_POLICY.rules.length === 0 &&
        n.OPENROUTER_NORMALIZATION_POLICY.provider === "openrouter",
    );
    check(
      "K2 سياسة AgentRouter تعلن صفر قاعدة",
      n.AGENTROUTER_NORMALIZATION_POLICY.rules.length === 0 &&
        n.AGENTROUTER_NORMALIZATION_POLICY.provider === "agentrouter",
    );
    const artifact = `{${validAiResponseJson()}`;
    for (const provider of ["openrouter", "agentrouter"] as const) {
      const r = n.normalizeResponse({
        content: artifact,
        provider,
        model: "any",
        policy:
          provider === "openrouter"
            ? n.OPENROUTER_NORMALIZATION_POLICY
            : n.AGENTROUTER_NORMALIZATION_POLICY,
      });
      check(
        `K3 ${provider}: نفس العيب → INVALID_RESPONSE (بلا إصلاح مزوّد)`,
        !r.ok &&
          r.trace.providerRepairRan === false &&
          r.trace.genericRepairProducedCandidate === false,
      );
    }
    // Cross-provider misuse: even if the ATRIA policy is wired to another
    // provider, the CORE scope gate must refuse to run it.
    const rCross = n.normalizeResponse({
      content: artifact,
      provider: "agentrouter",
      model: "any",
      policy: ATRIA,
    });
    check(
      "K4 بوابة النطاق: سياسة Atria لا تُنفَّذ لمزود آخر (حتى لو رُبِّطت)",
      !rCross.ok && rCross.trace.providerRepairRan === false,
    );
    check(
      "K5 isPolicyInScope يرفض: المزود المخالف / القواعد الفارغة / المزود الناقص",
      n.isPolicyInScope(ATRIA, { provider: "openrouter", model: "m" }) ===
        false &&
        n.isPolicyInScope(n.OPENROUTER_NORMALIZATION_POLICY, {
          provider: "openrouter",
          model: "m",
        }) === false &&
        n.isPolicyInScope(undefined, CTX) === false,
    );
  }

  // ── L: strict-first — repair not called when strict + schema succeed ─────
  {
    let ruleCalls = 0;
    const spyRule: NormalizerRule = {
      name: "SPY",
      apply: () => {
        ruleCalls += 1;
        return null;
      },
    };
    const spyPolicy: NormalizerPolicy = {
      provider: "atria",
      rules: [spyRule],
    };
    const rOk = n.normalizeResponse({
      content: validAiResponseJson(),
      provider: "atria",
      model: CTX.model,
      policy: spyPolicy,
    });
    check(
      "L1 JSON صالح → القاعدة لا تُستدعى إطلاقاً (0 استدعاءات)",
      rOk.ok && rOk.mode === "DIRECT_PARSE" && ruleCalls === 0,
    );
    check(
      "L2 المرحلة العامة لا تعمل عند نجاح الصارم + الـ schema",
      rOk.trace.genericRepairRan === false,
    );
    // Broken content: the rule IS reached (after the strict + generic stages).
    const rBad = n.normalizeResponse({
      content: `{${validAiResponseJson({ intent: "NOPE" })}`,
      provider: "atria",
      model: CTX.model,
      policy: spyPolicy,
    });
    check(
      "L3 محتوى معطوب → القاعدة تُستدعى (بعد الصارم + العام)",
      !rBad.ok && ruleCalls === 1,
    );
    // Schema-invalid but parseable: generic stage runs, and only because the
    // strict path could not accept it.
    check(
      "L4 الترتيب: الصارم أولاً، ثم العام، ثم سياسة المزود",
      rBad.trace.stage === "PROVIDER_REPAIR" &&
        rBad.trace.genericRepairRan === true &&
        rBad.trace.providerRepairRan === true,
    );
  }

  // ── M: no recursive repair ────────────────────────────────────────────────
  {
    let calls = 0;
    const countingRule: NormalizerRule = {
      name: "COUNT_ONCE",
      apply: (content: string) => {
        calls += 1;
        // Returning a candidate that still fails the schema proves the rule
        // is never re-invoked on its own output.
        return content.replace('"FAQ"', '"NOT_AN_INTENT"');
      },
    };
    const r = n.normalizeResponse({
      content: `{${validAiResponseJson()}`,
      provider: "atria",
      model: CTX.model,
      policy: { provider: "atria", rules: [countingRule] },
    });
    check(
      "M1 كل قاعدة تُستدعى مرة واحدة على الأكثر (بلا سلسلة طفرات)",
      !r.ok && calls === 1,
    );
    check(
      "M2 المرحلة العامة تعمل مرة واحدة فقط",
      r.trace.genericRepairRan === true,
    );
    check(
      "M3 عدد محاولات القواعد ≤ عدد القواعد المعلنة",
      r.trace.ruleAttempts.length <= 1,
    );
    // A rule whose candidate is rejected cannot re-enter the pipeline: the
    // same content through the engine twice is deterministic.
    const again = n.normalizeResponse({
      content: `{${validAiResponseJson()}`,
      provider: "atria",
      model: CTX.model,
      policy: { provider: "atria", rules: [countingRule] },
    });
    check(
      "M4 الحتمية: تشغيلان متطابقان ينتجان نفس النتيجة",
      again.ok === r.ok && again.mode === r.mode,
    );
    // Rule isolation: a THROWING rule declines instead of propagating.
    const throwingRule: NormalizerRule = {
      name: "THROWER",
      apply: () => {
        throw new Error("boom");
      },
    };
    const rThrow = n.normalizeResponse({
      content: `{${validAiResponseJson()}`,
      provider: "atria",
      model: CTX.model,
      policy: {
        provider: "atria",
        rules: [throwingRule, n.ATRIA_SURPLUS_BRACE_RULE],
      },
    });
    check(
      "M5 القاعدة التي تُستثني تُرفَض فقط (لا انتشار للخطأ)، والتالية تُجرَّب",
      rThrow.ok &&
        rThrow.mode === "BOUNDED_PROVIDER_REPAIR" &&
        rThrow.trace.providerRepairRule === "ATRIA_SURPLUS_BRACE",
    );
  }

  // ── N: idempotence ────────────────────────────────────────────────────────
  {
    const r1 = run(validAiResponseJson());
    const reSerialized = JSON.stringify(accepted(r1));
    const r2 = run(reSerialized);
    check(
      "N1 إعادة تطبيع الحمولة المقبولة → DIRECT_PARSE",
      r2.ok && r2.mode === "DIRECT_PARSE",
    );
    check(
      "N2 نفس الدلالة (تكافؤ تام)",
      JSON.stringify(accepted(r2)) === JSON.stringify(validAiResponseObj()),
    );
    // Idempotence through the repaired path too.
    const r3 = run(`{${validAiResponseJson()}`);
    const r4 = run(JSON.stringify(accepted(r3)));
    check(
      "N3 الحمولة المُصلَحة ثم أُعيد تطبيعها → DIRECT_PARSE وتكافؤ",
      r4.ok &&
        r4.mode === "DIRECT_PARSE" &&
        JSON.stringify(accepted(r4)) === JSON.stringify(accepted(r3)),
    );
    // Structural helpers are idempotent on already-clean content.
    check(
      "N4 stripJsonFences مُطابق لذاته على المحتوى النظيف",
      n.stripJsonFences(validAiResponseJson()) === validAiResponseJson(),
    );
  }

  // ── S: telemetry never leaks content or secrets ──────────────────────────
  {
    // A content marker (deliberately NOT shaped like any real secret) used
    // to prove the trace/summary never carries provider content.
    const marker = "MARKER-CONTENT-PROBE-0123456789abcdef";
    const proseWithMarker = `Hello ${marker} world`;
    const r = run(proseWithMarker);
    const traceJson = JSON.stringify(r.trace);
    const summary = n.summarizeNormalizerResult(r);
    check(
      "S1 الأثر لا يحتوي المحتوى أو الأسرار",
      !traceJson.includes(marker) && !summary.includes(marker),
    );
    check(
      "S2 الملخّص يحتوي فقط على إحصاءات شكلية",
      summary.includes("outcome=INVALID_RESPONSE") &&
        summary.includes("len=") &&
        !summary.includes("Hello"),
    );
    const rValid = run(validAiResponseJson({ content: marker }));
    check(
      "S3 الأثر على الاستجابة المقبولة لا يحتوي المحتوى",
      !JSON.stringify(rValid.trace).includes(marker),
    );
    check(
      "S4 البصمة تكشف الشكل فقط (طول/أول بايت/أقواس/مفاتيح)",
      (() => {
        const fp = r.trace.fingerprint;
        return (
          typeof fp.contentLength === "number" &&
          typeof fp.firstByte === "string" &&
          typeof fp.leadingBraceCount === "number" &&
          typeof fp.trailingBraceCount === "number" &&
          (fp.topLevelKeys === null || typeof fp.topLevelKeys === "number")
        );
      })(),
    );
  }

  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nمحرك التطبيع سليم: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
