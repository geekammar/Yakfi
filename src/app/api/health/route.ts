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

      // Health checks are read-only. Schema changes and account provisioning
      // belong to explicit, reviewed operator workflows, never a public GET.
      const migrations = await db.$queryRaw<Array<{ migration_name: string }>>`
        SELECT migration_name FROM "_prisma_migrations"
        WHERE migration_name = '20261108200000_safe_telegram_staff_reply_delivery'
          AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        LIMIT 1
      `;
      const [userCount, accountCount, testUser] = await Promise.all([
        db.user.count(),
        db.account.count(),
        db.user.findUnique({
          where: { email: "preview.admin@flowpilot.app" },
          select: {
            id: true,
            isActive: true,
            role: true,
            accountType: true,
            businessId: true,
          },
        }),
      ]);
      const testAccountCount = testUser
        ? await db.account.count({
            where: {
              userId: testUser.id,
              providerId: "credential",
              password: { not: null },
            },
          })
        : 0;

      previewDiagnostics = {
        dbHost,
        isProductionDb,
        migrationApplied: migrations.length === 1,
        userCount,
        accountCount,
        previewTestAccountReady: Boolean(
          testUser?.isActive &&
          testUser.role === "ADMIN" &&
          testUser.accountType === "BUSINESS" &&
          testUser.businessId &&
          testAccountCount > 0,
        ),
      };
    } catch {
      previewDiagnostics = { error: "PREVIEW_DIAGNOSTICS_UNAVAILABLE" };
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
