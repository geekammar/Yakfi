/** Operator-only repository; never imported by application request handlers. */
import type { PrismaClient } from "@/generated/prisma/client";

import {
  RecoveryError,
  TARGET,
  type Connection,
  type Credential,
  type RecoveryRepository,
} from "../credentials/test-bot-recovery";

export function testBotRecoveryRepository(
  db: PrismaClient,
): RecoveryRepository {
  return {
    readConnection: () =>
      db.telegramConnection.findFirst({
        where: { id: TARGET.connectionId, businessId: TARGET.businessId },
      }),
    readCredential: (credentialsRef) =>
      db.runtimeCredential.findUnique({ where: { credentialsRef } }),
    async replace(expected: Connection, row: Credential, verify) {
      await db.$transaction(
        async (tx) => {
          await tx.runtimeCredential.create({ data: row });
          const changed = await tx.telegramConnection.updateMany({
            where: {
              id: TARGET.connectionId,
              businessId: TARGET.businessId,
              botExternalId: TARGET.botId,
              botUsername: expected.botUsername,
              credentialsRef: expected.credentialsRef,
              credentialKind: "RUNTIME",
              updatedAt: expected.updatedAt,
              deletedAt: null,
              status: "CONNECTED",
              isActive: true,
            },
            data: { credentialsRef: row.credentialsRef },
          });
          if (changed.count !== 1)
            throw new RecoveryError("CONCURRENT_CONNECTION_CHANGE");
          const saved = await tx.runtimeCredential.findUnique({
            where: { credentialsRef: row.credentialsRef },
          });
          if (!saved) throw new RecoveryError("PERSISTED_RECORD_MISSING");
          verify(saved);
          // Keep the original record intact for targeted rollback; do not delete it.
        },
        { timeout: 15000, maxWait: 5000 },
      );
    },
  };
}
