/**
 * Operator attention query service (PROMPT-B04) — the thin server layer the
 * UI consumes. It never trusts a client-supplied `businessId`: the tenant
 * scope is always the authenticated session's Business, passed down by the
 * route/layout guards (the established pattern).
 *
 * The handoff lifecycle stays `ConversationStatus.NEED_HUMAN` — this layer
 * only reads/advances the notification marker on top of it.
 */

import type { NavItem } from "@/lib/app-config";
import type { OpenAttentionDto, ResolveAttentionDto } from "@/lib/validation";
import {
  operatorAttentionRepository,
  type OperatorAttentionRepository,
} from "@/server/repositories";

export type AttentionDeps = {
  attention: Pick<
    OperatorAttentionRepository,
    "countOpen" | "open" | "resolve"
  >;
};

export const defaultAttentionDeps: AttentionDeps = {
  attention: operatorAttentionRepository,
};

/**
 * The operator-facing badge count: how many unresolved handoffs in this
 * Business have NOT been acknowledged yet. Server-derived tenant scope.
 */
export async function getOpenAttentionCount(
  deps: AttentionDeps,
  businessId: string,
): Promise<number> {
  return deps.attention.countOpen(businessId);
}

/**
 * Attach the live attention count to the navigation destination
 * (PROMPT-B04). Pure presentation wiring: the count is already
 * server-derived, and this only picks the item the operator acts from —
 * the staff workspace when present, else the shared inbox. Display-only.
 */
export function withAttentionCount(items: NavItem[], count: number): NavItem[] {
  if (count <= 0) return items;
  const destination = items.find((item) =>
    ["/staff", "/conversations"].includes(item.href),
  );
  if (!destination) return items;
  return items.map((item) =>
    item === destination ? { ...item, attentionCount: count } : item,
  );
}

/**
 * Record that an operator has seen a conversation (PROMPT-B04 resolution).
 * Server-authorized: the caller proves the actor's Business owns the thread
 * before reaching here. The conversation keeps its NEED_HUMAN status — the
 * handoff is still operationally open; only the NEW/unread alert clears.
 */
export async function acknowledgeAttention(
  deps: AttentionDeps,
  input: ResolveAttentionDto,
): Promise<void> {
  await deps.attention.resolve(input);
}

/**
 * Open operator attention for a manual staff handoff (the conversations
 * feature's existing HANDOFF transition). Uses the same idempotent row as
 * the AI-driven path — one live alert per conversation, never a storm.
 */
export async function openStaffHandoffAttention(
  deps: AttentionDeps,
  input: OpenAttentionDto,
): Promise<void> {
  await deps.attention.open(input);
}

export type { OpenAttentionDto, ResolveAttentionDto };
