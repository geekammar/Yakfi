/**
 * Turn evidence — the smallest production-safe observability projection
 * (PROMPT-AI-OPS-22).
 *
 * WHY THIS EXISTS. A finished inbound turn already computes a rich, content-
 * free decision record (`TurnObservability`, PROMPT-AI-ARCH-02), but until now
 * that record was returned to the webhook caller and DISCARDED — the callers
 * read only `ok` / `duplicate` / `code`. Nothing emitted or persisted it. The
 * live pilot therefore could not explain its own behaviour: `usage_records`
 * proves a provider failed, but nothing records whether the address was
 * carried, whether the disclosure gate was even consulted, or which routing
 * decision was taken. This module projects a finished turn into ONE bounded,
 * machine-safe evidence record so the next turn is explainable from evidence
 * instead of inference.
 *
 * WHAT IT IS. A PURE, TOTAL projection: no I/O, no LLM, no DB, no env, no
 * secret, no network. Deterministic — the same finished turn always yields the
 * same record. It performs ZERO inference and changes ZERO behaviour; it only
 * re-labels facts the authoritative path already decided.
 *
 * WHAT IT MAY CARRY (binding — closed machine keys, counters, booleans, and
 * already-safe correlation ids only):
 *   schema · environment · appVersion · traceId · conversationId · businessId ·
 *   customerMessageId · intent · assistantAction · conversationStatus ·
 *   handoffCause · routingDecision · taskRelevance[] · contextChannels ·
 *   knowledgeSourceClass[] · provider · model · providerAttempts ·
 *   providerStatus · providerLatencyMs · inputTokens · outputTokens ·
 *   parseSuccess · disclosureChannel · disclosureAllowed ·
 *   disclosureRefusalReason · knowledgeGapCategory · finalOutcome ·
 *   outboundSendAttempted · outboundSendDelivered · emittedAt
 *
 * The token counters (`inputTokens` / `outputTokens`, PROMPT-AI-PERF-02) are
 * copied AS-IS from the existing attempt-level adapter telemetry the engine
 * already holds — they are never recomputed from characters, never estimated,
 * and never a second source of truth. They are `null` when the provider
 * adapter exposes no token telemetry or no provider was consulted (a
 * deterministic turn), so an un-instrumented adapter never fabricates a zero.
 *
 * WHAT IT MUST NEVER CARRY (binding):
 *   customer message text · phone numbers · API keys / tokens / secretRefs ·
 *   prompts · chain-of-thought · hidden reasoning · raw provider payloads ·
 *   arbitrary PII · any free text a customer or model authored.
 *
 * The record is emitted ONCE per inbound turn, OFF the customer critical path
 * (after the reply was persisted + sent), through the fail-open sink in
 * `src/lib/observability/turn-telemetry.ts`. It is never a second source of
 * truth and never blocks, retries, or alters a turn.
 *
 * Docs: `docs/ai/ARCHITECTURE.md`, `docs/BUILD_STATE.md` (PROMPT-AI-OPS-22).
 */

import type { TaskRelevance } from "@/features/conversations/server/ai-context-builder";
import type { AiRequest } from "@/features/conversations/server/ai-contract";
import type {
  TurnContextChannels,
  TurnObservability,
} from "@/features/conversations/server/ai-observability";

/** Stable schema marker so a sink can evolve the shape without ambiguity. */
export const TURN_EVIDENCE_SCHEMA = "flowpilot.turn.evidence@v1" as const;

/** The bounded, content-free evidence record for ONE finished inbound turn. */
export type TurnEvidence = {
  readonly schema: typeof TURN_EVIDENCE_SCHEMA;
  readonly environment: string;
  readonly appVersion: string;
  /** One correlation id per turn; null only for a turn that never started. */
  readonly traceId: string | null;
  readonly conversationId: string;
  readonly businessId: string;
  readonly customerMessageId: string;
  readonly intent: string | null;
  readonly assistantAction: string;
  readonly conversationStatus: string;
  readonly handoffCause: string | null;
  readonly routingDecision: string | null;
  readonly taskRelevance: readonly string[] | null;
  readonly contextChannels: TurnContextChannels | null;
  readonly knowledgeSourceClass: readonly string[] | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly providerAttempts: number | null;
  readonly providerStatus: string | null;
  readonly providerLatencyMs: number | null;
  /**
   * Input tokens the provider reported for this turn (PROMPT-AI-PERF-02): the
   * successful (else last) physical attempt's existing adapter telemetry,
   * copied as-is. `null` when the adapter exposes no token telemetry or no
   * provider was consulted — never a fabricated zero.
   */
  readonly inputTokens: number | null;
  /** See {@link TurnEvidence.inputTokens} — the output-token counterpart. */
  readonly outputTokens: number | null;
  readonly parseSuccess: boolean | null;
  readonly disclosureChannel: string | null;
  readonly disclosureAllowed: boolean | null;
  readonly disclosureRefusalReason: string | null;
  readonly knowledgeGapCategory: string | null;
  readonly finalOutcome: string;
  readonly outboundSendAttempted: boolean;
  readonly outboundSendDelivered: boolean | null;
  readonly emittedAt: string;
};

/**
 * Structural input — deliberately NOT the engine's `InboundSuccess` type, so
 * this module imports nothing from the engine (no cycle) and any producer can
 * supply the finished-turn facts it already has.
 */
export type TurnEvidenceInput = {
  readonly ok: boolean;
  readonly duplicate?: boolean;
  readonly businessId?: string | null;
  readonly conversationId?: string | null;
  readonly customerMessageId?: string | null;
  readonly assistantAction?: string | null;
  readonly intent?: string | null;
  readonly conversationStatus?: string | null;
  readonly handoffCause?: string | null;
  readonly assistantProvider?: string | null;
  readonly observability?: TurnObservability | null;
  readonly knowledgeGap?: { readonly category: string } | null;
  readonly delivery?: { readonly delivered: boolean } | null;
};

export type BuildTurnEvidenceMeta = {
  readonly environment: string;
  readonly appVersion: string;
  /** Injection point for deterministic tests; defaults to `new Date()`. */
  readonly emittedAt?: Date;
};

const NO_CALL_ROUTING = new Set<TurnObservability["routingDecision"]>([
  "DETERMINISTIC_BYPASS",
  "DETERMINISTIC",
  "JEV",
]);

/**
 * Generate ONE opaque correlation id for a turn. Random, bounded, hex — it
 * carries no business or customer meaning and is never derived from content.
 */
export function newTurnTraceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * The task-relevance families that armed this turn, as closed machine keys.
 * Pure: reads only the boolean record the B-02 builder already derived.
 */
export function armedRelevance(relevance: TaskRelevance): string[] {
  return (Object.keys(relevance) as ReadonlyArray<keyof TaskRelevance>).filter(
    (key) => relevance[key] === true,
  );
}

/**
 * Project the assembled `AiRequest` into bounded channel facts. Pure: counters
 * and presence booleans only — it never copies a value and never reads
 * `message` / `recentMessages` / `assistantStyle`.
 */
export function readContextChannels(request: AiRequest): TurnContextChannels {
  const services = request.services ?? [];
  return {
    servicesCount: services.length,
    addressPresent:
      typeof request.businessAddress === "string"
        ? request.businessAddress.trim().length > 0
        : false,
    aboutPresent:
      typeof request.businessAbout === "string"
        ? request.businessAbout.trim().length > 0
        : false,
    faqPresent: (request.faqs ?? []).length > 0,
    pricePresent: services.some(
      (service) =>
        typeof service.price === "string" && service.price.trim().length > 0,
    ),
    availabilityPresent: (request.availability ?? []).length > 0,
  };
}

/**
 * Project a finished turn into its evidence record. Pure and total: no I/O, no
 * env, no DB, no secret, no network; the same input always yields the same
 * record (given the same `emittedAt`).
 */
export function buildTurnEvidence(
  input: TurnEvidenceInput,
  meta: BuildTurnEvidenceMeta,
): TurnEvidence {
  const observability = input.observability ?? null;
  const notCalled =
    observability?.routingDecision !== undefined &&
    NO_CALL_ROUTING.has(observability.routingDecision);
  return {
    schema: TURN_EVIDENCE_SCHEMA,
    environment: meta.environment,
    appVersion: meta.appVersion,
    traceId: observability?.traceId ?? null,
    conversationId: input.conversationId ?? "",
    businessId: input.businessId ?? "",
    customerMessageId: input.customerMessageId ?? "",
    intent: input.intent ?? null,
    assistantAction: input.duplicate
      ? "DUPLICATE"
      : (input.assistantAction ?? "UNKNOWN"),
    conversationStatus: input.conversationStatus ?? "",
    handoffCause: input.handoffCause ?? null,
    routingDecision: observability?.routingDecision ?? null,
    taskRelevance: observability?.taskRelevance ?? null,
    contextChannels: observability?.contextChannels ?? null,
    knowledgeSourceClass: observability?.knowledgeSourceClass ?? null,
    provider: observability?.provider ?? input.assistantProvider ?? null,
    model: observability?.model ?? null,
    providerAttempts: observability?.providerAttempts ?? null,
    providerStatus:
      observability?.providerStatus ?? (notCalled ? "NOT_CALLED" : null),
    providerLatencyMs: observability?.latencyMs ?? null,
    // PROMPT-AI-PERF-02 — the ONE token projection onto the evidence record:
    // pure pass-through of the counter the engine already copied from the
    // attempt-level adapter telemetry. No recomputation, no estimation, no
    // second source of truth; absent telemetry stays `null` (never a fake 0).
    inputTokens: observability?.inputTokens ?? null,
    outputTokens: observability?.outputTokens ?? null,
    parseSuccess: observability?.parseSuccess ?? null,
    disclosureChannel: observability?.disclosure?.channel ?? null,
    disclosureAllowed: observability?.disclosure?.allowed ?? null,
    disclosureRefusalReason: observability?.disclosure?.refusalReason ?? null,
    knowledgeGapCategory: input.knowledgeGap?.category ?? null,
    finalOutcome: input.duplicate
      ? "DUPLICATE"
      : (input.assistantAction ?? "UNKNOWN"),
    outboundSendAttempted:
      input.delivery !== null && input.delivery !== undefined,
    outboundSendDelivered: input.delivery ? input.delivery.delivered : null,
    emittedAt: (meta.emittedAt ?? new Date()).toISOString(),
  };
}

/**
 * Content-freeness guard (used by the deterministic checks and any future
 * audit). Fails loudly if a field that could carry customer content, a secret,
 * a prompt, or chain-of-thought ever appears on the record. Structural: it
 * checks the record's KEYS against the closed allowlist and asserts no value
 * is a non-empty string outside the allowlist — it never inspects message
 * text, because the record must not contain any.
 */
export const TURN_EVIDENCE_ALLOWED_STRING_FIELDS = new Set<string>([
  "schema",
  "environment",
  "appVersion",
  "traceId",
  "conversationId",
  "businessId",
  "customerMessageId",
  "intent",
  "assistantAction",
  "conversationStatus",
  "handoffCause",
  "routingDecision",
  "provider",
  "model",
  "providerStatus",
  "disclosureChannel",
  "disclosureRefusalReason",
  "knowledgeGapCategory",
  "finalOutcome",
  "emittedAt",
]);

/** Recursively assert the record (and any nested object) is content-free. */
export function assertTurnEvidenceContentFree(
  record: unknown,
  path = "$",
): void {
  if (record === null || typeof record !== "object") {
    if (typeof record === "string" && record.length === 0) return;
    return;
  }
  const value = record as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    const childPath = `${path}.${key}`;
    const child = value[key];
    if (Array.isArray(child)) {
      for (let index = 0; index < child.length; index += 1) {
        assertTurnEvidenceContentFree(child[index], `${childPath}[${index}]`);
      }
      continue;
    }
    if (child !== null && typeof child === "object") {
      assertTurnEvidenceContentFree(child, childPath);
      continue;
    }
    if (typeof child === "string") {
      if (!TURN_EVIDENCE_ALLOWED_STRING_FIELDS.has(key)) {
        throw new Error(
          `turn-evidence content-freeness violated at ${childPath}: unexpected string field "${key}"`,
        );
      }
    }
  }
}
