/* eslint-disable @typescript-eslint/consistent-type-imports */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AiRequest } from "../src/features/conversations/server/ai-contract";

/**
 * FlowPilot — AI PROMPT & EVALUATION SEPARATION check (PROMPT-ARCH-03).
 *
 * Verifies the provider-neutral, versioned prompt artifacts and their
 * deterministic fixtures — no DB, no network, no secrets.
 * Run: pnpm check:ai-prompts
 */

export {};

type Check = { label: string; pass: boolean };

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

  const promptHeadings = [
    ...promptsRaw.matchAll(/^###\s+(.+?)@v(\d+)\s*$/gm),
  ].map((m) => ({
    id: m[1]!.trim(),
    version: `v${m[2]!}`,
  }));
  const expectedIds = [
    "booking-intent",
    "faq-match",
    "availability-handoff",
    "reschedule-cancellation",
    "human-request",
  ];
  for (const id of expectedIds) {
    check(
      `تعريف ${id}@v1 موجود`,
      promptHeadings.some((h) => h.id === id && h.version === "v1"),
    );
  }
  check("عدد التعاريف = 5 (v1 لكل عائلة)", promptHeadings.length === 5);

  const requiredSections = [
    "\\*\\*Purpose:",
    "\\*\\*Input context:",
    "\\*\\*System instructions:",
    "\\*\\*Output contract:",
    "\\*\\*Constraints",
    "\\*\\*Handoff policy:",
    "\\*\\*Version history:",
  ];
  for (const heading of promptHeadings) {
    const start = promptsRaw.indexOf(`### ${heading.id}@${heading.version}`);
    const nextHead = promptsRaw.indexOf("\n### ", start + 1);
    const block =
      nextHead === -1
        ? promptsRaw.slice(start)
        : promptsRaw.slice(start, nextHead);
    for (const sec of requiredSections) {
      check(
        `قسم ${sec.replace(/\\\*/g, "*")} في ${heading.id}@${heading.version}`,
        new RegExp(sec).test(block),
      );
    }
  }

  const intentActionExpectations: Record<
    string,
    { intent: string; action: string }
  > = {
    "booking-intent": { intent: "BOOKING", action: "booking_handoff" },
    "faq-match": { intent: "FAQ", action: "reply" },
    "availability-handoff": {
      intent: "AVAILABILITY",
      action: "booking_handoff",
    },
  };
  for (const [id, exp] of Object.entries(intentActionExpectations)) {
    const start = promptsRaw.indexOf(`### ${id}@v1`);
    const nextHead = promptsRaw.indexOf("\n### ", start + 1);
    const block =
      nextHead === -1
        ? promptsRaw.slice(start)
        : promptsRaw.slice(start, nextHead);
    check(`${id}@v1 يذكر intent "${exp.intent}"`, block.includes(exp.intent));
    check(`${id}@v1 يذكر action "${exp.action}"`, block.includes(exp.action));
  }
  {
    const start = promptsRaw.indexOf("### reschedule-cancellation@v1");
    const nextHead = promptsRaw.indexOf("\n### ", start + 1);
    const block =
      nextHead === -1
        ? promptsRaw.slice(start)
        : promptsRaw.slice(start, nextHead);
    check(
      "reschedule-cancellation@v1 يذكر CANCELLATION و RESCHEDULE",
      block.includes("CANCELLATION") && block.includes("RESCHEDULE"),
    );
    check(
      "reschedule-cancellation@v1 action booking_handoff",
      block.includes("booking_handoff"),
    );
  }
  {
    const start = promptsRaw.indexOf("### human-request@v1");
    const nextHead = promptsRaw.indexOf("\n### ", start + 1);
    const block =
      nextHead === -1
        ? promptsRaw.slice(start)
        : promptsRaw.slice(start, nextHead);
    check(
      "human-request@v1 يذكر HUMAN_REQUEST و AMBIGUOUS",
      block.includes("HUMAN_REQUEST") && block.includes("AMBIGUOUS"),
    );
    check("human-request@v1 action handoff", block.includes("handoff"));
  }

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

  // Provider-neutrality: forbid invocation syntax, allow prose mentions
  const allDocsRaw =
    promptsRaw + "\n" + archRaw + "\n" + evalRaw + "\n" + readmeRaw;
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
  const promptBlocksJoined = promptHeadings
    .map((h) => {
      const s = promptsRaw.indexOf(`### ${h.id}@${h.version}`);
      const n = promptsRaw.indexOf("\n### ", s + 1);
      return n === -1 ? promptsRaw.slice(s) : promptsRaw.slice(s, n);
    })
    .join("\n");
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
    const promptIntents = [
      ...promptsRaw.matchAll(/intent:\s*"([A-Z_]+)"/g),
    ].map((m) => m[1]!);
    const allowedIntents = new Set(aiIntentValues as readonly string[]);
    check(
      "كل intent مذكور في PROMPTS ضمن aiIntentValues",
      promptIntents.every((v) => allowedIntents.has(v)),
    );
    const promptReasons = [
      ...promptsRaw.matchAll(/handoffReason:\s*"([A-Z_]+)"/g),
    ].map((m) => m[1]!);
    const allowedReasons = new Set(handoffReasonValues as readonly string[]);
    check(
      "كل handoffReason في PROMPTS ضمن handoffReasonValues",
      promptReasons.length === 0 ||
        promptReasons.every((v) => allowedReasons.has(v)),
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
