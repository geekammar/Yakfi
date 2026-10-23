/**
 * Fail-open turn telemetry sink (PROMPT-AI-OPS-22).
 *
 * Emits ONE bounded, content-free turn-evidence record per inbound turn. It is
 * strictly OFF the customer critical path: called AFTER the reply was
 * persisted + delivered, and constructed so that ANY failure in this module is
 * swallowed and can NEVER block, retry, or alter a customer turn.
 *
 * VENDOR-NEUTRAL BY CONSTRUCTION (binding):
 *   FlowPilot → structured observability → existing runtime logs → optional OTLP sink
 *
 * - The DEFAULT sink is a single structured JSON `console` line that the
 *   existing Vercel/runtime log infrastructure already captures. It requires
 *   NO new dependency and NO new infrastructure.
 * - An OPTIONAL OTLP/HTTP-JSON exporter exists for a future sink; it is gated
 *   ENTIRELY behind environment configuration and is implemented with the
 *   platform `fetch` (no `@opentelemetry/*` dependency on the customer path).
 *   Absent configuration ⇒ logs only, exactly as before.
 * - No telemetry database/table is on the customer path, and none is required.
 *
 * Kill switches (fail-open by default):
 *   TURN_EVIDENCE_DISABLED=1        → total silence (no log line, no OTLP)
 *   OTEL_TURN_EVIDENCE_ENABLED=1    → also export via OTLP (needs endpoint)
 *   OTEL_EXPORTER_OTLP_ENDPOINT=url → the OTLP/HTTP base URL
 *
 * Docs: `docs/ai/ARCHITECTURE.md`, `docs/BUILD_STATE.md` (PROMPT-AI-OPS-22).
 */

import type { TurnEvidence } from "@/features/conversations/server/turn-evidence";
import { TURN_EVIDENCE_SCHEMA } from "@/features/conversations/server/turn-evidence";

import pkg from "../../../package.json";

/** A sink the engine may be given; absent ⇒ no emission (exact prior behaviour). */
export interface TurnTelemetrySink {
  emit(record: TurnEvidence): void;
}

const LOG_NAME = "flowpilot.turn.evidence";

function envFlag(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true";
}

function otlpEndpoint(): string | null {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!raw) return null;
  const base = raw.trim().replace(/\/+$/, "");
  return base.length > 0 ? base : null;
}

/**
 * The DEFAULT sink: ONE structured JSON line. `console` is the runtime log
 * surface Vercel already captures, so this needs no new infrastructure. The
 * record is already a plain, bounded, content-free value — it is serialized
 * as-is under a stable log name so a sink can filter `msg === LOG_NAME`.
 */
function logTurnEvidence(record: TurnEvidence): void {
  // The structured JSON line IS this sink's output — the runtime log surface
  // Vercel already captures. `console.log` is therefore intentional here and
  // scoped to this one emission point.
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: "info", msg: LOG_NAME, ...record }));
}

/**
 * OPTIONAL OTLP/HTTP-JSON export (dependency-free). Fire-and-forget: the
 * promise is never awaited on the customer path and any rejection is swallowed
 * by the caller's `.catch()`. The payload is a minimal, spec-shaped
 * `ExportTraceServiceRequest` whose span attributes are the evidence record's
 * closed machine keys. Never content, never secrets.
 */
function exportTurnEvidenceOtlp(record: TurnEvidence, endpoint: string): void {
  const traceId = record.traceId ?? "";
  // Derive a bounded 8-byte span id (16 hex chars) from the platform RNG.
  const spanId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const nowNs = `${Date.now()}000000`;
  const attributes: Array<{
    key: string;
    value:
      | { stringValue: string }
      | { intValue: string }
      | { doubleValue: number }
      | { boolValue: boolean };
  }> = [
    { key: "flowpilot.schema", value: { stringValue: record.schema } },
    {
      key: "flowpilot.environment",
      value: { stringValue: record.environment },
    },
    { key: "flowpilot.app_version", value: { stringValue: record.appVersion } },
    {
      key: "flowpilot.conversation_id",
      value: { stringValue: record.conversationId },
    },
    { key: "flowpilot.business_id", value: { stringValue: record.businessId } },
    {
      key: "flowpilot.assistant_action",
      value: { stringValue: record.assistantAction },
    },
    {
      key: "flowpilot.conversation_status",
      value: { stringValue: record.conversationStatus },
    },
    {
      key: "flowpilot.intent",
      value: { stringValue: record.intent ?? "null" },
    },
    {
      key: "flowpilot.handoff_cause",
      value: { stringValue: record.handoffCause ?? "null" },
    },
    {
      key: "flowpilot.routing_decision",
      value: { stringValue: record.routingDecision ?? "null" },
    },
    {
      key: "flowpilot.provider",
      value: { stringValue: record.provider ?? "null" },
    },
    {
      key: "flowpilot.provider_status",
      value: { stringValue: record.providerStatus ?? "null" },
    },
    ...(record.providerAttempts !== null
      ? [
          {
            key: "flowpilot.provider_attempts",
            value: { intValue: String(record.providerAttempts) },
          },
        ]
      : []),
    {
      key: "flowpilot.provider_latency_ms",
      value: { doubleValue: record.providerLatencyMs ?? 0 },
    },
    // PROMPT-AI-PERF-02 — the provider's own token counters, exported ONLY when
    // a real count exists. A telemetry-less or no-call turn exports NO token
    // attribute rather than a fabricated zero (the log record keeps `null`).
    ...(record.inputTokens !== null
      ? [
          {
            key: "flowpilot.input_tokens",
            value: { intValue: String(record.inputTokens) },
          },
        ]
      : []),
    ...(record.outputTokens !== null
      ? [
          {
            key: "flowpilot.output_tokens",
            value: { intValue: String(record.outputTokens) },
          },
        ]
      : []),
    {
      key: "flowpilot.parse_success",
      value: { boolValue: record.parseSuccess ?? false },
    },
    {
      key: "flowpilot.disclosure_channel",
      value: { stringValue: record.disclosureChannel ?? "null" },
    },
    {
      key: "flowpilot.disclosure_allowed",
      value: { boolValue: record.disclosureAllowed ?? false },
    },
    {
      key: "flowpilot.final_outcome",
      value: { stringValue: record.finalOutcome },
    },
    {
      key: "flowpilot.outbound_delivered",
      value: { boolValue: record.outboundSendDelivered ?? false },
    },
    // PROMPT-AI-JEV-03D — the DISJOINT shadow slot (OPTION E), exported only
    // when a shadow evaluation ran this turn. Closed machine keys only; the
    // shadowModelCallCount attribute is the experimental counter that must
    // never be summed into the serving model-call accounting.
    ...(record.shadowEvidenceRole !== null
      ? [
          {
            key: "flowpilot.shadow_evidence_role",
            value: { stringValue: record.shadowEvidenceRole ?? "null" },
          },
        ]
      : []),
    ...(record.shadowResultClass !== null
      ? [
          {
            key: "flowpilot.shadow_result_class",
            value: { stringValue: record.shadowResultClass ?? "null" },
          },
        ]
      : []),
    ...(record.shadowModelCallCount !== null
      ? [
          {
            key: "flowpilot.shadow_model_call_count",
            value: { intValue: String(record.shadowModelCallCount) },
          },
        ]
      : []),
    ...(record.shadowLanguageHint !== null
      ? [
          {
            key: "flowpilot.shadow_language_hint",
            value: { stringValue: record.shadowLanguageHint },
          },
        ]
      : []),
    ...(record.shadowFailureCode !== null
      ? [
          {
            key: "flowpilot.shadow_failure_code",
            value: { stringValue: record.shadowFailureCode },
          },
        ]
      : []),
    ...(record.shadowHandoffAgreement !== null
      ? [
          {
            key: "flowpilot.shadow_handoff_agreement",
            value: { stringValue: record.shadowHandoffAgreement },
          },
        ]
      : []),
    ...(record.shadowServedModel !== null
      ? [
          {
            key: "flowpilot.shadow_served_model",
            value: { stringValue: record.shadowServedModel },
          },
        ]
      : []),
    ...(record.shadowLatencyMs !== null
      ? [
          {
            key: "flowpilot.shadow_latency_ms",
            value: { doubleValue: record.shadowLatencyMs },
          },
        ]
      : []),
  ];

  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "flowpilot" } },
            {
              key: "service.version",
              value: { stringValue: record.appVersion },
            },
            {
              key: "deployment.environment",
              value: { stringValue: record.environment },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: LOG_NAME, version: record.appVersion },
            spans: [
              {
                traceId,
                spanId,
                name: LOG_NAME,
                kind: "SPAN_KIND_INTERNAL",
                startTimeUnixNano: nowNs,
                endTimeUnixNano: nowNs,
                attributes,
                status: { code: "STATUS_CODE_OK" },
              },
            ],
          },
        ],
      },
    ],
  };

  void fetch(`${endpoint}/v1/traces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    // Telemetry must never outpace or outlive the turn it observes.
    keepalive: false,
  }).catch(() => {
    /* fail-open: an unreachable OTLP sink is silently dropped */
  });
}

/**
 * Emit one turn-evidence record through the default sink and, when explicitly
 * configured, the optional OTLP sink. TOTAL and fail-open: every step is
 * wrapped so a telemetry failure can never propagate to a customer turn.
 */
export function emitTurnEvidence(record: TurnEvidence): void {
  try {
    if (envFlag("TURN_EVIDENCE_DISABLED")) return;
    if (record.schema !== TURN_EVIDENCE_SCHEMA) return;
    logTurnEvidence(record);
    if (envFlag("OTEL_TURN_EVIDENCE_ENABLED")) {
      const endpoint = otlpEndpoint();
      if (endpoint) exportTurnEvidenceOtlp(record, endpoint);
    }
  } catch {
    /* fail-open: observability never blocks, retries, or alters a turn */
  }
}

/** The production sink; wired into `defaultConversationEngineDeps`. */
export const turnTelemetrySink: TurnTelemetrySink = { emit: emitTurnEvidence };

// `pkg` is imported only for the app version carried on every record. Keep the
// reference explicit so a bundler never tree-shakes the version away.
void pkg.version;
