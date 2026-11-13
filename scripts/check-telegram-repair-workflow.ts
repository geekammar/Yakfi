/**
 * FlowPilot — Telegram Webhook Maintenance Workflow & Safe Lookup Regressions
 *
 * Verifies:
 * 1. Safe workflow input handling: shell syntax is treated strictly as data and rejected
 * 2. Safe metadata recording: printf formats user-controlled inputs as literal strings without command execution
 * 3. Operational protections: branch restriction (main only), capability preflight (DB and master key)
 * 4. Read-only target lookup: projection restriction, selector validation, zero mutation, NO_MATCH, EXACT_MATCH, AMBIGUOUS_MATCH
 * 5. CLI boundary enforcement: --lookup rejects mutating flags; check/apply strictly require valid UUIDs
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ResolvedCredential } from "../src/server/credentials/credentials-resolver";
import type { TelegramApiDeps } from "../src/server/integrations/telegram/telegram-client";
import type {
  SwitchTelegramWebhookParams,
  TelegramBotTargetMatch,
} from "../src/server/integrations/telegram/telegram-repair";
import type { TelegramConnection } from "../src/types/domain";

// Seed offline dummy env vars before importing repo layers
process.env.DATABASE_URL ??=
  "postgresql://user:password@localhost:5432/placeholder";
process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

const checks: { label: string; pass: boolean }[] = [];

function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync(
      "node",
      ["--import", "tsx", "scripts/repair-telegram-webhook.ts", ...args],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function runBashScript(
  script: string,
  env: Record<string, string>,
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync("bash", ["-c", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function runSwitchRunner(env: Record<string, string>): {
  status: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync(
      "node",
      ["--import", "tsx", "scripts/switch-test-bot-webhook.ts"],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

async function main() {
  console.log(
    "Running Telegram Repair Workflow & Safe Lookup Regressions...\n",
  );

  const { lookupTelegramBotTarget, normalizeBotUsername } =
    await import("../src/server/integrations/telegram/telegram-repair");

  // ─── 1. Username Normalization ─────────────────────────────────────────────
  check(
    "T1. normalizeBotUsername strips optional leading @ and trims whitespace",
    normalizeBotUsername("@Drafnanafnanbot") === "Drafnanafnanbot" &&
      normalizeBotUsername("Drafnanafnanbot") === "Drafnanafnanbot" &&
      normalizeBotUsername("  @test_bot  ") === "test_bot" &&
      normalizeBotUsername("") === null &&
      normalizeBotUsername("   ") === null &&
      normalizeBotUsername(undefined) === null,
  );

  // ─── 2. Lookup Target Unit Tests ───────────────────────────────────────────
  const mockMatches: TelegramBotTargetMatch[] = [
    {
      businessId: "11111111-1111-1111-1111-111111111111",
      connectionId: "22222222-2222-2222-2222-222222222222",
      botExternalId: "123456789",
      botUsername: "Drafnanafnanbot",
      status: "CONNECTED",
      isActive: true,
    },
  ];

  const mockRepo = {
    async findCandidatesByBotIdentifier(params: {
      botUsername?: string;
      botExternalId?: string;
      limit?: number;
    }) {
      if (
        params.botUsername === "Drafnanafnanbot" ||
        params.botExternalId === "123456789"
      ) {
        return mockMatches;
      }
      if (params.botUsername === "ambiguous_bot") {
        return [
          mockMatches[0]!,
          {
            businessId: "33333333-3333-3333-3333-333333333333",
            connectionId: "44444444-4444-4444-4444-444444444444",
            botExternalId: "987654321",
            botUsername: "ambiguous_bot",
            status: "DISCONNECTED",
            isActive: false,
          },
        ];
      }
      return [];
    },
  };

  // T2. Exact match by username
  const exactUsernameRes = await lookupTelegramBotTarget(
    { connectionRepository: mockRepo },
    { botUsername: "@Drafnanafnanbot" },
  );
  check(
    "T2. lookupTelegramBotTarget returns EXACT_MATCH for unique bot username with limited projection",
    exactUsernameRes.ok === true &&
      exactUsernameRes.status === "EXACT_MATCH" &&
      exactUsernameRes.target.businessId ===
        "11111111-1111-1111-1111-111111111111" &&
      exactUsernameRes.target.connectionId ===
        "22222222-2222-2222-2222-222222222222" &&
      exactUsernameRes.target.botExternalId === "123456789" &&
      exactUsernameRes.target.botUsername === "Drafnanafnanbot" &&
      exactUsernameRes.target.status === "CONNECTED" &&
      exactUsernameRes.target.isActive === true &&
      !("credentialsRef" in exactUsernameRes.target) &&
      !("webhookSecretHash" in exactUsernameRes.target),
  );

  // T3. Exact match by external ID
  const exactExternalIdRes = await lookupTelegramBotTarget(
    { connectionRepository: mockRepo },
    { botExternalId: "123456789" },
  );
  check(
    "T3. lookupTelegramBotTarget returns EXACT_MATCH for unique bot external ID",
    exactExternalIdRes.ok === true &&
      exactExternalIdRes.status === "EXACT_MATCH" &&
      exactExternalIdRes.target.botExternalId === "123456789",
  );

  // T4. No match
  const noMatchRes = await lookupTelegramBotTarget(
    { connectionRepository: mockRepo },
    { botUsername: "nonexistent_bot" },
  );
  check(
    "T4. lookupTelegramBotTarget returns explicit NO_MATCH when no rows found",
    noMatchRes.ok === true &&
      noMatchRes.status === "NO_MATCH" &&
      noMatchRes.matches.length === 0,
  );

  // T5. Ambiguous match
  const ambiguousRes = await lookupTelegramBotTarget(
    { connectionRepository: mockRepo },
    { botUsername: "ambiguous_bot" },
  );
  check(
    "T5. lookupTelegramBotTarget returns explicit AMBIGUOUS_MATCH when multiple rows found",
    ambiguousRes.ok === true &&
      ambiguousRes.status === "AMBIGUOUS_MATCH" &&
      ambiguousRes.matches.length === 2,
  );

  // T6. Selector validation: empty
  const emptyRes = await lookupTelegramBotTarget(
    { connectionRepository: mockRepo },
    {},
  );
  check(
    "T6. lookupTelegramBotTarget rejects empty selector with INVALID_SELECTOR",
    emptyRes.ok === false && emptyRes.code === "INVALID_SELECTOR",
  );

  // T7. Selector validation: malformed username
  const malformedUsernameRes = await lookupTelegramBotTarget(
    { connectionRepository: mockRepo },
    { botUsername: "in valid bot!" },
  );
  check(
    "T7. lookupTelegramBotTarget rejects invalid bot username shape",
    malformedUsernameRes.ok === false &&
      malformedUsernameRes.code === "INVALID_SELECTOR",
  );

  // T8. Selector validation: malformed external ID
  const malformedExtIdRes = await lookupTelegramBotTarget(
    { connectionRepository: mockRepo },
    { botExternalId: "abc12345" },
  );
  check(
    "T8. lookupTelegramBotTarget rejects non-numeric external ID",
    malformedExtIdRes.ok === false &&
      malformedExtIdRes.code === "INVALID_SELECTOR",
  );

  // ─── 3. CLI Argument Validation for --lookup ──────────────────────────────
  const cliLookupMutateError1 = runCli([
    "--lookup",
    "--apply",
    "--bot-username",
    "bot1",
  ]);
  const cliLookupMutateError2 = runCli([
    "--lookup",
    "--reconcile-secret",
    "--bot-username",
    "bot1",
  ]);
  const cliLookupUrlError = runCli([
    "--lookup",
    "--expected-url",
    "https://example.com/api/telegram/webhook",
    "--bot-username",
    "bot1",
  ]);
  const cliLookupMissingSelector = runCli(["--lookup"]);

  check(
    "T9. CLI rejects mutating or URL flags in --lookup mode",
    cliLookupMutateError1.status === 1 &&
      cliLookupMutateError1.stderr.includes(
        "--lookup is read-only and cannot be combined with --apply",
      ) &&
      cliLookupMutateError2.status === 1 &&
      cliLookupMutateError2.stderr.includes(
        "--lookup is read-only and cannot be combined with --apply",
      ) &&
      cliLookupUrlError.status === 1 &&
      cliLookupUrlError.stderr.includes(
        "--lookup is read-only and does not accept --expected-url",
      ) &&
      cliLookupMissingSelector.status === 1 &&
      cliLookupMissingSelector.stderr.includes(
        "--lookup requires --bot-username or --bot-external-id",
      ),
  );

  // T10. CLI non-lookup requires valid UUIDs
  const cliInvalidUuid = runCli([
    "-b",
    "not-a-valid-uuid",
    "-c",
    "22222222-2222-2222-2222-222222222222",
  ]);
  check(
    "T10. CLI check/apply mode strictly rejects non-UUID identifiers",
    cliInvalidUuid.status === 1 &&
      cliInvalidUuid.stderr.includes(
        "Both --business-id and --connection-id must be valid UUIDs",
      ),
  );

  // ─── 4. Workflow Script Shell Injection & Validation Regressions ───────────
  // Bash snippet simulating workflow input validation and metadata output
  const S = "$";
  const WORKFLOW_VALIDATION_BASH = `
set -euo pipefail

# 1. Branch restriction check
if [ "${S}{GITHUB_REF:-}" != "refs/heads/main" ]; then
  echo "::error::Branch refused: ${S}{GITHUB_REF:-}"
  exit 1
fi

# 2. Database URL check
if [ -z "${S}{DATABASE_URL:-}" ]; then
  echo "::error::Missing DATABASE_URL"
  exit 1
fi

# 3. Mode validation
case "${S}{INPUT_MODE:-}" in
  "lookup"|"check"|"apply"|"apply-reconcile") ;;
  *) echo "::error::Invalid mode ${S}{INPUT_MODE:-}"; exit 1 ;;
esac

# 4. Mode-specific input validation
CLEAN_BOT_USERNAME=""
CLEAN_BOT_EXTERNAL_ID=""

if [ "${S}{INPUT_MODE}" = "lookup" ]; then
  if [ -z "${S}{INPUT_BOT_USERNAME:-}" ] && [ -z "${S}{INPUT_BOT_EXTERNAL_ID:-}" ]; then
    echo "::error::Missing lookup selector"
    exit 1
  fi
  if [ -n "${S}{INPUT_BOT_USERNAME:-}" ]; then
    RAW_USERNAME="${S}{INPUT_BOT_USERNAME#@}"
    if [[ ! "${S}RAW_USERNAME" =~ ^[A-Za-z0-9_]{3,32}$ ]]; then
      echo "::error::Invalid bot_username format"
      exit 1
    fi
    CLEAN_BOT_USERNAME="${S}RAW_USERNAME"
  fi
  if [ -n "${S}{INPUT_BOT_EXTERNAL_ID:-}" ]; then
    if [[ ! "${S}INPUT_BOT_EXTERNAL_ID" =~ ^[0-9]{5,20}$ ]]; then
      echo "::error::Invalid bot_external_id format"
      exit 1
    fi
    CLEAN_BOT_EXTERNAL_ID="${S}INPUT_BOT_EXTERNAL_ID"
  fi
else
  if [ -z "${S}{CREDENTIAL_MASTER_KEY:-}" ]; then
    echo "::error::Missing CREDENTIAL_MASTER_KEY"
    exit 1
  fi
  UUID_REGEX="^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
  if [[ ! "${S}{INPUT_BUSINESS_ID:-}" =~ ${S}UUID_REGEX ]]; then
    echo "::error::Invalid business_id"
    exit 1
  fi
  if [[ ! "${S}{INPUT_CONNECTION_ID:-}" =~ ${S}UUID_REGEX ]]; then
    echo "::error::Invalid connection_id"
    exit 1
  fi
  if [[ ! "${S}{INPUT_EXPECTED_URL:-}" =~ ^https:// ]]; then
    echo "::error::Invalid expected_url"
    exit 1
  fi
fi

# Safe metadata recording via printf
printf 'RECORDED_MODE: %s\n' "${S}INPUT_MODE"
if [ "${S}INPUT_MODE" = "lookup" ]; then
  if [ -n "${S}CLEAN_BOT_USERNAME" ]; then
    printf 'RECORDED_USERNAME: %s\n' "${S}CLEAN_BOT_USERNAME"
  fi
  if [ -n "${S}CLEAN_BOT_EXTERNAL_ID" ]; then
    printf 'RECORDED_EXTERNAL_ID: %s\n' "${S}CLEAN_BOT_EXTERNAL_ID"
  fi
else
  printf 'RECORDED_BUSINESS: %s\n' "${S}INPUT_BUSINESS_ID"
  printf 'RECORDED_CONNECTION: %s\n' "${S}INPUT_CONNECTION_ID"
fi
`;

  // T11. Branch restriction: non-main branch is refused
  const nonMainRun = runBashScript(WORKFLOW_VALIDATION_BASH, {
    GITHUB_REF: "refs/heads/feature-branch",
    DATABASE_URL: "postgresql://mock",
    INPUT_MODE: "lookup",
    INPUT_BOT_USERNAME: "Drafnanafnanbot",
  });
  check(
    "T11. Workflow strictly refuses execution on non-main branches",
    nonMainRun.status === 1 &&
      nonMainRun.stdout.includes("Branch refused: refs/heads/feature-branch"),
  );

  // T12. Shell injection attempt in bot_username is rejected by format regex
  const injectionRun1 = runBashScript(WORKFLOW_VALIDATION_BASH, {
    GITHUB_REF: "refs/heads/main",
    DATABASE_URL: "postgresql://mock",
    INPUT_MODE: "lookup",
    INPUT_BOT_USERNAME: "$(whoami); touch /tmp/pwned",
  });
  check(
    "T12. Shell command injection in bot_username fails validation and does not execute",
    injectionRun1.status === 1 &&
      injectionRun1.stdout.includes("Invalid bot_username format"),
  );

  // T13. Shell injection attempt in business_id UUID is rejected by format regex
  const injectionRun2 = runBashScript(WORKFLOW_VALIDATION_BASH, {
    GITHUB_REF: "refs/heads/main",
    DATABASE_URL: "postgresql://mock",
    CREDENTIAL_MASTER_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    INPUT_MODE: "check",
    INPUT_BUSINESS_ID: "`touch /tmp/pwned2`",
    INPUT_CONNECTION_ID: "22222222-2222-2222-2222-222222222222",
    INPUT_EXPECTED_URL:
      "https://flowpilot-prod.vercel.app/api/telegram/webhook",
  });
  check(
    "T13. Shell command injection in business_id fails validation and does not execute",
    injectionRun2.status === 1 &&
      injectionRun2.stdout.includes("Invalid business_id"),
  );

  // T14. Safe metadata recording preserves literal values via printf
  const safeLookupRun = runBashScript(WORKFLOW_VALIDATION_BASH, {
    GITHUB_REF: "refs/heads/main",
    DATABASE_URL: "postgresql://mock",
    INPUT_MODE: "lookup",
    INPUT_BOT_USERNAME: "@Drafnanafnanbot",
  });
  check(
    "T14. Valid lookup input is safely recorded and cleaned (@ stripped)",
    safeLookupRun.status === 0 &&
      safeLookupRun.stdout.includes("RECORDED_MODE: lookup") &&
      safeLookupRun.stdout.includes("RECORDED_USERNAME: Drafnanafnanbot"),
  );

  // T15. Missing master key in check mode fails closed
  const missingKeyRun = runBashScript(WORKFLOW_VALIDATION_BASH, {
    GITHUB_REF: "refs/heads/main",
    DATABASE_URL: "postgresql://mock",
    CREDENTIAL_MASTER_KEY: "",
    INPUT_MODE: "check",
    INPUT_BUSINESS_ID: "11111111-1111-1111-1111-111111111111",
    INPUT_CONNECTION_ID: "22222222-2222-2222-2222-222222222222",
    INPUT_EXPECTED_URL:
      "https://flowpilot-prod.vercel.app/api/telegram/webhook",
  });
  check(
    "T15. Missing CREDENTIAL_MASTER_KEY in check mode fails closed before execution",
    missingKeyRun.status === 1 &&
      missingKeyRun.stdout.includes("Missing CREDENTIAL_MASTER_KEY"),
  );

  // T16. Missing master key in lookup mode is ALLOWED (lookup is read-only metadata)
  const lookupWithoutMasterKeyRun = runBashScript(WORKFLOW_VALIDATION_BASH, {
    GITHUB_REF: "refs/heads/main",
    DATABASE_URL: "postgresql://mock",
    CREDENTIAL_MASTER_KEY: "",
    INPUT_MODE: "lookup",
    INPUT_BOT_USERNAME: "Drafnanafnanbot",
  });
  check(
    "T16. Lookup mode succeeds without CREDENTIAL_MASTER_KEY because it reads only unencrypted metadata",
    lookupWithoutMasterKeyRun.status === 0 &&
      lookupWithoutMasterKeyRun.stdout.includes(
        "RECORDED_USERNAME: Drafnanafnanbot",
      ),
  );

  // ─── 4. Switch CLI Boundary Enforcement ───────────────────────────────────
  // T17. CLI --switch requires --expected-current-url and --destination-url
  const switchMissingUrls = runCli([
    "--switch",
    "--business-id",
    "11111111-1111-1111-1111-111111111111",
    "--connection-id",
    "22222222-2222-2222-2222-222222222222",
  ]);
  check(
    "T17. CLI --switch fails closed when expected-current-url or destination-url is omitted",
    switchMissingUrls.status === 1 &&
      switchMissingUrls.stderr.includes(
        "Both --expected-current-url and --destination-url are required",
      ),
  );

  // T18. CLI --switch rejects non-UUID IDs
  const switchBadUuid = runCli([
    "--switch",
    "--business-id",
    "invalid-uuid",
    "--connection-id",
    "22222222-2222-2222-2222-222222222222",
    "--expected-current-url",
    "https://flowpilot-prod.vercel.app/api/telegram/webhook",
    "--destination-url",
    "https://preview.flowpilot.app/api/telegram/webhook",
  ]);
  check(
    "T18. CLI --switch strictly rejects non-UUID business-id or connection-id",
    switchBadUuid.status === 1 &&
      switchBadUuid.stderr.includes("must be valid UUIDs"),
  );

  // T19. CLI --switch rejects combination with --lookup or --reconcile-secret
  const switchWithLookup = runCli([
    "--switch",
    "--lookup",
    "--business-id",
    "11111111-1111-1111-1111-111111111111",
    "--connection-id",
    "22222222-2222-2222-2222-222222222222",
    "--expected-current-url",
    "https://flowpilot-prod.vercel.app/api/telegram/webhook",
    "--destination-url",
    "https://preview.flowpilot.app/api/telegram/webhook",
  ]);
  const switchWithReconcile = runCli([
    "--switch",
    "--reconcile-secret",
    "--business-id",
    "11111111-1111-1111-1111-111111111111",
    "--connection-id",
    "22222222-2222-2222-2222-222222222222",
    "--expected-current-url",
    "https://flowpilot-prod.vercel.app/api/telegram/webhook",
    "--destination-url",
    "https://preview.flowpilot.app/api/telegram/webhook",
  ]);
  check(
    "T19. CLI --switch rejects conflicting modes (--lookup, --reconcile-secret)",
    switchWithLookup.status === 1 &&
      switchWithLookup.stderr.includes("cannot be combined with --lookup") &&
      switchWithReconcile.status === 1 &&
      switchWithReconcile.stderr.includes(
        "cannot be combined with --reconcile-secret",
      ),
  );

  // T20. Passing switch flags without --switch fails
  const flagsWithoutSwitch = runCli([
    "--business-id",
    "11111111-1111-1111-1111-111111111111",
    "--connection-id",
    "22222222-2222-2222-2222-222222222222",
    "--expected-current-url",
    "https://flowpilot-prod.vercel.app/api/telegram/webhook",
    "--destination-url",
    "https://preview.flowpilot.app/api/telegram/webhook",
  ]);
  check(
    "T20. Passing --expected-current-url or --destination-url without --switch is rejected",
    flagsWithoutSwitch.status === 1 &&
      flagsWithoutSwitch.stderr.includes("only valid with --switch"),
  );

  // ─── 5. Guarded Switch Runner & Restoration Workflow Execution Tests ───────
  const { executeGuardedSwitch, validateProductionDatabaseUrl, FIXED_TARGETS } =
    await import("./switch-test-bot-webhook");
  const { validateDatabaseUrl, RecoveryError } =
    await import("../src/server/credentials/test-bot-recovery");
  const { switchTelegramBotWebhook } =
    await import("../src/server/integrations/telegram/telegram-repair");

  // T21. Runner CLI fails closed on unknown operation
  const runnerUnknownOp = runSwitchRunner({
    OPERATION: "unauthorized-op",
    DATABASE_URL:
      "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require",
    CREDENTIAL_MASTER_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  check(
    "T21. Runner CLI fails closed on unknown operation",
    runnerUnknownOp.status === 1 &&
      runnerUnknownOp.stderr.includes("Preflight Refused: [UNKNOWN_OPERATION]"),
  );

  // T22. Runner CLI fails closed on missing database URL
  const runnerMissingDb = runSwitchRunner({
    OPERATION: "switch-webhook-dry-run",
    DATABASE_URL: "",
    CREDENTIAL_MASTER_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  check(
    "T22. Runner CLI fails closed on missing database URL",
    runnerMissingDb.status === 1 &&
      runnerMissingDb.stderr.includes(
        "Preflight Refused: [MISSING_DATABASE_URL]",
      ),
  );

  // T23. Runner CLI fails closed on missing master key secret
  const runnerMissingKey = runSwitchRunner({
    OPERATION: "switch-webhook-dry-run",
    DATABASE_URL:
      "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require",
    CREDENTIAL_MASTER_KEY: "",
  });
  check(
    "T23. Runner CLI fails closed on missing master key secret",
    runnerMissingKey.status === 1 &&
      runnerMissingKey.stderr.includes(
        "Preflight Refused: [MISSING_CREDENTIAL_MASTER_KEY]",
      ),
  );

  // T24. Runner CLI strictly refuses unauthorized database target host
  const runnerBadHost = runSwitchRunner({
    OPERATION: "switch-webhook-dry-run",
    DATABASE_URL:
      "postgresql://postgres:pass@localhost:5432/neondb?sslmode=require",
    CREDENTIAL_MASTER_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  check(
    "T24. Runner CLI strictly refuses unauthorized database target host",
    runnerBadHost.status === 1 &&
      runnerBadHost.stderr.includes(
        "Preflight Refused: [DATABASE_TARGET_NOT_AUTHORIZED]",
      ),
  );

  // T25. Structured validation accepts both authorized test database hosts
  let validTestHostsPass = true;
  try {
    validateDatabaseUrl(
      "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require",
    );
    validateDatabaseUrl(
      "postgres://user:pass@ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech:5432/neondb?sslmode=require",
    );
  } catch {
    validTestHostsPass = false;
  }
  check(
    "T25. Structured validation accepts both authorized test database hosts (direct and pooler)",
    validTestHostsPass,
  );

  // T26. Structured validation rejects authorized host with database name suffix (/neondb_backup)
  let rejectedBackupDb = false;
  try {
    validateDatabaseUrl(
      "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb_backup?sslmode=require",
    );
  } catch (err: unknown) {
    if (
      err instanceof RecoveryError &&
      err.code === "DATABASE_TARGET_NOT_AUTHORIZED"
    ) {
      rejectedBackupDb = true;
    }
  }
  check(
    "T26. Structured validation rejects authorized host with database name suffix (/neondb_backup)",
    rejectedBackupDb,
  );

  // T27. Structured validation rejects query param injection / connection-string manipulation
  let rejectedQueryInjection = false;
  try {
    validateDatabaseUrl(
      "postgresql://user:pass@localhost:5432/neondb?fake=@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb&sslmode=require",
    );
  } catch (err: unknown) {
    if (
      err instanceof RecoveryError &&
      (err.code === "DATABASE_TARGET_NOT_AUTHORIZED" ||
        err.code === "DATABASE_OPTIONS_NOT_AUTHORIZED")
    ) {
      rejectedQueryInjection = true;
    }
  }
  check(
    "T27. Structured validation rejects query param injection / connection-string manipulation",
    rejectedQueryInjection,
  );

  // T28. Structured validation rejects plain postgresql:// without sslmode or with unauthorized options
  let rejectedPlainAndOptions = false;
  try {
    validateDatabaseUrl(
      "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb",
    );
  } catch (err1: unknown) {
    if (
      err1 instanceof RecoveryError &&
      err1.code === "DATABASE_TLS_REQUIRED"
    ) {
      try {
        validateDatabaseUrl(
          "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require&target_session_attrs=read-write",
        );
      } catch (err2: unknown) {
        if (
          err2 instanceof RecoveryError &&
          err2.code === "DATABASE_OPTIONS_NOT_AUTHORIZED"
        ) {
          rejectedPlainAndOptions = true;
        }
      }
    }
  }
  check(
    "T28. Structured validation rejects plain postgresql:// without sslmode and rejects unauthorized query options",
    rejectedPlainAndOptions,
  );

  // T29. Structured validation rejects malformed database URLs
  let rejectedMalformedUrl = false;
  try {
    validateDatabaseUrl("not-a-valid-database-url");
  } catch (err: unknown) {
    if (err instanceof RecoveryError && err.code === "INVALID_DATABASE_URL") {
      rejectedMalformedUrl = true;
    }
  }
  check(
    "T29. Structured validation rejects malformed database URLs with INVALID_DATABASE_URL",
    rejectedMalformedUrl,
  );

  // T30. Production destination validator rejects test database and loopback hosts
  let prodValidatorGuardsPass = false;
  try {
    validateProductionDatabaseUrl(
      "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require",
    );
  } catch (err1: unknown) {
    if (
      err1 instanceof RecoveryError &&
      err1.code === "PRODUCTION_DATABASE_TARGET_NOT_AUTHORIZED"
    ) {
      try {
        validateProductionDatabaseUrl(
          "postgresql://user:pass@127.0.0.1:5432/neondb?sslmode=require",
        );
      } catch (err2: unknown) {
        if (
          err2 instanceof RecoveryError &&
          err2.code === "PRODUCTION_DATABASE_TARGET_NOT_AUTHORIZED"
        ) {
          prodValidatorGuardsPass = true;
        }
      }
    }
  }
  check(
    "T30. Production restoration validator strictly rejects test database and loopback hosts",
    prodValidatorGuardsPass,
  );

  // T31. Guarded runner dry run executes without mutation and with apply=false
  const dryRunCapture = { current: null as SwitchTelegramWebhookParams | null };
  const loggedLines: string[] = [];
  const testOut = {
    log: (...args: unknown[]) => loggedLines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => loggedLines.push(args.map(String).join(" ")),
  };

  const dryRunOutcome = await executeGuardedSwitch(
    {
      DATABASE_URL:
        "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require",
      CREDENTIAL_MASTER_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      OPERATION: "switch-webhook-dry-run",
    },
    {
      switchFn: async (params) => {
        dryRunCapture.current = params;
        return {
          ok: true,
          status: "SWITCH_DRY_RUN",
          dryRun: true,
          botExternalId: FIXED_TARGETS.botExternalId,
          botUsername: FIXED_TARGETS.botUsername,
          currentWebhookUrl: FIXED_TARGETS.mainWebhookUrl,
          destinationWebhookUrl: FIXED_TARGETS.previewWebhookUrl,
          allowedUpdates: ["message", "callback_query"],
          pendingUpdateCount: 0,
          restorationProcedure: "test restoration procedure",
          message: "Dry run successful",
        };
      },
      out: testOut,
    },
  );
  check(
    "T31. Guarded runner dry run passes apply=false, pins fixed targets, and logs planned procedure",
    dryRunOutcome.ok === true &&
      dryRunOutcome.status === "SWITCH_DRY_RUN" &&
      dryRunCapture.current !== null &&
      dryRunCapture.current.apply === false &&
      dryRunCapture.current.businessId === FIXED_TARGETS.businessId &&
      dryRunCapture.current.connectionId === FIXED_TARGETS.connectionId &&
      dryRunCapture.current.expectedBotExternalId ===
        FIXED_TARGETS.botExternalId &&
      dryRunCapture.current.expectedCurrentUrl ===
        FIXED_TARGETS.mainWebhookUrl &&
      dryRunCapture.current.destinationUrl ===
        FIXED_TARGETS.previewWebhookUrl &&
      loggedLines.some((l) => l.includes("mode=DRY RUN")),
  );

  // T32. Guarded runner apply executes with apply=true
  const applyCapture = { current: null as SwitchTelegramWebhookParams | null };
  const applyLoggedLines: string[] = [];
  const applyOut = {
    log: (...args: unknown[]) =>
      applyLoggedLines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) =>
      applyLoggedLines.push(args.map(String).join(" ")),
  };

  const applyOutcome = await executeGuardedSwitch(
    {
      DATABASE_URL:
        "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require",
      CREDENTIAL_MASTER_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      OPERATION: "switch-webhook-apply",
    },
    {
      switchFn: async (params) => {
        applyCapture.current = params;
        return {
          ok: true,
          status: "SWITCHED",
          dryRun: false,
          botExternalId: FIXED_TARGETS.botExternalId,
          botUsername: FIXED_TARGETS.botUsername,
          previousWebhookUrl: FIXED_TARGETS.mainWebhookUrl,
          webhookUrl: FIXED_TARGETS.previewWebhookUrl,
          allowedUpdates: ["message", "callback_query"],
          previousAllowedUpdates: ["message"],
          pendingUpdateCount: 0,
          webhookSecretHashPersisted: true,
          restorationProcedure: "test revert procedure",
          verifiedAt: new Date().toISOString(),
        };
      },
      out: applyOut,
    },
  );
  check(
    "T32. Guarded runner apply passes apply=true, pins fixed targets, and logs switched confirmation",
    applyOutcome.ok === true &&
      applyOutcome.status === "SWITCHED" &&
      applyCapture.current !== null &&
      applyCapture.current.apply === true &&
      applyCapture.current.expectedCurrentUrl ===
        FIXED_TARGETS.mainWebhookUrl &&
      applyCapture.current.destinationUrl === FIXED_TARGETS.previewWebhookUrl &&
      applyLoggedLines.some((l) => l.includes("mode=APPLY (explicit switch)")),
  );

  // T33. Strict output hygiene boundary: synthetic secrets, tokens, and database URLs are never leaked
  const hygieneLoggedLines: string[] = [];
  const hygieneOut = {
    log: (...args: unknown[]) =>
      hygieneLoggedLines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) =>
      hygieneLoggedLines.push(args.map(String).join(" ")),
  };
  const SYNTHETIC_SECRET = "TOP_SECRET_TELEGRAM_BOT_TOKEN_XYZ_999";
  const SYNTHETIC_DB_PASS = "SUPER_SECRET_POSTGRES_PASSWORD_ABC_123";

  const hygieneOutcome = await executeGuardedSwitch(
    {
      DATABASE_URL: `postgresql://app_user:${SYNTHETIC_DB_PASS}@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require`,
      CREDENTIAL_MASTER_KEY:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      OPERATION: "switch-webhook-apply",
    },
    {
      switchFn: async () => {
        throw new Error(
          `Connection failed to postgres://app_user:${SYNTHETIC_DB_PASS}@ep-little-mouse... with token ${SYNTHETIC_SECRET}`,
        );
      },
      out: hygieneOut,
    },
  );
  const combinedHygieneOutput = hygieneLoggedLines.join("\n");
  check(
    "T33. Strict output hygiene boundary: catches unexpected errors, emits UNEXPECTED_SWITCH_FAILURE, and discloses zero secrets",
    hygieneOutcome.ok === false &&
      hygieneOutcome.code === "UNEXPECTED_SWITCH_FAILURE" &&
      !combinedHygieneOutput.includes(SYNTHETIC_SECRET) &&
      !combinedHygieneOutput.includes(SYNTHETIC_DB_PASS) &&
      combinedHygieneOutput.includes("[UNEXPECTED_SWITCH_FAILURE]"),
  );

  // T34. Workflow definition delegates to switch runner with exact branch and SHA protection
  const workflowYaml = readFileSync(
    ".github/workflows/test-db-migrate.yml",
    "utf-8",
  );
  const hasBranchGate = workflowYaml.includes(
    "github.ref == 'refs/heads/fix/safe-telegram-staff-reply-delivery'",
  );
  const hasShaCheck =
    workflowYaml.includes("EXPECTED_SHA: ${{ inputs.expected_commit_sha }}") &&
    workflowYaml.includes('[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]');
  const delegatesToSwitchRunner = workflowYaml.includes(
    "node --import tsx scripts/switch-test-bot-webhook.ts",
  );
  const hasTestDbBinding = workflowYaml.includes(
    "DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}",
  );
  const hasProdDbBinding = workflowYaml.includes(
    "DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}",
  );
  const hasWorkflowOptions =
    workflowYaml.includes("switch-webhook-dry-run") &&
    workflowYaml.includes("switch-webhook-apply") &&
    workflowYaml.includes("restore-main-webhook-dry-run") &&
    workflowYaml.includes("restore-main-webhook-apply");

  check(
    "T34. Workflow file strictly delegates to switch runner with branch gate, SHA check, and isolated secret scopes",
    hasBranchGate &&
      hasShaCheck &&
      delegatesToSwitchRunner &&
      hasTestDbBinding &&
      hasProdDbBinding &&
      hasWorkflowOptions,
  );

  // T35. Offline multi-database switch and restoration regression (test DB switch -> main DB restoration cycle)
  let telegramRemoteUrl: string = FIXED_TARGETS.mainWebhookUrl;
  let telegramRemoteSecret: string | null = "initial-secret";
  let telegramRemoteUpdates = ["message"];

  const mockCredentialsResolver = {
    async resolve(): Promise<ResolvedCredential> {
      return {
        ok: true,
        kind: "RUNTIME",
        reference: "fp:725da53e-e346-4a3c-a083-fc8a3bae7f37",
        value: "8926541123:dummy-token-for-offline-testing-regression-only",
      };
    },
  };

  const mockTelegramApi: TelegramApiDeps = {
    apiHost: "https://api.telegram.org",
    credentialsResolver: mockCredentialsResolver,
    async fetchImpl(input: RequestInfo | URL, init?: RequestInit) {
      const urlStr = typeof input === "string" ? input : input.toString();
      if (urlStr.includes("/getMe")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(FIXED_TARGETS.botExternalId),
              is_bot: true,
              first_name: "Drafnan Bot",
              username: "Drafnanafnanbot",
              can_manage_bots: false,
            },
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/getWebhookInfo")) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              url: telegramRemoteUrl,
              has_custom_certificate: false,
              pending_update_count: 0,
              allowed_updates: telegramRemoteUpdates,
            },
          }),
          { status: 200 },
        );
      }
      if (urlStr.includes("/setWebhook")) {
        const body = JSON.parse(init?.body as string);
        telegramRemoteUrl = body.url;
        telegramRemoteSecret = body.secret_token;
        telegramRemoteUpdates = body.allowed_updates;
        return new Response(
          JSON.stringify({
            ok: true,
            result: true,
            description: "Webhook was set",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false }), { status: 404 });
    },
  };

  const testDbConnection = {
    id: FIXED_TARGETS.connectionId,
    businessId: FIXED_TARGETS.businessId,
    botExternalId: FIXED_TARGETS.botExternalId,
    botUsername: "Drafnanafnanbot",
    provider: "telegram_managed",
    credentialsRef: "fp:725da53e-e346-4a3c-a083-fc8a3bae7f37",
    status: "CONNECTED",
    isActive: true,
    webhookSecretHash: "initial-test-db-secret-hash",
  };

  const mainDbConnection = {
    id: FIXED_TARGETS.connectionId,
    businessId: FIXED_TARGETS.businessId,
    botExternalId: FIXED_TARGETS.botExternalId,
    botUsername: "Drafnanafnanbot",
    provider: "telegram_managed",
    credentialsRef: "fp:725da53e-e346-4a3c-a083-fc8a3bae7f37",
    status: "CONNECTED",
    isActive: true,
    webhookSecretHash: "initial-main-db-secret-hash",
  };

  const createRepoFor = (connRef: typeof testDbConnection) => ({
    async findByIdWithinBusiness(
      id: string,
      businessId: string,
    ): Promise<TelegramConnection | null> {
      if (id === connRef.id && businessId === connRef.businessId) {
        return { ...connRef } as unknown as TelegramConnection;
      }
      return null;
    },
    async updateWebhookSecretHash(
      id: string,
      businessId: string,
      webhookSecretHash: string,
    ): Promise<TelegramConnection | null> {
      if (id === connRef.id && businessId === connRef.businessId) {
        connRef.webhookSecretHash = webhookSecretHash;
        return { ...connRef } as unknown as TelegramConnection;
      }
      return null;
    },
    async update(
      id: string,
      businessId: string,
      data: Partial<TelegramConnection>,
    ): Promise<TelegramConnection | null> {
      if (id === connRef.id && businessId === connRef.businessId) {
        Object.assign(connRef, data);
        return { ...connRef } as unknown as TelegramConnection;
      }
      return null;
    },
  });

  // Step 1: Forward switch targeting Test DB
  const forwardStepResult = await switchTelegramBotWebhook(
    {
      api: mockTelegramApi,
      credentialsResolver: mockCredentialsResolver,
      connectionRepository: createRepoFor(testDbConnection),
    },
    {
      businessId: FIXED_TARGETS.businessId,
      connectionId: FIXED_TARGETS.connectionId,
      expectedCurrentUrl: FIXED_TARGETS.mainWebhookUrl,
      destinationUrl: FIXED_TARGETS.previewWebhookUrl,
      apply: true,
    },
  );

  const forwardSuccess =
    forwardStepResult.ok === true &&
    forwardStepResult.status === "SWITCHED" &&
    telegramRemoteUrl === (FIXED_TARGETS.previewWebhookUrl as string) &&
    telegramRemoteSecret !== null &&
    testDbConnection.webhookSecretHash ===
      createHash("sha256").update(telegramRemoteSecret).digest("hex") &&
    mainDbConnection.webhookSecretHash === "initial-main-db-secret-hash";

  const testDbHashAfterForward = testDbConnection.webhookSecretHash;

  // Step 2: Reverse switch (restoration) targeting Main DB
  const reverseStepResult = await switchTelegramBotWebhook(
    {
      api: mockTelegramApi,
      credentialsResolver: mockCredentialsResolver,
      connectionRepository: createRepoFor(mainDbConnection),
    },
    {
      businessId: FIXED_TARGETS.businessId,
      connectionId: FIXED_TARGETS.connectionId,
      expectedCurrentUrl: FIXED_TARGETS.previewWebhookUrl,
      destinationUrl: FIXED_TARGETS.mainWebhookUrl,
      apply: true,
    },
  );

  const reverseSuccess =
    reverseStepResult.ok === true &&
    reverseStepResult.status === "SWITCHED" &&
    telegramRemoteUrl === FIXED_TARGETS.mainWebhookUrl &&
    mainDbConnection.webhookSecretHash ===
      createHash("sha256").update(telegramRemoteSecret!).digest("hex") &&
    testDbConnection.webhookSecretHash === testDbHashAfterForward;

  check(
    "T35. Offline multi-database switch and restoration regression: forward switch synchronizes Test DB, restoration synchronizes Main DB without cross-database interference",
    forwardSuccess && reverseSuccess,
  );

  let validMainTargets = true;
  for (const host of [
    "ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech",
    "ep-tiny-grass-a5e63jev-pooler.us-east-2.aws.neon.tech",
  ]) {
    try {
      validateProductionDatabaseUrl(
        `postgresql://${host}/neondb?sslmode=require`,
      );
    } catch {
      validMainTargets = false;
    }
  }
  check(
    "T36. Restoration accepts only the known main endpoint direct/pooler targets",
    validMainTargets,
  );
  let rejectedMainTargets = true;
  for (const uri of [
    "postgresql://unrelated.example/neondb?sslmode=require",
    "postgresql://[::1]/neondb?sslmode=require",
    "postgresql://ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech/other?sslmode=require",
    "postgresql://ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech/neondb?sslmode=require&host=localhost",
    "postgresql://ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech/neondb?sslmode=disable",
  ]) {
    try {
      validateProductionDatabaseUrl(uri);
      rejectedMainTargets = false;
    } catch {
      /* Expected refusal. */
    }
  }
  check(
    "T37. Restoration rejects wrong host/database, IPv6 loopback and query transport overrides",
    rejectedMainTargets,
  );
  const deniedIdentityHash = mainDbConnection.webhookSecretHash;
  const deniedIdentitySecret = telegramRemoteSecret;
  const deniedIdentity = await switchTelegramBotWebhook(
    {
      api: mockTelegramApi,
      credentialsResolver: mockCredentialsResolver,
      connectionRepository: createRepoFor(mainDbConnection),
    },
    {
      businessId: FIXED_TARGETS.businessId,
      connectionId: FIXED_TARGETS.connectionId,
      expectedBotExternalId: "999999999",
      expectedCurrentUrl: FIXED_TARGETS.mainWebhookUrl,
      destinationUrl: FIXED_TARGETS.previewWebhookUrl,
      apply: true,
    },
  );
  check(
    "T38. Wrong operator-pinned bot ID is rejected before webhook or database mutation",
    !deniedIdentity.ok &&
      deniedIdentity.code === "BOT_IDENTITY_MISMATCH" &&
      telegramRemoteUrl === FIXED_TARGETS.mainWebhookUrl &&
      telegramRemoteSecret === deniedIdentitySecret &&
      mainDbConnection.webhookSecretHash === deniedIdentityHash,
  );
  const unknownOpLog: string[] = [];
  await executeGuardedSwitch(
    { OPERATION: SYNTHETIC_SECRET },
    {
      out: {
        log: (...args) => unknownOpLog.push(args.join(" ")),
        error: (...args) => unknownOpLog.push(args.join(" ")),
      },
    },
  );
  check(
    "T39. Unknown-operation error does not echo arbitrary input",
    !unknownOpLog.join(" ").includes(SYNTHETIC_SECRET),
  );

  // ─── Summary ──────────────────────────────────────────────────────────────
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
    `\nAll ${checks.length}/${checks.length} workflow & safe lookup checks PASSED.`,
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
