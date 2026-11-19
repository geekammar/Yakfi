import { resolveRuntimeCommitSha } from "@/lib/runtime-identity";
import { checkCutoverReadiness } from "@/server/operator/cutover-readiness";

import pkg from "../../../../../package.json";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const outcome = await checkCutoverReadiness(request, {
    commitSha: resolveRuntimeCommitSha(),
    version: pkg.version,
  });
  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { "Cache-Control": "no-store" },
  });
}
