import { populatePreviewEnvIfNeeded } from "./url-resolver";
import { z } from "zod";

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const serverEnvSchema = z.object({
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  /**
   * Shared secret gating the provider-neutral inbound webhook
   * (PROMPT-19). Optional: when unset the inbound route is DISABLED
   * (503) — no unauthenticated message can enter the system. A real
   * provider adapter verifies its own provider signatures and either
   * holds this token or calls the engine service directly.
   */
  INBOUND_WEBHOOK_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(32).optional(),
  ),
  /**
   * Secret gating the operator test ingress (PROMPT-AI-JEV-03F-I).
   * Optional: when unset and INBOUND_WEBHOOK_TOKEN is also unset, the
   * test ingress route is DISABLED (503).
   */
  FLOWPILOT_TEST_INGRESS_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(32).optional(),
  ),
  /**
   * AI provider API keys (PROMPT-OPS-05) — environment-backed SECRETS,
   * optional until the provider integration phase. They are NEVER
   * stored in the database, returned by any API, or logged: the
   * platform AI policy carries only their reference NAMES
   * (OPENROUTER_API_KEY / AGENTROUTER_API_KEY). Local development:
   * .env.local; production: Vercel Environment Variables (a key change
   * requires redeploy in the current deployment model).
   */
  OPENROUTER_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  AGENTROUTER_API_KEY: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  /**
   * Meta WhatsApp Cloud API — server-side secrets (PROMPT-CORE-03B;
   * Decision #42). All are OPTIONAL until a Business connects a real
   * WhatsApp number — no code path requires them at boot. They are
   * NEVER stored in DB rows, returned by APIs, or logged: the inbound
   * webhook uses the verify token + app secret at the adapter boundary,
   * the outbound adapter resolves the per-connection access token from
   * `WhatsAppConnection.credentialsRef` (an env-var NAME) falling back
   * to the global `WHATSAPP_META_ACCESS_TOKEN`.
   */
  WHATSAPP_META_VERIFY_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(8).optional(),
  ),
  WHATSAPP_META_APP_SECRET: z.preprocess(
    emptyToUndefined,
    z.string().min(8).optional(),
  ),
  WHATSAPP_META_ACCESS_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(8).optional(),
  ),
  WHATSAPP_META_PHONE_NUMBER_ID: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  WHATSAPP_META_APP_ID: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  /**
   * Meta Embedded Signup configuration id (WHATSAPP-ONBOARDING-01;
   * DECISIONS #47) — the `config_id` the Meta App's Embedded Signup
   * configuration is launched against. Server-side CONFIGURATION
   * METADATA: non-secret, but operator-owned (created in the Meta App
   * Dashboard) and never embedded in a client bundle. Optional at boot
   * — no code path requires it to start; it is a prerequisite of the
   * real Meta adapter, which falls back to the deterministic stand-in
   * while it is unset (never an invented value).
   */
  WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  WHATSAPP_META_API_VERSION: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
  /**
   * RUNTIME credential store master encryption key (WHATSAPP-ONBOARDING-01;
   * DECISIONS #49). OPTIONAL: while it is unset, the runtime credential
   * store stays UNAVAILABLE (every store/resolve of a `fp:<id>` reference
   * fails closed) and the existing ENV reference grammar is completely
   * unaffected — so the app boots and runs without it.
   *
   * It is the ONLY place the plaintext-encryption key lives: never stored
   * in the database, never logged, never returned by an API, never
   * projected to the platform UI, and never prefixed with NEXT_PUBLIC_.
   * Value = 32 random bytes encoded as hex (64 chars) or base64 (44 chars);
   * the exact 32-byte decode is enforced lazily by the credential store
   * (a malformed key reports a safe error and never echoes the value).
   * Rotation is a later operational concern (see cipher `key_version`).
   */
  CREDENTIAL_MASTER_KEY: z.preprocess(
    emptyToUndefined,
    z.string().min(32).optional(),
  ),
  /**
   * FlowPilot TELEGRAM MANAGER BOT token (DECISIONS #63 — the second
   * channel; Telegram Managed Bots). Server-side SECRET, optional until a
   * Business provisions a Telegram bot: the ONE-TIME operator setup
   * creates the Manager Bot via @BotFather, enables "Bot Management Mode",
   * and sets this value. It is the ONLY token that may call
   * `getManagedBotToken` / `replaceManagedBotToken`, and it is an
   * operator-level secret — it is NEVER stored in the database, NEVER
   * returned by any API, NEVER logged, NEVER exposed to the browser, and
   * NEVER prefixed with NEXT_PUBLIC_. Managed customer bot tokens are
   * stored only as opaque `fp:<id>` RUNTIME references (DECISIONS #49).
   */
  TELEGRAM_MANAGER_BOT_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
});

const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
});

populatePreviewEnvIfNeeded();

const parsedServer = serverEnvSchema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  INBOUND_WEBHOOK_TOKEN: process.env.INBOUND_WEBHOOK_TOKEN,
  FLOWPILOT_TEST_INGRESS_TOKEN: process.env.FLOWPILOT_TEST_INGRESS_TOKEN,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  AGENTROUTER_API_KEY: process.env.AGENTROUTER_API_KEY,
  WHATSAPP_META_VERIFY_TOKEN: process.env.WHATSAPP_META_VERIFY_TOKEN,
  WHATSAPP_META_APP_SECRET: process.env.WHATSAPP_META_APP_SECRET,
  WHATSAPP_META_ACCESS_TOKEN: process.env.WHATSAPP_META_ACCESS_TOKEN,
  WHATSAPP_META_PHONE_NUMBER_ID: process.env.WHATSAPP_META_PHONE_NUMBER_ID,
  WHATSAPP_META_APP_ID: process.env.WHATSAPP_META_APP_ID,
  WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID:
    process.env.WHATSAPP_META_EMBEDDED_SIGNUP_CONFIG_ID,
  WHATSAPP_META_API_VERSION: process.env.WHATSAPP_META_API_VERSION,
  CREDENTIAL_MASTER_KEY: process.env.CREDENTIAL_MASTER_KEY,
  TELEGRAM_MANAGER_BOT_TOKEN: process.env.TELEGRAM_MANAGER_BOT_TOKEN,
});

if (!parsedServer.success) {
  console.error(
    "❌ Invalid server environment variables:\n" +
      z.prettifyError(parsedServer.error),
  );
  throw new Error("Invalid server environment variables");
}

const parsedClient = clientEnvSchema.safeParse({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

if (!parsedClient.success) {
  console.error(
    "❌ Invalid client environment variables:\n" +
      z.prettifyError(parsedClient.error),
  );
  throw new Error("Invalid client environment variables");
}

export const env = {
  ...parsedServer.data,
  ...parsedClient.data,
};

export type Env = typeof env;
