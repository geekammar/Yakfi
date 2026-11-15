#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { resolveMasterKey } from "../src/server/credentials/credential-crypto";
import { validateDatabaseUrl } from "../src/server/credentials/test-bot-recovery";

export const PROJECT_ID = "prj_CjKh6Qt6IAKEc9EB4StaJJxnP0Fp";
export const TARGET_ENVIRONMENT = "production";
export const TARGET_KEYS = ["DATABASE_URL", "CREDENTIAL_MASTER_KEY"] as const;

export type TargetKey = (typeof TARGET_KEYS)[number];
export type Operation = "preflight" | "apply";

export type VercelEnv = {
  id?: unknown;
  key?: unknown;
  target?: unknown;
  gitBranch?: unknown;
  customEnvironmentId?: unknown;
  type?: unknown;
};

type Deps = {
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
};

function requireString(value: string | undefined, code: string): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(code);
  return trimmed;
}

function assertExactSha(expected: string, actual: string): void {
  if (!/^[0-9a-f]{40}$/.test(expected) || expected !== actual) {
    throw new Error("COMMIT_SHA_MISMATCH");
  }
}

function targetList(env: VercelEnv): unknown[] {
  if (Array.isArray(env.target)) return env.target;
  return env.target === undefined ? [] : [env.target];
}

export function findProductionRecord(
  envs: VercelEnv[],
  key: TargetKey,
): VercelEnv {
  const keyRecords = envs.filter((env) => env.key === key);
  const mixedScope = keyRecords.filter(
    (env) =>
      targetList(env).includes(TARGET_ENVIRONMENT) &&
      targetList(env).length > 1,
  );
  if (mixedScope.length > 0) {
    throw new Error(`MIXED_SCOPE_${key}_RECORD`);
  }
  const matches = keyRecords.filter(
    (env) =>
      targetList(env).length === 1 &&
      targetList(env)[0] === TARGET_ENVIRONMENT &&
      !env.gitBranch &&
      !env.customEnvironmentId,
  );
  if (matches.length === 0) {
    throw new Error(`MISSING_${key}_PRODUCTION_RECORD`);
  }
  if (matches.length > 1) {
    throw new Error(`AMBIGUOUS_${key}_PRODUCTION_RECORD`);
  }
  return matches[0]!;
}

function validateSourcePair(
  values: Partial<Record<TargetKey, string | undefined>>,
): {
  DATABASE_URL: string;
  CREDENTIAL_MASTER_KEY: string;
} {
  const databaseUrl = requireString(
    values.DATABASE_URL,
    "MISSING_DATABASE_URL",
  );
  const masterKey = requireString(
    values.CREDENTIAL_MASTER_KEY,
    "MISSING_CREDENTIAL_MASTER_KEY",
  );
  try {
    validateDatabaseUrl(databaseUrl);
  } catch (error: unknown) {
    if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) {
      throw new Error(error.message);
    }
    throw new Error("DATABASE_TARGET_NOT_AUTHORIZED");
  }
  const resolved = resolveMasterKey(masterKey);
  if (!resolved.ok) {
    throw new Error("MASTER_KEY_UNAVAILABLE_OR_INVALID");
  }
  resolved.key.fill(0);
  return {
    DATABASE_URL: databaseUrl,
    CREDENTIAL_MASTER_KEY: masterKey,
  };
}

async function listProjectEnvs(
  token: string,
  fetchImpl: typeof fetch,
): Promise<VercelEnv[]> {
  const response = await fetchImpl(
    `https://api.vercel.com/v10/projects/${PROJECT_ID}/env?decrypt=false`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    throw new Error(`VERCEL_ENV_LIST_FAILED_${response.status}`);
  }
  const body = (await response.json()) as { envs?: unknown };
  if (!Array.isArray(body.envs)) {
    throw new Error("VERCEL_ENV_LIST_MALFORMED");
  }
  return body.envs as VercelEnv[];
}

async function updateEnvRecord(
  token: string,
  record: VercelEnv,
  value: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  if (typeof record.id !== "string" || !record.id) {
    throw new Error("VERCEL_ENV_RECORD_ID_MISSING");
  }
  const response = await fetchImpl(
    `https://api.vercel.com/v9/projects/${PROJECT_ID}/env/${record.id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        value,
        type: "sensitive",
        target: [TARGET_ENVIRONMENT],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    throw new Error(`VERCEL_ENV_UPDATE_FAILED_${response.status}`);
  }
}

export async function runUpdateProductionRuntimeEnv(
  params: {
    operation: Operation;
    expectedSha: string;
    githubSha: string;
    token?: string;
    values: Partial<Record<TargetKey, string | undefined>>;
  },
  deps: Deps = {},
): Promise<void> {
  const log = deps.log ?? console.log;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const expectedSha = requireString(
    params.expectedSha,
    "EXPECTED_COMMIT_SHA_REQUIRED",
  );
  const githubSha = requireString(params.githubSha, "GITHUB_SHA_REQUIRED");
  assertExactSha(expectedSha, githubSha);
  const token = requireString(params.token, "VERCEL_TOKEN_UNAVAILABLE");
  const values = validateSourcePair(params.values);

  const envs = await listProjectEnvs(token, fetchImpl);
  const records = TARGET_KEYS.map((key) => ({
    key,
    record: findProductionRecord(envs, key),
  }));

  if (params.operation === "preflight") {
    for (const { key } of records) {
      log(`PREFLIGHT_OK key=${key} scope=${TARGET_ENVIRONMENT}`);
    }
    return;
  }
  if (params.operation !== "apply") {
    throw new Error("INVALID_OPERATION");
  }

  for (const { key, record } of records) {
    const value = values[key];
    try {
      await updateEnvRecord(token, record, value, fetchImpl);
    } catch {
      log(`PARTIAL_ENV_UPDATE key=${key}`);
      throw new Error(`PARTIAL_ENV_UPDATE_${key}`);
    }
    log(`UPDATED key=${key} scope=${TARGET_ENVIRONMENT}`);
  }

  const verified = await listProjectEnvs(token, fetchImpl);
  for (const key of TARGET_KEYS) {
    const record = findProductionRecord(verified, key);
    if (record.type !== "sensitive") {
      throw new Error(`VERIFIED_${key}_NOT_SENSITIVE`);
    }
    log(`METADATA_VERIFIED key=${key} scope=${TARGET_ENVIRONMENT}`);
  }
  log(`APPLY_OK keys=${TARGET_KEYS.join(",")} scope=${TARGET_ENVIRONMENT}`);
}

async function main(): Promise<void> {
  try {
    const operation = process.env.OPERATION?.trim();
    if (operation !== "preflight" && operation !== "apply") {
      throw new Error("INVALID_OPERATION");
    }
    await runUpdateProductionRuntimeEnv({
      operation,
      expectedSha: process.env.EXPECTED_COMMIT_SHA ?? "",
      githubSha: process.env.GITHUB_SHA ?? "",
      token: process.env.VERCEL_TOKEN,
      values: {
        DATABASE_URL: process.env.DATABASE_URL,
        CREDENTIAL_MASTER_KEY: process.env.CREDENTIAL_MASTER_KEY,
      },
    });
  } catch (error: unknown) {
    const code =
      error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "UNEXPECTED_ENV_UPDATE_FAILURE";
    console.error(`::error::${code}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
