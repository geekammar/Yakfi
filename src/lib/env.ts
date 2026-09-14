import { z } from "zod";

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
  INBOUND_WEBHOOK_TOKEN: z.string().min(32).optional(),
  /**
   * AI provider API keys (PROMPT-OPS-05) — environment-backed SECRETS,
   * optional until the provider integration phase. They are NEVER
   * stored in the database, returned by any API, or logged: the
   * platform AI policy carries only their reference NAMES
   * (OPENROUTER_API_KEY / AGENTROUTER_API_KEY). Local development:
   * .env.local; production: Vercel Environment Variables (a key change
   * requires redeploy in the current deployment model).
   */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  AGENTROUTER_API_KEY: z.string().min(1).optional(),
});

const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
});

const parsedServer = serverEnvSchema.safeParse({
  DATABASE_URL: process.env.DATABASE_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
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
