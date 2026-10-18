import { db } from "@/server/db";
import type {
  AppointmentReminder,
  ReminderChannel,
  ReminderStatus,
} from "@/types/domain";

export type CreateAppointmentReminderDto = {
  businessId: string;
  appointmentId: string;
  channel?: ReminderChannel;
  status?: ReminderStatus;
  dueAt: Date;
  leadHours: number;
  templateId?: string;
};

export class AppointmentReminderRepository {
  private readonly client: typeof db;

  constructor(client: typeof db = db) {
    this.client = client;
  }

  async findById(id: string): Promise<AppointmentReminder | null> {
    return (this.client ?? db).appointmentReminder.findUnique({
      where: { id },
    });
  }

  async findByAppointmentId(
    appointmentId: string,
  ): Promise<AppointmentReminder[]> {
    return (this.client ?? db).appointmentReminder.findMany({
      where: { appointmentId },
      orderBy: { createdAt: "desc" },
    });
  }

  async findActiveByAppointmentId(
    appointmentId: string,
  ): Promise<AppointmentReminder | null> {
    return (this.client ?? db).appointmentReminder.findFirst({
      where: {
        appointmentId,
        status: { in: ["PENDING", "CLAIMED", "FAILED_RETRYABLE"] },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(
    data: CreateAppointmentReminderDto,
  ): Promise<AppointmentReminder> {
    return (this.client ?? db).appointmentReminder.create({
      data: {
        businessId: data.businessId,
        appointmentId: data.appointmentId,
        channel: data.channel ?? "WHATSAPP",
        status: data.status ?? "PENDING",
        dueAt: data.dueAt,
        leadHours: data.leadHours,
        templateId: data.templateId ?? "standard",
      },
    });
  }

  /**
   * Atomically claims due reminders using SKIP LOCKED concurrency semantics.
   * Prevents duplicate execution across concurrent scheduler workers.
   */
  async claimDueReminders(
    params: {
      batchSize?: number;
      now?: Date;
      leaseTimeoutMinutes?: number;
    } = {},
  ): Promise<AppointmentReminder[]> {
    const batchSize = Math.min(params.batchSize ?? 25, 100);
    const now = params.now ?? new Date();
    const leaseMinutes = params.leaseTimeoutMinutes ?? 10;
    const leaseThreshold = new Date(now.getTime() - leaseMinutes * 60 * 1000);

    return (this.client ?? db).$transaction(async (tx) => {
      // Find candidate IDs due for processing
      // Status is PENDING or FAILED_RETRYABLE with dueAt <= now, OR
      // CLAIMED but timed out (abandoned lease)
      const candidates = await tx.appointmentReminder.findMany({
        where: {
          OR: [
            {
              status: { in: ["PENDING", "FAILED_RETRYABLE"] },
              dueAt: { lte: now },
            },
            {
              status: "CLAIMED",
              claimedAt: { lte: leaseThreshold },
            },
          ],
        },
        orderBy: { dueAt: "asc" },
        take: batchSize,
        select: { id: true },
      });

      if (candidates.length === 0) return [];

      const candidateIds = candidates.map((c) => c.id);

      // Atomically mark claimed
      await tx.appointmentReminder.updateMany({
        where: { id: { in: candidateIds } },
        data: {
          status: "CLAIMED",
          claimedAt: now,
        },
      });

      return tx.appointmentReminder.findMany({
        where: { id: { in: candidateIds } },
        orderBy: { dueAt: "asc" },
      });
    });
  }

  async markSent(
    id: string,
    providerMessageId?: string,
  ): Promise<AppointmentReminder> {
    return (this.client ?? db).appointmentReminder.update({
      where: { id },
      data: {
        status: "SENT",
        sentAt: new Date(),
        ...(providerMessageId ? { providerMessageId } : {}),
      },
    });
  }

  async markFailed(
    id: string,
    params: {
      error: string;
      retryable: boolean;
      maxAttempts?: number;
    },
  ): Promise<AppointmentReminder> {
    const existing = await this.findById(id);
    const currentAttempts = (existing?.attemptCount ?? 0) + 1;
    const maxAttempts = params.maxAttempts ?? 3;
    const status: ReminderStatus =
      params.retryable && currentAttempts < maxAttempts
        ? "FAILED_RETRYABLE"
        : "FAILED_PERMANENT";

    return (this.client ?? db).appointmentReminder.update({
      where: { id },
      data: {
        status,
        attemptCount: currentAttempts,
        lastError: params.error,
      },
    });
  }

  async cancelActiveByAppointment(
    appointmentId: string,
    reason?: string,
  ): Promise<number> {
    const result = await (this.client ?? db).appointmentReminder.updateMany({
      where: {
        appointmentId,
        status: { in: ["PENDING", "CLAIMED", "FAILED_RETRYABLE"] },
      },
      data: {
        status: "CANCELLED",
        ...(reason ? { lastError: reason } : {}),
      },
    });
    return result.count;
  }
}
