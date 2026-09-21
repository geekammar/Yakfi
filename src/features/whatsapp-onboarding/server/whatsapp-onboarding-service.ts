/**
 * WhatsApp onboarding application logic (WHATSAPP-ONBOARDING-01).
 *
 * The SEPARATE onboarding lifecycle of a Business-owned WhatsApp
 * connection, implemented as two server-side use cases on top of the
 * provider-neutral `ConnectionAuthorizer` port:
 *
 *   BEGIN     Business Admin (ADMIN, own Business) → the connection
 *             moves to AUTHORIZING and a single-use authorization
 *             attempt is persisted server-side. Only safe launch
 *             information is returned.
 *   CALLBACK  the target Business is resolved ONLY from the persisted
 *             authorization attempt (never from the query, the client,
 *             or the session); the code is exchanged through the port,
 *             the connection moves to PROVISIONING, and ONLY non-secret
 *             references/provenance are persisted.
 *
 * Architecture invariants (DECISIONS #31/#47, AGENT_RULES):
 * - The Business is ALWAYS server-derived: the authenticated actor for
 *   BEGIN, the persisted authorization ledger for CALLBACK. A
 *   client-supplied businessId/connectionId can never redirect a read
 *   or a write.
 * - ADMIN-only.
 * - `onboardingState` is NEVER consumed by the transport runtime, the
 *   conversation engine, booking, or AI. The operational gate stays
 *   `status === "CONNECTED" && isActive`.
 * - `READY` is written ONLY by `markOnboardingReady` (guarded by the
 *   operational gate) — reached through the read-only verification
 *   path, never by the callback.
 * - Secrets: an access token never crosses this service. The callback
 *   persists `credentialsRef` (a REFERENCE) + its KIND only.
 * - No real Meta call is made: the wired authorizer is a deterministic
 *   stand-in until the Meta adapter lands.
 */

import { env } from "@/lib/env";
import {
  META_PROVENANCE_KEYS,
  type CredentialKind,
  type WhatsAppOnboardingState as StateMachine,
} from "@/lib/validation";
import { classifyCredentialReference } from "@/server/credentials/credentials-resolver";
import type {
  BusinessRepository,
  WhatsAppConnectionRepository,
} from "@/server/repositories";
import type { WhatsAppOnboardingAuthorizationRepository } from "@/server/repositories/whatsapp-onboarding-authorization.repository";
import { ONBOARDING_AUTHORIZATION_EXPIRY_MINUTES } from "@/server/repositories/whatsapp-onboarding-authorization.repository";
import type {
  AuthorizationErrorCode,
  AuthorizationProvenance,
  AuthorizationResult,
  ConnectionAuthorizer,
} from "@/server/transport/whatsapp-transport";
import type { WhatsAppConnection } from "@/types/domain";

import type {
  BeginWhatsAppOnboardingResult,
  CredentialReferenceDescriptor,
  HandleWhatsAppAuthorizationCallbackResult,
  OnboardingFailure,
  WhatsAppCallbackErrorCode,
  WhatsAppOnboardingActor,
  WhatsAppOnboardingCta,
  WhatsAppOnboardingView,
} from "../types";
import {
  DUPLICATE_EXTERNAL_ID_FAILURE,
  ONBOARDING_GATE_FAILURE,
  PERSISTENCE_FAILURE,
  VERIFICATION_REQUIRED_FAILURE,
  describeAuthorizationFailure,
  type OnboardingFailureDescriptor,
} from "./onboarding-failure";

const FORBIDDEN_MESSAGE = "ربط واتساب متاح للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const NO_CONNECTION_MESSAGE = "تعذر العثور على اتصال واتساب لهذه المنشأة";
const LAUNCH_FAILED_MESSAGE = "تعذر بدء ربط واتساب الآن — حاول مرة أخرى";
const READY_MESSAGE = "اكتمل ربط واتساب — الرقم جاهز لاستقبال رسائل العملاء.";

/** The post-authorization states: the provider identity is persisted. */
const POST_AUTHORIZATION_STATES: StateMachine[] = [
  "PROVISIONING",
  "ACTION_REQUIRED",
  "READY",
];

export type WhatsAppOnboardingServiceDeps = {
  connectionRepository: Pick<
    WhatsAppConnectionRepository,
    | "create"
    | "update"
    | "findPrimaryByBusiness"
    | "findByIdWithinBusiness"
    | "findByExternalId"
    | "markOnboardingReady"
  >;
  authorizationRepository: Pick<
    WhatsAppOnboardingAuthorizationRepository,
    "create" | "findActiveByConnection" | "findByStateRef" | "consume"
  >;
  businessRepository: Pick<BusinessRepository, "findById">;
  /** Provider-neutral authorization port (Meta adapter later). */
  authorizer: ConnectionAuthorizer;
  /** Opaque state-reference source (injectable for determinism). */
  generateStateRef: () => string;
  /** Clock (injectable for determinism). */
  now: () => Date;
};

/** The write surface needed to record normalized diagnostics. */
type FailureWriterDeps = Pick<
  WhatsAppOnboardingServiceDeps,
  "connectionRepository" | "now"
>;

type Scope = { ok: true; businessId: string } | { ok: false; message: string };

function resolveScope(actor: WhatsAppOnboardingActor): Scope {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

/**
 * The callback URL the provider must return to. Server-built from the
 * app's canonical URL — never from a client input.
 */
export function resolveOnboardingCallbackUrl(): string {
  return `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/whatsapp-onboarding/callback`;
}

function isPostAuthorization(state: string): boolean {
  return (POST_AUTHORIZATION_STATES as string[]).includes(state);
}

/** Only the LAST normalized failure is persisted, and only this shape. */
function toOnboardingFailure(
  connectionId: string,
  descriptor: OnboardingFailureDescriptor,
  now: Date,
): OnboardingFailure {
  return {
    category: descriptor.category,
    reasonCode: descriptor.reasonCode,
    reasonSummary: descriptor.reasonSummary,
    retryable: descriptor.retryable,
    failedAt: now,
    operationRef: connectionId,
  };
}

async function recordFailure(
  deps: FailureWriterDeps,
  connectionId: string,
  businessId: string,
  descriptor: OnboardingFailureDescriptor,
  now: Date,
): Promise<void> {
  const failure = toOnboardingFailure(connectionId, descriptor, now);
  try {
    await deps.connectionRepository.update(connectionId, businessId, {
      onboardingState: descriptor.terminalState,
      onboardingActor: "META",
      onboardingReasonCode: failure.reasonCode,
      onboardingReasonSummary: failure.reasonSummary,
      onboardingRetryable: failure.retryable,
      onboardingStateChangedAt: now,
      ...(descriptor.terminalState === "FAILED"
        ? { onboardingFailedAt: now }
        : { onboardingFailedAt: null }),
    });
  } catch {
    // A diagnostics write must never mask the outcome the caller is
    // already reporting; the failure is returned either way.
  }
}

// ─── Customer-facing lifecycle projection ───────────────────────────────────

export const ONBOARDING_STATUS_LABELS: Record<StateMachine, string> = {
  NOT_STARTED: "غير متصل",
  AUTHORIZING: "جاري الربط",
  PROVISIONING: "جاري التجهيز",
  ACTION_REQUIRED: "يحتاج إجراء",
  READY: "جاهز",
  FAILED: "تعذر إكمال الربط",
};

function isOperationallyConnected(connection: WhatsAppConnection): boolean {
  return connection.isActive && connection.status === "CONNECTED";
}

/**
 * The simplified customer-facing lifecycle + the single next action.
 * Operator-only concepts (WABA, phone_number_id, system user, access
 * token, provider error text) never appear in the resulting view.
 */
export function resolveOnboardingStatus(
  connection: WhatsAppConnection | null,
): WhatsAppOnboardingView {
  if (!connection) {
    return {
      connectionId: "",
      statusLabel: ONBOARDING_STATUS_LABELS.NOT_STARTED,
      onboardingState: "NOT_STARTED",
      operationallyConnected: false,
      // No connection yet: the managed launch is the correct next action
      // from ANY surface (the begin use case creates the connection).
      // A link CTA here would be a dead self-link on `/settings/whatsapp`
      // — the canonical surface — so this is a launch action, not a link.
      cta: "BEGIN",
      reasonSummary: null,
    };
  }

  const connected = isOperationallyConnected(connection);
  const state = connection.onboardingState as StateMachine;
  let cta: WhatsAppOnboardingCta;
  if (connected) cta = "DONE";
  else if (state === "AUTHORIZING") cta = "RESUME";
  else if (state === "PROVISIONING" || state === "ACTION_REQUIRED")
    cta = connection.externalId ? "VERIFY" : "ACT";
  else if (state === "FAILED")
    cta = connection.onboardingRetryable ? "RETRY" : "CONFIGURE";
  else if (connection.externalId) cta = "VERIFY";
  else cta = "BEGIN";

  return {
    connectionId: connection.id,
    // The customer sees readiness, not internal states: an operationally
    // connected number is "جاهز" even when the Meta authorization flow
    // was never started (the existing manual pilot path stays valid).
    statusLabel: connected
      ? ONBOARDING_STATUS_LABELS.READY
      : ONBOARDING_STATUS_LABELS[state],
    onboardingState: state,
    operationallyConnected: connected,
    cta,
    reasonSummary: connection.onboardingReasonSummary ?? null,
  };
}

/** The actor's Business onboarding status (ADMIN only, own Business). */
export async function getOnboardingStatus(
  deps: Pick<WhatsAppOnboardingServiceDeps, "connectionRepository">,
  actor: WhatsAppOnboardingActor,
): Promise<WhatsAppOnboardingView> {
  const scope = resolveScope(actor);
  if (!scope.ok) {
    return {
      connectionId: "",
      statusLabel: ONBOARDING_STATUS_LABELS.NOT_STARTED,
      onboardingState: "NOT_STARTED",
      operationallyConnected: false,
      cta: "CONFIGURE",
      reasonSummary: null,
    };
  }
  const connection = await deps.connectionRepository.findPrimaryByBusiness(
    scope.businessId,
  );
  return resolveOnboardingStatus(connection);
}

// ─── BEGIN ──────────────────────────────────────────────────────────────────

/**
 * Launch the provider authorization for the actor's Business (ADMIN
 * only, own Business). Creates/reuses the Business-scoped connection,
 * moves the lifecycle to AUTHORIZING, persists the single-use
 * authorization attempt, and returns ONLY safe launch information.
 */
export async function beginWhatsAppOnboarding(
  deps: WhatsAppOnboardingServiceDeps,
  actor: WhatsAppOnboardingActor,
  params: { redirectUri: string },
): Promise<BeginWhatsAppOnboardingResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const business = await deps.businessRepository.findById(scope.businessId);
  if (!business) return { success: false, message: NO_BUSINESS_MESSAGE };

  let connection = await deps.connectionRepository.findPrimaryByBusiness(
    scope.businessId,
  );
  if (!connection) {
    try {
      connection = await deps.connectionRepository.create({
        businessId: scope.businessId,
        branchId: null, // Business-shared (Default Branch) — DECISIONS #31
        // The Business-declared number is the display label until the
        // provider reports its own; the AUTHORITATIVE identity comes
        // from the callback (externalId), never from here.
        phoneNumber: business.whatsappNumber,
        provider: deps.authorizer.providerName,
        externalId: undefined,
        credentialsRef: undefined,
        status: "PENDING", // verification is the only path to CONNECTED
        onboardingState: "NOT_STARTED",
        onboardingActor: "NONE",
      });
    } catch {
      return { success: false, message: LAUNCH_FAILED_MESSAGE };
    }
  }

  if (connection.onboardingState === "READY") {
    return {
      success: true,
      launched: false,
      reason: "ALREADY_READY",
      connectionId: connection.id,
    };
  }

  const now = deps.now();
  // Resume: an in-flight, unconsumed attempt is reused — no second
  // stateRef, no second ledger row (abandonment then re-launch picks up
  // where it left off instead of orphaning attempts).
  const active = await deps.authorizationRepository.findActiveByConnection(
    connection.id,
    now,
  );
  const resumed = Boolean(
    active && connection.onboardingState === "AUTHORIZING",
  );

  let launch: { authorizationUrl: string; stateRef: string };
  try {
    launch = await deps.authorizer.launchAuthorization({
      businessId: scope.businessId,
      connectionId: connection.id,
      phoneNumber: connection.phoneNumber,
      redirectUri: params.redirectUri,
      existingStateRef: resumed && active ? active.stateRef : undefined,
    });
  } catch {
    return { success: false, message: LAUNCH_FAILED_MESSAGE };
  }

  if (!resumed) {
    try {
      await deps.authorizationRepository.create({
        businessId: scope.businessId,
        connectionId: connection.id,
        stateRef: launch.stateRef,
        expiresAt: new Date(
          now.getTime() + ONBOARDING_AUTHORIZATION_EXPIRY_MINUTES * 60_000,
        ),
      });
    } catch {
      return { success: false, message: LAUNCH_FAILED_MESSAGE };
    }
  }

  try {
    await deps.connectionRepository.update(connection.id, scope.businessId, {
      onboardingState: "AUTHORIZING",
      onboardingActor: "CUSTOMER",
      onboardingStateChangedAt: now,
      onboardingFailedAt: null,
    });
  } catch {
    return { success: false, message: LAUNCH_FAILED_MESSAGE };
  }

  return {
    success: true,
    launched: true,
    authorizationUrl: launch.authorizationUrl,
    stateRef: launch.stateRef,
    connectionId: connection.id,
    resumed,
  };
}

// ─── CALLBACK ───────────────────────────────────────────────────────────────

export type WhatsAppCallbackParams = {
  stateRef: string;
  code: string;
  redirectUri: string;
};

/**
 * Handle the provider authorization callback. The target Business is
 * resolved ONLY from the persisted authorization attempt: the opaque
 * `stateRef` is the single callback credential, and it must match an
 * unconsumed, unexpired attempt whose connection belongs to its own
 * Business. Hostile/replayed/cross-tenant state matches no row and
 * nothing is written. On success the connection moves to PROVISIONING,
 * ONLY non-secret references/provenance are persisted, and `READY` is
 * left to the guarded operational path.
 */
export async function handleWhatsAppAuthorizationCallback(
  deps: WhatsAppOnboardingServiceDeps,
  params: WhatsAppCallbackParams,
): Promise<HandleWhatsAppAuthorizationCallbackResult> {
  const now = deps.now();
  const authorization = await deps.authorizationRepository.findByStateRef(
    params.stateRef,
  );
  if (!authorization) {
    return rejected("AUTHORIZATION_STATE_UNKNOWN");
  }
  if (authorization.consumedAt) {
    return rejected("AUTHORIZATION_ALREADY_CONSUMED");
  }
  if (authorization.expiresAt.getTime() <= now.getTime()) {
    return rejected("AUTHORIZATION_EXPIRED");
  }

  // Cross-tenant rejection: the ledger's connection must exist INSIDE
  // the ledger row's own Business (Business-scoped lookup).
  const connection = await deps.connectionRepository.findByIdWithinBusiness(
    authorization.connectionId,
    authorization.businessId,
  );
  if (!connection) {
    return rejected("AUTHORIZATION_CONNECTION_MISMATCH");
  }

  // Replay protection: exactly one consumer wins this conditional write.
  const consumed = await deps.authorizationRepository.consume(
    params.stateRef,
    authorization.businessId,
    authorization.connectionId,
    now,
  );
  if (!consumed) {
    return rejected("AUTHORIZATION_ALREADY_CONSUMED");
  }

  const businessId = authorization.businessId;
  const connectionId = connection.id;

  try {
    await deps.connectionRepository.update(connectionId, businessId, {
      onboardingState: "PROVISIONING",
      onboardingActor: "META",
      onboardingStateChangedAt: now,
      onboardingReasonCode: null,
      onboardingReasonSummary: null,
      onboardingRetryable: null,
    });
  } catch {
    return rejected("PERSISTENCE_FAILED");
  }

  const exchange: AuthorizationResult = await deps.authorizer.exchangeCallback({
    code: params.code,
    stateRef: params.stateRef,
    redirectUri: params.redirectUri,
    // From the persisted ledger — an audit hint for tenant-scoped secret
    // storage only; the ledger already authorized this Business.
    businessId,
  });

  if (!exchange.ok) {
    const descriptor = describeAuthorizationFailure(exchange.code);
    await recordFailure(deps, connectionId, businessId, descriptor, now);
    if (descriptor.terminalState === "ACTION_REQUIRED") {
      return {
        success: true,
        businessId,
        connectionId,
        onboardingState: "ACTION_REQUIRED",
        summary: descriptor.reasonSummary,
      };
    }
    return {
      success: false,
      code: exchange.code,
      message: descriptor.reasonSummary,
    };
  }

  // A provider identity already owned by ANOTHER Business would make
  // inbound tenant resolution ambiguous — refuse (self is excluded).
  const owner = await deps.connectionRepository.findByExternalId(
    exchange.externalId,
  );
  if (owner && owner.businessId !== businessId) {
    await recordFailure(
      deps,
      connectionId,
      businessId,
      DUPLICATE_EXTERNAL_ID_FAILURE,
      now,
    );
    return rejected("DUPLICATE_EXTERNAL_ID");
  }

  const provenance = pickMetaProvenance(exchange.provenance);
  const provisioned = await persistProvisioning(
    deps,
    connectionId,
    businessId,
    exchange,
    provenance,
    deps.authorizer.providerName,
  );
  if (!provisioned) {
    await recordFailure(
      deps,
      connectionId,
      businessId,
      PERSISTENCE_FAILURE,
      now,
    );
    return rejected("PERSISTENCE_FAILED");
  }

  // READY ONLY through the operational gate (CONNECTED + active). The
  // callback never sets `status` — verification owns it.
  const ready = await deps.connectionRepository.markOnboardingReady(
    connectionId,
    businessId,
  );
  if (!ready) {
    await recordFailure(
      deps,
      connectionId,
      businessId,
      VERIFICATION_REQUIRED_FAILURE,
      now,
    );
    return {
      success: true,
      businessId,
      connectionId,
      onboardingState: "ACTION_REQUIRED",
      summary: VERIFICATION_REQUIRED_FAILURE.reasonSummary,
    };
  }

  return {
    success: true,
    businessId,
    connectionId,
    onboardingState: "READY",
    summary: READY_MESSAGE,
  };
}

function rejected(code: WhatsAppCallbackErrorCode): {
  success: false;
  code: WhatsAppCallbackErrorCode;
  message: string;
} {
  return { success: false, code, message: callbackMessage(code) };
}

function callbackMessage(code: WhatsAppCallbackErrorCode): string {
  switch (code) {
    case "AUTHORIZATION_STATE_UNKNOWN":
      return "تعذرت مطابقة طلب الربط — ابدأ الربط مرة أخرى من الإعدادات.";
    case "AUTHORIZATION_EXPIRED":
      return "انتهت صلاحية طلب الربط — ابدأ الربط مرة أخرى من الإعدادات.";
    case "AUTHORIZATION_ALREADY_CONSUMED":
      return "تم استخدام طلب الربط هذا بالفعل — ابدأ ربطاً جديداً.";
    case "AUTHORIZATION_CONNECTION_MISMATCH":
      return "تعذرت مطابقة الاتصال المستهدف — ابدأ الربط مرة أخرى من الإعدادات.";
    case "DUPLICATE_EXTERNAL_ID":
      return DUPLICATE_EXTERNAL_ID_FAILURE.reasonSummary;
    case "PERSISTENCE_FAILED":
      return PERSISTENCE_FAILURE.reasonSummary;
    default:
      return describeAuthorizationFailure(code as AuthorizationErrorCode)
        .reasonSummary;
  }
}

/**
 * Persist only the approved, non-secret provenance fields: unknown
 * provider keys never reach the database.
 */
function pickMetaProvenance(
  provenance: AuthorizationProvenance | undefined,
): Partial<Record<(typeof META_PROVENANCE_KEYS)[number], string>> {
  if (!provenance) return {};
  const picked: Partial<Record<(typeof META_PROVENANCE_KEYS)[number], string>> =
    {};
  for (const key of META_PROVENANCE_KEYS) {
    const value = provenance[key];
    if (typeof value === "string" && value.trim().length > 0) {
      picked[key] = value.trim();
    }
  }
  return picked;
}

async function persistProvisioning(
  deps: FailureWriterDeps,
  connectionId: string,
  businessId: string,
  exchange: Extract<AuthorizationResult, { ok: true }>,
  provenance: Partial<Record<(typeof META_PROVENANCE_KEYS)[number], string>>,
  providerName: string,
): Promise<boolean> {
  try {
    const updated = await deps.connectionRepository.update(
      connectionId,
      businessId,
      {
        provider: providerName,
        externalId: exchange.externalId,
        credentialsRef: exchange.credentialsRef,
        credentialKind: exchange.credentialKind,
        displayPhoneNumber: exchange.displayPhoneNumber ?? null,
        verifiedName: exchange.verifiedName ?? null,
        metaBusinessId: provenance.meta_business_id ?? null,
        wabaId: provenance.waba_id ?? null,
        metaReviewStatus: provenance.meta_review_status ?? null,
        onboardingStateChangedAt: deps.now(),
      },
    );
    return Boolean(updated);
  } catch {
    return false;
  }
}

// ─── Readiness finalization (the verification success path) ─────────────────

export type ReadinessResult =
  | { success: true; ready: boolean; connectionId: string }
  | { success: false; message: string };

/**
 * Complete the onboarding lifecycle after a SUCCESSFUL read-only
 * verification — the only path that establishes operational readiness.
 * Idempotent and deliberately conservative: a connection that never
 * went through the provider authorization (the existing manual pilot
 * path) is left untouched — its onboarding lifecycle stays
 * NOT_STARTED and its operational `status` says everything the
 * customer needs to know.
 */
export async function refreshWhatsAppOnboardingReadiness(
  deps: Pick<WhatsAppOnboardingServiceDeps, "connectionRepository" | "now">,
  actor: WhatsAppOnboardingActor,
): Promise<ReadinessResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const connection = await deps.connectionRepository.findPrimaryByBusiness(
    scope.businessId,
  );
  if (!connection) return { success: false, message: NO_CONNECTION_MESSAGE };

  if (!isPostAuthorization(connection.onboardingState)) {
    // Nothing to finalize — no provider authorization happened yet.
    return {
      success: true,
      ready: connection.onboardingState === "READY",
      connectionId: connection.id,
    };
  }
  if (connection.onboardingState === "READY") {
    return { success: true, ready: true, connectionId: connection.id };
  }

  // The guarded write: READY cannot exist without CONNECTED + active.
  const ready = await deps.connectionRepository.markOnboardingReady(
    connection.id,
    scope.businessId,
  );
  if (!ready) {
    await recordFailure(
      deps,
      connection.id,
      scope.businessId,
      ONBOARDING_GATE_FAILURE,
      deps.now(),
    );
    return {
      success: true,
      ready: false,
      connectionId: connection.id,
    };
  }
  return { success: true, ready: true, connectionId: connection.id };
}

// ─── Credential reference descriptor (used by platform projections) ─────────

export function describeCredentialReference(
  connection: Pick<WhatsAppConnection, "credentialsRef" | "credentialKind">,
): CredentialReferenceDescriptor | null {
  if (!connection.credentialsRef) return null;
  const stored = connection.credentialKind as CredentialKind | null;
  return {
    reference: connection.credentialsRef,
    kind: stored ?? classifyCredentialReference(connection.credentialsRef),
  };
}
