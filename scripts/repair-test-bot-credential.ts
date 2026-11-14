/** JSON stdin only. Use the masked Python launcher; never put secrets in argv. */
import { readFileSync } from "node:fs";

import {
  RecoveryError,
  recoverTestBot,
  validateDatabaseUrl,
} from "../src/server/credentials/test-bot-recovery";

async function main() {
  const input = JSON.parse(readFileSync(0, "utf8")) as {
    databaseUrl: string;
    masterKey: string;
    token?: string;
    apply: boolean;
  };
  validateDatabaseUrl(input.databaseUrl);
  if (typeof input.apply !== "boolean" || typeof input.masterKey !== "string")
    throw new RecoveryError("INVALID_INPUT");
  process.env.DATABASE_URL = input.databaseUrl;
  const { db } = await import("../src/server/db");
  const { testBotRecoveryRepository } =
    await import("../src/server/repositories/test-bot-recovery.repository");
  try {
    const result = await recoverTestBot(input, testBotRecoveryRepository(db));
    console.log(JSON.stringify({ ok: true, ...result }));
  } finally {
    await db.$disconnect();
  }
}
main().catch((error: unknown) => {
  console.log(
    JSON.stringify({
      ok: false,
      code:
        error instanceof RecoveryError
          ? error.code
          : "RECOVERY_FAILED_NO_SECRETS_LOGGED",
    }),
  );
  process.exitCode = 1;
});
