import type { AttentionReason, HandoffCause } from "@/lib/validation";
import type {
  AppointmentStatus,
  ConversationStatus,
  MessageSenderType,
} from "@/types/domain";

export type InboxUser = {
  id: string;
  name: string;
  image: string | null;
};

export type InboxConversation = {
  id: string;
  status: ConversationStatus;
  customer: { id: string; name: string; phone: string };
  assignedUser: InboxUser | null;
  lastMessage: {
    content: string;
    displayText?: string | null;
    metadata?: unknown;
    senderType: MessageSenderType;
    createdAt: string;
  } | null;
  lastActivityAt: string;
  /**
   * PROMPT-B04 — this thread has an UNACKNOWLEDGED operator attention: an
   * unresolved NEED_HUMAN handoff the operator has not opened yet. Drives
   * the visual "needs your attention" distinction in the inbox.
   */
  hasAttention: boolean;
};

/**
 * Authorized read-only snapshot for an OPEN conversation.
 *
 * Deliberately smaller than `ConversationDetailData`: it carries only the
 * values that can change while the operator is reading (messages, bookings,
 * status, ownership, the current open attention reason and the team list
 * needed by the assignment control). Reading attention is display-only:
 * opening/acknowledgment writes stay outside this snapshot.
 */
export type ConversationRefreshData = Pick<
  ConversationDetailData,
  | "id"
  | "status"
  | "aiSummary"
  | "assignedUser"
  | "attentionReason"
  | "attentionCause"
  | "messages"
  | "appointments"
  | "team"
>;

export type ConversationRefreshResult =
  | { success: true; data: ConversationRefreshData }
  | {
      success: false;
      code:
        | "INVALID_INPUT"
        | "UNAUTHENTICATED"
        | "FORBIDDEN"
        | "NOT_FOUND"
        | "UNKNOWN";
      message: string;
    };

export type ConversationDetailData = {
  id: string;
  businessId?: string;
  status: ConversationStatus;
  aiSummary: string;
  /**
   * WHY the thread needs the operator (DECISIONS #62): the attention reason
   * captured at the moment the thread is opened. Present only on the FIRST
   * load of an unacknowledged handoff — opening the thread acknowledges it,
   * so a reload legitimately shows `null`. The NEED_HUMAN status badge stays
   * regardless; this is the "understand why" affordance, rendered as icon +
   * Arabic text (never color-only).
   */
  attentionReason: AttentionReason | null;
  /**
   * PROMPT-AI-ARCH-16 (Slice 7) — the canonical TYPED cause of the handoff:
   * the stable, fine-grained "why does this need me?" value, captured
   * alongside the coarse `attentionReason` at the moment the thread is
   * opened. Same first-load-only semantics as `attentionReason` (opening the
   * thread acknowledges it). Null when no cause was recorded — the operator
   * then reads the coarse reason alone.
   */
  attentionCause: HandoffCause | null;
  customer: {
    id: string;
    name: string;
    phone: string;
    notes: string | null;
  };
  assignedUser: InboxUser | null;
  currentUserId: string;
  messages: Array<{
    id: string;
    senderType: MessageSenderType;
    content: string;
    displayText?: string | null;
    metadata?: unknown;
    createdAt: string;
  }>;
  appointments: Array<{
    id: string;
    date: string;
    startTime: string;
    status: AppointmentStatus;
    notes: string | null;
    service: { name: string; durationMinutes: number };
  }>;
  team: InboxUser[];
};

export type ConversationActionResult =
  { success: true } | { success: false; message: string };

export type StaffReplyOutcome =
  "unroutable" | "in-progress" | "accepted" | "definite_rejection" | "unknown";

export type StaffReplyActionResult =
  | {
      success: true;
      outcome: "accepted";
      messageId?: string;
      assignedUser?: InboxUser | null;
    }
  | {
      success: false;
      outcome: "unroutable" | "in-progress" | "definite_rejection" | "unknown";
      message: string;
      code?: string;
    };

export type StaffReplyStatusActionResult =
  | {
      success: true;
      status: "accepted";
      messageId?: string;
      message: string;
    }
  | {
      success: false;
      status: "in-progress" | "rejected" | "unknown";
      code?: string;
      message: string;
    };
