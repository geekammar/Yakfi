/**
 * FlowPilot — BUSINESS IDENTITY deterministic reply check (PROMPT-AI-UX-04B).
 *
 * Deterministic, OFFLINE verification of the smallest correct architectural
 * fix for the proven business-identity failure (PROMPT-AI-UX-04A forensics):
 * a direct identity question was answered by the LLM, which authored
 * hedge/handoff wording («الاسم المسجّل عندي هو…»), and no downstream layer
 * rewrites provider text. The fix answers the turn on the EXISTING
 * deterministic seam (`bypassDeterministicAi`) BEFORE any provider is
 * consulted, from the ONE authoritative fact the turn is about
 * (`AiRequest.businessName`), so the turn ends with a fixed, confident,
 * Egyptian-natural reply and ZERO provider calls.
 *
 * No DB, no network, no LLM, no API tokens, no secrets, no WhatsApp
 * transport. Every AI call goes through an injected scripted adapter that
 * COUNTS its calls, so "zero provider calls" is proven, not assumed.
 *
 *   I1–I8    the deterministic identity decision set + reply contract
 *            (I2b/I2c the ≤200-char bound; I8 the customer may ASSERT
 *            unsupported attributes the reply never affirms)
 *   M1–M8    the multi-intent rule: a mixed turn is never swallowed
 *   D1–D2    the disclosure boundary backs it from business.identity and the
 *            backstop for non-identity turns stays intact
 *   J1       the conservative JEV strategy inherits the decision (0 divergence)
 *   E1–E9    end-to-end engine run: real engine, in-memory repositories
 *            (E6/E7 a REPEATED pure identity turn stays deterministic and
 *            single-send; E8/E9 a Resume-AI round trip after a human takeover)
 *   X1–X3    an UNPROVEN business identity (no stored name) fails safe and
 *            leaks no business name (the identity-seam half of tenant isolation)
 *   R1–R6    regression: greeting / booking / human / sensitive / unknown /
 *            FAQ turns are behaviorally unchanged
 *
 * Run: pnpm check:business-identity
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

/** The authoritative business name used across the checks. */
const BUSINESS_NAME = "عيادة الدكتورة أفنان للأسنان";

/** The one expected customer-facing reply for the canonical turn. */
const EXPECTED_REPLY = `أيوه، ${BUSINESS_NAME} معاك. تحب نساعدك إزاي؟`;

/** Pure identity questions (no other task vocabulary). */
const PURE_IDENTITY_QUESTIONS = [
  "هو انتو عيادة الدكتورة أفنان؟",
  "هو انتو عيادة الدكتور أحمد؟",
  "انتو مين؟",
  "ما اسم العيادة؟",
  "السلام عليكم، هو انتو عيادة الدكتورة أفنان؟",
  "هو انتو عيادة الدكتورة أفنان",
  "ما اسمكم؟",
];

/**
 * Turns that ALSO arm another TaskRelevance family — the deterministic
 * identity branch must YIELD so the existing generative multi-intent path
 * owns them (confirm the identity AND continue the other task).
 *
 * Note on phrasing: the relevance derivation strips the Egyptian «و»
 * conjunction ONLY for the price family, so a mixed turn is written here with
 * the second task un-prefixed (e.g. «العنوان فين؟», not «والعنوان فين؟») —
 * the derivation recognizes it that way, which is what this rule is about.
 */
const MIXED_TURNS = [
  "هو انتو عيادة الدكتورة أفنان؟ وعايز أحجز بكرة",
  "انتو مين؟ وبكام التنظيف؟",
  "ما اسم العيادة؟ وايه الخدمات اللي عندكم؟",
  "انتو مين؟ العنوان فين؟",
  "ما اسمكم؟ احكيلي عن العيادة",
  "هو انتو عيادة الدكتورة أفنان؟ التنظيف بيشمل ايه؟",
];

/**
 * A colloquial identity ask that ALSO arms `providerChoice` through a
 * high-precision false positive: «إيه» matches the provider-choice word
 * «أي». The spec lists providerChoice among the families the identity branch
 * must yield to (a bare provider title is a provider-identity/preference
 * concern), so this turn deliberately stays on the generative path rather than
 * risk answering a provider-choice turn as a pure identity confirmation. The
 * provider prompt's identity instruction (UX-04B) still keeps that turn
 * confident when the model answers it.
 */
const PROVIDER_CHOICE_OVERLAP_IDENTITY = ["إيه اسم العيادة؟", "إيه اسمك؟"];

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
  const { bypassDeterministicAi, classifyCustomerMessage } = convAi as {
    bypassDeterministicAi: (request: AiRequest) => AiResponse | null;
    classifyCustomerMessage: (
      message: string,
      faqs: ReadonlyArray<{ question: string; answer: string }>,
    ) => AiResponse;
  };
  const { parseAiResponse } = contract as {
    parseAiResponse: (raw: unknown) => AiResponse | null;
  };
  const disclosure =
    await import("../src/features/conversations/server/ai-disclosure");
  const contextBuilder =
    await import("../src/features/conversations/server/ai-context-builder");
  const jev = await import("../src/server/integrations/ai/jev-strategy");

  function requestFor(
    message: string,
    businessName = BUSINESS_NAME,
  ): AiRequest {
    return {
      message,
      conversationStatus: "AI_ACTIVE",
      recentMessages: [],
      businessName,
      services: [],
      faqs: [],
    };
  }

  // ── I1. every pure identity question → deterministic FAQ/reply ──────────
  for (const [index, message] of PURE_IDENTITY_QUESTIONS.entries()) {
    const bypassed = bypassDeterministicAi(requestFor(message));
    check(
      `I1-${index + 1}. «${message}» → FAQ/reply حتمي من اسم المنشأة`,
      bypassed !== null &&
        eq(bypassed.intent, "FAQ") &&
        eq(bypassed.action, "reply") &&
        eq(bypassed.content, EXPECTED_REPLY) &&
        bypassed.handoffReason === null &&
        bypassed.summary === null,
    );
  }

  // ── I2. the canonical example produces EXACTLY the expected reply ───────
  const canonical = bypassDeterministicAi(
    requestFor("هو انتو عيادة الدكتورة أفنان؟"),
  );
  check(
    "I2. المثال الأساسي → الرد المتوقَّع حرفياً (أيوه + الاسم معاك + دعوة)",
    canonical !== null && eq(canonical.content, EXPECTED_REPLY),
  );

  // ── I2b. the reply is a SHORT, concise customer-visible message ──────────
  // The fixed template (name + short invite) can never grow into a paragraph.
  check(
    "I2b. رد الهوية موجز ضمن الحد الأقصى (٢٠٠ حرف)",
    canonical !== null && canonical.content.length <= 200,
  );
  // The bound holds for EVERY contract-valid name: a business name may be up
  // to 120 chars (aiRequestSchema), and the fixed part is a short prefix +
  // invite — so the whole reply stays under the bound even in the worst case.
  const longestName = "أ".repeat(120);
  const longestReply = bypassDeterministicAi(
    requestFor("انتو مين؟", longestName),
  );
  check(
    "I2c. أطول اسم مسموح (١٢٠ حرف) → الرد لا يزال ≤ ٢٠٠ حرف (الحد ثابت)",
    longestReply !== null && longestReply.content.length <= 200,
  );

  // ── I3. determinism: same input ⇒ same output (never varies) ────────────
  check(
    "I3. حتمي — نفس السؤال يعطي نفس الرد دائماً (لا يتغير بالمزود/الكتالوج/المعرفة)",
    deepEq(
      bypassDeterministicAi(requestFor("انتو مين؟")),
      bypassDeterministicAi(requestFor("انتو مين؟")),
    ) &&
      deepEq(
        bypassDeterministicAi(requestFor("انتو مين؟", BUSINESS_NAME))?.content,
        bypassDeterministicAi(requestFor("انتو مين؟", BUSINESS_NAME))?.content,
      ),
  );
  // The template is FIXED: it does not change with the catalog or the store.
  const withCatalogAndFaqs = bypassDeterministicAi({
    ...requestFor("انتو مين؟"),
    services: [{ name: "تنظيف أسنان", price: "٣٠٠ جنيه" }],
    faqs: [{ question: "مواعيد العمل", answer: "من 9 حتى 6" }],
  });
  check(
    "I3b. القالب ثابت — لا يتغير بوجود كتالوج أو معرفة مخزنة",
    withCatalogAndFaqs !== null &&
      eq(withCatalogAndFaqs.content, EXPECTED_REPLY),
  );

  // ── I4. the reply is a valid contract response the engine can persist ───
  check(
    "I4. الرد صالح ضمن عقد AiResponse (parseAiResponse يقبله)",
    canonical !== null && parseAiResponse(canonical) !== null,
  );

  // ── I5. the reply states ONLY the authoritative name (nothing invented) ─
  // It names no owner, specialty, license, accreditation, hours, price,
  // location or legal/official status the business did not store.
  check(
    "I5. الرد يذكر اسم المنشأة المعتمد فقط (بلا اختراع)",
    canonical !== null &&
      canonical.content.includes(BUSINESS_NAME) &&
      !/تخصص|ترخيص|معتمد|اعتماد|ساعات العمل|من 9|جنيه|العنوان|فرع|مواعيد/i.test(
        canonical.content,
      ),
  );

  // ── I6. the banned hedge/disclaimer wording NEVER appears ───────────────
  const banned = [
    "الاسم المسجل",
    "المسجل",
    "المسجَّل",
    "مخزن",
    "مخزَّن",
    "بحسب البيانات",
    "البيانات الموجودة",
    "تأكيد رسمي",
    "لا أستطيع التأكد",
    "لا استطيع التأكد",
    "جارٍ تحويلك",
    "جاري تحويلك",
    "تواصل مع الفريق للتأكيد",
    "الكيان",
    "السجل",
    "رسمي",
    "قانوني",
  ];
  check(
    "I6. لا صياغة تحوّط/تحذير/قاعدة/سجل/قانونية في رد الهوية (ممنوعة)",
    canonical !== null &&
      banned.every((word) => !canonical.content.includes(word)),
  );
  check(
    "I6b. الرد لا يدّعي أنه بشري (لا موظف/إنسان/بشري)",
    canonical !== null &&
      !/بشري|إنسان|موظف|أنا شخص|بشر/i.test(canonical.content),
  );

  // ── I8. the customer ASSERTS unsupported identity attributes ────────────
  // The turn stays a PURE identity ask (it arms no other task family), so the
  // deterministic reply still ships — and because that copy is the FIXED
  // template built from the stored name ONLY, it can never affirm an
  // attribute the business did not store. No license, specialty, board
  // accreditation, branch, owner or official status is confirmed: the
  // asserted words simply do not appear in the reply (spec case 6).
  const ASSERTED_ATTRIBUTE_TURNS = [
    "هو انتو عيادة الدكتورة أفنان المرخّصة من نقابة أطباء الأسنان؟",
    "هو انتو عيادة الدكتورة أفنان المتخصّصة في زراعة الأسنان ومعتمدة دولياً؟",
  ];
  const ASSERTED_ATTRIBUTE_WORDS = [
    "مرخّصة",
    "مرخصة",
    "نقابة",
    "متخصّصة",
    "متخصصة",
    "معتمدة",
    "دولياً",
    "زراعة",
    "ترخيص",
    "اعتماد",
  ];
  for (const [index, message] of ASSERTED_ATTRIBUTE_TURNS.entries()) {
    const asserted = bypassDeterministicAi(requestFor(message));
    check(
      `I8-${index + 1}. «${message}» → رد حتمي يؤكد الاسم فقط (لا يقرّ السمات غير المدعومة)`,
      asserted !== null &&
        asserted.content.includes(BUSINESS_NAME) &&
        ASSERTED_ATTRIBUTE_WORDS.every(
          (word) => !asserted.content.includes(word),
        ),
    );
  }

  // ── I7. a missing authoritative name yields to the existing safe path ───
  // The branch NEVER invents a name: with an empty businessName the bypass
  // returns null and the existing NO_KNOWLEDGE handoff owns the turn.
  check(
    "I7. اسم المنشأة فارغ ⇒ الـ bypass يرجع null (لا اختراع اسم — المسار الآمن)",
    bypassDeterministicAi(requestFor("انتو مين؟", "")) === null &&
      bypassDeterministicAi(requestFor("ما اسم العيادة؟", "   ")) === null,
  );
  // And the existing safe classification for an identity ask with no name is a
  // knowledge-gap handoff (unchanged behavior).
  const noKnowledge = classifyCustomerMessage("انتو مين؟", []);
  check(
    "I7b. غياب الاسم يُبقي المسار القائم (NO_KNOWLEDGE تحويل بشري)",
    eq(noKnowledge.action, "handoff") &&
      eq(noKnowledge.handoffReason, "NO_KNOWLEDGE"),
  );

  // ── M1–M6. the multi-intent rule: a mixed turn is never swallowed ───────
  for (const [index, message] of MIXED_TURNS.entries()) {
    const bypassed = bypassDeterministicAi(requestFor(message));
    check(
      `M${index + 1}. «${message}» → ليس سؤال هوية نقي (يبقى للمسار التوليدي متعدد النوايا)`,
      bypassed === null,
    );
  }
  // A pure booking turn is not identity either.
  check(
    "M7. «عايز أحجز موعد» → ليس رد هوية (أسبقية الحجز)",
    bypassDeterministicAi(requestFor("عايز أحجز موعد")) === null,
  );

  // The documented providerChoice overlap: a colloquial «إيه» identity ask
  // arms providerChoice, so the identity branch yields by design.
  for (const [index, message] of PROVIDER_CHOICE_OVERLAP_IDENTITY.entries()) {
    check(
      `M8-${index + 1}. «${message}» → يبقى للمسار التوليدي (providerChoice مسلَّحة بـ«إيه» — استسلام وفق المواصفات)`,
      bypassDeterministicAi(requestFor(message)) === null,
    );
  }

  // ── D1. the disclosure gate backs the reply from business.identity ──────
  // Built with an EMPTY FAQ store and no other channel, so the name family is
  // the ONLY possible support — exactly the backstop the gate consults.
  {
    const built = contextBuilder.buildAiContext({
      scope: { businessId: "biz-identity-1" },
      sources: {
        business: {
          name: BUSINESS_NAME,
          faqs: [],
          about: null,
        },
        services: [],
        conversation: { status: "AI_ACTIVE", recentMessages: [] },
        message: "هو انتو عيادة الدكتورة أفنان؟",
      },
    });
    const identityRecord = built.facts.find(
      (fact: { key: string }) => fact.key === "business.identity",
    );
    const decision = disclosure.enforceDisclosure({
      response: canonical as AiResponse,
      context: { request: built.request, facts: built.facts },
    });
    check(
      "D1. البوّابة تُفصح عن رد الهوية من عائلة business.identity (مخزن أسئلة فارغ)",
      identityRecord?.included === true &&
        identityRecord?.disclosable === true &&
        eq(decision.kind, "disclosed") &&
        eq(
          decision.kind === "disclosed" ? decision.support[0] : undefined,
          "business.identity",
        ),
    );
    check(
      "D1b. سؤال الهوية النقي يحمل الاسم في الطلب (القناة الوحيدة الكافية)",
      eq(built.request.businessName, BUSINESS_NAME),
    );
  }

  // ── D2. the backstop: the name cannot back a NON-identity reply ─────────
  // The name is carried for phrasing on every turn, but the identity family is
  // armed ONLY on an identity ask — so the deterministic branch never fires on
  // another question and the gate still refuses an unbacked reply there.
  {
    const built = contextBuilder.buildAiContext({
      scope: { businessId: "biz-identity-2" },
      sources: {
        business: { name: BUSINESS_NAME, faqs: [], about: null },
        services: [],
        conversation: { status: "AI_ACTIVE", recentMessages: [] },
        message: "بكام التنظيف؟",
      },
    });
    const identityRecord = built.facts.find(
      (fact: { key: string }) => fact.key === "business.identity",
    );
    check(
      "D2. دور غير الهوية لا يُسلّح العائلة (الحماية كما هي) والـ bypass لا يُطلق",
      identityRecord?.included === false &&
        identityRecord?.omissionReason === "OUTSIDE_CONTEXT_BUDGET" &&
        built.request.businessName === BUSINESS_NAME &&
        bypassDeterministicAi(requestFor("بكام التنظيف؟")) === null,
    );
  }

  // ── J1. the conservative JEV strategy inherits the decision (0 divergence)
  // The strategy's deterministic set IS the bypass set, so it terminates the
  // identity turn with the SAME complete response — the seam agreement that
  // keeps the gateway and the engine's fast path from ever diverging.
  {
    const strategy = jev.createConservativeJevStrategy();
    const corpus = [
      "هو انتو عيادة الدكتورة أفنان؟",
      "انتو مين؟",
      "ما اسم العيادة؟",
      "السلام عليكم",
      "م",
      "ما مواعيد العمل؟",
      "عايز أحجز موعد",
      "أريد التحدث إلى موظف",
      "عندي ألم شديد وعايز أحجز",
    ];
    let divergence = 0;
    for (const message of corpus) {
      const request = requestFor(message);
      const proven = bypassDeterministicAi(request);
      const decision = strategy.decide(request);
      const terminates = decision.mode === "DETERMINISTIC";
      if (proven === null && terminates) divergence += 1;
      if (proven !== null && !terminates) divergence += 1;
      if (
        proven !== null &&
        terminates &&
        decision.response !== null &&
        (decision.response.intent !== proven.intent ||
          decision.response.action !== proven.action ||
          decision.response.content !== proven.content ||
          decision.response.handoffReason !== proven.handoffReason)
      )
        divergence += 1;
    }
    check(
      `J1. استراتيجية JEV المحافِظة تطابق مجموعة الـ bypass (0 انحراف على ${corpus.length} رسائل)`,
      divergence === 0,
    );
    const identityDecision = strategy.decide(
      requestFor("هو انتو عيادة الدكتورة أفنان؟"),
    );
    check(
      "J1b. سؤال الهوية يُحسم حتمياً عند البوابة بلا نداء مزود (يرث القرار)",
      identityDecision.mode === "DETERMINISTIC" &&
        identityDecision.response !== null &&
        eq(identityDecision.response.content, EXPECTED_REPLY),
    );
  }

  // ── E1–E5. end-to-end engine run (real engine, in-memory repositories) ──
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const nowIso = () => new Date().toISOString();
  const businessId = "biz-identity-e2e";
  const branchId = "branch-identity-e2e";
  const written: Array<{ senderType: string; content: string }> = [];
  const sent: string[] = [];
  let engineAiCalls = 0;
  let conversation: {
    id: string;
    businessId: string;
    status: string;
    assignedUserId: string | null;
  } = {
    id: "conv-identity-e2e",
    businessId,
    status: "AI_ACTIVE",
    assignedUserId: null,
  };
  let seq = 0;
  /**
   * The canonical Business record for the engine runs, parameterized by name:
   * the unproven-identity scenario (X-series) needs a business that stored NO
   * authoritative name, everything else stays identical.
   */
  const businessRecord = (name: string) => ({
    id: businessId,
    name,
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
  });
  const engineDeps = {
    businessRepository: {
      findByWhatsappNumber: async () => null,
      findById: async () => businessRecord(BUSINESS_NAME),
    },
    branchRepository: { findDefaultByBusiness: async () => null },
    customerRepository: {
      upsertByPhone: async () => ({
        id: "cust-identity-1",
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
        conversation = {
          ...conversation,
          status: patch.status ?? conversation.status,
          assignedUserId:
            patch.assignedUserId === undefined
              ? conversation.assignedUserId
              : patch.assignedUserId,
        };
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
          content: "لن يصل المزود على دور الهوية",
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

  const identityTurn = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: "هو انتو عيادة الدكتورة أفنان؟",
      receivedAt: nowIso(),
      externalId: "ext-identity-1",
    },
    { businessId, connectionId: null, branchId },
  );
  check(
    "E1. سؤال هوية داخل → AI_REPLY ويبقى AI_ACTIVE (نية FAQ من المسار الحتمي)",
    identityTurn.ok &&
      !identityTurn.duplicate &&
      eq(identityTurn.assistantAction, "AI_REPLY") &&
      eq(identityTurn.conversationStatus, "AI_ACTIVE") &&
      eq(identityTurn.intent, "FAQ") &&
      identityTurn.handoffCause === null,
  );
  check(
    "E2. صفر نداءات مزود + رسالة مساعدة واحدة + التسليم يحمل الرد الواثق بالاسم",
    eq(engineAiCalls, 0) &&
      written.filter((message) => message.senderType === "AI").length === 1 &&
      sent.length === 1 &&
      eq(sent[0], EXPECTED_REPLY),
  );
  check(
    "E2b. الرد خالي من أي صياغة تحوّط/قاعدة/سجل (العقد السلوكي للمسار الحتمي)",
    sent.length === 1 &&
      banned.every((word) => !sent[0]!.includes(word)) &&
      !/سيتواصل معك أحد أعضاء الفريق/.test(sent[0]!),
  );

  // A mixed identity+booking turn DOES consult the provider (multi-intent path
  // owns it) — the deterministic branch never swallows a real second task.
  const mixedTurn = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: "هو انتو عيادة الدكتورة أفنان؟ وعايز أحجز بكرة",
      receivedAt: nowIso(),
      externalId: "ext-identity-2",
    },
    { businessId, connectionId: null, branchId },
  );
  check(
    "E3. هوية + حجز → يُستشار المزود (المسار متعدد النوايا يملكه — لا ابتلاع)",
    mixedTurn.ok && !mixedTurn.duplicate && eq(engineAiCalls, 1),
  );

  // The thread is STILL AI_ACTIVE and unassigned after the identity turn, so
  // the assistant owns the next message — no human hijack.
  check(
    "E4. بعد رد الهوية: المحادثة تبقى AI_ACTIVE (المساعد يملك الدور التالي)",
    eq(conversation.status, "AI_ACTIVE") &&
      conversation.assignedUserId === null,
  );
  // And the identity exchange is preserved in history.
  check(
    "E5. سياق المحادثة محفوظ — سؤال العميل ورد المساعد لا يُفقدان",
    written.some(
      (message) => message.content === "هو انتو عيادة الدكتورة أفنان؟",
    ) && written.some((message) => message.content === EXPECTED_REPLY),
  );

  // ── E6/E7. a REPEATED pure identity turn stays deterministic + single-send ─
  // The seam is pure: the same identity question again produces the SAME
  // confident reply, still ZERO provider calls, still exactly ONE
  // customer-visible message, and the thread stays AI_ACTIVE so the assistant
  // owns the next turn (spec case 7). No duplicate send, no escalation.
  const callsBeforeRepeat = engineAiCalls;
  const aiWrittenBeforeRepeat = written.filter(
    (message) => message.senderType === "AI",
  ).length;
  const sentBeforeRepeat = sent.length;
  const repeatTurn = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: "انتو مين؟",
      receivedAt: nowIso(),
      externalId: "ext-identity-repeat",
    },
    { businessId, connectionId: null, branchId },
  );
  check(
    "E6. تكرار سؤال هوية → FAQ/reply حتمي (نفس القالب، لا تحويل)",
    repeatTurn.ok &&
      !repeatTurn.duplicate &&
      eq(repeatTurn.intent, "FAQ") &&
      eq(repeatTurn.assistantAction, "AI_REPLY") &&
      repeatTurn.handoffCause === null,
  );
  check(
    "E7. التكرار: صفر نداءات إضافية + رسالة واحدة فقط + AI_ACTIVE + نفس الرد",
    eq(engineAiCalls, callsBeforeRepeat) &&
      eq(
        written.filter((message) => message.senderType === "AI").length,
        aiWrittenBeforeRepeat + 1,
      ) &&
      eq(sent.length, sentBeforeRepeat + 1) &&
      eq(sent[sent.length - 1], EXPECTED_REPLY) &&
      eq(conversation.status, "AI_ACTIVE") &&
      conversation.assignedUserId === null,
  );

  // ── E8/E9. Resume AI after a human takeover still answers identity ───────
  // The deterministic identity reply keeps the thread AI_ACTIVE and unassigned
  // (E4), so the EXISTING Resume-AI control restores the assistant after a
  // human takeover and the identity turn is answered deterministically AGAIN —
  // the seam never strands the thread in a handoff (spec case 9).
  await engineDeps.conversationRepository.updateWorkflow(conversation.id, {
    status: "NEED_HUMAN",
    assignedUserId: "staff-identity-1",
  });
  check(
    "E8a. الاستيلاء البشري → NEED_HUMAN + ملكية (التحويل القائم)",
    eq(conversation.status, "NEED_HUMAN") &&
      eq(conversation.assignedUserId, "staff-identity-1"),
  );
  await engineDeps.conversationRepository.updateWorkflow(conversation.id, {
    status: "AI_ACTIVE",
    assignedUserId: null,
  });
  check(
    "E8b. Resume AI → AI_ACTIVE + لا ملكية (الاستئناف القائم)",
    eq(conversation.status, "AI_ACTIVE") &&
      eq(conversation.assignedUserId, null),
  );
  const callsBeforeResume = engineAiCalls;
  const resumedIdentity = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: "ما اسم العيادة؟",
      receivedAt: nowIso(),
      externalId: "ext-identity-resume",
    },
    { businessId, connectionId: null, branchId },
  );
  check(
    "E8c. بعد Resume AI: سؤال هوية → FAQ/reply حتمي + صفر نداءات + AI_ACTIVE",
    resumedIdentity.ok &&
      !resumedIdentity.duplicate &&
      eq(resumedIdentity.intent, "FAQ") &&
      eq(resumedIdentity.assistantAction, "AI_REPLY") &&
      eq(engineAiCalls, callsBeforeResume) &&
      eq(conversation.status, "AI_ACTIVE"),
  );
  // The assistant still owns an ORDINARY turn after resume (no human hijack).
  const resumedGreeting = await engine.receiveInboundMessage(
    engineDeps,
    {
      to: "+201000000000",
      from: "+201234567890",
      text: "السلام عليكم",
      receivedAt: nowIso(),
      externalId: "ext-identity-resume-2",
    },
    { businessId, connectionId: null, branchId },
  );
  check(
    "E9. بعد Resume AI: ترحيب → GREETING/reply حتمي (المساعد يملك الدور التالي)",
    resumedGreeting.ok &&
      !resumedGreeting.duplicate &&
      eq(resumedGreeting.intent, "GREETING") &&
      eq(resumedGreeting.assistantAction, "AI_REPLY") &&
      eq(engineAiCalls, callsBeforeResume) &&
      eq(conversation.status, "AI_ACTIVE"),
  );

  // ── X1–X3. an UNPROVEN business identity fails safe and leaks nothing ────
  // The deterministic seam never invents a name and never leaks ANOTHER
  // business's name: when the business stored no authoritative name, the
  // identity branch yields (proven at the seam in I7), the turn falls through
  // to the EXISTING safe path, and the customer-visible reply carries NO
  // business name at all. This is the identity-seam half of tenant isolation;
  // the other half (another business's data never reaching the request) is
  // proven by check:ai-readiness (spec case 8).
  {
    let unnamedAiCalls = 0;
    const unnamedSent: string[] = [];
    // A contract-following provider: on an identity ask with NO authoritative
    // name it hands off with NO_KNOWLEDGE (booking-assistant.prompt) instead
    // of inventing one — the safe path is exercised exactly as production.
    const unnamedDeps = {
      ...engineDeps,
      businessRepository: {
        ...engineDeps.businessRepository,
        findById: async () => businessRecord(""),
      },
      ai: {
        providerName: "scripted-contract",
        async respond(): Promise<AiResponse> {
          unnamedAiCalls += 1;
          return {
            intent: "AMBIGUOUS",
            action: "handoff",
            content: "شكراً لسؤالك — سيرد عليك أحد أعضاء الفريق قريباً.",
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            handoffReason: "NO_KNOWLEDGE",
            summary: null,
          };
        },
      },
      transport: {
        providerName: "scripted",
        async send(input: { content: string }) {
          unnamedSent.push(input.content);
          return { provider: "scripted", delivered: true };
        },
      },
    } as unknown as Parameters<typeof engine.receiveInboundMessage>[0];
    const unnamedTurn = await engine.receiveInboundMessage(
      unnamedDeps,
      {
        to: "+201000000000",
        from: "+201234567890",
        text: "انتو مين؟",
        receivedAt: nowIso(),
        externalId: "ext-identity-unnamed",
      },
      { businessId, connectionId: null, branchId },
    );
    check(
      "X1. اسم غير مُثبَت → الفرع الحتمي يستسلم ويُستشار المزود (لا ابتكاع اسم)",
      unnamedTurn.ok &&
        !unnamedTurn.duplicate &&
        eq(unnamedAiCalls, 1) &&
        bypassDeterministicAi(requestFor("انتو مين؟", "")) === null,
    );
    check(
      "X2. اسم غير مُثبَت → تحويل بشري آمن (NO_KNOWLEDGE) بلا سبب طلب العميل",
      unnamedTurn.ok &&
        !unnamedTurn.duplicate &&
        eq(unnamedTurn.assistantAction, "AI_HANDOFF") &&
        eq(unnamedTurn.conversationStatus, "NEED_HUMAN") &&
        unnamedTurn.handoffCause !== null &&
        unnamedTurn.handoffCause !== "CUSTOMER_REQUESTED_HUMAN",
    );
    check(
      "X3. اسم غير مُثبَت → لا اسم مُسرَّب ولا قالب هوية في رد العميل",
      eq(unnamedSent.length, 1) &&
        !unnamedSent[0]!.includes("أفنان") &&
        !unnamedSent[0]!.includes("معاك"),
    );
  }

  // ── R1–R6. regressions: nothing else moved ──────────────────────────────
  const greeting = bypassDeterministicAi(requestFor("السلام عليكم"));
  check(
    "R1. تحية نقي → GREETING/reply كما هو (لا يتأثر بفرع الهوية)",
    greeting !== null &&
      eq(greeting.intent, "GREETING") &&
      eq(greeting.action, "reply"),
  );
  check(
    "R2. نص قصير جداً → AMBIGUOUS/handoff (bypassDeterministicAi)",
    bypassDeterministicAi(requestFor("؟"))?.intent === "AMBIGUOUS",
  );
  const booking = classifyCustomerMessage("عايز أحجز موعد", []);
  check(
    "R3. حجز → BOOKING/booking_handoff كما هو",
    eq(booking.intent, "BOOKING") && eq(booking.action, "booking_handoff"),
  );
  const human = classifyCustomerMessage("أريد التحدث إلى موظف", []);
  check(
    "R4. طلب بشري → HUMAN_REQUEST/handoff كما هو",
    eq(human.intent, "HUMAN_REQUEST") && eq(human.action, "handoff"),
  );
  const sensitive = classifyCustomerMessage("ألم شديد وتورم", []);
  check(
    "R5. لغة حساسة → تحويل بشري فوري كما هو",
    eq(sensitive.handoffReason, "SENSITIVE"),
  );
  const faqs = [
    { question: "ما هي ساعات العمل؟", answer: "من 9 صباحاً حتى 6 مساءً" },
  ];
  const faqHit = classifyCustomerMessage("ما هي ساعات العمل؟", faqs);
  check(
    "R6. إجابة FAQ حرفية كما هي (فرع الهوية لا يمسّها)",
    eq(faqHit.intent, "FAQ") && eq(faqHit.content, faqs[0]!.answer),
  );

  // ── report ─────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => !item.pass);
  console.log(
    `\n── BUSINESS IDENTITY (PROMPT-AI-UX-04B) — ${checks.length} checks ──`,
  );
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
    "\nNo network, no DB, no LLM provider call for pure identity turns, no WhatsApp transport, no Meta send was used by this check.",
  );
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
