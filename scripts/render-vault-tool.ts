#!/usr/bin/env node
/**
 * Yakfi — Recoverable Secrets Vault Envelope & Guarded Render Transfer Tool.
 *
 * Security invariants:
 * - Targets ONLY the confirmed Render workspace `tea-db9st3gm7kps73ek9op0`
 *   ("My Workspace") and `ohio` web_service instances.
 * - Transfers/exports ONLY the explicit allowlist (`DATABASE_URL`,
 *   `CREDENTIAL_MASTER_KEY`).
 * - Encrypts secrets strictly in memory to an owner-controlled X25519 public
 *   recipient (`yakfi-rcpt-v1:<base64url-spki>`) via ECDH + HKDF-SHA256 +
 *   AES-256-GCM with authenticated metadata (AAD).
 * - Never prints secret values, connection strings, headers, ciphertexts, or
 *   raw provider bodies; never creates plaintext CI artifacts.
 * - Restoration check (`verify-bundle`) proves decryptability + schema validity
 *   using the owner's private key without printing plaintext values.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { resolveMasterKey } from "../src/server/credentials/credential-crypto";
import { validateDatabaseUrl } from "../src/server/credentials/test-bot-recovery";
import {
  CUTOVER_READINESS_BOT_ID,
  CUTOVER_READINESS_BOT_USERNAME,
  CUTOVER_READINESS_BUSINESS_ID,
  CUTOVER_READINESS_CONNECTION_ID,
  CUTOVER_READINESS_PATH,
  signCutoverReadiness,
} from "../src/server/operator/cutover-readiness";

export const CONFIRMED_RENDER_WORKSPACE_ID = "tea-db9st3gm7kps73ek9op0";
export const CONFIRMED_RENDER_REGION = "ohio";
export const CONFIRMED_VERCEL_PROJECT_ID = "prj_CjKh6Qt6IAKEc9EB4StaJJxnP0Fp";

export const EXPLICIT_TRANSFER_ALLOWLIST = [
  "DATABASE_URL",
  "CREDENTIAL_MASTER_KEY",
] as const;

export type AllowlistedKey = (typeof EXPLICIT_TRANSFER_ALLOWLIST)[number];

const ALLOWLIST_SET = new Set<string>(EXPLICIT_TRANSFER_ALLOWLIST);
const RECIPIENT_PREFIX = "yakfi-rcpt-v1:";
const PRIVATE_KEY_PREFIX = "yakfi-priv-v1:";
const BUNDLE_SCHEMA = "yakfi.encrypted-secret-bundle@v1";
const HKDF_INFO = Buffer.from("yakfi-render-vault-envelope-v1", "utf8");
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const RENDER_SERVICE_ID_RE = /^srv-[a-z0-9]{16,32}$/;

const AUTHORIZED_ACTIVE_DB_HOSTS = new Set([
  "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech",
  "ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech",
]);

const LEGACY_INACTIVE_DB_HOSTS = new Set([
  "ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech",
  "ep-tiny-grass-a5e63jev-pooler.us-east-2.aws.neon.tech",
]);

export type EncryptedSecretBundle = {
  schema: typeof BUNDLE_SCHEMA;
  createdAt: string;
  recipient: string;
  ephemeralPublicKey: string;
  iv: string;
  salt: string;
  authTag: string;
  ciphertext: string;
  metadata: {
    workspaceId: string;
    serviceId: string;
    commitSha: string;
    keyNames: AllowlistedKey[];
  };
};

export type SafeTransferSummary = {
  ok: boolean;
  mode: string;
  code: string;
  workspaceId: string;
  serviceId?: string;
  commitSha?: string;
  dryRun?: boolean;
  transferredKeys?: AllowlistedKey[];
  failedKey?: AllowlistedKey;
  encryptedBundleWritten?: boolean;
};

export function generateOwnerRecoveryKeypair(): {
  recipient: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const spkiB64 = Buffer.from(spki).toString("base64url");
  const pkcs8B64 = Buffer.from(pkcs8).toString("base64url");
  return {
    recipient: `${RECIPIENT_PREFIX}${spkiB64}`,
    privateKey: `${PRIVATE_KEY_PREFIX}${pkcs8B64}`,
  };
}

function parseRecipientPublicKey(recipient: string) {
  const trimmed = recipient.trim();
  if (!trimmed.startsWith(RECIPIENT_PREFIX)) {
    throw new Error("INVALID_OWNER_RECIPIENT");
  }
  const b64 = trimmed.slice(RECIPIENT_PREFIX.length);
  if (!b64 || !/^[A-Za-z0-9_-]{40,120}$/.test(b64)) {
    throw new Error("INVALID_OWNER_RECIPIENT");
  }
  const der = Buffer.from(b64, "base64url");
  const keyObj = createPublicKey({ key: der, format: "der", type: "spki" });
  if (keyObj.asymmetricKeyType !== "x25519") {
    throw new Error("INVALID_OWNER_RECIPIENT");
  }
  return { normalizedRecipient: trimmed, keyObj };
}

function parseOwnerPrivateKey(rawPrivate: string) {
  const trimmed = rawPrivate.trim();
  if (!trimmed.startsWith(PRIVATE_KEY_PREFIX)) {
    throw new Error("INVALID_OWNER_PRIVATE_KEY");
  }
  const b64 = trimmed.slice(PRIVATE_KEY_PREFIX.length);
  if (!b64 || !/^[A-Za-z0-9_-]{40,160}$/.test(b64)) {
    throw new Error("INVALID_OWNER_PRIVATE_KEY");
  }
  const der = Buffer.from(b64, "base64url");
  try {
    const keyObj = createPrivateKey({
      key: der,
      format: "der",
      type: "pkcs8",
    });
    if (keyObj.asymmetricKeyType !== "x25519") {
      throw new Error("INVALID_OWNER_PRIVATE_KEY");
    }
    return keyObj;
  } finally {
    der.fill(0);
  }
}

export function parseAllowlist(raw: string): AllowlistedKey[] {
  const items = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (items.length === 0) {
    throw new Error("EMPTY_ALLOWLIST");
  }
  const unique = new Set<AllowlistedKey>();
  for (const item of items) {
    if (!ALLOWLIST_SET.has(item)) {
      throw new Error("DISALLOWED_SECRET_KEY");
    }
    unique.add(item as AllowlistedKey);
  }
  return Array.from(unique).sort();
}

export function validateAllowlistedValue(
  key: AllowlistedKey,
  rawValue: string | undefined,
): string {
  const trimmed = rawValue?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`MISSING_${key}`);
  }
  if (key === "DATABASE_URL") {
    try {
      validateDatabaseUrl(trimmed);
    } catch {
      throw new Error("UNAUTHORIZED_DATABASE_URL_TARGET");
    }
    return trimmed;
  }
  const resolved = resolveMasterKey(trimmed);
  if (!resolved.ok) {
    throw new Error("INVALID_CREDENTIAL_MASTER_KEY_FORMAT");
  }
  resolved.key.fill(0);
  return trimmed;
}

function buildBundleAad(params: {
  recipient: string;
  workspaceId: string;
  serviceId: string;
  commitSha: string;
  keyNames: AllowlistedKey[];
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: BUNDLE_SCHEMA,
      recipient: params.recipient,
      workspaceId: params.workspaceId,
      serviceId: params.serviceId,
      commitSha: params.commitSha,
      keyNames: params.keyNames,
    }),
    "utf8",
  );
}

export function encryptAllowlistedSecretsForOwner(params: {
  recipient: string;
  allowlist: AllowlistedKey[];
  sourceValues: Partial<Record<AllowlistedKey, string | undefined>>;
  commitSha: string;
  serviceId: string;
  workspaceId?: string;
  now?: () => Date;
}): EncryptedSecretBundle {
  const commitSha = params.commitSha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(commitSha)) {
    throw new Error("INVALID_COMMIT_SHA");
  }
  const serviceId = params.serviceId.trim();
  if (!RENDER_SERVICE_ID_RE.test(serviceId)) {
    throw new Error("INVALID_RENDER_SERVICE_ID");
  }
  const workspaceId = (
    params.workspaceId ?? CONFIRMED_RENDER_WORKSPACE_ID
  ).trim();
  if (workspaceId !== CONFIRMED_RENDER_WORKSPACE_ID) {
    throw new Error("WORKSPACE_ID_MISMATCH");
  }
  if (params.allowlist.length === 0) {
    throw new Error("EMPTY_ALLOWLIST");
  }

  const sortedKeys = [...params.allowlist].sort();
  for (const key of sortedKeys) {
    if (!ALLOWLIST_SET.has(key)) {
      throw new Error("DISALLOWED_SECRET_KEY");
    }
  }

  const { normalizedRecipient, keyObj: recipientPubKey } =
    parseRecipientPublicKey(params.recipient);

  const payloadMap: Record<string, string> = {};
  for (const key of sortedKeys) {
    payloadMap[key] = validateAllowlistedValue(key, params.sourceValues[key]);
  }

  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralSpki = Buffer.from(
    ephemeral.publicKey.export({ format: "der", type: "spki" }),
  );
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPubKey,
  });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const derivedKey = Buffer.from(
    hkdfSync("sha256", shared, salt, HKDF_INFO, 32),
  );
  const plaintextBuf = Buffer.from(
    JSON.stringify({ values: payloadMap }),
    "utf8",
  );

  const aad = buildBundleAad({
    recipient: normalizedRecipient,
    workspaceId,
    serviceId,
    commitSha,
    keyNames: sortedKeys,
  });

  try {
    const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
    cipher.setAAD(aad);
    const enc = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      schema: BUNDLE_SCHEMA,
      createdAt: (params.now ?? (() => new Date()))().toISOString(),
      recipient: normalizedRecipient,
      ephemeralPublicKey: ephemeralSpki.toString("base64url"),
      iv: iv.toString("base64url"),
      salt: salt.toString("base64url"),
      authTag: authTag.toString("base64url"),
      ciphertext: enc.toString("base64url"),
      metadata: {
        workspaceId,
        serviceId,
        commitSha,
        keyNames: sortedKeys,
      },
    };
  } finally {
    shared.fill(0);
    derivedKey.fill(0);
    plaintextBuf.fill(0);
  }
}

export type BundleVerificationResult =
  | {
      ok: true;
      workspaceId: string;
      serviceId: string;
      commitSha: string;
      verifiedKeys: AllowlistedKey[];
    }
  | {
      ok: false;
      code: string;
    };

function decryptBundleToMap(
  bundle: EncryptedSecretBundle,
  rawPrivateKey: string,
): Record<AllowlistedKey, string> {
  if (!bundle || bundle.schema !== BUNDLE_SCHEMA || !bundle.metadata) {
    throw new Error("INVALID_BUNDLE_SCHEMA");
  }
  if (bundle.metadata.workspaceId !== CONFIRMED_RENDER_WORKSPACE_ID) {
    throw new Error("WORKSPACE_ID_MISMATCH");
  }
  if (!RENDER_SERVICE_ID_RE.test(bundle.metadata.serviceId)) {
    throw new Error("INVALID_RENDER_SERVICE_ID");
  }
  if (!FULL_SHA_RE.test(bundle.metadata.commitSha)) {
    throw new Error("INVALID_COMMIT_SHA");
  }

  const ownerPrivKey = parseOwnerPrivateKey(rawPrivateKey);
  const derivedOwnerPubSpki = Buffer.from(
    createPublicKey(ownerPrivKey).export({ format: "der", type: "spki" }),
  ).toString("base64url");
  const expectedRecipient = `${RECIPIENT_PREFIX}${derivedOwnerPubSpki}`;
  if (bundle.recipient !== expectedRecipient) {
    throw new Error("RECIPIENT_KEY_MISMATCH");
  }

  const ephemeralPubDer = Buffer.from(bundle.ephemeralPublicKey, "base64url");
  const ephemeralPubKey = createPublicKey({
    key: ephemeralPubDer,
    format: "der",
    type: "spki",
  });

  const sortedKeys = [...bundle.metadata.keyNames].sort();
  for (const k of sortedKeys) {
    if (!ALLOWLIST_SET.has(k)) {
      throw new Error("DISALLOWED_SECRET_KEY");
    }
  }

  const shared = diffieHellman({
    privateKey: ownerPrivKey,
    publicKey: ephemeralPubKey,
  });
  const salt = Buffer.from(bundle.salt, "base64url");
  const iv = Buffer.from(bundle.iv, "base64url");
  const authTag = Buffer.from(bundle.authTag, "base64url");
  const ciphertext = Buffer.from(bundle.ciphertext, "base64url");
  const derivedKey = Buffer.from(
    hkdfSync("sha256", shared, salt, HKDF_INFO, 32),
  );

  const aad = buildBundleAad({
    recipient: bundle.recipient,
    workspaceId: bundle.metadata.workspaceId,
    serviceId: bundle.metadata.serviceId,
    commitSha: bundle.metadata.commitSha,
    keyNames: sortedKeys,
  });

  let decrypted: Buffer | null = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", derivedKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const parsed = JSON.parse(decrypted.toString("utf8")) as {
      values?: Record<string, unknown>;
    };
    if (!parsed.values || typeof parsed.values !== "object") {
      throw new Error("MALFORMED_DECRYPTED_PAYLOAD");
    }
    const out = {} as Record<AllowlistedKey, string>;
    for (const key of sortedKeys) {
      const val = parsed.values[key];
      if (typeof val !== "string") {
        throw new Error(`MISSING_${key}`);
      }
      out[key] = validateAllowlistedValue(key, val);
    }
    return out;
  } catch (err: unknown) {
    if (err instanceof Error && /^[A-Z0-9_]+$/.test(err.message)) {
      throw err;
    }
    throw new Error("BUNDLE_DECRYPTION_OR_AUTH_FAILED");
  } finally {
    shared.fill(0);
    derivedKey.fill(0);
    if (decrypted) decrypted.fill(0);
  }
}

/**
 * Restoration check: verifies that the owner's private key decrypts the
 * bundle cleanly and that every recovered value satisfies strict runtime
 * format/target validation, returning ONLY values-free metadata.
 */
export function verifyOwnerEncryptedBundle(params: {
  bundle: EncryptedSecretBundle;
  privateKey: string;
}): BundleVerificationResult {
  try {
    const recovered = decryptBundleToMap(params.bundle, params.privateKey);
    const verifiedKeys = (Object.keys(recovered) as AllowlistedKey[]).sort();
    return {
      ok: true,
      workspaceId: params.bundle.metadata.workspaceId,
      serviceId: params.bundle.metadata.serviceId,
      commitSha: params.bundle.metadata.commitSha,
      verifiedKeys,
    };
  } catch (err: unknown) {
    const code =
      err instanceof Error && /^[A-Z0-9_]+$/.test(err.message)
        ? err.message
        : "BUNDLE_VERIFICATION_FAILED";
    return { ok: false, code };
  }
}

export async function verifyRenderServiceOwnership(
  params: {
    serviceId: string;
    renderApiKey: string;
    expectedWorkspaceId?: string;
    expectedRegion?: string;
  },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{
  ok: true;
  serviceId: string;
  serviceName: string;
  workspaceId: string;
  region: string;
}> {
  const serviceId = params.serviceId.trim();
  if (!RENDER_SERVICE_ID_RE.test(serviceId)) {
    throw new Error("INVALID_RENDER_SERVICE_ID");
  }
  const apiCred = params.renderApiKey.trim();
  if (!apiCred) {
    throw new Error("MISSING_RENDER_API_KEY");
  }
  const expectedWorkspace = (
    params.expectedWorkspaceId ?? CONFIRMED_RENDER_WORKSPACE_ID
  ).trim();
  if (expectedWorkspace !== CONFIRMED_RENDER_WORKSPACE_ID) {
    throw new Error("WORKSPACE_ID_MISMATCH");
  }
  const expectedRegion = (
    params.expectedRegion ?? CONFIRMED_RENDER_REGION
  ).trim();

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(
    `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiCred}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`RENDER_SERVICE_LOOKUP_FAILED_${response.status}`);
  }

  const raw = (await response.json()) as {
    service?: {
      id?: unknown;
      name?: unknown;
      ownerId?: unknown;
      type?: unknown;
      serviceDetails?: { region?: unknown };
    };
    id?: unknown;
    name?: unknown;
    ownerId?: unknown;
    type?: unknown;
    serviceDetails?: { region?: unknown };
  };
  const svc = raw.service ?? raw;
  if (svc.id !== serviceId) {
    throw new Error("RENDER_SERVICE_ID_MISMATCH");
  }
  if (svc.ownerId !== expectedWorkspace) {
    throw new Error("RENDER_WORKSPACE_MISMATCH");
  }
  if (svc.type !== "web_service") {
    throw new Error("RENDER_SERVICE_TYPE_MISMATCH");
  }
  const region =
    typeof svc.serviceDetails?.region === "string"
      ? svc.serviceDetails.region.toLowerCase()
      : "";
  if (region && region !== expectedRegion.toLowerCase()) {
    throw new Error("RENDER_REGION_MISMATCH");
  }

  return {
    ok: true,
    serviceId,
    serviceName: typeof svc.name === "string" ? svc.name : "unknown",
    workspaceId: expectedWorkspace,
    region: region || expectedRegion,
  };
}

export async function transferAllowlistedSecretsToRender(
  params: {
    expectedCommitSha: string;
    actualCommitSha: string;
    serviceId: string;
    renderApiKey: string;
    ownerRecipient: string;
    allowlist: AllowlistedKey[];
    sourceValues: Partial<Record<AllowlistedKey, string | undefined>>;
    dryRun: boolean;
  },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<{
  summary: SafeTransferSummary;
  encryptedBundle: EncryptedSecretBundle;
}> {
  const expectedSha = params.expectedCommitSha.trim().toLowerCase();
  const actualSha = params.actualCommitSha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(expectedSha) || expectedSha !== actualSha) {
    throw new Error("COMMIT_SHA_MISMATCH");
  }

  const serviceInfo = await verifyRenderServiceOwnership(
    {
      serviceId: params.serviceId,
      renderApiKey: params.renderApiKey,
    },
    deps,
  );

  // Produce the encrypted owner backup first (proves allowlist + value validity
  // + valid owner recipient BEFORE any Render API write).
  const encryptedBundle = encryptAllowlistedSecretsForOwner({
    recipient: params.ownerRecipient,
    allowlist: params.allowlist,
    sourceValues: params.sourceValues,
    commitSha: expectedSha,
    serviceId: serviceInfo.serviceId,
    workspaceId: serviceInfo.workspaceId,
  });

  const sortedKeys = [...encryptedBundle.metadata.keyNames];

  if (params.dryRun) {
    return {
      encryptedBundle,
      summary: {
        ok: true,
        mode: "transfer-to-render",
        code: "DRY_RUN_READY",
        workspaceId: serviceInfo.workspaceId,
        serviceId: serviceInfo.serviceId,
        commitSha: expectedSha,
        dryRun: true,
        transferredKeys: sortedKeys,
      },
    };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiCred = params.renderApiKey.trim();
  const completed: AllowlistedKey[] = [];

  for (const key of sortedKeys) {
    const val = validateAllowlistedValue(key, params.sourceValues[key]);
    const res = await fetchImpl(
      `https://api.render.com/v1/services/${encodeURIComponent(serviceInfo.serviceId)}/env-vars/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiCred}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: val }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      return {
        encryptedBundle,
        summary: {
          ok: false,
          mode: "transfer-to-render",
          code: `PARTIAL_TRANSFER_FAILURE_${key}`,
          workspaceId: serviceInfo.workspaceId,
          serviceId: serviceInfo.serviceId,
          commitSha: expectedSha,
          dryRun: false,
          transferredKeys: completed,
          failedKey: key,
        },
      };
    }
    completed.push(key);
  }

  return {
    encryptedBundle,
    summary: {
      ok: true,
      mode: "transfer-to-render",
      code: "TRANSFER_APPLIED",
      workspaceId: serviceInfo.workspaceId,
      serviceId: serviceInfo.serviceId,
      commitSha: expectedSha,
      dryRun: false,
      transferredKeys: completed,
    },
  };
}

export type SourceInspectionReport = {
  testDbClassification:
    | "ACTIVE_NEON_TEST_DB"
    | "LEGACY_INACTIVE_PROD_DB"
    | "OTHER_HOST"
    | "MISSING_OR_INVALID";
  prodDbClassification:
    | "ACTIVE_NEON_TEST_DB"
    | "LEGACY_INACTIVE_PROD_DB"
    | "OTHER_HOST"
    | "MISSING_OR_INVALID";
  masterKeyFormatValid: boolean;
  vercelProductionMetadata?: {
    totalProductionCount: number;
    sensitiveCount: number;
    nonSensitiveCount: number;
    keys: Array<{ key: string; type: string }>;
  };
  renderServiceVerified?: {
    serviceId: string;
    workspaceId: string;
    region: string;
  };
};

function classifyDbHostSafe(
  rawUrl: string | undefined,
): SourceInspectionReport["testDbClassification"] {
  if (!rawUrl || !rawUrl.trim()) return "MISSING_OR_INVALID";
  try {
    const parsed = new URL(rawUrl.trim());
    if (AUTHORIZED_ACTIVE_DB_HOSTS.has(parsed.hostname)) {
      return "ACTIVE_NEON_TEST_DB";
    }
    if (LEGACY_INACTIVE_DB_HOSTS.has(parsed.hostname)) {
      return "LEGACY_INACTIVE_PROD_DB";
    }
    return "OTHER_HOST";
  } catch {
    return "MISSING_OR_INVALID";
  }
}

export async function inspectRecoverySources(
  params: {
    testDatabaseUrl?: string;
    prodDatabaseUrl?: string;
    credentialMasterKey?: string;
    vercelAccessCred?: string;
    renderApiKey?: string;
    renderServiceId?: string;
  },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<SourceInspectionReport> {
  const resolvedKey = resolveMasterKey(params.credentialMasterKey?.trim());
  const masterKeyFormatValid = resolvedKey.ok;
  if (resolvedKey.ok) {
    resolvedKey.key.fill(0);
  }

  const report: SourceInspectionReport = {
    testDbClassification: classifyDbHostSafe(params.testDatabaseUrl),
    prodDbClassification: classifyDbHostSafe(params.prodDatabaseUrl),
    masterKeyFormatValid,
  };

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  if (params.vercelAccessCred?.trim()) {
    const res = await fetchImpl(
      `https://api.vercel.com/v10/projects/${CONFIRMED_VERCEL_PROJECT_ID}/env?decrypt=false`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${params.vercelAccessCred.trim()}` },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as {
        envs?: Array<{
          key?: unknown;
          type?: unknown;
          target?: unknown;
        }>;
      };
      if (Array.isArray(data.envs)) {
        const prodEnvs = data.envs.filter((item) => {
          const targets = Array.isArray(item.target)
            ? item.target
            : item.target !== undefined
              ? [item.target]
              : [];
          return targets.includes("production");
        });
        // Strip everything except key name and variable type — NEVER read `value`.
        const keys = prodEnvs
          .map((item) => ({
            key: typeof item.key === "string" ? item.key : "UNKNOWN_KEY",
            type: typeof item.type === "string" ? item.type : "unknown",
          }))
          .sort((a, b) => a.key.localeCompare(b.key));
        const sensitiveCount = keys.filter(
          (k) => k.type === "sensitive" || k.type === "secret",
        ).length;
        report.vercelProductionMetadata = {
          totalProductionCount: keys.length,
          sensitiveCount,
          nonSensitiveCount: keys.length - sensitiveCount,
          keys,
        };
      }
    }
  }

  if (params.renderApiKey?.trim() && params.renderServiceId?.trim()) {
    const verified = await verifyRenderServiceOwnership(
      {
        serviceId: params.renderServiceId,
        renderApiKey: params.renderApiKey,
      },
      deps,
    );
    report.renderServiceVerified = {
      serviceId: verified.serviceId,
      workspaceId: verified.workspaceId,
      region: verified.region,
    };
  }

  return report;
}

export type BacklogDispositionPolicy =
  | "require_zero"
  | "allow_inspected_replay";

export async function verifyRenderCutoverReadinessAndBacklog(
  params: {
    renderOrigin: string;
    expectedCommitSha: string;
    expectedVersion: string;
    databaseUrl: string;
    cutoverSignerCred: string;
    pendingUpdateCount: number;
    backlogPolicy?: BacklogDispositionPolicy;
  },
  deps: {
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<
  | {
      ok: true;
      origin: string;
      commitSha: string;
      version: string;
      pendingUpdateCount: number;
      dropPendingUpdates: false;
    }
  | {
      ok: false;
      code: string;
      pendingUpdateCount?: number;
    }
> {
  const expectedSha = params.expectedCommitSha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(expectedSha)) {
    return { ok: false, code: "INVALID_EXPECTED_COMMIT_SHA" };
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(params.renderOrigin.trim());
  } catch {
    return { ok: false, code: "INVALID_RENDER_ORIGIN" };
  }
  if (
    parsedOrigin.protocol !== "https:" ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    (parsedOrigin.pathname !== "/" && parsedOrigin.pathname !== "") ||
    parsedOrigin.hostname.toLowerCase().endsWith(".vercel.app")
  ) {
    return { ok: false, code: "INVALID_RENDER_ORIGIN" };
  }

  try {
    validateDatabaseUrl(params.databaseUrl.trim());
  } catch {
    return { ok: false, code: "UNAUTHORIZED_DATABASE_URL_TARGET" };
  }

  const signer = params.cutoverSignerCred.trim();
  if (!signer) {
    return { ok: false, code: "MISSING_CUTOVER_SIGNER_CREDENTIAL" };
  }

  // Enforce explicit backlog policy BEFORE any webhook mutation:
  // never drop_pending_updates blindly, and never replay non-zero backlog blindly.
  const policy = params.backlogPolicy ?? "require_zero";
  if (params.pendingUpdateCount > 0 && policy !== "allow_inspected_replay") {
    return {
      ok: false,
      code: "PENDING_UPDATES_REQUIRE_DISPOSITION",
      pendingUpdateCount: params.pendingUpdateCount,
    };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const nowMs = (deps.now ?? Date.now)();
  const timestamp = String(nowMs);
  const origin = parsedOrigin.origin;

  const res = await fetchImpl(`${origin}${CUTOVER_READINESS_PATH}`, {
    method: "GET",
    redirect: "error",
    headers: {
      "x-flowpilot-cutover-bot-id": CUTOVER_READINESS_BOT_ID,
      "x-flowpilot-cutover-timestamp": timestamp,
      "x-flowpilot-cutover-signature": signCutoverReadiness(
        signer,
        timestamp,
        CUTOVER_READINESS_BOT_ID,
      ),
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "RENDER_CUTOVER_READINESS_UNAUTHORIZED" };
  }
  if (!res.ok) {
    return { ok: false, code: "RENDER_CUTOVER_READINESS_UNAVAILABLE" };
  }

  const body = (await res.json()) as {
    ok?: unknown;
    commitSha?: unknown;
    version?: unknown;
    databaseHost?: unknown;
    databaseName?: unknown;
    businessId?: unknown;
    connectionId?: unknown;
    botExternalId?: unknown;
    botUsername?: unknown;
    credentialResolved?: unknown;
  };

  if (body.ok !== true || body.credentialResolved !== true) {
    return { ok: false, code: "RENDER_RUNTIME_CREDENTIAL_UNRESOLVED" };
  }
  if (
    body.commitSha !== expectedSha ||
    body.version !== params.expectedVersion.trim() ||
    body.businessId !== CUTOVER_READINESS_BUSINESS_ID ||
    body.connectionId !== CUTOVER_READINESS_CONNECTION_ID ||
    body.botExternalId !== CUTOVER_READINESS_BOT_ID ||
    body.botUsername !== CUTOVER_READINESS_BOT_USERNAME
  ) {
    return { ok: false, code: "RENDER_RUNTIME_IDENTITY_MISMATCH" };
  }
  if (
    typeof body.databaseHost !== "string" ||
    !AUTHORIZED_ACTIVE_DB_HOSTS.has(body.databaseHost) ||
    body.databaseName !== "neondb"
  ) {
    return { ok: false, code: "RENDER_RUNTIME_DATABASE_MISMATCH" };
  }

  return {
    ok: true,
    origin,
    commitSha: expectedSha,
    version: params.expectedVersion.trim(),
    pendingUpdateCount: params.pendingUpdateCount,
    dropPendingUpdates: false,
  };
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function writeSummaryLine(line: string): void {
  console.log(line);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    appendFileSync(summaryPath, `${line}\n`);
  }
}

async function runCli(): Promise<void> {
  const args = process.argv.slice(2);
  const subcommand = args[0] ?? "";

  if (subcommand === "keygen") {
    const outPath = getArgValue(args, "--out");
    if (!outPath) {
      console.error(
        "Usage: tsx scripts/render-vault-tool.ts keygen --out <private-keyfile.json>",
      );
      process.exit(1);
    }
    const pair = generateOwnerRecoveryKeypair();
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          schema: "yakfi.owner-recovery-keypair@v1",
          createdAt: new Date().toISOString(),
          recipient: pair.recipient,
          privateKey: pair.privateKey,
          warning:
            "STORE THIS FILE ONLY IN YOUR ENCRYPTED PASSWORD MANAGER VAULT. NEVER COMMIT OR SHARE privateKey.",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(`✅ Wrote owner recovery keypair (0600) to: ${outPath}`);
    console.log(`📌 Public recipient (safe for workflow input):`);
    console.log(`   ${pair.recipient}`);
    return;
  }

  if (subcommand === "verify-bundle") {
    const bundlePath = getArgValue(args, "--bundle");
    const keyFilePath = getArgValue(args, "--key-file");
    if (!bundlePath || !keyFilePath) {
      console.error(
        "Usage: tsx scripts/render-vault-tool.ts verify-bundle --bundle <bundle.enc.json> --key-file <private-keyfile.json>",
      );
      process.exit(1);
    }
    const bundle = JSON.parse(
      readFileSync(bundlePath, "utf8"),
    ) as EncryptedSecretBundle;
    const keyData = JSON.parse(readFileSync(keyFilePath, "utf8")) as {
      privateKey?: string;
    };
    const result = verifyOwnerEncryptedBundle({
      bundle,
      privateKey: keyData.privateKey ?? "",
    });
    if (!result.ok) {
      console.error(`❌ RESTORATION_CHECK_FAILED: ${result.code}`);
      process.exit(1);
    }
    console.log("✅ RESTORATION_CHECK_PASSED (values-free):");
    console.log(`   - workspaceId: ${result.workspaceId}`);
    console.log(`   - serviceId:   ${result.serviceId}`);
    console.log(`   - commitSha:   ${result.commitSha}`);
    console.log(`   - verifiedKeys: ${result.verifiedKeys.join(", ")}`);
    return;
  }

  if (subcommand === "inspect-sources") {
    const report = await inspectRecoverySources({
      testDatabaseUrl: process.env.TEST_DATABASE_URL_SOURCE,
      prodDatabaseUrl: process.env.PROD_DATABASE_URL_SOURCE,
      credentialMasterKey: process.env.CREDENTIAL_MASTER_KEY_SOURCE,
      vercelAccessCred: process.env.VERCEL_TOKEN_SOURCE,
      renderApiKey: process.env.RENDER_API_KEY_SOURCE,
      renderServiceId: process.env.RENDER_SERVICE_ID,
    });
    writeSummaryLine("### Safe Recovery Source Inspection (Values-Free)");
    writeSummaryLine(
      `- **TEST_DATABASE_URL target**: \`${report.testDbClassification}\``,
    );
    writeSummaryLine(
      `- **PRODUCTION_DATABASE_URL target**: \`${report.prodDbClassification}\``,
    );
    writeSummaryLine(
      `- **CREDENTIAL_MASTER_KEY 32-byte format**: \`${report.masterKeyFormatValid ? "VALID" : "MISSING_OR_INVALID"}\``,
    );
    if (report.vercelProductionMetadata) {
      const v = report.vercelProductionMetadata;
      writeSummaryLine(
        `- **Vercel Production Env Metadata**: total=\`${v.totalProductionCount}\`, sensitive=\`${v.sensitiveCount}\`, nonSensitive=\`${v.nonSensitiveCount}\``,
      );
      for (const item of v.keys) {
        writeSummaryLine(`  - \`${item.key}\` (\`${item.type}\`)`);
      }
    }
    if (report.renderServiceVerified) {
      writeSummaryLine(
        `- **Render Target Verified**: service=\`${report.renderServiceVerified.serviceId}\`, workspace=\`${report.renderServiceVerified.workspaceId}\`, region=\`${report.renderServiceVerified.region}\``,
      );
    }
    return;
  }

  if (subcommand === "export-encrypted-bundle") {
    const bundleOut = getArgValue(args, "--bundle-out");
    if (!bundleOut) {
      throw new Error("MISSING_BUNDLE_OUT_PATH");
    }
    const expectedSha = (process.env.EXPECTED_COMMIT_SHA ?? "")
      .trim()
      .toLowerCase();
    const actualSha = (process.env.GITHUB_SHA ?? "").trim().toLowerCase();
    if (!FULL_SHA_RE.test(expectedSha) || expectedSha !== actualSha) {
      throw new Error("COMMIT_SHA_MISMATCH");
    }
    const allowlist = parseAllowlist(process.env.ALLOWLIST ?? "");
    const bundle = encryptAllowlistedSecretsForOwner({
      recipient: process.env.OWNER_RECIPIENT ?? "",
      allowlist,
      sourceValues: {
        DATABASE_URL: process.env.TEST_DATABASE_URL_SOURCE,
        CREDENTIAL_MASTER_KEY: process.env.CREDENTIAL_MASTER_KEY_SOURCE,
      },
      commitSha: expectedSha,
      serviceId: process.env.RENDER_SERVICE_ID ?? "",
    });
    writeFileSync(bundleOut, JSON.stringify(bundle, null, 2) + "\n", {
      mode: 0o600,
    });
    writeSummaryLine("### Encrypted Owner Bundle Created (Zero Plaintext)");
    writeSummaryLine(
      `- **Workspace**: \`${bundle.metadata.workspaceId}\` | **Service**: \`${bundle.metadata.serviceId}\``,
    );
    writeSummaryLine(
      `- **Allowlisted Keys**: \`${bundle.metadata.keyNames.join(", ")}\``,
    );
    writeSummaryLine(`- **Commit SHA**: \`${bundle.metadata.commitSha}\``);
    return;
  }

  if (subcommand === "transfer-to-render") {
    const bundleOut = getArgValue(args, "--bundle-out");
    const allowlist = parseAllowlist(process.env.ALLOWLIST ?? "");
    const dryRun = (process.env.DRY_RUN ?? "true").trim() !== "false";
    const { summary, encryptedBundle } =
      await transferAllowlistedSecretsToRender({
        expectedCommitSha: process.env.EXPECTED_COMMIT_SHA ?? "",
        actualCommitSha: process.env.GITHUB_SHA ?? "",
        serviceId: process.env.RENDER_SERVICE_ID ?? "",
        renderApiKey: process.env.RENDER_API_KEY_SOURCE ?? "",
        ownerRecipient: process.env.OWNER_RECIPIENT ?? "",
        allowlist,
        sourceValues: {
          DATABASE_URL: process.env.TEST_DATABASE_URL_SOURCE,
          CREDENTIAL_MASTER_KEY: process.env.CREDENTIAL_MASTER_KEY_SOURCE,
        },
        dryRun,
      });
    if (bundleOut) {
      writeFileSync(
        bundleOut,
        JSON.stringify(encryptedBundle, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
    writeSummaryLine("### Render Allowlisted Secret Transfer Summary");
    writeSummaryLine(`- **Outcome**: \`${summary.code}\``);
    writeSummaryLine(`- **Workspace**: \`${summary.workspaceId}\``);
    writeSummaryLine(`- **Service**: \`${summary.serviceId ?? "unknown"}\``);
    writeSummaryLine(`- **Dry Run**: \`${String(summary.dryRun)}\``);
    writeSummaryLine(
      `- **Processed Keys**: \`${(summary.transferredKeys ?? []).join(", ")}\``,
    );
    if (!summary.ok) {
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli().catch((err: unknown) => {
    const safeCode =
      err instanceof Error && /^[A-Z0-9_]+$/.test(err.message)
        ? err.message
        : "UNEXPECTED_VAULT_TOOL_ERROR";
    console.error(`::error::${safeCode}`);
    process.exit(1);
  });
}
