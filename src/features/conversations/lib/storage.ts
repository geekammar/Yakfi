/**
 * FlowPilot — Tenant- and Operator-Scoped Storage Module (CONV-STORAGE-01)
 *
 * Scopes conversation drafts, inbox search/filters, and scroll restoration to
 * trusted business and operator IDs. Strictly avoids PII (never email/phone).
 * Handles quota exhaustion, missing identity, and malformed storage gracefully.
 */

const DRAFT_PREFIX = "fp_draft:";
const DRAFT_META_PREFIX = "fp_draft_meta:";
const ATTEMPT_PREFIX = "fp_reply_attempt:";
const INBOX_STATE_PREFIX = "fp_inbox_state:";
const INBOX_SCROLL_PREFIX = "fp_inbox_scroll:";

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getDraftStorageKey(
  businessId: string,
  userId: string,
  conversationId: string,
): string {
  return `${DRAFT_PREFIX}${encodeURIComponent(businessId)}:${encodeURIComponent(userId)}:${encodeURIComponent(conversationId)}`;
}

export function getDraftMetaStorageKey(
  businessId: string,
  userId: string,
  conversationId: string,
): string {
  return `${DRAFT_META_PREFIX}${encodeURIComponent(businessId)}:${encodeURIComponent(userId)}:${encodeURIComponent(conversationId)}`;
}

export function getInboxStateStorageKey(
  businessId: string,
  userId: string,
): string {
  return `${INBOX_STATE_PREFIX}${encodeURIComponent(businessId)}:${encodeURIComponent(userId)}`;
}

export function getInboxScrollStorageKey(
  businessId: string,
  userId: string,
): string {
  return `${INBOX_SCROLL_PREFIX}${encodeURIComponent(businessId)}:${encodeURIComponent(userId)}`;
}

export interface StoredDraftMeta {
  draftId: string;
  updatedAt: number;
}

export function getStoredDraftMeta(
  businessId?: string,
  userId?: string,
  conversationId?: string,
): StoredDraftMeta | null {
  if (!businessId || !userId || !conversationId) return null;
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    const key = getDraftMetaStorageKey(businessId, userId, conversationId);
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (
      typeof parsed.draftId !== "string" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return parsed as StoredDraftMeta;
  } catch {
    return null;
  }
}

export function getStoredDraft(
  businessId?: string,
  userId?: string,
  conversationId?: string,
): string | null {
  if (!businessId || !userId || !conversationId) return null;
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    const key = getDraftStorageKey(businessId, userId, conversationId);
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function setStoredDraft(
  businessId?: string,
  userId?: string,
  conversationId?: string,
  draft?: string,
  meta?: StoredDraftMeta,
): void {
  if (!businessId || !userId || !conversationId) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getDraftStorageKey(businessId, userId, conversationId);
    const metaKey = getDraftMetaStorageKey(businessId, userId, conversationId);
    if (draft && draft.trim()) {
      storage.setItem(key, draft);
      if (meta) {
        storage.setItem(metaKey, JSON.stringify(meta));
      }
    } else {
      storage.removeItem(key);
      storage.removeItem(metaKey);
    }
  } catch {
    // Quota exhaustion or storage write errors are safely ignored
  }
}

export function removeStoredDraft(
  businessId?: string,
  userId?: string,
  conversationId?: string,
): void {
  if (!businessId || !userId || !conversationId) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getDraftStorageKey(businessId, userId, conversationId);
    const metaKey = getDraftMetaStorageKey(businessId, userId, conversationId);
    storage.removeItem(key);
    storage.removeItem(metaKey);
  } catch {
    // Safe removal under quota exhaustion or storage errors
  }
}

export interface StoredReplyAttempt {
  attemptId: string;
  content: string;
  status: "pending" | "in-progress" | "unknown" | "rejected";
  timestamp: number;
  message?: string;
  code?: string;
  draftId?: string;
  dismissed?: boolean;
}

export function getReplyAttemptStorageKey(
  businessId: string,
  userId: string,
  conversationId: string,
): string {
  return `${ATTEMPT_PREFIX}${encodeURIComponent(businessId)}:${encodeURIComponent(userId)}:${encodeURIComponent(conversationId)}`;
}

function isValidAttempt(item: unknown): item is StoredReplyAttempt {
  if (!item || typeof item !== "object") return false;
  const o = item as Record<string, unknown>;
  return typeof o.attemptId === "string" && typeof o.content === "string";
}

export function getStoredReplyAttempts(
  businessId?: string,
  userId?: string,
  conversationId?: string,
): StoredReplyAttempt[] {
  if (!businessId || !userId || !conversationId) return [];
  const storage = getSessionStorage();
  if (!storage) return [];
  try {
    const key = getReplyAttemptStorageKey(businessId, userId, conversationId);
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed) return [];
    if (Array.isArray(parsed)) {
      return parsed.filter(isValidAttempt);
    }
    if (typeof parsed === "object" && isValidAttempt(parsed)) {
      return [parsed];
    }
    return [];
  } catch {
    return [];
  }
}

export function setStoredReplyAttempts(
  businessId?: string,
  userId?: string,
  conversationId?: string,
  attempts: StoredReplyAttempt[] = [],
): void {
  if (!businessId || !userId || !conversationId) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getReplyAttemptStorageKey(businessId, userId, conversationId);
    if (attempts.length > 0) {
      storage.setItem(key, JSON.stringify(attempts));
    } else {
      storage.removeItem(key);
    }
  } catch {
    // Quota exhaustion or storage write errors are safely ignored
  }
}

export function getStoredReplyAttempt(
  businessId?: string,
  userId?: string,
  conversationId?: string,
): StoredReplyAttempt | null {
  const attempts = getStoredReplyAttempts(businessId, userId, conversationId);
  return attempts.find((a) => !a.dismissed) ?? null;
}

export function setStoredReplyAttempt(
  businessId?: string,
  userId?: string,
  conversationId?: string,
  attempt?: StoredReplyAttempt | null,
): void {
  if (!businessId || !userId || !conversationId) return;
  if (!attempt) {
    removeStoredReplyAttempt(businessId, userId, conversationId);
    return;
  }
  const attempts = getStoredReplyAttempts(businessId, userId, conversationId);
  const index = attempts.findIndex((a) => a.attemptId === attempt.attemptId);
  if (index >= 0) {
    attempts[index] = attempt;
  } else {
    attempts.push(attempt);
  }
  setStoredReplyAttempts(businessId, userId, conversationId, attempts);
}

export function removeStoredReplyAttemptById(
  businessId?: string,
  userId?: string,
  conversationId?: string,
  attemptId?: string,
): void {
  if (!businessId || !userId || !conversationId || !attemptId) return;
  const attempts = getStoredReplyAttempts(businessId, userId, conversationId);
  const remaining = attempts.filter((a) => a.attemptId !== attemptId);
  setStoredReplyAttempts(businessId, userId, conversationId, remaining);
}

export function markStoredReplyAttemptDismissed(
  businessId?: string,
  userId?: string,
  conversationId?: string,
  attemptId?: string,
  dismissed = true,
): void {
  if (!businessId || !userId || !conversationId || !attemptId) return;
  const attempts = getStoredReplyAttempts(businessId, userId, conversationId);
  const updated = attempts.map((a) =>
    a.attemptId === attemptId ? { ...a, dismissed } : a,
  );
  setStoredReplyAttempts(businessId, userId, conversationId, updated);
}

export function removeStoredReplyAttempt(
  businessId?: string,
  userId?: string,
  conversationId?: string,
): void {
  if (!businessId || !userId || !conversationId) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getReplyAttemptStorageKey(businessId, userId, conversationId);
    storage.removeItem(key);
  } catch {
    // Safe removal under quota exhaustion or storage errors
  }
}

export interface StoredInboxState {
  search?: string;
  status?: string;
  assignee?: string;
}

export function getStoredInboxState(
  businessId?: string,
  userId?: string,
): StoredInboxState | null {
  if (!businessId || !userId) return null;
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    const key = getInboxStateStorageKey(businessId, userId);
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      search: typeof parsed.search === "string" ? parsed.search : undefined,
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      assignee:
        typeof parsed.assignee === "string" ? parsed.assignee : undefined,
    };
  } catch {
    return null;
  }
}

export function setStoredInboxState(
  businessId?: string,
  userId?: string,
  state?: StoredInboxState,
): void {
  if (!businessId || !userId || !state) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getInboxStateStorageKey(businessId, userId);
    storage.setItem(key, JSON.stringify(state));
  } catch {
    // Quota exhaustion or storage write errors are safely ignored
  }
}

export function clearStoredInboxState(
  businessId?: string,
  userId?: string,
): void {
  if (!businessId || !userId) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getInboxStateStorageKey(businessId, userId);
    storage.removeItem(key);
  } catch {
    // Safe removal under quota exhaustion or storage errors
  }
}

export function getStoredInboxScroll(
  businessId?: string,
  userId?: string,
): number | null {
  if (!businessId || !userId) return null;
  const storage = getSessionStorage();
  if (!storage) return null;
  try {
    const key = getInboxScrollStorageKey(businessId, userId);
    const raw = storage.getItem(key);
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

export function setStoredInboxScroll(
  businessId?: string,
  userId?: string,
  scrollY?: number,
): void {
  if (!businessId || !userId || typeof scrollY !== "number") return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getInboxScrollStorageKey(businessId, userId);
    storage.setItem(key, String(scrollY));
  } catch {
    // Quota exhaustion or storage write errors are safely ignored
  }
}

export function clearStoredInboxScroll(
  businessId?: string,
  userId?: string,
): void {
  if (!businessId || !userId) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getInboxScrollStorageKey(businessId, userId);
    storage.removeItem(key);
  } catch {
    // Safe removal under quota exhaustion or storage errors
  }
}

/**
 * Clears only conversation drafts, inbox filter state, and inbox scroll
 * positions upon sign out. Does NOT clear the entire sessionStorage,
 * keeping auth tokens and foreign tab state intact.
 * Works even when storage write quota is completely exhausted.
 */
export function clearConversationStorage(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (
        key &&
        (key.startsWith(DRAFT_PREFIX) ||
          key.startsWith(DRAFT_META_PREFIX) ||
          key.startsWith(ATTEMPT_PREFIX) ||
          key.startsWith(INBOX_STATE_PREFIX) ||
          key.startsWith(INBOX_SCROLL_PREFIX))
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      storage.removeItem(key);
    }
  } catch {
    // Safe cleanup under storage errors
  }
}
