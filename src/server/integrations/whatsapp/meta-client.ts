import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import {
  TransportError,
  defaultConnectionResolutionDeps,
  resolveConnectionForSend,
  type ConnectionResolutionDeps,
  type MessageTransport,
  type OutboundMessage,
  type TransportSendResult,
  type WhatsAppTransportErrorCode,
} from "@/server/transport/whatsapp-transport";

/**
 * Meta WhatsApp Cloud API — outbound text adapter.
 *
 * Boundary rules:
 * - Meta concepts (Graph API URL, version, access token, WABA ids,
 *   HTTP status semantics) live ONLY here — never in Core.
 * - Credentials are a server-side env-var NAME indirection:
 *   `WhatsAppConnection.credentialsRef` holds an env-var NAME (e.g.
 *   `WHATSAPP_META_ACCESS_TOKEN`). The adapter reads that var's VALUE
 *   at send time — the reference itself is never logged.
 * - tenancy is enforced via `resolveConnectionForSend` (same-Business,
 *   CONNECTED/isActive gate) — the token is read only after tenancy.
 */

export const META_GRAPH_HOST = "https://graph.facebook.com";
export const META_DEFAULT_API_VERSION = "v21.0";

export type MetaClientConfig = {
  apiVersion: string;
  phoneNumberId?: string;
  accessToken: string;
};

export type ResolveMetaConfigDeps = {
  connectionDeps: ConnectionResolutionDeps;
  getEnvVar(name: string): string | undefined;
  defaultApiVersion: string;
  /**
   * The credential REFERENCE boundary (DECISIONS #49). A connection's
   * `credentialsRef` is resolved through it: an ENV-var NAME reads the
   * environment (the existing behavior); an opaque `fp:<id>` handle
   * resolves the encrypted runtime store. The VALUE is returned here and
   * never persisted or logged.
   */
  credentialsResolver: CredentialsResolver;
};

export async function resolveMetaClientConfig(
  deps: ResolveMetaConfigDeps,
  _params: { businessId: string; connectionId: string },
  connection: { phoneNumberId?: string | null; credentialsRef?: string | null },
): Promise<MetaClientConfig | { error: TransportError }> {
  const versionRaw =
    deps.getEnvVar("WHATSAPP_META_API_VERSION") ?? deps.defaultApiVersion;
  const apiVersion = versionRaw.startsWith("v") ? versionRaw : `v${versionRaw}`;

  const phoneNumberId =
    connection.phoneNumberId ??
    deps.getEnvVar("WHATSAPP_META_PHONE_NUMBER_ID") ??
    undefined;

  let accessToken: string | undefined;
  if (connection.credentialsRef) {
    const ref = connection.credentialsRef.trim();
    const resolved = await deps.credentialsResolver.resolve(ref);
    if (!resolved.ok) {
      return {
        error: new TransportError("UNAUTHORIZED_CREDENTIALS", resolved.message),
      };
    }
    accessToken = resolved.value;
  } else {
    accessToken = deps.getEnvVar("WHATSAPP_META_ACCESS_TOKEN");
  }
  if (!accessToken) {
    return {
      error: new TransportError(
        "UNAUTHORIZED_CREDENTIALS",
        "رمز وصول واتساب غير مُهيأ",
      ),
    };
  }

  return { apiVersion, phoneNumberId, accessToken };
}

export function buildMetaSendUrl(
  host: string,
  apiVersion: string,
  phoneNumberId: string,
): string {
  return `${host}/${apiVersion}/${phoneNumberId}/messages`;
}

export function buildMetaTextPayload(to: string, text: string): unknown {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: text },
  };
}

// ─── Error mapping ─────────────────────────────────────────────────────────

export type MetaApiErrorBody = {
  error?: {
    code?: number;
    error_subcode?: number;
    type?: string;
    message?: string;
    error_data?: { details?: string };
  };
};

/**
 * Map Graph API failures to the provider-neutral transport taxonomy.
 * Never leaks HTTP details into Domain — the code + retryable flag
 * are the only signals Core sees.
 */
export function mapMetaError(
  httpStatus: number,
  body: MetaApiErrorBody | null,
): { code: WhatsAppTransportErrorCode; retryable: boolean } {
  const errorCode = body?.error?.code;
  // 401/403 → credential problem (not retryable)
  if (httpStatus === 401 || httpStatus === 403) {
    return { code: "UNAUTHORIZED_CREDENTIALS", retryable: false };
  }
  // 400 — inspect Graph subcode for retryability
  if (httpStatus === 400) {
    // 368 = temporarily blocked / rate-adjacent — retryable
    if (body?.error?.error_subcode === 368) {
      return { code: "TRANSIENT_TRANSPORT_FAILURE", retryable: true };
    }
    return { code: "PERMANENT_TRANSPORT_FAILURE", retryable: false };
  }
  // 429 → rate limit (retryable)
  if (httpStatus === 429) {
    return { code: "TRANSIENT_TRANSPORT_FAILURE", retryable: true };
  }
  // 5xx → transient
  if (httpStatus >= 500 && httpStatus < 600) {
    return { code: "TRANSIENT_TRANSPORT_FAILURE", retryable: true };
  }
  // Graph OAuth subcodes that mean bad/expired token
  if (errorCode === 190 || errorCode === 102) {
    return { code: "UNAUTHORIZED_CREDENTIALS", retryable: false };
  }
  return { code: "PERMANENT_TRANSPORT_FAILURE", retryable: false };
}

// ─── Transport implementation ──────────────────────────────────────────────

export type MetaTransportDeps = {
  connectionDeps: ConnectionResolutionDeps;
  getEnvVar(name: string): string | undefined;
  fetchImpl: typeof fetch;
  graphHost: string;
  defaultApiVersion: string;
  credentialsResolver: CredentialsResolver;
};

/**
 * Create the Meta-backed MessageTransport.
 * The `connectionId` is resolved per-send from the OutboundMessage
 * (or a default configured connection when absent).
 */
export function createMetaWhatsAppTransport(
  deps: MetaTransportDeps,
): MessageTransport {
  return {
    providerName: "meta-whatsapp",
    async send(message: OutboundMessage): Promise<TransportSendResult> {
      // Outbound tenancy: the sending connection MUST be resolvable
      // WITHIN the message's Business. `businessId` and `connectionId`
      // are server-derived (resolved at the inbound boundary) — a
      // cross-Business pair fails closed in `resolveConnectionForSend`.
      const connectionId = message.connectionId;
      const businessId = message.businessId;
      if (!connectionId || !businessId) {
        return {
          provider: "meta-whatsapp",
          delivered: false,
          error: "لا يوجد اتصال واتساب مرتبط بالإرسال",
          errorCode: "INVALID_CONNECTION",
        };
      }

      const resolved = await resolveConnectionForSend(deps.connectionDeps, {
        connectionId,
        businessId,
      });
      if (!resolved.ok) {
        return {
          provider: "meta-whatsapp",
          delivered: false,
          error: resolved.message,
          errorCode: resolved.code,
        };
      }

      // Fetch the connection row for credentialsRef/phoneNumberId
      const row = await deps.connectionDeps.whatsappConnectionRepository
        .findByIdWithinBusiness(connectionId, businessId)
        .catch(() => null);
      // row is the same as `resolved` already validated; read the ref
      const credentialsRef =
        (row as { credentialsRef?: string | null } | null)?.credentialsRef ??
        null;
      const phoneNumberIdFromConnection =
        (row as { externalId?: string | null } | null)?.externalId ?? null;

      const configOrError = await resolveMetaClientConfig(
        {
          connectionDeps: deps.connectionDeps,
          getEnvVar: deps.getEnvVar,
          defaultApiVersion: deps.defaultApiVersion,
          credentialsResolver: deps.credentialsResolver,
        },
        { businessId, connectionId },
        {
          phoneNumberId: phoneNumberIdFromConnection,
          credentialsRef,
        },
      );
      if ("error" in configOrError) {
        return {
          provider: "meta-whatsapp",
          delivered: false,
          error: configOrError.error.message,
          errorCode: configOrError.error.code,
        };
      }
      const config = configOrError;
      const phoneNumberId = config.phoneNumberId;
      if (!phoneNumberId) {
        return {
          provider: "meta-whatsapp",
          delivered: false,
          error: "معرّف رقم واتساب غير مُهيأ",
          errorCode: "INVALID_CONNECTION",
        };
      }

      const url = buildMetaSendUrl(
        deps.graphHost,
        config.apiVersion,
        phoneNumberId,
      );
      const body = buildMetaTextPayload(message.to, message.content);

      let response: Response;
      try {
        response = await deps.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.accessToken}`,
          },
          body: JSON.stringify(body),
        });
      } catch {
        return {
          provider: "meta-whatsapp",
          delivered: false,
          error: "تعذر الاتصال بخدمة واتساب",
          errorCode: "TRANSIENT_TRANSPORT_FAILURE",
        };
      }

      if (response.ok) {
        let providerMessageId: string | undefined;
        try {
          const json = (await response.json()) as {
            messages?: Array<{ id?: string }>;
          };
          providerMessageId = json.messages?.[0]?.id;
        } catch {
          // no-op: delivery already succeeded
        }
        void providerMessageId;
        return { provider: "meta-whatsapp", delivered: true };
      }

      let errorBody: MetaApiErrorBody | null = null;
      try {
        errorBody = (await response.json()) as MetaApiErrorBody;
      } catch {
        errorBody = null;
      }
      const mapped = mapMetaError(response.status, errorBody);
      const detail = errorBody?.error?.message ?? `HTTP ${response.status}`;
      return {
        provider: "meta-whatsapp",
        delivered: false,
        error: detail,
        errorCode: mapped.code,
      };
    },
  };
}

/**
 * The Meta-backed transport wired to the app's production singletons
 * (`defaultConnectionResolutionDeps` + `process.env` + global fetch).
 * The Meta route is the ONLY caller: the provider-neutral engine default
 * stays offline, so non-Meta entry points never gain a live sender.
 */
export function createDefaultMetaWhatsAppTransport(): MessageTransport {
  return createMetaWhatsAppTransport({
    connectionDeps: defaultConnectionResolutionDeps,
    getEnvVar: (name) => process.env[name],
    fetchImpl: globalThis.fetch,
    graphHost: META_GRAPH_HOST,
    defaultApiVersion: META_DEFAULT_API_VERSION,
    credentialsResolver: defaultCredentialsResolver,
  });
}
