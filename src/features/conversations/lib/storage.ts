/**
 * FlowPilot — Tenant- and Operator-Scoped Storage Module (CONV-STORAGE-01)
 *
 * Scopes conversation drafts, inbox search/filters, and scroll restoration to
 * trusted business and operator IDs. Strictly avoids PII (never email/phone).
 * Handles disabled or malformed storage gracefully.
 */

const DRAFT_PREFIX = "fp_draft:";
const INBOX_STATE_PREFIX = "fp_inbox_state:";
const INBOX_SCROLL_PREFIX = "fp_inbox_scroll:";

function isStorageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const testKey = "__fp_test__";
    window.sessionStorage.setItem(testKey, testKey);
    window.sessionStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
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
  businessId: string,
  userId: string,
  conversationId: string,
): string | null {
  if (!businessId || !userId || !conversationId) return null;
  if (!isStorageAvailable()) return null;
  try {
    const key = getDraftStorageKey(businessId, userId, conversationId);
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setStoredDraft(
  businessId: string,
  userId: string,
  conversationId: string,
  draft: string,
): void {
  if (!businessId || !userId || !conversationId) return;
  if (!isStorageAvailable()) return;
  try {
    const key = getDraftStorageKey(businessId, userId, conversationId);
    if (draft.trim()) {
      window.sessionStorage.setItem(key, draft);
    } else {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Gracefully handle quota or storage access errors
  }
}

export function removeStoredDraft(
  businessId: string,
  userId: string,
  conversationId: string,
): void {
  if (!businessId || !userId || !conversationId) return;
  if (!isStorageAvailable()) return;
  try {
    const key = getDraftStorageKey(businessId, userId, conversationId);
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export interface StoredInboxState {
  search?: string;
  status?: string;
  assignee?: string;
}

export function getStoredInboxState(
  businessId: string,
  userId: string,
): StoredInboxState | null {
  if (!businessId || !userId) return null;
  if (!isStorageAvailable()) return null;
  try {
    const key = getInboxStateStorageKey(businessId, userId);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return {
      search: typeof parsed.search === "string" ? parsed.search : undefined,
      status: typeof parsed.status === "string" ? parsed.status : undefined,
      assignee: typeof parsed.assignee === "string" ? parsed.assignee : undefined,
    };
  } catch {
    return null;
  }
}

export function setStoredInboxState(
  businessId: string,
  userId: string,
  state: StoredInboxState,
): void {
  if (!businessId || !userId) return;
  if (!isStorageAvailable()) return;
  try {
    const key = getInboxStateStorageKey(businessId, userId);
    window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Gracefully handle quota or storage access errors
  }
}

export function clearStoredInboxState(
  businessId: string,
  userId: string,
): void {
  if (!businessId || !userId) return;
  if (!isStorageAvailable()) return;
  try {
    const key = getInboxStateStorageKey(businessId, userId);
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

export function getStoredInboxScroll(
  businessId: string,
  userId: string,
): number | null {
  if (!businessId || !userId) return null;
  if (!isStorageAvailable()) return null;
  try {
    const key = getInboxScrollStorageKey(businessId, userId);
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

export function setStoredInboxScroll(
  businessId: string,
  userId: string,
  scrollY: number,
): void {
  if (!businessId || !userId) return;
  if (!isStorageAvailable()) return;
  try {
    const key = getInboxScrollStorageKey(businessId, userId);
    window.sessionStorage.setItem(key, String(scrollY));
  } catch {
    // Ignore storage errors
  }
}

export function clearStoredInboxScroll(
  businessId: string,
  userId: string,
): void {
  if (!businessId || !userId) return;
  if (!isStorageAvailable()) return;
  try {
    const key = getInboxScrollStorageKey(businessId, userId);
    window.sessionStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

/**
 * Clears only conversation drafts, inbox filter state, and inbox scroll
 * positions upon sign out. Does NOT clear the entire sessionStorage,
 * keeping auth tokens and foreign tab state intact.
 */
export function clearConversationStorage(): void {
  if (!isStorageAvailable()) return;
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const key = window.sessionStorage.key(i);
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
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Ignore storage errors
  }
}
