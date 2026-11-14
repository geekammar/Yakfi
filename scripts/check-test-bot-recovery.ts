import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  decryptCredential,
  encryptCredential,
} from "../src/server/credentials/credential-crypto";
import {
  TARGET,
  recoverTestBot,
  validateDatabaseUrl,
  verifyBot,
  type Connection,
  type Credential,
  type RecoveryRepository,
} from "../src/server/credentials/test-bot-recovery";

const key = randomBytes(32);
const token = `${TARGET.botId}:${"x".repeat(30)}`;
const connection: Connection = {
  id: TARGET.connectionId,
  businessId: TARGET.businessId,
  botExternalId: TARGET.botId,
  botUsername: TARGET.username,
  status: "CONNECTED",
  isActive: true,
  deletedAt: null,
  credentialsRef: "fp:old",
  credentialKind: "RUNTIME",
  updatedAt: new Date(),
};
let checks = 0;
async function test(name: string, run: () => Promise<void> | void) {
  await run();
  checks++;
  console.log(`PASS ${name}`);
}
function harness(
  row: Credential | null = null,
  patch: Partial<Connection> = {},
) {
  let writes = 0;
  const repo: RecoveryRepository = {
    readConnection: async () => ({ ...connection, ...patch }),
    readCredential: async () => row,
    replace: async (_expected, replacement, verify) => {
      verify(replacement);
      row = replacement;
      writes++;
    },
  };
  return { repo, writes: () => writes, row: () => row };
}
const credential = (
  cipherBlob = encryptCredential(key, token),
): Credential => ({
  credentialsRef: "fp:old",
  businessId: TARGET.businessId,
  algorithm: "AES-256-GCM",
  keyVersion: 1,
  cipherBlob,
});
const options = { masterKey: key.toString("hex"), apply: false };
const checkBot = async (actual: string) => {
  assert.equal(actual, token);
};
async function main() {
  await test("missing reference is read-only", async () => {
    const h = harness();
    assert.equal(
      (await recoverTestBot(options, h.repo, checkBot)).status,
      "REPAIR_NEEDED",
    );
    assert.equal(h.writes(), 0);
  });
  await test("healthy hex key, no rewrite", async () => {
    const h = harness(credential());
    assert.equal(
      (await recoverTestBot(options, h.repo, checkBot)).status,
      "HEALTHY_LOCAL_KEY",
    );
    assert.equal(h.writes(), 0);
  });
  await test("base64 key accepted by canonical crypto", async () => {
    const h = harness(credential());
    assert.equal(
      (
        await recoverTestBot(
          { ...options, masterKey: key.toString("base64") },
          h.repo,
          checkBot,
        )
      ).status,
      "HEALTHY_LOCAL_KEY",
    );
  });
  await test("wrong key is not reported as missing record", async () => {
    const h = harness(credential(encryptCredential(randomBytes(32), token)));
    assert.equal(
      (await recoverTestBot(options, h.repo, checkBot)).diagnosis,
      "AUTHENTICATION_FAILED_KEY_OR_DATA",
    );
  });
  await test("truncated package is malformed", async () => {
    assert.equal(
      (
        await recoverTestBot(
          options,
          harness(credential("v1:AA==")).repo,
          checkBot,
        )
      ).diagnosis,
      "MALFORMED_RECORD",
    );
  });
  await test("foreign tenant aborts even in apply mode", async () => {
    const h = harness({ ...credential(), businessId: "foreign" });
    await assert.rejects(
      recoverTestBot({ ...options, apply: true, token }, h.repo, checkBot),
      /OWNERSHIP/,
    );
    assert.equal(h.writes(), 0);
  });
  for (const patch of [
    { botExternalId: "other" },
    { botUsername: null },
    { isActive: false },
    { deletedAt: new Date() },
    { credentialKind: "ENV" },
  ]) {
    await test("connection identity and eligibility fail closed", async () => {
      const h = harness(null, patch);
      await assert.rejects(
        recoverTestBot({ ...options, apply: true, token }, h.repo, checkBot),
      );
      assert.equal(h.writes(), 0);
    });
  }
  await test("repair uses canonical cipher and preserves rollback ref", async () => {
    const h = harness();
    const r = await recoverTestBot(
      { ...options, apply: true, token },
      h.repo,
      checkBot,
    );
    assert.equal(h.writes(), 1);
    assert.equal(r.previousReference, "fp:old");
    assert.equal(decryptCredential(key, h.row()!.cipherBlob), token);
    assert.equal(r.previewVerified, false);
  });
  await test("Telegram failure prevents any write", async () => {
    const h = harness();
    await assert.rejects(
      recoverTestBot({ ...options, apply: true, token }, h.repo, async () => {
        throw new Error("offline");
      }),
    );
    assert.equal(h.writes(), 0);
  });
  await test("wrong live bot rejected", async () => {
    await assert.rejects(
      verifyBot(
        token,
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: 1, username: TARGET.username, is_bot: true },
            }),
          ),
      ),
      /IDENTITY/,
    );
  });
  await test("correct live identity accepted", async () => {
    await verifyBot(
      token,
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              id: Number(TARGET.botId),
              username: TARGET.username,
              is_bot: true,
            },
          }),
        ),
    );
  });
  await test("database host/TLS overrides rejected", () => {
    for (const url of [
      "postgres://production/neondb?sslmode=require",
      "postgres://ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?host=production",
      "postgres://ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech/neondb?sslmode=disable",
    ])
      assert.throws(() => validateDatabaseUrl(url));
  });
  await test("authorized test URL accepted", () => {
    validateDatabaseUrl(
      "postgresql://ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    );
  });
  await test("corrupted readback cannot succeed", async () => {
    const h = harness();
    h.repo.replace = async (_expected, row, verify) => {
      verify({ ...row, cipherBlob: encryptCredential(key, "different") });
    };
    await assert.rejects(
      recoverTestBot({ ...options, apply: true, token }, h.repo, checkBot),
      /PERSISTED/,
    );
  });
  await test("concurrency abort propagated", async () => {
    const h = harness();
    h.repo.replace = async () => {
      throw new Error("CONCURRENT_CONNECTION_CHANGE");
    };
    await assert.rejects(
      recoverTestBot({ ...options, apply: true, token }, h.repo, checkBot),
      /CONCURRENT/,
    );
  });
  console.log(
    `${checks}/${checks} passed; synthetic credentials, no network or database mutations.`,
  );
}
main().catch(() => {
  console.error("RECOVERY_TEST_FAILED");
  process.exitCode = 1;
});
