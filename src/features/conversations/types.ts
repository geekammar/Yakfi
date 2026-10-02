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

export type ConversationDetailData = {
  id: string;
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
