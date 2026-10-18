import type {
  CreateAppointmentDto,
  ListAppointmentsDto,
  UpdateAppointmentDto,
} from "@/lib/validation";
import { paginationSchema, paginationToSkipTake } from "@/lib/validation";
import { db } from "@/server/db";
import type {
  Appointment,
  AppointmentStatus,
  AppointmentWithRelations,
} from "@/types/domain";

const notDeleted = { deletedAt: null } as const;

/**
 * Booking concurrency (DECISIONS #34, PROMPT-ARCH-02): conflict-checked
 * writes run in SERIALIZABLE transactions with a bounded retry loop.
 * Under SSI, two concurrent transactions that both pass the overlap
 * count and both insert the same slot CANNOT both commit — one aborts
 * (Prisma P2034) and the retry re-evaluates the conflict check against
 * the now-committed row (a real conflict → typed null result; a rare
 * false-positive abort → the retry succeeds). This preserves the exact
 * existing conflict rule — including its asymmetric staff/unassigned
 * scoping — which is NOT expressible as a symmetric DB exclusion
 * constraint; serializability IS the invariant here.
 */
const SERIALIZABLE_ATTEMPTS = 3;

/** Prisma P2034 — serialization failure / deadlock in a transaction. */
function isTransactionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2034"
  );
}

/**
 * Runs a conflict-checked write with serializable semantics. Exhausted
 * retries surface as a typed conflict (null) — the honest, rare
 * worst-case is a user-visible SLOT_CONFLICT that a manual retry
 * resolves.
 */
async function withSerializableRetry<T>(
  operation: () => Promise<T>,
): Promise<T | null> {
  for (let attempt = 1; attempt <= SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      if (attempt === SERIALIZABLE_ATTEMPTS) return null;
    }
  }
  return null;
}

/** "YYYY-MM-DD" → UTC midnight Date (matches Prisma @db.Date). */
function toDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** "HH:mm" or "HH:mm:ss" → epoch-based time value (matches @db.Time). */
function toTime(time: string): Date {
  const withSeconds = time.length === 5 ? `${time}:00` : time;
  return new Date(`1970-01-01T${withSeconds}.000Z`);
}

/** Epoch-based `@db.Time` value → business-local "HH:mm". */
function toWallClock(time: Date): string {
  return time.toISOString().slice(11, 16);
}

function appointmentRange(input: ListAppointmentsDto) {
  return {
    ...(input.fromDate || input.toDate
      ? {
          date: {
            ...(input.fromDate ? { gte: toDate(input.fromDate) } : {}),
            ...(input.toDate ? { lte: toDate(input.toDate) } : {}),
          },
        }
      : {}),
  };
}

export class AppointmentRepository {
  private readonly client: typeof db;

  constructor(client: typeof db = db) {
    this.client = client;
  }

  async findById(id: string): Promise<Appointment | null> {
    return (this.client ?? db).appointment.findFirst({
      where: { id, ...notDeleted },
    });
  }

  /** Agenda view — customer + service projections preloaded. */
  async findWithRelations(
    id: string,
  ): Promise<AppointmentWithRelations | null> {
    return db.appointment.findFirst({
      where: { id, ...notDeleted },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
        provider: {
          select: { id: true, name: true, displayName: true },
        },
      },
    });
  }

  async findWithRelationsByBusiness(
    id: string,
    businessId: string,
  ): Promise<AppointmentWithRelations | null> {
    return db.appointment.findFirst({
      where: { id, businessId, ...notDeleted },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
        provider: {
          select: { id: true, name: true, displayName: true },
        },
      },
    });
  }

  async list(
    input: ListAppointmentsDto,
    rawPagination?: unknown,
  ): Promise<AppointmentWithRelations[]> {
    const pagination = paginationSchema.parse(rawPagination ?? {});
    return db.appointment.findMany({
      where: {
        businessId: input.businessId,
        ...notDeleted,
        ...appointmentRange(input),
        ...(input.status ? { status: input.status } : {}),
        ...(input.customerId ? { customerId: input.customerId } : {}),
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
        provider: {
          select: { id: true, name: true, displayName: true },
        },
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }],
      ...paginationToSkipTake(pagination),
    });
  }

  async listAgenda(businessId: string, date: string) {
    return db.appointment.findMany({
      where: { businessId, date: toDate(date), ...notDeleted },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
        provider: {
          select: { id: true, name: true, displayName: true },
        },
      },
      orderBy: { startTime: "asc" },
      take: 100,
    });
  }

  async searchAppointments(
    businessId: string,
    query: string,
    limit = 20,
  ): Promise<AppointmentWithRelations[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return db.appointment.findMany({
        where: { businessId, ...notDeleted },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          service: {
            select: { id: true, name: true, durationMinutes: true },
          },
          provider: {
            select: { id: true, name: true, displayName: true },
          },
        },
        orderBy: [{ date: "desc" }, { startTime: "desc" }],
        take: limit,
      });
    }

    return (this.client ?? db).appointment.findMany({
      where: {
        businessId,
        ...notDeleted,
        OR: [
          { customer: { name: { contains: trimmed, mode: "insensitive" } } },
          { customer: { phone: { contains: trimmed } } },
          { notes: { contains: trimmed, mode: "insensitive" } },
        ],
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
        provider: {
          select: { id: true, name: true, displayName: true },
        },
      },
      orderBy: [{ date: "desc" }, { startTime: "desc" }],
      take: limit,
    });
  }

  async getDashboardSummary(businessId: string, date: string) {
    const appointmentDate = toDate(date);
    const [agenda, pendingCount, confirmedCount] = await db.$transaction([
      db.appointment.findMany({
        where: {
          businessId,
          date: appointmentDate,
          ...notDeleted,
          status: { in: ["PENDING", "CONFIRMED"] },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          service: {
            select: { id: true, name: true, durationMinutes: true },
          },
        },
        orderBy: { startTime: "asc" },
        take: 12,
      }),
      db.appointment.count({
        where: {
          businessId,
          date: appointmentDate,
          ...notDeleted,
          status: "PENDING",
        },
      }),
      db.appointment.count({
        where: {
          businessId,
          date: appointmentDate,
          ...notDeleted,
          status: "CONFIRMED",
        },
      }),
    ]);

    return { agenda, pendingCount, confirmedCount };
  }

  async listRecentByCustomer(businessId: string, customerId: string, take = 3) {
    return db.appointment.findMany({
      where: { businessId, customerId, ...notDeleted },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        service: {
          select: { id: true, name: true, durationMinutes: true },
        },
      },
      orderBy: [{ date: "desc" }, { startTime: "desc" }],
      take,
    });
  }

  /**
   * Latest appointment per customer for context rows (staff workspace
   * queue). One business-scoped read; callers pick the first row per
   * customer (already ordered newest-first).
   */
  async listLatestByCustomers(businessId: string, customerIds: string[]) {
    if (customerIds.length === 0) return [];
    return db.appointment.findMany({
      where: { businessId, customerId: { in: customerIds }, ...notDeleted },
      include: { service: { select: { id: true, name: true } } },
      orderBy: [{ date: "desc" }, { startTime: "desc" }],
    });
  }

  async create(input: CreateAppointmentDto): Promise<Appointment> {
    const {
      date,
      startTime,
      endTime,
      assignedUserId,
      providerId,
      notes,
      ...rest
    } = input;
    return db.appointment.create({
      data: {
        ...rest,
        date: toDate(date),
        startTime: toTime(startTime),
        endTime: toTime(endTime),
        ...(assignedUserId != null ? { assignedUserId } : {}),
        ...(providerId != null ? { providerId } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
    });
  }

  /**
   * Conflict-checked create — SERIALIZABLE + retry (PROMPT-ARCH-02).
   * Returns the appointment, or null when the slot is (or became)
   * taken. `branchId` is part of the DTO and is written as-is — callers
   * resolve it SERVER-side (never client input).
   */
  async createWithConflictCheck(
    input: CreateAppointmentDto,
  ): Promise<Appointment | null> {
    const {
      date,
      startTime,
      endTime,
      assignedUserId,
      providerId,
      notes,
      ...rest
    } = input;
    return withSerializableRetry(() =>
      db.$transaction(
        async (tx) => {
          const conflict = await tx.appointment.count({
            where: {
              businessId: input.businessId,
              ...notDeleted,
              date: toDate(date),
              status: { in: ["PENDING", "CONFIRMED"] },
              ...(providerId || assignedUserId
                ? {
                    OR: [
                      ...(providerId ? [{ providerId }] : []),
                      ...(assignedUserId ? [{ assignedUserId }] : []),
                      { providerId: null, assignedUserId: null },
                    ],
                  }
                : {}),
              startTime: { lt: toTime(endTime) },
              endTime: { gt: toTime(startTime) },
            },
          });
          if (conflict > 0) return null;

          const appointment = await tx.appointment.create({
            data: {
              ...rest,
              date: toDate(date),
              startTime: toTime(startTime),
              endTime: toTime(endTime),
              ...(assignedUserId != null ? { assignedUserId } : {}),
              ...(providerId != null ? { providerId } : {}),
              ...(notes !== undefined ? { notes } : {}),
            },
          });
          await tx.customer.update({
            where: { id: input.customerId },
            data: { lastAppointmentAt: new Date() },
          });
          return appointment;
        },
        { isolationLevel: "Serializable" },
      ),
    );
  }

  async update(id: string, input: UpdateAppointmentDto): Promise<Appointment> {
    const {
      date,
      startTime,
      endTime,
      assignedUserId,
      providerId,
      notes,
      ...rest
    } = input;
    return db.appointment.update({
      where: { id },
      data: {
        ...rest,
        ...(date !== undefined ? { date: toDate(date) } : {}),
        ...(startTime !== undefined ? { startTime: toTime(startTime) } : {}),
        ...(endTime !== undefined ? { endTime: toTime(endTime) } : {}),
        ...(assignedUserId !== undefined ? { assignedUserId } : {}),
        ...(providerId !== undefined ? { providerId } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
    });
  }

  /**
   * Conflict-checked reschedule — SERIALIZABLE + retry
   * (PROMPT-ARCH-02). Same semantics as create: null = the new slot is
   * (or became) taken.
   */
  async rescheduleWithConflictCheck(
    id: string,
    input: { date: string; startTime: string; endTime: string },
  ): Promise<Appointment | null> {
    return withSerializableRetry(() =>
      db.$transaction(
        async (tx) => {
          const appointment = await tx.appointment.findFirst({
            where: { id, ...notDeleted },
          });
          if (!appointment) return null;
          const conflict = await tx.appointment.count({
            where: {
              businessId: appointment.businessId,
              ...notDeleted,
              id: { not: id },
              date: toDate(input.date),
              status: { in: ["PENDING", "CONFIRMED"] },
              ...(appointment.providerId || appointment.assignedUserId
                ? {
                    OR: [
                      ...(appointment.providerId
                        ? [{ providerId: appointment.providerId }]
                        : []),
                      ...(appointment.assignedUserId
                        ? [{ assignedUserId: appointment.assignedUserId }]
                        : []),
                      { providerId: null, assignedUserId: null },
                    ],
                  }
                : {}),
              startTime: { lt: toTime(input.endTime) },
              endTime: { gt: toTime(input.startTime) },
            },
          });
          if (conflict > 0) return null;

          return tx.appointment.update({
            where: { id },
            data: {
              date: toDate(input.date),
              startTime: toTime(input.startTime),
              endTime: toTime(input.endTime),
            },
          });
        },
        { isolationLevel: "Serializable" },
      ),
    );
  }

  async setStatus(id: string, status: AppointmentStatus) {
    return db.appointment.update({ where: { id }, data: { status } });
  }

  /**
   * Blocking appointments for availability (PROMPT-10): same business,
   * same date, not soft-deleted, PENDING/CONFIRMED — the exact rule
   * `hasConflict`/`createWithConflictCheck` enforce for writes. Only
   * the time interval is returned, as business-local "HH:mm" strings
   * (epoch-based `@db.Time` values converted the same way the agenda
   * serializer derives wall-clock times).
   *
   * `excludeAppointmentId` (B-08): the appointment currently being
   * rescheduled must not block its OWN slot. The write path
   * (`rescheduleWithConflictCheck`) already excludes itself with
   * `id: { not: id }`; this is the READ counterpart so availability
   * guidance shows the appointment's own current slot as free while
   * every OTHER appointment still blocks normally. The id is a
   * server-derived row identity (the action resolved the appointment
   * against the actor's own Business BEFORE calling), never a
   * client-supplied value — a foreign tenant's id simply matches no
   * row here, so it cannot widen availability across tenants.
   */
  async listBlockingForDate(
    businessId: string,
    date: string,
    excludeAppointmentId?: string,
  ): Promise<Array<{ startTime: string; endTime: string }>> {
    const rows = await db.appointment.findMany({
      where: {
        businessId,
        ...notDeleted,
        date: toDate(date),
        status: { in: ["PENDING", "CONFIRMED"] as AppointmentStatus[] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      select: { startTime: true, endTime: true },
      orderBy: { startTime: "asc" },
      take: 200,
    });
    return rows.map((row) => ({
      startTime: toWallClock(row.startTime),
      endTime: toWallClock(row.endTime),
    }));
  }

  /**
   * Blocking appointments for provider-scoped availability
   * (PROMPT-CORE-02): the read counterpart of the write path's existing
   * assignee scoping (`hasConflict` / `createWithConflictCheck`) — the
   * SAME PENDING/CONFIRMED, same-date, non-deleted rule, restricted to
   * the given assignees (a Provider's calendar is blocked only by its
   * own appointments). ONE batched business-scoped read; callers group
   * the rows by assignedUserId in application memory.
   */
  async listBlockingByAssignees(
    businessId: string,
    date: string,
    assignedUserIds: string[],
    excludeAppointmentId?: string,
  ): Promise<
    Array<{ assignedUserId: string; startTime: string; endTime: string }>
  > {
    if (assignedUserIds.length === 0) return [];
    const rows = await db.appointment.findMany({
      where: {
        businessId,
        ...notDeleted,
        date: toDate(date),
        status: { in: ["PENDING", "CONFIRMED"] as AppointmentStatus[] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        OR: [
          { providerId: { in: assignedUserIds } },
          { assignedUserId: { in: assignedUserIds } },
          { providerId: null, assignedUserId: null },
        ],
      },
      select: {
        providerId: true,
        assignedUserId: true,
        startTime: true,
        endTime: true,
      },
      orderBy: { startTime: "asc" },
      take: 200,
    });
    const result: Array<{
      assignedUserId: string;
      startTime: string;
      endTime: string;
    }> = [];
    for (const row of rows) {
      const startTime = toWallClock(row.startTime);
      const endTime = toWallClock(row.endTime);
      let matched = false;
      if (row.providerId && assignedUserIds.includes(row.providerId)) {
        result.push({
          assignedUserId: row.providerId,
          startTime,
          endTime,
        });
        matched = true;
      }
      if (
        row.assignedUserId &&
        assignedUserIds.includes(row.assignedUserId) &&
        row.assignedUserId !== row.providerId
      ) {
        result.push({
          assignedUserId: row.assignedUserId,
          startTime,
          endTime,
        });
        matched = true;
      }
      if (!matched && !row.providerId && !row.assignedUserId) {
        // Legacy unassigned appointment: conservative blocking policy
        // blocks all queried assignees for this slot.
        for (const assigneeId of assignedUserIds) {
          result.push({
            assignedUserId: assigneeId,
            startTime,
            endTime,
          });
        }
      }
    }
    return result;
  }

  /**
   * Blocking appointments for provider-scoped availability (STAFF-PROVIDER-01).
   * Direct providerId counterpart of listBlockingByAssignees.
   */
  async listBlockingByProviders(
    businessId: string,
    date: string,
    providerIds: string[],
    excludeAppointmentId?: string,
  ): Promise<
    Array<{ providerId: string; startTime: string; endTime: string }>
  > {
    const blocking = await this.listBlockingByAssignees(
      businessId,
      date,
      providerIds,
      excludeAppointmentId,
    );
    return blocking.map((b) => ({
      providerId: b.assignedUserId,
      startTime: b.startTime,
      endTime: b.endTime,
    }));
  }

  /** Overlap check for a staff member or provider (or the whole business when unassigned). */
  async hasConflict(params: {
    businessId: string;
    date: string;
    startTime: string;
    endTime: string;
    providerId?: string | null;
    assignedUserId?: string | null;
    excludeAppointmentId?: string;
  }): Promise<boolean> {
    const count = await db.appointment.count({
      where: {
        businessId: params.businessId,
        ...notDeleted,
        date: toDate(params.date),
        status: {
          in: ["PENDING", "CONFIRMED"] as AppointmentStatus[],
        },
        ...(params.providerId || params.assignedUserId
          ? {
              OR: [
                ...(params.providerId
                  ? [{ providerId: params.providerId }]
                  : []),
                ...(params.assignedUserId
                  ? [{ assignedUserId: params.assignedUserId }]
                  : []),
                { providerId: null, assignedUserId: null },
              ],
            }
          : {}),
        ...(params.excludeAppointmentId
          ? { id: { not: params.excludeAppointmentId } }
          : {}),
        startTime: { lt: toTime(params.endTime) },
        endTime: { gt: toTime(params.startTime) },
      },
    });
    return count > 0;
  }

  async softDelete(id: string): Promise<Appointment> {
    return db.appointment.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async restore(id: string): Promise<Appointment> {
    return db.appointment.update({ where: { id }, data: { deletedAt: null } });
  }
}
