/**
 * FlowPilot — BOUNDED REAL-LLM BUSINESS-IDENTITY PROBE (PROMPT-AI-UX-04B-2).
 *
 * ONE bounded live-provider probe (a handful of identity turns, NOT a broad
 * matrix) that verifies the generative identity path against a REAL model
 * using the REAL production-shaped pilot data (مركز أفنان — the live dental
 * pilot, read-only). It exercises exactly the seam 04B-2 changed:
 *
 *   real pilot data shape (in-memory)
 *     → deterministic bypass (the 04B-1 zero-call identity seam) OR B-02
 *       context builder
 *     → REAL Atria adapter (the live policy provider)
 *     → parseAiResponse
 *     → B-03 disclosure gate (structural)
 *
 * Fixtures (kept deliberately tiny and cost-bounded):
 *   I-DET   the canonical identity question → the deterministic zero-call seam
 *           (proves the target UX is answered WITHOUT spending a call)
 *   I-GEN   a pure identity ask that reaches the generative path
 *           (providerChoice overlap) → confident FAQ/reply from businessName
 *   I-MIX   identity + booking → the identity is answered and the booking is
 *           not lost (no unnecessary NO_KNOWLEDGE handoff)
 *
 * The probe NEVER prints the API key (presence only), NEVER writes production
 * data, and NEVER silently falls back to a mock: a provider failure is a
 * BLOCKED_PROVIDER exit.
 *
 * Run (reads the key by NAME only):
 *   pnpm exec dotenv -e .env.local -e .env -- tsx \
 *     scripts/probe-business-identity.ts \
 *     --provider atria --model Atria-Dawn-Preview --timeout-ms 60000
 */

import { buildAiContext } from "@/features/conversations/server/ai-context-builder";
import type { AiRequest } from "@/features/conversations/server/ai-contract";
import { parseAiResponse } from "@/features/conversations/server/ai-contract";
import { enforceDisclosure } from "@/features/conversations/server/ai-disclosure/disclosure-gate";
import { bypassDeterministicAi } from "@/features/conversations/server/conversation-ai";
import { createAtriaAdapter } from "@/server/integrations/ai/atria";
import { createCodeCraftAdapter } from "@/server/integrations/ai/codecraft";
import type { AiProviderAdapter } from "@/server/integrations/ai/types";

export {};

// ─── REAL pilot data shape (مركز أفنان — production read-only) ──────────────

const PILOT_NAME = "مركز أفنان";
const PILOT_ABOUT = "عيادة اسنان متخصصة في زراعة الاسنان وعمل التركيبات";
const PILOT_ADDRESS = "شارع الاستاد - دسوق - كفر الشيخ";

const PILOT_SERVICES = [
  {
    id: "svc-1",
    businessId: "business-1",
    name: "استشارة أسنان",
    description: "استشارة وتشخيص أسنان أولية",
    priceType: "FIXED",
    priceAmount: 300,
    priceCurrency: "EGP",
  },
  {
    id: "svc-2",
    businessId: "business-1",
    name: "كشف جراحة",
    description: null,
  },
] as const;

const PILOT_FAQS = [
  {
    question: "هل يتم تأكيد الموعد تلقائيا؟",
    answer: "نعم، يتم تأكيد الموعد تلقائياً فور حجزه.",
  },
];

/** The UX-04A hedge/disclaimer failure mode a compliant reply must not carry. */
const BANNED_HEDGE_WORDS = [
  "الاسم المسجل",
  "المسجل",
  "المسجَّل",
  "بحسب البيانات",
  "البيانات الموجودة",
  "تأكيد رسمي",
  "لا أستطيع التأكد",
  "لا استطيع التأكد",
  "تواصل مع الفريق للتأكيد",
];

type ProbeFixture = {
  readonly id: string;
  readonly message: string;
  readonly deterministic?: boolean;
  readonly note: string;
  /**
   * Words that would indicate the reply AFFIRMED an attribute the pilot never
   * stored (spec case D — unsupported attribute). Asserted ABSENT from the
   * shipped content: the prompt confines the identity reply to the name and
   * leaves an unvalued attribute unasserted, so a compliant reply carries the
   * name only and never manufactures a license/syndicate/accreditation fact.
   */
  readonly unsupportedAttribute?: readonly string[];
};

const FIXTURES: ReadonlyArray<ProbeFixture> = [
  {
    id: "I-DET",
    message: "هو انتو عيادة الدكتورة أفنان؟",
    deterministic: true,
    note: "المثال الأساسي: يجب أن يجيبه الفرع الحتمي بصفر نداءات",
  },
  {
    id: "I-GEN",
    message: "إيه اسم العيادة؟",
    note: "سؤال هوية نقي يصل للمزود (تداخل providerChoice): إجابة واثقة من businessName",
  },
  {
    id: "I-WORD",
    message: "إيه اسمك بالظبط؟",
    note: "صياغة هوية مختلفة تصل للمزود: إجابة واثقة من businessName بصياغة طبيعية",
  },
  {
    id: "I-MIX",
    message: "هو انتو مركز أفنان؟ وعايز أحجز بكرة",
    note: "هوية + حجز: تُجاب الهوية ولا يُفقد الحجز (لا تحويل NO_KNOWLEDGE بلا داعٍ)",
  },
  {
    id: "I-ATTR",
    message: "إيه اسم العيادة؟ وانتو مرخّصين من نقابة أطباء الأسنان؟",
    note: "هوية + سمة غير مدعومة (ترخيص/نقابة): الاسم يؤكد ولا يُقرّ الترخيص المخترع",
    unsupportedAttribute: [
      "مرخّص",
      "مرخص",
      "مرخّصة",
      "مرخصة",
      "نقابة",
      "نقابه",
      "معتمد",
      "معتمدة",
      "اعتماد",
      "ترخيص",
    ],
  },
];

type ProbeResult = {
  id: string;
  pass: boolean;
  deterministic: boolean;
  providerCalled: boolean;
  intent: string | null;
  action: string | null;
  handoffReason: string | null;
  gate: string | null;
  gateReason: string | null;
  support: readonly string[];
  hedgeFree: boolean;
  confirmsName: boolean;
  latencyMs: number | null;
  note?: string;
};

function parseArgs(argv: ReadonlyArray<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1]?.startsWith("--")
        ? "true"
        : (argv[i + 1] ?? "true");
      map.set(key, value);
      if (value !== "true") i += 1;
    }
  }
  return map;
}

function sourcesFor(message: string) {
  return {
    business: {
      businessId: "business-1",
      name: PILOT_NAME,
      about: PILOT_ABOUT,
      address: PILOT_ADDRESS,
      faqs: PILOT_FAQS,
      whatsappNumber: "+201000000000",
      cancellationPolicy: null,
      workingHours: null,
      slotDurationMinutes: 30,
      confirmationMode: "automatic",
      timezone: "Africa/Cairo",
      vertical: "dental",
      city: "كفر الشيخ",
    },
    services: PILOT_SERVICES,
    conversation: { status: "AI_ACTIVE" as const, recentMessages: [] },
    message,
  };
}

function hedgeFree(content: string): boolean {
  return BANNED_HEDGE_WORDS.every((word) => !content.includes(word));
}

function confirmsName(content: string): boolean {
  return content.includes(PILOT_NAME);
}

/**
 * Does the reply AFFIRM an attribute the business never stored? Affirmation is
 * NOT bare presence of the word: a compliant model may mention the attribute
 * only to DECLINE it («المعلومة دي مش متوفرة عندي») or to refer it away
 * («سأقوم بتحويلك إلى فريق المركز»). An occurrence counts as an AFFIRMATION
 * only when it survives clause-level screening: the attribute appears in a
 * sentence clause that carries NO negation token and NO referral/handoff
 * marker — i.e. the model asserted the attribute instead of refusing it.
 *
 * Two design points are load-bearing:
 *
 *  • CLAUSE SCOPE on sentence terminators (، is deliberately NOT a separator:
 *    «نعم، مرخّصة من النقابة» is ONE positive claim). Arabic negation and
 *    referral wording live inside the same clause as the refused attribute, so
 *    screening per-clause neither misses a refusal nor lets a fabrication hide
 *    behind a negation in some unrelated sentence.
 *
 *  • TOKEN matching, never substring matching: «الاسنان» contains the letters
 *    of «لا», so a substring test would see a negation that was never written.
 *    Prefix clitics (و/ف/ال/ب/ل/ك) are stripped first so «فلا» → «لا» while
 *    «الاسنان» → «اسنان».
 *
 * This is a screen, not a verdict: the probe prints the shipped content on any
 * failure so the decline/fabrication boundary is adjudicated by an operator.
 */
const NEGATION_TOKENS = new Set([
  "مش",
  "ماش",
  "لا",
  "غير",
  "ليس",
  "ليست",
  "مافيش",
  "عنديش",
]);

/**
 * Wording that refers the attribute away instead of answering it — an
 * escalation to a human/team. Present in both observed live declines, and a
 * legitimate non-affirming way to name the attribute.
 */
const REFERRAL_TOKENS = new Set([
  "حوّل",
  "حول",
  "تحويل",
  "موظف",
  "فريق",
  "سيرد",
  "تواصل",
  "الرد",
]);

/**
 * Leading Arabic clitics/articles stripped before a token is classified, so
 * «فلا» → «لا» (negation) while «الاسنان» → «اسنان» (not negation). The
 * longer article+conjunction combinations are tried before the single letters.
 */
const TOKEN_PREFIXES = [
  "وال",
  "فال",
  "بال",
  "كال",
  "ال",
  "و",
  "ف",
  "ل",
  "ب",
  "ك",
];

function stripTokenPrefix(token: string): string {
  for (const prefix of TOKEN_PREFIXES) {
    if (token.startsWith(prefix) && token.length > prefix.length) {
      return token.slice(prefix.length);
    }
  }
  return token;
}

/** Sentence clauses — split on terminators ONLY (، is part of a clause). */
function splitClauses(text: string): string[] {
  return text
    .split(/[.؛\n]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function affirmsAttribute(content: string, attribute: string): boolean {
  for (const clause of splitClauses(content)) {
    if (!clause.includes(attribute)) continue;
    const tokens = clause.split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) continue;
    const stems = tokens.map(stripTokenPrefix);
    if (stems.some((stem) => NEGATION_TOKENS.has(stem))) continue;
    if (stems.some((stem) => REFERRAL_TOKENS.has(stem))) continue;
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = args.get("provider") ?? "atria";
  const model =
    args.get("model") ?? process.env.ATRIA_MODEL ?? "Atria-Dawn-Preview";
  const timeoutMs = Number(args.get("timeout-ms") ?? "60000");

  const keyName =
    provider === "atria"
      ? "ATRIA_API_KEY"
      : provider === "codecraft"
        ? "CODECRAFT_API_KEY"
        : provider === "openrouter"
          ? "OPENROUTER_API_KEY"
          : "AGENTROUTER_API_KEY";
  if (!process.env[keyName]) {
    console.error(
      `BLOCKED_PROVIDER — ${keyName} is not present in the environment; refusing to run.`,
    );
    process.exit(2);
  }

  console.log(`provider: ${provider}`);
  console.log(`model: ${model}`);
  console.log(`key: ${keyName} (presence only — value never read/printed)`);
  console.log(`business: ${PILOT_NAME} (real pilot data shape)`);
  console.log(`fixtures: ${FIXTURES.length} (bounded identity probe)\n`);

  let adapter: AiProviderAdapter;
  if (provider === "atria") {
    adapter = createAtriaAdapter({
      model,
      getEnvVar: (name) => process.env[name],
      fetchImpl: fetch,
      timeoutMs,
    });
  } else if (provider === "codecraft") {
    adapter = createCodeCraftAdapter({
      model,
      getEnvVar: (name) => process.env[name],
      fetchImpl: fetch,
      timeoutMs,
    });
  } else {
    console.error(
      `This focused identity probe supports --provider atria|codecraft. Got: ${provider}`,
    );
    process.exit(2);
  }

  const results: ProbeResult[] = [];

  for (const f of FIXTURES) {
    // ── The canonical identity question is a ZERO-CALL path (04B-1) ────────
    if (f.deterministic) {
      const built = buildAiContext({
        scope: { businessId: "business-1" },
        sources: sourcesFor(f.message),
      });
      const bypassed = bypassDeterministicAi(built.request);
      if (bypassed === null) {
        results.push({
          id: f.id,
          pass: false,
          deterministic: true,
          providerCalled: false,
          intent: null,
          action: null,
          handoffReason: null,
          gate: null,
          gateReason: null,
          support: [],
          hedgeFree: false,
          confirmsName: false,
          latencyMs: 0,
          note: "deterministic seam returned null for the canonical identity question",
        });
        console.log(`✘ ${f.id} — deterministic seam returned null`);
        continue;
      }
      const decision = enforceDisclosure({
        response: bypassed,
        context: { request: built.request, facts: built.facts },
      });
      const clean = hedgeFree(bypassed.content);
      const named = confirmsName(bypassed.content);
      const pass =
        bypassed.intent === "FAQ" &&
        bypassed.action === "reply" &&
        decision.kind === "disclosed" &&
        clean &&
        named;
      results.push({
        id: f.id,
        pass,
        deterministic: true,
        providerCalled: false,
        intent: bypassed.intent,
        action: bypassed.action,
        handoffReason: bypassed.handoffReason ?? null,
        gate: decision.kind,
        gateReason: decision.kind === "requires-human" ? decision.reason : null,
        support: decision.kind === "disclosed" ? decision.support : [],
        hedgeFree: clean,
        confirmsName: named,
        latencyMs: 0,
      });
      console.log(
        `${pass ? "✔" : "✘"} ${f.id} — DETERMINISTIC (0 calls) intent=${bypassed.intent} action=${bypassed.action} gate=${decision.kind} support=[${decision.kind === "disclosed" ? decision.support.join(",") : "-"}] name=${named} hedgeFree=${clean}`,
      );
      console.log(`   content: ${bypassed.content}`);
      continue;
    }

    const built = buildAiContext({
      scope: { businessId: "business-1" },
      sources: sourcesFor(f.message),
    });
    const request: AiRequest = built.request;
    let call = await adapter.call(request);
    if (!call.ok && call.error.retryable) {
      console.log(`↻ ${f.id} — retryable provider failure; one retry`);
      call = await adapter.call(request);
    }
    if (!call.ok) {
      results.push({
        id: f.id,
        pass: false,
        deterministic: false,
        providerCalled: true,
        intent: null,
        action: null,
        handoffReason: null,
        gate: null,
        gateReason: null,
        support: [],
        hedgeFree: false,
        confirmsName: false,
        latencyMs: call.latencyMs ?? null,
        note: `provider failure: ${call.error.code}`,
      });
      console.log(`✘ ${f.id} — provider failure (${call.error.code})`);
      continue;
    }
    const parsed = parseAiResponse(call.response);
    if (!parsed) {
      results.push({
        id: f.id,
        pass: false,
        deterministic: false,
        providerCalled: true,
        intent: null,
        action: null,
        handoffReason: null,
        gate: null,
        gateReason: null,
        support: [],
        hedgeFree: false,
        confirmsName: false,
        latencyMs: call.latencyMs ?? null,
        note: "parseAiResponse rejected the provider object",
      });
      console.log(`✘ ${f.id} — malformed provider object`);
      continue;
    }
    const decision = enforceDisclosure({
      response: parsed,
      context: { request, facts: built.facts },
    });
    const clean = hedgeFree(parsed.content);
    const named = confirmsName(parsed.content);
    // Spec case D: an asserted-but-unstored attribute (license/syndicate/
    // accreditation) must never be AFFIRMED. The prompt confines the identity
    // reply to the name and leaves an unvalued attribute unasserted, so a
    // compliant reply either omits the attribute or mentions it only to
    // DECLINE it. AFFIRMATION is therefore not bare presence: an occurrence
    // counts as affirmed only when the reply makes a POSITIVE claim of it,
    // detected here as an attribute occurrence with NO negation/absence marker
    // in the forward window — the shape of Egyptian-Arabic decline («المعلومة
    // دي مش متوفرة») versus fabrication («إحنا مرخّصين من نقابة…»).
    const affirmedUnsupported =
      f.unsupportedAttribute?.some((word) =>
        affirmsAttribute(parsed.content, word),
      ) ?? false;
    // The identity must be answered, and the turn must not become an
    // AMBIGUOUS handoff or a NO_KNOWLEDGE handoff for the IDENTITY itself.
    // For a mixed identity + knowledge-gap turn (an unsupported attribute), a
    // NO_KNOWLEDGE handoff is the BINDING correct action: the prompt keeps a
    // required knowledge-gap handoff above answer-and-continue, so the name is
    // confirmed in the handoff content and the unanswerable attribute is
    // escalated. Only an AMBIGUOUS handoff stays a failure there.
    const unnecessaryHandoff =
      parsed.action === "handoff" &&
      (parsed.handoffReason === "AMBIGUOUS" ||
        (parsed.handoffReason === "NO_KNOWLEDGE" && !f.unsupportedAttribute));
    const pass =
      !unnecessaryHandoff &&
      !affirmedUnsupported &&
      decision.kind === "disclosed" &&
      clean &&
      named &&
      (f.unsupportedAttribute
        ? parsed.action === "reply" || parsed.action === "handoff"
        : f.id === "I-MIX"
          ? parsed.action === "reply" || parsed.action === "booking_handoff"
          : parsed.intent === "FAQ" && parsed.action === "reply");
    results.push({
      id: f.id,
      pass,
      deterministic: false,
      providerCalled: true,
      intent: parsed.intent,
      action: parsed.action,
      handoffReason: parsed.handoffReason ?? null,
      gate: decision.kind,
      gateReason: decision.kind === "requires-human" ? decision.reason : null,
      support: decision.kind === "disclosed" ? decision.support : [],
      hedgeFree: clean,
      confirmsName: named,
      latencyMs: call.latencyMs ?? null,
    });
    console.log(
      `${pass ? "✔" : "✘"} ${f.id} — intent=${parsed.intent} action=${parsed.action} handoff=${parsed.handoffReason ?? "-"} gate=${decision.kind}${decision.kind === "requires-human" ? `(${decision.reason})` : ""} support=[${decision.kind === "disclosed" ? decision.support.join(",") : "-"}] name=${named} hedgeFree=${clean}${f.unsupportedAttribute ? ` attrClean=${!affirmedUnsupported}` : ""} latency=${call.latencyMs ?? "?"}ms`,
    );
    if (!pass) console.log(`   content: ${parsed.content.slice(0, 240)}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const providerFailures = results.filter(
    (r) => r.providerCalled && r.intent === null,
  ).length;
  const providerCalls = results.filter((r) => r.providerCalled).length;

  console.log(
    `\n${passed}/${results.length} identity classes passed · ${providerFailures} provider failures · ${providerCalls} real provider call(s)`,
  );

  if (providerFailures > 0) {
    console.error("\nBLOCKED_PROVIDER — at least one real call failed.");
    process.exit(2);
  }
  if (passed !== results.length) {
    process.exit(1);
  }
  console.log("\nBOUNDED REAL-LLM BUSINESS-IDENTITY PROBE: PASS");
}

main().catch((error: Error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
