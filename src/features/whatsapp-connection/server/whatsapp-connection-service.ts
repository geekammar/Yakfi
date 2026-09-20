/**
 * WhatsApp connection onboarding workflow (Business Admin → connect /
 * configure / verify / activate a WhatsApp number for the Business).
 *
 * Architecture invariants (DECISIONS #31/#42, AGENT_RULES):
 * - The Business is ALWAYS the actor's own, derived from the trusted
 *   session → user record — never from client input. A client-supplied
 *   businessId can never redirect a read or a write.
 * - ADMIN-only (the Business Admin owns the connection).
 * - `externalId` (the Meta `phone_number_id`) is the AUTHORITATIVE
 *   provider identity; `phoneNumber` is a display label.
 * - Secrets: `credentialsRef` is an env-var NAME. The raw access token
 *   is resolved by the provider verifier at verification time and never
 *   crosses this service, the view, or the logs.
 * - The provider verifier is an injected `ConnectionVerifier` — this
 *   service contains zero Meta assumptions (the Meta adapter owns them).
 * - Verification is READ-ONLY: no customer-facing WhatsApp message is
 *   ever sent by this workflow.
 * - The EXISTING status model is reused (PENDING / CONNECTED /
 *   DISCONNECTED + isActive) — no parallel connection-state system.
 */

import { whatsappConnectionValidation } from "@/features/whatsapp-connection/schemas/whatsapp-connection-schema";
import type {
  WhatsAppConnectionActionResult,
  WhatsAppConnectionListResult,
  WhatsAppConnectionView,
  WhatsAppVerificationResult,
} from "@/features/whatsapp-connection/types";
import { maskExternalId } from "@/lib/whatsapp-identity";
import type { WhatsAppConnectionRepository } from "@/server/repositories";
import { whatsAppConnectionRepository } from "@/server/repositories";
import type {
  ConnectionVerificationResult,
  ConnectionVerifier,
} from "@/server/transport/whatsapp-transport";
import type { WhatsAppConnection } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type WhatsAppConnectionActor = {
  userId: string;
  role: "ADMIN" | "STAFF";
  businessId: string | null;
};

export type WhatsAppConnectionServiceDeps = {
  whatsappConnectionRepository: Pick<
    WhatsAppConnectionRepository,
    | "create"
    | "update"
    | "findByIdWithinBusiness"
    | "findByExternalId"
    | "listByBusiness"
  >;
  /** Provider verifier (Meta adapter in production; fake in tests). */
  verifier: ConnectionVerifier;
};

const FORBIDDEN_MESSAGE = "إعداد واتساب متاح للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const NOT_FOUND_MESSAGE = "تعذر العثور على اتصال واتساب لهذه المنشأة";
const DUPLICATE_MESSAGE =
  "هذا الاتصال (معرّف الرقم) مسجّل لمنشأة أخرى — يجب إزالته منها أولاً";

function resolveScope(
  actor: WhatsAppConnectionActor,
): { ok: true; businessId: string } | { ok: false; message: string } {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

// Canonical masking helper (`@/lib/whatsapp-identity` — one rule for
// every surface that shows a provider connection identity).
export { maskExternalId } from "@/lib/whatsapp-identity";

function toView(connection: WhatsAppConnection): WhatsAppConnectionView {
  return {
    id: connection.id,
    provider: connection.provider ?? null,
    displayName: connection.displayName ?? null,
    phoneNumber: connection.phoneNumber,
    externalId: connection.externalId ?? null,
    externalIdMasked: maskExternalId(connection.externalId),
    status: connection.status,
    isActive: connection.isActive,
    updatedAt: connection.updatedAt.toISOString(),
  };
}

/** List the actor's Business connections (ADMIN only, own Business). */
export async function listConnections(
  deps: WhatsAppConnectionServiceDeps,
  actor: WhatsAppConnectionActor,
): Promise<WhatsAppConnectionListResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { message: scope.message };

  const connections = await deps.whatsappConnectionRepository.listByBusiness(
    scope.businessId,
  );
  return { connections: connections.map(toView) };
}

/**
 * Create or update the actor's Business WhatsApp connection (ADMIN only,
 * own Business). The lifecycle fields (status/isActive) are NEVER client
 * input: a new connection starts PENDING and only verification may
 * CONNECT it.
 */
export async function saveConnection(
  deps: WhatsAppConnectionServiceDeps,
  actor: WhatsAppConnectionActor,
  input: unknown,
): Promise<WhatsAppConnectionActionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const parsed = whatsappConnectionValidation.save.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message:
        parsed.error.issues[0]?.message ?? "بيانات اتصال واتساب غير صالحة",
    };
  }

  // Duplicate protection (DECISIONS #23 check-then-create convention —
  // service-layer, no schema constraint): a provider connection identity
  // is one WhatsApp number; registering the SAME externalId under two
  // Businesses would make inbound tenant resolution ambiguous. Self is
  // excluded (updating the same connection keeps its own identity).
  if (parsed.data.connectionId) {
    const existing =
      await deps.whatsappConnectionRepository.findByIdWithinBusiness(
        parsed.data.connectionId,
        scope.businessId,
      );
    if (!existing) return { success: false, message: NOT_FOUND_MESSAGE };
  }
  const duplicate = await deps.whatsappConnectionRepository.findByExternalId(
    parsed.data.externalId,
  );
  if (duplicate && duplicate.id !== parsed.data.connectionId) {
    return { success: false, message: DUPLICATE_MESSAGE };
  }

  try {
    if (parsed.data.connectionId) {
      // Update identity/label only — verification owns the lifecycle.
      const updated = await deps.whatsappConnectionRepository.update(
        parsed.data.connectionId,
        scope.businessId,
        {
          displayName: parsed.data.displayName ?? null,
          phoneNumber: parsed.data.phoneNumber,
          externalId: parsed.data.externalId,
          credentialsRef: parsed.data.credentialsRef,
          // The provider label comes from the wired verifier (the
          // provider adapter owns its own identity) — never hard-coded
          // in this provider-neutral feature.
          provider: deps.verifier.providerName,
        },
      );
      if (!updated) return { success: false, message: NOT_FOUND_MESSAGE };
      return { success: true, connection: toView(updated) };
    }

    const created = await deps.whatsappConnectionRepository.create({
      businessId: scope.businessId,
      branchId: null, // Business-shared (Default Branch) — DECISIONS #31
      displayName: parsed.data.displayName ?? undefined,
      phoneNumber: parsed.data.phoneNumber,
      provider: deps.verifier.providerName,
      externalId: parsed.data.externalId,
      credentialsRef: parsed.data.credentialsRef,
      status: "PENDING", // verification is the only path to CONNECTED
      // Manual configuration never went through the provider
      // authorization flow — the onboarding lifecycle starts honest.
      onboardingState: "NOT_STARTED",
      onboardingActor: "NONE",
    });
    return { success: true, connection: toView(created) };
  } catch {
    return { success: false, message: "تعذر حفظ اتصال واتساب الآن" };
  }
}

/**
 * READ-ONLY verification of the actor's connection (ADMIN only, own
 * Business). Proves the stored provider identity is real and the
 * credential reference is usable — WITHOUT sending any WhatsApp
 * message. On success the connection becomes CONNECTED + active; on
 * failure it stays/becomes PENDING (configured, not verified).
 */
export async function verifyConnection(
  deps: WhatsAppConnectionServiceDeps,
  actor: WhatsAppConnectionActor,
  connectionId: string,
): Promise<WhatsAppVerificationResult> {
  const scope = resolveScope(actor);
  if (!scope.ok)
    return {
      success: false,
      message: scope.message,
      verificationCode: "INVALID_CONNECTION",
    };

  const connection =
    await deps.whatsappConnectionRepository.findByIdWithinBusiness(
      connectionId,
      scope.businessId,
    );
  if (!connection)
    return {
      success: false,
      message: NOT_FOUND_MESSAGE,
      verificationCode: "INVALID_CONNECTION",
    };

  if (!connection.isActive || connection.status === "DISCONNECTED") {
    return {
      success: false,
      message: "الاتصال غير مفعّل — أعد تفعيله قبل التحقق",
      verificationCode: "INVALID_CONNECTION",
    };
  }
  if (!connection.externalId) {
    return {
      success: false,
      message: "معرّف رقم واتساب غير مُهيأ لهذا الاتصال",
      verificationCode: "INVALID_CONNECTION",
    };
  }

  const result: ConnectionVerificationResult = await deps.verifier.verify({
    externalId: connection.externalId,
    credentialsRef: connection.credentialsRef,
  });

  if (!result.ok) {
    // Keep the row configured-but-unverified; never silently CONNECT.
    if (connection.status === "CONNECTED") {
      await deps.whatsappConnectionRepository.update(
        connectionId,
        scope.businessId,
        { status: "PENDING" },
      );
    }
    return {
      success: false,
      message: result.message,
      verificationCode: result.code,
    };
  }

  const verified = await deps.whatsappConnectionRepository.update(
    connectionId,
    scope.businessId,
    { status: "CONNECTED", isActive: true },
  );
  if (!verified)
    return {
      success: false,
      message: NOT_FOUND_MESSAGE,
      verificationCode: "INVALID_CONNECTION",
    };

  return { success: true, connection: toView(verified), verification: result };
}

/**
 * Disconnect the actor's connection (ADMIN only, own Business): the
 * connection row is RETAINED (configuration preserved) but deactivated —
 * `resolveConnectionForSend` and inbound gating refuse it until it is
 * reactivated and re-verified.
 */
export async function disconnectConnection(
  deps: WhatsAppConnectionServiceDeps,
  actor: WhatsAppConnectionActor,
  connectionId: string,
): Promise<WhatsAppConnectionActionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const connection =
    await deps.whatsappConnectionRepository.findByIdWithinBusiness(
      connectionId,
      scope.businessId,
    );
  if (!connection) return { success: false, message: NOT_FOUND_MESSAGE };

  const updated = await deps.whatsappConnectionRepository.update(
    connectionId,
    scope.businessId,
    { status: "DISCONNECTED", isActive: false },
  );
  if (!updated) return { success: false, message: NOT_FOUND_MESSAGE };
  return { success: true, connection: toView(updated) };
}

/**
 * Reactivate a disconnected connection (ADMIN only, own Business). It
 * returns to PENDING — verification is required again before it can
 * send or receive (a stale credential must never be trusted).
 */
export async function reactivateConnection(
  deps: WhatsAppConnectionServiceDeps,
  actor: WhatsAppConnectionActor,
  connectionId: string,
): Promise<WhatsAppConnectionActionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const connection =
    await deps.whatsappConnectionRepository.findByIdWithinBusiness(
      connectionId,
      scope.businessId,
    );
  if (!connection) return { success: false, message: NOT_FOUND_MESSAGE };

  const updated = await deps.whatsappConnectionRepository.update(
    connectionId,
    scope.businessId,
    { status: "PENDING", isActive: true },
  );
  if (!updated) return { success: false, message: NOT_FOUND_MESSAGE };
  return { success: true, connection: toView(updated) };
}

/** Production dependencies (app singletons + the Meta verifier). */
export function defaultWhatsAppConnectionServiceDeps(
  verifier: ConnectionVerifier,
): WhatsAppConnectionServiceDeps {
  return {
    whatsappConnectionRepository: whatsAppConnectionRepository,
    verifier,
  };
}
