/**
 * Semantic Fact Reconciliation (CORE-03A).
 *
 * ONE pure reconciliation helper at the conversation feature boundary.
 *
 * Precedence rules:
 * 1. Legacy extraction proposes SETs first (for non-null fields).
 * 2. Explicit factUpdates have higher precedence.
 * 3. Within factUpdates, operations apply in order; the last valid operation for each key wins.
 * 4. Explicit SET/REMOVE for a key prevents legacy language helpers from overriding that key.
 * 5. Absent operation preserves valid existing state.
 * 6. REMOVE overrides conflicting extraction for the same key.
 * 7. Later SET after REMOVE wins; later REMOVE after SET wins.
 */

import type {
  AiExtraction,
  AiFactUpdate,
  CanonicalTimePreference,
} from "@/features/conversations/server/ai-contract";
import {
  isCanonicalTimePreference,
  isFactKey,
  isRemovableFactKey,
  type ConversationFactKey,
  type RemovableFactKey,
} from "@/features/conversations/server/conversation-facts";

export type ReconciledTurnFacts = {
  /** The final operation for each key touched in this turn. */
  readonly operations: ReadonlyMap<ConversationFactKey, AiFactUpdate>;
  /** The set of keys explicitly touched this turn (via factUpdates or extraction). */
  readonly touchedKeys: ReadonlySet<ConversationFactKey>;
  /** The set of keys explicitly removed this turn. */
  readonly removedKeys: ReadonlySet<RemovableFactKey>;
  /** The set of keys set this turn. */
  readonly setFacts: ReadonlyMap<
    ConversationFactKey,
    { value: string; isRevision?: boolean }
  >;
  /**
   * Reconciled factUpdates (canonical list of operations, without contradictions,
   * where last valid operation for each key wins).
   */
  readonly effectiveFactUpdates: readonly AiFactUpdate[];
  /**
   * Reconciled extraction for downstream booking input.
   * If a key was removed, its value is null.
   * If a key was set, its value is the set value.
   * If untouched, its value is the extraction value (or null).
   */
  readonly normalizedExtraction: AiExtraction;
  /** Check if a key was touched by extraction or factUpdates this turn */
  readonly isTouched: (key: ConversationFactKey | string) => boolean;
  /** Check if a key was explicitly removed this turn */
  readonly isRemoved: (key: ConversationFactKey | string) => boolean;
};

export function reconcileTurnSemanticFacts(
  extraction: AiExtraction | null | undefined,
  factUpdates: readonly AiFactUpdate[] | null | undefined,
): ReconciledTurnFacts {
  const operations = new Map<ConversationFactKey, AiFactUpdate>();
  const touchedKeys = new Set<ConversationFactKey>();
  const removedKeys = new Set<RemovableFactKey>();
  const setFacts = new Map<
    ConversationFactKey,
    { value: string; isRevision?: boolean }
  >();

  // 1. Legacy extraction proposes SETs first (non-null fields only)
  if (extraction) {
    if (extraction.service) {
      operations.set("service", {
        key: "service",
        operation: "set",
        value: extraction.service,
      });
      setFacts.set("service", { value: extraction.service });
      touchedKeys.add("service");
    }
    if (extraction.date) {
      operations.set("date", {
        key: "date",
        operation: "set",
        value: extraction.date,
      });
      setFacts.set("date", { value: extraction.date });
      touchedKeys.add("date");
    }
    if (extraction.timePreference) {
      operations.set("timePreference", {
        key: "timePreference",
        operation: "set",
        value: extraction.timePreference,
      });
      setFacts.set("timePreference", { value: extraction.timePreference });
      touchedKeys.add("timePreference");
    }
    if (extraction.exactTime) {
      touchedKeys.add("exactTime");
      if (extraction.exactTime.type === "specific") {
        operations.set("exactTime", {
          key: "exactTime",
          operation: "set",
          value: extraction.exactTime.time,
        });
        setFacts.set("exactTime", { value: extraction.exactTime.time });
      }
    }
    if (extraction.provider) {
      operations.set("provider", {
        key: "provider",
        operation: "set",
        value: extraction.provider,
      });
      setFacts.set("provider", { value: extraction.provider });
      touchedKeys.add("provider");
    }
  }

  // 2. Explicit factUpdates have higher precedence (last valid operation wins)
  for (const update of factUpdates ?? []) {
    if (!isFactKey(update.key)) continue;
    const key = update.key;
    touchedKeys.add(key);

    if (update.operation === "remove") {
      if (isRemovableFactKey(key)) {
        operations.set(key, update);
        removedKeys.add(key);
        setFacts.delete(key);
      }
    } else {
      // SET operation (explicit or default)
      operations.set(key, { ...update, operation: "set" });
      if (isRemovableFactKey(key)) {
        removedKeys.delete(key);
      }
      setFacts.set(key, {
        value: update.value,
        isRevision: update.isRevision,
      });
    }
  }

  const effectiveFactUpdates: readonly AiFactUpdate[] = Array.from(
    operations.values(),
  );

  const rawTimePref = removedKeys.has("timePreference")
    ? null
    : (setFacts.get("timePreference")?.value ??
      extraction?.timePreference ??
      null);
  const timePreference: CanonicalTimePreference | null =
    isCanonicalTimePreference(rawTimePref) ? rawTimePref : null;

  let normalizedExactTime = extraction?.exactTime ?? null;
  if (removedKeys.has("exactTime")) {
    normalizedExactTime = null;
  } else if (setFacts.has("exactTime")) {
    normalizedExactTime = {
      type: "specific",
      time: setFacts.get("exactTime")!.value,
    };
  }

  const normalizedExtraction: AiExtraction = {
    service: setFacts.get("service")?.value ?? extraction?.service ?? null,
    date: removedKeys.has("date")
      ? null
      : (setFacts.get("date")?.value ?? extraction?.date ?? null),
    timePreference,
    exactTime: normalizedExactTime,
    provider: removedKeys.has("provider")
      ? null
      : (setFacts.get("provider")?.value ?? extraction?.provider ?? null),
    temporalRequest:
      removedKeys.has("date") || removedKeys.has("dateRange")
        ? null
        : (extraction?.temporalRequest ?? null),
  };

  return {
    operations,
    touchedKeys,
    removedKeys,
    setFacts,
    effectiveFactUpdates,
    normalizedExtraction,
    isTouched: (key: string) => touchedKeys.has(key as ConversationFactKey),
    isRemoved: (key: string) => removedKeys.has(key as RemovableFactKey),
  };
}
