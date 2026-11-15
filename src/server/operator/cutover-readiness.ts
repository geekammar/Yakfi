import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import {
  defaultTelegramApiDeps,
  telegramGetMe,
  type TelegramApiResult,
  type TelegramBotUser,
} from "@/server/integrations/telegram/telegram-client";
import type { TelegramConnectionRepository } from "@/server/repositories";
import type { TelegramConnection } from "@/types/domain";

export const CUTOVER_READINESS_PATH = "/api/operator/cutover-readiness";
export const CUTOVER_READINESS_BUSINESS_ID =
  "f5314115-ae8c-46ea-9d7e-080ef5e7366d";
export const CUTOVER_READINESS_CONNECTION_ID =
  "1d2cdf87-2bee-4f26-aad5-5ab9efd1c716";
export const CUTOVER_READINESS_BOT_ID = "8926541123";
export const CUTOVER_READINESS_BOT_USERNAME = "Drafnanafnanbot";
const CUTOVER_READINESS_MAX_SKEW_MS = 120_000;

export type CutoverReadinessOutcome = {
  status: number;
  body: Record<string, unknown>;
};

type ReadinessDeps = {
  connectionRepository?: Pick<
    TelegramConnectionRepository,
    "findByIdWithinBusiness"
  >;
  credentialsResolver?: Pick<CredentialsResolver, "resolve">;
  getMe?: (
    token: string,
  ) => Promise<TelegramApiResult<TelegramBotUser>>;
  getEnvVar?: (name: string) => string | undefined;
  now?: () => number;
};

export function cutoverSignatureMessage(
  timestamp: string,
  botId: string,
): string {
  return `${timestamp}\nGET\n${CUTOVER_READINESS_PATH}\n${botId}`;
}

export function signCutoverReadiness(
  botToken: string,
  timestamp: string,
  botId: string,
): string {
  return createHmac("sha256", botToken)
    .update(cutoverSignatureMessage(timestamp, botId))
    .digest("hex");
}

function constantTimeEqual(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function parseDatabaseIdentity(databaseUrl: string | undefined): {
  host: string;
  name: string;
} | null {
  if (!databaseUrl) return null;
  try {
    const url = new URL(databaseUrl);
    const name = url.pathname.replace(/^\/+/, "");
    if (!url.hostname || !name) return null;
    return { host: url.hostname, name };
  } catch {
    return null;
  }
}

function validConnection(
  conn: TelegramConnection | null,
): conn is TelegramConnection & { credentialsRef: string } {
  return Boolean(
    conn &&
      conn.id === CUTOVER_READINESS_CONNECTION_ID &&
      conn.businessId === CUTOVER_READINESS_BUSINESS_ID &&
      conn.botExternalId === CUTOVER_READINESS_BOT_ID &&
      conn.botUsername?.toLowerCase() ===
        CUTOVER_READINESS_BOT_USERNAME.toLowerCase() &&
      conn.status === "CONNECTED" &&
      conn.isActive &&
      conn.deletedAt === null &&
      conn.credentialsRef,
  );
}

export async function checkCutoverReadiness(
  request: Request,
  params: {
    commitSha: string | null;
    version: string;
  },
  deps: ReadinessDeps = {},
): Promise<CutoverReadinessOutcome> {
  const now = deps.now ?? Date.now;
  const getEnvVar =
    deps.getEnvVar ?? ((name: string) => process.env[name]);
  const providedBotId =
    request.headers.get("x-flowpilot-cutover-bot-id")?.trim() ?? "";
  const timestamp =
    request.headers.get("x-flowpilot-cutover-timestamp")?.trim() ?? "";
  const signature =
    request.headers.get("x-flowpilot-cutover-signature")?.trim() ?? "";

  if (!providedBotId || !timestamp || !signature) {
    return {
      status: 401,
      body: { ok: false, code: "UNAUTHORIZED" },
    };
  }
  if (providedBotId !== CUTOVER_READINESS_BOT_ID) {
    return {
      status: 403,
      body: { ok: false, code: "FORBIDDEN" },
    };
  }
  const timestampMs = Number(timestamp);
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(now() - timestampMs) > CUTOVER_READINESS_MAX_SKEW_MS
  ) {
    return {
      status: 401,
      body: { ok: false, code: "STALE_OR_INVALID_TIMESTAMP" },
    };
  }

  const database = parseDatabaseIdentity(getEnvVar("DATABASE_URL"));
  if (!database) {
    return {
      status: 503,
      body: { ok: false, code: "DATABASE_UNAVAILABLE" },
    };
  }

  const connectionRepository =
    deps.connectionRepository ??
    (await import("@/server/repositories")).telegramConnectionRepository;
  const credentialsResolver =
    deps.credentialsResolver ?? defaultCredentialsResolver;
  const getMe =
    deps.getMe ??
    ((token: string) => telegramGetMe(defaultTelegramApiDeps, token));

  const connection = await connectionRepository.findByIdWithinBusiness(
    CUTOVER_READINESS_CONNECTION_ID,
    CUTOVER_READINESS_BUSINESS_ID,
  );
  if (!validConnection(connection)) {
    return {
      status: 503,
      body: { ok: false, code: "FIXED_CONNECTION_NOT_READY" },
    };
  }

  const resolved = await credentialsResolver.resolve(connection.credentialsRef);
  if (!resolved.ok) {
    return {
      status: 503,
      body: { ok: false, code: "CREDENTIAL_UNRESOLVED" },
    };
  }

  const expectedSignature = signCutoverReadiness(
    resolved.value,
    timestamp,
    providedBotId,
  );
  if (!constantTimeEqual(signature, expectedSignature)) {
    return {
      status: 401,
      body: { ok: false, code: "UNAUTHORIZED" },
    };
  }

  const me = await getMe(resolved.value);
  if (
    !me.ok ||
    me.result.id !== Number(CUTOVER_READINESS_BOT_ID) ||
    me.result.is_bot !== true ||
    me.result.username?.toLowerCase() !==
      CUTOVER_READINESS_BOT_USERNAME.toLowerCase()
  ) {
    return {
      status: 503,
      body: { ok: false, code: "BOT_IDENTITY_UNRESOLVED" },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      checkedAt: new Date(now()).toISOString(),
      commitSha: params.commitSha,
      version: params.version,
      databaseHost: database.host,
      databaseName: database.name,
      businessId: connection.businessId,
      connectionId: connection.id,
      botExternalId: connection.botExternalId,
      botUsername: connection.botUsername,
      connectionStatus: connection.status,
      credentialResolved: true,
    },
  };
}
