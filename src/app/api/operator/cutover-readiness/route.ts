import pkg from "../../../../../package.json";
import { checkCutoverReadiness } from "@/server/operator/cutover-readiness";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const outcome = await checkCutoverReadiness(request, {
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    version: pkg.version,
  });
  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { "Cache-Control": "no-store" },
  });
}
