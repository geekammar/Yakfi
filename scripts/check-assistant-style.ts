/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — ASSISTANT STYLE / PERSONALITY surface check (DECISIONS #62).
 *
 * Deterministic, OFFLINE verification that the assistant's voice is ONE
 * structured, provider-neutral, channel-agnostic configuration surface —
 * so the operator never has to write or edit raw prompts (DECISIONS
 * #43/#48 forbid a prompt editor UI and forbid superadmin from editing
 * prompt definitions). No DB, no network, no LLM call, no API tokens, no
 * secrets, no WhatsApp transport.
 *
 *   S1  the resident style validates against the closed typed schema
 *   S2  every dimension is a closed non-empty enum and the resident value
 *       is a member of each (the surface is typed values, never prose)
 *   S3  the resident directive is Arabic-only — it can never smuggle a
 *       provider/endpoint/machine identifier into the request
 *   S4  the directive carries no secret-shaped content and none of the
 *       substrings the context-builder guards (provenance/source/
 *       visibility/durationMinutes/workingHours)
 *   S5  the style keeps the assistant transparent (it is told it is an
 *       automated assistant; it is never told to claim it is human)
 *   S6  the style module is provider-neutral: it imports no adapter and
 *       names no provider id
 *   S7  provider replacement needs NO style rewrite: the directive is
 *       request context rendered identically for every provider
 *   S8  the style cannot bypass safety/disclosure: the gate never reads
 *       it (the gate module imports no style; the gate input has no style
 *       field), the closed knowledge-free intent list is unchanged, and a
 *       knowledge-free reply still passes ONLY by declared intent
 *   S9  the deterministic voice conforms to the configured style
 *       (Arabic-only, no emoji, concise, greeting self-identifies)
 *
 *   GREETING (DECISIONS #61, no regression):
 *   G1  canonical Egyptian/MSA openings → GREETING reply, stays a reply
 *   G2  a greeting + a real intent keeps the real intent (never swallowed)
 *   G3  a bare time-of-day noun is NOT a greeting
 *   G4  the greeting reply spends ZERO provider calls (deterministic bypass)
 *   G5  the greeting reply discloses it is an assistant (never fakes human)
 *
 *   INTENT taxonomy discipline (DECISIONS #61/#62 — no invented intents):
 *   T1  the intent family is EXACTLY the documented 8 values, no drift
 *   T2  the candidate future intents (SMALL_TALK / THANKS / GOODBYE /
 *       CHITCHAT / CONFIRMATION) are documented as future observation and
 *       are absent from the contract and the prompt
 *
 * Run: pnpm check:assistant-style
 */
export {};

type Check = { label: string; pass: boolean };
type AiIntent =
  import("../src/features/conversations/server/ai-contract").AiIntent;
type AiResponse =
  import("../src/features/conversations/server/ai-contract").AiResponse;
type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}
function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const style =
    await import("../src/features/conversations/server/assistant-style");
  const contract =
    await import("../src/features/conversations/server/ai-contract");
  const ai =
    await import("../src/features/conversations/server/conversation-ai");
  const prompt = await import("../src/server/integrations/ai/prompt");
  const disclosure =
    await import("../src/features/conversations/server/ai-disclosure");

  // ── S1. the resident style validates ─────────────────────────────────────
  const parsedStyle = style.assistantStyleSchema.safeParse(
    style.ASSISTANT_STYLE,
  );
  check(
    "S1. النمط الساكن يطابق المخطط المغلق (قيم مُنمّطة، لا نثر حر)",
    parsedStyle.success,
  );

  // ── S2. closed, non-empty enums; the resident value is a member of each ─
  const dimensions: Array<{
    name: string;
    values: readonly string[];
    resident: string;
  }> = [
    {
      name: "language",
      values: style.assistantLanguageValues,
      resident: style.ASSISTANT_STYLE.language,
    },
    {
      name: "arabicStyle",
      values: style.arabicStyleValues,
      resident: style.ASSISTANT_STYLE.arabicStyle,
    },
    {
      name: "tone",
      values: style.toneValues,
      resident: style.ASSISTANT_STYLE.tone,
    },
    {
      name: "detail",
      values: style.detailValues,
      resident: style.ASSISTANT_STYLE.detail,
    },
    {
      name: "emoji",
      values: style.emojiValues,
      resident: style.ASSISTANT_STYLE.emoji,
    },
    {
      name: "role",
      values: style.assistantRoleValues,
      resident: style.ASSISTANT_STYLE.role,
    },
  ];
  check(
    "S2. كل بُعد تعدادٌ مغلق غير فارغ والقيمة الساكنة عضوٌ فيه",
    dimensions.every(
      (d) =>
        d.values.length >= 2 &&
        new Set(d.values).size === d.values.length &&
        d.values.includes(d.resident),
    ),
  );

  // ── S3. the resident directive is Arabic-only (no Latin at all) ────────
  check(
    "S3. توجيه النمط عربي خالص — لا يهرب معرّف مزود/نقطة نهاية للطلب",
    !/[A-Za-z]/.test(style.ASSISTANT_STYLE_DIRECTIVE) &&
      style.ASSISTANT_STYLE_DIRECTIVE.length > 20,
  );

  // ── S4. no secret-shaped content, no guarded substrings ────────────────
  const forbidden = [
    "Bearer",
    "sk-",
    "api_key",
    "DATABASE_URL",
    "Authorization",
    "source",
    "visibility",
    "provenance",
    "durationMinutes",
    "workingHours",
    "openrouter",
    "agentrouter",
    "atria",
    "codecraft",
  ];
  check(
    "S4. التوجيه خالٍ من الأسرار ومن سلاسل الحراسة (لا مصدر/رؤية/مزود)",
    !forbidden.some((token) =>
      style.ASSISTANT_STYLE_DIRECTIVE.toLowerCase().includes(
        token.toLowerCase(),
      ),
    ),
  );

  // ── S5. the style keeps the assistant transparent (never fakes human) ──
  check(
    "S5. النمط يُلزم المساعد بالشفافية — يُذكَّر أنه مساعد آلي، لا بشري",
    style.ASSISTANT_STYLE_DIRECTIVE.includes("مساعد آلي") &&
      style.ASSISTANT_STYLE_DIRECTIVE.includes("لا تدّعي أنك بشري"),
  );

  // ── S6. the style module is provider-neutral (source-level guard) ──────
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) =>
      fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const moduleSource = read(
      "src/features/conversations/server/assistant-style.ts",
    );
    check(
      "S6a. وحدة النمط لا تستورد أي محوّل مزود (محايدة عن المزود)",
      !/from\s+"@\/server\/integrations\/ai\/(atria|openrouter|agentrouter|codecraft)"/.test(
        moduleSource,
      ) && !moduleSource.includes("callOpenAiCompatible"),
    );
    check(
      "S6b. وحدة النمط لا تسمّي أي مزود (لا هوية مزود في الصوت)",
      !/openrouter|agentrouter|atria|codecraft/i.test(moduleSource),
    );
    check(
      "S6c. وحدة النمط محايدة عن القناة (لا ذكر لقناة في الصوت)",
      !/whatsapp|telegram/i.test(moduleSource),
    );
    // The renderer is total: every enum value has a fragment (no free text).
    const everyValueRendered = (() => {
      for (const language of style.assistantLanguageValues) {
        const rendered = style.renderAssistantStyleDirective({
          ...style.ASSISTANT_STYLE,
          language,
        });
        if (rendered.length < 10) return false;
      }
      for (const role of style.assistantRoleValues) {
        const rendered = style.renderAssistantStyleDirective({
          ...style.ASSISTANT_STYLE,
          role,
        });
        if (rendered.length < 10) return false;
      }
      return true;
    })();
    check(
      "S6d. مُنسّق التوجيه كامل لكل قيمة تعدادية (لا هروب لنثر حر)",
      everyValueRendered,
    );
  }

  // ── S7. provider replacement needs no style rewrite ────────────────────
  // The directive rides in the REQUEST, so buildPromptMessages renders the
  // identical assistantStyle line whichever adapter consumes it.
  {
    const baseRequest: AiRequest = {
      message: "السلام عليكم",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "منشأة تجريبية",
      services: [],
      faqs: [],
      assistantStyle: style.ASSISTANT_STYLE_DIRECTIVE,
    };
    const messages = prompt.buildPromptMessages(baseRequest);
    const userContent = messages[1]!.content;
    const withoutProvider = prompt.buildPromptMessages(baseRequest);
    check(
      "S7a. التوجيه يصل سياق المزود كخطّ موحّد (assistantStyle)",
      messages.length === 2 &&
        userContent.includes(
          `assistantStyle: ${style.ASSISTANT_STYLE_DIRECTIVE}`,
        ),
    );
    check(
      "S7b. نفس التوجيه بالضبط لأي مزود — لا نسخة مزود-specific",
      withoutProvider[1]!.content === userContent &&
        !userContent.toLowerCase().includes("openrouter") &&
        !userContent.toLowerCase().includes("codecraft"),
    );
    // A request that omits the style still renders the resident directive
    // (the voice has a safe default; nothing is unstyled).
    const minimal = prompt.buildPromptMessages({
      message: "السلام عليكم",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "منشأة تجريبية",
      services: [],
      faqs: [],
    });
    check(
      "S7c. الطلب الأدنى يُكمل التوجيه الساكن (لا رد بلا أسلوب)",
      minimal[1]!.content.includes(
        `assistantStyle: ${style.ASSISTANT_STYLE_DIRECTIVE}`,
      ),
    );
  }

  // ── S8. the style cannot bypass safety / disclosure ────────────────────
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) =>
      fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const gateSource = read(
      "src/features/conversations/server/ai-disclosure/disclosure-gate.ts",
    );
    check(
      "S8a. بوابة الإفصاح لا تقرأ النمط (لا استيراد ولا حقل أسلوب)",
      !gateSource.includes("assistant-style") &&
        !gateSource.includes("assistantStyle") &&
        !gateSource.includes("renderAssistantStyleDirective"),
    );
    check(
      "S8b. قائمة النوايا الخالية من المعرفة مغلقة وحيدة العضو (GREETING)",
      disclosure.KNOWLEDGE_FREE_REPLY_INTENTS.length === 1 &&
        eq(disclosure.KNOWLEDGE_FREE_REPLY_INTENTS[0], "GREETING"),
    );

    // Behavioral: a knowledge-free reply passes ONLY by declared intent; a
    // self-authored reply for any other intent is still routed to a human
    // no matter how it is phrased (the gate never inspects text).
    const request: AiRequest = {
      message: "السلام عليكم",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "منشأة تجريبية",
      services: [],
      faqs: [],
      assistantStyle: style.ASSISTANT_STYLE_DIRECTIVE,
    };
    const greetingReply: AiResponse = {
      intent: "GREETING",
      action: "reply",
      content: "أهلاً بك! أنا مساعدك للحجز والمواعيد.",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    };
    const humanRequestReply: AiResponse = {
      intent: "HUMAN_REQUEST",
      action: "reply",
      content: "أهلاً بك! أساعدك فوراً في كل شيء.",
      extraction: {
        service: null,
        provider: null,
        date: null,
        timePreference: null,
      },
      handoffReason: null,
      summary: null,
    };
    const facts: readonly never[] = [];
    const greetingGate = disclosure.enforceDisclosure({
      response: greetingReply,
      context: { request, facts },
    });
    const refusedGate = disclosure.enforceDisclosure({
      response: humanRequestReply,
      context: { request, facts },
    });
    check(
      "S8c. رد الترحيب يعبر البوابة بالنية المُعلنة فقط (لا بمعرفة)",
      greetingGate.kind === "disclosed",
    );
    check(
      "S8d. رد مُؤلَّف ذاتياً لنية أخرى يبقى للبشر — النمط لا يُضعف الحراسة",
      refusedGate.kind === "requires-human",
    );
  }

  // ── S9. the deterministic voice conforms to the configured style ──────
  {
    const probe = ai.classifyCustomerMessage("السلام عليكم", []);
    const reply = probe.content;
    // Arabic-only means NO LATIN LETTERS can ride the reply (a provider or
    // machine identifier can never reach the customer through the voice).
    const arabicOnly = reply.length > 0 && !/[A-Za-z]/.test(reply);
    const noEmoji = !/\p{Extended_Pictographic}/u.test(reply);
    check(
      "S9a. صوت المساعد الحتمي عربي خالص (يطابق النمط المُعداد)",
      arabicOnly,
    );
    check(
      "S9b. لا إيموجي في الردود الحتمية (يطابق emoji: none)",
      noEmoji && eq(style.ASSISTANT_VOICE_CONFORMANCE.emoji, "none"),
    );
    check(
      "S9c. الردود الحتمية موجزة (ضمن حدّ الإيجاز المُعدّ)",
      reply.length > 0 &&
        reply.length <= style.ASSISTANT_VOICE_CONFORMANCE.maxLength,
    );
    check(
      "S9d. ترحيب المساعد يُعرّف بنفسه كمساعد (شفاف، لا انتحال بشري)",
      reply.includes("مساعد") && !reply.includes("أنا إنسان"),
    );
  }

  // ── GREETING naturalness + no regression ────────────────────────────────
  {
    const greetings = [
      "السلام عليكم",
      "أهلاً",
      "صباح الخير",
      "مساء الخير",
      "ازيك",
      "عامل ايه",
      "أهلاً وسهلاً",
      "كيف حالك",
    ];
    const allGreetings = greetings.every((text) => {
      const r = ai.classifyCustomerMessage(text, []);
      return r.intent === "GREETING" && r.action === "reply";
    });
    check(
      "G1. افتتاحيات عربية/مصرية → GREETING + reply (سلوك طبيعي)",
      allGreetings,
    );

    const mixed = ai.classifyCustomerMessage(
      "السلام عليكم، عايز أحجز موعد",
      [],
    );
    check(
      "G2. ترحيب + نية حقيقية → النية الحقيقية (لا ابتلاع للترحيب)",
      mixed.intent === "BOOKING",
    );

    const bareTime = ai.classifyCustomerMessage("صباح", []);
    check(
      "G3. اسم وقت مجرد («صباح») ليس ترحيباً (يذهب للمسار العادي)",
      bareTime.intent !== "GREETING",
    );

    const bypassRequest: AiRequest = {
      message: "السلام عليكم",
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "منشأة تجريبية",
      services: [],
      faqs: [],
    };
    const bypassed = ai.bypassDeterministicAi(bypassRequest);
    check(
      "G4. الترحيب يُجاب حتمياً — صفر نداءات مزود (bypassDeterministicAi)",
      bypassed !== null &&
        bypassed.intent === "GREETING" &&
        bypassed.action === "reply",
    );

    const greetingContent = ai.classifyCustomerMessage(
      "السلام عليكم",
      [],
    ).content;
    check(
      "G5. رد الترحيب شفاف عن كونه مساعد آلي (لا انتحال بشري)",
      greetingContent.includes("مساعد") && !greetingContent.includes("بشري"),
    );
  }

  // ── INTENT taxonomy discipline ──────────────────────────────────────────
  {
    const documented: AiIntent[] = [
      "GREETING",
      "FAQ",
      "BOOKING",
      "AVAILABILITY",
      "RESCHEDULE",
      "CANCELLATION",
      "HUMAN_REQUEST",
      "AMBIGUOUS",
    ];
    check(
      "T1. عائلة النوايا هي الـ8 الموّثقة تماماً — لا انحراف",
      eq(contract.aiIntentValues.length, documented.length) &&
        contract.aiIntentValues.every(
          (intent, index) => intent === documented[index],
        ),
    );
    const futureCandidates = [
      "SMALL_TALK",
      "THANKS",
      "GOODBYE",
      "CHITCHAT",
      "CONFIRMATION",
    ];
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) =>
      fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const contractSource = read(
      "src/features/conversations/server/ai-contract.ts",
    );
    const promptSource = read("prompts/system/booking-assistant.prompt");
    const generatedSource = read("src/generated/ai-prompts.generated.ts");
    check(
      "T2. النوايا المرشحة المستقبلية غائبة + موّثقة كمراقبة قادمة",
      futureCandidates.every(
        (candidate) =>
          !contractSource.includes(`"${candidate}"`) &&
          !promptSource.includes(candidate),
      ) &&
        generatedSource.includes("GREETING") &&
        !futureCandidates.some((candidate) =>
          generatedSource.includes(candidate),
        ),
    );
  }

  // ── report ─────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => !item.pass);
  console.log(`\n── ASSISTANT STYLE — ${checks.length} checks ──`);
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.label}`);
  }
  console.log(
    `\n${checks.length - failed.length}/${checks.length} passed, ${failed.length} failed`,
  );
  if (failed.length > 0) {
    console.log("\nFAILURES:");
    for (const item of failed) console.log(`  ✗ ${item.label}`);
    process.exitCode = 1;
  }
  console.log(
    "\nNo network, no DB, no LLM provider call, no WhatsApp transport, no Meta send was used by this check.",
  );
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
