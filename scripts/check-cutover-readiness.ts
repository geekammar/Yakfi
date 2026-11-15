import {
  CUTOVER_READINESS_BOT_ID,
  CUTOVER_READINESS_BOT_USERNAME,
  CUTOVER_READINESS_BUSINESS_ID,
  CUTOVER_READINESS_CONNECTION_ID,
  checkCutoverReadiness,
  signCutoverReadiness,
} from "../src/server/operator/cutover-readiness";
import type { TelegramConnection } from "../src/types/domain";

const checks: Array<{ label: string; pass: boolean }> = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const NOW = 1_700_000_000_000;
const TOKEN = ["8926541123", "cutover", "token", "sentinel"].join(":");
const DATABASE_URL = [
  "postgresql",
  "://user:pass@",
  "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech",
  "/neondb?sslmode=require",
].join("");
const timestamp = String(NOW);
const signature = signCutoverReadiness(
  TOKEN,
  timestamp,
  CUTOVER_READINESS_BOT_ID,
);

const connection = {
  id: CUTOVER_READINESS_CONNECTION_ID,
  businessId: CUTOVER_READINESS_BUSINESS_ID,
  botExternalId: CUTOVER_READINESS_BOT_ID,
  botUsername: CUTOVER_READINESS_BOT_USERNAME,
  status: "CONNECTED",
  isActive: true,
  deletedAt: null,
  credentialsRef: "fp:725da53e-e346-4a3c-a083-fc8a3bae7f37",
} as unknown as TelegramConnection;

function request(headers: Record<string, string> = {}): Request {
  return new Request(
    "https://flowpilot-prod.vercel.app/api/operator/cutover-readiness",
    { headers },
  );
}

function validHeaders(): Record<string, string> {
  return {
    "x-flowpilot-cutover-bot-id": CUTOVER_READINESS_BOT_ID,
    "x-flowpilot-cutover-timestamp": timestamp,
    "x-flowpilot-cutover-signature": signature,
  };
}

async function main(): Promise<void> {
  let connectionCalls = 0;
  let resolveCalls = 0;
  let getMeCalls = 0;
  const deps = {
    connectionRepository: {
      async findByIdWithinBusiness() {
        connectionCalls += 1;
        return connection;
      },
    },
    credentialsResolver: {
      async resolve() {
        resolveCalls += 1;
        return {
          ok: true as const,
          kind: "RUNTIME" as const,
          reference: "fp:725da53e-e346-4a3c-a083-fc8a3bae7f37",
          value: TOKEN,
        };
      },
    },
    getMe: async () => {
      getMeCalls += 1;
      return {
        ok: true as const,
        result: {
          id: Number(CUTOVER_READINESS_BOT_ID),
          is_bot: true,
          username: CUTOVER_READINESS_BOT_USERNAME,
        },
      };
    },
    getEnvVar: (name: string) =>
      name === "DATABASE_URL" ? DATABASE_URL : undefined,
    now: () => NOW,
  };

  const missing = await checkCutoverReadiness(
    request(),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    deps,
  );
  check(
    "C1. Missing cutover signature headers fail closed before DB access",
    missing.status === 401 &&
      missing.body.code === "UNAUTHORIZED" &&
      connectionCalls === 0 &&
      resolveCalls === 0 &&
      getMeCalls === 0,
  );

  const wrongBot = await checkCutoverReadiness(
    request({ ...validHeaders(), "x-flowpilot-cutover-bot-id": "999999999" }),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    deps,
  );
  check(
    "C2. Wrong fixed bot ID is rejected before DB access",
    wrongBot.status === 403 &&
      wrongBot.body.code === "FORBIDDEN" &&
      connectionCalls === 0,
  );

  const stale = await checkCutoverReadiness(
    request({ ...validHeaders(), "x-flowpilot-cutover-timestamp": String(NOW - 300_000) }),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    deps,
  );
  check(
    "C3. Stale timestamp is rejected before DB access",
    stale.status === 401 &&
      stale.body.code === "STALE_OR_INVALID_TIMESTAMP" &&
      connectionCalls === 0,
  );

  const missingDatabase = await checkCutoverReadiness(
    request(validHeaders()),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    { ...deps, getEnvVar: () => undefined },
  );
  check(
    "C4. Missing runtime DATABASE_URL fails closed",
    missingDatabase.status === 503 &&
      missingDatabase.body.code === "DATABASE_UNAVAILABLE" &&
      connectionCalls === 0,
  );

  const missingConnection = await checkCutoverReadiness(
    request(validHeaders()),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    {
      ...deps,
      connectionRepository: {
        async findByIdWithinBusiness() {
          connectionCalls += 1;
          return null;
        },
      },
    },
  );
  check(
    "C5. Missing fixed business/connection fails closed",
    missingConnection.status === 503 &&
      missingConnection.body.code === "FIXED_CONNECTION_NOT_READY",
  );

  const unresolved = await checkCutoverReadiness(
    request(validHeaders()),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    {
      ...deps,
      credentialsResolver: {
        async resolve() {
          resolveCalls += 1;
          return {
            ok: false as const,
            code: "UNRESOLVED_REFERENCE" as const,
            message: "unavailable",
          };
        },
      },
    },
  );
  check(
    "C6. Unresolved application credential fails closed without getMe",
    unresolved.status === 503 &&
      unresolved.body.code === "CREDENTIAL_UNRESOLVED" &&
      getMeCalls === 0,
  );

  const badSignature = await checkCutoverReadiness(
    request({ ...validHeaders(), "x-flowpilot-cutover-signature": "0".repeat(64) }),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    deps,
  );
  check(
    "C7. Invalid signature is rejected before getMe",
    badSignature.status === 401 &&
      badSignature.body.code === "UNAUTHORIZED" &&
      getMeCalls === 0,
  );

  const valid = await checkCutoverReadiness(
    request(validHeaders()),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    deps,
  );
  const serialized = JSON.stringify(valid.body);
  check(
    "C8. Valid signed request proves runtime DB/credential/bot binding with bounded output",
    valid.status === 200 &&
      valid.body.ok === true &&
      valid.body.databaseHost ===
        "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech" &&
      valid.body.databaseName === "neondb" &&
      valid.body.businessId === CUTOVER_READINESS_BUSINESS_ID &&
      valid.body.connectionId === CUTOVER_READINESS_CONNECTION_ID &&
      valid.body.credentialResolved === true &&
      valid.body.commitSha === "a".repeat(40) &&
      valid.body.version === "0.79.10" &&
      getMeCalls === 1 &&
      !serialized.includes(TOKEN) &&
      !serialized.includes("fp:725da53e"),
  );

  const wrongIdentity = await checkCutoverReadiness(
    request(validHeaders()),
    { commitSha: "a".repeat(40), version: "0.79.10" },
    {
      ...deps,
      getMe: async () => ({
        ok: true as const,
        result: { id: 999999999, is_bot: true, username: "OtherBot" },
      }),
    },
  );
  check(
    "C9. Provider identity mismatch fails closed",
    wrongIdentity.status === 503 &&
      wrongIdentity.body.code === "BOT_IDENTITY_UNRESOLVED",
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
  console.log(`\nAll ${checks.length}/${checks.length} cutover readiness checks PASSED.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
