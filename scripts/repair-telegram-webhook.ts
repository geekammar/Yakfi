#!/usr/bin/env tsx

// Provide safe offline defaults for Better Auth validation if unset
process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
process.env.BETTER_AUTH_URL ??= "https://flowpilot-prod.vercel.app";
process.env.NEXT_PUBLIC_APP_URL ??= "https://flowpilot-prod.vercel.app";

function printHelpAndExit(code = 0) {
  console.log(`
FlowPilot Telegram Webhook Repair & Reconciliation CLI

Usage:
  # Candidate Lookup (read-only):
  pnpm telegram:repair-webhook --lookup [--bot-username <username>] [--bot-external-id <id>]

  # Inspection and Repair (requires explicit UUIDs):
  pnpm telegram:repair-webhook --business-id <UUID> --connection-id <UUID> [options]

Modes:
  --lookup                     Read-only candidate lookup (queries database by bot username or external ID)
  (default)                    Read-only check mode (inspects allowed_updates and URL)
  --apply                      Apply subscription repair (adds callback_query and rotates secret)
  --apply --reconcile-secret   Force secret rotation and DB reconciliation even if subscription is OK

Lookup Options:
  --bot-username, -u <str>     Bot @username to look up (e.g. @Drafnanafnanbot)
  --bot-external-id, -e <str>  Stable bot numeric external ID to look up

Repair Options:
  --business-id, -b <UUID>     Business UUID owning the bot connection
  --connection-id, -c <UUID>   Telegram Connection UUID
  --expected-url <URL>         Verify registered webhook URL matches this expected URL exactly
  --help, -h                   Show this help message

Examples:
  # 1. Candidate lookup:
  pnpm telegram:repair-webhook --lookup --bot-username @Drafnanafnanbot

  # 2. Read-only check:
  pnpm telegram:repair-webhook --business-id 11111111-1111-1111-1111-111111111111 --connection-id 22222222-2222-2222-2222-222222222222 --expected-url https://flowpilot-prod.vercel.app/api/telegram/webhook

  # 3. Targeted apply:
  pnpm telegram:repair-webhook --business-id 11111111-1111-1111-1111-111111111111 --connection-id 22222222-2222-2222-2222-222222222222 --expected-url https://flowpilot-prod.vercel.app/api/telegram/webhook --apply

  # 4. Targeted reconciliation after partial failure:
  pnpm telegram:repair-webhook --business-id 11111111-1111-1111-1111-111111111111 --connection-id 22222222-2222-2222-2222-222222222222 --expected-url https://flowpilot-prod.vercel.app/api/telegram/webhook --apply --reconcile-secret
`);
  process.exit(code);
}

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseArgs(args: string[]): {
  businessId?: string;
  connectionId?: string;
  apply: boolean;
  reconcileSecret: boolean;
  expectedWebhookUrl?: string;
  lookup: boolean;
  botUsername?: string;
  botExternalId?: string;
} {
  let businessId: string | undefined;
  let connectionId: string | undefined;
  let apply = false;
  let reconcileSecret = false;
  let expectedWebhookUrl: string | undefined;
  let lookup = false;
  let botUsername: string | undefined;
  let botExternalId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    } else if (arg === "--lookup") {
      lookup = true;
    } else if (arg === "--bot-username" || arg === "-u") {
      const next = args[++i];
      if (!next || next.startsWith("-")) {
        console.error("❌ Error: Missing value for --bot-username");
        process.exit(1);
      }
      botUsername = next;
    } else if (arg.startsWith("--bot-username=")) {
      botUsername = arg.slice("--bot-username=".length);
      if (!botUsername) {
        console.error("❌ Error: Empty value for --bot-username");
        process.exit(1);
      }
    } else if (arg === "--bot-external-id" || arg === "-e") {
      const next = args[++i];
      if (!next || next.startsWith("-")) {
        console.error("❌ Error: Missing value for --bot-external-id");
        process.exit(1);
      }
      botExternalId = next;
    } else if (arg.startsWith("--bot-external-id=")) {
      botExternalId = arg.slice("--bot-external-id=".length);
      if (!botExternalId) {
        console.error("❌ Error: Empty value for --bot-external-id");
        process.exit(1);
      }
    } else if (arg === "--business-id" || arg === "-b") {
      const next = args[++i];
      if (!next || next.startsWith("-")) {
        console.error("❌ Error: Missing value for --business-id");
        process.exit(1);
      }
      businessId = next;
    } else if (arg.startsWith("--business-id=")) {
      businessId = arg.slice("--business-id=".length);
      if (!businessId) {
        console.error("❌ Error: Empty value for --business-id");
        process.exit(1);
      }
    } else if (arg === "--connection-id" || arg === "-c") {
      const next = args[++i];
      if (!next || next.startsWith("-")) {
        console.error("❌ Error: Missing value for --connection-id");
        process.exit(1);
      }
      connectionId = next;
    } else if (arg.startsWith("--connection-id=")) {
      connectionId = arg.slice("--connection-id=".length);
      if (!connectionId) {
        console.error("❌ Error: Empty value for --connection-id");
        process.exit(1);
      }
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--reconcile-secret") {
      reconcileSecret = true;
    } else if (arg === "--expected-url") {
      const next = args[++i];
      if (!next || next.startsWith("-")) {
        console.error("❌ Error: Missing value for --expected-url");
        process.exit(1);
      }
      expectedWebhookUrl = next;
    } else if (arg.startsWith("--expected-url=")) {
      expectedWebhookUrl = arg.slice("--expected-url=".length);
      if (!expectedWebhookUrl) {
        console.error("❌ Error: Empty value for --expected-url");
        process.exit(1);
      }
    } else {
      console.error(
        `❌ Error: Unknown argument '${arg}'. Use --help to view valid options.`,
      );
      process.exit(1);
    }
  }

  return {
    businessId,
    connectionId,
    apply,
    reconcileSecret,
    expectedWebhookUrl,
    lookup,
    botUsername,
    botExternalId,
  };
}

async function handleLookup(params: {
  botUsername?: string;
  botExternalId?: string;
}) {
  const { lookupTelegramBotTargetDefault } =
    await import("../src/server/integrations/telegram/telegram-repair");

  const outcome = await lookupTelegramBotTargetDefault(params);

  if (!outcome.ok) {
    console.error(`\n❌ Lookup Refused: [${outcome.code}] ${outcome.message}`);
    process.exit(1);
  }

  console.log("\n================ Target Lookup Result ================");
  console.log(`Status:              ${outcome.status}`);
  console.log(`Query:               ${JSON.stringify(outcome.query)}`);

  if (outcome.status === "NO_MATCH") {
    console.log(`Message:             ${outcome.message}`);
    console.log(
      "Verdict:             No matching Telegram bot connection was found in the database.",
    );
    console.log("====================================================\n");
    process.exit(0);
  }

  if (outcome.status === "AMBIGUOUS_MATCH") {
    console.log(`Message:             ${outcome.message}`);
    console.log(`Found Matches:       ${outcome.matches.length}`);
    console.log("Candidates:");
    for (let i = 0; i < outcome.matches.length; i++) {
      const m = outcome.matches[i]!;
      console.log(
        `  [${i + 1}] businessId: ${m.businessId} | connectionId: ${m.connectionId} | botExternalId: ${m.botExternalId} | botUsername: @${m.botUsername ?? "unknown"} | status: ${m.status} | isActive: ${m.isActive}`,
      );
    }
    console.log(
      "Verdict:             Multiple candidate connections matched. Choose explicit IDs before running check or apply.",
    );
    console.log("====================================================\n");
    process.exit(1);
  }

  // EXACT_MATCH
  console.log(`Business ID:         ${outcome.target.businessId}`);
  console.log(`Connection ID:       ${outcome.target.connectionId}`);
  console.log(`Bot External ID:     ${outcome.target.botExternalId}`);
  console.log(
    `Bot Username:        @${outcome.target.botUsername ?? "unknown"}`,
  );
  console.log(`Status:              ${outcome.target.status}`);
  console.log(`Is Active:           ${outcome.target.isActive}`);
  console.log("====================================================\n");

  console.log("Next Step (Read-Only Check):");
  console.log(
    `  pnpm telegram:repair-webhook --business-id ${outcome.target.businessId} --connection-id ${outcome.target.connectionId} --expected-url <EXPECTED_URL>\n`,
  );
  console.log("Targeted Repair (when callback_query missing):");
  console.log(
    `  pnpm telegram:repair-webhook --business-id ${outcome.target.businessId} --connection-id ${outcome.target.connectionId} --expected-url <EXPECTED_URL> --apply\n`,
  );
  process.exit(0);
}

async function main() {
  const {
    businessId,
    connectionId,
    apply,
    reconcileSecret,
    expectedWebhookUrl,
    lookup,
    botUsername,
    botExternalId,
  } = parseArgs(process.argv.slice(2));

  if (lookup) {
    if (apply || reconcileSecret) {
      console.error(
        "❌ Error: --lookup is read-only and cannot be combined with --apply or --reconcile-secret.",
      );
      process.exit(1);
    }
    if (expectedWebhookUrl) {
      console.error(
        "❌ Error: --lookup is read-only and does not accept --expected-url.",
      );
      process.exit(1);
    }
    if (!botUsername && !botExternalId) {
      console.error(
        "❌ Error: --lookup requires --bot-username or --bot-external-id to be specified.",
      );
      process.exit(1);
    }
    await handleLookup({ botUsername, botExternalId });
    return;
  }

  if (!businessId || !connectionId) {
    console.error(
      "❌ Error: Both --business-id and --connection-id are required.",
    );
    console.error(
      "Usage: pnpm telegram:repair-webhook --business-id <UUID> --connection-id <UUID> [--apply] [--reconcile-secret]",
    );
    process.exit(1);
  }

  if (reconcileSecret && !apply) {
    console.error(
      "❌ Error: --reconcile-secret requires --apply to be specified.",
    );
    process.exit(1);
  }

  if (!UUID_REGEX.test(businessId) || !UUID_REGEX.test(connectionId)) {
    console.error(
      "❌ Error: Both --business-id and --connection-id must be valid UUIDs.",
    );
    process.exit(1);
  }

  const modeLabel = reconcileSecret
    ? "APPLY (secret reconciliation)"
    : apply
      ? "APPLY"
      : "CHECK (read-only)";

  console.log(`[FlowPilot] Telegram Webhook Maintenance: mode=${modeLabel}`);
  console.log(`Target: businessId=${businessId}, connectionId=${connectionId}`);
  if (expectedWebhookUrl) {
    console.log(`Expected URL: ${expectedWebhookUrl}`);
  }

  try {
    const { repairTelegramBotWebhookDefault } =
      await import("../src/server/integrations/telegram/telegram-repair");
    const outcome = await repairTelegramBotWebhookDefault({
      businessId,
      connectionId,
      apply,
      reconcileSecret,
      expectedWebhookUrl,
    });

    if (!outcome.ok) {
      if (outcome.status === "PARTIAL_FAILURE") {
        console.error("\n⚠️  PARTIAL FAILURE / RECOVERY REQUIRED");
        console.error(`[${outcome.code}] ${outcome.message}`);
        if (outcome.remoteStateMayHaveChanged) {
          console.error(
            "Note: Telegram remote state may have changed while local database confirmation was not obtained.",
          );
        }
        console.error(
          "Incoming webhook requests may return 401 until reconciled.",
        );
        console.error(`Pending Updates: ${outcome.pendingUpdateCount}`);
        if (outcome.reconciliationCommand) {
          console.error(
            "\nRun the following command to complete reconciliation:",
          );
          console.error(`  ${outcome.reconciliationCommand}\n`);
        }
        process.exit(1);
      }

      console.error(
        `\n❌ Maintenance Refused / Failed: [${outcome.code}] ${outcome.message}`,
      );
      if (outcome.reconciliationCommand) {
        console.error("\nRun the following command to recover or reconcile:");
        console.error(`  ${outcome.reconciliationCommand}\n`);
      }
      process.exit(1);
    }

    console.log("\n================ Maintenance Result ================");
    console.log(`Status:              ${outcome.status}`);
    console.log(
      `Mode:                ${outcome.checkOnly ? "CHECK (read-only)" : "APPLIED"}`,
    );
    console.log(`Bot External ID:     ${outcome.botExternalId}`);
    console.log(`Bot Username:        @${outcome.botUsername ?? "unknown"}`);
    console.log(`Webhook URL:         ${outcome.webhookUrl}`);

    if (outcome.status === "ALREADY_CORRECT") {
      console.log(
        `Allowed Updates:     ${JSON.stringify(outcome.allowedUpdates)}`,
      );
      console.log(`Pending Updates:     ${outcome.pendingUpdateCount}`);
      if (outcome.note) {
        console.log(`Note:                ${outcome.note}`);
      }
      console.log(
        "Verdict:             Subscription includes message & callback_query. No subscription change needed.",
      );
    } else if (outcome.status === "REPAIR_REQUIRED") {
      console.log(
        `Current Updates:     ${JSON.stringify(outcome.currentAllowedUpdates)}`,
      );
      console.log(
        `Target Updates:      ${JSON.stringify(outcome.targetAllowedUpdates)}`,
      );
      console.log(`Pending Updates:     ${outcome.pendingUpdateCount}`);
      if (outcome.lastErrorMessage) {
        console.log(`Last Telegram Error: ${outcome.lastErrorMessage}`);
      }
      if (outcome.note) {
        console.log(`Note:                ${outcome.note}`);
      }
      console.log(
        "Verdict:             Missing callback_query! Re-run with --apply to subscribe and rotate secret.",
      );
    } else if (
      outcome.status === "REPAIRED" ||
      outcome.status === "SECRET_RECONCILED"
    ) {
      console.log(
        `Previous Updates:    ${JSON.stringify(outcome.previousAllowedUpdates)}`,
      );
      console.log(
        `Updated Updates:     ${JSON.stringify(outcome.allowedUpdates)}`,
      );
      console.log(`Pending Updates:     ${outcome.pendingUpdateCount}`);
      console.log(
        `Secret Reconciled:   ${outcome.secretReconciled ? "YES" : "NO"}`,
      );
      console.log(
        `Digest Persisted:    ${outcome.webhookSecretHashPersisted ? "CONFIRMED" : "UNCONFIRMED"}`,
      );
      console.log(
        "Verdict:             Successfully updated Telegram webhook subscription with callback_query and confirmed secret digest!",
      );
    }
    console.log("====================================================\n");
  } catch (err) {
    console.error(
      "\n❌ Unexpected Maintenance Error:",
      err instanceof Error ? err.message : String(err),
    );
    process.exit(1);
  }
}

void main();
