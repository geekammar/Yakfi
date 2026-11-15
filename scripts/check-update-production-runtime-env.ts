import {
  findProductionRecord,
  runUpdateProductionRuntimeEnv,
  type TargetKey,
  type VercelEnv,
} from "./update-production-runtime-env";

const checks: Array<{ label: string; pass: boolean }> = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const AUTH_SENTINEL = ["vercel", "token", "regression", "only"].join("-");
const DATABASE_VALUE = [
  "postgresql",
  "://user:db-secret-sentinel@",
  "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech",
  "/neondb?sslmode=require",
].join("");
const MASTER_VALUE = ["a1b2", "c3d4", "e5f6", "0718"].join("").repeat(4);

type RecordShape = VercelEnv & {
  id: string;
  key: string;
  target: string[];
  type: string;
};

function baseEnvs(): RecordShape[] {
  return [
    {
      id: "env-db-production",
      key: "DATABASE_URL",
      target: ["production"],
      gitBranch: null,
      customEnvironmentId: null,
      type: "sensitive",
    },
    {
      id: "env-key-production",
      key: "CREDENTIAL_MASTER_KEY",
      target: ["production"],
      gitBranch: null,
      customEnvironmentId: null,
      type: "sensitive",
    },
    {
      id: "env-db-preview",
      key: "DATABASE_URL",
      target: ["preview"],
      gitBranch: null,
      customEnvironmentId: null,
      type: "sensitive",
    },
    {
      id: "env-key-old-preview",
      key: "CREDENTIAL_MASTER_KEY",
      target: ["preview"],
      gitBranch: "fix/safe-telegram-staff-reply-delivery",
      customEnvironmentId: null,
      type: "sensitive",
    },
    {
      id: "env-unrelated",
      key: "OPENROUTER_API_KEY",
      target: ["production"],
      gitBranch: null,
      customEnvironmentId: null,
      type: "sensitive",
    },
  ];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function main(): Promise<void> {
  check(
    "P1. Only exactly one non-branch Production record is selected per target key",
    findProductionRecord(baseEnvs(), "DATABASE_URL").id ===
      "env-db-production" &&
      findProductionRecord(baseEnvs(), "CREDENTIAL_MASTER_KEY").id ===
        "env-key-production",
  );

  for (const fixture of [
    {
      label: "P2. Missing Production record fails closed",
      envs: baseEnvs().filter((e) => e.id !== "env-db-production"),
      key: "DATABASE_URL" as TargetKey,
      code: "MISSING_DATABASE_URL_PRODUCTION_RECORD",
    },
    {
      label: "P3. Duplicate Production records fail closed",
      envs: [
        ...baseEnvs(),
        {
          id: "env-db-production-duplicate",
          key: "DATABASE_URL",
          target: ["production"],
          gitBranch: null,
          customEnvironmentId: null,
          type: "sensitive",
        },
      ],
      key: "DATABASE_URL" as TargetKey,
      code: "AMBIGUOUS_DATABASE_URL_PRODUCTION_RECORD",
    },
  ]) {
    let code = "";
    try {
      findProductionRecord(fixture.envs, fixture.key);
    } catch (error: unknown) {
      code = error instanceof Error ? error.message : "";
    }
    check(fixture.label, code === fixture.code);
  }

  const shaCalls: string[] = [];
  const shaDeps = {
    fetchImpl: async (input: RequestInfo | URL) => {
      shaCalls.push(String(input));
      return jsonResponse({ envs: baseEnvs() });
    },
  };
  let shaCode = "";
  try {
    await runUpdateProductionRuntimeEnv(
      {
        operation: "preflight",
        expectedSha: SHA,
        githubSha: OTHER_SHA,
        token: AUTH_SENTINEL,
        values: {
          DATABASE_URL: DATABASE_VALUE,
          CREDENTIAL_MASTER_KEY: MASTER_VALUE,
        },
      },
      shaDeps,
    );
  } catch (error: unknown) {
    shaCode = error instanceof Error ? error.message : "";
  }
  check(
    "P4. Commit SHA mismatch refuses before any Vercel request",
    shaCode === "COMMIT_SHA_MISMATCH" && shaCalls.length === 0,
  );

  const preflightLines: string[] = [];
  const preflightCalls: Array<{ url: string; init?: RequestInit }> = [];
  await runUpdateProductionRuntimeEnv(
    {
      operation: "preflight",
      expectedSha: SHA,
      githubSha: SHA,
      token: AUTH_SENTINEL,
      values: {
        DATABASE_URL: DATABASE_VALUE,
        CREDENTIAL_MASTER_KEY: MASTER_VALUE,
      },
    },
    {
      log: (line) => preflightLines.push(line),
      fetchImpl: async (input, init) => {
        preflightCalls.push({ url: String(input), init });
        return jsonResponse({ envs: baseEnvs() });
      },
    },
  );
  check(
    "P5. Preflight lists metadata only and performs no mutation",
    preflightCalls.length === 1 &&
      preflightCalls[0]!.init?.method === "GET" &&
      preflightLines.includes(
        "PREFLIGHT_OK key=DATABASE_URL scope=production",
      ) &&
      preflightLines.includes(
        "PREFLIGHT_OK key=CREDENTIAL_MASTER_KEY scope=production",
      ) &&
      preflightLines.every(
        (line) =>
          !line.includes("db-secret-sentinel") &&
          !line.includes(MASTER_VALUE),
      ),
  );

  const applyCalls: Array<{ url: string; init?: RequestInit }> = [];
  let applyEnvs = baseEnvs();
  const applyLines: string[] = [];
  await runUpdateProductionRuntimeEnv(
    {
      operation: "apply",
      expectedSha: SHA,
      githubSha: SHA,
      token: AUTH_SENTINEL,
      values: {
        DATABASE_URL: DATABASE_VALUE,
        CREDENTIAL_MASTER_KEY: MASTER_VALUE,
      },
    },
    {
      log: (line) => applyLines.push(line),
      fetchImpl: async (input, init) => {
        const url = String(input);
        applyCalls.push({ url, init });
        if (init?.method === "PATCH") {
          applyEnvs = applyEnvs.map((env) =>
            url.endsWith(String(env.id)) ? { ...env } : env,
          );
        }
        return jsonResponse({ envs: applyEnvs });
      },
    },
  );
  const patches = applyCalls.filter((call) => call.init?.method === "PATCH");
  const patchBodies = patches.map((call) =>
    JSON.parse(String(call.init?.body ?? "{}")),
  );
  check(
    "P6. Apply patches exactly the two Production records and preserves unrelated scopes",
    patches.length === 2 &&
      patches[0]!.url.endsWith("/env/env-db-production") &&
      patches[1]!.url.endsWith("/env/env-key-production") &&
      patchBodies.every(
        (body) =>
          body.type === "sensitive" &&
          Array.isArray(body.target) &&
          body.target.length === 1 &&
          body.target[0] === "production" &&
          !("gitBranch" in body),
      ) &&
      applyLines.includes(
        "APPLY_OK keys=DATABASE_URL,CREDENTIAL_MASTER_KEY scope=production",
      ) &&
      applyLines.every(
        (line) =>
          !line.includes("db-secret-sentinel") &&
          !line.includes(MASTER_VALUE),
      ),
  );

  async function expectZeroMutation(
    label: string,
    params: {
      operation: "preflight" | "apply";
      values: { DATABASE_URL?: string; CREDENTIAL_MASTER_KEY?: string };
      envs?: RecordShape[];
    },
    expectedCode: string,
  ): Promise<void> {
    let calls = 0;
    let patches = 0;
    let code = "";
    try {
      await runUpdateProductionRuntimeEnv(
        {
          operation: params.operation,
          expectedSha: SHA,
          githubSha: SHA,
          token: AUTH_SENTINEL,
          values: params.values,
        },
        {
          log: () => undefined,
          fetchImpl: async (_input, init) => {
            calls += 1;
            if (init?.method === "PATCH") patches += 1;
            return jsonResponse({ envs: params.envs ?? baseEnvs() });
          },
        },
      );
    } catch (error: unknown) {
      code = error instanceof Error ? error.message : "";
    }
    check(label, code === expectedCode && patches === 0 && calls <= 1);
  }

  await expectZeroMutation(
    "P8. Missing second source value fails before list/PATCH",
    {
      operation: "apply",
      values: { DATABASE_URL: DATABASE_VALUE },
    },
    "MISSING_CREDENTIAL_MASTER_KEY",
  );
  await expectZeroMutation(
    "P9. Invalid selected database target fails before PATCH",
    {
      operation: "apply",
      values: {
        DATABASE_URL: ["postgresql", "://user:pass@", "evil.example", "/neondb?sslmode=require"].join(""),
        CREDENTIAL_MASTER_KEY: MASTER_VALUE,
      },
    },
    "DATABASE_TARGET_NOT_AUTHORIZED",
  );
  await expectZeroMutation(
    "P10. Invalid master-key format fails before PATCH without claiming decryption",
    {
      operation: "apply",
      values: { DATABASE_URL: DATABASE_VALUE, CREDENTIAL_MASTER_KEY: "not-a-valid-key" },
    },
    "MASTER_KEY_UNAVAILABLE_OR_INVALID",
  );
  await expectZeroMutation(
    "P11. Mixed Production/Preview scope is rejected before any PATCH",
    {
      operation: "apply",
      values: { DATABASE_URL: DATABASE_VALUE, CREDENTIAL_MASTER_KEY: MASTER_VALUE },
      envs: [
        ...baseEnvs().filter((e) => e.id !== "env-db-production"),
        {
          id: "env-db-mixed",
          key: "DATABASE_URL",
          target: ["production", "preview"],
          gitBranch: null,
          customEnvironmentId: null,
          type: "sensitive",
        },
      ],
    },
    "MIXED_SCOPE_DATABASE_URL_RECORD",
  );
  await expectZeroMutation(
    "P12. Preflight applies the same source-value validation as apply",
    {
      operation: "preflight",
      values: { DATABASE_URL: DATABASE_VALUE },
    },
    "MISSING_CREDENTIAL_MASTER_KEY",
  );

  const partialCalls: Array<{ url: string; init?: RequestInit }> = [];
  let partialCode = "";
  try {
    await runUpdateProductionRuntimeEnv(
      {
        operation: "apply",
        expectedSha: SHA,
        githubSha: SHA,
        token: AUTH_SENTINEL,
        values: {
          DATABASE_URL: DATABASE_VALUE,
          CREDENTIAL_MASTER_KEY: MASTER_VALUE,
        },
      },
      {
        log: () => undefined,
        fetchImpl: async (input, init) => {
          const url = String(input);
          partialCalls.push({ url, init });
          if (
            init?.method === "PATCH" &&
            url.endsWith("/env/env-key-production")
          ) {
            return jsonResponse({ error: "failed" }, 500);
          }
          return jsonResponse({ envs: baseEnvs() });
        },
      },
    );
  } catch (error: unknown) {
    partialCode = error instanceof Error ? error.message : "";
  }
  check(
    "P7. A partial second update stops once with no automatic retry",
    partialCode === "PARTIAL_ENV_UPDATE_CREDENTIAL_MASTER_KEY" &&
      partialCalls.filter((call) => call.init?.method === "PATCH").length ===
        2 &&
      partialCalls.filter(
        (call) =>
          call.init?.method === "PATCH" &&
          call.url.endsWith("/env/env-key-production"),
      ).length === 1,
  );

  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nFailed ${failed} of ${checks.length} checks.`);
    process.exit(1);
  }
  console.log(
    `\nAll ${checks.length}/${checks.length} production runtime env checks PASSED.`,
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
