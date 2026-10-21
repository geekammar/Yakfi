/**
 * Conversation Fact Keys & Vocabulary (CORE-03A).
 *
 * Single source of truth for canonical conversation-fact keys and
 * removable fact subsets across contract, engine, and state boundaries.
 */

import { z } from "zod";

/**
 * The closed set of conversation fact keys tracked in conversation state.
 * Unknown keys on an incoming factUpdate are ignored.
 */
export const conversationFactKeys = [
  "service",
  "date",
  "timePreference",
  "provider",
  "customerName",
  "followUpRequestId",
] as const;

export type ConversationFactKey = (typeof conversationFactKeys)[number];

export const conversationFactKeySchema = z.enum(conversationFactKeys);

/**
 * The bounded subset of fact keys that can be explicitly REMOVED in this slice (CORE-03A).
 * REMOVE outside date, timePreference, and provider is rejected.
 */
export const removableFactKeys = [
  "date",
  "timePreference",
  "provider",
] as const;

export type RemovableFactKey = (typeof removableFactKeys)[number];

export const removableFactKeySchema = z.enum(removableFactKeys);

const factKeySet: ReadonlySet<string> = new Set(conversationFactKeys);
const removableFactKeySet: ReadonlySet<string> = new Set(removableFactKeys);

export function isFactKey(key: string): key is ConversationFactKey {
  return factKeySet.has(key);
}

export function isRemovableFactKey(key: string): key is RemovableFactKey {
  return removableFactKeySet.has(key);
}
