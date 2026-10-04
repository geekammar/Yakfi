/**
 * FlowPilot AI Evaluation — PROMPT-AI-OPS-24 LIVE PILOT / PRODUCT LOOP
 * VERIFICATION with the Atria provider as the SOLE live AI path.
 *
 * Verification only: it changes NO production behavior and mutates NO
 * production data. It drives the EXISTING B-02 context builder + the REAL
 * Atria adapter (the live policy provider) + the EXISTING B-03 disclosure
 * gate + the deterministic greeting bypass over a focused matrix derived
 * from the REAL pilot business data shape (مركز أفنان — the live dental
 * pilot), so every customer-visible class is proven against a real model
 * instead of an offline assertion:
 *
 *   real pilot data shape (in-memory)
 *     → deterministic bypass (greeting) OR B-02 context builder
 *     → real Atria adapter → parseAiResponse
 *     → B-03 disclosure gate (structural, no fabrication)
 *
 * It proves the false-handoff defect class is resolved WITH a healthy
 * provider: ordinary information questions (location / hours / services /
 * price / FAQ) do NOT become NEED_HUMAN merely because they are normal
 * business information.
 *
 * Run (reads the key by NAME only, never prints it):
 *   pnpm exec dotenv -e .env.local -e .env -- tsx \
 *     scripts/eval-run-future-op24.ts \
 *     --provider atria --model Atria-Dawn-Preview --timeout-ms 60000
 *
 * STOPS + reports a BLOCKER if the provider is unavailable — it never
 * silently falls back to a mock or the deterministic classifier.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAiContext } from "@/features/conversations/server/ai-context-builder";
import type { AiRequest } from "@/features/conversations/server/ai-contract";
import { parseAiResponse } from "@/features/conversations/server/ai-contract";
import { enforceDisclosure } from "@/features/conversations/server/ai-disclosure/disclosure-gate";
import { bypassDeterministicAi } from "@/features/conversations/server/conversation-ai";
import { createAtriaAdapter } from "@/server/integrations/ai/atria";
import { createCodeCraftAdapter } from "@/server/integrations/ai/codecraft";
import type { AiProviderAdapter } from "@/server/integrations/ai/types";

export {};

// ─── REAL pilot data shape (مركز أفنان, read from production read-only) ──────
// The exact authoritative values the live pilot stores today. Nothing is
// invented; a missing-value variant nulls a field to prove the honest
// NO_KNOWLEDGE path.

const PILOT_NAME = "مركز أفنان";
const PILOT_ABOUT = "عيادة اسنان متخصصة في زراعة الاسنان وعمل التركيبات";
const PILOT_ADDRESS = "شارع الاستاد - دسوق - كفر الشيخ";

type PilotService = {
  id: string;
  businessId: string;
  name: string;
  description?: string | null;
  priceType?: string | null;
  priceAmount?: number | null;
  priceMaxAmount?: number | null;
  priceCurrency?: string | null;
  priceNote?: string | null;
};

const PILOT_SERVICES: ReadonlyArray<PilotService> = [
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
  {
    id: "svc-3",
    businessId: "business-1",
    name: "حشو عصب",
    description: null,
    priceType: "RANGE",
    priceAmount: 1200,
    priceMaxAmount: 2000,
    priceCurrency: "EGP",
  },
  {
    id: "svc-4",
    businessId: "business-1",
    name: "جلسة تجميلية",
    description: null,
    priceType: "CONDITIONAL",
    priceNote: "حسب الحالة",
  },
];

const PILOT_FAQS: ReadonlyArray<{ question: string; answer: string }> = [
  {
    question: "هل يتم تأكيد الموعد تلقائيا؟",
    answer: "نعم، يتم تأكيد الموعد تلقائياً فور حجزه.",
  },
];

type Fixture = {
  readonly id: string;
  readonly message: string;
  readonly about: string | null;
  readonly address: string | null;
  readonly services: ReadonlyArray<PilotService>;
  readonly faqs: ReadonlyArray<{ question: string; answer: string }>;
  /** True when the turn is expected to be the zero-call deterministic path. */
  readonly deterministic?: boolean;
  readonly expect: {
    readonly action: "reply" | "handoff" | "booking_handoff";
    readonly gate: "disclosed" | "requires-human";
    readonly contains?: string;
    readonly handoffReason?: string;
    readonly mustNotContain?: string;
  };
};

function fixture(overrides: Partial<Fixture>): Fixture {
  return {
    id: "base",
    message: "",
    about: PILOT_ABOUT,
    address: PILOT_ADDRESS,
    services: PILOT_SERVICES,
    faqs: PILOT_FAQS,
    expect: { action: "reply", gate: "disclosed" },
    ...overrides,
  };
}

/**
 * The matrix — the customer-classes this verification must prove.
 * A. greeting · B. business info · C. service discovery · D. price ·
 * E. FAQ/knowledge · F. booking intent · G. human handoff.
 */
const FIXTURES: ReadonlyArray<Fixture> = [
  // ── A. GREETING (deterministic, zero provider call) ─────────────────────
  fixture({
    id: "A-greeting",
    message: "اهلا",
    deterministic: true,
    expect: { action: "reply", gate: "disclosed", contains: "أهلا" },
  }),

  // ── B. BUSINESS INFORMATION (the false-handoff class) ───────────────────
  // NOTE on gate semantics: a routing action (`handoff`/`booking_handoff`)
  // discloses no knowledge, so the gate PASSES IT THROUGH (`disclosed`) and
  // the engine's own NEED_HUMAN contract owns the turn. `requires-human` is
  // the gate's refusal of an unbacked REPLY only. So an honest handoff is
  // asserted as action=handoff + gate=disclosed, and the fabrication guard
  // is the `mustNotContain` check on the customer-visible content.
  fixture({
    id: "B-about",
    message: "انتو مين؟",
    expect: { action: "reply", gate: "disclosed" },
  }),
  fixture({
    id: "B-location",
    message: "أين موقعكم؟",
    expect: { action: "reply", gate: "disclosed", contains: "دسوق" },
  }),
  fixture({
    id: "B-location-missing",
    message: "أين موقعكم؟",
    address: null,
    expect: {
      action: "handoff",
      gate: "disclosed",
      handoffReason: "NO_KNOWLEDGE",
      mustNotContain: "شارع",
    },
  }),
  fixture({
    id: "B-hours",
    message: "مواعيد العمل ايه؟",
    // workingHours are INTERNAL by design; the model must not invent hours.
    expect: {
      action: "handoff",
      gate: "disclosed",
      handoffReason: "NO_KNOWLEDGE",
      mustNotContain: "الساعة",
    },
  }),

  // ── C. SERVICE DISCOVERY ────────────────────────────────────────────────
  fixture({
    id: "C-service-list",
    message: "ما الخدمات المتاحة؟",
    expect: {
      action: "reply",
      gate: "disclosed",
      contains: "استشارة أسنان",
    },
  }),
  fixture({
    id: "C-specific-service",
    message: "هل يوجد عندكم حشو عصب؟",
    expect: { action: "reply", gate: "disclosed", contains: "حشو" },
  }),
  fixture({
    id: "C-service-description",
    message: "الاستشارة بيشمل ايه؟",
    expect: { action: "reply", gate: "disclosed" },
  }),

  // ── D. PRICE (the system must NOT invent a price) ───────────────────────
  fixture({
    id: "D-price-known",
    message: "الاستشارة بكام؟",
    expect: { action: "reply", gate: "disclosed", contains: "300" },
  }),
  fixture({
    id: "D-price-range",
    message: "حشو العصب بكام؟",
    expect: { action: "reply", gate: "disclosed", contains: "1200" },
  }),
  fixture({
    id: "D-price-missing",
    message: "كشف الجراحة بكام؟",
    // كشف جراحة has NO price — the model must hand off, never invent a number.
    expect: {
      action: "handoff",
      gate: "disclosed",
      handoffReason: "NO_KNOWLEDGE",
      mustNotContain: "جنيه",
    },
  }),

  // ── E. FAQ / KNOWLEDGE ──────────────────────────────────────────────────
  fixture({
    id: "E-faq-known",
    message: "هل يتم تأكيد الموعد تلقائيا؟",
    expect: { action: "reply", gate: "disclosed", contains: "تلقائيا" },
  }),
  fixture({
    id: "E-faq-missing",
    message: "هل عندكم خدمة توصيل للبيت؟",
    faqs: [],
    expect: {
      action: "handoff",
      gate: "disclosed",
      handoffReason: "NO_KNOWLEDGE",
      mustNotContain: "نعم",
    },
  }),

  // ── F. BOOKING INTENT (domain authority owns availability) ──────────────
  fixture({
    id: "F-booking-intent",
    message: "عايز أحجز كشف بكرة",
    expect: { action: "booking_handoff", gate: "disclosed" },
  }),

  // ── G. HUMAN HANDOFF ───────────────────────────────────────────────────
  // Wire-level handoffReason values are HUMAN_REQUEST/SENSITIVE/NO_KNOWLEDGE/
  // AMBIGUOUS (the Slice-7 typed CAUSE is a separate engine-level enum).
  fixture({
    id: "G-explicit-human",
    message: "عايز أكلم دكتور بشخصي",
    expect: {
      action: "handoff",
      gate: "disclosed",
      handoffReason: "HUMAN_REQUEST",
    },
  }),
  fixture({
    id: "G-sensitive",
    message: "عندي نزيف شديد في اللثة وحاجة طارئة",
    expect: { action: "handoff", gate: "disclosed" },
  }),
  fixture({
    id: "G-ambiguous",
    message: "ما العملة المستخدمة في علاج الضرس؟",
    expect: { action: "handoff", gate: "disclosed" },
  }),
];

type Result = {
  id: string;
  ok: boolean;
  deterministic: boolean;
  latencyMs: number | null;
  intent: string | null;
  action: string | null;
  handoffReason: string | null;
  gate: string | null;
  gateReason: string | null;
  support: readonly string[];
  contentContainsExpected: boolean;
  contentViolatesMustNot: boolean;
  providerCalled: boolean;
  pass: boolean;
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

function sourcesFor(f: Fixture) {
  return {
    business: {
      businessId: "business-1",
      name: PILOT_NAME,
      about: f.about,
      address: f.address,
      faqs: f.faqs,
      whatsappNumber: "+201000000000",
      cancellationPolicy: null,
      workingHours: null,
      slotDurationMinutes: 30,
      confirmationMode: "automatic",
      timezone: "Africa/Cairo",
      vertical: "dental",
      city: "كفر الشيخ",
    },
    services: f.services,
    conversation: { status: "AI_ACTIVE" as const, recentMessages: [] },
    message: f.message,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = args.get("provider") ?? "atria";
  const model =
    args.get("model") ?? process.env.ATRIA_MODEL ?? "Atria-Dawn-Preview";
  const timeoutMs = Number(args.get("timeout-ms") ?? "60000");
  const outDir =
    args.get("out") ?? "evaluation/reports/egyptian-v1/real-llm-op24";

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
      `This focused probe supports --provider atria|codecraft. Got: ${provider}`,
    );
    process.exit(2);
  }

  const results: Result[] = [];
  for (const f of FIXTURES) {
    // ── The deterministic bypass (greeting) is a ZERO-CALL path ──────────
    if (f.deterministic) {
      // The probe goes through the same builder so the request is a valid
      // `AiRequest` (the schema's defaulted arrays are materialized).
      const built = buildAiContext({
        scope: { businessId: "business-1" },
        sources: sourcesFor(f),
      });
      const probe: AiRequest = built.request;
      const bypassed = bypassDeterministicAi(probe);
      if (bypassed === null) {
        results.push({
          id: f.id,
          ok: false,
          deterministic: true,
          latencyMs: 0,
          intent: null,
          action: null,
          handoffReason: null,
          gate: null,
          gateReason: null,
          support: [],
          contentContainsExpected: false,
          contentViolatesMustNot: false,
          providerCalled: false,
          pass: false,
          note: "deterministic bypass returned null for a greeting",
        });
        console.log(`✘ ${f.id} — bypass returned null`);
        continue;
      }
      const decision = enforceDisclosure({
        response: bypassed,
        context: { request: probe, facts: [] },
      });
      const containsOk = f.expect.contains
        ? bypassed.content.includes(f.expect.contains)
        : true;
      const violates = f.expect.mustNotContain
        ? bypassed.content.includes(f.expect.mustNotContain)
        : false;
      const pass =
        bypassed.action === f.expect.action &&
        decision.kind === f.expect.gate &&
        containsOk &&
        !violates;
      results.push({
        id: f.id,
        ok: true,
        deterministic: true,
        latencyMs: 0,
        intent: bypassed.intent,
        action: bypassed.action,
        handoffReason: bypassed.handoffReason ?? null,
        gate: decision.kind,
        gateReason: decision.kind === "requires-human" ? decision.reason : null,
        support: decision.kind === "disclosed" ? decision.support : [],
        contentContainsExpected: containsOk,
        contentViolatesMustNot: violates,
        providerCalled: false,
        pass,
      });
      console.log(
        `${pass ? "✔" : "✘"} ${f.id} — DETERMINISTIC (0 calls) action=${bypassed.action} gate=${decision.kind} latency=0ms`,
      );
      continue;
    }

    const built = buildAiContext({
      scope: { businessId: "business-1" },
      sources: sourcesFor(f),
    });
    const request: AiRequest = built.request;
    let call = await adapter.call(request);
    // A transient provider timeout is retried ONCE (same request, same
    // adapter) so a slow first attempt cannot be misread as a product
    // defect. The retry is bounded to one and only for provider failures.
    if (!call.ok && call.error.retryable) {
      console.log(
        `↻ ${f.id} — retryable provider failure (${call.error.code}); one retry`,
      );
      call = await adapter.call(request);
    }
    if (!call.ok) {
      results.push({
        id: f.id,
        ok: false,
        deterministic: false,
        latencyMs: call.latencyMs ?? null,
        intent: null,
        action: null,
        handoffReason: null,
        gate: null,
        gateReason: null,
        support: [],
        contentContainsExpected: false,
        contentViolatesMustNot: false,
        providerCalled: true,
        pass: false,
        note: `provider failure: ${call.error.code}`,
      });
      console.log(`✘ ${f.id} — provider failure (${call.error.code})`);
      continue;
    }
    const parsed = parseAiResponse(call.response);
    if (!parsed) {
      results.push({
        id: f.id,
        ok: true,
        deterministic: false,
        latencyMs: call.latencyMs ?? null,
        intent: null,
        action: null,
        handoffReason: null,
        gate: null,
        gateReason: null,
        support: [],
        contentContainsExpected: false,
        contentViolatesMustNot: false,
        providerCalled: true,
        pass: false,
        note: "parseAiResponse rejected the provider object",
      });
      console.log(`✘ ${f.id} — malformed provider object`);
      continue;
    }
    const decision = enforceDisclosure({
      response: parsed,
      context: { request, facts: built.facts },
    });
    const contentContainsExpected = f.expect.contains
      ? parsed.content.includes(f.expect.contains)
      : true;
    const contentViolatesMustNot = f.expect.mustNotContain
      ? parsed.content.includes(f.expect.mustNotContain)
      : false;
    const gate = decision.kind;
    const gateReason =
      decision.kind === "requires-human" ? decision.reason : null;
    const support = decision.kind === "disclosed" ? decision.support : [];
    const pass =
      parsed.action === f.expect.action &&
      gate === f.expect.gate &&
      contentContainsExpected &&
      !contentViolatesMustNot &&
      (f.expect.handoffReason
        ? parsed.handoffReason === f.expect.handoffReason
        : true);
    results.push({
      id: f.id,
      ok: true,
      deterministic: false,
      latencyMs: call.latencyMs ?? null,
      intent: parsed.intent,
      action: parsed.action,
      handoffReason: parsed.handoffReason ?? null,
      gate,
      gateReason,
      support,
      contentContainsExpected,
      contentViolatesMustNot,
      providerCalled: true,
      pass,
    });
    console.log(
      `${pass ? "✔" : "✘"} ${f.id} — intent=${parsed.intent} action=${parsed.action} handoff=${parsed.handoffReason ?? "-"} gate=${gate}${gateReason ? `(${gateReason})` : ""} latency=${call.latencyMs ?? "?"}ms`,
    );
    if (!pass) {
      console.log(
        `   expected: action=${f.expect.action} gate=${f.expect.gate}${f.expect.handoffReason ? ` handoff=${f.expect.handoffReason}` : ""}${f.expect.contains ? ` contains="${f.expect.contains}"` : ""}${f.expect.mustNotContain ? ` mustNotContain="${f.expect.mustNotContain}"` : ""}`,
      );
      console.log(`   content: ${parsed.content.slice(0, 160)}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const providerFailures = results.filter((r) => !r.ok).length;
  const providerCalls = results.filter((r) => r.providerCalled && r.ok).length;
  // FALSE-HANDOFF CHECK: an ordinary information question that the customer
  // experiences as a handoff. The engine's routing action (`handoff`) is the
  // customer-visible handoff; the gate's `requires-human` is only the refusal
  // of an unbacked reply. So the defect class is: a fixture whose question is
  // an ordinary information request, the model was REACHED and SUCCEEDED, and
  // the turn still resolved to `action=handoff` with a NON-sensitive,
  // NON-human-requested cause.
  const ORDINARY_INFO_IDS = new Set([
    "B-about",
    "B-location",
    "C-service-list",
    "C-specific-service",
    "C-service-description",
    "D-price-known",
    "D-price-range",
    "E-faq-known",
  ]);
  const falseHandoffs = results.filter(
    (r) =>
      r.ok &&
      !r.deterministic &&
      ORDINARY_INFO_IDS.has(r.id) &&
      r.action === "handoff",
  );

  mkdirSync(resolve(outDir), { recursive: true });
  writeFileSync(
    resolve(outDir, "results.json"),
    `${JSON.stringify(
      {
        provider,
        model,
        results,
        passed,
        total: results.length,
        providerFailures,
        providerCalls,
        falseHandoffs: falseHandoffs.map((r) => r.id),
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\n${passed}/${results.length} classes passed · ${providerFailures} provider failures · ${providerCalls} real provider calls`,
  );
  if (falseHandoffs.length > 0) {
    console.log(
      `FALSE-HANDOFF CHECK: ${falseHandoffs.length} ordinary question(s) wrongly handed off: ${falseHandoffs.map((r) => r.id).join(", ")}`,
    );
  } else {
    console.log(
      "FALSE-HANDOFF CHECK: PASS — no ordinary information question became a human handoff",
    );
  }
  console.log(`artifacts: ${outDir}/results.json`);

  if (providerFailures > 0) {
    console.error("\nBLOCKED_PROVIDER — at least one real call failed.");
    process.exit(2);
  }
  if (passed !== results.length) {
    process.exit(1);
  }
  console.log("\nREAL-LLM OPS-24 LIVE PILOT VERIFICATION: PASS");
}

main().catch((error: Error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
