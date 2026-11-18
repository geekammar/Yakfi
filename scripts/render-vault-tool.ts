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
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

import { resolveMasterKey } from "@/server/credentials/credential-crypto";
import {
  verifySelectedRuntimePreflight,
  type SelectedRuntimePreflightResult,
} from "@/server/credentials/selected-runtime-preflight";
import {
  RecoveryError,
  validateDatabaseUrl,
} from "@/server/credentials/test-bot-recovery";
import {
  CUTOVER_READINESS_BOT_ID,
  CUTOVER_READINESS_BOT_USERNAME,
  CUTOVER_READINESS_BUSINESS_ID,
  CUTOVER_READINESS_CONNECTION_ID,
  CUTOVER_READINESS_PATH,
  signCutoverReadiness,
} from "@/server/operator/cutover-readiness";

export { verifySelectedRuntimePreflight, type SelectedRuntimePreflightResult };

export const CONFIRMED_RENDER_WORKSPACE_ID = "tea-db9st3gm7kps73ek9op0";
export const CONFIRMED_RENDER_REGION = "ohio";
export const CONFIRMED_VERCEL_PROJECT_ID = "prj_CjKh6Qt6IAKEc9EB4StaJJxnP0Fp";
export const PRE_SERVICE_EXPORT_SENTINEL = "PRE_SERVICE_CREATION";

export const EXPLICIT_TRANSFER_ALLOWLIST = [
  "DATABASE_URL",
  "CREDENTIAL_MASTER_KEY",
] as const;

export type AllowlistedKey = (typeof EXPLICIT_TRANSFER_ALLOWLIST)[number];

const ALLOWLIST_SET = new Set<string>(EXPLICIT_TRANSFER_ALLOWLIST);
const RECIPIENT_PREFIX = "yakfi-rcpt-v1:";
const PRIVATE_KEY_PREFIX = "yakfi-priv-v1:";
const RESTORATION_PROOF_PREFIX = "yakfi-verified-v1:";
const RESTORATION_PROOF_DOMAIN = "yakfi-owner-restoration-proof-v1";
const BUNDLE_SCHEMA = "yakfi.encrypted-secret-bundle@v1";
const HKDF_INFO = Buffer.from("yakfi-render-vault-envelope-v1", "utf8");
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const RENDER_SERVICE_ID_RE = /^srv-[a-z0-9]{16,32}$/;
const RENDER_REGION_RE = /^[a-z][a-z0-9-]{1,31}$/;

const AUTHORIZED_ACTIVE_DB_HOSTS = new Set([
  "ep-little-mouse-a5nh644n.us-east-2.aws.neon.tech",
  "ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech",
]);

const LEGACY_INACTIVE_DB_HOSTS = new Set([
  "ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech",
  "ep-tiny-grass-a5e63jev-pooler.us-east-2.aws.neon.tech",
]);

export type OwnerRecoveryKeypair = {
  recipient: string;
  privateKey: string;
};

export type EncryptedBundleMetadata = {
  workspaceId: string;
  serviceId: string;
  commitSha: string;
  keyNames: AllowlistedKey[];
};

export type EncryptedSecretBundle = {
  schema: typeof BUNDLE_SCHEMA;
  createdAt: string;
  recipient: string;
  ephemeralPublicKey: string;
  iv: string;
  salt: string;
  authTag: string;
  ciphertext: string;
  metadata: EncryptedBundleMetadata;
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

export type BundleVerificationSuccess = {
  ok: true;
  workspaceId: string;
  serviceId: string;
  commitSha: string;
  verifiedKeys: AllowlistedKey[];
  restorationProof: string;
};

export type BundleVerificationFailure = {
  ok: false;
  code: string;
};

type VerifyOk = BundleVerificationSuccess;
type VerifyErr = BundleVerificationFailure;
export type BundleVerificationResult = VerifyOk | VerifyErr;

export type VerifiedRenderService = {
  ok: true;
  serviceId: string;
  serviceName: string;
  workspaceId: string;
  region: string;
};

export type TransferRenderResult = {
  summary: SafeTransferSummary;
  encryptedBundle: EncryptedSecretBundle;
};

export type DbHostClassification =
  | "ACTIVE_NEON_TEST_DB"
  | "LEGACY_INACTIVE_PROD_DB"
  | "OTHER_HOST"
  | "MISSING_OR_INVALID";

export type VercelEnvKeyMeta = {
  key: string;
  type: string;
};

export type VercelProductionMetaSummary = {
  totalProductionCount: number;
  sensitiveCount: number;
  nonSensitiveCount: number;
  keys: VercelEnvKeyMeta[];
};

export type RenderServiceSummary = {
  serviceId: string;
  workspaceId: string;
  region: string;
};

export type SourceInspectionReport = {
  testDbClassification: DbHostClassification;
  prodDbClassification: DbHostClassification;
  masterKeyFormatValid: boolean;
  vercelProductionMetadata?: VercelProductionMetaSummary;
  renderServiceVerified?: RenderServiceSummary;
};

export type BacklogPolicy = "require_zero" | "allow_inspected_replay";
export type BacklogDispositionPolicy = BacklogPolicy;

export type RenderCutoverReady = {
  ok: true;
  origin: string;
  commitSha: string;
  version: string;
  pendingUpdateCount: number;
  dropPendingUpdates: false;
};

export type RenderCutoverBlocked = {
  ok: false;
  code: string;
  pendingUpdateCount?: number;
};

export type RenderCutoverOutcome = RenderCutoverReady | RenderCutoverBlocked;

export type MigrationPreflightState =
  | "UP_TO_DATE"
  | "PENDING_MIGRATIONS"
  | "FAILED_MIGRATIONS"
  | "DIVERGENT_HISTORY"
  | "COMMAND_FAILED";

export type OverallSelectedRuntimeReadiness = "READY" | "NOT_READY";

export type EvaluateMigrationStatusParams = {
  exitCode: number;
  rawOutput: string;
  credentialDecryptionStatus: string;
};

export type MigrationStatusEvaluation = {
  ok: boolean;
  exitCode: number;
  propagatedExitCode: number;
  credentialDecryptionStatus: string;
  migrationStatus: MigrationPreflightState;
  overallReadiness: OverallSelectedRuntimeReadiness;
  redactedOutput: string;
};

type DecryptedEnvelopeShape = {
  values?: Record<string, unknown>;
};

type RenderServiceDetailsPayload = {
  region?: unknown;
};

type RenderServicePayload = {
  id?: unknown;
  name?: unknown;
  ownerId?: unknown;
  type?: unknown;
  serviceDetails?: RenderServiceDetailsPayload;
};

type RenderServiceEnvelope = RenderServicePayload & {
  service?: RenderServicePayload;
};

type VercelEnvRecordPayload = {
  key?: unknown;
  type?: unknown;
  target?: unknown;
};

type VercelEnvListPayload = {
  envs?: VercelEnvRecordPayload[];
};

type CutoverReadinessPayload = {
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

type OwnerKeyfilePayload = {
  privateKey?: string;
};

export type BundlePersistedHook = (
  bundle: EncryptedSecretBundle,
) => Promise<void> | void;

export type FetchDeps = {
  fetchImpl?: typeof fetch;
  onBundlePersisted?: BundlePersistedHook;
};

export type CutoverDeps = {
  fetchImpl?: typeof fetch;
  now?: () => number;
};

export type BuildBundleAadParams = {
  recipient: string;
  workspaceId: string;
  serviceId: string;
  commitSha: string;
  keyNames: AllowlistedKey[];
};

export type EncryptAllowlistedParams = {
  recipient: string;
  allowlist: AllowlistedKey[];
  sourceValues: Partial<Record<AllowlistedKey, string | undefined>>;
  commitSha: string;
  serviceId?: string;
  workspaceId?: string;
  now?: () => Date;
};

export type ComputeRestorationProofParams = {
  recipient: string;
  commitSha: string;
  allowlist: AllowlistedKey[];
  sourceValues: Partial<Record<AllowlistedKey, string | undefined>>;
  workspaceId?: string;
};

export type VerifyBundleParams = {
  bundle: EncryptedSecretBundle;
  privateKey: string;
};

export type VerifyRenderServiceParams = {
  serviceId: string;
  renderApiKey: string;
  expectedWorkspaceId?: string;
  expectedRegion?: string;
};

export type TransferRenderParams = {
  expectedCommitSha: string;
  actualCommitSha: string;
  serviceId: string;
  renderApiKey: string;
  ownerRecipient: string;
  allowlist: AllowlistedKey[];
  sourceValues: Partial<Record<AllowlistedKey, string | undefined>>;
  dryRun: boolean;
  ownerRestorationProof?: string;
  bundleOutPath?: string;
};

export type InspectSourcesParams = {
  testDatabaseUrl?: string;
  prodDatabaseUrl?: string;
  credentialMasterKey?: string;
  vercelAccessCred?: string;
  renderApiKey?: string;
  renderServiceId?: string;
};

export type VerifyCutoverParams = {
  renderOrigin: string;
  expectedCommitSha: string;
  expectedVersion: string;
  databaseUrl: string;
  cutoverSignerCred: string;
  pendingUpdateCount: number;
  backlogPolicy?: BacklogDispositionPolicy;
};

export function assertNoPrivateKeyMaterial(raw: string | undefined): void {
  if (!raw) {
    return;
  }
  const upper = raw.toUpperCase();
  if (
    raw.includes(PRIVATE_KEY_PREFIX) ||
    upper.includes("PRIVATE KEY") ||
    upper.includes("PRIVATEKEY")
  ) {
    throw new Error("PRIVATE_KEY_INPUT_FORBIDDEN");
  }
}

export function generateOwnerRecoveryKeypair(): OwnerRecoveryKeypair {
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

export function writeOwnerRecoveryKeypairExclusive(
  outPath: string,
  providedPair?: OwnerRecoveryKeypair,
): OwnerRecoveryKeypair {
  const trimmedPath = outPath.trim();
  if (!trimmedPath) {
    throw new Error("INVALID_KEYFILE_PATH");
  }
  const existingStat = lstatSync(trimmedPath, { throwIfNoEntry: false });
  if (existingStat) {
    if (existingStat.isSymbolicLink()) {
      throw new Error("REFUSING_SYMLINK_KEYFILE");
    }
    throw new Error("REFUSING_TO_OVERWRITE_EXISTING_KEYFILE");
  }

  const pair = providedPair ?? generateOwnerRecoveryKeypair();
  const warnMsg =
    "STORE ONLY IN ENCRYPTED VAULT. NEVER COMMIT OR SHARE privateKey.";
  const keypairPayload = {
    schema: "yakfi.owner-recovery-keypair@v1",
    createdAt: new Date().toISOString(),
    recipient: pair.recipient,
    privateKey: pair.privateKey,
    warning: warnMsg,
  };
  const keypairJson = `${JSON.stringify(keypairPayload, null, 2)}\n`;

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const openFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;

  let fd: number;
  try {
    fd = openSync(trimmedPath, openFlags, 0o600);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ELOOP") {
      throw new Error("REFUSING_SYMLINK_KEYFILE");
    }
    if (code === "EEXIST") {
      throw new Error("REFUSING_TO_OVERWRITE_EXISTING_KEYFILE");
    }
    throw new Error("KEYFILE_EXCLUSIVE_WRITE_FAILED");
  }

  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, keypairJson, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  return pair;
}

export function writeEncryptedBundleFile(
  outPath: string,
  bundle: EncryptedSecretBundle,
): void {
  const trimmedPath = outPath.trim();
  if (!trimmedPath) {
    throw new Error("MISSING_BUNDLE_OUT_PATH");
  }
  const existingStat = lstatSync(trimmedPath, { throwIfNoEntry: false });
  if (existingStat?.isSymbolicLink()) {
    throw new Error("REFUSING_SYMLINK_BUNDLE_PATH");
  }
  const outJson = `${JSON.stringify(bundle, null, 2)}\n`;
  writeFileSync(trimmedPath, outJson, { mode: 0o600 });
}

function parseRecipientPublicKey(recipient: string) {
  assertNoPrivateKeyMaterial(recipient);
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
  const rawParts = raw.split(",");
  const items: string[] = [];
  for (const part of rawParts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      items.push(trimmed);
    }
  }
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

function buildBundleAad(params: BuildBundleAadParams): Buffer {
  const aadJson = JSON.stringify({
    schema: BUNDLE_SCHEMA,
    recipient: params.recipient,
    workspaceId: params.workspaceId,
    serviceId: params.serviceId,
    commitSha: params.commitSha,
    keyNames: params.keyNames,
  });
  return Buffer.from(aadJson, "utf8");
}

export function computeOwnerRestorationProof(
  params: ComputeRestorationProofParams,
): string {
  assertNoPrivateKeyMaterial(params.recipient);
  const commitSha = params.commitSha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(commitSha)) {
    throw new Error("INVALID_COMMIT_SHA");
  }
  const rawWorkspace = params.workspaceId ?? CONFIRMED_RENDER_WORKSPACE_ID;
  const workspaceId = rawWorkspace.trim();
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
  const parsedRecipient = parseRecipientPublicKey(params.recipient);
  const valueDigests: Array<[AllowlistedKey, string]> = [];
  for (const key of sortedKeys) {
    const validVal = validateAllowlistedValue(key, params.sourceValues[key]);
    const hasher = createHash("sha256");
    const valHash = hasher.update(validVal, "utf8").digest("hex");
    valueDigests.push([key, valHash]);
  }
  const canonical = JSON.stringify({
    schema: RESTORATION_PROOF_DOMAIN,
    recipient: parsedRecipient.normalizedRecipient,
    workspaceId,
    commitSha,
    keyNames: sortedKeys,
    valueDigests,
  });
  const hmac = createHmac("sha256", RESTORATION_PROOF_DOMAIN);
  const mac = hmac.update(canonical, "utf8").digest("base64url");
  return `${RESTORATION_PROOF_PREFIX}${mac}`;
}

export function verifyOwnerRestorationProof(
  expectedProof: string,
  providedProof: string | undefined,
): boolean {
  assertNoPrivateKeyMaterial(providedProof);
  const trimmed = providedProof?.trim() ?? "";
  if (!trimmed.startsWith(RESTORATION_PROOF_PREFIX)) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedProof, "utf8");
  const providedBuf = Buffer.from(trimmed, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

export function encryptAllowlistedSecretsForOwner(
  params: EncryptAllowlistedParams,
): EncryptedSecretBundle {
  const commitSha = params.commitSha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(commitSha)) {
    throw new Error("INVALID_COMMIT_SHA");
  }
  const rawServiceId = params.serviceId?.trim() ?? "";
  const serviceId =
    rawServiceId === "" ? PRE_SERVICE_EXPORT_SENTINEL : rawServiceId;
  const validPreService = serviceId === PRE_SERVICE_EXPORT_SENTINEL;
  if (!validPreService && !RENDER_SERVICE_ID_RE.test(serviceId)) {
    throw new Error("INVALID_RENDER_SERVICE_ID");
  }
  const rawWorkspace = params.workspaceId ?? CONFIRMED_RENDER_WORKSPACE_ID;
  const workspaceId = rawWorkspace.trim();
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

  const parsedRecipient = parseRecipientPublicKey(params.recipient);
  const normalizedRecipient = parsedRecipient.normalizedRecipient;
  const recipientPubKey = parsedRecipient.keyObj;

  const payloadMap: Record<string, string> = {};
  for (const key of sortedKeys) {
    payloadMap[key] = validateAllowlistedValue(key, params.sourceValues[key]);
  }

  const ephemeral = generateKeyPairSync("x25519");
  const ephemDer = ephemeral.publicKey.export({ format: "der", type: "spki" });
  const ephemeralSpki = Buffer.from(ephemDer);
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPubKey,
  });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const hkdfOut = hkdfSync("sha256", shared, salt, HKDF_INFO, 32);
  const derivedKey = Buffer.from(hkdfOut);
  const payloadJson = JSON.stringify({ values: payloadMap });
  const plaintextBuf = Buffer.from(payloadJson, "utf8");

  const aad = buildBundleAad({
    recipient: normalizedRecipient,
    workspaceId,
    serviceId,
    commitSha,
    keyNames: sortedKeys,
  });

  const createdAt = params.now ? params.now() : new Date();

  try {
    const cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
    cipher.setAAD(aad);
    const enc = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      schema: BUNDLE_SCHEMA,
      createdAt: createdAt.toISOString(),
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
  const metaServiceId = bundle.metadata.serviceId;
  if (
    metaServiceId !== PRE_SERVICE_EXPORT_SENTINEL &&
    !RENDER_SERVICE_ID_RE.test(metaServiceId)
  ) {
    throw new Error("INVALID_RENDER_SERVICE_ID");
  }
  if (!FULL_SHA_RE.test(bundle.metadata.commitSha)) {
    throw new Error("INVALID_COMMIT_SHA");
  }

  const ownerPrivKey = parseOwnerPrivateKey(rawPrivateKey);
  const ownerPubObj = createPublicKey(ownerPrivKey);
  const ownerPubDer = ownerPubObj.export({ format: "der", type: "spki" });
  const derivedOwnerPubSpki = Buffer.from(ownerPubDer).toString("base64url");
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
  const hkdfOut = hkdfSync("sha256", shared, salt, HKDF_INFO, 32);
  const derivedKey = Buffer.from(hkdfOut);

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
    const part1 = decipher.update(ciphertext);
    const part2 = decipher.final();
    decrypted = Buffer.concat([part1, part2]);
    const utf8 = decrypted.toString("utf8");
    const parsed = JSON.parse(utf8) as DecryptedEnvelopeShape;
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
    if (decrypted) {
      decrypted.fill(0);
    }
  }
}

/**
 * Restoration check: verifies that the owner's private key decrypts the
 * bundle cleanly and that every recovered value satisfies strict runtime
 * format/target validation, returning ONLY values-free metadata.
 */
export function verifyOwnerEncryptedBundle(
  params: VerifyBundleParams,
): BundleVerificationResult {
  try {
    const recovered = decryptBundleToMap(params.bundle, params.privateKey);
    const verifiedKeys = (Object.keys(recovered) as AllowlistedKey[]).sort();
    const restorationProof = computeOwnerRestorationProof({
      recipient: params.bundle.recipient,
      workspaceId: params.bundle.metadata.workspaceId,
      commitSha: params.bundle.metadata.commitSha,
      allowlist: verifiedKeys,
      sourceValues: recovered,
    });
    return {
      ok: true,
      workspaceId: params.bundle.metadata.workspaceId,
      serviceId: params.bundle.metadata.serviceId,
      commitSha: params.bundle.metadata.commitSha,
      verifiedKeys,
      restorationProof,
    };
  } catch (err: unknown) {
    let code = "BUNDLE_VERIFICATION_FAILED";
    if (err instanceof Error && /^[A-Z0-9_]+$/.test(err.message)) {
      code = err.message;
    }
    return { ok: false, code };
  }
}

export async function verifyRenderServiceOwnership(
  params: VerifyRenderServiceParams,
  deps: FetchDeps = {},
): Promise<VerifiedRenderService> {
  const serviceId = params.serviceId.trim();
  if (!RENDER_SERVICE_ID_RE.test(serviceId)) {
    throw new Error("INVALID_RENDER_SERVICE_ID");
  }
  const apiCred = params.renderApiKey.trim();
  if (!apiCred) {
    throw new Error("MISSING_RENDER_API_KEY");
  }
  const fallbackWorkspace = CONFIRMED_RENDER_WORKSPACE_ID;
  const rawWorkspace = params.expectedWorkspaceId ?? fallbackWorkspace;
  const expectedWorkspace = rawWorkspace.trim();
  if (expectedWorkspace !== CONFIRMED_RENDER_WORKSPACE_ID) {
    throw new Error("WORKSPACE_ID_MISMATCH");
  }
  const rawRegion = params.expectedRegion ?? CONFIRMED_RENDER_REGION;
  const expectedRegion = rawRegion.trim().toLowerCase();
  if (!expectedRegion || !RENDER_REGION_RE.test(expectedRegion)) {
    throw new Error("RENDER_REGION_MALFORMED");
  }
  if (expectedRegion !== CONFIRMED_RENDER_REGION) {
    throw new Error("RENDER_REGION_MISMATCH");
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const encodedService = encodeURIComponent(serviceId);
  const serviceUrl = `https://api.render.com/v1/services/${encodedService}`;
  const response = await fetchImpl(serviceUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiCred}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`RENDER_SERVICE_LOOKUP_FAILED_${response.status}`);
  }

  const raw = (await response.json()) as RenderServiceEnvelope;
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
  const rawServiceRegion = svc.serviceDetails?.region;
  if (rawServiceRegion === undefined || rawServiceRegion === null) {
    throw new Error("RENDER_REGION_MISSING");
  }
  if (typeof rawServiceRegion !== "string") {
    throw new Error("RENDER_REGION_MALFORMED");
  }
  const trimmedRegion = rawServiceRegion.trim();
  if (!trimmedRegion) {
    throw new Error("RENDER_REGION_MISSING");
  }
  const region = trimmedRegion.toLowerCase();
  if (!RENDER_REGION_RE.test(region)) {
    throw new Error("RENDER_REGION_MALFORMED");
  }
  if (region !== expectedRegion) {
    throw new Error("RENDER_REGION_MISMATCH");
  }

  let serviceName = "unknown";
  if (typeof svc.name === "string") {
    serviceName = svc.name;
  }

  return {
    ok: true,
    serviceId,
    serviceName,
    workspaceId: expectedWorkspace,
    region,
  };
}

export async function transferAllowlistedSecretsToRender(
  params: TransferRenderParams,
  deps: FetchDeps = {},
): Promise<TransferRenderResult> {
  assertNoPrivateKeyMaterial(params.ownerRecipient);
  assertNoPrivateKeyMaterial(params.ownerRestorationProof);

  const expectedSha = params.expectedCommitSha.trim().toLowerCase();
  const actualSha = params.actualCommitSha.trim().toLowerCase();
  if (!FULL_SHA_RE.test(expectedSha) || expectedSha !== actualSha) {
    throw new Error("COMMIT_SHA_MISMATCH");
  }

  const expectedProof = computeOwnerRestorationProof({
    recipient: params.ownerRecipient,
    workspaceId: CONFIRMED_RENDER_WORKSPACE_ID,
    commitSha: expectedSha,
    allowlist: params.allowlist,
    sourceValues: params.sourceValues,
  });

  const providedProof = params.ownerRestorationProof?.trim() ?? "";
  if (!params.dryRun || providedProof.length > 0) {
    if (!verifyOwnerRestorationProof(expectedProof, providedProof)) {
      throw new Error("OWNER_RESTORATION_VERIFICATION_REQUIRED");
    }
  }

  const ownershipReq: VerifyRenderServiceParams = {
    serviceId: params.serviceId,
    renderApiKey: params.renderApiKey,
  };
  const serviceInfo = await verifyRenderServiceOwnership(ownershipReq, deps);

  const encryptedBundle = encryptAllowlistedSecretsForOwner({
    recipient: params.ownerRecipient,
    allowlist: params.allowlist,
    sourceValues: params.sourceValues,
    commitSha: expectedSha,
    serviceId: serviceInfo.serviceId,
    workspaceId: serviceInfo.workspaceId,
  });

  // Persist and deliver the encrypted recovery bundle BEFORE any remote PUT.
  let encryptedBundleWritten = false;
  if (params.bundleOutPath) {
    writeEncryptedBundleFile(params.bundleOutPath, encryptedBundle);
    encryptedBundleWritten = true;
  }
  if (deps.onBundlePersisted) {
    await deps.onBundlePersisted(encryptedBundle);
    encryptedBundleWritten = true;
  }

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
        encryptedBundleWritten,
      },
    };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const apiCred = params.renderApiKey.trim();
  const completed: AllowlistedKey[] = [];
  const encodedSvc = encodeURIComponent(serviceInfo.serviceId);

  for (const key of sortedKeys) {
    const val = validateAllowlistedValue(key, params.sourceValues[key]);
    const encodedKey = encodeURIComponent(key);
    const svcBase = `https://api.render.com/v1/services/${encodedSvc}`;
    const putUrl = `${svcBase}/env-vars/${encodedKey}`;
    let res: Response;
    try {
      res = await fetchImpl(putUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiCred}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: val }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return {
        encryptedBundle,
        summary: {
          ok: false,
          mode: "transfer-to-render",
          code: `NETWORK_TRANSFER_FAILURE_${key}`,
          workspaceId: serviceInfo.workspaceId,
          serviceId: serviceInfo.serviceId,
          commitSha: expectedSha,
          dryRun: false,
          transferredKeys: completed,
          failedKey: key,
          encryptedBundleWritten,
        },
      };
    }
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
          encryptedBundleWritten,
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
      encryptedBundleWritten,
    },
  };
}

function classifyDbHostSafe(rawUrl: string | undefined): DbHostClassification {
  if (!rawUrl || !rawUrl.trim()) {
    return "MISSING_OR_INVALID";
  }
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
  params: InspectSourcesParams,
  deps: FetchDeps = {},
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
    const vBase = "https://api.vercel.com/v10/projects";
    const vProj = CONFIRMED_VERCEL_PROJECT_ID;
    const vercelUrl = `${vBase}/${vProj}/env?decrypt=false`;
    const vToken = params.vercelAccessCred.trim();
    const res = await fetchImpl(vercelUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${vToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = (await res.json()) as VercelEnvListPayload;
      if (Array.isArray(data.envs)) {
        const keys: VercelEnvKeyMeta[] = [];
        let sensitiveCount = 0;
        for (const item of data.envs) {
          const targets: unknown[] = [];
          if (Array.isArray(item.target)) {
            targets.push(...item.target);
          } else if (item.target !== undefined) {
            targets.push(item.target);
          }
          if (!targets.includes("production")) {
            continue;
          }
          // Strip everything except key name and type (never retain value).
          const key = typeof item.key === "string" ? item.key : "UNKNOWN_KEY";
          const type = typeof item.type === "string" ? item.type : "unknown";
          keys.push({ key, type });
          if (type === "sensitive" || type === "secret") {
            sensitiveCount += 1;
          }
        }
        keys.sort((a, b) => a.key.localeCompare(b.key));
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
    const svcReq: VerifyRenderServiceParams = {
      serviceId: params.renderServiceId,
      renderApiKey: params.renderApiKey,
    };
    const verified = await verifyRenderServiceOwnership(svcReq, deps);
    report.renderServiceVerified = {
      serviceId: verified.serviceId,
      workspaceId: verified.workspaceId,
      region: verified.region,
    };
  }

  return report;
}

export async function verifyRenderCutoverReadinessAndBacklog(
  params: VerifyCutoverParams,
  deps: CutoverDeps = {},
): Promise<RenderCutoverOutcome> {
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
  const pathName = parsedOrigin.pathname;
  const validPath = pathName === "/" || pathName === "";
  const lowerHost = parsedOrigin.hostname.toLowerCase();
  if (
    parsedOrigin.protocol !== "https:" ||
    Boolean(parsedOrigin.username) ||
    Boolean(parsedOrigin.password) ||
    Boolean(parsedOrigin.search) ||
    Boolean(parsedOrigin.hash) ||
    !validPath ||
    lowerHost.endsWith(".vercel.app")
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
  // never drop_pending_updates, and never replay non-zero backlog blindly.
  const policy = params.backlogPolicy ?? "require_zero";
  if (params.pendingUpdateCount > 0 && policy !== "allow_inspected_replay") {
    return {
      ok: false,
      code: "PENDING_UPDATES_REQUIRE_DISPOSITION",
      pendingUpdateCount: params.pendingUpdateCount,
    };
  }

  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const nowMs = deps.now ? deps.now() : Date.now();
  const timestamp = String(nowMs);
  const origin = parsedOrigin.origin;
  const botId = CUTOVER_READINESS_BOT_ID;
  const signature = signCutoverReadiness(signer, timestamp, botId);

  const res = await fetchImpl(`${origin}${CUTOVER_READINESS_PATH}`, {
    method: "GET",
    redirect: "error",
    headers: {
      "x-flowpilot-cutover-bot-id": botId,
      "x-flowpilot-cutover-timestamp": timestamp,
      "x-flowpilot-cutover-signature": signature,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "RENDER_CUTOVER_READINESS_UNAUTHORIZED" };
  }
  if (!res.ok) {
    return { ok: false, code: "RENDER_CUTOVER_READINESS_UNAVAILABLE" };
  }

  const body = (await res.json()) as CutoverReadinessPayload;

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

const FAILED_MIGRATION_RE = /have failed|failed to apply|rolled back/i;
const DIVERGENT_MIGRATION_RE =
  /are different|diverged|drift detected|modified after it was applied|missing from the local/i;
const PENDING_MIGRATION_RE = /have not yet been applied/i;
const UP_TO_DATE_MIGRATION_RE = /Database schema is up to date/i;

export function redactMigrationStatusOutput(raw: string): string {
  return raw
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1***:***@")
    .replace(
      /([?&](?:password|sslpassword|token|api_key|secret)=)[^&\s]+/gi,
      "$1***",
    );
}

export function evaluateMigrationStatusPreflight(
  params: EvaluateMigrationStatusParams,
): MigrationStatusEvaluation {
  const exitCode = Number.isInteger(params.exitCode) ? params.exitCode : 1;
  const credentialDecryptionStatus =
    params.credentialDecryptionStatus.trim() || "UNKNOWN";
  const redactedOutput = redactMigrationStatusOutput(params.rawOutput);

  let migrationStatus: MigrationPreflightState;
  if (FAILED_MIGRATION_RE.test(redactedOutput)) {
    migrationStatus = "FAILED_MIGRATIONS";
  } else if (DIVERGENT_MIGRATION_RE.test(redactedOutput)) {
    migrationStatus = "DIVERGENT_HISTORY";
  } else if (PENDING_MIGRATION_RE.test(redactedOutput)) {
    migrationStatus = "PENDING_MIGRATIONS";
  } else if (exitCode === 0 && UP_TO_DATE_MIGRATION_RE.test(redactedOutput)) {
    migrationStatus = "UP_TO_DATE";
  } else {
    migrationStatus = "COMMAND_FAILED";
  }

  const credentialOk = credentialDecryptionStatus === "HEALTHY_LOCAL_KEY";
  const ok = credentialOk && exitCode === 0 && migrationStatus === "UP_TO_DATE";
  const readinessVal = ok ? "READY" : "NOT_READY";
  const overallReadiness: OverallSelectedRuntimeReadiness = readinessVal;
  let propagatedExitCode = 1;
  if (ok) {
    propagatedExitCode = 0;
  } else if (exitCode > 0 && exitCode <= 255) {
    propagatedExitCode = exitCode;
  }

  return {
    ok,
    exitCode,
    propagatedExitCode,
    credentialDecryptionStatus,
    migrationStatus,
    overallReadiness,
    redactedOutput,
  };
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return undefined;
  }
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
      const u = "Usage: tsx scripts/render-vault-tool.ts keygen --out <file>";
      console.error(u);
      process.exit(1);
    }
    const pair = writeOwnerRecoveryKeypairExclusive(outPath);
    console.log(`✅ Wrote owner recovery keypair (0600) to: ${outPath}`);
    console.log("📌 Public recipient (safe for workflow input):");
    console.log(`   ${pair.recipient}`);
    return;
  }

  if (subcommand === "verify-bundle") {
    const bundlePath = getArgValue(args, "--bundle");
    const keyFilePath = getArgValue(args, "--key-file");
    if (!bundlePath || !keyFilePath) {
      const u = "Usage: verify-bundle --bundle <bundle> --key-file <keyfile>";
      console.error(u);
      process.exit(1);
    }
    const rawBundle = readFileSync(bundlePath, "utf8");
    const bundle = JSON.parse(rawBundle) as EncryptedSecretBundle;
    const rawKeyFile = readFileSync(keyFilePath, "utf8");
    const keyData = JSON.parse(rawKeyFile) as OwnerKeyfilePayload;
    const result = verifyOwnerEncryptedBundle({
      bundle,
      privateKey: keyData.privateKey ?? "",
    });
    if (!result.ok) {
      console.error(`❌ RESTORATION_CHECK_FAILED: ${result.code}`);
      process.exit(1);
    }
    console.log("✅ RESTORATION_CHECK_PASSED (values-free):");
    console.log(`   - workspaceId:      ${result.workspaceId}`);
    console.log(`   - serviceId:        ${result.serviceId}`);
    console.log(`   - commitSha:        ${result.commitSha}`);
    console.log(`   - verifiedKeys:     ${result.verifiedKeys.join(", ")}`);
    console.log(`   - restorationProof: ${result.restorationProof}`);
    return;
  }

  if (subcommand === "verify-selected-runtime") {
    const rawExpected = process.env.EXPECTED_COMMIT_SHA ?? "";
    const expectedSha = rawExpected.trim().toLowerCase();
    const rawActual = process.env.GITHUB_SHA ?? "";
    const actualSha = rawActual.trim().toLowerCase();
    if (expectedSha) {
      if (!FULL_SHA_RE.test(expectedSha) || expectedSha !== actualSha) {
        throw new Error("COMMIT_SHA_MISMATCH");
      }
    }
    const rawDbUrl = process.env.TEST_DATABASE_URL_SOURCE?.trim() ?? "";
    const rawMasterKey = process.env.CREDENTIAL_MASTER_KEY_SOURCE?.trim() ?? "";
    try {
      validateDatabaseUrl(rawDbUrl);
    } catch (err: unknown) {
      const errCode =
        err instanceof RecoveryError
          ? err.code
          : "DATABASE_TARGET_NOT_AUTHORIZED";
      writeSummaryLine("### Selected Runtime Pairing Preflight (Read-Only)");
      writeSummaryLine("- **Status**: `BLOCKED`");
      writeSummaryLine(`- **Code**: \`${errCode}\``);
      console.log("status: BLOCKED");
      console.log(`code: ${errCode}`);
      process.exit(1);
    }
    process.env.DATABASE_URL = rawDbUrl;
    const dbMod = await import("@/server/db");
    const repoMod =
      await import("@/server/repositories/test-bot-recovery.repository");
    let preflight: SelectedRuntimePreflightResult;
    try {
      preflight = await verifySelectedRuntimePreflight(
        { databaseUrl: rawDbUrl, masterKey: rawMasterKey },
        { repo: repoMod.testBotRecoveryRepository(dbMod.db) },
      );
    } finally {
      await dbMod.db.$disconnect().catch(() => {});
    }
    writeSummaryLine("### Selected Runtime Pairing Preflight (Read-Only)");
    writeSummaryLine(`- **Status**: \`${preflight.status}\``);
    writeSummaryLine(`- **Code**: \`${preflight.code}\``);
    console.log(`status: ${preflight.status}`);
    console.log(`code: ${preflight.code}`);
    if (!preflight.ok) {
      process.exit(1);
    }
    return;
  }

  if (subcommand === "evaluate-migration-status") {
    const statusFile = getArgValue(args, "--status-file");
    const rawExit = getArgValue(args, "--exit-code") ?? "1";
    const credStatus =
      getArgValue(args, "--credential-status") ??
      process.env.CREDENTIAL_STATUS ??
      "UNKNOWN";
    if (!statusFile) {
      throw new Error("MISSING_MIGRATION_STATUS_FILE");
    }
    const parsedExit = Number.parseInt(rawExit, 10);
    const exitCode = Number.isNaN(parsedExit) ? 1 : parsedExit;
    const rawText = readFileSync(statusFile, "utf8");
    const evalRes = evaluateMigrationStatusPreflight({
      exitCode,
      rawOutput: rawText,
      credentialDecryptionStatus: credStatus,
    });
    const credLabel = evalRes.credentialDecryptionStatus;
    const migLabel = evalRes.migrationStatus;
    const readyLabel = evalRes.overallReadiness;
    writeSummaryLine("### Selected Runtime Migration Status (Read-Only)");
    writeSummaryLine(`- **Credential Decryption Status**: \`${credLabel}\``);
    writeSummaryLine(`- **Prisma Migrate Exit Code**: \`${evalRes.exitCode}\``);
    writeSummaryLine(`- **Migration Status**: \`${migLabel}\``);
    writeSummaryLine(`- **Overall Runtime Readiness**: \`${readyLabel}\``);
    writeSummaryLine("```");
    writeSummaryLine(evalRes.redactedOutput.trimEnd());
    writeSummaryLine("```");
    console.log(`credential_decryption_status: ${credLabel}`);
    console.log(`prisma_migrate_exit_code: ${evalRes.exitCode}`);
    console.log(`migration_status: ${migLabel}`);
    console.log(`overall_runtime_readiness: ${readyLabel}`);
    if (!evalRes.ok) {
      const errMsg =
        `Selected runtime credential decryption is ${credLabel}, ` +
        `migration status is ${migLabel} (exit code ${evalRes.exitCode}); ` +
        "overall runtime readiness is NOT_READY. Migrations were NOT applied.";
      console.error(`::error::${errMsg}`);
      process.exit(evalRes.propagatedExitCode);
    }
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
    const isKeyValid = report.masterKeyFormatValid;
    const keyFormatLabel = isKeyValid ? "VALID" : "MISSING_OR_INVALID";
    const testDbClass = report.testDbClassification;
    const prodDbClass = report.prodDbClassification;
    writeSummaryLine("### Safe Recovery Source Inspection (Values-Free)");
    writeSummaryLine(`- **TEST_DATABASE_URL**: \`${testDbClass}\``);
    writeSummaryLine(`- **PRODUCTION_DATABASE_URL**: \`${prodDbClass}\``);
    writeSummaryLine(`- **CREDENTIAL_MASTER_KEY**: \`${keyFormatLabel}\``);
    if (report.vercelProductionMetadata) {
      const v = report.vercelProductionMetadata;
      const totalProd = v.totalProductionCount;
      writeSummaryLine(`- **Vercel Prod Total**: \`${totalProd}\``);
      writeSummaryLine(`- **Vercel Sensitive**: \`${v.sensitiveCount}\``);
      writeSummaryLine(`- **Vercel Config**: \`${v.nonSensitiveCount}\``);
      for (const item of v.keys) {
        writeSummaryLine(`  - \`${item.key}\` (\`${item.type}\`)`);
      }
    }
    if (report.renderServiceVerified) {
      const r = report.renderServiceVerified;
      writeSummaryLine(`- **Render Service**: \`${r.serviceId}\``);
      writeSummaryLine(`- **Render Workspace**: \`${r.workspaceId}\``);
      writeSummaryLine(`- **Render Region**: \`${r.region}\``);
    }
    return;
  }

  if (subcommand === "export-encrypted-bundle") {
    const bundleOut = getArgValue(args, "--bundle-out");
    if (!bundleOut) {
      throw new Error("MISSING_BUNDLE_OUT_PATH");
    }
    const rawExpected = process.env.EXPECTED_COMMIT_SHA ?? "";
    const expectedSha = rawExpected.trim().toLowerCase();
    const rawActual = process.env.GITHUB_SHA ?? "";
    const actualSha = rawActual.trim().toLowerCase();
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
    writeEncryptedBundleFile(bundleOut, bundle);
    const joinedAllowlist = bundle.metadata.keyNames.join(", ");
    writeSummaryLine("### Encrypted Owner Bundle Created (Zero Plaintext)");
    writeSummaryLine(`- **Workspace**: \`${bundle.metadata.workspaceId}\``);
    writeSummaryLine(`- **Service**: \`${bundle.metadata.serviceId}\``);
    writeSummaryLine(`- **Allowlisted Keys**: \`${joinedAllowlist}\``);
    writeSummaryLine(`- **Commit SHA**: \`${bundle.metadata.commitSha}\``);
    return;
  }

  if (subcommand === "transfer-to-render") {
    const bundleOut = getArgValue(args, "--bundle-out");
    const allowlist = parseAllowlist(process.env.ALLOWLIST ?? "");
    const dryRun = (process.env.DRY_RUN ?? "true").trim() !== "false";
    const transferResult = await transferAllowlistedSecretsToRender({
      expectedCommitSha: process.env.EXPECTED_COMMIT_SHA ?? "",
      actualCommitSha: process.env.GITHUB_SHA ?? "",
      serviceId: process.env.RENDER_SERVICE_ID ?? "",
      renderApiKey: process.env.RENDER_API_KEY_SOURCE ?? "",
      ownerRecipient: process.env.OWNER_RECIPIENT ?? "",
      ownerRestorationProof: process.env.OWNER_RESTORATION_PROOF ?? "",
      bundleOutPath: bundleOut,
      allowlist,
      sourceValues: {
        DATABASE_URL: process.env.TEST_DATABASE_URL_SOURCE,
        CREDENTIAL_MASTER_KEY: process.env.CREDENTIAL_MASTER_KEY_SOURCE,
      },
      dryRun,
    });
    const { summary } = transferResult;
    const processed = (summary.transferredKeys ?? []).join(", ");
    writeSummaryLine("### Render Allowlisted Secret Transfer Summary");
    writeSummaryLine(`- **Outcome**: \`${summary.code}\``);
    writeSummaryLine(`- **Workspace**: \`${summary.workspaceId}\``);
    writeSummaryLine(`- **Service**: \`${summary.serviceId ?? "unknown"}\``);
    writeSummaryLine(`- **Dry Run**: \`${String(summary.dryRun)}\``);
    writeSummaryLine(`- **Processed Keys**: \`${processed}\``);
    if (!summary.ok) {
      process.exit(1);
    }
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  process.exit(1);
}

const argvEntry = process.argv[1];
const cliEntryHref = argvEntry ? pathToFileURL(argvEntry).href : "";
if (cliEntryHref && import.meta.url === cliEntryHref) {
  runCli().catch((err: unknown) => {
    let safeCode = "UNEXPECTED_VAULT_TOOL_ERROR";
    if (err instanceof Error && /^[A-Z0-9_]+$/.test(err.message)) {
      safeCode = err.message;
    }
    console.error(`::error::${safeCode}`);
    process.exit(1);
  });
}
