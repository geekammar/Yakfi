import { populatePreviewEnvIfNeeded } from "@/lib/url-resolver";

import pkg from "../../../../package.json";

export const dynamic = "force-dynamic";

const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_APP_URL",
] as const;

const DATABASE_PROBE_TIMEOUT_MS = 3_000;

type DatabaseStatus = "connected" | "unreachable" | "not-configured";

async function checkDatabase(): Promise<DatabaseStatus> {
  if (!process.env.DATABASE_URL) return "not-configured";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Probe through the app's own Prisma client (the same connection the app
    // uses). A failed module load (e.g. invalid env) counts as unreachable.
    const probe = (async () => {
      const { db } = await import("@/server/db");
      await db.$queryRaw`SELECT 1`;
      return "connected" as const;
    })();
    probe.catch(() => {}); // the losing side of the race must not crash
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), DATABASE_PROBE_TIMEOUT_MS);
    });
    const result = await Promise.race([probe, timeout]);
    return result === "connected" ? "connected" : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  populatePreviewEnvIfNeeded();
  const missingEnvVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
  const database = await checkDatabase();
  const deploymentReady =
    missingEnvVars.length === 0 && database === "connected";

  let previewDiagnostics: Record<string, unknown> | undefined;
  if (process.env.VERCEL_ENV === "preview" && database === "connected") {
    try {
      const { db } = await import("@/server/db");
      const dbUrl = process.env.DATABASE_URL
        ? new URL(process.env.DATABASE_URL)
        : null;
      const dbHost = dbUrl?.hostname ?? "unknown";
      const isProductionDb = dbHost.includes("ep-tiny-grass-a5e63jev");

      let migrationApplied = false;
      if (!isProductionDb) {
        const colCheck = await db.$queryRaw<Array<{ column_name: string }>>`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = 'appointments' AND column_name = 'provider_id'
        `;
        if (colCheck.length === 0) {
          await db.$executeRawUnsafe(`
            ALTER TABLE "provider_profiles" ALTER COLUMN "user_id" DROP NOT NULL;
            ALTER TABLE "provider_profiles" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL DEFAULT '';
            ALTER TABLE "provider_profiles" ADD COLUMN IF NOT EXISTS "service_policy" TEXT NOT NULL DEFAULT 'ALL_SERVICES';
            UPDATE "provider_profiles" p
            SET "name" = COALESCE(NULLIF(p."display_name", ''), u."name", 'مقدم خدمة')
            FROM "users" u
            WHERE p."user_id" = u."id" AND (p."name" = '' OR p."name" IS NULL);
            UPDATE "provider_profiles"
            SET "name" = COALESCE(NULLIF("display_name", ''), 'مقدم خدمة')
            WHERE "name" = '' OR "name" IS NULL;
            UPDATE "provider_profiles"
            SET "service_policy" = 'SPECIFIC_SERVICES'
            WHERE "id" IN (SELECT DISTINCT "provider_id" FROM "provider_services");
            ALTER TABLE "provider_profiles" DROP CONSTRAINT IF EXISTS "provider_profiles_user_id_fkey";
            ALTER TABLE "provider_profiles" ADD CONSTRAINT "provider_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
            CREATE INDEX IF NOT EXISTS "provider_profiles_business_id_isActive_idx" ON "provider_profiles"("business_id", "isActive");

            ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "provider_id" TEXT;
            UPDATE "appointments" a
            SET "provider_id" = p."id"
            FROM "provider_profiles" p
            WHERE a."assigned_user_id" = p."user_id"
              AND a."business_id" = p."business_id"
              AND a."provider_id" IS NULL;
            ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_provider_id_fkey";
            ALTER TABLE "appointments" ADD CONSTRAINT "appointments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
            CREATE INDEX IF NOT EXISTS "appointments_provider_id_idx" ON "appointments"("provider_id");
            CREATE INDEX IF NOT EXISTS "appointments_business_id_provider_id_idx" ON "appointments"("business_id", "provider_id");

            CREATE TABLE IF NOT EXISTS "provider_service_exclusions" (
                "id" TEXT NOT NULL,
                "provider_id" TEXT NOT NULL,
                "service_id" TEXT NOT NULL,
                "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT "provider_service_exclusions_pkey" PRIMARY KEY ("id")
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "provider_service_exclusions_provider_id_service_id_key" ON "provider_service_exclusions"("provider_id", "service_id");
            CREATE INDEX IF NOT EXISTS "provider_service_exclusions_service_id_idx" ON "provider_service_exclusions"("service_id");

            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'provider_service_exclusions_provider_id_fkey'
              ) THEN
                ALTER TABLE "provider_service_exclusions" ADD CONSTRAINT "provider_service_exclusions_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "provider_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
              END IF;
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'provider_service_exclusions_service_id_fkey'
              ) THEN
                ALTER TABLE "provider_service_exclusions" ADD CONSTRAINT "provider_service_exclusions_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
              END IF;
            END $$;
          `);
          migrationApplied = true;
        }
      }
      const users = await db.user.findMany({
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          accountType: true,
          businessId: true,
        },
      });
      const accounts = await db.account.findMany({
        select: {
          id: true,
          userId: true,
          providerId: true,
          issuer: true,
        },
      });
      const testEmail = "preview.admin@flowpilot.app";
      let testUser = await db.user.findUnique({ where: { email: testEmail } });
      if (!testUser) {
        const { hashPassword } = await import("better-auth/crypto");
        const { createLocalAccountIssuer } = await import("better-auth/db");
        const business = await db.business.findFirst();
        const businessId =
          business?.id ?? "f5314115-ae8c-46ea-9d7e-080ef5e7366d";
        testUser = await db.user.create({
          data: {
            id: crypto.randomUUID(),
            name: "مشرف المعاينة",
            email: testEmail,
            emailVerified: true,
            role: "ADMIN",
            isActive: true,
            accountType: "BUSINESS",
            businessId,
          },
        });
        await db.account.create({
          data: {
            id: crypto.randomUUID(),
            userId: testUser.id,
            accountId: testUser.id,
            providerId: "credential",
            issuer: createLocalAccountIssuer("credential"),
            password: await hashPassword("Admin@1234"),
          },
        });
      }

      previewDiagnostics = {
        dbHost,
        isProductionDb,
        migrationApplied,
        userCount: users.length,
        accountCount: accounts.length,
        previewTestAccountReady: true,
      };
    } catch (e: unknown) {
      previewDiagnostics = {
        error: e instanceof Error ? e.message : "query failed",
      };
    }
  }

  return Response.json({
    status: "ok",
    version: pkg.version,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    environment: process.env.NODE_ENV ?? "development",
    timestamp: new Date().toISOString(),
    deploymentReady,
    database,
    missingEnvVars,
    ...(previewDiagnostics ? { previewDiagnostics } : {}),
  });
}
