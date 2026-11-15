/** One-time, fixed-target test recovery. No webhook or master-key changes. */
import { randomUUID } from "node:crypto";

import {
  decryptCredential,
  encryptCredential,
  resolveMasterKey,
} from "./credential-crypto";

export const TARGET = {
  businessId: "f5314115-ae8c-46ea-9d7e-080ef5e7366d",
  connectionId: "1d2cdf87-2bee-4f26-aad5-5ab9efd1c716",
  botId: "8926541123",
  username: "Drafnanafnanbot",
} as const;
export type Connection = {
  id: string;
  businessId: string;
  botExternalId: string;
  botUsername: string | null;
  status: string;
  isActive: boolean;
  deletedAt: Date | null;
  credentialsRef: string | null;
  credentialKind: string | null;
  updatedAt: Date;
};
export type Credential = {
  credentialsRef: string;
  businessId: string;
  algorithm: string;
  keyVersion: number;
  cipherBlob: string;
};
export interface RecoveryRepository {
  readConnection(): Promise<Connection | null>;
  readCredential(reference: string): Promise<Credential | null>;
  replace(
    expected: Connection,
    row: Credential,
    verify: (row: Credential) => void,
  ): Promise<void>;
}
export class RecoveryError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new RecoveryError(code);
}
export function validateDatabaseUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RecoveryError("INVALID_DATABASE_URL");
  }
  const hosts = [
    "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech",
    "ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech",
  ];
  requireCondition(
    ["postgres:", "postgresql:"].includes(url.protocol) &&
      hosts.includes(url.hostname) &&
      url.pathname === "/neondb" &&
      (!url.port || url.port === "5432") &&
      !url.hash,
    "DATABASE_TARGET_NOT_AUTHORIZED",
  );
  // Disallow connection-string overrides of the validated destination/TLS policy.
  for (const [name, value] of url.searchParams) {
    requireCondition(
      (name === "sslmode" && ["require", "verify-full"].includes(value)) ||
        (name === "channel_binding" && value === "require"),
      "DATABASE_OPTIONS_NOT_AUTHORIZED",
    );
  }
  requireCondition(url.searchParams.has("sslmode"), "DATABASE_TLS_REQUIRED");
}
function validConnection(conn: Connection | null): asserts conn is Connection {
  requireCondition(
    conn &&
      conn.id === TARGET.connectionId &&
      conn.businessId === TARGET.businessId &&
      conn.botExternalId === TARGET.botId &&
      conn.botUsername?.toLowerCase() === TARGET.username.toLowerCase(),
    "CONNECTION_IDENTITY_MISMATCH",
  );
  requireCondition(
    conn.isActive &&
      conn.status === "CONNECTED" &&
      conn.deletedAt === null &&
      conn.credentialKind === "RUNTIME",
    "CONNECTION_NOT_ELIGIBLE",
  );
}
export async function verifyBot(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  requireCondition(
    /^\d+:[A-Za-z0-9_-]{20,}$/.test(token),
    "TOKEN_FORMAT_INVALID",
  );
  let body: {
    ok?: boolean;
    result?: { id?: number; username?: string; is_bot?: boolean };
  };
  try {
    const response = await fetchImpl(
      `https://api.telegram.org/bot${token}/getMe`,
      { signal: AbortSignal.timeout(10000), redirect: "error" },
    );
    requireCondition(response.ok, "TELEGRAM_CHECK_FAILED");
    body = await response.json();
  } catch {
    throw new RecoveryError("TELEGRAM_CHECK_FAILED");
  }
  requireCondition(
    body?.ok === true &&
      body.result?.is_bot === true &&
      String(body.result.id) === TARGET.botId &&
      body.result.username?.toLowerCase() === TARGET.username.toLowerCase(),
    "BOT_IDENTITY_MISMATCH",
  );
}
export async function recoverTestBot(
  input: { masterKey: string; token?: string; apply: boolean },
  repo: RecoveryRepository,
  checkBot: (token: string) => Promise<void> = verifyBot,
) {
  const key = resolveMasterKey(input.masterKey);
  requireCondition(key.ok, "MASTER_KEY_UNAVAILABLE_OR_INVALID");
  try {
    const conn = await repo.readConnection();
    validConnection(conn);
    const row = conn.credentialsRef
      ? await repo.readCredential(conn.credentialsRef)
      : null;
    let diagnosis = "MISSING_REFERENCE";
    if (row) {
      requireCondition(
        row.businessId === TARGET.businessId &&
          row.credentialsRef === conn.credentialsRef,
        "CREDENTIAL_OWNERSHIP_MISMATCH",
      );
      const encoded = row.cipherBlob.startsWith("v1:")
        ? row.cipherBlob.slice(3)
        : "";
      const bytes = Buffer.from(encoded, "base64");
      if (
        row.algorithm !== "AES-256-GCM" ||
        row.keyVersion !== 1 ||
        bytes.length < 29 ||
        bytes.toString("base64") !== encoded
      ) {
        diagnosis = "MALFORMED_RECORD";
      } else {
        let token: string | undefined;
        try {
          token = decryptCredential(key.key, row.cipherBlob);
        } catch {
          diagnosis = "AUTHENTICATION_FAILED_KEY_OR_DATA";
        }
        if (token !== undefined) {
          // A network error or wrong identity must not trigger automatic replacement.
          await checkBot(token);
          return { status: "HEALTHY_LOCAL_KEY", previewVerified: false };
        }
      }
    }
    if (!input.apply)
      return { status: "REPAIR_NEEDED", diagnosis, previewVerified: false };
    requireCondition(input.token, "BOT_TOKEN_REQUIRED");
    const token = input.token.trim();
    await checkBot(token);
    const replacement: Credential = {
      credentialsRef: `fp:${randomUUID()}`,
      businessId: TARGET.businessId,
      cipherBlob: encryptCredential(key.key, token),
      algorithm: "AES-256-GCM",
      keyVersion: 1,
    };
    const verify = (persisted: Credential) => {
      requireCondition(
        persisted.credentialsRef === replacement.credentialsRef &&
          persisted.businessId === TARGET.businessId &&
          persisted.algorithm === "AES-256-GCM" &&
          persisted.keyVersion === 1,
        "PERSISTED_METADATA_MISMATCH",
      );
      requireCondition(
        decryptCredential(key.key, persisted.cipherBlob) === token,
        "PERSISTED_CRYPTO_MISMATCH",
      );
    };
    // Repository reads the actual inserted row and verifies inside its transaction.
    await repo.replace(conn, replacement, verify);
    return {
      status: "REPAIRED_LOCAL_KEY",
      previousReference: conn.credentialsRef,
      newReference: replacement.credentialsRef,
      previewVerified: false,
    };
  } finally {
    key.key.fill(0);
  }
}
