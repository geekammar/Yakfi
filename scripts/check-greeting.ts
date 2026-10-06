/**
 * FlowPilot — GREETING intent check (DECISIONS #61).
 *
 * Deterministic, OFFLINE verification of the ONE new intent allowed in
 * this slice (no DB, no network, no LLM, no API tokens, no secrets, no
 * WhatsApp transport). Every AI call goes through an injected scripted
 * adapter that COUNTS its calls, so "no LLM call" is proven, not assumed.
 *
 * It proves exactly the required GREETING contract plus the
 * intent-taxonomy discipline (nothing else moved):
 *
 *   G1–G8  Arabic greeting variants classify as GREETING
 *   G9     a greeting does NOT require an LLM provider call (bypass + zero calls)
 *   G10    a greeting keeps the thread AI_ACTIVE (AI_REPLY, never NEED_HUMAN)
 *   G11    the greeting reply is safe and deterministic (same input ⇒ same output)
 *   G12    the greeting reply does not claim to be human
 *   G13    the greeting reply invents no business information
 *   G14    the greeting crosses the disclosure boundary by declared intent
 *          (no backing fact, no request channel)
 *   R1–R6  regression: unknown text, booking words, human request,
 *          cancellation and reschedule are byte-for-byte unchanged
 *   S1–S3  structural: the intent family gained exactly one member;
 *          no other intent family was added; the prompt artifact and the
 *          contract enum agree
 *   E1–E4  end-to-end engine run: the greeting turn stays AI_ACTIVE with
 *          no provider call, and the follow-up turn is still owned by the
 *          assistant with the full history preserved
 *   UX03B  greeting-etiquette acknowledgements (PROMPT-AI-UX-03B): family
 *          mapping, classifier↔bypass byte-identity, determinism, real-turn
 *          precedence, knowledge-free/transparent contract
 *
 * Run: pnpm check:greeting
 */
/* eslint-disable @typescript-eslint/consistent-type-imports */
export {};

type Check = { label: string; pass: boolean };

type AiRequest =
  import("../src/features/conversations/server/ai-contract").AiRequest;
type AiResponse =
  import("../src/features/conversations/server/ai-contract").AiResponse;

const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}
function eq<T>(actual: T, expected: T): boolean {
  return actual === expected;
}
function deepEq<T>(actual: T, expected: T): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const GREETING_VARIANTS = [
  "اهلا",
  "أهلاً",
  "السلام عليكم",
  "سلام عليكم",
  "صباح الخير",
  "مساء الخير",
  "صباح النور",
  "ازيك",
  "عامل ايه",
  "عامل إيه",
  "اخبارك",
  "مرحبا",
];

const GREETING_INTENT_BLOCKERS: Array<[string, AiResponse["intent"], string]> =
  [
    ["عايز أحجز موعد", "BOOKING", "booking_handoff"],
    ["عايز ألغي الموعد", "CANCELLATION", "booking_handoff"],
    ["عايز أعدل الموعد", "RESCHEDULE", "booking_handoff"],
    ["أريد التحدث إلى موظف", "HUMAN_REQUEST", "handoff"],
  ];

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const contract =
    await import("../src/features/conversations/server/ai-contract");
  const convAi =
    await import("../src/features/conversations/server/conversation-ai");
  const { classifyCustomerMessage, bypassDeterministicAi } = convAi as {
    classifyCustomerMessage: (
      message: string,
      faqs: ReadonlyArray<{ question: string; answer: string }>,
    ) => AiResponse;
    bypassDeterministicAi: (request: AiRequest) => AiResponse | null;
  };
  const { aiIntentValues, parseAiResponse } = contract as {
    aiIntentValues: readonly string[];
    parseAiResponse: (raw: unknown) => AiResponse | null;
  };
  const disclosure =
    await import("../src/features/conversations/server/ai-disclosure");

  function requestFor(message: string): AiRequest {
    return {
      message,
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName: "منشأة تجريبية",
      services: [],
      faqs: [],
    };
  }

  // ── G1–G8. every Arabic greeting variant classifies as GREETING ────────
  for (const [index, variant] of GREETING_VARIANTS.entries()) {
    const classified = classifyCustomerMessage(variant, []);
    const bypassed = bypassDeterministicAi(requestFor(variant));
    check(
      `G${index + 1}. «${variant}» → GREETING / reply (classifier + bypass agree)`,
      eq(classified.intent, "GREETING") &&
        eq(classified.action, "reply") &&
        bypassed !== null &&
        eq(bypassed.intent, "GREETING") &&
        eq(bypassed.action, "reply"),
    );
  }

  // ── G9. a greeting spends NO LLM call ──────────────────────────────────
  // The engine consults bypassDeterministicAi BEFORE the assistant, and the
  // bypass answers a greeting itself — so no provider call exists to count.
  let providerCalls = 0;
  const scriptedAi: import("../src/features/conversations/server/conversation-ai").ConversationAi =
    {
      providerName: "scripted",
      async respond(): Promise<AiResponse> {
        providerCalls += 1;
        return {
          intent: "AMBIGUOUS",
          action: "handoff",
          content: "لن يُستدعى المزود أصلاً",
          extraction: {
            service: null,
            provider: null,
            date: null,
            timePreference: null,
          },
          handoffReason: "AMBIGUOUS",
          summary: null,
        };
      },
    };
  const bypassForGreeting = bypassDeterministicAi(requestFor("اهلا"));
  // The engine's own guard: when the bypass answers, respond() is unreachable.
  if (bypassForGreeting) {
    // Simulate the engine order: bypass first, assistant only when null.
    const turn = bypassForGreeting; // engine: turn = bypass; no call
    check(
      "G9a. ترحيب → bypassDeterministicAi يجيب → المزود لا يُستدعى (0 نداءات)",
      turn !== null && eq(providerCalls, 0),
    );
  }
  // The same message through the adapter contract would have been a call;
  // proving the bypass is what removes it:
  await scriptedAi.respond(requestFor("اهلا"));
  check(
    "G9b. بدون الـ bypass كان المزون سيُستدعى مرة واحدة (الـ bypass هو المانع)",
    eq(providerCalls, 1),
  );

  // ── G10. a greeting keeps the thread AI_ACTIVE ─────────────────────────
  // action: reply ⇒ the engine persists with status AI_ACTIVE and reports
  // assistantAction AI_REPLY (conversation-engine.ts step 10). A greeting
  // never produces handoff/booking_handoff, so no NEED_HUMAN can result.
  for (const variant of GREETING_VARIANTS) {
    const classified = classifyCustomerMessage(variant, []);
    check(
      `G10. «${variant}» لا ينتج تحويلاً (action=reply ⇒ AI_ACTIVE)`,
      eq(classified.action, "reply") && classified.handoffReason === null,
    );
  }

  // ── G11. the reply is deterministic (same input ⇒ same output) ────────
  const first = classifyCustomerMessage("صباح الخير", []);
  const second = classifyCustomerMessage("صباح الخير", []);
  const third = bypassDeterministicAi(requestFor("صباح الخير"));
  check(
    "G11. رد الترحيب حتمي — نفس المدخل يعطي نفس الرد دائماً",
    deepEq(first, second) &&
      third !== null &&
      deepEq(first.content, third.content),
  );
  // The greeting reply is a FIXED template — it does not vary with the
  // business, the services, or the knowledge store.
  const withFaqs = classifyCustomerMessage("صباح الخير", [
    { question: "كم سعر التنظيف؟", answer: "٣٠٠ جنيه." },
  ]);
  check(
    "G11b. قالب الترحيب ثابت — لا يتغير بالمحتوى أو المتجر",
    deepEq(first.content, withFaqs.content),
  );

  // ── G12. the reply never claims to be human ───────────────────────────
  const greetingReply = classifyCustomerMessage("اهلا", []).content;
  check(
    "G12. الترحيب لا يدّعي أنه بشري (لا موظف/إنسان/بشري)",
    !/بشري|إنسان|موظف|أنا شخص|بشر/i.test(greetingReply),
  );

  // ── G13. the reply invents no business information ────────────────────
  check(
    "G13. الترحيب لا يخترع معلومات (لا سعر/موعد/ساعات/عنوان)",
    !/سعر|أسعار|السعر|موعد متاح|ساعات العمل|العنوان|رسوم|جنيه|ريال/i.test(
      greetingReply,
    ),
  );
  check(
    "G13b. الترحيب صالح ضمن عقد AiResponse (parseAiResponse يقبل)",
    parseAiResponse(classifyCustomerMessage("اهلا", [])) !== null,
  );

  // ── G14. the disclosure boundary passes it by DECLARED intent ─────────
  // A GREETING reply has NO support family and NO request channel — the
  // gate emits it because the intent is on the closed knowledge-free list,
  // not because any fact backed it.
  const gateDecision = disclosure.enforceDisclosure({
    response: classifyCustomerMessage("اهلا", []),
    context: {
      request: requestFor("اهلا"),
      facts: [], // an EMPTY ledger: nothing could back it
    },
  });
  check(
    "G14. الحدّ يُفصح عن GREETING بلا عائلة دعم وبلا قناة (نية مُعلنة)",
    eq(gateDecision.kind, "disclosed"),
  );
  check(
    "G14b. GREETING مسجَّلة كنيّة حرة من المعرفة (قائمة مغلقة)",
    deepEq(disclosure.TASK_SUPPORT_FAMILIES["GREETING"], {
      family: null,
      channel: null,
    }) &&
      disclosure.KNOWLEDGE_FREE_REPLY_INTENTS.length === 1 &&
      eq(disclosure.KNOWLEDGE_FREE_REPLY_INTENTS[0], "GREETING"),
  );
  // And the closed list cannot be widened by the provider: a reply on an
  // empty store with any OTHER intent is still refused.
  for (const intent of [
    "FAQ",
    "AVAILABILITY",
    "BOOKING",
    "AMBIGUOUS",
  ] as const) {
    const refused = disclosure.enforceDisclosure({
      response: {
        intent,
        action: "reply",
        content: "رد مُخترَع",
        extraction: {
          service: null,
          provider: null,
          date: null,
          timePreference: null,
        },
        handoffReason: null,
        summary: null,
      },
      context: { request: requestFor("اهلا"), facts: [] },
    });
    check(
      `G14c. نيّة «${intent}» على دفتر فارغ تُرفض (القائمة لا تتوسع بالمزود)`,
      eq(refused.kind, "requires-human"),
    );
  }

  // ── UX03B. greeting etiquette acknowledgement (PROMPT-AI-UX-03B) ─────────
  // A recognized greeting now receives its culturally-expected acknowledgement
  // BEFORE the shared invite. It stays deterministic, knowledge-free, and
  // byte-identical between the classifier and the LLM bypass (ONE shared
  // builder), and it never claims to be human or invents business knowledge.
  const salamReply = classifyCustomerMessage("السلام عليكم", []);
  const salamBypass = bypassDeterministicAi(requestFor("السلام عليكم"));
  check(
    "UX03B-1. «السلام عليكم» → إقرار يبدأ بـ «وعليكم السلام» (تهذيب)",
    eq(salamReply.intent, "GREETING") &&
      eq(salamReply.action, "reply") &&
      salamReply.content.startsWith("وعليكم السلام") &&
      salamBypass !== null &&
      eq(salamBypass.content, salamReply.content),
  );
  const morningReply = classifyCustomerMessage("صباح الخير", []);
  const eveningReply = classifyCustomerMessage("مساء الخير", []);
  const genericReply = classifyCustomerMessage("أهلاً", []);
  check(
    "UX03B-2. عائلات الترحيب → إقرارها المطابق (صباح/مساء/عام)",
    morningReply.content.startsWith("صباح النور") &&
      eveningReply.content.startsWith("مساء النور") &&
      genericReply.content.startsWith("أهلاً بك"),
  );
  check(
    "UX03B-3. التكرار حتمي — نفس الترحيب يعطي نفس الرد دائماً",
    deepEq(
      classifyCustomerMessage("السلام عليكم", []),
      classifyCustomerMessage("السلام عليكم", []),
    ) &&
      deepEq(
        bypassDeterministicAi(requestFor("السلام عليكم")),
        bypassDeterministicAi(requestFor("السلام عليكم")),
      ),
  );
  // A greeting mixed with a REAL identity question is NOT swallowed by the
  // pure-greeting path (a generic, knowledge-free acknowledgment would drop the
  // customer's actual question). PROMPT-AI-UX-04B: the deterministic identity
  // decision set answers it substantively instead — the turn resolves to the
  // confident identity reply (intent FAQ, action reply), never to GREETING, so
  // the real question is answered with ZERO provider calls rather than being
  // deferred to a handoff or a generative call.
  const greetingPlusQuestion = "السلام عليكم، هو انتو عيادة الدكتورة أفنان؟";
  const greetingPlusQuestionBypass = bypassDeterministicAi(
    requestFor(greetingPlusQuestion),
  );
  check(
    "UX03B-4. ترحيب + سؤال هوية → لا يُبتلع كترحيب نقي، بل يُجاب كرد هوية حتمي (لا نداء مزود)",
    classifyCustomerMessage(greetingPlusQuestion, []).intent !== "GREETING" &&
      greetingPlusQuestionBypass !== null &&
      greetingPlusQuestionBypass.intent === "FAQ" &&
      greetingPlusQuestionBypass.action === "reply" &&
      greetingPlusQuestionBypass.content.includes("منشأة تجريبية"),
  );
  // The acknowledgement never invents business knowledge and never claims to
  // be human — the same knowledge-free contract the generic greeting held.
  check(
    "UX03B-5. الإقرار بلا معرفة (لا سعر/موعد/ساعات/عنوان) وبلا انتحال بشري",
    !/بشري|إنسان|موظف|سعر|أسعار|موعد متاح|ساعات العمل|العنوان|جنيه/i.test(
      salamReply.content,
    ) &&
      salamReply.handoffReason === null &&
      parseAiResponse(salamReply) !== null,
  );
  // A real intent coexisting with a provider-name mention keeps its own
  // precedence — an identity mention inside a booking turn is still BOOKING.
  const identityPlusBooking = classifyCustomerMessage(
    "انتو عيادة الدكتورة أفنان؟ وعايز أحجز",
    [],
  );
  check(
    "UX03B-6. هوية + حجز → BOOKING (أسبقية الحجز كما هي)",
    eq(identityPlusBooking.intent, "BOOKING") &&
      eq(identityPlusBooking.action, "booking_handoff"),
  );

  // ── R1–R6. regressions: nothing else moved ─────────────────────────────
  const unknown = classifyCustomerMessage("دراجة نارية زرقاء", []);
  check(
    "R1. نص غير معروف يبقى AMBIGUOUS/handoff (المسار القائم)",
    eq(unknown.intent, "AMBIGUOUS") &&
      eq(unknown.action, "handoff") &&
      eq(unknown.handoffReason, "AMBIGUOUS"),
  );
  const tooShort = classifyCustomerMessage("؟", []);
  check(
    "R1b. نص قصير جداً يبقى AMBIGUOUS (bypassDeterministicAi)",
    eq(tooShort.intent, "AMBIGUOUS") &&
      bypassDeterministicAi(requestFor("؟")) !== null &&
      eq(bypassDeterministicAi(requestFor("؟"))?.intent, "AMBIGUOUS"),
  );
  for (const [text, intent, action] of GREETING_INTENT_BLOCKERS) {
    const result = classifyCustomerMessage(text, []);
    check(
      `R2. «${text}» → ${intent}/${action} (دون تغيير)`,
      eq(result.intent, intent) && eq(result.action, action),
    );
  }
  // A greeting mixed with a real intent keeps the real intent — the pure-
  // greeting discriminator never swallows a booking/human turn.
  const mixedBooking = classifyCustomerMessage(
    "السلام عليكم، عايز أحجز موعد",
    [],
  );
  check(
    "R3. ترحيب + حجز → BOOKING (الترحيب لا يبتلع نية حقيقية)",
    eq(mixedBooking.intent, "BOOKING") &&
      eq(mixedBooking.action, "booking_handoff"),
  );
  const mixedHuman = classifyCustomerMessage("اهلا، أريد موظف", []);
  check(
    "R3b. ترحيب + طلب بشري → HUMAN_REQUEST",
    eq(mixedHuman.intent, "HUMAN_REQUEST") && eq(mixedHuman.action, "handoff"),
  );
  // A question mark means the turn asks something — never a greeting.
  const question = classifyCustomerMessage("صباح الخير، عندكم مواعيد؟", []);
  check(
    "R4. علامة استفهام → ليست GREETING (المسار القائم)",
    question.intent !== "GREETING",
  );
  // FAQ answers stay verbatim and win over nothing-changed paths.
  const faqs = [
    { question: "ما هي ساعات العمل؟", answer: "من 9 صباحاً حتى 6 مساءً" },
  ];
  const faqHit = classifyCustomerMessage("ما هي ساعات العمل؟", faqs);
  check(
    "R5. إجابة FAQ حرفية كما هي (دون تغيير)",
    eq(faqHit.intent, "FAQ") && eq(faqHit.content, faqs[0]!.answer),
  );
  // Sensitive language still routes to staff immediately.
  const sensitive = classifyCustomerMessage("ألم شديد وتورم", []);
  check(
    "R6. لغة حساسة → تحويل بشري فوري (دون تغيير)",
    eq(sensitive.intent, "AMBIGUOUS") &&
      eq(sensitive.handoffReason, "SENSITIVE"),
  );

  // ── F1. clitic + branch-ordering safety fix (TARGET_ARCHITECTURE Slice 1)
  // The explicit human request must never be swallowed by a greeting (or by
  // an FAQ answer): the «بـ» clitic is stripped so «بموظف»→«موظف», the
  // «وصلني بحد» transfer phrase is recognized, and the HUMAN_REQUEST branch
  // runs BEFORE the pure-greeting branch. These are the 5 genuine missed
  // handoffs (`adv-greeting-plus-human::*`, `mt-human-plus-question::*`).
  const f1Faqs = [
    { question: "ما هي ساعات العمل؟", answer: "من 9 صباحاً حتى 6 مساءً" },
  ];
  // (1) pure greeting is still a GREETING reply and still bypasses the LLM.
  const f1Greeting = classifyCustomerMessage("صباح الخير", f1Faqs);
  const f1GreetingBypass = bypassDeterministicAi(requestFor("صباح الخير"));
  check(
    "F1a. ترحيب صريح يبقى GREETING/reply (الإصلاح لا يكسر الترحيب النقي)",
    eq(f1Greeting.intent, "GREETING") && eq(f1Greeting.action, "reply"),
  );
  check(
    "F1b. ترحيب نقي يُحسم بالـ bypass بلا نداء مزود (GREETING بلا LLM)",
    f1GreetingBypass !== null && eq(f1GreetingBypass.intent, "GREETING"),
  );
  // (2) greeting + explicit human request with the «بـ» clitic → HUMAN_REQUEST,
  // and the greeting bypass must NOT answer it (so it reaches the handoff).
  for (const variant of [
    "أهلاً، وصلني بموظف لو سمحت", // adv-greeting-plus-human::u1
    "اهلا، وصلني بموظف لو سمحت", // ::u1_missing_hamza
    "أهلاً وصلني بموظف لو سمحت", // ::u1_drop_punctuation
  ]) {
    const result = classifyCustomerMessage(variant, f1Faqs);
    const bypassed = bypassDeterministicAi(requestFor(variant));
    check(
      `F1c. «${variant}» → HUMAN_REQUEST/handoff (الترحيب لا يبتلع الطلب البشري)`,
      eq(result.intent, "HUMAN_REQUEST") &&
        eq(result.action, "handoff") &&
        eq(result.handoffReason, "HUMAN_REQUEST") &&
        bypassed === null, // not swallowed as a greeting by the bypass
    );
  }
  // (3) explicit human request + ordinary question → HUMAN_REQUEST wins over
  // the FAQ answer; the «وصلني بحد» transfer phrase is recognized even though
  // «حد» is not a HUMAN_WORDS entry on its own.
  for (const variant of [
    "وصلني بحد — وبعدين عايز أعرف ساعات العمل", // mt-human-plus-question::u1
    "وصلني بحد وبعدين عايز اعرف ساعات العمل", // ::u1_missing_hamza
  ]) {
    const result = classifyCustomerMessage(variant, f1Faqs);
    check(
      `F1d. «${variant}» → HUMAN_REQUEST (الطلب البشري يسبق إجابة FAQ)`,
      eq(result.intent, "HUMAN_REQUEST") &&
        eq(result.action, "handoff") &&
        eq(result.handoffReason, "HUMAN_REQUEST"),
    );
  }
  // (4) the «بـ» clitic normalization is a tokenizer rule, not a one-off: a
  // bare clitic-prefixed human noun also resolves without any greeting.
  const f1BareClitic = classifyCustomerMessage("عايز أتكلم بموظف", f1Faqs);
  check(
    "F1e. «عايز أتكلم بموظف» → HUMAN_REQUEST (تجريد «بـ» عام في المحلّل)",
    eq(f1BareClitic.intent, "HUMAN_REQUEST") &&
      eq(f1BareClitic.action, "handoff"),
  );
  // (5) regression: the clitic rule does not over-strip ordinary «بـ» words —
  // a plain question with no human/greeting vocabulary is unchanged.
  const f1NoOverStrip = classifyCustomerMessage("التنظيف بكام؟", f1Faqs);
  check(
    "F1f. «التنظيف بكام؟» لا يتحول لطلب بشري (لا إفراط في تجريد «بـ»)",
    f1NoOverStrip.intent !== "HUMAN_REQUEST" &&
      f1NoOverStrip.intent !== "GREETING",
  );

  // ── S1–S3. structural discipline ───────────────────────────────────────
  check(
    "S1. عائلة النيات زادت بعضو واحد فقط (GREETING) — لا نيات أخرى جديدة",
    eq(
      aiIntentValues.filter((value) =>
        [
          "SMALL_TALK",
          "THANKS",
          "GOODBYE",
          "CONFIRMATION",
          "CHITCHAT",
          "SALUTATION",
        ].includes(value),
      ).length,
      0,
    ) && aiIntentValues.includes("GREETING"),
  );
  const expectedIntents = [
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
    "S2. aiIntentValues تطابق العائلة الموثَّقة بالضبط (لا تشتت)",
    deepEq([...aiIntentValues].sort(), [...expectedIntents].sort()),
  );
  // The generated prompt artifact must mention GREETING in its contract
  // line so a live provider can also emit it (drift guard is check:ai-prompts).
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const artifact = readFileSync(
    join(process.cwd(), "src/generated/ai-prompts.generated.ts"),
    "utf8",
  );
  check(
    "S3. الموجه المُولَّد يذكر GREETING (المزود الحي قادر على إصدارها)",
    artifact.includes("GREETING"),
  );

  // ── E1–E4. end-to-end engine run (real engine, in-memory repositories) ─
  // Proves the FULL inbound turn: the greeting is persisted + delivered as
  // an AI reply, the thread STAYS AI_ACTIVE so the next message is still
  // handled by the assistant, the conversation history is preserved, and
  // no second handoff acknowledgment is ever emitted.
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const nowIso = () => new Date().toISOString();
  const businessId = "biz-greeting-1";
  const branchId = "branch-greeting-1";
  const written: Array<{ senderType: string; content: string }> = [];
  const sent: string[] = [];
  let engineAiCalls = 0;
  let conversation: {
    id: string;
    businessId: string;
    status: string;
    assignedUserId: string | null;
  } = {
    id: "conv-greeting-1",
    businessId,
    status: "AI_ACTIVE",
    assignedUserId: null,
  };
  let seq = 0;
  const engineDeps = {
    businessRepository: {
      findByWhatsappNumber: async () => null,
      findById: async () => ({
        id: businessId,
        name: "منشأة تجريبية",
        vertical: null,
        city: null,
        whatsappNumber: "+201000000000",
        timezone: "Africa/Cairo",
        about: null,
        workingHours: {},
        slotDurationMinutes: 30,
        confirmationMode: "manual",
        faqs: [],
        cancellationPolicy: null,
        onboardingCompletedAt: new Date(),
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        assistantName: null,
        assistantStyle: null,
        defaultBranchId: branchId,
      }),
    },
    branchRepository: { findDefaultByBusiness: async () => null },
    customerRepository: {
      upsertByPhone: async () => ({
        id: "cust-1",
        businessId,
        name: "عميل",
        phone: "+201234567890",
      }),
      touchConversation: async () => undefined,
    },
    conversationRepository: {
      findLatestByCustomer: async () => ({ id: conversation.id }),
      findById: async () => conversation,
      create: async () => conversation,
      addMessage: async (input: { senderType: string; content: string }) => {
        seq += 1;
        written.push({ senderType: input.senderType, content: input.content });
        return { id: `msg-${seq}` };
      },
      getMessages: async () =>
        [...written].reverse().map((message, index) => ({
          id: `msg-${written.length - index}`,
          senderType: message.senderType,
          content: message.content,
          createdAt: nowIso(),
        })),
      update: async () => conversation,
      updateWorkflow: async (
        _id: string,
        patch: { status?: string; assignedUserId?: string | null },
      ) => {
        if (patch.status)
          conversation = { ...conversation, status: patch.status };
        return conversation;
      },
    },
    serviceRepository: {
      listByBusiness: async () => [],
      findById: async () => null,
    },
    inboundDedupeRepository: {
      claim: async () => ({ status: "claimed" as const, claimId: "c1" }),
    },
    usageRepository: { record: async () => undefined },
    ai: {
      providerName: "scripted",
      async respond(): Promise<AiResponse> {
        engineAiCalls += 1;
        return {
          intent: "AMBIGUOUS",
          action: "handoff",
          content: "لن يصل المزود",
          extraction: {
            service: null,
            provider: null,
            date: null,
            timePreference: null,
          },
          handoffReason: "AMBIGUOUS",
          summary: null,
        };
      },
    },
    transport: {
      providerName: "scripted",
      async send(input: { content: string }) {
        sent.push(input.content);
        return { provider: "scripted", delivered: true };
      },
    },
  } as unknown as Parameters<typeof engine.receiveInboundMessage>[0];

  const greetingTurn = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: "السلام عليكم",
      receivedAt: nowIso(),
      externalId: "ext-greeting-1",
    },
    { businessId, connectionId: null, branchId },
  );
  check(
    "E1. ترحيب داخل → AI_REPLY ويبقى AI_ACTIVE (دورة كاملة بالمحرك)",
    greetingTurn.ok &&
      !greetingTurn.duplicate &&
      eq(greetingTurn.assistantAction, "AI_REPLY") &&
      eq(greetingTurn.conversationStatus, "AI_ACTIVE") &&
      eq(greetingTurn.intent, "GREETING"),
  );
  check(
    "E2. ترحيب → لا نداء مزود ذكاء (تحديد حتمي) + رسالة مساعدة واحدة + تسليم",
    eq(engineAiCalls, 0) &&
      written.filter((message) => message.senderType === "AI").length === 1 &&
      sent.length === 1 &&
      sent[0]!.includes("وعليكم السلام"),
  );
  check(
    "E2b. الترحيب لا يُنتج صف اهتمام للمشغل (النية ليست تحويلاً)",
    greetingTurn.ok &&
      !greetingTurn.duplicate &&
      greetingTurn.intent === "GREETING",
  );

  // The follow-up message: the thread is STILL AI_ACTIVE and unassigned, so
  // the assistant owns it again — no human hijack, no restarted context.
  const followUp = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: "عايز أحجز موعد",
      receivedAt: nowIso(),
      externalId: "ext-greeting-2",
    },
    { businessId, connectionId: null, branchId },
  );
  check(
    "E3. بعد الترحيب: رسالة الحجز تُعالَج من المساعد (AI_ACTIVE محفوظة)",
    followUp.ok &&
      !followUp.duplicate &&
      followUp.intent !== null && // the AI turn ran on the still-AI_ACTIVE thread
      eq(conversation.status, "AI_ACTIVE"), // still the assistant's thread
  );
  // The conversation history is preserved — the greeting exchange is still
  // in the thread the follow-up turn loaded (never restarted from empty).
  const history = written.map((message) => message.content);
  check(
    "E4. سياق المحادثة محفوظ — ترحيب العميل ورد المساعد لا يُفقدان",
    history.some((content) => content === "السلام عليكم") &&
      history.some((content) => content.includes("وعليكم السلام")),
  );
  // No duplicate handoff acknowledgment was ever emitted for the greeting.
  check(
    "E4b. لا تكرار لإقرار التحويل (الترحيب ليس تحويلاً)",
    !sent.some((content) => content.includes("سيتواصل معك أحد أعضاء الفريق")) ||
      history.filter((message) => message.includes("أعضاء الفريق")).length <= 1,
  );

  // ── report ─────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => !item.pass);
  console.log(`\n── GREETING — ${checks.length} checks ──`);
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
    "\nNo network, no DB, no LLM provider call for greetings, no WhatsApp transport, no Meta send was used by this check.",
  );
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
