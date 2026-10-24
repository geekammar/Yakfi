#!/usr/bin/env tsx
import { repairTelegramBotWebhookDefault } from "../src/server/integrations/telegram/telegram-repair";

function parseArgs(args: string[]): {
  businessId?: string;
  connectionId?: string;
  apply: boolean;
} {
  let businessId: string | undefined;
  let connectionId: string | undefined;
  let apply = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--business-id" || arg === "-b") {
      businessId = args[++i];
    } else if (arg.startsWith("--business-id=")) {
      businessId = arg.split("=")[1];
    } else if (arg === "--connection-id" || arg === "-c") {
      connectionId = args[++i];
    } else if (arg.startsWith("--connection-id=")) {
      connectionId = arg.split("=")[1];
    } else if (arg === "--apply") {
      apply = true;
    }
  }

  return { businessId, connectionId, apply };
}

async function main() {
  const { businessId, connectionId, apply } = parseArgs(process.argv.slice(2));

  if (!businessId || !connectionId) {
    console.error(
      "Usage: tsx scripts/repair-telegram-webhook.ts --business-id <UUID> --connection-id <UUID> [--apply]",
    );
    console.error(
      "Note: Without --apply, the command runs in read-only check mode.",
    );
    process.exit(1);
  }

  console.log(
    `[FlowPilot] Telegram Webhook Maintenance: mode=${apply ? "APPLY" : "CHECK (read-only)"}`,
  );
  console.log(`Target: businessId=${businessId}, connectionId=${connectionId}`);

  try {
    const outcome = await repairTelegramBotWebhookDefault({
      businessId,
      connectionId,
      apply,
    });

    if (!outcome.ok) {
      console.error(
        `\n❌ Maintenance Refused / Failed: [${outcome.code}] ${outcome.message}`,
      );
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
      console.log(
        "Verdict:             No repair needed. Registration is already valid and includes callback_query.",
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
      console.log(
        "Verdict:             Missing callback_query! Re-run with --apply to execute controlled rotation.",
      );
    } else if (outcome.status === "REPAIRED") {
      console.log(
        `Previous Updates:    ${JSON.stringify(outcome.previousAllowedUpdates)}`,
      );
      console.log(
        `Updated Updates:     ${JSON.stringify(outcome.allowedUpdates)}`,
      );
      console.log(`Pending Updates:     ${outcome.pendingUpdateCount}`);
      console.log(
        "Verdict:             Successfully updated Telegram webhook subscription with callback_query!",
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
