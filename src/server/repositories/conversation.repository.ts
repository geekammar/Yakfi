import { Prisma } from "@/generated/prisma/client";

import type {
  CreateConversationDto,
  CreateMessageDto,
  ListConversationsDto,
  UpdateConversationDto,
} from "@/lib/validation";
import { paginationSchema, paginationToSkipTake } from "@/lib/validation";
import { db } from "@/server/db";
import { InboundDuplicateError } from "@/server/repositories/inbound-dedupe.repository";
import type {
  Conversation,
  ConversationStatus,
  ConversationWithCustomer,
  ConversationWithMessages,
  Message,
} from "@/types/domain";

const notDeleted = { deletedAt: null } as const;

export type TelegramConversationScope = {
  channel: "telegram";
  connectionId: string;
  botExternalId: string;
  recipientExternalId: string;
};

export class ConversationRepository {
  async findById(id: string): Promise<Conversation | null> {
    return db.conversation.findFirst({ where: { id, ...notDeleted } });
  }

  /** Thread view — conversation plus its ordered messages. */
  async findWithMessages(id: string): Promise<ConversationWithMessages | null> {
    return db.conversation.findFirst({
      where: { id, ...notDeleted },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  }

  async findDetailByBusiness(id: string, businessId: string) {
    return db.conversation.findFirst({
      where: { id, businessId, ...notDeleted },
      include: {
        customer: true,
        assignedTo: { select: { id: true, name: true, image: true } },
        messages: { orderBy: { createdAt: "asc" } },
      },
    });
  }

  /** List view — conversation with a lightweight customer projection. */
  async list(
    input: ListConversationsDto,
    rawPagination?: unknown,
  ): Promise<ConversationWithCustomer[]> {
    const pagination = paginationSchema.parse(rawPagination ?? {});
    return db.conversation.findMany({
      where: {
        businessId: input.businessId,
        ...notDeleted,
        ...(input.status ? { status: input.status } : {}),
        ...(input.assignedUserId
          ? { assignedUserId: input.assignedUserId }
          : {}),
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      ...paginationToSkipTake(pagination),
    });
  }

  async listInbox(businessId: string) {
    return db.conversation.findMany({
      where: { businessId, ...notDeleted },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        assignedTo: { select: { id: true, name: true, image: true } },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            content: true,
            displayText: true,
            metadata: true,
            senderType: true,
            createdAt: true,
          },
        },
      },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take: 100,
    });
  }

  async findLatestByCustomer(
    businessId: string,
    customerId: string,
    scope?: TelegramConversationScope,
  ) {
    if (scope) {
      // Authenticated ingress may reuse only a compatible thread. Never
      // rebind a mixed historical thread or erase its conflicting evidence.
      const prefix = `tg:${scope.botExternalId}:`;
      const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT c.id
        FROM conversations c
        LEFT JOIN conversation_delivery_routes r ON r.conversation_id = c.id
        WHERE c.business_id = ${businessId} AND c.customer_id = ${customerId}
          AND c.deleted_at IS NULL
          AND (r.id IS NULL OR (
            r.business_id = c.business_id AND r.channel = ${scope.channel}
            AND r.connection_id = ${scope.connectionId}
            AND r.bot_external_id = ${scope.botExternalId}
            AND r.recipient_external_id = ${scope.recipientExternalId}
          ))
          AND NOT EXISTS (
            SELECT 1 FROM inbound_message_dedupe d
            WHERE d.conversation_id = c.id AND d.customer_message_id IS NOT NULL
              AND (d.business_id <> c.business_id
                OR NOT starts_with(d.external_key, ${prefix}))
          )
        ORDER BY c.last_message_at DESC, c.created_at DESC
        LIMIT 1
      `);
      return rows[0] ?? null;
    }
    return db.conversation.findFirst({
      where: { businessId, customerId, ...notDeleted },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      select: { id: true },
    });
  }

  /** Customer-history view — lightweight rows for one customer's threads. */
  async listByCustomer(businessId: string, customerId: string) {
    return db.conversation.findMany({
      where: { businessId, customerId, ...notDeleted },
      select: { id: true, status: true, lastMessageAt: true, createdAt: true },
      orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
      take: 50,
    });
  }

  async getDashboardSummary(
    businessId: string,
    dayStartUtc: Date,
    dayEndUtc: Date,
  ) {
    const commonWhere = { businessId, ...notDeleted } as const;
    const [recent, todayCount, needHumanCount] = await db.$transaction([
      db.conversation.findMany({
        where: commonWhere,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
        },
        orderBy: [{ lastMessageAt: "desc" }, { createdAt: "desc" }],
        take: 5,
      }),
      db.conversation.count({
        where: {
          ...commonWhere,
          OR: [
            { lastMessageAt: { gte: dayStartUtc, lt: dayEndUtc } },
            {
              lastMessageAt: null,
              createdAt: { gte: dayStartUtc, lt: dayEndUtc },
            },
          ],
        },
      }),
      db.conversation.count({
        where: { ...commonWhere, status: "NEED_HUMAN" },
      }),
    ]);

    return { recent, todayCount, needHumanCount };
  }

  async create(data: CreateConversationDto): Promise<Conversation> {
    return db.conversation.create({ data });
  }

  async update(id: string, data: UpdateConversationDto): Promise<Conversation> {
    return db.conversation.update({ where: { id }, data });
  }

  async setStatus(id: string, status: ConversationStatus) {
    return db.conversation.update({ where: { id }, data: { status } });
  }

  async assign(id: string, assignedUserId: string | null) {
    return db.conversation.update({
      where: { id },
      data: { assignedUserId },
    });
  }

  async updateWorkflow(
    id: string,
    data: {
      status?: ConversationStatus;
      assignedUserId?: string | null;
    },
  ) {
    return db.conversation.update({ where: { id }, data });
  }

  /**
   * Adds a message and advances `lastMessageAt` in one transaction.
   * This is the single write path for messages.
   *
   * With `dedupe` (the inbound webhook path, PROMPT-ARCH-02): the
   * claim's conversationId/customerMessageId are recorded in the SAME
   * transaction as the message insert — "claim has a message id" ⟺
   * "message row exists". If a concurrent duplicate already recorded a
   * message for the claim, the conditional update matches zero rows,
   * the whole transaction (including this message insert) rolls back,
   * and `InboundDuplicateError` carries the winner's ids — a retried
   * webhook can never double-write a customer message.
   */
  async addMessage(
    input: CreateMessageDto,
    workflow?: {
      assignedUserId?: string | null;
      status?: ConversationStatus;
    },
    dedupe?: {
      claimId: string;
    },
    deliveryRoute?: {
      channel: string;
      connectionId: string;
      botExternalId: string;
      recipientExternalId: string;
    },
  ): Promise<Message> {
    return db.$transaction(async (tx) => {
      const message = await tx.message.create({
        data: {
          conversationId: input.conversationId,
          senderType: input.senderType,
          content: input.content,
          displayText: input.displayText,
          metadata:
            input.metadata === null
              ? Prisma.JsonNull
              : (input.metadata as Prisma.InputJsonValue | undefined),
          createdAt: input.createdAt,
        },
      });
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: { lastMessageAt: message.createdAt, ...workflow },
      });
      if (deliveryRoute) {
        const existingRoute = await tx.conversationDeliveryRoute.findUnique({
          where: { conversationId: input.conversationId },
        });
        if (!existingRoute) {
          const conflicting = await tx.inboundMessageDedupe.findFirst({
            where: {
              conversationId: input.conversationId,
              customerMessageId: { not: null },
              NOT: {
                externalKey: {
                  startsWith: `tg:${deliveryRoute.botExternalId}:`,
                },
              },
            },
          });
          if (!conflicting) {
            const conv = await tx.conversation.findUnique({
              where: { id: input.conversationId },
              select: { businessId: true },
            });
            if (conv) {
              await tx.conversationDeliveryRoute.create({
                data: {
                  businessId: conv.businessId,
                  conversationId: input.conversationId,
                  channel: deliveryRoute.channel,
                  connectionId: deliveryRoute.connectionId,
                  botExternalId: deliveryRoute.botExternalId,
                  recipientExternalId: deliveryRoute.recipientExternalId,
                },
              });
            }
          }
        }
      }
      if (dedupe) {
        const won = await tx.inboundMessageDedupe.updateMany({
          where: { id: dedupe.claimId, customerMessageId: null },
          data: {
            customerMessageId: message.id,
            conversationId: input.conversationId,
          },
        });
        if (won.count === 0) {
          const winner = await tx.inboundMessageDedupe.findUnique({
            where: { id: dedupe.claimId },
            select: { conversationId: true, customerMessageId: true },
          });
          throw new InboundDuplicateError({
            conversationId: winner?.conversationId ?? null,
            customerMessageId: winner?.customerMessageId ?? null,
          });
        }
      }
      return message;
    });
  }

  async getMessages(conversationId: string, rawPagination?: unknown) {
    const pagination = paginationSchema.parse(rawPagination ?? {});
    return db.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      ...paginationToSkipTake(pagination),
    });
  }

  async softDelete(id: string): Promise<Conversation> {
    return db.conversation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async restore(id: string): Promise<Conversation> {
    return db.conversation.update({
      where: { id },
      data: { deletedAt: null },
    });
  }
}
