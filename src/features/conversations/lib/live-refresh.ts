import type {
  ConversationDetailData,
  ConversationRefreshData,
} from "@/features/conversations/types";

/** Visible-tab refresh cadence. */
export const CONVERSATION_REFRESH_INTERVAL_MS = 5_000;
/** Failure backoff ceiling — transient outages retain the last good snapshot. */
export const CONVERSATION_REFRESH_MAX_BACKOFF_MS = 60_000;

/**
 * Merge authoritative refresh data without losing local-only optimistic
 * messages.
 *
 * Confirmed messages are unioned by id (messages are immutable/append-only in
 * this product), so a slower snapshot can never remove a newer confirmed
 * result. An optimistic message is preserved only while it is not yet present
 * in the server snapshot; if a NEWLY arrived server message has the same
 * sender/content it is treated as the confirmed copy, preventing a duplicate.
 */
export function mergeConversationRefreshMessages(
  currentMessages: ConversationDetailData["messages"],
  refreshedMessages: ConversationDetailData["messages"],
  optimisticIds: ReadonlySet<string>,
): ConversationDetailData["messages"] {
  const previousServerIds = new Set(
    currentMessages
      .filter((message) => !optimisticIds.has(message.id))
      .map((message) => message.id),
  );
  const refreshedIds = new Set(refreshedMessages.map((message) => message.id));
  const newlyArrived = refreshedMessages.filter(
    (message) => !previousServerIds.has(message.id),
  );

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
    if (optimisticIds.has(message.id) || seen.has(message.id)) continue;
    seen.add(message.id);
    merged.push(message);
  }

  for (const message of currentMessages) {
    if (!optimisticIds.has(message.id) || seen.has(message.id)) continue;
    const confirmedCopyArrived = newlyArrived.some(
      (incoming) =>
        incoming.senderType === message.senderType &&
        incoming.content === message.content,
    );
    const stillMissingFromServer = !refreshedIds.has(message.id);
    if (confirmedCopyArrived || !stillMissingFromServer) continue;
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
    messages: mergeConversationRefreshMessages(
      current.messages,
      refresh.messages,
      optimisticIds,
    ),
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
