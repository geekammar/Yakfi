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
        userCount: users.length,
        users,
        accountCount: accounts.length,
        accounts,
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
    environment: process.env.NODE_ENV ?? "development",
    timestamp: new Date().toISOString(),
    deploymentReady,
    database,
    missingEnvVars,
    ...(previewDiagnostics ? { previewDiagnostics } : {}),
  });
}
