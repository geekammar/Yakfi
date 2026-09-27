/**
 * Provider-neutral WhatsApp transport contract foundation
 * (PROMPT-CORE-03A; DECISIONS #29/#31).
 *
 * The canonical, replaceable transport boundary between the FlowPilot
 * Core and ANY WhatsApp vendor:
 *
 *   inbound:  provider webhook → provider adapter (PROMPT-CORE-03B) →
 *             normalizeInboundTransportMessage → resolveInboundConnection
 *             → toEngineInboundMessage → Conversation Engine
 *
 *   outbound: Conversation result → OutboundMessage → MessageTransport →
 *             provider adapter (PROMPT-CORE-03B)
 *
 * The contracts carry ONLY normalized internal identity:
 * - no Meta request/response objects, Graph API shapes, or HTTP status
 *   assumptions — the future adapter maps vendor errors onto the
 *   taxonomy below;
 * - no provider access tokens — connections hold `credentialsRef`
 *   REFERENCES, and the credential itself is never returned;
 * - no provider-specific retry semantics — the taxonomy only classifies
 *   retryable vs permanent; retry POLICY belongs to the adapter layer;
 * - unknown/hostile keys in provider payloads are stripped by Zod:
 *   businessId/branchId/connectionId/role/accountType can never be
 *   injected from a client payload — identity is resolved SERVER-side
 *   from persisted state over the EXISTING repositories.
 *
 * No vendor is integrated here: no SDK, no HTTP, no webhook
 * verification, no media download, no actual send. Pure contracts +
 * normalization + tenant resolution.
 */

import { externalHandleSchema } from "@/lib/validation";
import type { CredentialKind } from "@/lib/validation";
import type {
  BranchRepository,
  BusinessRepository,
  WhatsAppConnectionRepository,
} from "@/server/repositories";
import {
  branchRepository,
  businessRepository,
  whatsAppConnectionRepository,
} from "@/server/repositories";

import { z } from "zod";

// ─── Transport error taxonomy ────────────────────────────────────────────────

/**
 * Minimal provider-neutral failure taxonomy for the transport boundary.
 * The future Meta adapter maps vendor-specific errors (HTTP statuses,
 * Graph API error payloads) onto these categories — Core never assumes
 * provider-specific statuses. Retry POLICY (backoff, budgets) belongs to
 * the adapter/integration layer; only the retryable classification is
 * part of this contract.
 */
export const whatsappTransportErrorCodes = [
  /** The connection is missing, inactive, or disconnected for the tenant. */
  "INVALID_CONNECTION",
  /** The credential reference is unusable (never the secret itself). */
  "UNAUTHORIZED_CREDENTIALS",
  /** The adapter received a payload it cannot map to the contract. */
  "MALFORMED_PROVIDER_PAYLOAD",
  /** A redelivered inbound message (idempotent success, not an error). */
  "DUPLICATE_INBOUND",
  /** The message kind is not supported by the transport/Core yet. */
  "UNSUPPORTED_MESSAGE_TYPE",
  /** Transient transport failure — retryable by the adapter. */
  "TRANSIENT_TRANSPORT_FAILURE",
  /** Permanent transport failure — never retried. */
  "PERMANENT_TRANSPORT_FAILURE",
] as const;

export type WhatsAppTransportErrorCode =
  (typeof whatsappTransportErrorCodes)[number];

/** Only transient failures may be retried — the adapter's retry policy decides how. */
export function isRetryableTransportErrorCode(
  code: WhatsAppTransportErrorCode,
): boolean {
  return code === "TRANSIENT_TRANSPORT_FAILURE";
}

/** Typed transport failure carrying its normalized category. */
export class TransportError extends Error {
  readonly code: WhatsAppTransportErrorCode;
  readonly retryable: boolean;

  constructor(code: WhatsAppTransportErrorCode, message?: string) {
    super(message ?? code);
    this.name = "TransportError";
    this.code = code;
    this.retryable = isRetryableTransportErrorCode(code);
  }
}

// ─── Normalized inbound envelope ─────────────────────────────────────────────

/** Normalized message kinds. TEXT is the only kind the Core consumes today. */
export const inboundTransportKindValues = [
  "TEXT",
  "MEDIA",
  "UNSUPPORTED",
] as const;

export type InboundTransportKind = (typeof inboundTransportKindValues)[number];

/**
 * Minimal media REFERENCE contract — the provider payload is never
 * copied into Core and media is never downloaded here (a later
 * decision); only what the transport legitimately observed crosses.
 */
export const inboundTransportMediaSchema = z.object({
  mimeType: z.string().trim().min(1).max(128),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024)
    .optional(),
  /** Provider-side locator only — never fetched by Core. */
  externalReference: z.string().trim().min(1).max(512),
});

export type InboundTransportMedia = z.infer<typeof inboundTransportMediaSchema>;

const normalizedInboundTransportSchema = z
  .object({
    /** Provider message id — the inbound idempotency key when present. */
    externalMessageId: z.string().trim().min(1).max(256),
    /** The customer's provider-neutral external handle (E.164 phone for
     *  the WhatsApp path; a Telegram chat id for the Telegram path —
     *  DECISIONS #64). */
    senderExternalId: externalHandleSchema,
    /** The receiving identity's provider-neutral external handle. */
    recipientExternalId: externalHandleSchema,
    /**
     * Provider-side STABLE identity of the receiving account when the
     * provider exposes one separately from its display number (e.g. a
     * Meta Cloud API `phone_number_id`). Purely a lookup key: it maps to
     * a persisted `WhatsAppConnection.externalId` server-side and is
     * NEVER trusted as tenant identity by itself. Optional — providers
     * without a separate identity keep the phone-number mapping.
     */
    recipientProviderId: z.string().trim().min(1).max(256).optional(),
    /** Transport-owned receive timestamp. */
    timestamp: z.iso.datetime(),
    kind: z.enum(inboundTransportKindValues).default("TEXT"),
    /** Text payload — required for TEXT, forbidden otherwise. */
    text: z.string().trim().min(1).max(4096).optional(),
    /** Media reference — required for MEDIA, forbidden otherwise. */
    media: inboundTransportMediaSchema.optional(),
  })
  .strict()
  .refine((message) => message.kind !== "TEXT" || message.text != null, {
    error: "نص الرسالة مطلوب للرسائل النصية",
    path: ["text"],
  })
  .refine((message) => message.kind !== "MEDIA" || message.media != null, {
    error: "مرجع الوسائط مطلوب للرسائل المرئية",
    path: ["media"],
  })
  .refine(
    (message) =>
      message.kind !== "UNSUPPORTED" ||
      (message.text == null && message.media == null),
    { error: "الرسائل غير المدعومة لا تحمل محتوى" },
  );

const normalizedInboundTransportSchemaWithExclusivity =
  normalizedInboundTransportSchema
    .refine((message) => message.kind !== "TEXT" || message.media == null, {
      error: "الرسائل النصية لا تحمل مرجع وسائط",
      path: ["media"],
    })
    .refine((message) => message.kind !== "MEDIA" || message.text == null, {
      error: "الرسائل المرئية لا تحمل نصًا",
      path: ["text"],
    });

const effectiveInboundSchema = normalizedInboundTransportSchemaWithExclusivity;

/**
 * The normalized inbound envelope — the ONLY shape a transport adapter
 * may hand to the Core. Unknown keys (including hostile identity keys:
 * businessId/branchId/connectionId/role/accountType) are REJECTED by
 * construction (`strict()`), never copied from the provider payload.
 */
export type NormalizedInboundTransportMessage = z.infer<
  typeof effectiveInboundSchema
>;

export type NormalizeInboundResult =
  | { ok: true; message: NormalizedInboundTransportMessage }
  | { ok: false; error: TransportError };

/** Provider payload → normalized envelope (boundary entry point). */
export function normalizeInboundTransportMessage(
  input: unknown,
): NormalizeInboundResult {
  const parsed = effectiveInboundSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: new TransportError(
        "MALFORMED_PROVIDER_PAYLOAD",
        parsed.error.issues[0]?.message ?? "حمولة الرسالة الواردة غير صالحة",
      ),
    };
  }
  return { ok: true, message: parsed.data };
}

/**
 * Server-resolved tenant identity — NEVER accepted from a provider
 * payload; attached only after `resolveInboundConnection` ran against
 * persisted state.
 */
export type ResolvedInboundIdentity = {
  /** The Business-owned connection row id when one exists (null = the
   *  legacy whatsappNumber mapping only). */
  connectionId: string | null;
  businessId: string;
  /** Optional Branch scope of the connection (null = Business-shared). */
  branchId: string | null;
};

/** Normalized envelope + server-resolved identity — engine-ready. */
export type ResolvedInboundTransportMessage =
  NormalizedInboundTransportMessage & ResolvedInboundIdentity;

/**
 * Structural twin of the Conversation Engine's inbound contract
 * (`inboundMessageSchema` in the conversations feature) — the shape is
 * proven identical by `pnpm check:whatsapp-transport`, which runs the
 * REAL engine schema (and the REAL engine) against this output. The
 * boundary never imports the feature (dependency direction: features →
 * server).
 */
export type EngineInboundMessage = {
  to: string;
  from: string;
  text: string;
  receivedAt: string;
  externalId?: string;
};

/**
 * Normalized envelope → the Conversation Engine's inbound input. Only
 * TEXT messages cross into the Core today: a non-TEXT envelope is
 * refused at this boundary with UNSUPPORTED_MESSAGE_TYPE (the adapter
 * decides how to respond — media handling is not implemented yet).
 */
export function toEngineInboundMessage(
  resolved: ResolvedInboundTransportMessage,
): EngineInboundMessage {
  if (resolved.kind !== "TEXT" || resolved.text == null) {
    throw new TransportError(
      "UNSUPPORTED_MESSAGE_TYPE",
      "نوع الرسالة غير مدعوم في نواة المحادثات",
    );
  }
  return {
    to: resolved.recipientExternalId,
    from: resolved.senderExternalId,
    text: resolved.text,
    receivedAt: resolved.timestamp,
    externalId: resolved.externalMessageId,
  };
}

// ─── Normalized outbound contract ────────────────────────────────────────────

/** One outbound assistant reply to deliver to a customer. */
export type OutboundMessage = {
  /** Customer phone number (E.164-ish, as received inbound). */
  to: string;
  /** The sending Business — REQUIRED for tenant-scoped send resolution:
   *  an adapter must be able to prove the connection belongs to this
   *  Business before reading any credential reference. */
  businessId: string;
  /** Display name of the sending business. */
  businessName: string;
  /** Conversation the reply belongs to. */
  conversationId: string;
  /** Reply text exactly as persisted. */
  content: string;
  /** Normalized internal connection id (which WhatsApp identity sends) —
   *  resolved server-side; a connection of ANOTHER Business is unusable
   *  (see `resolveConnectionForSend`). */
  connectionId?: string;
  /** Internal correlation id (the persisted Message id) — outbound
   *  idempotency/audit metadata, never a provider id. */
  correlationId?: string;
  /** Normalized message kind — TEXT is the only kind Core sends today. */
  kind?: "TEXT";
};

/** Result of one delivery attempt. */
export type TransportSendResult = {
  provider: string;
  delivered: boolean;
  /** Human-readable failure reason when not delivered. */
  error?: string;
  /** Normalized error category when not delivered — the adapter maps
   *  provider-specific failures onto the taxonomy. */
  errorCode?: WhatsAppTransportErrorCode;
};

/** Provider-neutral outbound transport. */
export interface MessageTransport {
  readonly providerName: string;
  send(message: OutboundMessage): Promise<TransportSendResult>;
}

// ─── Connection verification boundary ────────────────────────────────────────

/**
 * Provider-neutral, READ-ONLY connection verification (the onboarding
 * "is this connection usable?" check). A provider adapter probes its
 * own provider with the connection's credential reference and reports
 * the normalized outcome — it MUST NOT send any customer-facing
 * message. Meta concepts (Graph endpoints, HTTP statuses) never cross
 * this boundary; only the normalized result below does.
 */
export type ConnectionVerificationResult =
  | {
      ok: true;
      /** The provider's own connection id echoed back (e.g. Meta
       *  `phone_number_id`) — confirms the stored externalId is real. */
      verifiedExternalId: string;
      /** Provider-side display number for the connection (non-secret). */
      displayPhoneNumber?: string;
      /** Provider-side verified name (non-secret). */
      verifiedName?: string;
    }
  | {
      ok: false;
      /** Normalized failure category — never an HTTP status. */
      code: "INVALID_CREDENTIALS" | "INVALID_CONNECTION" | "UNREACHABLE";
      message: string;
    };

export interface ConnectionVerifier {
  readonly providerName: string;
  verify(params: {
    /** The connection's provider-side stable identity (Meta
     *  `phone_number_id`). Required — identity is authoritative. */
    externalId: string;
    /** Credential REFERENCE (env-var name) — the adapter resolves the
     *  secret server-side; the value itself never crosses this call. */
    credentialsRef?: string | null;
  }): Promise<ConnectionVerificationResult>;
}

// ─── Onboarding authorization boundary (WHATSAPP-ONBOARDING-01) ─────────────

/**
 * Provider-neutral connection AUTHORIZATION port — the onboarding
 * "connect this number" step, sitting beside the read-only
 * `ConnectionVerifier` above. The WhatsApp onboarding feature talks to
 * this boundary only; a future Meta Embedded Signup adapter implements
 * it (a deterministic stand-in is wired until then).
 *
 * Boundary rules:
 * - Provider concepts (Embedded Signup, Graph endpoints, OAuth codes,
 *   WABA ids, HTTP statuses) live ONLY inside the adapter — this port
 *   carries normalized identity + opaque references, never a provider
 *   model and never an HTTP status.
 * - A raw access token NEVER crosses this boundary in either direction.
 *   A credential comes back as an opaque REFERENCE (`credentialsRef`)
 *   plus its KIND (ENV today; RUNTIME once a runtime secret store
 *   exists) — the feature persists the reference only.
 * - Tenancy is NOT this port's concern: the caller persists the
 *   `stateRef` → Business/connection binding server-side (the
 *   authorization ledger) and resolves the target Business ONLY from
 *   that persisted state. `businessId` in the launch params is an
 *   audit hint, never an authority.
 * - This port provisions nothing on the provider side: no number
 *   registration, no webhook subscription, no message of any kind.
 */
export type AuthorizationLaunchParams = {
  /** The Business onboarding the number — audit hint, never authority. */
  businessId: string;
  /** The connection row being authorized. */
  connectionId: string;
  /** The Business's display number (E.164), a non-secret label. */
  phoneNumber?: string | null;
  /** The server-built callback URL the provider must return to. */
  redirectUri: string;
  /**
   * The persisted state reference of an in-flight attempt the launch is
   * RESUMING. The provider's `state` must be the server-persisted one,
   * so a resumed attempt reuses the same reference (no second attempt).
   */
  existingStateRef?: string | null;
};

export type AuthorizationLaunchResult = {
  /** Where the Business Admin's browser goes next (provider-owned URL). */
  authorizationUrl: string;
  /** Opaque single-use state reference — the ONLY callback credential. */
  stateRef: string;
};

export type AuthorizationExchangeParams = {
  /** The provider's authorization code (opaque outside the adapter). */
  code: string;
  /** The opaque state reference persisted at launch time. */
  stateRef: string;
  /** The same server-built callback URL used at launch. */
  redirectUri: string;
  /**
   * The Business the authorization belongs to — an AUDIT hint taken from
   * the persisted authorization ledger (never from the client). An
   * adapter that persists a provider-issued secret uses ONLY this to
   * tenant-scope that secret; it is never authority for which Business
   * a callback belongs to (the ledger is).
   */
  businessId: string;
};

/**
 * Provider-reported non-secret provenance with provider-OWNED keys. Only
 * an allowlist is persisted (the feature maps the Meta keys it knows);
 * unknown keys never reach the database.
 */
export type AuthorizationProvenance = Readonly<Record<string, string>>;

export const authorizationErrorCodeValues = [
  /** The Business Admin declined or the provider rejected the attempt. */
  "AUTHORIZATION_DECLINED",
  /** The authorization attempt expired before the callback arrived. */
  "AUTHORIZATION_EXPIRED",
  /** The provider rejected the returned code / it was already used. */
  "INVALID_AUTHORIZATION_CODE",
  /** The provider needs more steps (e.g. a pending review) — not ready. */
  "PROVISIONING_INCOMPLETE",
  /** Transient provider failure — retryable. */
  "PROVIDER_UNREACHABLE",
  /** The adapter could not map the provider response onto the contract. */
  "PROVIDER_PAYLOAD_INVALID",
] as const;

export type AuthorizationErrorCode =
  (typeof authorizationErrorCodeValues)[number];

export type AuthorizationResult =
  | {
      ok: true;
      /** The provider's STABLE connection identity (Meta
       *  `phone_number_id`) — becomes `WhatsAppConnection.externalId`. */
      externalId: string;
      /** Opaque credential REFERENCE — never a raw token. */
      credentialsRef: string;
      /** The grammar of `credentialsRef` (ENV / RUNTIME). */
      credentialKind: CredentialKind;
      /** Provider-side display number (non-secret label). */
      displayPhoneNumber?: string;
      /** Provider-side verified name (non-secret label). */
      verifiedName?: string;
      /** Extra provider-owned non-secret reference fields. */
      provenance?: AuthorizationProvenance;
    }
  | {
      ok: false;
      /** Normalized failure category — never an HTTP status. */
      code: AuthorizationErrorCode;
      message: string;
    };

export interface ConnectionAuthorizer {
  readonly providerName: string;
  launchAuthorization(
    params: AuthorizationLaunchParams,
  ): Promise<AuthorizationLaunchResult>;
  exchangeCallback(
    params: AuthorizationExchangeParams,
  ): Promise<AuthorizationResult>;
}

// ─── Connection / tenant resolution boundary ─────────────────────────────────

/** Canonical phone form for the number-mapping lookups (digits + leading +). */
function canonicalPhone(phone: string): string {
  return phone.replace(/[\s-]/g, "");
}

export type ConnectionResolutionDeps = {
  businessRepository: Pick<
    BusinessRepository,
    "findByWhatsappNumber" | "findById"
  >;
  whatsappConnectionRepository: Pick<
    WhatsAppConnectionRepository,
    "findByPhone" | "findByIdWithinBusiness" | "findByExternalId"
  >;
  branchRepository: Pick<
    BranchRepository,
    "findDefaultByBusiness" | "findByIdWithinBusiness"
  >;
};

/** Production dependencies (app singletons). */
export const defaultConnectionResolutionDeps: ConnectionResolutionDeps = {
  businessRepository,
  whatsappConnectionRepository: whatsAppConnectionRepository,
  branchRepository,
};

export type InboundConnectionResolution =
  | {
      ok: true;
      businessId: string;
      businessName: string;
      /** The Business-owned connection row id when one exists. */
      connectionId: string | null;
      /** Validated Branch scope: the connection's own branch, else the
       *  Business's Default Branch (null only for a Business-shared
       *  connection without a resolvable default). */
      branchId: string | null;
      /** Machine connection status when a connection row exists. */
      connectionStatus: string | null;
    }
  | { ok: false; code: WhatsAppTransportErrorCode; message: string };

export type SendConnectionResolution =
  | {
      ok: true;
      connectionId: string;
      branchId: string | null;
      /** The business-owned sending number (not a secret). */
      phoneNumber: string;
    }
  | { ok: false; code: WhatsAppTransportErrorCode; message: string };

/**
 * INBOUND tenancy: recipient number → Business → optional connection →
 * optional Branch. All identity comes from persisted server-side state
 * (the established `BusinessRepository.findByWhatsappNumber` mapping) —
 * never from the provider payload. A connection row (when present) is
 * same-Business BY CONSTRUCTION (Business-scoped repository lookup), and
 * its optional Branch scope is VALIDATED within the Business: a foreign
 * or corrupt branchId refuses with INVALID_CONNECTION instead of being
 * silently trusted.
 */
export async function resolveInboundConnection(
  deps: ConnectionResolutionDeps,
  recipientPhone: string,
  providerIdentity?: string | null,
): Promise<InboundConnectionResolution> {
  const phone = canonicalPhone(recipientPhone);

  // 1. Preferred: the provider's STABLE receiving identity maps to a
  //    persisted, Business-owned connection (`WhatsAppConnection.externalId`
  //    — e.g. the Meta `phone_number_id`). The display number is only a
  //    label and may be formatted differently from the stored mapping.
  if (providerIdentity) {
    const connection =
      await deps.whatsappConnectionRepository.findByExternalId(
        providerIdentity,
      );
    if (connection) {
      const business = await deps.businessRepository.findById(
        connection.businessId,
      );
      if (!business || !business.isActive) {
        return {
          ok: false,
          code: "INVALID_CONNECTION",
          message: "المنشأة غير مفعّلة حالياً",
        };
      }
      return finalizeInboundResolution(deps, business, connection);
    }
  }

  // 2. Legacy phone mapping (Business.whatsappNumber) — used when the
  //    provider exposes no stable identity or no connection is registered
  //    for it yet.
  const business = await deps.businessRepository.findByWhatsappNumber(phone);
  if (!business) {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "تعذر تحديد المنشأة المستقبلة للرسالة",
    };
  }
  if (!business.isActive) {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "المنشأة غير مفعّلة حالياً",
    };
  }
  const connection = await deps.whatsappConnectionRepository.findByPhone(
    business.id,
    phone,
  );
  return finalizeInboundResolution(deps, business, connection);
}

/** Shared Branch validation + result shape for both resolution paths. */
async function finalizeInboundResolution(
  deps: ConnectionResolutionDeps,
  business: { id: string; name: string },
  connection: { id: string; branchId: string | null; status: string } | null,
): Promise<InboundConnectionResolution> {
  let branchId: string | null = null;
  if (connection?.branchId) {
    const branch = await deps.branchRepository.findByIdWithinBusiness(
      connection.branchId,
      business.id,
    );
    if (!branch) {
      return {
        ok: false,
        code: "INVALID_CONNECTION",
        message: "نطاق فرع الاتصال غير صالح",
      };
    }
    branchId = branch.id;
  } else {
    const defaultBranch = await deps.branchRepository.findDefaultByBusiness(
      business.id,
    );
    branchId = defaultBranch?.id ?? null;
  }
  return {
    ok: true,
    businessId: business.id,
    businessName: business.name,
    connectionId: connection?.id ?? null,
    branchId,
    connectionStatus: connection?.status ?? null,
  };
}

/**
 * OUTBOUND tenancy: which connection may send for a Business. The
 * connection id is a NORMALIZED internal id resolved WITHIN the Business
 * — a connection of ANOTHER Business (or an unknown one) is "not found"
 * for the caller (no cross-tenant existence leak), so cross-Business
 * connection use is impossible. Only an active CONNECTED connection may
 * send. The credential reference itself is never returned — the future
 * adapter resolves it inside the transport layer.
 */
export async function resolveConnectionForSend(
  deps: ConnectionResolutionDeps,
  params: { connectionId: string; businessId: string },
): Promise<SendConnectionResolution> {
  const connection =
    await deps.whatsappConnectionRepository.findByIdWithinBusiness(
      params.connectionId,
      params.businessId,
    );
  if (!connection) {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "الاتصال غير متاح لهذه المنشأة",
    };
  }
  if (!connection.isActive) {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "الاتصال غير مفعّل حالياً",
    };
  }
  if (connection.status !== "CONNECTED") {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "الاتصال غير موصول حالياً",
    };
  }
  return {
    ok: true,
    connectionId: connection.id,
    branchId: connection.branchId ?? null,
    phoneNumber: connection.phoneNumber,
  };
}
