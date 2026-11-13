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

import type { TelegramBotTargetMatch } from "../src/server/integrations/telegram/telegram-repair";

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

  // ─── 5. Switch Workflow Step Bash Logic Validation ──────────────────────────
  const SWITCH_WORKFLOW_BASH = `
set -euo pipefail

if [ -z "\${DATABASE_URL:-}" ] || [ -z "\${CREDENTIAL_MASTER_KEY:-}" ]; then
  echo '::error::Required test database or master key secret is unavailable.'
  exit 1
fi

case "\$DATABASE_URL" in
  *"@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb"*|*"@ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech/neondb"*)
    ;;
  *)
    echo '::error::DATABASE_URL host or database name is not authorized for test webhook operations.'
    exit 1
    ;;
esac

FIXED_BUSINESS_ID="f5314115-ae8c-46ea-9d7e-080ef5e7366d"
FIXED_CONNECTION_ID="1d2cdf87-2bee-4f26-aad5-5ab9efd1c716"
EXPECTED_CURRENT_URL="https://flowpilot-prod.vercel.app/api/telegram/webhook"
DESTINATION_URL="https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app/api/telegram/webhook"

APPLY_FLAG=""
if [ "\${OPERATION:-}" = "switch-webhook-apply" ]; then
  APPLY_FLAG="--apply"
fi

printf 'EXECUTED_SWITCH_COMMAND: node --import tsx scripts/repair-telegram-webhook.ts --switch --business-id %s --connection-id %s --expected-current-url %s --destination-url %s%s\\n' \\
  "\$FIXED_BUSINESS_ID" "\$FIXED_CONNECTION_ID" "\$EXPECTED_CURRENT_URL" "\$DESTINATION_URL" "\${APPLY_FLAG:+ \$APPLY_FLAG}"
`;

  // T21. Switch workflow refuses unauthorized database URL
  const switchBadDbRun = runBashScript(SWITCH_WORKFLOW_BASH, {
    DATABASE_URL: "postgresql://postgres:pass@localhost:5432/flowpilot_test",
    CREDENTIAL_MASTER_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    OPERATION: "switch-webhook-dry-run",
  });
  check(
    "T21. Switch workflow step strictly refuses unauthorized database target host",
    switchBadDbRun.status === 1 &&
      switchBadDbRun.stdout.includes(
        "DATABASE_URL host or database name is not authorized",
      ),
  );

  // T22. Switch workflow refuses missing secrets
  const switchMissingSecretRun = runBashScript(SWITCH_WORKFLOW_BASH, {
    DATABASE_URL: "",
    CREDENTIAL_MASTER_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    OPERATION: "switch-webhook-dry-run",
  });
  check(
    "T22. Switch workflow step fails closed on missing secrets",
    switchMissingSecretRun.status === 1 &&
      switchMissingSecretRun.stdout.includes(
        "Required test database or master key secret is unavailable",
      ),
  );

  // T23. Switch workflow dry run constructs dry run invocation
  const switchDryRun = runBashScript(SWITCH_WORKFLOW_BASH, {
    DATABASE_URL:
      "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require",
    CREDENTIAL_MASTER_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    OPERATION: "switch-webhook-dry-run",
  });
  check(
    "T23. Switch workflow dry run constructs exact dry run invocation without --apply",
    switchDryRun.status === 0 &&
      switchDryRun.stdout.includes("EXECUTED_SWITCH_COMMAND:") &&
      switchDryRun.stdout.includes(
        "--business-id f5314115-ae8c-46ea-9d7e-080ef5e7366d",
      ) &&
      switchDryRun.stdout.includes(
        "--connection-id 1d2cdf87-2bee-4f26-aad5-5ab9efd1c716",
      ) &&
      switchDryRun.stdout.includes(
        "--expected-current-url https://flowpilot-prod.vercel.app/api/telegram/webhook",
      ) &&
      switchDryRun.stdout.includes(
        "--destination-url https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app/api/telegram/webhook",
      ) &&
      !switchDryRun.stdout.includes("--apply"),
  );

  // T24. Switch workflow apply constructs apply invocation
  const switchApplyRun = runBashScript(SWITCH_WORKFLOW_BASH, {
    DATABASE_URL:
      "postgresql://user:pass@ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=require",
    CREDENTIAL_MASTER_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    OPERATION: "switch-webhook-apply",
  });
  check(
    "T24. Switch workflow apply constructs invocation with --apply",
    switchApplyRun.status === 0 &&
      switchApplyRun.stdout.includes("EXECUTED_SWITCH_COMMAND:") &&
      switchApplyRun.stdout.includes("--apply"),
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
