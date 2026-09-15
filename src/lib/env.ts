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
  WHATSAPP_META_API_VERSION: z.preprocess(
    emptyToUndefined,
    z.string().min(1).optional(),
  ),
});

const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
});

const parsedServer = serverEnvSchema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  INBOUND_WEBHOOK_TOKEN: process.env.INBOUND_WEBHOOK_TOKEN,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  AGENTROUTER_API_KEY: process.env.AGENTROUTER_API_KEY,
  WHATSAPP_META_VERIFY_TOKEN: process.env.WHATSAPP_META_VERIFY_TOKEN,
  WHATSAPP_META_APP_SECRET: process.env.WHATSAPP_META_APP_SECRET,
  WHATSAPP_META_ACCESS_TOKEN: process.env.WHATSAPP_META_ACCESS_TOKEN,
  WHATSAPP_META_PHONE_NUMBER_ID: process.env.WHATSAPP_META_PHONE_NUMBER_ID,
  WHATSAPP_META_API_VERSION: process.env.WHATSAPP_META_API_VERSION,
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
