/**
 * Conversation Control — HUMAN HANDOFF policy (Phases 7–9).
 *
 * Decides, from a provider-neutral final result + turn state, whether the
 * conversation leaves the AI thread and WHY. It consumes:
 *  - the existing structured AI response contract (Phase 7), and
 *  - the existing sanitized provider error taxonomy (Phase 9).
 *
 * It NEVER:
 *  - inspects raw provider JSON,
 *  - invents new AI actions,
 *  - changes `aiResponseSchema`,
 *  - writes to the DB, or
 *  - sends anything itself (the engine executes the transition).
 */
import type {
  AiResponse,
  HandoffReason as ContractHandoffReason,
} from "@/features/conversations/server/ai-contract";

import type { AiProviderErrorCode, AiProviderResult } from "../types";
import type { HandoffReason } from "./types";

/**
 * Customer-facing handoff message seam (Phase 10) — the ONE place the
 * layer phrases a handoff. Wording follows the existing product voice in
 * `conversation-ai.ts` (REPLIES.*). Nothing else in this layer may
 * compose a customer-facing handoff string, so handoff text can never be
 * scattered or duplicated.
 */
export const HANDOFF_MESSAGES: Readonly<Record<HandoffReason, string>> = {
  CUSTOMER_REQUESTED_HUMAN: "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق.",
  AI_REQUESTED_HANDOFF: "سأحوّلك لأحد أعضاء الفريق المختص لمساعدتك.",
  RETRY_EXHAUSTED:
    "واجهت صعوبة مؤقتة في الرد — سيتواصل معك أحد أعضاء الفريق الآن.",
  PROVIDER_UNAVAILABLE:
    "واجهت صعوبة مؤقتة في الرد — سيتواصل معك أحد أعضاء الفريق الآن.",
  QUOTA_EXHAUSTED:
    "واجهت صعوبة مؤقتة في الرد — سيتواصل معك أحد أعضاء الفريق الآن.",
  AUTH_OR_CONFIGURATION_FAILURE:
    "واجهت صعوبة مؤقتة في الرد — سيتواصل معك أحد أعضاء الفريق الآن.",
  UNSUPPORTED_REQUEST:
    "لم أفهم طلبك تماماً — سيرد عليك أحد أعضاء الفريق لمساعدتك قريباً.",
  SENSITIVE_OR_RESTRICTED_REQUEST:
    "سنعتني بطلبك — سيتواصل معك أحد أعضاء الفريق في أقرب وقت.",
} as const;

/** The canonical customer-facing message for a handoff reason. */
export function handoffMessageFor(reason: HandoffReason): string {
  return HANDOFF_MESSAGES[reason];
}

/**
 * Map the EXISTING contract handoff reasons (ai-contract.ts) onto the
 * control-layer taxonomy. The contract is NOT changed; unknown / malformed
 * handoff actions fail safe to `null` upstream and never reach this map.
 */
export function fromContractHandoffReason(
  reason: ContractHandoffReason | null,
): HandoffReason | null {
  if (reason === null) return null;
  switch (reason) {
    case "HUMAN_REQUEST":
      return "CUSTOMER_REQUESTED_HUMAN";
    case "SENSITIVE":
      return "SENSITIVE_OR_RESTRICTED_REQUEST";
    case "NO_KNOWLEDGE":
      return "UNSUPPORTED_REQUEST";
    case "AMBIGUOUS":
      return "UNSUPPORTED_REQUEST";
    default:
      // Exhaustiveness guard: any future contract reason stays safe.
      return null;
  }
}

/**
 * Map a final provider FAILURE classification onto a handoff reason
 * (Phase 9). Uses existing error classifications only.
 */
export function handoffReasonForFailure(
  result: AiProviderResult,
): HandoffReason | null {
  if (result.ok) return null;
  return failureCodeToHandoffReason(result.error.code);
}

/** Pure code → reason mapping, exported for direct testing. */
export function failureCodeToHandoffReason(
  code: AiProviderErrorCode,
): HandoffReason {
  switch (code) {
    case "TIMEOUT":
      // A timeout that reached this layer already exhausted its retries.
      return "RETRY_EXHAUSTED";
    case "CONFIG_ERROR":
      return "AUTH_OR_CONFIGURATION_FAILURE";
    case "RETRYABLE":
      // Distinguished by the caller via httpStatus: a quota/rate-limit
      // exhaustion vs a generic network/provider outage.
      return "PROVIDER_UNAVAILABLE";
    case "PERMANENT":
    case "INVALID_RESPONSE":
    case "CONTROLLED_FAILURE":
      return "UNSUPPORTED_REQUEST";
    default:
      // Exhaustiveness guard — unknown classifications fail safe.
      return "PROVIDER_UNAVAILABLE";
  }
}

/**
 * Refine a `RETRYABLE` failure into quota vs unavailability when the
 * caller can supply the sanitized HTTP status. Provider-agnostic: it reads
 * only the mapped status code, never a body.
 */
export function refineRetryableFailure(
  reason: HandoffReason,
  httpStatus: number | undefined,
): HandoffReason {
  if (reason !== "PROVIDER_UNAVAILABLE") return reason;
  if (httpStatus === 429) return "QUOTA_EXHAUSTED";
  return reason;
}

/**
 * Phase 7 — read a supported handoff action straight off the EXISTING
 * structured AI response. Returns `null` for any reply action, and for a
 * malformed/unknown handoff (fails safe — the engine keeps authority over
 * the actual transition).
 */
export function handoffFromAiResponse(
  response: AiResponse | null,
): HandoffReason | null {
  if (response === null) return null;
  if (response.action === "reply") return null;
  if (response.action === "handoff") {
    return (
      fromContractHandoffReason(response.handoffReason) ??
      "AI_REQUESTED_HANDOFF"
    );
  }
  // booking_handoff: a booking-related escalation the AI itself requested.
  return "AI_REQUESTED_HANDOFF";
}
