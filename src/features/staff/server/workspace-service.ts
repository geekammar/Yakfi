/**
 * Staff workspace query (PROMPT-17) — the human-handoff view: which
 * conversations need ME now?
 *
 * The service layer enforces the authorization rules the route layer
 * relies on: only Business STAFF users open the workspace, and every
 * read is scoped to the actor's own Business (derived from the
 * authenticated session — a client can never supply a businessId).
 * The repository collaborators are injectable (established
 * team-service pattern) so the workflow logic can be verified without
 * a live database. This is a READ layer only: takeover and replies
 * stay in the conversations feature's existing write paths.
 */

import { resolveDisplayForMessage } from "@/features/conversations/server/interaction-display";
import type {
  StaffAssignedItem,
  StaffQueueItem,
  StaffWorkspaceResult,
} from "@/features/staff/types";
import type {
  AppointmentRepository,
  ConversationRepository,
  OperatorAttentionRepository,
} from "@/server/repositories";
import {
  appointmentRepository,
  conversationRepository,
  operatorAttentionRepository,
} from "@/server/repositories";
import type { UserRole } from "@/types/domain";

/** Authorization context derived from the authenticated session. */
export type WorkspaceActor = {
  userId: string;
  role: UserRole;
  businessId: string | null;
};

export type StaffWorkspaceDeps = {
  conversations: Pick<ConversationRepository, "listInbox">;
  appointments: Pick<AppointmentRepository, "listLatestByCustomers">;
  /** PROMPT-B04 — the operator-attention marker on handoff queue rows. */
  attention: Pick<OperatorAttentionRepository, "findOpenByConversations">;
};

/** Production dependencies (app singletons). */
export const defaultStaffWorkspaceDeps: StaffWorkspaceDeps = {
  conversations: conversationRepository,
  appointments: appointmentRepository,
  attention: operatorAttentionRepository,
};

const FORBIDDEN_MESSAGE = "مساحة العمل متاحة لأعضاء الفريق فقط";
const NO_BUSINESS_MESSAGE = "لا توجد منشأة مرتبطة بحسابك";
const LOAD_FAILED_MESSAGE = "تعذر تحميل مساحة العمل الآن";

type InboxRow = Awaited<
  ReturnType<ConversationRepository["listInbox"]>
>[number];
type AppointmentRow = Awaited<
  ReturnType<AppointmentRepository["listLatestByCustomers"]>
>[number];

function toWorkspaceAppointment(
  appointment: AppointmentRow,
): StaffQueueItem["latestAppointment"] {
  return {
    id: appointment.id,
    serviceName: appointment.service.name,
    date: appointment.date.toISOString().slice(0, 10),
    startTime: appointment.startTime.toISOString(),
    status: appointment.status,
  };
}

function appointmentFor(
  latest: Map<string, AppointmentRow>,
  customerId: string,
): StaffQueueItem["latestAppointment"] {
  const appointment = latest.get(customerId);
  return appointment ? toWorkspaceAppointment(appointment) : null;
}

/** Newest appointment per customer — rows arrive newest-first. */
function latestAppointmentByCustomer(
  appointments: AppointmentRow[],
): Map<string, AppointmentRow> {
  const latest = new Map<string, AppointmentRow>();
  for (const appointment of appointments) {
    if (!latest.has(appointment.customerId)) {
      latest.set(appointment.customerId, appointment);
    }
  }
  return latest;
}

/** Queue priority: unassigned first (needs an owner now), then mine,
 * then other people's — activity order is preserved inside each group. */
function queueRank(row: InboxRow, actorUserId: string): number {
  if (!row.assignedUserId) return 0;
  return row.assignedUserId === actorUserId ? 1 : 2;
}

/**
 * The staff workspace: the NEED_HUMAN handoff queue plus the actor's
 * own assigned (non-handoff) conversations, with just enough customer
 * + appointment context to act without opening extra screens.
 */
export async function getStaffWorkspace(
  deps: StaffWorkspaceDeps,
  actor: WorkspaceActor,
): Promise<StaffWorkspaceResult> {
  if (actor.role !== "STAFF") {
    return { success: false, message: FORBIDDEN_MESSAGE };
  }
  if (!actor.businessId) {
    return { success: false, message: NO_BUSINESS_MESSAGE };
  }

  try {
    const conversations = await deps.conversations.listInbox(actor.businessId);

    const queueRows = conversations.filter(
      (row) => row.status === "NEED_HUMAN",
    );
    const assignedRows = conversations.filter(
      (row) =>
        row.assignedUserId === actor.userId && row.status !== "NEED_HUMAN",
    );

    const appointmentsByCustomer = latestAppointmentByCustomer(
      await deps.appointments.listLatestByCustomers(actor.businessId, [
        ...new Set(
          [...queueRows, ...assignedRows].map((row) => row.customerId),
        ),
      ]),
    );

    // PROMPT-B04 — which queue threads are still UNACKNOWLEDGED (the operator
    // has not opened them yet). One tenant-scoped lookup, then a boolean +
    // the coarse reason per row. The reason is an operational category only
    // (never prompts/chain-of-thought/provider internals) and is shown solely
    // to the operator, never to the customer.
    const attentionByConversation =
      await deps.attention.findOpenByConversations(
        actor.businessId,
        [...queueRows, ...assignedRows].map((row) => row.id),
      );

    const queue: StaffQueueItem[] = queueRows
      .map((row) => ({
        row,
        rank: queueRank(row, actor.userId),
      }))
      .sort((a, b) => a.rank - b.rank) // stable: keeps activity order
      .map(({ row }) => {
        const attention = attentionByConversation.get(row.id) ?? null;
        return {
          id: row.id,
          assignment: !row.assignedUserId
            ? ("unassigned" as const)
            : row.assignedUserId === actor.userId
              ? ("mine" as const)
              : ("other" as const),
          assignedUserName: row.assignedTo?.name ?? null,
          customer: row.customer,
          lastMessage: row.messages[0]
            ? {
                content: row.messages[0].content,
                displayText: resolveDisplayForMessage({
                  senderType: row.messages[0].senderType,
                  content: row.messages[0].content,
                  displayText: (
                    row.messages[0] as { displayText?: string | null }
                  ).displayText,
                }),
                senderType: row.messages[0].senderType,
                createdAt: row.messages[0].createdAt.toISOString(),
              }
            : null,
          lastActivityAt: (row.lastMessageAt ?? row.createdAt).toISOString(),
          latestAppointment: appointmentFor(
            appointmentsByCustomer,
            row.customerId,
          ),
          hasAttention: Boolean(attention),
          attentionReason: attention?.reason ?? null,
          attentionCause: attention?.cause ?? null,
          attentionCreatedAt: attention?.createdAt ?? null,
        };
      });

    const assigned: StaffAssignedItem[] = assignedRows.map((row) => ({
      id: row.id,
      status: row.status,
      customer: row.customer,
      lastMessage: row.messages[0]
        ? {
            content: row.messages[0].content,
            displayText: resolveDisplayForMessage({
              senderType: row.messages[0].senderType,
              content: row.messages[0].content,
              displayText: (row.messages[0] as { displayText?: string | null })
                .displayText,
            }),
            senderType: row.messages[0].senderType,
            createdAt: row.messages[0].createdAt.toISOString(),
          }
        : null,
      lastActivityAt: (row.lastMessageAt ?? row.createdAt).toISOString(),
      latestAppointment: appointmentFor(appointmentsByCustomer, row.customerId),
    }));

    return { success: true, queue, assigned };
  } catch {
    return { success: false, message: LOAD_FAILED_MESSAGE };
  }
}
