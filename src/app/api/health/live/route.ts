import { resolveRuntimeCommitSha } from "@/lib/runtime-identity";

import pkg from "../../../../../package.json";

export const dynamic = "force-dynamic";

/**
 * Lightweight process liveness probe (`/api/health/live`).
 *
 * Performs ZERO database queries so frequent platform liveness probes (e.g.
 * Render's ~5-second healthCheckPath) verify HTTP server responsiveness without
 * keeping Neon PostgreSQL continuously awake or preventing idle suspension.
 *
 * Explicit deployment + database readiness remains at `/api/health`.
 */
export async function GET() {
  return Response.json(
    {
      status: "ok",
      live: true,
      version: pkg.version,
      commitSha: resolveRuntimeCommitSha(),
      environment: process.env.NODE_ENV ?? "development",
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
