/**
 * Meta WhatsApp Cloud API — REAL Embedded Signup adapter
 * (WHATSAPP-ONBOARDING-01; DECISIONS #47).
 *
 * A `ConnectionAuthorizer` implementation that performs a REAL Meta
 * Embedded Signup round-trip for DEVELOPMENT testing:
 *
 *   launchAuthorization ──▶ Meta OAuth dialog URL (`config_id` launch)
 *                          (the browser leaves the app and returns to
 *                           `/whatsapp-onboarding/callback` with
 *                           `state` + `code`)
 *   exchangeCallback    ──▶ server-side code exchange
 *                        ──▶ WABA + phone_number_id resolution
 *                        ──▶ opaque runtime credential persistence
 *
 * Boundary rules (identical to the existing Meta adapters):
 * - Meta concepts (dialog host, Graph URL, `config_id`, OAuth params,
 *   Graph response shapes) live ONLY here. The feature/domain talks to
 *   the provider-neutral `ConnectionAuthorizer` port.
 * - The App Secret VALUE is resolved here server-side only (the SAME
 *   `WHATSAPP_META_APP_SECRET` the webhook uses) and is never logged,
 *   persisted, or returned. Neither is the authorization code or the
 *   access token.
 * - The callback URL is never hardcoded: it arrives through the port's
 *   `redirectUri` (server-built from `NEXT_PUBLIC_APP_URL`).
 * - Tenancy: `businessId` comes from the persisted authorization ledger
 *   through the port. It is used ONLY to tenant-scope the stored secret;
 *   it is never authority for which Business a callback belongs to.
 *
 * Failure model (never fake success):
 * - an unresolved configuration ⇒ the launch/exchange fails fast (the
 *   wiring layer falls back to the deterministic stand-in, so no code
 *   path silently degrades);
 * - a provider error ⇒ a normalized `AuthorizationErrorCode`;
 * - a response that does not carry the fields this adapter needs ⇒
 *   `PROVIDER_PAYLOAD_INVALID` (never an invented identity);
 * - a credential store that is unavailable ⇒ `PROVISIONING_INCOMPLETE`
 *   (the operator must set `CREDENTIAL_MASTER_KEY`; the token is never
 *   persisted anywhere else and the connection is never claimed ready).
 */

import {
  defaultCredentialsResolver,
  mintRuntimeCredentialReference,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import {
  META_GRAPH_HOST,
  type MetaApiErrorBody,
} from "@/server/integrations/whatsapp/meta-client";
import {
  resolveMetaOnboardingConfig,
  type MetaOnboardingConfig,
  type MetaOnboardingConfigDeps,
} from "@/server/integrations/whatsapp/meta-onboarding-config";
import type {
  AuthorizationErrorCode,
  AuthorizationExchangeParams,
  AuthorizationLaunchParams,
  AuthorizationLaunchResult,
  AuthorizationProvenance,
  AuthorizationResult,
  ConnectionAuthorizer,
} from "@/server/transport/whatsapp-transport";

/**
 * The Facebook OAuth dialog host — the only place the dialog origin is
 * named. Kept alongside `META_GRAPH_HOST` (the token/Graph host).
 */
export const META_DIALOG_HOST = "https://www.facebook.com";

export const META_PROVIDER_NAME = "meta-whatsapp";

/**
 * The scopes the WhatsApp Business login integration needs. Passed as a
 * hint; with a `config_id` launch Meta also reads the scopes configured
 * on the Embedded Signup configuration in the dashboard.
 */
export const EMBEDDED_SIGNUP_SCOPES = [
  "whatsapp_business_management",
  "whatsapp_business_messaging",
] as const;

export type MetaEmbeddedSignupDeps = {
  /** Configuration seam (env) — defaults to the production `process.env`. */
  configDeps?: MetaOnboardingConfigDeps;
  /** Injectable transport — offline tests inject a fake. */
  fetchImpl?: typeof fetch;
  /** Facebook OAuth dialog origin. */
  dialogHost?: string;
  /** Graph API origin. */
  graphHost?: string;
  /**
   * The opaque credential boundary: the exchanged access token is stored
   * through it and only the opaque `fp:<id>` reference is returned.
   */
  credentialsResolver?: CredentialsResolver;
};

/** Opaque, unguessable, single-use state reference. */
function newStateRef(): string {
  return crypto.randomUUID();
}

/** Resolve the config per call (env rotation without a reload) or fail. */
function requireConfig(deps: MetaEmbeddedSignupDeps): MetaOnboardingConfig {
  const resolution = resolveMetaOnboardingConfig(
    deps.configDeps ?? defaultConfigDeps,
  );
  if (!resolution.ok) {
    // Only env-var NAMES — never the App Secret value or the config id.
    throw new Error(
      `تكوين Embedded Signup غير مكتمل: ${resolution.missing.join("، ")}`,
    );
  }
  return resolution.config;
}

// ─── URL builders (pure, unit-testable) ─────────────────────────────────────

/**
 * Build the Meta OAuth dialog URL for an Embedded Signup launch. The
 * `state` is the server-persisted opaque `stateRef` — the single
 * callback credential. `response_type=code` is Meta's default and is
 * stated explicitly because the callback route consumes `code`.
 */
export function buildEmbeddedSignupDialogUrl(params: {
  dialogHost: string;
  apiVersion: string;
  appId: string;
  configurationId: string;
  redirectUri: string;
  stateRef: string;
}): string {
  const url = new URL(`${params.dialogHost}/${params.apiVersion}/dialog/oauth`);
  url.searchParams.set("app_id", params.appId);
  url.searchParams.set("config_id", params.configurationId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.stateRef);
  url.searchParams.set("response_type", "code");
  return url.toString();
}

export function buildTokenExchangeUrl(
  graphHost: string,
  apiVersion: string,
): string {
  return `${graphHost}/${apiVersion}/oauth/access_token`;
}

export function buildPhoneNumbersUrl(
  graphHost: string,
  apiVersion: string,
  wabaId: string,
): string {
  return `${graphHost}/${apiVersion}/${wabaId}/phone_numbers`;
}

// ─── Provider response shapes (only what this adapter reads) ────────────────

type GranularScope = {
  scope?: string;
  target_ids?: string[];
};

type TokenExchangeResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  /** WhatsApp Business login returns the granted WhatsApp scopes here. */
  granular_scopes?: GranularScope[];
};

type PhoneNumbersResponse = {
  data?: Array<{
    id?: string;
    display_phone_number?: string;
    name?: string;
  }>;
};

// ─── Error mapping (never an HTTP status to the feature) ─────────────────────

/**
 * Map a Meta token-exchange failure onto the provider-neutral
 * authorization taxonomy. Never echoes the provider message upward: the
 * feature persists only its own normalized summary.
 */
export function mapTokenExchangeError(
  httpStatus: number,
  body: MetaApiErrorBody | null,
): { code: AuthorizationErrorCode; message: string } {
  const errorCode = body?.error?.message ?? "";
  if (httpStatus >= 500 && httpStatus < 600) {
    return { code: "PROVIDER_UNREACHABLE", message: "تعذر الوصول إلى المزوّد" };
  }
  if (
    errorCode.includes("code") ||
    errorCode.includes("invalid_grant") ||
    errorCode.includes("expired")
  ) {
    return {
      code: "INVALID_AUTHORIZATION_CODE",
      message: "رمز التفويض غير صالح أو منتهي",
    };
  }
  if (errorCode.includes("redirect_uri")) {
    return {
      code: "PROVIDER_PAYLOAD_INVALID",
      message: "رابط الإرجاع غير متطابق مع إعدادات التطبيق",
    };
  }
  if (errorCode.includes("access_denied") || httpStatus === 403) {
    return { code: "AUTHORIZATION_DECLINED", message: "تم رفض التفويض" };
  }
  if (httpStatus === 401) {
    return {
      code: "INVALID_AUTHORIZATION_CODE",
      message: "بيانات اعتماد التطبيق غير صالحة",
    };
  }
  return {
    code: "PROVIDER_PAYLOAD_INVALID",
    message: "استجابة المزوّد غير قابلة للقراءة",
  };
}

// ─── Provider identity resolution ─────────────────────────────────────────────

/**
 * A fetched provider response: on success the parsed JSON body is present
 * (an unparseable 2xx degrades to an empty object, which then fails the
 * field checks honestly); on failure only the normalized error body.
 */
type FetchResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: MetaApiErrorBody | null };

async function parseResult<T>(response: Response): Promise<FetchResult<T>> {
  let parsed: T | MetaApiErrorBody | null = null;
  try {
    parsed = (await response.json()) as T | MetaApiErrorBody;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      body: parsed as MetaApiErrorBody | null,
    };
  }
  // A 2xx without a JSON body: an empty object carries no fields, so the
  // required-field checks below fail honestly instead of crashing.
  return {
    ok: true,
    status: response.status,
    body: (parsed ?? {}) as T,
  };
}

/**
 * The WABA id from the exchange's granted WhatsApp scopes. The scope's
 * `target_ids` carry the WhatsApp Business Account the token is valid
 * for. Unknown/absent shapes ⇒ `undefined` (the caller fails honestly).
 */
export function resolveWabaIdFromExchange(
  response: TokenExchangeResponse,
): string | undefined {
  const scopes = response.granular_scopes ?? [];
  for (const scope of scopes) {
    if (!scope.scope?.startsWith("whatsapp_business")) continue;
    const target = scope.target_ids?.[0];
    if (target && target.trim()) return target.trim();
  }
  return undefined;
}

/**
 * Pick the phone number identity from a WABA's phone_numbers edge. The
 * `id` is the stable `phone_number_id` that becomes the connection's
 * `externalId` (and the inbound tenant key). The first number is the
 * WABA's primary number — a Business with several numbers must be
 * managed from the Meta dashboard (out of scope here).
 */
export function resolvePhoneNumberIdentity(
  body: PhoneNumbersResponse,
): { externalId: string; displayPhoneNumber?: string } | undefined {
  const first = body.data?.[0];
  if (!first?.id || !first.id.trim()) return undefined;
  return {
    externalId: first.id.trim(),
    displayPhoneNumber: first.display_phone_number?.trim() || undefined,
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export function createMetaEmbeddedSignupConnectionAuthorizer(
  deps: MetaEmbeddedSignupDeps = {},
): ConnectionAuthorizer {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const dialogHost = deps.dialogHost ?? META_DIALOG_HOST;
  const graphHost = deps.graphHost ?? META_GRAPH_HOST;
  const credentialsResolver =
    deps.credentialsResolver ?? defaultCredentialsResolver;

  async function postForm<T>(
    url: string,
    body: URLSearchParams,
  ): Promise<FetchResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      });
    } catch {
      return { ok: false, status: 0, body: null };
    }
    return parseResult<T>(response);
  }

  async function getJson<T>(
    url: string,
    accessToken: string,
  ): Promise<FetchResult<T>> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });
    } catch {
      return { ok: false, status: 0, body: null };
    }
    return parseResult<T>(response);
  }

  return {
    providerName: META_PROVIDER_NAME,

    async launchAuthorization(
      params: AuthorizationLaunchParams,
    ): Promise<AuthorizationLaunchResult> {
      const config = requireConfig(deps);
      const stateRef = params.existingStateRef?.trim()
        ? params.existingStateRef.trim()
        : newStateRef();
      const authorizationUrl = buildEmbeddedSignupDialogUrl({
        dialogHost,
        apiVersion: config.apiVersion,
        appId: config.appId,
        configurationId: config.configurationId,
        // The server-built callback URL is authoritative — never a
        // hardcoded domain.
        redirectUri: params.redirectUri,
        stateRef,
      });
      return { authorizationUrl, stateRef };
    },

    async exchangeCallback(
      params: AuthorizationExchangeParams,
    ): Promise<AuthorizationResult> {
      const config = requireConfig(deps);
      const code = params.code.trim();
      if (!code) {
        return {
          ok: false,
          code: "INVALID_AUTHORIZATION_CODE",
          message: "رمز تفويض غير صالح",
        };
      }

      // ── 1. Server-side code exchange (App Secret never logged) ──
      const exchangeUrl = buildTokenExchangeUrl(graphHost, config.apiVersion);
      const exchangeBody = new URLSearchParams({
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
        redirect_uri: params.redirectUri,
      });
      const exchange = await postForm<TokenExchangeResponse>(
        exchangeUrl,
        exchangeBody,
      );
      if (exchange.status === 0) {
        return {
          ok: false,
          code: "PROVIDER_UNREACHABLE",
          message: "تعذر الوصول إلى المزوّد",
        };
      }
      if (!exchange.ok) {
        const mapped = mapTokenExchangeError(exchange.status, exchange.body);
        return { ok: false, ...mapped };
      }

      const tokenBody = exchange.body;
      const accessToken = tokenBody?.access_token?.trim();
      if (!accessToken) {
        // The exchange answered 2xx with no usable token — unusable, and
        // never faked.
        return {
          ok: false,
          code: "PROVIDER_PAYLOAD_INVALID",
          message: "استجابة المزوّد لا تحوي رمز وصول",
        };
      }

      // ── 2. Provider identity: WABA → phone_number_id ──
      const wabaId = resolveWabaIdFromExchange(tokenBody);
      if (!wabaId) {
        return {
          ok: false,
          code: "PROVIDER_PAYLOAD_INVALID",
          message: "تعذر تحديد حساب واتساب للأعمال من التفويض",
        };
      }

      const phones = await getJson<PhoneNumbersResponse>(
        buildPhoneNumbersUrl(graphHost, config.apiVersion, wabaId),
        accessToken,
      );
      if (phones.status === 0) {
        return {
          ok: false,
          code: "PROVIDER_UNREACHABLE",
          message: "تعذر الوصول إلى المزوّد",
        };
      }
      if (!phones.ok) {
        const mapped = mapTokenExchangeError(phones.status, phones.body);
        return { ok: false, ...mapped };
      }
      const identity = resolvePhoneNumberIdentity(phones.body);
      if (!identity) {
        // No registered number yet: the Business must complete phone
        // registration in the Meta dashboard — honest, not ready.
        return {
          ok: false,
          code: "PROVISIONING_INCOMPLETE",
          message: "لا يوجد رقم واتساب مسجّل بعد على حساب الأعمال",
        };
      }

      // ── 3. Persist the token through the OPAQUE boundary only ──
      // The raw access token is stored in the encrypted runtime store;
      // the connection row keeps only the opaque `fp:<id>` reference.
      const reference = mintRuntimeCredentialReference();
      const stored = await credentialsResolver.store({
        businessId: params.businessId,
        reference,
        secret: accessToken,
      });
      if (!stored.ok) {
        // The store is unavailable (e.g. CREDENTIAL_MASTER_KEY unset) or
        // the reference collided: the token is not persisted anywhere
        // else, so the connection must NOT be reported as provisioned.
        return {
          ok: false,
          code: "PROVISIONING_INCOMPLETE",
          message: "تعذر تخزين بيانات اعتماد واتساب بأمان",
        };
      }

      const provenance: AuthorizationProvenance = {
        waba_id: wabaId,
      };
      return {
        ok: true,
        externalId: identity.externalId,
        credentialsRef: stored.reference,
        credentialKind: "RUNTIME",
        displayPhoneNumber: identity.displayPhoneNumber,
        verifiedName: undefined,
        provenance,
      };
    },
  };
}

const defaultConfigDeps: MetaOnboardingConfigDeps = {
  getEnvVar: (name) => process.env[name],
};

/**
 * The production singleton — server-only. Activated by the onboarding
 * wiring ONLY when `resolveMetaOnboardingConfig()` resolves; otherwise
 * the deterministic stand-in stays in place (no invented values, no
 * silent behavior change).
 */
export const metaEmbeddedSignupConnectionAuthorizer: ConnectionAuthorizer =
  createMetaEmbeddedSignupConnectionAuthorizer();
