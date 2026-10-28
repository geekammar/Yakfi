/**
 * FlowPilot — Tenant- and Operator-Scoped Storage Module (CONV-STORAGE-01)
 *
 * Scopes conversation drafts, inbox search/filters, and scroll restoration to
 * trusted business and operator IDs. Strictly avoids PII (never email/phone).
 * Handles quota exhaustion, missing identity, and malformed storage gracefully.
 */

const DRAFT_PREFIX = "fp_draft:";
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
): void {
  if (!businessId || !userId || !conversationId) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    const key = getDraftStorageKey(businessId, userId, conversationId);
    if (draft && draft.trim()) {
      storage.setItem(key, draft);
    } else {
      storage.removeItem(key);
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
