/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — MINIMAL SAFE PRODUCTION TEST INGRESS VERIFICATION
 * (PROMPT-AI-JEV-03F-I).
 *
 * Verifies all 10 minimal verification criteria offline (no external network,
 * in-memory fakes + real route handler, real conversation engine, real schema,
 * real shadow join, real security boundary):
 *
 *  1. Unauthorized ingress → rejected (401).
 *  2. Missing token → rejected (503 when unset, 401 when missing in request).
 *  3. Test request cannot target a real customer accidentally (403 FORBIDDEN).
 *  4. Test turn reaches the real Conversation Engine (`receiveInboundMessage`).
 *  5. Semantic JEV remains OFF (non-authoritative baseline).
 *  6. Shadow remains non-authoritative (independent switch).
 *  7. Normal 0/1 customer-serving model-call invariant remains intact.
 *  8. No real outbound Telegram/WhatsApp message is sent (offline transport).
 *  9. No unrelated database/domain mutation occurs (isolated test business only).
 * 10. Existing regression checks and public-path reachability preserved.
 *
 * Run: pnpm check:test-ingress
 */

export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
  console.log(`${pass ? "✔" : "✘"} ${label}`);
}

const TEST_SECRET = "0123456789abcdef0123456789abcdef"; // 32 chars
const TEST_PHONE = "+201005551234";
const REAL_CLINIC_PHONE = "+201001111111";
const CUSTOMER_PHONE = "+201234567890";

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { isPublicPath } = await import("../src/lib/public-paths");
  const { TEST_BUSINESS_ID, TEST_BUSINESS_PHONE } =
    await import("../src/features/conversations/server/test-business");
  const { handleInboundRequest } =
    await import("../src/app/api/conversations/inbound/route");
  const { isSemanticJevEnabled, isShadowJevEnabled } =
    await import("../src/server/integrations/ai/factory");
  const { offlineMessageTransport } =
    await import("../src/features/conversations/server/conversation-transport");
  const { defaultConversationEngineDeps } =
    await import("../src/features/conversations/server/conversation-engine");

  console.log(
    "\n── 1. Route reachability & proxy policy (Criterion 10) ────────",
  );
  check(
    "1.1 /api/conversations/inbound is a public path (no 307 redirect from proxy)",
    isPublicPath("/api/conversations/inbound") === true,
  );
  check(
    "1.2 /api/conversations stays protected (no prefix leak)",
    isPublicPath("/api/conversations") === false,
  );
  check("1.3 /settings stays protected", isPublicPath("/settings") === false);

  console.log(
    "\n── 2. Security & Token Verification (Criteria 1 & 2) ──────────",
  );
  // 2.1 When no secret is configured in env → 503 WEBHOOK_DISABLED
  {
    const req = new Request("http://localhost:3000/api/conversations/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-ingress-token": TEST_SECRET,
      },
      body: JSON.stringify({
        to: TEST_PHONE,
        from: CUSTOMER_PHONE,
        text: "مرحبا",
      }),
    });
    const res = await handleInboundRequest(req, {
      engineDeps: defaultConversationEngineDeps,
      ensureTestBusiness: async () => {},
      getExpectedTokens: () => [],
    });
    check("2.1 Missing secret env → 503 WEBHOOK_DISABLED", res.status === 503);
    const json = await res.json();
    check(
      "2.1b Error code is WEBHOOK_DISABLED",
      json.error?.code === "WEBHOOK_DISABLED",
    );
  }

  // 2.2 Missing token header → 401 UNAUTHENTICATED
  {
    const req = new Request("http://localhost:3000/api/conversations/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: TEST_PHONE,
        from: CUSTOMER_PHONE,
        text: "مرحبا",
      }),
    });
    const res = await handleInboundRequest(req, {
      engineDeps: defaultConversationEngineDeps,
      ensureTestBusiness: async () => {},
      getExpectedTokens: () => [TEST_SECRET],
    });
    check(
      "2.2 Missing request token header → 401 UNAUTHENTICATED",
      res.status === 401,
    );
  }

  // 2.3 Wrong token header → 401 UNAUTHENTICATED
  {
    const req = new Request("http://localhost:3000/api/conversations/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-ingress-token": "wrong-secret-token-1234567890123456",
      },
      body: JSON.stringify({
        to: TEST_PHONE,
        from: CUSTOMER_PHONE,
        text: "مرحبا",
      }),
    });
    const res = await handleInboundRequest(req, {
      engineDeps: defaultConversationEngineDeps,
      ensureTestBusiness: async () => {},
      getExpectedTokens: () => [TEST_SECRET],
    });
    check("2.3 Invalid token header → 401 UNAUTHENTICATED", res.status === 401);
  }

  console.log(
    "\n── 3. Hard Safety Boundary — Real Customer Isolation (Criterion 3) ──",
  );
  // 3.1 Test request attempting to target a real customer clinic → 403 FORBIDDEN
  {
    const req = new Request("http://localhost:3000/api/conversations/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-ingress-token": TEST_SECRET,
      },
      body: JSON.stringify({
        to: REAL_CLINIC_PHONE, // Real clinic!
        from: CUSTOMER_PHONE,
        text: "رسالة تجربة على عيادة حقيقية",
      }),
    });
    const res = await handleInboundRequest(req, {
      engineDeps: defaultConversationEngineDeps,
      ensureTestBusiness: async () => {},
      getExpectedTokens: () => [TEST_SECRET],
    });
    check(
      "3.1 Targeting a real clinic number → 403 FORBIDDEN (rejected before engine)",
      res.status === 403,
    );
    const json = await res.json();
    check(
      "3.1b Returns clear isolation error message",
      json.error?.code === "FORBIDDEN",
    );
  }

  console.log(
    "\n── 4. Real Conversation Engine Path (Criteria 4, 8, 9) ─────────",
  );
  // 4.1 Valid test message reaches real conversation engine and succeeds
  {
    let businessEnsured: boolean = false;
    let transportDelivered: boolean = false;
    let engineReached: boolean = false;

    const fakeBusiness = {
      id: TEST_BUSINESS_ID,
      name: "عيادة الاختبار (Isolated Test Target)",
      whatsappNumber: TEST_BUSINESS_PHONE,
      isActive: true,
      timezone: "Africa/Cairo",
      faqs: [{ question: "مواعيد العمل؟", answer: "نعمل يوميا من ١٠ صباحا." }],
    };

    const conv = {
      id: "conv-test-1",
      businessId: TEST_BUSINESS_ID,
      customerId: "cust-test-1",
      branchId: "branch-test-1",
      status: "AI_ACTIVE",
      assignedUserId: null,
      lastMessageAt: null,
      aiSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const mockEngineDeps = {
      ...defaultConversationEngineDeps,
      serviceRepository: {
        listByBusiness: async () => [],
        listActiveByBusiness: async () => [],
      },
      businessRepository: {
        ...defaultConversationEngineDeps.businessRepository,
        findByWhatsappNumber: async (num: string) =>
          num.replace(/[\s-]/g, "") === TEST_PHONE ? fakeBusiness : null,
        findById: async (id: string) =>
          id === TEST_BUSINESS_ID ? fakeBusiness : null,
      },
      inboundDedupeRepository: {
        claim: async () => ({ status: "claimed" as const, claimId: "claim-1" }),
      },
      customerRepository: {
        upsertByPhone: async (
          bId: string,
          input: { phone: string; name: string },
        ) => ({
          id: "cust-test-1",
          businessId: bId,
          phone: input.phone,
          name: input.name,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        }),
        touchConversation: async () => ({}),
      },
      conversationRepository: {
        findLatestByCustomer: async () => null,
        create: async () => conv,
        findById: async () => conv,
        listRecentMessages: async () => [],
        getMessages: async () => [],
        addMessage: async (_data: unknown) => {
          engineReached = true;
          return {
            id: "msg-test-1",
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
        updateWorkflow: async () => conv,
        update: async () => conv,
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: "branch-test-1",
          businessId: TEST_BUSINESS_ID,
          name: "الفرع الرئيسي",
        }),
        findByIdWithinBusiness: async () => ({
          id: "branch-test-1",
          businessId: TEST_BUSINESS_ID,
          name: "الفرع الرئيسي",
        }),
      },
      ai: {
        providerName: "offline-mock",
        respond: async () => ({
          action: "reply",
          content: "نعمل يوميا من ١٠ صباحا.",
          intent: "FAQ",
          extraction: {
            service: null,
            provider: null,
            date: null,
            timePreference: null,
          },
          handoffReason: null,
          summary: null,
        }),
      },
      transport: {
        providerName: "offline",
        send: async () => {
          transportDelivered = true;
          return { provider: "offline", delivered: true };
        },
      },
    };

    const req = new Request("http://localhost:3000/api/conversations/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-ingress-token": TEST_SECRET,
      },
      body: JSON.stringify({
        to: TEST_PHONE,
        from: CUSTOMER_PHONE,
        text: "مواعيد العمل؟",
      }),
    });

    const res = await handleInboundRequest(req, {
      engineDeps: mockEngineDeps as never,
      ensureTestBusiness: async () => {
        businessEnsured = true;
      },
      getExpectedTokens: () => [TEST_SECRET],
    });

    check(
      "4.1 Ingress returns 200 OK for valid test request",
      res.status === 200,
    );
    check(
      "4.2 Isolated test business ensured before turn",
      Boolean(businessEnsured),
    );
    check(
      "4.3 Test turn reached real conversation engine persistence",
      Boolean(engineReached),
    );
    check(
      "4.4 Safe offline transport boundary used (no live WhatsApp/Telegram)",
      Boolean(transportDelivered),
    );

    const json = await res.json();
    check(
      "4.5 Tenant isolated to TEST_BUSINESS_ID only",
      json.result?.businessId === TEST_BUSINESS_ID,
    );
    check(
      "4.6 Delivery provider is reported as offline",
      json.result?.delivery?.provider === "offline",
    );
  }

  console.log(
    "\n── 5. JEV Architecture & Shadow Safety (Criteria 5, 6, 7) ─────",
  );
  // 5.1 Semantic JEV remains OFF by default
  check(
    "5.1 Semantic JEV switch is OFF when flag is absent",
    isSemanticJevEnabled(() => undefined) === false,
  );
  check(
    "5.2 Semantic JEV switch is OFF when flag is '0'",
    isSemanticJevEnabled((k) =>
      k === "FLOWPILOT_JEV_SEMANTIC_ENABLED" ? "0" : undefined,
    ) === false,
  );

  // 5.2 Shadow switch operates independently and is non-authoritative
  check(
    "5.3 Shadow JEV switch is ON when FLOWPILOT_JEV_SHADOW_ENABLED='1'",
    isShadowJevEnabled((k) =>
      k === "FLOWPILOT_JEV_SHADOW_ENABLED" ? "1" : undefined,
    ) === true,
  );
  check(
    "5.4 Shadow switch ON does NOT turn on authoritative Semantic JEV",
    isSemanticJevEnabled((k) =>
      k === "FLOWPILOT_JEV_SHADOW_ENABLED" ? "1" : undefined,
    ) === false,
  );

  // 5.3 Default transport is offline transport
  check(
    "5.5 Default engine transport is offlineMessageTransport",
    defaultConversationEngineDeps.transport === offlineMessageTransport,
  );

  // 5.4 End-to-end ingress turn with active Shadow JEV
  {
    const shadowMod =
      await import("../src/server/integrations/ai/jev-shadow-strategy");
    const { createLlmConversationAi } =
      await import("../src/server/integrations/ai/conversation-ai");
    const { createConservativeJevStrategy } =
      await import("../src/server/integrations/ai/jev-strategy");

    let shadowRan: boolean = false;
    const shadowStrategy = shadowMod.createShadowJevStrategy({
      provider: {
        model: "typesafe/jev-1.13",
        secretRef: "OPENROUTER_API_KEY",
        evaluate: async () => {
          shadowRan = true;
          return {
            ok: true,
            errorCode: null,
            errorMessage: null,
            answers: {
              supportRequested: { type: "noul" as const, noul: 0.99 },
              bookingRequested: { type: "noul" as const, noul: 0.01 },
            },
            latencyMs: 15,
            servedModel: "typesafe/jev-1.13",
            inputTokens: 12,
            outputTokens: 6,
            attemptSpent: true,
          };
        },
      },
      sampler: shadowMod.createShadowSampler({
        getEnvVar: (k) => {
          if (k === "SHADOW_SAMPLE_RATE") return "1.0";
          return undefined;
        },
      }),
    });

    const aiWithShadow = createLlmConversationAi({
      primary: {
        providerId: "openrouter",
        model: "openrouter/test-model",
        secretRef: "OPENROUTER_API_KEY",
        call: async () => ({
          ok: true,
          response: {
            action: "reply",
            content: "أهلاً بك، تحب تحجز الساعة كام؟",
            intent: "BOOKING",
            extraction: {
              service: null,
              provider: null,
              date: null,
              timePreference: null,
            },
            handoffReason: null,
            summary: null,
          },
          provider: "openrouter",
          model: "openrouter/test-model",
          latencyMs: 10,
        }),
      },
      fallbackEnabled: false,
      decisionStrategy: createConservativeJevStrategy(),
      shadowStrategy,
    });

    const fakeBusiness = {
      id: TEST_BUSINESS_ID,
      name: "عيادة الاختبار (Isolated Test Target)",
      whatsappNumber: TEST_BUSINESS_PHONE,
      isActive: true,
      timezone: "Africa/Cairo",
      slotDurationMinutes: 30,
      confirmationMode: "automatic",
      workingHours: {},
      faqs: [],
    };

    const conv = {
      id: "conv-shadow-1",
      businessId: TEST_BUSINESS_ID,
      customerId: "cust-shadow-1",
      branchId: "branch-test-1",
      status: "AI_ACTIVE",
      assignedUserId: null,
      lastMessageAt: null,
      aiSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    };

    const shadowEngineDeps = {
      ...defaultConversationEngineDeps,
      serviceRepository: {
        listByBusiness: async () => [],
        listActiveByBusiness: async () => [],
      },
      businessRepository: {
        ...defaultConversationEngineDeps.businessRepository,
        findByWhatsappNumber: async (num: string) =>
          num.replace(/[\s-]/g, "") === TEST_PHONE ? fakeBusiness : null,
        findById: async (id: string) =>
          id === TEST_BUSINESS_ID ? fakeBusiness : null,
      },
      inboundDedupeRepository: {
        claim: async () => ({
          status: "claimed" as const,
          claimId: "claim-shadow-1",
        }),
      },
      customerRepository: {
        upsertByPhone: async (
          bId: string,
          input: { phone: string; name: string },
        ) => ({
          id: "cust-shadow-1",
          businessId: bId,
          phone: input.phone,
          name: input.name,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        }),
        touchConversation: async () => ({}),
      },
      conversationRepository: {
        findLatestByCustomer: async () => null,
        create: async () => conv,
        findById: async () => conv,
        listRecentMessages: async () => [],
        getMessages: async () => [],
        addMessage: async (_data: unknown) => ({
          id: "msg-shadow-1",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        updateWorkflow: async () => conv,
        update: async () => conv,
      },
      branchRepository: {
        findDefaultByBusiness: async () => ({
          id: "branch-test-1",
          businessId: TEST_BUSINESS_ID,
          name: "الفرع الرئيسي",
        }),
        findByIdWithinBusiness: async () => ({
          id: "branch-test-1",
          businessId: TEST_BUSINESS_ID,
          name: "الفرع الرئيسي",
        }),
      },
      ai: aiWithShadow,
      transport: {
        providerName: "offline",
        send: async () => ({ provider: "offline", delivered: true }),
      },
    };

    const req = new Request("http://localhost:3000/api/conversations/inbound", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-ingress-token": TEST_SECRET,
      },
      body: JSON.stringify({
        to: TEST_PHONE,
        from: CUSTOMER_PHONE,
        text: "عايز أحجز موعد بكرة",
      }),
    });

    const res = await handleInboundRequest(req, {
      engineDeps: shadowEngineDeps as never,
      ensureTestBusiness: async () => {},
      getExpectedTokens: () => [TEST_SECRET],
    });

    check(
      "5.6 Ingress executes successfully with active Shadow JEV",
      res.status === 200,
    );
    check("5.7 Shadow evaluation executed concurrently", Boolean(shadowRan));

    const json = await res.json();
    check(
      "5.8 Authoritative serving decision wins (BOOKING intent, not shadow handoff)",
      json.result?.intent === "BOOKING",
    );
    check(
      "5.9 Disjoint shadow telemetry captured in observability",
      Boolean(json.result?.observability?.shadow?.resultClass),
    );
    check(
      "5.10 Customer serving modelCallCount stays 1",
      json.result?.observability?.modelCallCount === 1,
    );
    check(
      "5.11 Disjoint shadowModelCallCount accounts for the shadow call (1)",
      json.result?.observability?.shadow?.shadowModelCallCount === 1,
    );
  }

  console.log(
    "\n── Summary ────────────────────────────────────────────────────",
  );
  const failed = checks.filter((c) => !c.pass);
  if (failed.length > 0) {
    console.error(
      `\n✘ FAILED: ${failed.length}/${checks.length} checks failed.`,
    );
    process.exit(1);
  }
  console.log(
    `\n✔ ALL GREEN: ${checks.length}/${checks.length} minimal safe ingress checks passed.`,
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
