/**
 * Platform Business onboarding read model (WHATSAPP-ONBOARDING-01).
 *
 * The FIRST Super Admin operational read surface: a read-only,
 * explicitly-projected view of Business onboarding + WhatsApp
 * connection state. Platform-operator guarded, server-derived targets,
 * Business-scoped repository methods, and NO DB-row spreading into the
 * UI — `toOverview()` is the only thing that shapes the data.
 *
 * Rules (AGENT_RULES / DECISIONS #22 / #31 / #47):
 * - The operator sees operational DETAIL but never SECRETS: no
 *   `credentialsRef` value, no token, no authorization code, no raw
 *   provider response — the projection structurally cannot carry them.
 * - Meta provenance is reference-only: provider ids are masked and
 *   never authorize anything.
 * - READ-ONLY: no platform write action exists here.
 * - Drill-down targets are validated (`uuidSchema`) and re-resolved
 *   server-side; an arbitrary id from a link is never trusted raw.
 */

import type { User } from "@/generated/prisma/client";

import {
  platformBusinessIdentitySchema,
  platformListBusinessInputSchema,
} from "@/features/platform/schemas/platform-schema";
import type {
  BusinessOnboardingListItem,
  BusinessOnboardingOverview,
  GetBusinessOnboardingOverviewSuccess,
  ListBusinessOnboardingSuccess,
  PlatformActor,
  PlatformErrorCode,
  PlatformServiceResult,
} from "@/features/platform/types";
import { maskExternalId, maskPhoneNumber } from "@/lib/whatsapp-identity";
import type {
  BusinessRepository,
  UserRepository,
  WhatsAppConnectionRepository,
} from "@/server/repositories";
import {
  businessRepository,
  userRepository,
  whatsAppConnectionRepository,
} from "@/server/repositories";
import type { Business, WhatsAppConnection } from "@/types/domain";

type Failure = {
  success: false;
  error: { code: PlatformErrorCode; message: string };
};

function failure(code: PlatformErrorCode, message: string): Failure {
  return { success: false, error: { code, message } };
}

/** Narrow repository surface (injectable). */
export type BusinessOnboardingServiceDeps = Readonly<{
  businesses: Pick<
    BusinessRepository,
    "listForPlatform" | "countForPlatform" | "findById"
  >;
  connections: Pick<
    WhatsAppConnectionRepository,
    "listByBusinessIds" | "findPrimaryByBusiness"
  >;
  users: Pick<UserRepository, "findAdminsByBusinesses" | "findAdminByBusiness">;
}>;

const defaultDeps: BusinessOnboardingServiceDeps = {
  businesses: businessRepository,
  connections: whatsAppConnectionRepository,
  users: userRepository,
};

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

/** Platform Operator gate — server-derived from the persisted user. */
function platformOnly(actor: PlatformActor): Failure | null {
  if (actor.accountType !== "PLATFORM") {
    return failure("FORBIDDEN", "هذه الصلاحية متاحة لمشغل المنصة فقط");
  }
  return null;
}

/**
 * THE projection — the single place a Business + its connection become
 * an operator view. Every field below is non-secret by construction;
 * adding a secret-bearing field here is a review error by design.
 */
export function toOverview(
  business: Business,
  connection: WhatsAppConnection | null,
  admin: Pick<User, "name" | "email"> | null,
): BusinessOnboardingOverview {
  return {
    business: {
      businessId: business.id,
      displayName: business.name,
      adminName: admin?.name ?? null,
      adminEmail: admin?.email ?? null,
      isActive: business.isActive,
      onboardingCompletedAt: iso(business.onboardingCompletedAt),
      createdAt: business.createdAt.toISOString(),
    },
    whatsapp: {
      connectionExists: connection !== null,
      connectionId: connection?.id ?? null,
      provider: connection?.provider ?? null,
      displayPhoneMasked: maskPhoneNumber(
        connection?.displayPhoneNumber ?? connection?.phoneNumber ?? null,
      ),
      externalIdMasked: maskExternalId(connection?.externalId ?? null),
      operationalStatus: connection?.status ?? null,
      isActive: connection?.isActive ?? null,
      // The reference VALUE is intentionally absent — only its grammar.
      credentialKind: connection?.credentialKind ?? null,
    },
    metaProvenance: {
      metaBusinessId: connection?.metaBusinessId ?? null,
      wabaId: connection?.wabaId ?? null,
      displayPhoneNumber: connection?.displayPhoneNumber ?? null,
      verifiedName: connection?.verifiedName ?? null,
      metaReviewStatus: connection?.metaReviewStatus ?? null,
    },
    onboarding: {
      onboardingState: connection?.onboardingState ?? "NOT_STARTED",
      onboardingActor: connection?.onboardingActor ?? "NONE",
      onboardingReasonCode: connection?.onboardingReasonCode ?? null,
      onboardingReasonSummary: connection?.onboardingReasonSummary ?? null,
      onboardingRetryable: connection?.onboardingRetryable ?? null,
      onboardingStateChangedAt: iso(connection?.onboardingStateChangedAt),
      onboardingCompletedAt: iso(connection?.onboardingCompletedAt),
      onboardingFailedAt: iso(connection?.onboardingFailedAt),
    },
    operations: {
      // Existing conventions: `status` is the last verification outcome
      // and `updatedAt` the last verification time (DECISIONS #47).
      lastVerificationResult: connection?.status ?? null,
      lastVerificationAt: connection ? iso(connection.updatedAt) : null,
      lastProvisioningSignalAt:
        iso(connection?.onboardingFailedAt) ??
        iso(connection?.onboardingStateChangedAt),
      operationRef: connection?.id ?? null,
    },
  };
}

function toListItem(
  overview: BusinessOnboardingOverview,
  connection: WhatsAppConnection | null,
): BusinessOnboardingListItem {
  return {
    business: overview.business,
    connectionExists: overview.whatsapp.connectionExists,
    provider: overview.whatsapp.provider,
    displayPhoneMasked: overview.whatsapp.displayPhoneMasked,
    operationalStatus: overview.whatsapp.operationalStatus,
    whatsappIsActive: overview.whatsapp.isActive,
    onboardingState: overview.onboarding.onboardingState,
    onboardingReasonSummary: overview.onboarding.onboardingReasonSummary,
    onboardingRetryable: overview.onboarding.onboardingRetryable,
    onboardingCompletedAt: overview.onboarding.onboardingCompletedAt,
    ...(connection ? {} : {}),
  };
}

/**
 * Read-only platform Business list for `/platform/businesses`.
 * Platform Operator only; the targets are server-derived; pagination +
 * search are validated before reaching the repository.
 */
export async function listBusinessOnboardingOverviews(
  actor: PlatformActor,
  input: unknown,
  deps: BusinessOnboardingServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<ListBusinessOnboardingSuccess>> {
  const forbidden = platformOnly(actor);
  if (forbidden) return forbidden;

  const parsed = platformListBusinessInputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return failure(
      "INVALID_INPUT",
      parsed.error.issues[0]?.message ?? "بيانات القائمة غير صالحة",
    );
  }

  const limit = parsed.data.pageSize;
  const offset = (parsed.data.page - 1) * parsed.data.pageSize;

  let businesses: Business[];
  let total: number;
  try {
    [businesses, total] = await Promise.all([
      deps.businesses.listForPlatform({
        search: parsed.data.search,
        limit,
        offset,
      }),
      deps.businesses.countForPlatform({ search: parsed.data.search }),
    ]);
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر تحميل المنشآت الآن");
  }

  if (businesses.length === 0) {
    return { success: true, data: { items: [], total, ...parsed.data } };
  }

  const businessIds = businesses.map((business) => business.id);
  const [connections, admins] = await Promise.all([
    deps.connections.listByBusinessIds(businessIds),
    deps.users.findAdminsByBusinesses(businessIds),
  ]);
  const connectionByBusiness = new Map(
    connections.map((connection) => [connection.businessId, connection]),
  );
  const adminByBusiness = new Map(
    admins.map((admin) => [admin.businessId, admin]),
  );

  const items = businesses.map((business) => {
    const connection = connectionByBusiness.get(business.id) ?? null;
    const overview = toOverview(
      business,
      connection,
      adminByBusiness.get(business.id) ?? null,
    );
    return toListItem(overview, connection);
  });

  return { success: true, data: { items, total, ...parsed.data } };
}

/**
 * Read-only drill-down for one Business. The id is validated and
 * re-resolved server-side — an arbitrary id from a link that matches no
 * Business is `BUSINESS_NOT_FOUND`, never a leak of its non-existence
 * beyond that.
 */
export async function getBusinessOnboardingOverview(
  actor: PlatformActor,
  businessId: string,
  deps: BusinessOnboardingServiceDeps = defaultDeps,
): Promise<PlatformServiceResult<GetBusinessOnboardingOverviewSuccess>> {
  const forbidden = platformOnly(actor);
  if (forbidden) return forbidden;

  const parsed = platformBusinessIdentitySchema.safeParse({ businessId });
  if (!parsed.success) {
    return failure("INVALID_INPUT", "معرّف المنشأة غير صالح");
  }

  let business: Business | null;
  try {
    business = await deps.businesses.findById(parsed.data.businessId);
  } catch {
    return failure("PERSISTENCE_FAILED", "تعذر تحميل المنشأة الآن");
  }
  if (!business) {
    return failure("BUSINESS_NOT_FOUND", "تعذر العثور على المنشأة");
  }

  const [connection, admin] = await Promise.all([
    deps.connections.findPrimaryByBusiness(business.id),
    deps.users.findAdminByBusiness(business.id),
  ]);

  return {
    success: true,
    data: {
      overview: toOverview(business, connection, admin),
    },
  };
}
