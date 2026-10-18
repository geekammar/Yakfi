/**
 * Smart Create Appointment flow reads (PROMPT-11 — Steps 1–3).
 *
 * Focused, tenant-scoped reads for the booking wizard:
 * - `searchBookingCustomers` — Step 1 (العميل): search by name or phone
 *   through the EXISTING `CustomerRepository.listByBusiness` search
 *   primitive (name OR phone substring, soft-deletes excluded). An
 *   empty query returns the most recent customers instead of searching.
 * - `listBookingServices` — Step 2 (الخدمة): active services only —
 *   the same rule every booking path enforces (inactive services are
 *   not selectable).
 *
 * The Business is ALWAYS the actor's own, derived from the
 * authenticated session — client input never carries or overrides it.
 * Repository collaborators are injectable (defaulting to the app
 * singletons) so the workflow logic can be verified without a live
 * database — the established invitations/services/availability pattern.
 */

import {
  bookingContextSchema,
  bookingCustomerSearchSchema,
} from "@/features/appointments/schemas/booking-flow-schema";
import type {
  BookingContextPrefill,
  BookingCustomerOption,
  BookingCustomerSearchResult,
  BookingFlowScreen,
  BookingServiceOption,
} from "@/features/appointments/types";
import type {
  CustomerRepository,
  ProviderRepository,
  ServiceRepository,
} from "@/server/repositories";
import {
  customerRepository,
  providerRepository,
  serviceRepository,
} from "@/server/repositories";
import type { UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type BookingFlowActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type BookingFlowServiceDeps = {
  customerRepository: Pick<CustomerRepository, "findById" | "listByBusiness">;
  serviceRepository: Pick<ServiceRepository, "findById" | "listByBusiness">;
  providerRepository?: Pick<ProviderRepository, "listEligibleForService"> &
    Partial<
      Pick<
        ProviderRepository,
        "countEligiblePerService" | "findProfileWithinBusiness"
      >
    >;
};

/** Production dependencies (app singletons). */
export const defaultBookingFlowServiceDeps: BookingFlowServiceDeps = {
  customerRepository,
  serviceRepository,
  providerRepository,
};

const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const SEARCH_FAILED_MESSAGE = "تعذر البحث الآن، حاول مرة أخرى";

/** How many customers one search result page carries. */
const CUSTOMER_PAGE_SIZE = 20;

function toCustomerOption(customer: {
  id: string;
  name: string;
  phone: string;
}): BookingCustomerOption {
  return { id: customer.id, name: customer.name, phone: customer.phone };
}

function toServiceOption(service: {
  id: string;
  name: string;
  durationMinutes: number;
}): BookingServiceOption {
  return {
    id: service.id,
    name: service.name,
    durationMinutes: service.durationMinutes,
  };
}

/**
 * Step 1 — search the actor's Business customers by name or phone.
 * An empty (or whitespace-only) query lists the most recent customers.
 * Both ADMIN and STAFF may read (booking is a business operation).
 */
export async function searchBookingCustomers(
  deps: BookingFlowServiceDeps,
  actor: BookingFlowActor,
  input: unknown,
): Promise<BookingCustomerSearchResult> {
  const parsed = bookingCustomerSearchSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "نص البحث غير صالح",
    };
  }

  if (!actor.businessId) {
    return { success: false, message: NO_BUSINESS_MESSAGE };
  }

  try {
    const customers = await deps.customerRepository.listByBusiness(
      actor.businessId,
      {
        search: parsed.data.query || undefined,
        rawPagination: { pageSize: CUSTOMER_PAGE_SIZE },
      },
    );
    return { success: true, customers: customers.map(toCustomerOption) };
  } catch {
    return { success: false, message: SEARCH_FAILED_MESSAGE };
  }
}

/**
 * Step 2 — the actor's Business bookable services. Active services
 * only: inactive services are never selectable in a booking flow.
 * Batched resolution eliminates per-service N+1 queries.
 */
export async function listBookingServices(
  deps: BookingFlowServiceDeps,
  actor: BookingFlowActor,
): Promise<BookingServiceOption[] | { message: string }> {
  if (!actor.businessId) return { message: NO_BUSINESS_MESSAGE };
  try {
    const services = await deps.serviceRepository.listByBusiness(
      actor.businessId,
      { rawPagination: { pageSize: 100 } },
    );
    if (!deps.providerRepository) {
      return services.map(toServiceOption);
    }
    if (deps.providerRepository.countEligiblePerService) {
      const counts = await deps.providerRepository.countEligiblePerService(
        actor.businessId,
        services.map((s) => s.id),
      );
      return services.map((service) => {
        const count = counts.get(service.id) ?? 0;
        return {
          ...toServiceOption(service),
          eligibleProviderCount: count,
          readinessStatus:
            count > 0
              ? ("READY_TO_BOOK" as const)
              : ("SETUP_REQUIRED" as const),
        };
      });
    }
    const withEligibility = await Promise.all(
      services.map(async (service) => {
        const eligible = await deps.providerRepository!.listEligibleForService(
          actor.businessId!,
          service.id,
        );
        const count = eligible.length;
        return {
          ...toServiceOption(service),
          eligibleProviderCount: count,
          readinessStatus:
            count > 0
              ? ("READY_TO_BOOK" as const)
              : ("SETUP_REQUIRED" as const),
        };
      }),
    );
    return withEligibility;
  } catch {
    return { message: "تعذر تحميل الخدمات الآن، حاول مرة أخرى" };
  }
}

/**
 * Smart Context resolution (B-07 §A) — turn optional entry-context ids
 * (from a customer page, a service page, or a conversation) into the
 * wizard's prefilled selections, WITHOUT asking the user to re-enter
 * what the system already knows.
 *
 * The ids are NEVER trusted: a customer/service is only prefilled when
 * it belongs to the actor's OWN Business (cross-tenant ids are
 * indistinguishable from missing ones — the same rule every other read
 * path enforces) and a service must additionally be ACTIVE to be
 * bookable. An absent or foreign id yields `null`, and the wizard then
 * asks for that input normally — no fabricated selections, no
 * cross-tenant leak.
 */
export async function resolveBookingContext(
  deps: BookingFlowServiceDeps,
  actor: BookingFlowActor,
  input: unknown,
): Promise<BookingContextPrefill> {
  const parsed = bookingContextSchema.safeParse(input);
  if (!parsed.success || !actor.businessId) {
    return { customer: null, serviceId: null, providerId: null };
  }
  const [customer, service, provider] = await Promise.all([
    parsed.data.customerId
      ? deps.customerRepository.findById(parsed.data.customerId)
      : Promise.resolve(null),
    parsed.data.serviceId
      ? deps.serviceRepository.findById(parsed.data.serviceId)
      : Promise.resolve(null),
    parsed.data.providerId && deps.providerRepository?.findProfileWithinBusiness
      ? deps.providerRepository.findProfileWithinBusiness(
          parsed.data.providerId,
          actor.businessId,
        )
      : Promise.resolve(null),
  ]);
  return {
    customer:
      customer && customer.businessId === actor.businessId
        ? toCustomerOption(customer)
        : null,
    serviceId:
      service && service.businessId === actor.businessId && service.isActive
        ? service.id
        : null,
    providerId:
      provider && provider.businessId === actor.businessId && provider.isActive
        ? provider.id
        : null,
  };
}

/**
 * Which wizard screen a prefilled context opens on (B-07 §A). Pure
 * derivation over the resolved (server-trusted) prefill: a known
 * customer skips العميل; a known customer AND service skips to
 * التاريخ. A service alone never skips العميل — the customer is
 * still required, so the flow never starts past what it can honestly
 * fill.
 */
export function deriveInitialBookingScreen(
  prefill: BookingContextPrefill,
): BookingFlowScreen {
  if (prefill.customer && prefill.serviceId) return "date";
  if (prefill.customer) return "service";
  return "customer";
}
