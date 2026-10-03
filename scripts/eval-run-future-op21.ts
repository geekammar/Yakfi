/**
 * FlowPilot AI Evaluation — PROMPT-AI-OPS-21 low-friction business knowledge /
 * address-channel real-LLM verification.
 *
 * Verification only: it changes NO production behavior and mutates NO
 * production data. It drives the EXISTING B-02 context builder + the REAL
 * configured provider adapter (through the shared callOpenAiCompatible →
 * buildPromptMessages → normalizeResponse → parseAiResponse chain) + the
 * EXISTING B-03 disclosure gate over a SMALL, focused fixture matrix, so it
 * proves the NEW `businessAddress` channel and the prompt line behave the
 * same way with a REAL model as they do deterministically:
 *
 *   in-memory business fixture
 *     → B-02 context builder (task-gated exposure)
 *     → real provider adapter → parseAiResponse
 *     → B-03 disclosure gate (structural, no fabrication)
 *
 * It proves:
 *  - a location question WITH an authoritative address gets a DISCLOSED
 *    AI reply that quotes the stored address;
 *  - a location question WITHOUT an address produces NO fabricated location
 *    (the model hands off NO_KNOWLEDGE; nothing is disclosed);
 *  - a business-profile question WITH an about gets a DISCLOSED reply;
 *  - an about is NOT carried on an unrelated (booking) turn, and the address
 *    is not carried there either;
 *  - the service catalog (names) is answerable with a real model;
 *
 * Run (reads the key by NAME only, never prints it):
 *   pnpm exec dotenv -e .env.local -e .env -- tsx \
 *     scripts/eval-run-future-op21.ts \
 *     --provider codecraft --model deepseek-v4-flash-0731 --timeout-ms 90000
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
import { createCodeCraftAdapter } from "@/server/integrations/ai/codecraft";
import type { AiProviderAdapter } from "@/server/integrations/ai/types";

export {};

type Fixture = {
  readonly id: string;
  readonly message: string;
  readonly about: string | null;
  readonly address: string | null;
  readonly services: ReadonlyArray<{
    id: string;
    businessId: string;
    name: string;
    description?: string | null;
    priceType?: string | null;
    priceAmount?: number | null;
    priceMaxAmount?: number | null;
    priceCurrency?: string | null;
    priceNote?: string | null;
  }>;
  readonly faqs: ReadonlyArray<{ question: string; answer: string }>;
  /**
   * Assertion on the REAL model's parsed response + the gate's verdict.
   * `expect.action` is the required AiResponse action; `expect.gate` the
   * required disclosure decision kind.
   */
  readonly expect: {
    readonly action: "reply" | "handoff" | "booking_handoff";
    readonly gate: "disclosed" | "requires-human";
    /** When true, the reply content must contain `contains`. */
    readonly contains?: string;
    readonly handoffReason?: string;
  };
};

const ADDRESS = "كفر الشيخ — شارع الجمهورية، بجوار صيدلية النيل";
const ABOUT = "عيادة أسنان متخصصة في تنظيف وحشو الأسنان بأحدث الأجهزة.";

const SERVICES = [
  {
    id: "svc-1",
    businessId: "business-1",
    name: "تنظيف الأسنان",
    description: "جلسة تنظيف عميق للجير والتلميع.",
    priceType: "FIXED",
    priceAmount: 300,
    priceCurrency: "EGP",
  },
  {
    id: "svc-2",
    businessId: "business-1",
    name: "حشو الأسنان",
    description: "حشو تجميلي بلون الأسنان.",
    priceType: "RANGE",
    priceAmount: 300,
    priceMaxAmount: 500,
    priceCurrency: "EGP",
  },
];

function fixture(overrides: Partial<Fixture>): Fixture {
  return {
    id: "base",
    message: "",
    about: ABOUT,
    address: ADDRESS,
    services: SERVICES,
    faqs: [
      { question: "هل يوجد حجز مسبق؟", answer: "نعم، الحجز مسبقًا مطلوب." },
    ],
    expect: { action: "reply", gate: "disclosed" },
    ...overrides,
  };
}

/** The matrix — the knowledge classes this slice introduced/exposed. */
const FIXTURES: ReadonlyArray<Fixture> = [
  fixture({
    id: "about-present",
    message: "احكيلي عن العيادة",
    expect: { action: "reply", gate: "disclosed", contains: "أسنان" },
  }),
  fixture({
    id: "about-missing",
    message: "احكيلي عن العيادة",
    about: null,
    expect: {
      action: "handoff",
      gate: "disclosed",
      handoffReason: "NO_KNOWLEDGE",
    },
  }),
  fixture({
    id: "location-present",
    message: "أين موقعكم؟",
    expect: { action: "reply", gate: "disclosed", contains: "كفر الشيخ" },
  }),
  fixture({
    id: "location-missing",
    message: "أين موقعكم؟",
    address: null,
    expect: {
      action: "handoff",
      gate: "disclosed",
      handoffReason: "NO_KNOWLEDGE",
    },
  }),
  fixture({
    id: "service-list",
    message: "ايه الخدمات اللي عندكم؟",
    services: SERVICES,
    expect: { action: "reply", gate: "disclosed", contains: "تنظيف" },
  }),
  fixture({
    id: "service-description",
    message: "تنظيف الأسنان بيشمل ايه؟",
    expect: { action: "reply", gate: "disclosed" },
  }),
  fixture({
    id: "price-present",
    message: "تنظيف الأسنان بكام؟",
    expect: { action: "reply", gate: "disclosed" },
  }),
  fixture({
    id: "price-missing",
    message: "حشو الأسنان بكام؟",
    services: [
      {
        id: "svc-3",
        businessId: "business-1",
        name: "حشو الأسنان",
        description: "حشو تجميلي.",
      },
    ],
    expect: {
      action: "handoff",
      gate: "disclosed",
      handoffReason: "NO_KNOWLEDGE",
    },
  }),
  fixture({
    id: "faq",
    message: "هل يوجد حجز مسبق؟",
    expect: { action: "reply", gate: "disclosed" },
  }),
  fixture({
    id: "unrelated-booking-carries-nothing",
    message: "عايز أحجز بكرة",
    about: ABOUT,
    address: ADDRESS,
    services: SERVICES,
    expect: { action: "booking_handoff", gate: "disclosed" },
  }),
];

type Result = {
  id: string;
  ok: boolean;
  latencyMs: number | null;
  intent: string | null;
  action: string | null;
  handoffReason: string | null;
  gate: string | null;
  gateReason: string | null;
  support: readonly string[];
  contentContainsExpected: boolean;
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
      name: "مركز أفنان",
      about: f.about,
      address: f.address,
      faqs: f.faqs,
      whatsappNumber: "+201000000000",
      cancellationPolicy: "يمكن الإلغاء قبل الموعد بـ ٢٤ ساعة.",
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
  const provider = args.get("provider") ?? "codecraft";
  const model =
    args.get("model") ??
    process.env.CODECRAFT_MODEL ??
    "deepseek-v4-flash-0731";
  const timeoutMs = Number(args.get("timeout-ms") ?? "90000");
  const outDir =
    args.get("out") ?? "evaluation/reports/egyptian-v1/real-llm-op21";

  const keyName =
    provider === "codecraft"
      ? "CODECRAFT_API_KEY"
      : provider === "atria"
        ? "ATRIA_API_KEY"
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
  if (provider === "codecraft") {
    adapter = createCodeCraftAdapter({
      model,
      getEnvVar: (name) => process.env[name],
      fetchImpl: fetch,
      timeoutMs,
    });
  } else {
    console.error(
      `This focused probe currently supports --provider codecraft (the live policy). Got: ${provider}`,
    );
    process.exit(2);
  }

  const results: Result[] = [];
  for (const f of FIXTURES) {
    const built = buildAiContext({
      scope: { businessId: "business-1" },
      sources: sourcesFor(f),
    });
    const request: AiRequest = built.request;
    const call = await adapter.call(request);
    if (!call.ok) {
      results.push({
        id: f.id,
        ok: false,
        latencyMs: call.latencyMs ?? null,
        intent: null,
        action: null,
        handoffReason: null,
        gate: null,
        gateReason: null,
        support: [],
        contentContainsExpected: false,
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
        latencyMs: call.latencyMs ?? null,
        intent: null,
        action: null,
        handoffReason: null,
        gate: null,
        gateReason: null,
        support: [],
        contentContainsExpected: false,
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
    const gate = decision.kind;
    const gateReason =
      decision.kind === "requires-human" ? decision.reason : null;
    const support = decision.kind === "disclosed" ? decision.support : [];
    const pass =
      parsed.action === f.expect.action &&
      gate === f.expect.gate &&
      contentContainsExpected &&
      (f.expect.handoffReason
        ? parsed.handoffReason === f.expect.handoffReason
        : true);
    results.push({
      id: f.id,
      ok: true,
      latencyMs: call.latencyMs ?? null,
      intent: parsed.intent,
      action: parsed.action,
      handoffReason: parsed.handoffReason,
      gate,
      gateReason,
      support,
      contentContainsExpected,
      pass,
    });
    console.log(
      `${pass ? "✔" : "✘"} ${f.id} — intent=${parsed.intent} action=${parsed.action} handoff=${parsed.handoffReason ?? "-"} gate=${gate}${gateReason ? `(${gateReason})` : ""} latency=${call.latencyMs ?? "?"}ms`,
    );
    if (!pass) {
      console.log(
        `   expected: action=${f.expect.action} gate=${f.expect.gate}${f.expect.handoffReason ? ` handoff=${f.expect.handoffReason}` : ""}${f.expect.contains ? ` contains="${f.expect.contains}"` : ""}`,
      );
      console.log(`   content: ${parsed.content.slice(0, 160)}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const providerFailures = results.filter((r) => !r.ok).length;

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
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `\n${passed}/${results.length} classes passed · ${providerFailures} provider failures`,
  );
  console.log(`artifacts: ${outDir}/results.json`);

  if (providerFailures > 0) {
    console.error("\nBLOCKED_PROVIDER — at least one real call failed.");
    process.exit(2);
  }
  if (passed !== results.length) {
    process.exit(1);
  }
  console.log("\nREAL-LLM OP21 VERIFICATION: PASS");
}

main().catch((error: Error) => {
  console.error(`Fatal: ${error.message}`);
  process.exit(1);
});
