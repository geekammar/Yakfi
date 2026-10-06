/**
 * FlowPilot — BUSINESS IDENTITY generative-path check (PROMPT-AI-UX-04B-2).
 *
 * The companion of `check-business-identity.ts` (PROMPT-AI-UX-04B-1, the
 * deterministic zero-call seam). 04B-1 proved that a PURE identity question
 * with an authoritative stored name is answered BEFORE any provider is
 * consulted. This check covers the RESIDUAL surface 04B-2 targets: the
 * identity turns that DO NOT qualify for that seam and therefore reach the
 * generative LLM path —
 *
 *   • a colloquial identity ask that ALSO arms `providerChoice`
 *     («إيه اسم العيادة؟» — «إيه» matches the provider-choice word «أي»),
 *   • a MIXED turn (identity + booking / price / service-detail …), which the
 *     multi-intent rule deliberately keeps on the generative path,
 *   • a turn whose business stored NO authoritative name (nothing to confirm),
 *
 * — and proves the PROMPT change (the obligation-shaped instruction in
 * prompts/system/booking-assistant.prompt) makes those generative turns land
 * correctly, backed by the existing structural disclosure boundary.
 *
 * DEFENCE IN DEPTH — where each behavioural rule is enforced (binding):
 *
 *   PROMPT layer  the instruction is obligation-shaped (CONFIRM, state the
 *     name plainly and confidently, invite to continue), authorizes confident
 *     natural phrasing, and — critically — does NOT enumerate the hedge /
 *     disclaimer phrases, because listing «الاسم المسجل عندي هو» in the
 *     prompt primes the model to reproduce it. Pinning the instruction is the
 *     ONLY place a "no disclaimer / no invented attribute" guarantee can live
 *     for a generative turn: the disclosure gate is STRUCTURAL (it never reads
 *     or scores reply text — check-ai-disclosure proves that invariant), so it
 *     can detect an UNBACKED TASK (a price answer with no price channel) but
 *     never a hedge inside a backed identity reply.
 *
 *   STRUCTURAL layer  the disclosure gate still owns the backstop:
 *     - an identity reply on an identity-armed turn is backed by
 *       `business.identity` and disclosed;
 *     - a PRICE reply is STILL governed by its own `service.price` channel —
 *       arming `businessIdentity` never arms the price family, so identity
 *       does NOT authorize a price answer (spec case 4);
 *     - a missing name leaves the channel empty → requires-human;
 *     - another tenant's record cannot back an identity reply (UNPROVEN_TENANT).
 *
 *   ENGINE layer  the real engine with in-memory repositories and a
 *     CONTRACT-FOLLOWING scripted provider (it returns exactly what the
 *     rewritten prompt instructs a compliant model to return): exactly ONE
 *     provider call per turn, exactly ONE customer-visible send, answer-and-
 *     continue for a mixed identity+booking turn, and no pathological loop on
 *     a repeated identity question.
 *
 * No DB, no network, no real LLM, no API tokens, no secrets. The provider is
 * an injected scripted adapter that COUNTS its calls, so "exactly one call"
 * is proven, not assumed.
 *
 *   G1  a pure identity ask that reaches the LLM (providerChoice overlap)
 *        → intent FAQ, action reply, no handoff, one call, one send
 *   G2  a DIFFERENT customer wording is answered from the canonical name
 *        (the prompt forbids treating it as unanswerable; the reply that ships
 *        carries the canonical businessName and no disclaimer)
 *   G3  identity + booking → the identity is answered and the BOOKING goal
 *        continues (answer-and-continue, one send, one call)
 *   G4  identity + price → identity does NOT authorize a price answer; price
 *        stays on its own channel (refused with no price, disclosed from
 *        service.price with one)
 *   G5  identity + an unsupported owner/specialty/license ASSERTION → the name
 *        may be confirmed; the unsupported attribute has no channel to lean on
 *        (businessAbout is not even carried on an identity ask) and the prompt
 *        forbids inferring it
 *   G6  missing businessName → the safe fallback stays intact (handoff, and
 *        nothing is invented)
 *   G7  cross-tenant businessName → safe failure stays intact (the foreign name
 *        is not even carried; the gate refuses)
 *   G8  greeting + identity → exactly ONE coherent reply, no double send, and
 *        the identity precedence stays correct (a real question is never
 *        swallowed by the greeting path)
 *   G9  a REPEATED identity question → no pathological loop (still one call +
 *        one send per turn, still AI_REPLY, still AI_ACTIVE)
 *
 * Run: pnpm check:business-identity-generative
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

/** The canonical Business.name used across the generative checks. */
const BUSINESS_NAME = "عيادة الدكتورة أفنان";
const TENANT_A = "biz-gen-aaaaaaaaaaaaaaaaaaaa";
const TENANT_B = "biz-gen-bbbbbbbbbbbbbbbbbbbb";

/**
 * The phrases the rewritten prompt must NOT enumerate and a compliant reply
 * must never carry (the UX-04A failure mode: the model hedged by quoting the
 * registry). Asserted ABSENT from the shipped reply, never used as policy
 * input — the disclosure gate stays structural.
 */
const BANNED_REPLY_WORDS = [
  "الاسم المسجل",
  "المسجل",
  "المسجَّل",
  "مخزن",
  "بحسب البيانات",
  "البيانات الموجودة",
  "تأكيد رسمي",
  "لا أستطيع التأكد",
  "لا استطيع التأكد",
  "جارٍ تحويلك",
  "جاري تحويلك",
  "تواصل مع الفريق للتأكيد",
  "السجل",
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
  const contextBuilder =
    await import("../src/features/conversations/server/ai-context-builder");
  const disclosure =
    await import("../src/features/conversations/server/ai-disclosure");
  const { bypassDeterministicAi } = convAi as {
    bypassDeterministicAi: (request: AiRequest) => AiResponse | null;
  };
  const { parseAiResponse } = contract as {
    parseAiResponse: (raw: unknown) => AiResponse | null;
  };
  type BuiltContext = ReturnType<typeof contextBuilder.buildAiContext>;
  type ContextSources = Parameters<
    (typeof contextBuilder)["buildAiContext"]
  >[0]["sources"];

  function emptyExtraction() {
    return { service: null, provider: null, date: null, timePreference: null };
  }

  /** A contract-following identity reply — what the rewritten prompt directs. */
  function identityReply(name = BUSINESS_NAME): AiResponse {
    return {
      intent: "FAQ",
      action: "reply",
      content: `نعم، ${name} معاك. تحب نساعدك إزاي؟`,
      extraction: emptyExtraction(),
      handoffReason: null,
      summary: null,
    };
  }

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

  // ── SETUP: the real engine, in-memory repositories, scripted provider ─────
  const engine =
    await import("../src/features/conversations/server/conversation-engine");
  const nowIso = () => new Date().toISOString();
  const businessId = "biz-gen-e2e";
  const branchId = "branch-gen-e2e";

  /**
   * A factory, not a singleton: every scenario group gets a FRESH engine
   * state so turn counters and message history cannot leak across groups
   * (G9's repetition, G8's single-send and G3's continuation each need a
   * clean ledger).
   */
  function makeHarness(options: {
    businessName?: string;
    services?: ContextSources["services"];
  }) {
    const name = options.businessName ?? BUSINESS_NAME;
    const services = options.services ?? [];
    const written: Array<{ senderType: string; content: string }> = [];
    const sent: string[] = [];
    let aiCalls = 0;
    let conversation: {
      id: string;
      businessId: string;
      status: string;
      assignedUserId: string | null;
    } = {
      id: "conv-gen-e2e",
      businessId,
      status: "AI_ACTIVE",
      assignedUserId: null,
    };
    let seq = 0;
    /**
     * The scripted provider plays a CONTRACT-FOLLOWING model: it returns
     * exactly what the rewritten prompt instructs for the turn it is handed.
     * The responder is swapped per scenario; the harness always COUNTS the
     * call so "exactly one provider call" is an assertion, not an assumption.
     */
    let responder: (message: string) => AiResponse = () => identityReply();

    const businessRecord = {
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
      faqs: [] as Array<{ question: string; answer: string }>,
      cancellationPolicy: null,
      onboardingCompletedAt: new Date(),
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
      assistantName: null,
      assistantStyle: null,
      defaultBranchId: branchId,
    };

    const deps = {
      businessRepository: {
        findByWhatsappNumber: async () => null,
        findById: async () => businessRecord,
      },
      branchRepository: { findDefaultByBusiness: async () => null },
      customerRepository: {
        upsertByPhone: async () => ({
          id: "cust-gen-1",
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
          written.push({
            senderType: input.senderType,
            content: input.content,
          });
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
        listByBusiness: async () => services,
        findById: async () => null,
      },
      inboundDedupeRepository: {
        claim: async () => ({ status: "claimed" as const, claimId: "c1" }),
      },
      usageRepository: { record: async () => undefined },
      ai: {
        providerName: "scripted-contract",
        async respond(request: AiRequest): Promise<AiResponse> {
          aiCalls += 1;
          return responder(request.message);
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

    async function runTurn(text: string, externalId: string) {
      const result = await engine.receiveInboundMessage(
        deps,
        {
          to: "+201000000000",
          from: "+201234567890",
          text,
          receivedAt: nowIso(),
          externalId,
        },
        { businessId, connectionId: null, branchId },
      );
      return result as {
        ok: boolean;
        duplicate: boolean;
        assistantAction: string;
        intent: string | null;
        /**
         * The engine's AUTHORITATIVE reported status for the turn. The
         * in-memory `conversation` snapshot lags the final transition in some
         * handoff paths, so every status assertion reads THIS field (the same
         * field check-conversation-ops-25 / check-business-identity assert).
         */
        conversationStatus: string;
        handoffCause: string | null;
      };
    }

    return {
      setResponder(next: (message: string) => AiResponse) {
        responder = next;
      },
      runTurn,
      snapshot: () => ({
        aiCalls,
        written: [...written],
        sent: [...sent],
        status: conversation.status,
        assignedUserId: conversation.assignedUserId,
      }),
    };
  }

  // ===========================================================================
  // G1. a pure identity ask that REACHES THE LLM → FAQ / reply / no handoff
  // ===========================================================================
  // «إيه اسم العيادة؟» arms providerChoice (the colloquial «إيه» matches the
  // provider-choice word «أي»), so `isPureBusinessIdentityQuestion` yields by
  // design and the turn is owned by the generative path. The rewritten prompt
  // must make that generative turn a confident identity answer — not a handoff.
  const G1_MESSAGE = "إيه اسم العيادة؟";
  {
    const bypassed = bypassDeterministicAi(requestFor(G1_MESSAGE));
    check(
      "G1a. «إيه اسم العيادة؟» يصل المزود (providerChoice مسلَّحة — ليس الفرع الحتمي)",
      bypassed === null,
    );

    const h = makeHarness({});
    const result = await h.runTurn(G1_MESSAGE, "gen-g1");
    const snap = h.snapshot();
    const aiWritten = snap.written.filter((m) => m.senderType === "AI");
    check(
      "G1b. سؤال هوية على المسار التوليدي → FAQ / reply (لا تحويل)",
      result.ok &&
        !result.duplicate &&
        eq(result.assistantAction, "AI_REPLY") &&
        eq(result.intent, "FAQ") &&
        result.handoffCause === null &&
        eq(snap.status, "AI_ACTIVE"),
    );
    check(
      "G1c. نداء مزود واحد بالضبط + رسالة عميل واحدة (لا إرسال مزدوج)",
      eq(snap.aiCalls, 1) && aiWritten.length === 1 && eq(snap.sent.length, 1),
    );
    check(
      "G1d. الرد يحمل الاسم المعتمد ويدعو للاستكمال (الصيغة الواثقة)",
      snap.sent.length === 1 &&
        snap.sent[0]!.includes(BUSINESS_NAME) &&
        snap.sent[0]!.includes("تحب نساعدك"),
    );
    check(
      "G1e. الرد خالٍ من صياغات التحذير/السجل (ناتج الموجه المُعاد كتابته)",
      snap.sent.length === 1 &&
        BANNED_REPLY_WORDS.every((word) => !snap.sent[0]!.includes(word)),
    );
  }

  // ===========================================================================
  // G2. a DIFFERENT customer wording → still answered from the canonical name
  // ===========================================================================
  // The customer's wording differs from the stored name. The prompt forbids
  // treating that as unanswerable: the model states the authoritative name
  // naturally and stops there. The reply that ships carries the CANONICAL
  // businessName (never the customer's variant as the business's own fact).
  {
    const h = makeHarness({});
    h.setResponder(() => ({
      intent: "FAQ",
      action: "reply",
      content: `إحنا ${BUSINESS_NAME}. تحب نساعدك إزاي؟`,
      extraction: emptyExtraction(),
      handoffReason: null,
      summary: null,
    }));
    const result = await h.runTurn("إيه اسمك؟", "gen-g2");
    const snap = h.snapshot();
    check(
      "G2a. صياغة مختلفة → FAQ / reply (لا تحويل لاختلاف اللفظ)",
      result.ok &&
        eq(result.assistantAction, "AI_REPLY") &&
        eq(result.intent, "FAQ") &&
        result.handoffCause === null,
    );
    check(
      "G2b. الرد يؤكد الاسم القانوني المعتمد (ولا يتبنى صياغة العميل كحقيقة)",
      snap.sent.length === 1 && snap.sent[0]!.includes(BUSINESS_NAME),
    );
    check(
      "G2c. لا ادعاء هوية غير مدعوم في الرد المُرسل",
      snap.sent.length === 1 &&
        !/مرخّصة|مرخصة|نقابة|معتمدة|تخصص|متخصّصة/i.test(snap.sent[0]!),
    );
    check(
      "G2d. الرد صالح ضمن عقد AiResponse (يقبله parseAiResponse)",
      parseAiResponse(identityReply()) !== null,
    );
  }

  // ===========================================================================
  // G3. identity + booking → the identity is answered, the BOOKING continues
  // ===========================================================================
  // A mixed turn is deliberately NOT swallowed by the deterministic seam
  // (M-series in check-business-identity). The generative path must answer the
  // answerable identity goal THIS turn and keep the booking goal pending —
  // answer-and-continue, exactly one send, exactly one call.
  const G3_MESSAGE = "هو انتو عيادة الدكتورة أفنان؟ وعايز أحجز بكرة";
  {
    const bypassed = bypassDeterministicAi(requestFor(G3_MESSAGE));
    check(
      "G3a. هوية + حجز → ليس فرعاً حتمياً (يبقى للمسار متعدد النوايا)",
      bypassed === null,
    );

    const h = makeHarness({});
    h.setResponder(
      () =>
        ({
          intent: "FAQ",
          action: "reply",
          content: `نعم، ${BUSINESS_NAME} معاك.`,
          extraction: emptyExtraction(),
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
        }) as AiResponse,
    );
    const result = await h.runTurn(G3_MESSAGE, "gen-g3");
    const snap = h.snapshot();
    const aiWritten = snap.written.filter((m) => m.senderType === "AI");
    check(
      "G3b. الإجابة عن الهوية صدرت (AI_REPLY / FAQ) والحجز لا يزال معلَّقاً",
      result.ok &&
        eq(result.assistantAction, "AI_REPLY") &&
        eq(result.intent, "FAQ") &&
        eq(snap.status, "AI_ACTIVE") &&
        result.handoffCause === null,
    );
    check(
      "G3c. رسالة AI واحدة فقط + نداء واحد فقط (لا إرسال مزدوج للحجز)",
      eq(snap.aiCalls, 1) && aiWritten.length === 1 && eq(snap.sent.length, 1),
    );
    check(
      "G3d. الرد يحمل إجابة الهوية والاسم المعتمد",
      snap.sent.length === 1 && snap.sent[0]!.includes(BUSINESS_NAME),
    );
  }

  // ===========================================================================
  // G4. identity + price → identity does NOT authorize a price answer
  // ===========================================================================
  // The load-bearing structural guarantee for a mixed identity+price turn:
  // arming `businessIdentity` arms ONLY the name family. A PRICE answer still
  // needs its OWN `service.price` channel — absent → the gate refuses an
  // unbacked price; present → the price reply is disclosed from `service.price`
  // (never from `business.identity`). Identity relevance never becomes price
  // permission.
  function gateFor(input: {
    message: string;
    reply: AiResponse;
    services?: ContextSources["services"];
    businessName?: string;
    scope?: string;
  }): BuiltContext & {
    decision: ReturnType<typeof disclosure.enforceDisclosure>;
  } {
    const built = contextBuilder.buildAiContext({
      scope: { businessId: input.scope ?? TENANT_A },
      sources: {
        business: {
          name: input.businessName ?? BUSINESS_NAME,
          faqs: [],
          about: null,
        },
        services: input.services ?? [],
        conversation: { status: "AI_ACTIVE", recentMessages: [] },
        message: input.message,
      },
    });
    const decision = disclosure.enforceDisclosure({
      response: input.reply,
      context: { request: built.request, facts: built.facts },
    });
    return { ...built, decision };
  }

  const G4_MESSAGE = "انتو مين؟ وبكام التنظيف؟";
  const pricedService: ContextSources["services"][number] = {
    id: "svc-gen-clean",
    businessId: TENANT_A,
    name: "تنظيف الأسنان",
    description: null,
    durationMinutes: 30,
    priceType: "FIXED",
    priceAmount: 300,
    priceCurrency: "EGP",
    priceNote: null,
    priceMaxAmount: null,
  };
  const unpricedService: ContextSources["services"][number] = {
    ...pricedService,
    id: "svc-gen-clean-noprice",
    priceType: null,
    priceAmount: null,
    priceCurrency: null,
  };
  {
    const identityArmed = gateFor({
      message: G4_MESSAGE,
      reply: identityReply(),
      services: [unpricedService],
    });
    const identityRecord = identityArmed.facts.find(
      (fact: { key: string }) => fact.key === "business.identity",
    );
    check(
      "G4a. دور الهوية+السعر يُسلّح عائلة الاسم فقط (السعر على قناته)",
      identityRecord?.included === true &&
        identityRecord?.disclosable === true &&
        eq(identityArmed.request.businessName, BUSINESS_NAME),
    );
    check(
      "G4b. رد الهوية على دور مختلط → مُفصح عنه من business.identity",
      identityArmed.decision.kind === "disclosed" &&
        eq(
          identityArmed.decision.kind === "disclosed"
            ? identityArmed.decision.support[0]
            : undefined,
          "business.identity",
        ),
    );

    // A price reply with NO stored price must still be refused on a
    // PRICE-ONLY turn: the identity family cannot back a price answer there
    // (it is not even armed). That is the structural backstop that keeps a
    // generative price answer unauthorized without its own channel.
    const priceOnlyNoPrice = gateFor({
      message: "بكام التنظيف؟",
      reply: {
        intent: "FAQ",
        action: "reply",
        content: "سعر التنظيف ٣٠٠ جنيه.",
        extraction: emptyExtraction(),
        handoffReason: null,
        summary: null,
      },
      services: [unpricedService],
    });
    check(
      "G4c. رد سعر بلا سعر مخزن على دور سعر نقي → مرفوض (الهوية لا تُجيز الإجابة عن السعر)",
      priceOnlyNoPrice.decision.kind === "requires-human" &&
        !priceOnlyNoPrice.request.services.some(
          (service: { price?: string | null }) =>
            typeof service.price === "string" &&
            service.price.trim().length > 0,
        ),
    );
    // And the identity family is NOT armed on a price-only turn, so the name
    // channel can never back that price reply either.
    check(
      "G4c2. دور السعر النقي لا يُسلّح عائلة الاسم (لا يمكنها تسنيد رد السعر)",
      priceOnlyNoPrice.facts.find(
        (fact: { key: string }) => fact.key === "business.identity",
      )?.included === false,
    );

    // With a stored price, the price reply is disclosed — but from
    // `service.price`, its OWN channel. That is price's own support path.
    const backedPrice = gateFor({
      message: G4_MESSAGE,
      reply: {
        intent: "FAQ",
        action: "reply",
        content: "سعر التنظيف 300 جنيه.",
        extraction: emptyExtraction(),
        handoffReason: null,
        summary: null,
      },
      services: [pricedService],
    });
    check(
      "G4d. رد السعر مع سعر مخزن → مُفصح عنه من service.price (قناة السعر الخاصة)",
      backedPrice.decision.kind === "disclosed" &&
        eq(
          backedPrice.decision.kind === "disclosed"
            ? backedPrice.decision.support[0]
            : undefined,
          "service.price",
        ) &&
        backedPrice.request.services.some(
          (service: { price?: string | null }) =>
            typeof service.price === "string" &&
            service.price.trim().length > 0,
        ),
    );

    // E2E: the contract-following model answers the identity and hands the
    // price gap to a human (NO_KNOWLEDGE — the price path owns its own gap).
    const h = makeHarness({ services: [unpricedService] });
    h.setResponder(
      () =>
        ({
          intent: "FAQ",
          action: "handoff",
          content: `نعم، ${BUSINESS_NAME} معاك.`,
          extraction: emptyExtraction(),
          handoffReason: "NO_KNOWLEDGE",
          summary: null,
        }) as AiResponse,
    );
    const result = await h.runTurn(G4_MESSAGE, "gen-g4");
    const snap = h.snapshot();
    check(
      "G4e. المحرك: هوية + سعر غير مخزن → تحويل آمن (لا اختراع سعر)",
      result.ok &&
        eq(result.assistantAction, "AI_HANDOFF") &&
        eq(result.conversationStatus, "NEED_HUMAN") &&
        eq(snap.aiCalls, 1),
    );
    check(
      "G4f. لا سعر مُرسَل إلى العميل (الثبات الهيكلي للسعر)",
      snap.sent.length === 1 && !/\d+\s*جنيه|سعر/i.test(snap.sent[0]!),
    );
  }

  // ===========================================================================
  // G5. identity + an unsupported owner/specialty/license ASSERTION
  // ===========================================================================
  // The customer ASSERTS attributes the business never stored. The name may
  // still be confirmed; the asserted attribute must not be affirmed. The
  // guarantee is enforced at the prompt layer (the instruction confines the
  // identity reply to the name and routes an absent attribute to its own
  // stored-value rule or NO_KNOWLEDGE) and structurally: an identity ask
  // carries NO `businessAbout` channel, so there is nothing descriptive to
  // quote — and the reply ships unchanged through the structural gate.
  const G5_MESSAGE = "إيه اسم العيادة؟ وانتو مرخّصين من نقابة أطباء الأسنان؟";
  {
    const built = gateFor({ message: G5_MESSAGE, reply: identityReply() });
    check(
      "G5a. سؤال الهوية لا يحمل قناة «عن المنشأة» (لا وصف للاقتباس منه)",
      built.request.businessAbout === undefined,
    );
    check(
      "G5b. رد الاسم وحده مدعوم من business.identity (قناة الاسم فقط)",
      built.decision.kind === "disclosed" &&
        eq(
          built.decision.kind === "disclosed"
            ? built.decision.support[0]
            : undefined,
          "business.identity",
        ),
    );

    // E2E: a contract-following model confirms the name and does NOT affirm
    // the asserted license — exactly the behaviour the rewritten prompt
    // directs. The shipped reply carries the name, not the attribute.
    const h = makeHarness({});
    h.setResponder(() => identityReply());
    const result = await h.runTurn(G5_MESSAGE, "gen-g5");
    const snap = h.snapshot();
    check(
      "G5c. الاسم مؤكَّد (FAQ / reply) والسمة غير المؤكَّدة غير مُقرَّة في الرد",
      result.ok &&
        eq(result.assistantAction, "AI_REPLY") &&
        eq(snap.sent.length, 1) &&
        snap.sent[0]!.includes(BUSINESS_NAME) &&
        !/مرخّصة|مرخصة|نقابة|معتمدة/i.test(snap.sent[0]!),
    );
  }

  // ===========================================================================
  // G6. missing businessName → the safe fallback stays intact
  // ===========================================================================
  // No authoritative name → the deterministic seam yields (nothing to confirm
  // from) and the generative path must NOT invent one. The structural channel
  // is empty, so the gate refuses any identity reply; a contract-following
  // model hands off with NO_KNOWLEDGE and no name is ever shipped.
  {
    const emptyName = gateFor({
      message: "إيه اسم العيادة؟",
      reply: identityReply("عيادة مفترضة"),
      businessName: "",
    });
    check(
      "G6a. اسم غائب ⇒ القناة فارغة ⇒ البوابة ترفض رد الهوية (لا اختراع)",
      emptyName.decision.kind === "requires-human" &&
        eq(emptyName.request.businessName, ""),
    );
    check(
      "G6b. الفرع الحتمي يستسلم أيضاً عند غياب الاسم (لا اختراع اسم)",
      bypassDeterministicAi(requestFor("إيه اسم العيادة؟", "")) === null,
    );

    const h = makeHarness({ businessName: "" });
    h.setResponder(
      () =>
        ({
          intent: "AMBIGUOUS",
          action: "handoff",
          content: "سيرد عليك أحد أعضاء الفريق قريباً.",
          extraction: emptyExtraction(),
          handoffReason: "NO_KNOWLEDGE",
          summary: null,
        }) as AiResponse,
    );
    const result = await h.runTurn("إيه اسم العيادة؟", "gen-g6");
    const snap = h.snapshot();
    check(
      "G6c. المحرك: اسم غائب → تحويل بشري آمن (لا قالب هوية، لا اسم مُرسَل)",
      result.ok &&
        eq(result.assistantAction, "AI_HANDOFF") &&
        eq(result.conversationStatus, "NEED_HUMAN") &&
        eq(snap.aiCalls, 1) &&
        snap.sent.length === 1 &&
        !snap.sent[0]!.includes("معاك"),
    );
  }

  // ===========================================================================
  // G7. cross-tenant businessName → the safe failure stays intact
  // ===========================================================================
  // Another Business's record is UNPROVEN against this turn's scope, so its
  // name is not even carried into the request — the identity reply has no
  // channel and the gate refuses (EXCLUDED_FROM_CONTEXT / UNPROVEN_TENANT).
  {
    const cross = contextBuilder.buildAiContext({
      scope: { businessId: TENANT_A },
      sources: {
        business: {
          name: BUSINESS_NAME,
          faqs: [],
          about: null,
          businessId: TENANT_B,
        },
        services: [],
        conversation: { status: "AI_ACTIVE", recentMessages: [] },
        message: "إيه اسم العيادة؟",
      },
    });
    const crossDecision = disclosure.enforceDisclosure({
      response: identityReply(),
      context: { request: cross.request, facts: cross.facts },
    });
    check(
      "G7a. سجل منشأة أخرى لا يصل الطلب (لا اسم محمول — عزل المستأجرين)",
      eq(cross.request.businessName, ""),
    );
    check(
      "G7b. رد الهوية من مستأجر آخر → مرفوض (فشل آمن يبقى سليماً)",
      crossDecision.kind === "requires-human",
    );
  }

  // ===========================================================================
  // G8. greeting + identity → exactly ONE coherent reply, no double send
  // ===========================================================================
  // Precedence: a social opening paired with a REAL identity question is never
  // swallowed by the pure-greeting path (the generic acknowledgement would drop
  // the customer's question). The identity answer is what ships — one AI
  // message, one send — whether the deterministic seam owns it or the
  // generative path does.
  {
    // Deterministic seam: a canonical greeting + identity question.
    const det = bypassDeterministicAi(
      requestFor("السلام عليكم، هو انتو عيادة الدكتورة أفنان؟"),
    );
    check(
      "G8a. تحية + هوية → ليست تحية نقي (السؤال الحقيقي لا يُبتلع)",
      det !== null &&
        eq(det.intent, "FAQ") &&
        eq(det.action, "reply") &&
        det.content.includes(BUSINESS_NAME),
    );

    // Generative: the greeting + a providerChoice-armed identity ask reaches
    // the LLM and still yields exactly ONE coherent reply.
    const h = makeHarness({});
    const GENERATIVE_GREETING_IDENTITY = "أهلاً، إيه اسم العيادة؟";
    check(
      "G8b. تحية + هوية (صيغة توليدية) تصل المزود",
      bypassDeterministicAi(requestFor(GENERATIVE_GREETING_IDENTITY)) === null,
    );
    const result = await h.runTurn(GENERATIVE_GREETING_IDENTITY, "gen-g8");
    const snap = h.snapshot();
    const aiWritten = snap.written.filter((m) => m.senderType === "AI");
    check(
      "G8c. تحية + هوية → رد واحد فقط (لا إرسال مزدوج) + AI_REPLY",
      result.ok &&
        eq(result.assistantAction, "AI_REPLY") &&
        eq(aiWritten.length, 1) &&
        eq(snap.sent.length, 1) &&
        eq(snap.aiCalls, 1),
    );
    check(
      "G8d. الرد الواحد يجيب الهوية (أسبقية الهوية على التحية)",
      snap.sent.length === 1 && snap.sent[0]!.includes(BUSINESS_NAME),
    );
  }

  // ===========================================================================
  // G9. a REPEATED identity question → no pathological loop
  // ===========================================================================
  // The reported failure was a repeated false handoff. A repeated generative
  // identity turn must stay a normal answered turn: still exactly one call +
  // one send per occurrence, still AI_REPLY, still AI_ACTIVE, never escalating
  // and never looping.
  {
    const h = makeHarness({});
    const REPEAT = "إيه اسم العيادة؟";
    const first = await h.runTurn(REPEAT, "gen-g9-a");
    const afterFirst = h.snapshot();
    const second = await h.runTurn(REPEAT, "gen-g9-b");
    const afterSecond = h.snapshot();
    check(
      "G9a. التكرار ١ → AI_REPLY / FAQ + نداء واحد + رسالة واحدة + AI_ACTIVE",
      first.ok &&
        eq(first.assistantAction, "AI_REPLY") &&
        eq(first.intent, "FAQ") &&
        eq(afterFirst.aiCalls, 1) &&
        afterFirst.sent.length === 1 &&
        eq(afterFirst.status, "AI_ACTIVE"),
    );
    check(
      "G9b. التكرار ٢ → لا تصعيد، لا حلقة مرضية (نداءان فقط، رسالتان فقط)",
      second.ok &&
        eq(second.assistantAction, "AI_REPLY") &&
        eq(second.intent, "FAQ") &&
        eq(afterSecond.aiCalls, 2) &&
        eq(afterSecond.sent.length, 2) &&
        eq(afterSecond.status, "AI_ACTIVE") &&
        afterSecond.assignedUserId === null &&
        second.handoffCause === null,
    );
    check(
      "G9c. كل رد يجيب الهوية بالاسم المعتمد (نفس الصيغة الواثقة)",
      afterSecond.sent.every(
        (content) =>
          content.includes(BUSINESS_NAME) && content.includes("تحب نساعدك"),
      ),
    );
  }

  // ── report ─────────────────────────────────────────────────────────────
  const failed = checks.filter((item) => !item.pass);
  console.log(
    `\n── BUSINESS IDENTITY — GENERATIVE PATH (PROMPT-AI-UX-04B-2) — ${checks.length} checks ──`,
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
    "\nNo real LLM was called: the provider is a scripted contract-following adapter; the checks pin the prompt contract, the structural disclosure boundary and the engine's turn authority.",
  );
}

main().catch((error: Error) => {
  console.error(`check crashed: ${error.message}`);
  console.error(error.stack ?? "");
  process.exit(1);
});
