import type {
  ConversationDetailData,
  ConversationRefreshData,
} from "@/features/conversations/types";

/** Visible-tab refresh cadence. */
export const CONVERSATION_REFRESH_INTERVAL_MS = 5_000;
/** Failure backoff ceiling — transient outages retain the last good snapshot. */
export const CONVERSATION_REFRESH_MAX_BACKOFF_MS = 60_000;

/**
 * Merge authoritative refresh data without losing local-only messages.
 *
 * Identity is the message id only. Two independent STAFF messages may carry
 * identical text, so sender/content/timestamp are NEVER used to infer that an
 * optimistic row and a server row are the same message. Callers defer message
 * snapshots while a local send is unresolved; confirmation then arrives
 * through the authoritative `messageId` returned by the send contract.
 */
export function mergeConversationRefreshMessages(
  currentMessages: ConversationDetailData["messages"],
  refreshedMessages: ConversationDetailData["messages"],
): ConversationDetailData["messages"] {
  const merged: ConversationDetailData["messages"] = [];
  const seen = new Set<string>();

  for (const message of refreshedMessages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }

  // Keep already-confirmed local messages the snapshot has not caught up with
  // (read-after-write safety), but never duplicate a server id.
  for (const message of currentMessages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }

  return merged;
}

/**
 * Replace an optimistic id with the authoritative message id without ever
 * producing two rows for the same confirmed message.
 */
export function replaceConversationMessageId(
  messages: ConversationDetailData["messages"],
  optimisticId: string,
  confirmedId: string,
): ConversationDetailData["messages"] {
  const alreadyConfirmed = messages.some(
    (message) => message.id === confirmedId && message.id !== optimisticId,
  );
  const next: ConversationDetailData["messages"] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const id = message.id === optimisticId ? confirmedId : message.id;
    if (seen.has(id)) continue;
    if (alreadyConfirmed && message.id === optimisticId) continue;
    seen.add(id);
    next.push(message.id === optimisticId ? { ...message, id } : message);
  }
  return next;
}

/** Apply the authoritative fields while keeping local-only transcript edges. */
export function mergeConversationRefresh(
  current: ConversationDetailData,
  refresh: ConversationRefreshData,
  optimisticIds: ReadonlySet<string>,
): ConversationDetailData {
  if (current.id !== refresh.id) return current;
  return {
    ...current,
    status: refresh.status,
    aiSummary: refresh.aiSummary,
    assignedUser: refresh.assignedUser,
    messages:
      optimisticIds.size > 0
        ? current.messages
        : mergeConversationRefreshMessages(current.messages, refresh.messages),
    appointments: refresh.appointments,
    team: refresh.team,
  };
}

/** Bounded exponential backoff (5s, 10s, 20s, 40s, 60s ceiling). */
export function conversationRefreshDelay(failureCount: number): number {
  if (failureCount <= 0) return CONVERSATION_REFRESH_INTERVAL_MS;
  return Math.min(
    CONVERSATION_REFRESH_INTERVAL_MS * 2 ** Math.min(failureCount, 4),
    CONVERSATION_REFRESH_MAX_BACKOFF_MS,
  );
}
