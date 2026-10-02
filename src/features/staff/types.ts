import type { AttentionReason, HandoffCause } from "@/lib/validation";
import type {
  AppointmentStatus,
  ConversationStatus,
  MessageSenderType,
  UserRole,
} from "@/types/domain";

import type { ComponentType } from "react";

/**
 * Team management types (PROMPT-16). Feature-specific by convention —
 * the team directory composes the invitations feature's create dialog
 * at the route layer through the structural `StaffInviteDialogComponent`
 * contract below (no cross-feature imports).
 */

/** Serializable team-member row for the team directory. */
export type TeamMemberItem = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  isActive: boolean;
};

/**
 * Invitation lifecycle states the team directory displays: waiting for
 * the invitee (PENDING) or accepted-but-not-yet-activated (ACCEPTED —
 * the resume path of an interrupted activation). Terminal states
 * (revoked/expired/activated) are not shown: activated invitees appear
 * as team members; dead invitations are inert.
 */
export type TeamInvitationStatus = "PENDING" | "ACCEPTED";

/** Serializable open-invitation row for the team directory. */
export type TeamInvitationItem = {
  id: string;
  email: string;
  role: UserRole;
  status: TeamInvitationStatus;
  createdAt: string;
  expiresAt: string;
};

export type TeamListResult =
  | { success: true; members: TeamMemberItem[] }
  | { success: false; message: string };

/** Typed failure codes for team-member activation changes. */
export type SetTeamMemberActiveErrorCode =
  | "FORBIDDEN"
  | "NO_BUSINESS"
  | "VALIDATION"
  | "NOT_FOUND"
  | "ADMIN_TARGET"
  | "UPDATE_FAILED";

export type SetTeamMemberActiveResult =
  | { success: true; member: TeamMemberItem }
  | { success: false; code: SetTeamMemberActiveErrorCode; message: string };

/**
 * Structural contract for the route-composed invite dialog (the
 * invitations feature's `StaffInviteDialog` satisfies it — composition
 * happens at the route layer, preserving feature isolation; same
 * pattern as the Smart Create create-customer dialog).
 */
export type StaffInviteDialogComponent = ComponentType<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (invitation: TeamInvitationItem) => void;
}>;

/**
 * Staff workspace types (PROMPT-17) — the human-handoff queue. The
 * workspace composes the conversations feature's existing takeover
 * action at the route layer through the structural
 * `TakeOverConversationAction` contract below (no cross-feature
 * imports, no second assignment system).
 */

/** Assignment state of a queue item, derived server-side from the actor. */
export type QueueAssignment = "unassigned" | "mine" | "other";

/** Lightweight customer identity on a workspace row. */
export type WorkspaceCustomer = {
  id: string;
  name: string;
  phone: string;
};

/** Latest appointment context on a workspace row (when present). */
export type WorkspaceAppointment = {
  id: string;
  serviceName: string;
  /** "YYYY-MM-DD" (business-local calendar date). */
  date: string;
  startTime: string;
  status: AppointmentStatus;
};

/** Serializable row of the NEED_HUMAN handoff queue. */
export type StaffQueueItem = {
  id: string;
  assignment: QueueAssignment;
  assignedUserName: string | null;
  customer: WorkspaceCustomer;
  lastMessage: {
    content: string;
    senderType: MessageSenderType;
    createdAt: string;
  } | null;
  lastActivityAt: string;
  latestAppointment: WorkspaceAppointment | null;
  /**
   * PROMPT-B04 — this handoff is still UNACKNOWLEDGED (no operator has
   * opened the thread since the AI handed it off). The operational
   * "needs your attention" marker; `attentionReason` is the coarse
   * category of why the AI did not answer (operator-only, never
   * customer-visible, never internal AI reasoning).
   */
  hasAttention: boolean;
  attentionReason: AttentionReason | null;
  /**
   * PROMPT-AI-ARCH-16 (Slice 7) — the canonical TYPED cause of the handoff:
   * the stable, fine-grained answer to "why does this conversation need me?".
   * Null when no cause was recorded (a staff-routed thread, or a legacy row);
   * the operator surface then falls back to the coarse `attentionReason`.
   * Operator-only, never customer-visible, never internal AI reasoning.
   */
  attentionCause: HandoffCause | null;
  attentionCreatedAt: string | null;
};

/** Serializable row of the "assigned to me" (non-handoff) section. */
export type StaffAssignedItem = {
  id: string;
  status: ConversationStatus;
  customer: WorkspaceCustomer;
  lastMessage: {
    content: string;
    senderType: MessageSenderType;
    createdAt: string;
  } | null;
  lastActivityAt: string;
  latestAppointment: WorkspaceAppointment | null;
};

export type StaffWorkspaceResult =
  | { success: true; queue: StaffQueueItem[]; assigned: StaffAssignedItem[] }
  | { success: false; message: string };

/**
 * Structural contract for the route-composed takeover action (the
 * conversations feature's `transitionConversation` satisfies it — the
 * ONE existing takeover mechanism is reused, never duplicated).
 */
export type TakeOverConversationAction = (input: {
  id: string;
  transition: "TAKE_OVER";
}) => Promise<{ success: boolean; message?: string }>;
