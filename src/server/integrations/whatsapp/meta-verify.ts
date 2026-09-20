import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import {
  META_DEFAULT_API_VERSION,
  META_GRAPH_HOST,
  mapMetaError,
  type MetaApiErrorBody,
} from "@/server/integrations/whatsapp/meta-client";
import type {
  ConnectionVerificationResult,
  ConnectionVerifier,
} from "@/server/transport/whatsapp-transport";

/**
 * Meta WhatsApp Cloud API — READ-ONLY connection verification.
 *
 * Boundary rules:
 * - Meta concepts (Graph URL, version, access token, HTTP statuses) live
 *   ONLY here — the feature/Core sees only the normalized
 *   `ConnectionVerificationResult`.
 * - Verification NEVER sends a customer-facing WhatsApp message: it is a
 *   single read-only `GET /{apiVersion}/{phone_number_id}` that echoes
 *   the phone number's provider-side identity (`id`,
 *   `display_phone_number`, `verified_name`). A message template send or
 *   a business-initiated conversation is NOT part of verification.
 * - The credential is resolved from `credentialsRef` (an env-var NAME)
 *   at verification time — the reference itself is never logged and the
 *   secret never leaves this module.
 *
 * Operator prerequisites (cannot be completed from code alone): a Meta
 * App with the WhatsApp product, a WhatsApp Business Account, a
 * registered/verified phone number, and a permanent access token with
 * `whatsapp_business_messaging` permission stored in the environment
 * under the connection's `credentialsRef` name.
 */

export type MetaVerifyDeps = {
  getEnvVar(name: string): string | undefined;
  fetchImpl: typeof fetch;
  graphHost: string;
  defaultApiVersion: string;
  /**
   * The credential REFERENCE boundary (DECISIONS #49): resolves the
   * connection's `credentialsRef` — an ENV-var NAME (existing behavior)
   * or an opaque `fp:<id>` runtime handle — to the access token. The
   * value stays in this module; the reference is the only thing logged.
   */
  credentialsResolver: CredentialsResolver;
};

export type MetaPhone_numberResponse = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
};

/**
 * Resolve the read-only verification request config. The
 * `phone_number_id` under test is ALWAYS the connection's own
 * `externalId` — the point of verification is to prove that stored
 * identity is real, so the global env fallback is deliberately NOT used
 * for the id (only for the access token, the shared operator secret).
 */
export async function resolveMetaVerifyConfig(
  deps: Pick<
    MetaVerifyDeps,
    "getEnvVar" | "defaultApiVersion" | "credentialsResolver"
  >,
  params: { externalId: string; credentialsRef?: string | null },
): Promise<
  | { apiVersion: string; accessToken: string }
  | { error: ConnectionVerificationResult }
> {
  if (!params.externalId.trim()) {
    return {
      error: {
        ok: false,
        code: "INVALID_CONNECTION",
        message: "معرّف رقم واتساب مفقود",
      },
    };
  }

  const versionRaw =
    deps.getEnvVar("WHATSAPP_META_API_VERSION") ?? deps.defaultApiVersion;
  const apiVersion = versionRaw.startsWith("v") ? versionRaw : `v${versionRaw}`;

  let accessToken: string | undefined;
  if (params.credentialsRef) {
    const ref = params.credentialsRef.trim();
    const resolved = await deps.credentialsResolver.resolve(ref);
    if (!resolved.ok) {
      return {
        error: {
          ok: false,
          code: "INVALID_CREDENTIALS",
          message: resolved.message,
        },
      };
    }
    accessToken = resolved.value;
  } else {
    accessToken = deps.getEnvVar("WHATSAPP_META_ACCESS_TOKEN");
  }
  if (!accessToken) {
    return {
      error: {
        ok: false,
        code: "INVALID_CREDENTIALS",
        message: "رمز وصول واتساب غير مُهيأ",
      },
    };
  }

  return { apiVersion, accessToken };
}

export function buildMetaVerifyUrl(
  host: string,
  apiVersion: string,
  phoneNumberId: string,
): string {
  return `${host}/${apiVersion}/${phoneNumberId}`;
}

/**
 * Run the read-only verification call. Never throws — every failure is
 * a normalized `ConnectionVerificationResult`.
 */
export async function verifyMetaConnection(
  deps: MetaVerifyDeps,
  params: { externalId: string; credentialsRef?: string | null },
): Promise<ConnectionVerificationResult> {
  const configOrError = await resolveMetaVerifyConfig(deps, params);
  if ("error" in configOrError) return configOrError.error;
  const { apiVersion, accessToken } = configOrError;

  const url = buildMetaVerifyUrl(deps.graphHost, apiVersion, params.externalId);

  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return {
      ok: false,
      code: "UNREACHABLE",
      message: "تعذر الاتصال بخدمة واتساب",
    };
  }

  if (response.ok) {
    let body: MetaPhone_numberResponse | null = null;
    try {
      body = (await response.json()) as MetaPhone_numberResponse;
    } catch {
      body = null;
    }
    // The echoed id MUST match the stored externalId — a mismatch means
    // the provider resolved a different connection than the one we
    // recorded (misconfiguration or a stale id).
    if (!body?.id) {
      return {
        ok: false,
        code: "INVALID_CONNECTION",
        message: "استجابة واتساب لا تحمل هوية الاتصال",
      };
    }
    if (body.id !== params.externalId) {
      return {
        ok: false,
        code: "INVALID_CONNECTION",
        message: "هوية اتصال واتساب المُعادة لا تطابق المسجّلة",
      };
    }
    return {
      ok: true,
      verifiedExternalId: body.id,
      displayPhoneNumber: body.display_phone_number,
      verifiedName: body.verified_name,
    };
  }

  let errorBody: MetaApiErrorBody | null = null;
  try {
    errorBody = (await response.json()) as MetaApiErrorBody;
  } catch {
    errorBody = null;
  }
  const mapped = mapMetaError(response.status, errorBody);
  const code: "INVALID_CREDENTIALS" | "INVALID_CONNECTION" | "UNREACHABLE" =
    mapped.code === "UNAUTHORIZED_CREDENTIALS"
      ? "INVALID_CREDENTIALS"
      : mapped.code === "TRANSIENT_TRANSPORT_FAILURE"
        ? "UNREACHABLE"
        : "INVALID_CONNECTION";
  return {
    ok: false,
    code,
    message:
      code === "INVALID_CREDENTIALS"
        ? "بيانات اعتماد واتساب غير صالحة أو منتهية"
        : code === "UNREACHABLE"
          ? "خدمة واتساب غير متاحة حالياً"
          : "اتصال واتساب غير صالح أو غير مملوك لهذه المنشأة",
  };
}

/**
 * The Meta-backed verifier wired to the app's production singletons.
 * Called ONLY from the whatsapp-connection feature's server actions —
 * the feature itself stays provider-neutral.
 */
export function createDefaultMetaConnectionVerifier(): ConnectionVerifier {
  return {
    providerName: "meta-whatsapp",
    verify: (params) =>
      verifyMetaConnection(
        {
          getEnvVar: (name) => process.env[name],
          fetchImpl: globalThis.fetch,
          graphHost: META_GRAPH_HOST,
          defaultApiVersion: META_DEFAULT_API_VERSION,
          credentialsResolver: defaultCredentialsResolver,
        },
        params,
      ),
  };
}
