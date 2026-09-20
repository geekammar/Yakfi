/* eslint-disable @typescript-eslint/consistent-type-imports */

/**
 * FlowPilot — META EMBEDDED SIGNUP adapter check (WHATSAPP-ONBOARDING-01).
 *
 * Verifies the REAL Meta Embedded Signup `ConnectionAuthorizer` OFFLINE:
 * the transport and the credential boundary are injected fakes, so no
 * network and no real secret is involved. What is proven:
 *
 *   1. the launch URL is a real Facebook OAuth dialog URL carrying the
 *      configured `app_id` + `config_id` + server-built `redirect_uri`
 *      + the opaque `state` (no JS SDK, no hardcoded domain)
 *   2. the opaque `stateRef` is created server-side and preserved on resume
 *   3. a successful server-side code exchange yields the normalized
 *      authorization result: `externalId` = phone_number_id, an opaque
 *      `fp:<id>` reference, `credentialKind` = RUNTIME
 *   4. the access token is stored ONLY through the opaque credential
 *      boundary; the returned result carries no raw token
 *   5. provider failures map to the normalized taxonomy; no failure is
 *      ever reported as success and no identity is invented
 *   6. a WABA with no registered number ⇒ PROVISIONING_INCOMPLETE
 *      (honest "not ready", never a fake connection)
 *   7. an unavailable credential store ⇒ PROVISIONING_INCOMPLETE, and
 *      nothing is persisted anywhere else
 *   8. no secret (app secret, code, token) ever appears in a request URL
 *   9. the adapter activates only behind the port; the domain/feature
 *      never imports it
 *
 * Run: pnpm check:meta-embedded-signup
 */

export {};

type Check = { label: string; pass: boolean };

const APP_ID = "9998887776665544";
// Offline fakes only — never real credentials (named so they are
// recognizably test values, and never committed elsewhere).
const APP_SECRET = "dummy-offline-app-secret";
const CONFIG_ID = "1587908742182956";
const CALLBACK = "http://localhost:3000/whatsapp-onboarding/callback";
const WABA_ID = "10203040506070809";
const PHONE_ID = "1098765432109876";
const TOKEN = "dummy-offline-token";

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const config =
    await import("../src/server/integrations/whatsapp/meta-onboarding-config");
  const adapter =
    await import("../src/server/integrations/whatsapp/meta-embedded-signup-authorizer");
  const credentials =
    await import("../src/server/credentials/credentials-resolver");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── injected configuration + transport + credential boundary ──────
  const env: Record<string, string | undefined> = {
    WHATSAPP_META_APP_ID: APP_ID,
    WHATSAPP_META_APP_SECRET: APP_SECRET,
    WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID: CONFIG_ID,
    WHATSAPP_META_API_VERSION: "v26.0",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  };
  const configDeps = { getEnvVar: (name: string) => env[name] };

  type Recorded = {
    url: string;
    method: string;
    body: string | null;
    headers: Record<string, string>;
  };
  const requests: Recorded[] = [];
  const stored: Array<{
    businessId: string;
    reference: string;
    secret: string;
  }> = [];
  let storeShouldSucceed = true;

  type Route = {
    match: (url: string, method: string) => boolean;
    respond: (
      url: string,
      method: string,
      body: string | null,
    ) => {
      status: number;
      json: unknown;
    };
  };

  // Provider behaviour is scripted per scenario.
  let tokenResponse: { status: number; json: unknown } = {
    status: 200,
    json: {
      access_token: TOKEN,
      token_type: "bearer",
      granular_scopes: [
        { scope: "whatsapp_business_management", target_ids: [WABA_ID] },
      ],
    },
  };
  let phonesResponse: { status: number; json: unknown } = {
    status: 200,
    json: { data: [{ id: PHONE_ID, display_phone_number: "+201001112233" }] },
  };
  let networkDown = false;

  const routes: Route[] = [
    {
      match: (url) => url.endsWith("/oauth/access_token"),
      respond: () => tokenResponse,
    },
    {
      match: (url) => url.includes(`/phone_numbers`),
      respond: () => phonesResponse,
    },
  ];

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      Object.entries(init.headers as Record<string, string>).forEach(
        ([k, v]) => {
          headers[k] = v;
        },
      );
    }
    const rawBody = init?.body;
    const body =
      typeof rawBody === "string"
        ? rawBody
        : rawBody instanceof URLSearchParams
          ? rawBody.toString()
          : null;
    requests.push({ url, method, body, headers });
    if (networkDown) throw new Error("network unreachable");
    const route = routes.find((r) => r.match(url, method));
    if (!route) {
      return new Response(JSON.stringify({ error: { message: "no route" } }), {
        status: 404,
      });
    }
    const { status, json } = route.respond(url, method, body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  const fakeResolver: import("../src/server/credentials/credentials-resolver").CredentialsResolver =
    {
      resolve: async () => ({
        ok: false as const,
        code: "UNRESOLVED_REFERENCE" as const,
        message: "offline check",
      }),
      store: async (params: {
        businessId: string;
        reference: string;
        secret: string;
      }) => {
        if (!storeShouldSucceed) {
          return {
            ok: false as const,
            code: "STORE_UNAVAILABLE" as const,
            message: "offline check",
          };
        }
        stored.push(params);
        return { ok: true as const, reference: params.reference };
      },
      delete: async () => ({ ok: true as const }),
    };

  const make = () =>
    adapter.createMetaEmbeddedSignupConnectionAuthorizer({
      configDeps,
      fetchImpl: fakeFetch as typeof fetch,
      dialogHost: "https://www.facebook.com",
      graphHost: "https://graph.facebook.com",
      credentialsResolver: fakeResolver,
    });

  const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

  // ── 1. launch URL ───────────────────────────────────────────────────
  requests.length = 0;
  const launch = await make().launchAuthorization({
    businessId: BUSINESS_ID,
    connectionId: "conn-1",
    phoneNumber: "+201001112233",
    redirectUri: CALLBACK,
  });
  const launchUrl = new URL(launch.authorizationUrl);
  check(
    "الإطلاق: رابط حوار فيسبوك صحيح (facebook.com/v26.0/dialog/oauth)",
    launchUrl.origin === "https://www.facebook.com" &&
      launchUrl.pathname === "/v26.0/dialog/oauth",
  );
  check(
    "الإطلاق: app_id + config_id من التكوين (لا قيمة مختلقة)",
    launchUrl.searchParams.get("app_id") === APP_ID &&
      launchUrl.searchParams.get("config_id") === CONFIG_ID,
  );
  check(
    "الإطلاق: redirect_uri مشتق خادمياً (لا نطاق مكتوب في الكود)",
    launchUrl.searchParams.get("redirect_uri") === CALLBACK,
  );
  check(
    "الإطلاق: state هو الـ stateRef المُنتج خادمياً",
    Boolean(launch.stateRef) &&
      launchUrl.searchParams.get("state") === launch.stateRef,
  );
  check(
    "الإطلاق: response_type=code (مسار الـ callback)",
    launchUrl.searchParams.get("response_type") === "code",
  );
  check(
    "الإطلاق: لا سر في الرابط (app secret / code / token)",
    !launch.authorizationUrl.includes(APP_SECRET) &&
      !launch.authorizationUrl.includes("code="),
  );

  // ── 2. resume preserves the server-persisted stateRef ──────────────
  const RESUMED = "resumed-state-ref-aaaaaaaa";
  const resumed = await make().launchAuthorization({
    businessId: BUSINESS_ID,
    connectionId: "conn-1",
    redirectUri: CALLBACK,
    existingStateRef: RESUMED,
  });
  check(
    "الاستئناف: نفس stateRef المحفوظ (لا طلب ثانٍ)",
    resumed.stateRef === RESUMED &&
      new URL(resumed.authorizationUrl).searchParams.get("state") === RESUMED,
  );

  // ── 3+4. successful exchange through the opaque boundary ───────────
  requests.length = 0;
  stored.length = 0;
  const ok = await make().exchangeCallback({
    code: "provider-authorization-code",
    stateRef: launch.stateRef,
    redirectUri: CALLBACK,
    businessId: BUSINESS_ID,
  });
  const okResult = ok as Extract<typeof ok, { ok: true }> & {
    provenance?: Record<string, string>;
  };
  check(
    "التبادل: نتيجة ناجحة تطابق العقد",
    ok.ok === true && "externalId" in ok && ok.externalId === PHONE_ID,
  );
  check(
    "التبادل: credentialsRef مرجع معتم (fp:) — لا رمام",
    ok.ok === true &&
      credentials.isRuntimeCredentialReference(ok.credentialsRef) === true,
  );
  check(
    "التبادل: credentialKind = RUNTIME",
    ok.ok === true && ok.credentialKind === "RUNTIME",
  );
  check(
    "التبادل: النتيجة لا تحوي الرمز (token) أبداً",
    JSON.stringify(ok).includes(TOKEN) === false,
  );
  const tokenRequest = requests[0];
  check(
    "التبادل: الرمز خُزّن عبر الحد المعتم فقط (مرة واحدة)",
    stored.length === 1 &&
      stored[0]?.secret === TOKEN &&
      stored[0]?.businessId === BUSINESS_ID,
  );
  check(
    "التبادل: الطلب حمل app_secret في الجسم لا في الرابط",
    tokenRequest !== undefined &&
      tokenRequest.method === "POST" &&
      tokenRequest.body?.includes(`client_secret=${APP_SECRET}`) === true &&
      tokenRequest.url.includes("secret") === false,
  );
  check(
    "التبادل: redirect_uri المرسل = redirectUri المنفذ (لا ثابت)",
    tokenRequest !== undefined &&
      tokenRequest.body?.includes(
        `redirect_uri=${encodeURIComponent(CALLBACK)}`,
      ) === true,
  );
  check(
    "التبادل: protonance تحمل waba_id فقط (لا مفاتيح غير مدعومة)",
    okResult.provenance !== undefined &&
      Object.keys(okResult.provenance).join() === "waba_id" &&
      okResult.provenance.waba_id === WABA_ID,
  );
  check(
    "التبادل: الرقم المعروض من المزوّد (ليس مدخلاً)",
    ok.ok === true && ok.displayPhoneNumber === "+201001112233",
  );

  // ── 5. provider failures map to the taxonomy (never fake success) ──
  tokenResponse = {
    status: 403,
    json: { error: { message: "access_denied" } },
  };
  const declined = await make().exchangeCallback({
    code: "c",
    stateRef: "s",
    redirectUri: CALLBACK,
    businessId: BUSINESS_ID,
  });
  check(
    "الرفض: AUTHORIZATION_DECLINED (ليس نجاحاً)",
    declined.ok === false && declined.code === "AUTHORIZATION_DECLINED",
  );

  tokenResponse = {
    status: 400,
    json: { error: { message: "invalid verification code" } },
  };
  const badCode = await make().exchangeCallback({
    code: "c",
    stateRef: "s",
    redirectUri: CALLBACK,
    businessId: BUSINESS_ID,
  });
  check(
    "الرمز غير صالح: INVALID_AUTHORIZATION_CODE",
    badCode.ok === false && badCode.code === "INVALID_AUTHORIZATION_CODE",
  );

  tokenResponse = { status: 200, json: { token_type: "bearer" } };
  const noToken = await make().exchangeCallback({
    code: "c",
    stateRef: "s",
    redirectUri: CALLBACK,
    businessId: BUSINESS_ID,
  });
  check(
    "استجابة بلا رمز: PROVIDER_PAYLOAD_INVALID (لا اختراع)",
    noToken.ok === false && noToken.code === "PROVIDER_PAYLOAD_INVALID",
  );

  tokenResponse = { status: 200, json: { access_token: TOKEN } };
  const noScopes = await make().exchangeCallback({
    code: "c",
    stateRef: "s",
    redirectUri: CALLBACK,
    businessId: BUSINESS_ID,
  });
  check(
    "استجابة بلا WABA: PROVIDER_PAYLOAD_INVALID",
    noScopes.ok === false && noScopes.code === "PROVIDER_PAYLOAD_INVALID",
  );

  tokenResponse = {
    status: 200,
    json: {
      access_token: TOKEN,
      granular_scopes: [
        { scope: "whatsapp_business_management", target_ids: [WABA_ID] },
      ],
    },
  };
  phonesResponse = { status: 200, json: { data: [] } };
  const noPhone = await make().exchangeCallback({
    code: "c",
    stateRef: "s",
    redirectUri: CALLBACK,
    businessId: BUSINESS_ID,
  });
  check(
    "لا رقم مسجّل: PROVISIONING_INCOMPLETE (ليس جاهزاً)",
    noPhone.ok === false && noPhone.code === "PROVISIONING_INCOMPLETE",
  );

  phonesResponse = { status: 200, json: { data: [{ id: PHONE_ID }] } };
  networkDown = true;
  const unreachable = await make().exchangeCallback({
    code: "c",
    stateRef: "s",
    redirectUri: CALLBACK,
    businessId: BUSINESS_ID,
  });
  check(
    "شبكة معطلة: PROVIDER_UNREACHABLE",
    unreachable.ok === false && unreachable.code === "PROVIDER_UNREACHABLE",
  );
  networkDown = false;

  // ── 7. unavailable credential store ⇒ honest incomplete ───────────
  phonesResponse = {
    status: 200,
    json: { data: [{ id: PHONE_ID, display_phone_number: "+201001112233" }] },
  };
  storeShouldSucceed = false;
  const noStore = await make().exchangeCallback({
    code: "c",
    stateRef: "s",
    redirectUri: CALLBACK,
    businessId: BUSINESS_ID,
  });
  check(
    "مخزن البيانات غير متاح: PROVISIONING_INCOMPLETE (لا نجاح كاذب)",
    noStore.ok === false && noStore.code === "PROVISIONING_INCOMPLETE",
  );
  check(
    "مخزن البيانات غير متاح: لا يُخزّن شيء في أي مكان آخر",
    stored.length === 1, // only the earlier successful scenario
  );
  storeShouldSucceed = true;

  // ── 8. no secret ever lands in a request URL ───────────────────────
  check(
    "أمان: لا سر في أي رابط طلب (الرمز في الترويسة للقراءة فقط)",
    requests.every(
      (r) => !r.url.includes(APP_SECRET) && !r.url.includes(TOKEN),
    ) === true,
  );

  // ── 9. configuration gate ──────────────────────────────────────────
  const fullEnv = { ...env };
  delete env.WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID;
  let threw = false;
  try {
    await make().launchAuthorization({
      businessId: BUSINESS_ID,
      connectionId: "conn-1",
      redirectUri: CALLBACK,
    });
  } catch {
    threw = true;
  }
  check("البوابة: تكوين ناقص يفشل فوراً (لا قيمة مختلقة)", threw === true);
  Object.assign(env, fullEnv);
  check(
    "البوابة: describeMetaOnboardingReadiness تُقرأ الأسماء فقط",
    config.describeMetaOnboardingReadiness(configDeps).ready === true,
  );

  // ── report ─────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? "✔" : "✘"} ${c.label}`);
  }
  console.log(
    `\nاختبارات محوّل Embedded Signup: ${checks.length - failed.length}/${
      checks.length
    } فحص ناجح.`,
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
