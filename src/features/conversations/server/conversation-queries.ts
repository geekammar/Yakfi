import type {
  ConversationDetailData,
  ConversationRefreshData,
  InboxConversation,
  InboxUser,
} from "@/features/conversations/types";
import {
  appointmentRepository,
  conversationRepository,
  operatorAttentionRepository,
  userRepository,
} from "@/server/repositories";

import { resolveDisplayForMessage } from "./interaction-display";

type DetailConversation = NonNullable<
  Awaited<ReturnType<typeof conversationRepository.findDetailByBusiness>>
>;
type DetailAppointments = Awaited<
  ReturnType<typeof appointmentRepository.listRecentByCustomer>
>;

function projectMessages(conversation: DetailConversation) {
  return conversation.messages.map((message) => ({
    id: message.id,
    senderType: message.senderType,
    content: message.content,
    displayText: resolveDisplayForMessage({
      senderType: message.senderType,
      content: message.content,
      displayText: message.displayText,
      metadata: message.metadata,
    }),
    metadata: message.metadata ?? null,
    createdAt: message.createdAt.toISOString(),
  }));
}

function projectAppointments(appointments: DetailAppointments) {
  return appointments.map((appointment) => ({
    id: appointment.id,
    date: appointment.date.toISOString().slice(0, 10),
    startTime: appointment.startTime.toISOString(),
    status: appointment.status,
    notes: appointment.notes,
    service: appointment.service,
  }));
}

export async function getConversationInbox(businessId: string) {
  const [conversations, users] = await Promise.all([
    conversationRepository.listInbox(businessId),
    userRepository.listByBusiness({ businessId }, { pageSize: 100 }),
  ]);

  // PROMPT-B04 — which threads still carry an UNACKNOWLEDGED attention.
  // Tenant scope is the session's Business; the map marks inbox rows that
  // need the operator's eyes.
  const attentionByConversation =
    await operatorAttentionRepository.findOpenByConversations(
      businessId,
      conversations.map((conversation) => conversation.id),
    );

  const team: InboxUser[] = users
    .filter((user) => user.isActive)
    .map((user) => ({ id: user.id, name: user.name, image: user.image }));
  const items: InboxConversation[] = conversations.map((conversation) => {
    const lastMessage = conversation.messages[0];
    return {
      id: conversation.id,
      status: conversation.status,
      customer: conversation.customer,
      assignedUser: conversation.assignedTo,
      lastMessage: lastMessage
        ? {
            content: lastMessage.content,
            displayText: resolveDisplayForMessage({
              senderType: lastMessage.senderType,
              content: lastMessage.content,
              displayText: lastMessage.displayText,
              metadata: lastMessage.metadata,
            }),
            metadata: lastMessage.metadata ?? null,
            senderType: lastMessage.senderType,
            createdAt: lastMessage.createdAt.toISOString(),
          }
        : null,
      lastActivityAt: (
        conversation.lastMessageAt ?? conversation.createdAt
      ).toISOString(),
      hasAttention: attentionByConversation.has(conversation.id),
    };
  });

  return { items, team };
}

export async function getConversationDetail(
  businessId: string,
  conversationId: string,
  currentUserId: string,
): Promise<ConversationDetailData | null> {
  const conversation = await conversationRepository.findDetailByBusiness(
    conversationId,
    businessId,
  );
  if (!conversation) return null;

  // PROMPT-B04 — opening the thread acknowledges its operator attention:
  // the operator has now SEEN this handoff, so the NEW/unread alert clears.
  // The conversation keeps its NEED_HUMAN status (the handoff itself is
  // unchanged) until the operator returns it to the assistant. Idempotent —
  // a second load matches zero open rows. Server-authorized: `businessId`
  // here is the session's Business, never client input.
  //
  // DECISIONS #62 — capture WHY first: the reason is read BEFORE the
  // resolve so the operator sees the handoff's operational cause on the
  // first load ("understand why"), then the alert clears. `findOpen` is
  // keyed by conversationId only, but tenancy was already proven above by
  // `findDetailByBusiness` returning this business's thread.
  const openAttention =
    await operatorAttentionRepository.findOpen(conversationId);
  await operatorAttentionRepository.resolve({
    conversationId,
    resolvedById: currentUserId,
  });

  const [appointments, users] = await Promise.all([
    appointmentRepository.listRecentByCustomer(
      businessId,
      conversation.customerId,
    ),
    userRepository.listByBusiness({ businessId }, { pageSize: 100 }),
  ]);

  return {
    id: conversation.id,
    businessId,
    status: conversation.status,
    aiSummary: conversation.aiSummary ?? "",
    attentionReason: openAttention?.reason ?? null,
    attentionCause: openAttention?.cause ?? null,
    customer: {
      id: conversation.customer.id,
      name: conversation.customer.name,
      phone: conversation.customer.phone,
      notes: conversation.customer.notes,
    },
    assignedUser: conversation.assignedTo,
    currentUserId,
    messages: projectMessages(conversation),
    appointments: projectAppointments(appointments),
    team: users
      .filter((user) => user.isActive)
      .map((user) => ({ id: user.id, name: user.name, image: user.image })),
  };
}

/**
 * Authorized READ-ONLY snapshot for a conversation that is already open.
 *
 * Unlike `getConversationDetail`, this deliberately performs NO operator-
 * attention acknowledgment: it may READ the CURRENT open marker so a new
 * handoff can be shown without a reload, but periodic refreshes must never
 * resolve/clear a handoff alert, mutate ownership, mark anything sent, write
 * appointments or trigger delivery. `businessId` is always derived from the
 * authenticated server session by the caller — never from the browser.
 */
export async function getConversationRefresh(
  businessId: string,
  conversationId: string,
): Promise<ConversationRefreshData | null> {
  const conversation = await conversationRepository.findDetailByBusiness(
    conversationId,
    businessId,
  );
  if (!conversation) return null;

  const [openAttention, appointments, users] = await Promise.all([
    operatorAttentionRepository.findOpen(conversationId),
    appointmentRepository.listRecentByCustomer(
      businessId,
      conversation.customerId,
    ),
    userRepository.listByBusiness({ businessId }, { pageSize: 100 }),
  ]);

  return {
    id: conversation.id,
    status: conversation.status,
    aiSummary: conversation.aiSummary ?? "",
    assignedUser: conversation.assignedTo,
    attentionReason: openAttention?.reason ?? null,
    attentionCause: openAttention?.cause ?? null,
    messages: projectMessages(conversation),
    appointments: projectAppointments(appointments),
    team: users
      .filter((user) => user.isActive)
      .map((user) => ({ id: user.id, name: user.name, image: user.image })),
  };
}
