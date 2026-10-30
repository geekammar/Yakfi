import { db } from "@/server/db";
import type {
  FollowUpRequest,
  FollowUpRequestStatus,
  FollowUpRequestWithRelations,
} from "@/types/domain";

const notDeleted = { deletedAt: null } as const;

const SERIALIZABLE_ATTEMPTS = 3;

function isTransactionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2034"
  );
}

async function withSerializableRetry<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      lastError = error;
      if (attempt === SERIALIZABLE_ATTEMPTS) throw error;
    }
  }
  throw lastError;
}

function toDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export type CancelFollowUpOutcome =
  | { outcome: "CANCELLED"; followUp: FollowUpRequest }
  | { outcome: "ALREADY_CANCELLED"; followUp: FollowUpRequest }
  | { outcome: "ALREADY_SCHEDULED"; followUp: FollowUpRequest }
  | { outcome: "NOT_FOUND" };

export type CreateFollowUpRequestData = {
  businessId: string;
  customerId: string;
  sourceAppointmentId?: string | null;
  serviceId?: string | null;
  preferredProviderId?: string | null;
  createdById?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  notes?: string | null;
};

export class FollowUpRequestRepository {
  constructor(private readonly prisma: typeof db = db) {}

  async create(data: CreateFollowUpRequestData): Promise<FollowUpRequest> {
    return this.prisma.followUpRequest.create({
      data: {
        businessId: data.businessId,
        customerId: data.customerId,
        sourceAppointmentId: data.sourceAppointmentId ?? null,
        serviceId: data.serviceId ?? null,
        preferredProviderId: data.preferredProviderId ?? null,
        createdById: data.createdById ?? null,
        startDate: data.startDate ? toDate(data.startDate) : null,
        endDate: data.endDate ? toDate(data.endDate) : null,
        notes: data.notes ?? null,
        status: "PENDING",
      },
    });
  }

  async findById(
    id: string,
    businessId: string,
  ): Promise<FollowUpRequestWithRelations | null> {
    return this.prisma.followUpRequest.findFirst({
      where: { id, businessId, ...notDeleted },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
        preferredProvider: {
          select: { id: true, name: true, displayName: true },
        },
        sourceAppointment: {
          select: { id: true, date: true, startTime: true, endTime: true },
        },
        scheduledAppointment: {
          select: {
            id: true,
            date: true,
            startTime: true,
            endTime: true,
            status: true,
          },
        },
      },
    });
  }

  async listByBusiness(
    businessId: string,
    options?: {
      status?: FollowUpRequestStatus;
      customerId?: string;
    },
  ): Promise<FollowUpRequestWithRelations[]> {
    return this.prisma.followUpRequest.findMany({
      where: {
        businessId,
        ...notDeleted,
        ...(options?.status ? { status: options.status } : {}),
        ...(options?.customerId ? { customerId: options.customerId } : {}),
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
        preferredProvider: {
          select: { id: true, name: true, displayName: true },
        },
        sourceAppointment: {
          select: { id: true, date: true, startTime: true, endTime: true },
        },
        scheduledAppointment: {
          select: {
            id: true,
            date: true,
            startTime: true,
            endTime: true,
            status: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    });
  }

  async listByCustomer(
    businessId: string,
    customerId: string,
  ): Promise<FollowUpRequestWithRelations[]> {
    return this.listByBusiness(businessId, { customerId });
  }

  async listBySourceAppointment(
    businessId: string,
    sourceAppointmentId: string,
  ): Promise<FollowUpRequestWithRelations[]> {
    return this.prisma.followUpRequest.findMany({
      where: {
        businessId,
        sourceAppointmentId,
        ...notDeleted,
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
        preferredProvider: {
          select: { id: true, name: true, displayName: true },
        },
        sourceAppointment: {
          select: { id: true, date: true, startTime: true, endTime: true },
        },
        scheduledAppointment: {
          select: {
            id: true,
            date: true,
            startTime: true,
            endTime: true,
            status: true,
          },
        },
      },
      orderBy: [{ createdAt: "desc" }],
    });
  }

  /**
   * Atomically transitions a follow-up request from PENDING to CANCELLED within the business boundary.
   * If the record is already CANCELLED, reconciles honestly as ALREADY_CANCELLED.
   * If the record is already SCHEDULED, refuses transition as ALREADY_SCHEDULED.
   * Never overwrites a SCHEDULED appointment or cross-tenant record.
   */
  async cancelPending(
    id: string,
    businessId: string,
  ): Promise<CancelFollowUpOutcome> {
    return withSerializableRetry(async () => {
      return (this.prisma as typeof db).$transaction(async (tx) => {
        const updateResult = await tx.followUpRequest.updateMany({
          where: {
            id,
            businessId,
            status: "PENDING",
            ...notDeleted,
          },
          data: {
            status: "CANCELLED",
          },
        });

        if (updateResult.count > 0) {
          const followUp = await tx.followUpRequest.findFirst({
            where: { id, businessId, ...notDeleted },
          });
          if (followUp) {
            return { outcome: "CANCELLED", followUp };
          }
        }

        const current = await tx.followUpRequest.findFirst({
          where: { id, businessId, ...notDeleted },
        });

        if (!current) {
          return { outcome: "NOT_FOUND" };
        }

        if (current.status === "CANCELLED") {
          return { outcome: "ALREADY_CANCELLED", followUp: current };
        }

        if (current.status === "SCHEDULED") {
          return { outcome: "ALREADY_SCHEDULED", followUp: current };
        }

        return { outcome: "NOT_FOUND" };
      });
    });
  }

  async updateStatus(
    id: string,
    businessId: string,
    status: FollowUpRequestStatus,
  ): Promise<FollowUpRequest | null> {
    const existing = await this.prisma.followUpRequest.findFirst({
      where: { id, businessId, ...notDeleted },
    });
    if (!existing) return null;
    if (existing.status === status) return existing;

    const result = await this.prisma.followUpRequest.updateMany({
      where: { id, businessId, status: existing.status, ...notDeleted },
      data: { status },
    });
    if (result.count === 0) return null;

    return this.prisma.followUpRequest.findFirst({
      where: { id, businessId, ...notDeleted },
    });
  }

  /**
   * Channel Readiness Contract (UX001-R5 Section 7):
   * Safely retrieves eligible pending follow-up requests for conversational
   * channels (WhatsApp / Telegram) without cross-tenant exposure or AI direct writes.
   */
  async getEligibleForChannel(
    businessId: string,
    customerId?: string,
  ): Promise<
    Array<{
      id: string;
      businessId: string;
      customerId: string;
      customerName: string;
      customerPhone: string;
      serviceId: string | null;
      serviceName: string | null;
      serviceDuration: number | null;
      preferredProviderId: string | null;
      preferredProviderName: string | null;
      startDate: string | null;
      endDate: string | null;
      status: FollowUpRequestStatus;
      isEligible: boolean;
    }>
  > {
    const requests = await this.prisma.followUpRequest.findMany({
      where: {
        businessId,
        status: "PENDING",
        ...notDeleted,
        ...(customerId ? { customerId } : {}),
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: { select: { id: true, name: true, durationMinutes: true } },
        preferredProvider: {
          select: { id: true, name: true, displayName: true },
        },
      },
      orderBy: [{ createdAt: "asc" }],
    });

    const todayStr = new Date().toISOString().slice(0, 10);

    return requests.map((req) => {
      const startStr = req.startDate
        ? req.startDate instanceof Date
          ? req.startDate.toISOString().slice(0, 10)
          : String(req.startDate).slice(0, 10)
        : null;
      const endStr = req.endDate
        ? req.endDate instanceof Date
          ? req.endDate.toISOString().slice(0, 10)
          : String(req.endDate).slice(0, 10)
        : null;
      // An undated request is always bookable; a dated request is eligible if endDate >= today
      const isEligible = !endStr || endStr >= todayStr;

      return {
        id: req.id,
        businessId: req.businessId,
        customerId: req.customerId,
        customerName: req.customer.name,
        customerPhone: req.customer.phone,
        serviceId: req.service?.id ?? null,
        serviceName: req.service?.name ?? null,
        serviceDuration: req.service?.durationMinutes ?? null,
        preferredProviderId: req.preferredProvider?.id ?? null,
        preferredProviderName:
          req.preferredProvider?.displayName ||
          req.preferredProvider?.name ||
          null,
        startDate: startStr,
        endDate: endStr,
        status: req.status,
        isEligible,
      };
    });
  }
}

export const followUpRequestRepository = new FollowUpRequestRepository();
