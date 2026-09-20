import { META_DEFAULT_API_VERSION } from "@/server/integrations/whatsapp/meta-client";

/**
 * Meta WhatsApp Cloud API — Embedded Signup CONFIGURATION SEAM
 * (WHATSAPP-ONBOARDING-01; DECISIONS #47).
 *
 * The smallest server-only configuration the future real Meta Embedded
 * Signup adapter (a `ConnectionAuthorizer` implementation) will consume.
 * It exists so that adapter reads ONE resolved config object instead of
 * environment variables, and so that NO Meta concept and NO secret ever
 * reaches the onboarding feature or the domain.
 *
 * What this module is:
 * - a typed projection of the existing `serverEnvSchema` fields; and
 * - an honest "are the operator-owned prerequisites configured?" check.
 *
 * What this module is NOT:
 * - no Meta SDK, no Facebook JS SDK, no HTTP, no OAuth, no code exchange;
 * - no authorization-URL generation, no Graph API call, no WABA
 *   provisioning, no phone registration, no webhook change;
 * - no runtime secret-store backend and no token rotation/refresh.
 * (All of that lives in `meta-embedded-signup-authorizer.ts` and the
 * credential boundary, never here.)
 *
 * Secret handling (identical to the existing webhook boundary): the App
 * Secret VALUE is resolved here server-side only — it is the SAME
 * `WHATSAPP_META_APP_SECRET` already used for `X-Hub-Signature-256`
 * validation, never a second secret. It is never stored in a DB row,
 * returned by an API, projected to the platform UI, or logged. Only its
 * env-var NAME (`WHATSAPP_META_APP_SECRET`) may appear in diagnostics.
 */

export type MetaOnboardingConfigDeps = {
  getEnvVar(name: string): string | undefined;
};

const APP_ID_ENV_VAR = "WHATSAPP_META_APP_ID";
const APP_SECRET_ENV_VAR = "WHATSAPP_META_APP_SECRET";
const CONFIG_ID_ENV_VAR = "WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID";
const API_VERSION_ENV_VAR = "WHATSAPP_META_API_VERSION";
const APP_URL_ENV_VAR = "NEXT_PUBLIC_APP_URL";

/** The onboarding callback path — the single approved route (unchanged). */
export const ONBOARDING_CALLBACK_PATH = "/whatsapp-onboarding/callback";

/**
 * Derive the canonical onboarding callback URL from the app's canonical
 * URL. Server-only; the same rule the onboarding service uses for the
 * port's `redirectUri` (which stays the AUTHORITATIVE value the adapter
 * sends to Meta). Exposed here so the config boundary can report the
 * exact URI the operator must register in the Meta App Dashboard — no
 * production domain is hardcoded anywhere.
 */
export function resolveMetaOnboardingCallbackUrl(
  getAppUrl: () => string | undefined,
): string | undefined {
  const appUrl = getAppUrl();
  if (!appUrl) return undefined;
  return `${appUrl.replace(/\/+$/, "")}${ONBOARDING_CALLBACK_PATH}`;
}

export type MetaOnboardingConfig = {
  /** Meta App ID — non-secret, identifies the Meta App (Embedded Signup
   *  `app_id` / JS SDK `appId`). `undefined` until the operator
   *  configures it (no default and no fake value is ever supplied). */
  appId: string;
  /**
   * The Meta App Secret VALUE — server-side only, adapter-side only.
   * This is the REUSED `WHATSAPP_META_APP_SECRET` (the same one the
   * webhook uses for HMAC validation); the code exchange passes
   * it as the OAuth `client_secret`. NEVER persist/log/project this.
   */
  appSecret: string;
  /**
   * The Meta Embedded Signup `config_id` — non-secret server-side
   * CONFIGURATION METADATA identifying the Embedded Signup configuration
   * the operator created in the Meta App Dashboard. The OAuth dialog is
   * launched against it. Never hardcoded in domain logic.
   */
  configurationId: string;
  /** Graph API version — unchanged existing configuration. */
  apiVersion: string;
  /**
   * The canonical callback URL the provider must return to, derived from
   * `NEXT_PUBLIC_APP_URL`. Diagnostic/registration value: the adapter
   * sends the port's `redirectUri` (built by the same rule) to Meta.
   */
  callbackUrl: string;
};

export type MetaOnboardingConfigResolution =
  | { ok: true; config: MetaOnboardingConfig }
  | {
      ok: false;
      /** The env-var NAME(S) missing — never a secret value. */
      missing: string[];
    };

/**
 * Resolve the Meta onboarding configuration. Adapter-side: the caller is
 * the Meta adapter at the transport boundary, never domain
 * logic. An unset optional variable is treated exactly like every other
 * optional server variable — empty string ⇒ `undefined`. All three
 * operator-owned values (App ID, App Secret, `config_id`) are required
 * for a REAL Embedded Signup round-trip; while any is missing the seam
 * resolves `ok: false` and the deterministic stand-in stays wired.
 */
/** Truthy string guard that also narrows (used after the missing check). */
function isPresent(value: string | undefined): value is string {
  return Boolean(value);
}

export function resolveMetaOnboardingConfig(
  deps: MetaOnboardingConfigDeps = defaultEnvDeps,
): MetaOnboardingConfigResolution {
  const appId = deps.getEnvVar(APP_ID_ENV_VAR);
  const appSecret = deps.getEnvVar(APP_SECRET_ENV_VAR);
  const configurationId = deps.getEnvVar(CONFIG_ID_ENV_VAR);
  const callbackUrl = resolveMetaOnboardingCallbackUrl(() =>
    deps.getEnvVar(APP_URL_ENV_VAR),
  );
  const missing: string[] = [];
  if (!appId) missing.push(APP_ID_ENV_VAR);
  if (!appSecret) missing.push(APP_SECRET_ENV_VAR);
  if (!configurationId) missing.push(CONFIG_ID_ENV_VAR);
  if (!callbackUrl) missing.push(APP_URL_ENV_VAR);
  if (
    !isPresent(appId) ||
    !isPresent(appSecret) ||
    !isPresent(configurationId) ||
    !isPresent(callbackUrl)
  ) {
    return { ok: false, missing };
  }

  const versionRaw =
    deps.getEnvVar(API_VERSION_ENV_VAR) ?? META_DEFAULT_API_VERSION;
  return {
    ok: true,
    config: {
      appId,
      appSecret,
      configurationId,
      apiVersion: versionRaw.startsWith("v") ? versionRaw : `v${versionRaw}`,
      callbackUrl,
    },
  };
}

/**
 * Read-only readiness descriptor for the operator-owned Meta App
 * Dashboard prerequisites (DECISIONS #47 — the gate for the real
 * adapter). Reports only env-var NAMES and booleans: no secret value and
 * no invented App ID or `config_id` is ever produced or logged.
 */
export type MetaOnboardingReadiness = {
  /** Is `WHATSAPP_META_APP_ID` populated? (external dashboard action) */
  appIdConfigured: boolean;
  /** Is `WHATSAPP_META_APP_SECRET` populated? (never its value) */
  appSecretConfigured: boolean;
  /** Is `WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID` populated? */
  configurationIdConfigured: boolean;
  /** All present ⇒ the config seam is ready for the real adapter. */
  ready: boolean;
  /** The env-var NAME(S) still missing — safe to log. */
  missing: string[];
  /** The exact URI to register in the Meta App Dashboard (or why not). */
  callbackUrl: string | null;
};

export function describeMetaOnboardingReadiness(
  deps: MetaOnboardingConfigDeps = defaultEnvDeps,
): MetaOnboardingReadiness {
  const resolution = resolveMetaOnboardingConfig(deps);
  if (resolution.ok) {
    return {
      appIdConfigured: true,
      appSecretConfigured: true,
      configurationIdConfigured: true,
      ready: true,
      missing: [],
      callbackUrl: resolution.config.callbackUrl,
    };
  }
  return {
    appIdConfigured: !resolution.missing.includes(APP_ID_ENV_VAR),
    appSecretConfigured: !resolution.missing.includes(APP_SECRET_ENV_VAR),
    configurationIdConfigured: !resolution.missing.includes(CONFIG_ID_ENV_VAR),
    ready: false,
    missing: resolution.missing,
    callbackUrl:
      resolveMetaOnboardingCallbackUrl(() => deps.getEnvVar(APP_URL_ENV_VAR)) ??
      null,
  };
}

const defaultEnvDeps: MetaOnboardingConfigDeps = {
  getEnvVar: (name) => process.env[name],
};

/**
 * Production singleton — adapter-side only. The onboarding feature and
 * the domain never import this; they keep talking to the
 * provider-neutral `ConnectionAuthorizer` port.
 */
export const defaultMetaOnboardingConfigDeps: MetaOnboardingConfigDeps =
  defaultEnvDeps;
