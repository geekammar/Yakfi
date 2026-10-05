/* eslint-disable @typescript-eslint/consistent-type-imports */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { AiRequest } from "../src/features/conversations/server/ai-contract";

/**
 * FlowPilot — AI PROMPT & EVALUATION SEPARATION check (PROMPT-ARCH-03).
 *
 * Verifies the Prompt Workspace Architecture
 * (PROMPT-OPS-AI-PROMPT-WORKSPACE-ARCHITECTURE-01) and its deterministic
 * fixtures — no DB, no network, no secrets. Run: pnpm check:ai-prompts
 *
 * Source-of-truth chain enforced here:
 *
 *   prompts/*.prompt  →  generator  →  src/generated/ai-prompts.generated.ts
 *                                          ↓ loaded by prompt-registry.ts
 *                                     buildPromptMessages / atria adapter
 *
 * Specifically: every registered prompt exists; no duplicate ids; the
 * declared variable contract holds; the generated artifact is byte-fresh
 * against the source prompt files; the runtime loads bodies from that
 * artifact (never from a literal string in TypeScript); no secret shape
 * and no provider-invocation syntax appears in a prompt body; and the
 * existing evaluation fixtures still replay green.
 */

export {};

type Check = { label: string; pass: boolean };

function listPromptFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (name.endsWith(".prompt")) out.push(abs);
    }
  };
  walk(join(process.cwd(), "prompts"));
  return out.sort();
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  const root = process.cwd();
  const promptsPath = join(root, "docs/ai/PROMPTS.md");
  const archPath = join(root, "docs/ai/ARCHITECTURE.md");
  const evalPath = join(root, "docs/ai/EVALUATIONS.md");
  const readmePath = join(root, "docs/ai/README.md");
  const enginePath = join(
    root,
    "src/features/conversations/server/conversation-engine.ts",
  );

  check("docs/ai/PROMPTS.md موجود", existsSync(promptsPath));
  check("docs/ai/ARCHITECTURE.md موجود", existsSync(archPath));
  check("docs/ai/EVALUATIONS.md موجود", existsSync(evalPath));
  check("docs/ai/README.md موجود", existsSync(readmePath));

  const promptsRaw = existsSync(promptsPath)
    ? readFileSync(promptsPath, "utf8")
    : "";
  const archRaw = existsSync(archPath) ? readFileSync(archPath, "utf8") : "";
  const evalRaw = existsSync(evalPath) ? readFileSync(evalPath, "utf8") : "";
  const readmeRaw = existsSync(readmePath)
    ? readFileSync(readmePath, "utf8")
    : "";
  const engineRaw = existsSync(enginePath)
    ? readFileSync(enginePath, "utf8")
    : "";

  check("PROMPTS.md غير فارغ", promptsRaw.length > 500);
  check("ARCHITECTURE.md غير فارغ", archRaw.length > 500);
  check("EVALUATIONS.md غير فارغ", evalRaw.length > 300);
  check(
    "README.md يذكر pnpm check:ai-prompts",
    readmeRaw.includes("check:ai-prompts"),
  );

  // ── Prompt Workspace: registry ↔ source files ↔ generated artifact ──────
  const { compilePromptBody, parsePromptId } =
    (await import("./generate-ai-prompts")) as typeof import("./generate-ai-prompts");
  const { PROMPT_REGISTRY, listPromptIds } =
    (await import("../src/server/integrations/ai/prompt-registry")) as typeof import("../src/server/integrations/ai/prompt-registry");
  const generated = (await import("../src/generated/ai-prompts.generated"))
    .AI_PROMPTS_GENERATED as ReadonlyArray<{
    id: string;
    sourcePath: string;
    body: string;
    sha256: string;
  }>;

  const promptFiles = listPromptFiles();
  check("مجلد prompts/ موجود وغير فارغ", promptFiles.length > 0);
  for (const abs of promptFiles) {
    check(`ملف موجه موجود: ${relative(root, abs)}`, existsSync(abs));
  }

  // 1. every registered prompt exists (file present + id declared + matches)
  const fileIds = new Set<string>();
  for (const entry of PROMPT_REGISTRY) {
    const abs = join(root, ...entry.sourcePath.split("/"));
    const exists = existsSync(abs);
    check(`ملف الموجه المسجل موجود: ${entry.sourcePath}`, exists);
    if (!exists) continue;
    const raw = readFileSync(abs, "utf8");
    const declared = parsePromptId(raw);
    check(
      `${entry.id}: المعرف المعلن في الملف يطابق السجل`,
      declared === entry.id,
    );
    fileIds.add(declared ?? "__missing__");
  }

  // no orphan prompt files (on disk but not registered)
  for (const abs of promptFiles) {
    const rel = relative(root, abs);
    const registered = PROMPT_REGISTRY.some(
      (e) => join(root, ...e.sourcePath.split("/")) === abs,
    );
    check(`ملف الموجه مُسجل: ${rel}`, registered);
  }

  // 2. no duplicate prompt ids (registry, files, and generated artifact)
  const registryIds = PROMPT_REGISTRY.map((e) => e.id);
  const generatedIds = generated.map((g) => g.id);
  check(
    "لا معرفات موجهات مكررة في السجل",
    new Set(registryIds).size === registryIds.length,
  );
  check(
    "لا معرفات مكررة في الأداة المولدة",
    new Set(generatedIds).size === generatedIds.length,
  );
  check(
    "معرفات السجل = معرفات الأداة المولدة",
    JSON.stringify([...registryIds].sort()) ===
      JSON.stringify([...generatedIds].sort()),
  );

  // 3. required variables/placeholders are valid
  for (const entry of PROMPT_REGISTRY) {
    const g = generated.find((x) => x.id === entry.id);
    if (!g) continue;
    const placeholders = [...g.body.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(
      (m) => m[1]!,
    );
    check(
      `${entry.id}: لا عناصر نائبة غير معلنة`,
      placeholders.every((p) => entry.variables.includes(p)),
    );
    check(
      `${entry.id}: كل العناصر المعلنة موجودة في النص`,
      entry.variables.every((v) => placeholders.includes(v)),
    );
  }

  // 4. generated artifact matches the source prompt files (drift guard)
  check(
    "الأداة المولدة موجودة",
    existsSync(join(root, "src/generated/ai-prompts.generated.ts")),
  );
  for (const entry of PROMPT_REGISTRY) {
    const abs = join(root, ...entry.sourcePath.split("/"));
    if (!existsSync(abs)) continue;
    const compiled = compilePromptBody(readFileSync(abs, "utf8"));
    const g = generated.find((x) => x.id === entry.id);
    check(
      `${entry.id}: النص المولد يطابق المصدر (byte-identical)`,
      g?.body === compiled,
    );
  }

  // 5. runtime consumes the generated artifact (not a literal string)
  const promptSrc = readFileSync(
    join(root, "src/server/integrations/ai/prompt.ts"),
    "utf8",
  );
  const atriaSrc = readFileSync(
    join(root, "src/server/integrations/ai/atria.ts"),
    "utf8",
  );
  check(
    "prompt.ts يحمل النص من الأداة المولدة (getPromptBody)",
    promptSrc.includes("getPromptBody(") &&
      !/\[\s*\n?\s*"[^"]+",\s*\n?\s*"/.test(promptSrc),
  );
  check(
    "atria.ts يحمل تعليمات JSON من الأداة المولدة (getPromptBody)",
    atriaSrc.includes("getPromptBody("),
  );
  {
    const loadedSystem = (await import("../src/server/integrations/ai/prompt"))
      .AI_SYSTEM_INSTRUCTIONS as string;
    const loadedAtria = (await import("../src/server/integrations/ai/atria"))
      .ATRIA_JSON_INSTRUCTIONS as string;
    check(
      "وقت التشغيل يقرأ النص من الأداة المولدة فعلياً",
      loadedSystem ===
        generated.find((g) => g.id === "system.booking-assistant")?.body &&
        loadedAtria ===
          generated.find((g) => g.id === "providers.atria.json-output")?.body,
    );
  }

  // 6. known prompt bodies are not silently reintroduced into runtime TS
  const runtimeDirs = [
    join(root, "src/server/integrations/ai"),
    join(root, "src/features/conversations/server"),
  ];
  const knownSentences = generated.flatMap((g) =>
    g.body.split(". ").filter((s) => s.trim().length > 40),
  );
  for (const dir of runtimeDirs) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, name), "utf8");
      const leaked = knownSentences.find((s) => {
        const probe = s.slice(0, 60);
        return src.includes(probe) && !src.includes("getPromptBody");
      });
      check(
        `لا نص موجه يعاد حرفياً في ${dir === runtimeDirs[0] ? "ai/" : "conversations/"}${name}`,
        !leaked,
      );
    }
  }

  // 7. no secret/token shape inside prompt files
  for (const abs of promptFiles) {
    const raw = readFileSync(abs, "utf8");
    check(
      `لا سر في ${relative(root, abs)}`,
      !/\bsk-[A-Za-z0-9]{20,}\b/.test(raw) &&
        !/Bearer/i.test(raw) &&
        !/-----BEGIN.*PRIVATE KEY-----/.test(raw) &&
        !/(?:api[_-]?key|secret|token|password)\s*[:=]/i.test(raw),
    );
  }

  // Catalog (docs/ai/PROMPTS.md) is documentation only: it must list every
  // runtime prompt id with its four catalog fields and must NOT carry bodies.
  for (const id of listPromptIds()) {
    check(`الكتالوج يذكر الموجه ${id}`, promptsRaw.includes(id));
  }
  check(
    "الكتالوج لا يحمل أجسام الموجهات (لا نص كامل)",
    !generated.some((g) => promptsRaw.includes(g.body.slice(0, 80))),
  );
  check(
    "الكتالوج يشير إلى شجرة prompts/",
    promptsRaw.includes("prompts/") && promptsRaw.includes(".prompt"),
  );
  check(
    "الكتالوج يذكر أنه توثيق فقط (وليس المصدر)",
    /catalog|documentation only|catalogue/i.test(promptsRaw),
  );

  // Deterministic classifier behavior specs — documented, code-owned. These
  // are NOT LLM prompt bodies; the fixtures below prove them against code.
  const expectedIds = [
    "booking-intent",
    "faq-match",
    "availability-handoff",
    "reschedule-cancellation",
    "human-request",
  ];
  check(
    "PROMPTS.md يذكر AiRequest و AiResponse و parseAiResponse",
    promptsRaw.includes("AiRequest") &&
      promptsRaw.includes("AiResponse") &&
      promptsRaw.includes("parseAiResponse"),
  );
  check(
    "PROMPTS.md يذكر أن reasoning يُشطب",
    promptsRaw.includes("reasoning") && promptsRaw.includes("stripped"),
  );

  // Provider-neutrality: forbid invocation syntax in the real prompt bodies
  // and in the docs. Bodies now live in /prompts, so they are the target.
  const allDocsRaw =
    promptsRaw + "\n" + archRaw + "\n" + evalRaw + "\n" + readmeRaw;
  const promptBodiesJoined = generated.map((g) => g.body).join("\n");
  const invocationChecks: Array<{
    kind: string;
    re: RegExp;
    scope: "promptBlocks" | "allDocs";
  }> = [
    {
      kind: "Authorization Bearer header",
      re: /Authorization\s*:\s*Bearer/i,
      scope: "allDocs",
    },
    { kind: "x-api-key header", re: /x-api-key\s*:/i, scope: "allDocs" },
    {
      kind: "sk secret shape",
      re: /\bsk-[A-Za-z0-9]{20,}\b/,
      scope: "allDocs",
    },
    {
      kind: "private key",
      re: /-----BEGIN.*PRIVATE KEY-----/,
      scope: "allDocs",
    },
    {
      kind: "model hack assignment",
      re: /"model"\s*:\s*"(gpt-4o|claude|gemini)/i,
      scope: "allDocs",
    },
    {
      kind: "openrouter model ref",
      re: /\bopenrouter\/[a-z0-9_-]+\b/i,
      scope: "promptBlocks",
    },
    {
      kind: "agentrouter model ref",
      re: /\bagentrouter\/[a-z0-9_-]+\b/i,
      scope: "promptBlocks",
    },
  ];
  const promptBlocksJoined = promptBodiesJoined;
  for (const c of invocationChecks) {
    const hay = c.scope === "promptBlocks" ? promptBlocksJoined : allDocsRaw;
    check(`لا نمط استدعاء مزود (${c.kind})`, !c.re.test(hay));
  }
  check(
    "تعاريف PROMPTS بلا Prisma create/update مباشر",
    !/prisma\.(appointment|conversation|business)\.(create|update|find)/i.test(
      promptBlocksJoined,
    ),
  );

  // Import runtime modules (import() type annotations are intentional for
  // type-only casts of dynamic imports; inline disable is consumed — file-level
  // exemption below for this harness).
  const aiContract =
    await import("../src/features/conversations/server/ai-contract");
  const convAi =
    await import("../src/features/conversations/server/conversation-ai");
  const {
    classifyCustomerMessage,
    bypassDeterministicAi,
    deterministicConversationAi,
  } =
    convAi as typeof import("../src/features/conversations/server/conversation-ai");
  const {
    parseAiResponse,
    aiIntentValues,
    handoffReasonValues,
    emptyAiExtraction,
    synthesizeDecisionGoals,
    aiGoalKindValues,
  } =
    aiContract as typeof import("../src/features/conversations/server/ai-contract");

  for (const id of expectedIds) {
    check(`EVALUATIONS.md يغطي ${id}@v1`, evalRaw.includes(`${id}@v1`));
  }
  check("EVALUATIONS.md يحتوي جدول Fixtures", evalRaw.includes("## Fixtures"));

  function aiReq(
    message: string,
    faqs: Array<{ question: string; answer: string }> = [],
    services: Array<{ name: string; durationMinutes: number }> = [],
  ): AiRequest {
    return {
      message,
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "منشأة تجريبية",
      services,
      faqs,
    };
  }

  {
    const r = classifyCustomerMessage("عايز أحجز موعد", []);
    check(
      "01 BOOKING عايز أحجز موعد → BOOKING/booking_handoff",
      r.intent === "BOOKING" &&
        r.action === "booking_handoff" &&
        r.handoffReason === null &&
        r.summary !== null,
    );
  }
  {
    const req = aiReq(
      "عايز أحجز تنظيف أسنان يوم الخميس",
      [],
      [{ name: "تنظيف أسنان", durationMinutes: 30 }],
    );
    const r = await deterministicConversationAi.respond(req);
    check(
      "02 BOOKING استخراج الخدمة تنظيف أسنان verbatim",
      r.intent === "BOOKING" && r.extraction.service === "تنظيف أسنان",
    );
  }
  {
    const faqs = [
      { question: "ما هي ساعات العمل؟", answer: "من 9 صباحاً حتى 6 مساءً" },
    ];
    const r = classifyCustomerMessage("ما هي ساعات العمل؟", faqs);
    check(
      "03 FAQ ساعات العمل → FAQ/reply verbatim",
      r.intent === "FAQ" &&
        r.action === "reply" &&
        r.content === faqs[0]!.answer &&
        r.summary === null,
    );
  }
  {
    const faqs = [
      { question: "هل عندكم تقويم أسنان؟", answer: "نعم نوفر تقويم…" },
    ];
    const r = classifyCustomerMessage("هل عندكم تقويم أسنان؟", faqs);
    check(
      "04 FAQ تقويم أسنان → FAQ verbatim",
      r.intent === "FAQ" && r.content === faqs[0]!.answer,
    );
  }
  {
    const r = classifyCustomerMessage("إيه الأوقات المتاحة بكرة؟", []);
    check(
      "05 AVAILABILITY الأوقات المتاحة → AVAILABILITY/booking_handoff",
      r.intent === "AVAILABILITY" &&
        r.action === "booking_handoff" &&
        r.summary !== null,
    );
  }
  {
    const faqs = [{ question: "هل يوجد حشو؟", answer: "نعم …" }];
    const r = classifyCustomerMessage("إمتى ممكن آجي؟", faqs);
    check(
      "06 AVAILABILITY إمتى ممكن آجي؟ → AVAILABILITY (FAQ لم يطابق)",
      r.intent === "AVAILABILITY",
    );
  }
  {
    const r = classifyCustomerMessage("عايز ألغي الموعد", []);
    check(
      "07 CANCELLATION عايز ألغي الموعد → CANCELLATION",
      r.intent === "CANCELLATION" &&
        r.action === "booking_handoff" &&
        r.summary === "طلب العميل إلغاء موعده",
    );
  }
  {
    const r = classifyCustomerMessage("عايز أغيّر معاد الحجز", []);
    check(
      "08 RESCHEDULE عايز أغيّر معاد الحجز → RESCHEDULE",
      r.intent === "RESCHEDULE" && r.summary === "طلب العميل تعديل موعده",
    );
  }
  {
    const r = classifyCustomerMessage("مش هقدر أحضر", []);
    check(
      "09 CANCELLATION مش هقدر أحضر → CANCELLATION",
      r.intent === "CANCELLATION",
    );
  }
  {
    const r = classifyCustomerMessage("عايز أكلم موظف حقيقي", []);
    check(
      "10 HUMAN_REQUEST موظف حقيقي → HUMAN_REQUEST/handoff",
      r.intent === "HUMAN_REQUEST" &&
        r.action === "handoff" &&
        r.handoffReason === "HUMAN_REQUEST",
    );
  }
  {
    const r = classifyCustomerMessage("عندي ألم شديد وتورم", []);
    check(
      "11 SENSITIVE ألم شديد وتورم → AMBIGUOUS/SENSITIVE",
      r.intent === "AMBIGUOUS" && r.handoffReason === "SENSITIVE",
    );
  }
  {
    const r = classifyCustomerMessage("هل عندكم زراعة أسنان؟", []);
    check(
      "12 NO_KNOWLEDGE سؤال بلا معرفة → AMBIGUOUS/NO_KNOWLEDGE",
      r.intent === "AMBIGUOUS" && r.handoffReason === "NO_KNOWLEDGE",
    );
  }
  {
    const r = classifyCustomerMessage("م", []);
    const bypass = bypassDeterministicAi(aiReq("م"));
    check(
      "13 AMBIGUOUS م → AMBIGUOUS/handoff",
      r.intent === "AMBIGUOUS" && r.handoffReason === "AMBIGUOUS",
    );
    check(
      "13 bypassDeterministicAi م → AMBIGUOUS (no AI_TURN)",
      bypass !== null &&
        bypass.intent === "AMBIGUOUS" &&
        bypass.handoffReason === "AMBIGUOUS",
    );
  }
  {
    const faqs = [{ question: "ساعات العمل؟", answer: "من 9 حتى 6" }];
    const r = classifyCustomerMessage(
      "عايز أحجز موعد، وما هي ساعات العمل؟",
      faqs,
    );
    check("14 ترتيب BOOKING يفوق FAQ → BOOKING", r.intent === "BOOKING");
  }
  {
    const faqs = [
      { question: "ما هي ساعات العمل؟", answer: "من 9 صباحاً حتى 6 مساءً" },
    ];
    const withFaq = classifyCustomerMessage("ما هي ساعات العمل؟", faqs);
    const avail = classifyCustomerMessage("إمتى ممكن آجي؟", []);
    check(
      "15 ترتيب FAQ يفوق AVAILABILITY → FAQ حين يطابق",
      withFaq.intent === "FAQ",
    );
    check("15 بدون FAQ مطابق → AVAILABILITY", avail.intent === "AVAILABILITY");
  }
  {
    const a = classifyCustomerMessage("عايز أحجز موعد", []);
    const b = classifyCustomerMessage("عايز أحجز موعد", []);
    check(
      "الحل حتمي — نفس المدخل نفس المخرج",
      JSON.stringify(a) === JSON.stringify(b),
    );
  }

  // Negative invariants
  {
    const raw = {
      intent: "FAQ" as const,
      action: "reply" as const,
      content: "من 9 حتى 6",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
      reasoning: "chain of thought that must be stripped",
      chainOfThought: "another",
    };
    const parsed = parseAiResponse(raw);
    check(
      "parseAiResponse يشطب reasoning/chainOfThought",
      parsed !== null &&
        !("reasoning" in (parsed as Record<string, unknown>)) &&
        !("chainOfThought" in (parsed as Record<string, unknown>)),
    );
  }
  {
    const bad = parseAiResponse({
      intent: "UNKNOWN",
      action: "reply",
      content: "hi",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
    });
    check("intent غير معروف مرفوض", bad === null);
  }
  {
    const bad = parseAiResponse({
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "رد",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
    });
    check("handoff بلا سبب مرفوض", bad === null);
  }
  {
    const bad = parseAiResponse({
      intent: "BOOKING",
      action: "booking_handoff",
      content: "رد",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
    });
    check("booking_handoff بلا ملخص مرفوض", bad === null);
  }
  {
    const intentsHaystack = `${promptBodiesJoined}\n${promptsRaw}`;
    const promptIntents = [
      ...intentsHaystack.matchAll(/intent:\s*"([A-Z_]+)"/g),
    ].map((m) => m[1]!);
    const allowedIntents = new Set(aiIntentValues as readonly string[]);
    check(
      "كل intent مذكور في الموجهات ضمن aiIntentValues",
      promptIntents.every((v) => allowedIntents.has(v)),
    );
    const promptReasons = [
      ...intentsHaystack.matchAll(/handoffReason:\s*"([A-Z_]+)"/g),
    ].map((m) => m[1]!);
    const allowedReasons = new Set(handoffReasonValues as readonly string[]);
    check(
      "كل handoffReason في الموجهات ضمن handoffReasonValues",
      promptReasons.length === 0 ||
        promptReasons.every((v) => allowedReasons.has(v)),
    );
  }

  // ── PRODUCER CONTRACT: multi-intent goals[] activation (PROMPT-AI-ARCH-10) ──
  // The producer boundary that PROMPT-AI-EVAL-12 proved missing: the canonical
  // system prompt must now ASK for goals[] on genuine multi-intent turns, and
  // the response contract/parser must ACCEPT a genuine multi-goal structure
  // (while staying strict enough to reject malformed goals) and stay
  // single-intent compatible. These checks assert the PRODUCER side only — the
  // resolver/state/engine consumption is guarded by check:multi-intent.
  {
    const systemPrompt =
      generated.find((g) => g.id === "system.booking-assistant")?.body ?? "";

    // (a) The prompt now DESCRIBES goals[] in the contract + multi-intent rule.
    check(
      "PRODUCER: الموجه يصف goals[] في العقد",
      /goals:\s*ordered array/i.test(systemPrompt) &&
        aiGoalKindValues.every((k) => systemPrompt.includes(k)),
    );
    check(
      "PRODUCER: الموجه يُعلّم تعدد النوايا (goals[] عند أكثر من هدف)",
      /Multi-intent/i.test(systemPrompt) &&
        /continueAfter/.test(systemPrompt) &&
        /lowest priority first/i.test(systemPrompt),
    );
    // (b) Single-intent must stay valid: the prompt tells the model to OMIT
    // goals[] for one goal and never manufacture extra goals.
    check(
      "PRODUCER: الموجه يبقي النية الواحدة صالحة (أهمِل goals[]؛ لا تُلفّق أهدافاً)",
      /OMIT goals\[\]/i.test(systemPrompt) &&
        /NEVER manufacture extra goals/i.test(systemPrompt),
    );
    // (c) Safety stays authoritative in the producer instruction.
    check(
      "PRODUCER: الموجه يُبقي السلامة/التحويل مرجعاً أعلى",
      /Safety stays authoritative/i.test(systemPrompt) &&
        /never hide a required handoff/i.test(systemPrompt),
    );
    // (d) The resolver owns precedence/one-goal/one-send — not the model.
    check(
      "PRODUCER: الموجه يسند الأسبقية/التنفيذ للمحلّل الحتمي",
      /resolver executes exactly ONE goal/i.test(systemPrompt) &&
        /OWNS all precedence/i.test(systemPrompt),
    );
    // (e) ANSWER-AND-CONTINUE TOP-LEVEL ACTION BINDING (PROMPT-AI-ARCH-11).
    //     The exact EVAL-13 remediation: an answerable knowledge goal that
    //     coexists with a domain/booking goal MUST pin the top-level action to
    //     `reply` (with the answer as content) and defer the domain goal via
    //     goals[] + continueAfter — NEVER top-level booking_handoff just because
    //     a domain goal also exists.
    check(
      "PRODUCER: الموجه يُثبّت action=reply على هدف الإجابة عند تعايشه مع هدف نطاق (استجب-واستمر)",
      /Answer-and-continue/i.test(systemPrompt) &&
        /TOP-LEVEL action to reply/i.test(systemPrompt) &&
        /do NOT set the top-level action to booking_handoff/i.test(
          systemPrompt,
        ),
    );
    // (f) The top-level action represents the CURRENT customer-visible response
    //     (the goal answered THIS turn), not a goal merely being deferred.
    check(
      "PRODUCER: الموجه يُعرّف الحقول العليا كاستجابة الدور الحالية (لا هدفاً مؤجَّلاً)",
      /CURRENT customer-visible response/i.test(systemPrompt) &&
        /never for a goal you are only deferring/i.test(systemPrompt),
    );
    // (g) The handoff override is explicit: a required human/sensitive/
    //     knowledge-gap handoff OUTRANKS answer-and-continue (the critical
    //     precedence rule — answer-and-continue never masks a required handoff).
    check(
      "PRODUCER: الموجه يُبقي التحويل المطلوب أعلى من استجب-واستمر (NO_KNOWLEDGE لا رد مُلفَّق)",
      /OUTRANKS answer-and-continue/i.test(systemPrompt) &&
        /genuinely answerable/i.test(systemPrompt) &&
        /NO_KNOWLEDGE rather than forcing a reply/i.test(systemPrompt),
    );
  }

  // ── PRODUCER: business-identity instruction (PROMPT-AI-UX-03B) ──────────
  // The canonical system prompt must tell the model that businessName is the
  // authoritative stored name, that a DIFFERENT customer wording is explained
  // (not treated as unanswerable on its own), that no official/legal identity
  // or unstored attribute may be invented, and that an ABSENT name falls back
  // to NO_KNOWLEDGE. The disclosure gate/builder identity channel (UX-02) is
  // the backstop; these checks pin the producer-side contract.
  {
    const systemPrompt =
      generated.find((g) => g.id === "system.booking-assistant")?.body ?? "";
    check(
      "PRODUCER-UX03B: الموجه يعلن businessName المرجع المعتمد للهوية",
      /Business identity:/i.test(systemPrompt) &&
        /businessName is the AUTHORITATIVE stored business name/i.test(
          systemPrompt,
        ),
    );
    check(
      "PRODUCER-UX03B: اختلاف صياغة العميل يُشرح (لا يُعامل كسؤال بلا إجابة)",
      /wording differs from businessName/i.test(systemPrompt) &&
        /registered\/stored name is businessName/i.test(systemPrompt),
    );
    check(
      "PRODUCER-UX03B: لا ادّعاء هوية رسمية/قانونية ولا استنتاج سمات غير مخزنة",
      /Do NOT claim an official, legal, licensed, or accredited identity/i.test(
        systemPrompt,
      ) && /do NOT infer attributes that are not stored/i.test(systemPrompt),
    );
    check(
      "PRODUCER-UX03B: غياب businessName ⇒ NO_KNOWLEDGE (لا اختراع اسم)",
      /businessName is empty or absent/i.test(systemPrompt) &&
        /NEVER invent a name/i.test(systemPrompt),
    );
  }

  // (1) single-intent output — valid, no goals[] needed.
  {
    const single = parseAiResponse({
      intent: "FAQ",
      action: "reply",
      content: "من 9 حتى 6",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
    });
    const goals = single ? synthesizeDecisionGoals(single) : [];
    check(
      "PRODUCER-1: نية واحدة صالحة بلا goals[] → هدف واحد مُركَّب",
      single !== null && goals.length === 1 && goals[0]!.kind === "ANSWER",
    );
  }

  // (2) genuine multi-intent output with 2+ goals — accepted + preserved.
  {
    const multi = parseAiResponse({
      intent: "FAQ",
      action: "reply",
      content: "من 9 صباحاً حتى 6 مساءً",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 0 },
        {
          kind: "DOMAIN_ACTION",
          intent: "BOOKING",
          priority: 1,
          continueAfter: true,
        },
      ],
    });
    check(
      "PRODUCER-2: تعدد النوايا (هدفان) مقبول ومحفوظ في العقد",
      multi !== null &&
        multi.goals?.length === 2 &&
        multi.goals[0]!.kind === "ANSWER" &&
        multi.goals[1]!.kind === "DOMAIN_ACTION" &&
        multi.goals[1]!.continueAfter === true,
    );
  }

  // (3) multi-intent goal ORDERING — array order is preserved verbatim.
  {
    const ordered = parseAiResponse({
      intent: "BOOKING",
      action: "booking_handoff",
      content: "تمام",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: "حجز + سؤال",
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 2 },
        { kind: "DOMAIN_ACTION", intent: "BOOKING", priority: 0 },
        { kind: "ANSWER", intent: "AVAILABILITY", priority: 1 },
      ],
    });
    check(
      "PRODUCER-3: ترتيب أهداف تعدد النوايا محفوظ حرفياً (parser لا يعيد الترتيب)",
      ordered !== null &&
        ordered.goals?.map((g) => g.intent).join(",") ===
          "FAQ,BOOKING,AVAILABILITY" &&
        ordered.goals?.map((g) => g.priority).join(",") === "2,0,1",
    );
  }

  // (4) invalid/malformed goals structure — strictly rejected.
  {
    const badKind = parseAiResponse({
      intent: "FAQ",
      action: "reply",
      content: "رد",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
      goals: [{ kind: "SELL" }],
    });
    const missingKind = parseAiResponse({
      intent: "FAQ",
      action: "reply",
      content: "رد",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
      goals: [{ intent: "FAQ" }],
    });
    const notArray = parseAiResponse({
      intent: "FAQ",
      action: "reply",
      content: "رد",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
      goals: { kind: "ANSWER" },
    });
    check(
      "PRODUCER-4: بنية goals[] مشوّهة مرفوضة (نوع خاطئ/ناقص/ليست مصفوفة)",
      badKind === null && missingKind === null && notArray === null,
    );
  }

  // (5) single-goal compatibility with Slice 5 — one explicit goal round-trips
  //     and synthesizes to exactly that one goal.
  {
    const oneGoal = parseAiResponse({
      intent: "FAQ",
      action: "reply",
      content: "رد",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
      goals: [{ kind: "ANSWER", intent: "FAQ", priority: 0 }],
    });
    const goals = oneGoal ? synthesizeDecisionGoals(oneGoal) : [];
    check(
      "PRODUCER-5: هدف واحد صريح متوافق مع Slice 5 (يبقى هدفاً واحداً)",
      oneGoal !== null && goals.length === 1 && goals[0]!.kind === "ANSWER",
    );
  }

  // (6) human + other goal — the producer keeps the top-level handoff so the
  //     resolver's EXISTING precedence hands off (never masked by a goal).
  {
    const humanPlus = parseAiResponse({
      intent: "HUMAN_REQUEST",
      action: "handoff",
      content: "تحويل",
      extraction: { ...emptyAiExtraction },
      handoffReason: "HUMAN_REQUEST",
      summary: null,
      goals: [
        { kind: "HANDOFF", intent: "HUMAN_REQUEST", priority: 0 },
        { kind: "DOMAIN_ACTION", intent: "BOOKING", priority: 1 },
      ],
    });
    check(
      "PRODUCER-6: إنسان + هدف آخر → العقد يبقى handoff/HUMAN_REQUEST (أسبقية التحويل)",
      humanPlus !== null &&
        humanPlus.action === "handoff" &&
        humanPlus.handoffReason === "HUMAN_REQUEST" &&
        humanPlus.goals?.some((g) => g.kind === "HANDOFF") === true,
    );
  }

  // (7) sensitive + other goal — top-level handoff/SENSITIVE preserved.
  {
    const sensitivePlus = parseAiResponse({
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "تحويل",
      extraction: { ...emptyAiExtraction },
      handoffReason: "SENSITIVE",
      summary: null,
      goals: [
        { kind: "HANDOFF", intent: "AMBIGUOUS", priority: 0 },
        { kind: "DOMAIN_ACTION", intent: "BOOKING", priority: 1 },
      ],
    });
    check(
      "PRODUCER-7: حساس + هدف آخر → العقد يبقى handoff/SENSITIVE",
      sensitivePlus !== null &&
        sensitivePlus.action === "handoff" &&
        sensitivePlus.handoffReason === "SENSITIVE",
    );
  }

  // (8) knowledge-gap + other goal — top-level handoff/NO_KNOWLEDGE preserved.
  {
    const gapPlus = parseAiResponse({
      intent: "AMBIGUOUS",
      action: "handoff",
      content: "تحويل",
      extraction: { ...emptyAiExtraction },
      handoffReason: "NO_KNOWLEDGE",
      summary: null,
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 0 },
        { kind: "DOMAIN_ACTION", intent: "BOOKING", priority: 1 },
      ],
    });
    check(
      "PRODUCER-8: فجوة معرفة + هدف آخر → العقد يبقى handoff/NO_KNOWLEDGE",
      gapPlus !== null &&
        gapPlus.action === "handoff" &&
        gapPlus.handoffReason === "NO_KNOWLEDGE",
    );
  }

  // (9) single-intent BOOKING remains valid (PROMPT-AI-ARCH-11 regression):
  //     a lone booking turn needs no goals[] and synthesizes to exactly ONE
  //     DOMAIN_ACTION goal — the answer-and-continue binding never forces a
  //     reply onto a genuinely single booking intent.
  {
    const booking = parseAiResponse({
      intent: "BOOKING",
      action: "booking_handoff",
      content: "تمام، هحجزلك",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: "طلب حجز",
    });
    const goals = booking ? synthesizeDecisionGoals(booking) : [];
    check(
      "PRODUCER-9: نية حجز واحدة صالحة بلا goals[] → هدف DOMAIN_ACTION واحد مُركَّب",
      booking !== null &&
        booking.action === "booking_handoff" &&
        goals.length === 1 &&
        goals[0]!.kind === "DOMAIN_ACTION",
    );
  }

  // (10) ANSWER + BOOKING with TOP-LEVEL action=reply (the remediated shape):
  //      an answerable knowledge goal is the primary (top-level reply + backed
  //      content) and the booking goal is deferred via goals[] + continueAfter.
  //      This is the exact structure the producer must now emit so the
  //      resolver's answer-and-continue path fires (consumption guarded by
  //      check:multi-intent).
  {
    const answerPlusBooking = parseAiResponse({
      intent: "FAQ",
      action: "reply",
      content: "مواعيدنا من 9 صباحاً حتى 6 مساءً",
      extraction: { ...emptyAiExtraction },
      handoffReason: null,
      summary: null,
      goals: [
        { kind: "ANSWER", intent: "FAQ", priority: 0 },
        {
          kind: "DOMAIN_ACTION",
          intent: "BOOKING",
          priority: 1,
          continueAfter: true,
        },
      ],
    });
    check(
      "PRODUCER-10: إجابة + حجز بـ action=reply أعلى → هدف ANSWER أساسي + هدف حجز مؤجَّل (continueAfter)",
      answerPlusBooking !== null &&
        answerPlusBooking.action === "reply" &&
        answerPlusBooking.goals?.length === 2 &&
        answerPlusBooking.goals[0]!.kind === "ANSWER" &&
        answerPlusBooking.goals[1]!.kind === "DOMAIN_ACTION" &&
        answerPlusBooking.goals[1]!.intent === "BOOKING" &&
        answerPlusBooking.goals[1]!.continueAfter === true,
    );
  }

  check(
    "المحرك يستدعي bypassDeterministicAi قبل ai.respond",
    engineRaw.includes("bypassDeterministicAi") &&
      engineRaw.indexOf("bypassDeterministicAi") <
        engineRaw.indexOf("ai.respond"),
  );
  check(
    "المحرك يعيد التحقق عبر parseAiResponse",
    engineRaw.includes("parseAiResponse"),
  );
  check(
    "المحرك يحمّل minimal context (AiRequest)",
    engineRaw.includes("AiRequest"),
  );
  check(
    "المحرك بلا Prisma مباشر",
    !/from\s+"@\/lib\/prisma"/.test(engineRaw) && !/prisma\./.test(engineRaw),
  );
  check(
    "ARCHITECTURE يذكر PlatformAiPolicy منفصل عن prompts",
    archRaw.includes("PlatformAiPolicy") &&
      archRaw.includes("platform_ai_policies"),
  );

  check("لا شكل sk- في docs/ai", !/\bsk-[A-Za-z0-9]{20,}\b/.test(allDocsRaw));
  check(
    "لا مفتاح خاص في docs/ai",
    !/-----BEGIN.*PRIVATE KEY-----/.test(allDocsRaw),
  );

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
    `\nثوابت موجهات الذكاء صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
