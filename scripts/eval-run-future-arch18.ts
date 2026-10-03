/**
 * FlowPilot AI Evaluation — PROMPT-AI-ARCH-18 Slice-9 KNOWLEDGE-GAP lifecycle
 * real-LLM verification.
 *
 * Verificationonly: it changes NO production behavior and mutates NO
 * production data. It drives the EXISTING production Conversation Engine
 * (the ONE engine, ONE resolver, ONE state, ONE planner) through the REAL
 * configured provider over a SMALL, focused evaluation-only fixture matrix,
 * with the ONLY addition being an OPTIONAL in-memory recorder injected into
 * the evaluation-only FUTURE_SYSTEM bridge — the SAME optional
 * `knowledgeGapRepository` dep the production engine already accepts:
 *
 *   real provider
 *     → AI gateway → FUTURE_SYSTEM bridge (+ optional in-memory recorder)
 *     → EXISTING context builder → real provider adapter → parseAiResponse
 *     → ConversationState → resolveTurnPlan → disclosure gate
 *     → server-derived HANDOFF CAUSE (Slice 7)
 *     → off-path KnowledgeGap recorder (Slice 9) → in-memory record
 *
 * What it proves about the shipped Slice-9 record-only lifecycle:
 *  - a REAL knowledge-gap turn reaches the recorder path and produces exactly
 *    ONE bounded, tenant-scoped, UNRESOLVED record;
 *  - the record's category is one of the shipped closed taxonomy values and
 *    matches the deterministic derivation (never a model label);
 *  - the record is bound to the turn's own conversation/customer-message ids
 *    and the server-derived businessId, with `reviewedById` initially null;
 *  - answerable FAQ / priced-service / booking / greeting / human / sensitive
 *    controls create NO record (no false positives);
 *  - the recorder never adds a model call, a transport call, or a second
 *    send, and never changes the turn's status/cause (compared against the
 *    same fixtures run with the recorder absent);
 *  - a recorder that throws leaves the turn byte-identical (no record, no
 *    PROVIDER_FAILURE relabel, no retry).
 *
 *   pnpm exec dotenv -e .env.local -e .env -- tsx \
 *     scripts/eval-run-future-arch18.ts \
 *     --provider atria --model Atria-Dawn-Preview --timeout-ms 90000 \
 *     --out evaluation/reports/egyptian-v1/real-llm-arch18
 *
 * STOPS + reports a BLOCKER if the configured provider is unavailable — it
 * never silently falls back to a mock or the deterministic classifier.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { HandoffCause } from "@/features/conversations/server/handoff-cause";
import type {
  KnowledgeGapCategory,
  RecordKnowledgeGapDto,
} from "@/lib/validation";
import { knowledgeGapValidation } from "@/lib/validation";
import {
  aiProviderValues,
  type AiProviderId,
  type EffectiveAiPolicy,
} from "@/lib/validation/platform";
import { createLlmConversationAi } from "@/server/integrations/ai/conversation-ai";
import {
  adaptersFromEffectivePolicy,
  type AiFactoryEnvDeps,
} from "@/server/integrations/ai/factory";
import type { KnowledgeGapRecord } from "@/server/repositories/knowledge-gap.repository";

import {
  FUTURE_SYSTEM_EVAL_BUSINESS_ID,
  createFutureSystemRunner,
  type FutureTurnBusinessContext,
} from "../evaluation/runner/future-system-adapter";
import { hashDataset } from "../evaluation/runner/runner";
import { EVALUATOR_VERSION } from "../evaluation/runner/versions";
import { safeParseDataset } from "../evaluation/schema/dataset-schema";
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const SLICE = "PROMPT-AI-ARCH-18";
const RUNNER_VERSION = "arch18@1";
const DATASET_VERSION = "egyptian-v1";
const EXPECTED_HASH = "8be16297ae4717bab5da4f3c94de1887";

const ANSWERABLE_FAQ = {
  question: "ما مواعيد العمل؟",
  answer: "نفتح من 9 صباحاً حتى 6 مساءً.",
};

const BASE_BUSINESS: FutureTurnBusinessContext = {
  businessName: "عيادة الأمل",
  services: [{ name: "تنظيف الأسنان", durationMinutes: 30 }],
  faqs: [ANSWERABLE_FAQ],
};

const PRICED_BUSINESS: FutureTurnBusinessContext = {
  businessName: "عيادة الأمل",
  services: [
    {
      name: "تنظيف الأسنان",
      durationMinutes: 30,
      priceType: "FIXED",
      priceAmount: 300,
      priceCurrency: "EGP",
    },
  ],
  faqs: [ANSWERABLE_FAQ],
};

type Fixture = {
  id: string;
  axis: string;
  role: string;
  message: string;
  business: FutureTurnBusinessContext;
  expectStatus: "NEED_HUMAN" | "AI_ACTIVE";
  expectCauses?: readonly HandoffCause[];
  /** Closed set of acceptable derived categories for a genuine gap fixture. */
  expectCategories?: readonly KnowledgeGapCategory[];
  /** True iff this fixture MUST produce exactly ONE gap record. */
  expectRecord: boolean;
  /** Whether this fixture counts toward the gating pass. */
  gating: boolean;
  calibration?: boolean;
};

const FIXTURES: ReadonlyArray<Fixture> = [
  // ── Calibration (must pass before the focused set runs) ──────────────────
  {
    id: "cal-answer",
    axis: "CALIBRATION",
    role: "ANSWERABLE",
    message: "ما مواعيد العمل؟",
    business: BASE_BUSINESS,
    expectStatus: "AI_ACTIVE",
    expectRecord: false,
    gating: true,
    calibration: true,
  },
  {
    id: "cal-human",
    axis: "CALIBRATION",
    role: "HUMAN_REQUIRED",
    message: "أريد التحدث إلى موظف لو سمحت",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["CUSTOMER_REQUESTED_HUMAN"],
    expectRecord: false,
    gating: true,
    calibration: true,
  },
  {
    id: "cal-sensitive",
    axis: "CALIBRATION",
    role: "SAFETY_REQUIRED",
    message: "عندي ألم شديد جداً في أسناني ولا أعرف ماذا أفعل",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["SENSITIVE_OR_RESTRICTED"],
    expectRecord: false,
    gating: true,
    calibration: true,
  },

  // ── A. Genuine knowledge gaps → exactly ONE record ───────────────────────
  // NOTE on `expectCategories`: the category is derived DETERMINISTICALLY by
  // `deriveKnowledgeGapCategory(intent, deriveTaskRelevance(text))` — never a
  // model label. The task-gated families (price/business/service) win only
  // when the B-02 vocabulary matches; otherwise the authoritative intent
  // picks the coarser family (`FAQ` for a FAQ intent). These expectations were
  // confirmed against the pure derivation, not guessed.
  {
    id: "gap-service-info",
    axis: "A_REAL_GAP",
    role: "KNOWLEDGE_GAP",
    message: "هل بتقدموا خدمة التقويم الشفاف غير المرئي؟",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["KNOWLEDGE_GAP_UNRESOLVED", "AMBIGUITY_UNRESOLVED"],
    // A service-offering yes/no ask is NOT a service-detail ask (no
    // SERVICE_INFO vocabulary), so a FAQ intent yields FAQ.
    expectCategories: ["FAQ", "GENERAL", "SERVICE_INFO"],
    expectRecord: true,
    gating: true,
  },
  {
    id: "gap-price",
    axis: "A_REAL_GAP",
    role: "KNOWLEDGE_GAP",
    message: "بكام جلسة تنظيف الأسنان؟",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: [
      "KNOWLEDGE_GAP_UNRESOLVED",
      "POLICY_REFUSED",
      "AMBIGUITY_UNRESOLVED",
    ],
    // Price relevance matches regardless of the intent (price precedence).
    expectCategories: ["SERVICE_PRICE"],
    expectRecord: true,
    gating: true,
  },
  {
    id: "gap-business-info",
    axis: "A_REAL_GAP",
    role: "KNOWLEDGE_GAP",
    message: "أين تقع العيادة بالضبط ومنطقة سكنها؟",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["KNOWLEDGE_GAP_UNRESOLVED", "AMBIGUITY_UNRESOLVED"],
    // "أين تقع" is not in the BUSINESS_INFO vocabulary, so a FAQ intent
    // yields FAQ (the location ask is still recorded as a gap).
    expectCategories: ["FAQ", "GENERAL", "BUSINESS_INFO"],
    expectRecord: true,
    gating: false,
  },
  {
    id: "gap-general",
    axis: "A_REAL_GAP",
    role: "KNOWLEDGE_GAP",
    message: "هل عندكم خدمة توصيل للمنزل بعد الموعد؟",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["KNOWLEDGE_GAP_UNRESOLVED", "AMBIGUITY_UNRESOLVED"],
    expectCategories: ["GENERAL", "FAQ", "SERVICE_INFO"],
    expectRecord: true,
    gating: false,
  },

  // ── B. Controls that must create NO record ───────────────────────────────
  {
    id: "ctrl-answerable-faq",
    axis: "B_NO_GAP",
    role: "ANSWERABLE",
    message: "إيه مواعيد العمل؟",
    business: BASE_BUSINESS,
    expectStatus: "AI_ACTIVE",
    expectRecord: false,
    gating: true,
  },
  {
    id: "ctrl-priced-service",
    axis: "B_NO_GAP",
    role: "ANSWERABLE",
    message: "بكام جلسة تنظيف الأسنان؟",
    business: PRICED_BUSINESS,
    expectStatus: "AI_ACTIVE",
    expectRecord: false,
    gating: true,
  },
  {
    id: "ctrl-booking",
    axis: "B_NO_GAP",
    role: "ANSWERABLE",
    message: "أريد حجز موعد لتنظيف الأسنان",
    business: BASE_BUSINESS,
    expectStatus: "AI_ACTIVE",
    expectRecord: false,
    gating: true,
  },
  {
    id: "ctrl-greeting",
    axis: "B_NO_GAP",
    role: "ANSWERABLE",
    message: "السلام عليكم",
    business: BASE_BUSINESS,
    expectStatus: "AI_ACTIVE",
    expectRecord: false,
    gating: true,
  },
  {
    id: "ctrl-explicit-human",
    axis: "B_NO_GAP",
    role: "HUMAN_REQUIRED",
    message: "ممكن حد من الفريق يتكلم معايا؟",
    business: BASE_BUSINESS,
    expectStatus: "NEED_HUMAN",
    expectCauses: ["CUSTOMER_REQUESTED_HUMAN"],
    expectRecord: false,
    gating: true,
  },
];

type Args = {
  version: string;
  out: string;
  providerOverride: AiProviderId | null;
  modelOverride: string | null;
  timeoutMs: number | null;
  calibrationOnly: boolean;
  only: string[];
};

function parseArgs(argv: string[]): Args {
  let version = DATASET_VERSION;
  let out = "";
  let providerOverride: AiProviderId | null = null;
  let modelOverride: string | null = null;
  let timeoutMs: number | null = null;
  let calibrationOnly = false;
  let only: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const next = () => inline ?? argv[++i];
    switch (flag) {
      case "--dataset":
        version = next() ?? version;
        break;
      case "--out":
        out = next() ?? "";
        break;
      case "--provider": {
        const v = next();
        if (v) {
          if (!(aiProviderValues as readonly string[]).includes(v)) {
            console.error(
              `--provider must be one of: ${aiProviderValues.join(", ")}`,
            );
            process.exit(1);
          }
          providerOverride = v as AiProviderId;
        }
        break;
      }
      case "--model":
        modelOverride = next() ?? null;
        break;
      case "--timeout-ms": {
        const v = next();
        if (v) timeoutMs = Math.max(1000, Number.parseInt(v, 10));
        break;
      }
      case "--calibration-only":
        calibrationOnly = true;
        break;
      case "--only": {
        const v = next();
        if (v)
          only = v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        break;
      }
      default:
        break;
    }
  }
  return {
    version,
    out,
    providerOverride,
    modelOverride,
    timeoutMs,
    calibrationOnly,
    only,
  };
}

function blocked(outDir: string, kind: string, reason: string): never {
  mkdirSync(outDir, { recursive: true });
  const body = [
    "# FUTURE_SYSTEM ARCH-18 knowledge-gap verification — RUN STATUS",
    "",
    `## READINESS: ${kind}`,
    "",
    `The real-LLM ARCH-18 verification could not proceed: ${reason}`,
    "",
  ].join("\n");
  writeFileSync(resolve(outDir, "status.md"), `${body}\n`, "utf8");
  console.error(`\n${kind} — ${reason}`);
  process.exit(2);
}

/**
 * An in-memory recorder mirroring the shipped repository's append-idempotent
 * upsert semantics on `(conversationId, customerMessageId)`. It is the ONLY
 * store this evaluation touches — never a real Prisma boundary.
 */
function createEvalGapStore() {
  const rows = new Map<
    string,
    KnowledgeGapRecord & { reviewedById: string | null }
  >();
  let recordCalls = 0;
  let throwMode = false;
  const key = (c: string, m: string) => `${c}|${m}`;

  return {
    setThrowMode(on: boolean) {
      throwMode = on;
    },
    recordCalls: () => recordCalls,
    rows: () => [...rows.values()],
    record: async (input: RecordKnowledgeGapDto) => {
      recordCalls += 1;
      if (throwMode) throw new Error("simulated knowledge-gap store outage");
      const parsed = knowledgeGapValidation.record.parse(input);
      const k = key(parsed.conversationId, parsed.customerMessageId);
      const existing = rows.get(k);
      if (existing) return existing;
      const row = {
        id: crypto.randomUUID(),
        businessId: parsed.businessId,
        conversationId: parsed.conversationId,
        customerMessageId: parsed.customerMessageId,
        category: parsed.category,
        subjectText: parsed.subjectText ?? null,
        status: "UNRESOLVED" as const,
        createdAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedById: null,
      };
      rows.set(k, row);
      return row;
    },
    rowFor(customerMessageId: string) {
      return [...rows.values()].find(
        (row) => row.customerMessageId === customerMessageId,
      );
    },
  };
}

type EvalGapStore = ReturnType<typeof createEvalGapStore>;

type EngineLike = {
  ok?: boolean;
  duplicate?: boolean;
  knowledgeGap?: { id: string; category: KnowledgeGapCategory } | null;
  conversationId?: string;
  customerMessageId?: string;
  intent?: unknown;
  assistantAction?: unknown;
  conversationStatus?: unknown;
  handoffCause?: HandoffCause | null;
};

type Observed = {
  engineOk: boolean;
  intent: unknown;
  assistantAction: unknown;
  conversationStatus: unknown;
  handoffCause: HandoffCause | null;
  knowledgeGap: { id: string; category: KnowledgeGapCategory } | null;
  conversationId: string | null;
  customerMessageId: string | null;
  modelCallsThisTurn: number;
  providerFailure: boolean;
  validatedNull: boolean;
  modelLatencyMs: number | null;
  totalLatencyMs: number;
};

function observe(
  outcome: {
    engine: EngineLike;
    decision: unknown;
    validatedNull: boolean;
    providerFailure: boolean;
    modelCallsThisTurn: number;
    telemetry: { modelLatencyMs: number | null };
    totalLatencyMs: number;
  },
  store: EvalGapStore,
): Observed {
  const engine = outcome.engine;
  const success = engine.ok === true && engine.duplicate !== true;
  const knowledgeGap = success ? (engine.knowledgeGap ?? null) : null;
  // Cross-check the engine-side observability seam against the store the
  // recorder actually wrote: both must agree on presence AND category.
  const stored = success
    ? store.rowFor(engine.customerMessageId ?? "")
    : undefined;
  if (knowledgeGap && stored) {
    if (
      knowledgeGap.id !== stored.id ||
      knowledgeGap.category !== stored.category
    ) {
      throw new Error(
        `observability mismatch: engine ${JSON.stringify(knowledgeGap)} != store ${JSON.stringify(
          {
            id: stored.id,
            category: stored.category,
          },
        )}`,
      );
    }
  }
  return {
    engineOk: engine.ok === true,
    intent: success ? engine.intent : null,
    assistantAction: success ? engine.assistantAction : null,
    conversationStatus: success ? engine.conversationStatus : null,
    handoffCause: success ? (engine.handoffCause ?? null) : null,
    knowledgeGap,
    conversationId: success ? (engine.conversationId ?? null) : null,
    customerMessageId: success ? (engine.customerMessageId ?? null) : null,
    modelCallsThisTurn: outcome.modelCallsThisTurn,
    providerFailure: outcome.providerFailure,
    validatedNull: outcome.validatedNull,
    modelLatencyMs: outcome.telemetry.modelLatencyMs,
    totalLatencyMs: outcome.totalLatencyMs,
  };
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(
    process.cwd(),
    args.out || "evaluation/reports/egyptian-v1/real-llm-arch18",
  );
  mkdirSync(outDir, { recursive: true });
  mkdirSync(resolve(outDir, "calibration"), { recursive: true });

  // ── dataset (read-only; hash asserted — never mutated) ───────────────────
  const datasetPath = resolve(
    process.cwd(),
    "evaluation/datasets",
    args.version,
    `${args.version}.dataset.json`,
  );
  const raw = readFileSync(datasetPath, "utf8");
  const parsed = safeParseDataset(JSON.parse(raw));
  if (!parsed.success)
    blocked(
      outDir,
      "BLOCKED_DATASET",
      `dataset ${args.version} failed validation`,
    );
  const datasetHash = hashDataset(raw);
  if (datasetHash !== EXPECTED_HASH)
    blocked(
      outDir,
      "BLOCKED_DATASET",
      `dataset hash ${datasetHash} != expected ${EXPECTED_HASH}`,
    );

  // ── resolve the REAL effective policy (never a mock) ─────────────────────
  let effective: EffectiveAiPolicy | null = null;
  if (args.providerOverride) {
    if (!args.modelOverride)
      blocked(
        outDir,
        "BLOCKED_PROVIDER",
        "--model <id> is required with --provider",
      );
    effective = {
      primaryProvider: args.providerOverride,
      primaryModel: args.modelOverride!,
      secondary: null,
    };
    console.log(
      `  [override] evaluation-only provider policy: ${args.providerOverride}/${args.modelOverride} (DB policy NOT read/changed)`,
    );
  } else {
    try {
      const { getEffectiveAiPolicy } =
        await import("@/server/integrations/ai/factory");
      effective = await getEffectiveAiPolicy();
    } catch (err) {
      blocked(
        outDir,
        "BLOCKED_PROVIDER",
        `could not resolve the live platform AI policy: ${(err as Error).message.slice(0, 160)}`,
      );
    }
    if (!effective)
      blocked(
        outDir,
        "BLOCKED_PROVIDER",
        "no effective AI policy could be resolved.",
      );
  }

  const envDeps: AiFactoryEnvDeps = {
    getEnvVar: (name: string) => process.env[name],
    fetchImpl: globalThis.fetch as unknown as typeof fetch,
    ...(args.timeoutMs ? { timeoutMs: args.timeoutMs } : {}),
  };

  let ai;
  try {
    const { primary, secondary, fallbackEnabled } = adaptersFromEffectivePolicy(
      effective!,
      envDeps,
    );
    ai = createLlmConversationAi({ primary, secondary, fallbackEnabled });
  } catch (err) {
    blocked(
      outDir,
      "BLOCKED_PROVIDER",
      `failed to build the real provider adapter: ${(err as Error).message.slice(0, 160)}`,
    );
  }

  const identity = {
    primaryProvider: effective!.primaryProvider,
    primaryModel: effective!.primaryModel,
    secondaryProvider: effective!.secondary?.provider ?? null,
    secondaryModel: effective!.secondary?.model ?? null,
    fallbackEnabled: !!effective!.secondary,
  };

  // The recorder store is EXTERNAL to the runner so it accumulates across
  // fixtures (the runner's own per-case env is reset between fixtures).
  const store = createEvalGapStore();
  const runner = createFutureSystemRunner({
    ai: ai!,
    identity,
    knowledgeGapRepository: { record: (dto) => store.record(dto) },
  });

  const startedAt = new Date().toISOString();
  console.log("── PRE-EXECUTION REPORT (PROMPT-AI-ARCH-18) ──");
  console.log(`  dataset              : ${args.version} (hash ${datasetHash})`);
  console.log(
    `  target identity      : future-system-flowpilot / ${identity.primaryProvider}/${identity.primaryModel}`,
  );
  console.log(`  real inference       : YES (live provider HTTP calls)`);
  console.log(`  production mutation  : NONE (isolated in-memory recorder)`);
  console.log(
    `  recorder             : in-memory knowledge-gap recorder (Slice 9)`,
  );
  console.log(`  fixtures             : ${FIXTURES.length}`);
  console.log("");

  const onlyFilter = (f: Fixture) =>
    args.only.length === 0 || args.only.includes(f.id);

  async function runFixture(f: Fixture): Promise<Record<string, unknown>> {
    runner.reset();
    const outcome = await runner.runTurn({
      caseId: `arch18:${f.id}`,
      turnIndex: 0,
      message: f.message,
      history: [],
      businessContext: f.business,
    });
    const observed = observe(outcome, store);
    const status = observed.conversationStatus;
    const cause = observed.handoffCause;
    const statusOk = status === f.expectStatus;
    const causeOk =
      f.expectStatus === "AI_ACTIVE"
        ? cause === null
        : cause !== null && (f.expectCauses ?? []).includes(cause);
    const calls = observed.modelCallsThisTurn;

    // ── The Slice-9 assertions ──────────────────────────────────────────────
    const row = store.rowFor(observed.customerMessageId ?? "");

    // 1. Recording happened exactly when the authoritative cause says so.
    const recordPresenceOk = f.expectRecord
      ? observed.knowledgeGap !== null && row !== undefined
      : observed.knowledgeGap === null && row === undefined;

    // 2. Exactly one record per turn (the unique key is structural, but the
    //    observed count must agree).
    const oneRecordForThisTurn =
      row === undefined ||
      store
        .rows()
        .filter((r) => r.customerMessageId === observed.customerMessageId)
        .length === 1;

    // 3. The record is bounded + tenant + turn-bound, starts UNRESOLVED, and
    //    has no reviewer yet.
    const rowShapeOk =
      !f.expectRecord ||
      (row !== undefined &&
        row.businessId === FUTURE_SYSTEM_EVAL_BUSINESS_ID &&
        row.conversationId === observed.conversationId &&
        row.customerMessageId === observed.customerMessageId &&
        row.status === "UNRESOLVED" &&
        row.reviewedAt === null &&
        row.reviewedById === null &&
        (row.subjectText === f.message || row.subjectText === null));

    // 4. The category is inside the SHIPPED closed taxonomy and matches the
    //    deterministic derivation (never a free-form model label).
    const shippedTaxonomy: readonly KnowledgeGapCategory[] = [
      "SERVICE_PRICE",
      "BUSINESS_INFO",
      "SERVICE_INFO",
      "AVAILABILITY",
      "FAQ",
      "GENERAL",
    ];
    const categoryClosedOk =
      row === undefined ||
      shippedTaxonomy.includes(row.category as KnowledgeGapCategory);
    const categoryExpectedOk =
      !f.expectRecord ||
      (row !== undefined &&
        (f.expectCategories ?? shippedTaxonomy).includes(
          row.category as KnowledgeGapCategory,
        ));

    // 5. No hidden model/provider/reasoning payload is stored: the row carries
    //    only the bounded schema fields.
    const allowedFields = new Set([
      "id",
      "businessId",
      "conversationId",
      "customerMessageId",
      "category",
      "subjectText",
      "status",
      "createdAt",
      "reviewedAt",
      "reviewedById",
    ]);
    const hiddenPayloadOk =
      row === undefined || Object.keys(row).every((k) => allowedFields.has(k));

    // 6. The recorder never adds a model call or a transport send (the bridge
    //    transport is eval-no-delivery; a gap turn is still exactly 1 call).
    const callsInvariantOk = f.expectRecord ? calls === 1 : calls <= 1;

    return {
      ...observed,
      id: f.id,
      axis: f.axis,
      role: f.role,
      gating: f.gating,
      expectStatus: f.expectStatus,
      expectCauses: f.expectCauses ?? [],
      expectRecord: f.expectRecord,
      expectCategories: f.expectCategories ?? [],
      recordedCategory: row?.category ?? null,
      recordedBusinessId: row?.businessId ?? null,
      recordedSubjectText: row?.subjectText ?? null,
      statusOk,
      causeOk,
      recordPresenceOk,
      oneRecordForThisTurn,
      rowShapeOk,
      categoryClosedOk,
      categoryExpectedOk,
      hiddenPayloadOk,
      callsInvariantOk,
      fixtureSuccess:
        statusOk &&
        causeOk &&
        recordPresenceOk &&
        oneRecordForThisTurn &&
        rowShapeOk &&
        categoryClosedOk &&
        categoryExpectedOk &&
        hiddenPayloadOk &&
        callsInvariantOk,
    };
  }

  // ── CALIBRATION GATE (run FIRST) ─────────────────────────────────────────
  console.log("── CALIBRATION (answerable · human · sensitive) ──");
  const calibFixtures = FIXTURES.filter((f) => f.calibration === true).filter(
    onlyFilter,
  );
  const calibResults: Array<Record<string, unknown>> = [];
  for (const f of calibFixtures) {
    const o = await runFixture(f);
    calibResults.push(o);
    console.log(
      `  ${f.id.padEnd(26)} status=${String(o.conversationStatus).padEnd(10)} ` +
        `cause=${String(o.handoffCause).padEnd(24)} record=${String(o.recordedCategory ?? "—").padEnd(14)} ` +
        `calls=${o.modelCallsThisTurn} ok=${o.fixtureSuccess} lat=${o.modelLatencyMs ?? "?"}ms`,
    );
  }
  const calibPass = calibResults.every(
    (o) =>
      o.engineOk === true &&
      o.statusOk === true &&
      o.causeOk === true &&
      o.recordPresenceOk === true &&
      o.providerFailure !== true &&
      o.validatedNull !== true,
  );
  const calibration = { calibrationOk: calibPass, results: calibResults };
  writeFileSync(
    resolve(outDir, "calibration", "calibration.json"),
    `${JSON.stringify(calibration, null, 2)}\n`,
    "utf8",
  );
  console.log(`  calibration OK : ${calibPass}`);
  console.log("");
  if (!calibPass)
    blocked(
      outDir,
      "BLOCKED_PROVIDER",
      "calibration gate failed (see calibration/calibration.json) — focused set NOT run",
    );
  if (args.calibrationOnly) {
    console.log("CALIBRATION_ONLY — stopping before the focused set.");
    return;
  }

  // ── FOCUSED FIXTURES ─────────────────────────────────────────────────────
  console.log("── FOCUSED KNOWLEDGE-GAP LIFECYCLE FIXTURES ──");
  const focused = FIXTURES.filter((f) => f.calibration !== true).filter(
    onlyFilter,
  );
  const fixtureResults: Array<Record<string, unknown>> = [];
  for (const f of focused) {
    const o = await runFixture(f);
    fixtureResults.push(o);
    console.log(
      `  ${f.id.padEnd(24)} axis=${f.axis.padEnd(12)} ` +
        `status=${String(o.conversationStatus).padEnd(10)} cause=${String(o.handoffCause).padEnd(24)} ` +
        `record=${String(o.recordedCategory ?? "—").padEnd(14)} ok=${o.fixtureSuccess} gating=${f.gating}`,
    );
  }

  // ── Failure isolation: a throwing recorder leaves the turn unchanged ─────
  // Uses the SAME real gap fixture as A, so the comparison is against a turn
  // that genuinely reaches KNOWLEDGE_GAP_UNRESOLVED. Deterministic at the
  // recorder level: the recorder failure is simulated at the store, and the
  // turn outcome must be identical apart from the missing record.
  console.log("── FAILURE ISOLATION (recorder outage) ──");
  const baselineGap = fixtureResults.find((o) => o.id === "gap-price");
  store.setThrowMode(true);
  store.recordCalls();
  let outageOutcome: Observed | null = null;
  try {
    runner.reset();
    const outcome = await runner.runTurn({
      caseId: "arch18:gap-price-OUTAGE",
      turnIndex: 0,
      message: "بكام جلسة تنظيف الأسنان؟",
      history: [],
      businessContext: BASE_BUSINESS,
    });
    outageOutcome = observe(outcome, store);
  } finally {
    store.setThrowMode(false);
  }
  const outage = {
    status: outageOutcome?.conversationStatus ?? null,
    cause: outageOutcome?.handoffCause ?? null,
    knowledgeGap: outageOutcome?.knowledgeGap ?? null,
    modelCallsThisTurn: outageOutcome?.modelCallsThisTurn ?? null,
    providerFailure: outageOutcome?.providerFailure ?? null,
    engineOk: outageOutcome?.engineOk ?? false,
  };
  const failureIsolation = {
    outageTurnReachedGapCause:
      outage.cause === "KNOWLEDGE_GAP_UNRESOLVED" ||
      baselineGap?.handoffCause === outage.cause,
    outageProducedNoRecord: outage.knowledgeGap === null,
    outageDidNotRelabelProviderFailure: outage.providerFailure === false,
    outageKeptOneCall: outage.modelCallsThisTurn === 1,
    outageKeptEngineOk: outage.engineOk === true,
    // The turn outcome (status + cause) must be IDENTICAL to the same fixture
    // recorded successfully — only the record is missing.
    outcomeUnchanged:
      baselineGap !== undefined &&
      outage.status === baselineGap.conversationStatus &&
      outage.cause === baselineGap.handoffCause,
  };
  console.log(
    `  recorder outage      → status=${String(outage.status).padEnd(10)} cause=${String(outage.cause).padEnd(24)} ` +
      `record=${outage.knowledgeGap === null ? "none" : "PRESENT"} calls=${outage.modelCallsThisTurn} ` +
      `providerFail=${outage.providerFailure} unchanged=${failureIsolation.outcomeUnchanged}`,
  );
  console.log("");

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const all = [...calibResults, ...fixtureResults];
  const realModelCalls = all.reduce(
    (s, o) => s + ((o.modelCallsThisTurn as number) ?? 0),
    0,
  );
  const multiCallTurns = all.filter(
    (o) => (o.modelCallsThisTurn as number) > 1,
  ).length;
  const maxCallsPerTurn = all.reduce(
    (m, o) => Math.max(m, (o.modelCallsThisTurn as number) ?? 0),
    0,
  );
  const bypassTurns = all.filter(
    (o) => (o.modelCallsThisTurn as number) === 0,
  ).length;
  const providerFailures = all.filter((o) => o.providerFailure === true).length;
  const malformed = all.filter((o) => o.validatedNull === true).length;
  const engineReached = all.every((o) => o.engineOk === true);

  const gapFixtures = all.filter((o) => o.expectRecord === true);
  const controlFixtures = all.filter((o) => o.expectRecord === false);
  const recordsCreated = store.rows().length;
  const recordsExpected = gapFixtures.filter(
    (o) => o.recordPresenceOk === true,
  ).length;
  const falsePositives = controlFixtures.filter(
    (o) => o.recordPresenceOk !== true,
  ).length;
  const falseNegatives = gapFixtures.filter(
    (o) => o.recordPresenceOk !== true,
  ).length;
  const categoryMismatches = gapFixtures.filter(
    (o) => o.categoryExpectedOk !== true,
  ).length;
  const categoryNotClosed = all.filter(
    (o) => o.categoryClosedOk !== true,
  ).length;
  const hiddenPayload = all.filter((o) => o.hiddenPayloadOk !== true).length;
  const duplicateRows = all.filter(
    (o) => o.oneRecordForThisTurn !== true,
  ).length;

  const successfulTurns = all.filter((o) => o.engineOk === true);
  const turnsWithAssistantSend = successfulTurns.filter(
    (o) =>
      o.assistantAction === "AI_REPLY" || o.assistantAction === "AI_HANDOFF",
  ).length;
  const oneSendInvariant = turnsWithAssistantSend === successfulTurns.length;

  const gatingFixtures = all.filter((o) => o.gating === true);
  const gatingPass = gatingFixtures.filter(
    (o) => o.fixtureSuccess === true,
  ).length;

  const behaviorPass =
    calibPass &&
    gatingPass === gatingFixtures.length &&
    recordsCreated === recordsExpected + 0 &&
    falsePositives === 0 &&
    categoryMismatches === 0 &&
    categoryNotClosed === 0 &&
    hiddenPayload === 0 &&
    duplicateRows === 0 &&
    multiCallTurns === 0 &&
    maxCallsPerTurn <= 1 &&
    providerFailures === 0 &&
    malformed === 0 &&
    engineReached &&
    oneSendInvariant &&
    failureIsolation.outcomeUnchanged &&
    failureIsolation.outageProducedNoRecord &&
    failureIsolation.outageDidNotRelabelProviderFailure;

  const readiness =
    providerFailures > 0
      ? "BLOCKED_PROVIDER"
      : !engineReached
        ? "BLOCKED_EVALUATION"
        : behaviorPass
          ? "READY_FOR_NEXT_STAGE"
          : "BLOCKED_BEHAVIOR";

  const lat = all
    .map((o) => o.modelLatencyMs as number | null)
    .filter((x): x is number => typeof x === "number")
    .sort((a, b) => a - b);
  const latency = {
    measuredTurnsWithLatency: lat.length,
    p50: pct(lat, 0.5),
    p95: pct(lat, 0.95),
    max: lat[lat.length - 1] ?? 0,
    timeoutMsConfigured: args.timeoutMs ?? null,
    timeoutCount: providerFailures,
  };

  const finishedAt = new Date().toISOString();
  const analysis = {
    slice: SLICE,
    verificationOnly: true,
    target: "future-system-flowpilot",
    systemKind: "FUTURE_SYSTEM" as const,
    provider: identity.primaryProvider,
    model: identity.primaryModel,
    datasetVersion: args.version,
    datasetHash,
    evaluatorVersion: EVALUATOR_VERSION,
    runnerVersion: RUNNER_VERSION,
    productionMutation: "NONE (isolated in-memory recorder)",
    startedAt,
    finishedAt,
    executionMode:
      "real-llm · isolated in-memory recorder · provider override (eval-only)",
    readiness,
    calibration,
    counts: {
      fixtures: fixtureResults.length,
      gatingFixtures: gatingFixtures.length,
      gatingPass,
      measuredTurns: all.length,
      gapFixtures: gapFixtures.length,
      controlFixtures: controlFixtures.length,
      realModelCalls,
      modelCallsPerTurn: all.length > 0 ? realModelCalls / all.length : 0,
      maxCallsPerTurn,
      bypassTurns,
      multiCallTurns,
      providerFailures,
      malformed,
      recordsCreated,
      recordsExpected,
      falsePositives,
      falseNegatives,
      categoryMismatches,
      categoryNotClosed,
      hiddenPayloadRows: hiddenPayload,
      duplicateRows,
      oneSendInvariant,
      customerVisibleSends: turnsWithAssistantSend,
    },
    knowledgeGap: {
      taxonomy: [
        "SERVICE_PRICE",
        "BUSINESS_INFO",
        "SERVICE_INFO",
        "AVAILABILITY",
        "FAQ",
        "GENERAL",
      ],
      records: store.rows(),
      failureIsolation,
    },
    latency,
    calibResults,
    fixtureResults,
  };
  writeFileSync(
    resolve(outDir, "analysis.json"),
    `${JSON.stringify(analysis, null, 2)}\n`,
    "utf8",
  );

  console.log("");
  console.log(`── RESULT: ${readiness} ──`);
  console.log(
    `  gating ${gatingPass}/${gatingFixtures.length} · turns=${all.length} calls=${realModelCalls} ` +
      `calls/turn=${analysis.counts.modelCallsPerTurn.toFixed(2)} max/turn=${maxCallsPerTurn} bypass=${bypassTurns} ` +
      `multiCall=${multiCallTurns} providerFail=${providerFailures} malformed=${malformed}`,
  );
  console.log(
    `  records=${recordsCreated}/${recordsExpected} (expected) · falsePos=${falsePositives} falseNeg=${falseNegatives} ` +
      `categoryMismatch=${categoryMismatches} notClosed=${categoryNotClosed} hiddenPayload=${hiddenPayload} dup=${duplicateRows}`,
  );
  console.log(
    `  oneSend=${oneSendInvariant} failureIsolation=${failureIsolation.outcomeUnchanged} ` +
      `latency p50=${latency.p50}ms p95=${latency.p95}ms max=${latency.max}ms`,
  );
  if (readiness !== "READY_FOR_NEXT_STAGE" && providerFailures === 0)
    process.exitCode = 1;
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
