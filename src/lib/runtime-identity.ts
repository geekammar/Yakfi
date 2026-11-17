/**
 * Platform-neutral runtime commit and environment resolvers.
 *
 * Supports Render (`RENDER_GIT_COMMIT`, `RENDER`) and Vercel
 * (`VERCEL_GIT_COMMIT_SHA`, `VERCEL_ENV`) without hardcoding a single vendor.
 */

export type RuntimeEnvMap = Record<string, string | undefined>;

export function resolveRuntimeCommitSha(
  env: RuntimeEnvMap = process.env,
): string | null {
  const renderSha = env.RENDER_GIT_COMMIT?.trim();
  if (renderSha) {
    return renderSha;
  }

  const vercelSha = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (vercelSha) {
    return vercelSha;
  }

  return null;
}

export function isRenderProductionRuntime(
  env: RuntimeEnvMap = process.env,
): boolean {
  return env.RENDER === "true" && env.RENDER_IS_PULL_REQUEST !== "true";
}

export function resolveRuntimeEnvironmentLabel(
  env: RuntimeEnvMap = process.env,
): string {
  if (env.VERCEL_ENV) {
    return env.VERCEL_ENV;
  }
  if (env.RENDER === "true") {
    return env.RENDER_IS_PULL_REQUEST === "true" ? "preview" : "production";
  }
  return env.NODE_ENV ?? "unknown";
}
