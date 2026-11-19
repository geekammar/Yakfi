/**
 * Read-only selected-runtime credential pairing preflight.
 *
 * Proves that the candidate `CREDENTIAL_MASTER_KEY` decrypts the intended
 * existing `fp:<id>` runtime credential in the authorized active Neon dataset
 * (`ep-little-mouse-a5nh644n[-pooler].us-east-2.aws.neon.tech/neondb`) for the
 * pinned Business/Connection/Bot identity — with ZERO database writes, ZERO
 * Telegram HTTP calls, ZERO paid AI calls, and ZERO secret values in outputs.
 */
import { decryptCredential, resolveMasterKey } from "./credential-crypto";
import {
  RecoveryError,
  TARGET,
  validateDatabaseUrl,
  type Connection,
  type RecoveryRepository,
} from "./test-bot-recovery";

export type SelectedRuntimePreflightRepo = Pick<
  RecoveryRepository,
  "readConnection" | "readCredential"
>;

export type SelectedRuntimePreflightOk = {
  ok: true;
  status: "HEALTHY_LOCAL_KEY";
  code: "DECRYPTION_VERIFIED_READONLY";
};

export type SelectedRuntimePreflightErr = {
  ok: false;
  status: "REPAIR_NEEDED" | "BLOCKED";
  code: string;
};

type PreflightOk = SelectedRuntimePreflightOk;
type PreflightErr = SelectedRuntimePreflightErr;
export type SelectedRuntimePreflightResult = PreflightOk | PreflightErr;

export type SelectedRuntimePreflightParams = {
  databaseUrl: string;
  masterKey: string;
};

export type SelectedRuntimePreflightDeps = {
  repo: SelectedRuntimePreflightRepo;
  /**
   * Test-only override allowing loopback disposable PostgreSQL URLs in CI.
   * Remote / non-loopback non-authorized hosts remain strictly rejected.
   */
  allowLocalDisposableDbForTests?: boolean;
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const BOT_CREDENTIAL_FORMAT_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;

function isLoopbackDatabaseUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return false;
    }
    const host = parsed.hostname;
    return (
      LOOPBACK_HOSTS.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

function validateTargetConnection(conn: Connection | null): string | null {
  if (
    !conn ||
    conn.id !== TARGET.connectionId ||
    conn.businessId !== TARGET.businessId ||
    conn.botExternalId !== TARGET.botId ||
    conn.botUsername?.toLowerCase() !== TARGET.username.toLowerCase()
  ) {
    return "CONNECTION_IDENTITY_MISMATCH";
  }
  if (
    !conn.isActive ||
    conn.status !== "CONNECTED" ||
    conn.deletedAt !== null ||
    conn.credentialKind !== "RUNTIME"
  ) {
    return "CONNECTION_NOT_ELIGIBLE";
  }
  return null;
}

export async function verifySelectedRuntimePreflight(
  params: SelectedRuntimePreflightParams,
  deps: SelectedRuntimePreflightDeps,
): Promise<SelectedRuntimePreflightResult> {
  const rawUrl = params.databaseUrl?.trim() ?? "";
  if (!rawUrl) {
    return { ok: false, status: "BLOCKED", code: "INVALID_DATABASE_URL" };
  }

  const allowLoopback = deps.allowLocalDisposableDbForTests === true;
  if (allowLoopback && isLoopbackDatabaseUrl(rawUrl)) {
    // Authorized disposable loopback PostgreSQL in CI test harness only.
  } else {
    try {
      validateDatabaseUrl(rawUrl);
    } catch (err: unknown) {
      const code =
        err instanceof RecoveryError
          ? err.code
          : "DATABASE_TARGET_NOT_AUTHORIZED";
      return { ok: false, status: "BLOCKED", code };
    }
  }

  const keyRes = resolveMasterKey(params.masterKey?.trim());
  if (!keyRes.ok) {
    return {
      ok: false,
      status: "BLOCKED",
      code: "MASTER_KEY_UNAVAILABLE_OR_INVALID",
    };
  }

  try {
    const conn = await deps.repo.readConnection();
    const connErr = validateTargetConnection(conn);
    if (connErr || !conn) {
      return {
        ok: false,
        status: "BLOCKED",
        code: connErr ?? "CONNECTION_IDENTITY_MISMATCH",
      };
    }

    if (!conn.credentialsRef || !conn.credentialsRef.startsWith("fp:")) {
      return {
        ok: false,
        status: "REPAIR_NEEDED",
        code: "MISSING_REFERENCE",
      };
    }

    const row = await deps.repo.readCredential(conn.credentialsRef);
    if (!row) {
      return {
        ok: false,
        status: "REPAIR_NEEDED",
        code: "MISSING_CREDENTIAL_RECORD",
      };
    }

    if (
      row.businessId !== TARGET.businessId ||
      row.credentialsRef !== conn.credentialsRef
    ) {
      return {
        ok: false,
        status: "BLOCKED",
        code: "CREDENTIAL_OWNERSHIP_MISMATCH",
      };
    }

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
      return {
        ok: false,
        status: "REPAIR_NEEDED",
        code: "MALFORMED_RECORD",
      };
    }

    let decryptedSecret: string;
    try {
      decryptedSecret = decryptCredential(keyRes.key, row.cipherBlob);
    } catch {
      return {
        ok: false,
        status: "REPAIR_NEEDED",
        code: "AUTHENTICATION_FAILED_KEY_OR_DATA",
      };
    }

    if (!BOT_CREDENTIAL_FORMAT_RE.test(decryptedSecret)) {
      return {
        ok: false,
        status: "REPAIR_NEEDED",
        code: "DECRYPTED_CREDENTIAL_FORMAT_INVALID",
      };
    }

    const botIdPrefix = decryptedSecret.split(":")[0] ?? "";
    if (botIdPrefix !== TARGET.botId) {
      return {
        ok: false,
        status: "BLOCKED",
        code: "DECRYPTED_BOT_IDENTITY_MISMATCH",
      };
    }

    return {
      ok: true,
      status: "HEALTHY_LOCAL_KEY",
      code: "DECRYPTION_VERIFIED_READONLY",
    };
  } catch {
    return {
      ok: false,
      status: "BLOCKED",
      code: "PREFLIGHT_READ_FAILED",
    };
  } finally {
    keyRes.key.fill(0);
  }
}
