import path from "node:path";

import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Match Next.js env precedence: .env.local overrides .env (when present).
// dotenv never overrides variables that are already set, so order is all
// that matters. Existing process.env values (CI secrets) always win.
loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
    // Optional (PROMPT-ARCH-03): shadow database for `prisma migrate dev`
    // and `migrate diff --from-migrations` — Prisma 7 requires it when a
    // migrations directory is involved and the main-database user cannot
    // CREATE DATABASE (typical on Neon). No-op unless the env var is set.
    ...(process.env.SHADOW_DATABASE_URL && {
      shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
    }),
  },
});
