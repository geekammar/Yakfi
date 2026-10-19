/**
 * Conversation engine (PROMPT-19; hardened in PROMPT-ARCH-02; wired for
 * PROMPT-AI-03 booking seam) — the ONE canonical inbound path that turns
 * an incoming WhatsApp-style customer message into a safe assistant
 * response:
 *
 *   inbound message → resolve business (by receiving WhatsApp number)
 *   → claim the external message key (DURABLE idempotency, before any
 *   irreversible processing) → find-or-create customer (`upsertByPhone`)
 *   → find-or-create conversation (Branch-aware) → persist the CUSTOMER
 *   message (the claim's message ids recorded in the SAME transaction)
 *   → load the conversation's minimal business context → typed AI turn
 *   (deterministic turns may BYPASS the assistant entirely) → for
 *   BOOKING/AVAILABILITY intents: mapper (AiResponse → domain, server-
 *   derived businessId/branchId, ANY_PROVIDER→no fabricated providerId)
 *   → CORE-01 eligibleProviders → provider-name match → CORE-02
 *   bookingOptions (reusing resolveWorkingDay/weekdayOf/
 *   generateCandidateSlots/filterConflictingSlots) → options/
 *   clarification/NEED_HUMAN (zero appointment mutation) → otherwise
 *   safe reply OR NEED_HUMAN → persist the assistant reply → deliver
 *   through the transport boundary → best-effort usage telemetry.
 *
 * Product rules encoded here:
 * - The payload NEVER controls authority: no `businessId`, role,
 *   customer/conversation ids, assignment, or tenant identity can enter
 *   through the inbound contract — the Business is resolved server-side
 *   from the receiving WhatsApp number via the established
 *   `BusinessRepository.findByWhatsappNumber` mapping. AiResponse
 *   extraction never carries businessId/role/accountType/tenant — those
 *   keys are stripped by `parseAiResponse`; the mapper uses only
 *   server-derived ids.
 * - Idempotency (DECISIONS #34): a redelivered webhook is deduplicated
 *   on the durable (businessId, external key) ledger BEFORE any
 *   irreversible processing; a redelivery of an already-processed
 *   message returns an idempotent success with the original ids and
 *   ZERO new side effects. The fallback key (no provider message id) is
 *   a deterministic hash of the canonical payload — provider-neutral
 *   and tenant-safe.
 * - The AI runs ONLY on unassigned AI_ACTIVE threads. Every other state
 *   (NEED_HUMAN / BOOKED / INCOMPLETE, or a thread owned by staff) keeps
 *   its assignment and routes the message to staff attention — the
 *   assistant never interjects into a human-owned conversation.
 * - AI output is never the source of truth (DECISIONS #33): it crosses
 *   the structured contract boundary (`ai-contract.ts`), is re-validated
 *   before persistence, and booking intents are resolved through the
 *   deterministic CORE-01/CORE-02 domain (mapper + eligibility +
 *   booking-options). The engine never creates appointments.
 * - All writes go through `ConversationRepository.addMessage` — the
 *   single message write path (immutable messages, transactional
 *   `lastMessageAt` advance). No Prisma access outside repositories.
 * - Usage telemetry (DECISIONS #36) is best-effort and append-only: it
 *   records ids, counters, and machine keys ONLY — no message content,
 *   no secrets, no chain-of-thought — and can never fail the turn.
 *
 * Repository/collaborator deps are injectable (defaulting to the app
 * singletons) so the real wiring is verifiable without a live database —
 * the established service pattern.
 */

import { createHash } from "node:crypto";

import { addMinutes } from "@/features/appointments/server/appointment-create-service";
import { resolveBookingOptions } from "@/features/appointments/server/booking-options-service";
import { resolveEligibleProviders } from "@/features/appointments/server/provider-eligibility-service";
import {
  inboundMessageSchema,
  type InboundMessageInput,
} from "@/features/conversations/schemas/conversation-schema";
import {
  buildAiContext,
  deriveTaskRelevance,
  type TaskRelevance,
} from "@/features/conversations/server/ai-context-builder";
import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import {
  AI_RECENT_MESSAGE_LIMIT,
  parseAiResponse,
} from "@/features/conversations/server/ai-contract";
import {
  TASK_SUPPORT_FAMILIES,
  enforceDisclosure,
} from "@/features/conversations/server/ai-disclosure";
import type {
  AiRoutingDecision,
  TurnObservability,
  TurnStateTransitionObservation,
} from "@/features/conversations/server/ai-observability";
import { buildTurnObservability } from "@/features/conversations/server/ai-observability";
import type {
  ServiceOffer,
  SlotOffer,
} from "@/features/conversations/server/booking-offer";
import {
  buildServiceOffer,
  buildSlotOffer,
  serviceOfferKeyboard,
  slotOfferKeyboard,
} from "@/features/conversations/server/booking-offer";
import {
  isProviderNameCandidate,
  mapAiResponseToBookingInput,
  matchProviderByName,
  matchServiceByName,
} from "@/features/conversations/server/booking-mapper";
import type {
  BookingSelection,
  BookingSelectionContext,
} from "@/features/conversations/server/booking-selection";
import type { OfferReply } from "@/features/conversations/server/booking-selection";
import {
  interpretOfferReply,
  tryParseBookingSelection,
} from "@/features/conversations/server/booking-selection";
import {
  CONTINUE_DOMAIN_INVITE,
  clarificationForBookingReason,
  clarificationForInterruption,
  derivePendingClarification,
  derivePendingContinuation,
} from "@/features/conversations/server/clarification";
import type { ConversationAi } from "@/features/conversations/server/conversation-ai";
import {
  bypassDeterministicAi,
  classifyCustomerMessage,
  detectTurnControlSignals,
  normalizeArabicText,
} from "@/features/conversations/server/conversation-ai";
import {
  completeBookingTask,
  deriveConversationStateFromHistory,
  emptyConversationState,
  factUpdatesFromExtraction,
  mergeConversationState,
  withOfferStatus,
  withPresentedOffer,
} from "@/features/conversations/server/conversation-state";
import type { ConversationStateStore } from "@/features/conversations/server/conversation-state-store";
import { openTurnStateSession } from "@/features/conversations/server/conversation-state-store";
import type { TurnStateSession } from "@/features/conversations/server/conversation-state-store";
import type { ConversationState } from "@/features/conversations/server/conversation-state";
import type { MessageTransport } from "@/features/conversations/server/conversation-transport";
import { offlineMessageTransport } from "@/features/conversations/server/conversation-transport";
import {
  contractHandoffReasonToCause,
  controlHandoffReasonToCause,
  eligibilityFailureCodeToCause,
  type HandoffCause,
} from "@/features/conversations/server/handoff-cause";
import { deriveKnowledgeGapObservation } from "@/features/conversations/server/knowledge-gap";
import {
  extractTimeOfDayPreference,
  resolveEgyptianRelativeDate,
  todayIsoInTimeZone,
} from "@/features/conversations/server/relative-date";
import {
  armedRelevance,
  buildTurnEvidence,
  newTurnTraceId,
  readContextChannels,
} from "@/features/conversations/server/turn-evidence";
import { resolveTurnPlan } from "@/features/conversations/server/turn-planner";
import type { ResolvedTurn } from "@/features/conversations/server/turn-planner";
import type { TurnTelemetrySink } from "@/lib/observability/turn-telemetry";
import { turnTelemetrySink } from "@/lib/observability/turn-telemetry";
import type {
  AttentionReason,
  KnowledgeGapCategory,
  RecordUsageDto,
} from "@/lib/validation";
import { createPolicyBackedAi } from "@/server/integrations/ai/factory";
import { JEV_DETERMINISTIC_PROVIDER } from "@/server/integrations/ai/jev-strategy";
import type {
  AiTelemetry,
  AiTelemetryAttempt,
} from "@/server/integrations/ai/types";
import type {
  AppointmentRepository,
  BranchRepository,
  BusinessRepository,
  ConversationRepository,
  CustomerRepository,
  FollowUpRequestRepository,
  InboundDedupeRepository,
  KnowledgeGapRepository,
  OperatorAttentionRepository,
  ProviderRepository,
  ServiceRepository,
  UsageRepository,
} from "@/server/repositories";
import {
  appointmentRepository,
  branchRepository,
  businessRepository,
  conversationRepository,
  conversationStateRepository,
  customerRepository,
  followUpRequestRepository,
  inboundDedupeRepository,
  knowledgeGapRepository,
  operatorAttentionRepository,
  providerRepository,
  serviceRepository,
  usageRepository,
} from "@/server/repositories";
import { InboundDuplicateError } from "@/server/repositories/inbound-dedupe.repository";
import type { Conversation, ConversationStatus } from "@/types/domain";

import pkg from "../../../../package.json";

// ─── Policy-backed assistant (PROMPT-AI-02) ────────────────────────────────
// Resolves the live Platform AI policy on every turn — no hard-coded
// provider or model in the engine. Secrets stay server-only via
// secretRef → getEnvVar (OPENROUTER_API_KEY / AGENTROUTER_API_KEY).
// Fallback is retryable/timeout only (orchestrator); deterministic
// bypass and parseAiResponse remain in the engine flow.
function getEnvVar(name: string): string | undefined {
  return process.env[name];
}

// Last telemetry from the most recent LLM turn — surfaced to the
// engine's readAiTelemetry (AI_TURN rich record). Null when the last
// turn used the deterministic fallback or had no telemetry.
let lastTelemetryValue: AiTelemetry | null = null;
let lastProviderNameInner = "policy-backed";

const policyBackedAi: ConversationAi = {
  get providerName() {
    return lastProviderNameInner;
  },
  async respond(request: AiRequest) {
    const liveAi = await createPolicyBackedAi({
      getEnvVar,
      fetchImpl: globalThis.fetch as unknown as typeof fetch,
    });
    // Keep providerName honest for deferred / handoff reporting
    lastProviderNameInner = liveAi.providerName;
    const maybe = liveAi as unknown as { getLastTelemetry?: () => unknown };
    let result: AiResponse;
    try {
      result = await liveAi.respond(request);
    } catch (error) {
      // Preserve telemetry even on controlled failure (engine maps
      // null → NEED_HUMAN). Capture before re-throwing.
      if (typeof maybe.getLastTelemetry === "function") {
        try {
          const t = maybe.getLastTelemetry();
          if (
            t &&
            typeof t === "object" &&
            "finalProvider" in (t as Record<string, unknown>)
          ) {
            lastTelemetryValue = t as AiTelemetry;
            if (lastTelemetryValue.finalProvider)
              lastProviderNameInner = lastTelemetryValue.finalProvider;
          }
        } catch {
          // telemetry is best-effort
        }
      }
      throw error;
    }
    if (typeof maybe.getLastTelemetry === "function") {
      try {
        const t = maybe.getLastTelemetry();
        if (
          t &&
          typeof t === "object" &&
          "finalProvider" in (t as Record<string, unknown>)
        ) {
          lastTelemetryValue = t as AiTelemetry;
          if (
            lastTelemetryValue.finalProvider &&
            lastTelemetryValue.finalProvider !== "deterministic-bypass"
          ) {
            lastProviderNameInner = lastTelemetryValue.finalProvider;
          } else if (
            lastTelemetryValue.finalProvider === "deterministic-bypass"
          ) {
            lastProviderNameInner = "deterministic-bypass";
          }
        } else {
          lastTelemetryValue = null;
        }
      } catch {
        lastTelemetryValue = null;
      }
    } else {
      lastTelemetryValue = null;
    }
    return result;
  },
  // Exposed for the engine's readAiTelemetry (LLM path); deterministic
  // fallback has no telemetry.
  getLastTelemetry(): AiTelemetry | null {
    return lastTelemetryValue;
  },
} as unknown as ConversationAi & { getLastTelemetry(): AiTelemetry | null };

export type ConversationEngineDeps = {
  businessRepository: Pick<BusinessRepository, "findByWhatsappNumber"> &
    Partial<Pick<BusinessRepository, "findById">>;
  branchRepository: Pick<BranchRepository, "findDefaultByBusiness"> &
    Partial<Pick<BranchRepository, "findByIdWithinBusiness">>;
  customerRepository: Pick<
    CustomerRepository,
    "upsertByPhone" | "touchConversation"
  >;
  conversationRepository: Pick<
    ConversationRepository,
    | "findLatestByCustomer"
    | "findById"
    | "create"
    | "addMessage"
    | "getMessages"
    | "update"
    | "updateWorkflow"
  >;
  serviceRepository: Pick<ServiceRepository, "listByBusiness"> &
    Partial<Pick<ServiceRepository, "findById">>;
  inboundDedupeRepository: Pick<InboundDedupeRepository, "claim">;
  usageRepository: Pick<UsageRepository, "record">;
  /**
   * OPTIONAL (PROMPT-B04): the operator-attention seam. When present, a
   * turn that ends in NEED_HUMAN records an idempotent attention row so the
   * operator is informed. Offline engine harnesses that do not exercise the
   * notification layer may omit it (the same optionality convention as
   * `providerRepository` / `appointmentRepository`).
   */
  attentionRepository?: Pick<OperatorAttentionRepository, "open">;
  /**
   * OPTIONAL (PROMPT-AI-ARCH-18 — Slice 9): the RECORD-ONLY knowledge-gap
   * seam. When present, a turn whose authoritative cause is
   * `KNOWLEDGE_GAP_UNRESOLVED` records ONE bounded gap observation AFTER the
   * customer reply was persisted + sent. It is off the critical path and
   * best-effort: a missing or failing repository can never block, retry, or
   * alter the turn. Offline engine harnesses may omit it (the same
   * optionality convention as `attentionRepository`).
   */
  knowledgeGapRepository?: Pick<KnowledgeGapRepository, "record">;
  /**
   * OPTIONAL (PROMPT-AI-OPS-22): the fail-open turn-evidence sink. When
   * present, ONE bounded, content-free evidence record is emitted for every
   * finished turn, strictly AFTER the reply was persisted + sent. It is off
   * the critical path and best-effort: a missing or failing sink can never
   * block, retry, or alter the turn (the same optionality convention as
   * `attentionRepository` / `knowledgeGapRepository`). Offline engine
   * harnesses may omit it to keep their output silent.
   */
  turnTelemetry?: TurnTelemetrySink;
  /**
   * OPTIONAL (CONV-CORE-01): the durable ConversationState store (typed
   * offers + customer facts). When absent — offline harnesses, or a database
   * the migration has not reached yet — the engine keeps the legacy,
   * history-derived behaviour byte-for-byte.
   */
  conversationStateRepository?: ConversationStateStore;
  providerRepository?: Pick<
    ProviderRepository,
    "listEligibleForService" | "listAssignmentSeams"
  >;
  appointmentRepository?: Pick<
    AppointmentRepository,
    "listBlockingByAssignees"
  > &
    Partial<
      Pick<
        AppointmentRepository,
        "createWithConflictCheck" | "listRecentByCustomer"
      >
    >;
  followUpRequestRepository?: Pick<
    FollowUpRequestRepository,
    "getEligibleForChannel" | "findById" | "updateStatus"
  >;
  ai: ConversationAi;
  transport: MessageTransport;
};

/** Production dependencies (app singletons + offline boundaries). */
export const defaultConversationEngineDeps: ConversationEngineDeps = {
  businessRepository,
  branchRepository,
  customerRepository,
  conversationRepository,
  serviceRepository,
  inboundDedupeRepository,
  usageRepository,
  attentionRepository: operatorAttentionRepository,
  knowledgeGapRepository,
  turnTelemetry: turnTelemetrySink,
  conversationStateRepository,
  providerRepository,
  appointmentRepository,
  followUpRequestRepository,
  ai: policyBackedAi,
  transport: offlineMessageTransport,
};

/**
 * Server-resolved inbound identity supplied by a provider adapter AFTER
 * its own tenant resolution (e.g. the Meta route: phone_number_id →
 * WhatsAppConnection → Business/Branch). It is an in-process argument,
 * NEVER part of the inbound JSON contract — a webhook body can never
 * supply it. The engine still re-loads the Business from the repository
 * and enforces `isActive`; the hint only replaces the phone-number
 * lookup when the provider identity is authoritative.
 */
export type ResolvedInboundIdentity = {
  businessId: string;
  connectionId?: string | null;
  branchId?: string | null;
};

async function resolveInboundBusiness(
  deps: ConversationEngineDeps,
  inbound: InboundMessageInput,
  resolvedIdentity?: ResolvedInboundIdentity,
) {
  if (resolvedIdentity?.businessId) {
    const findById = deps.businessRepository.findById;
    if (!findById) return null;
    return findById.call(deps.businessRepository, resolvedIdentity.businessId);
  }
  return deps.businessRepository.findByWhatsappNumber(
    canonicalPhone(inbound.to),
  );
}

// ─── Typed results ───────────────────────────────────────────────────────────

export type InboundFailureCode =
  | "VALIDATION"
  | "BUSINESS_NOT_FOUND"
  | "BUSINESS_INACTIVE"
  | "PERSISTENCE_FAILED";

export type InboundFailure = {
  ok: false;
  code: InboundFailureCode;
  message: string;
};

/** How the engine answered the inbound message. */
export type AssistantAction =
  /** The assistant replied autonomously (thread stays AI_ACTIVE). */
  | "AI_REPLY"
  /** The assistant handed the thread to staff (NEED_HUMAN). */
  | "AI_HANDOFF"
  /** The thread is not AI-eligible; the message went to staff attention. */
  | "DEFERRED_TO_STAFF";

export type InboundSuccess = {
  ok: true;
  /** False — this delivery was processed (not a duplicate). */
  duplicate: false;
  /** The tenant that owns this turn — server-derived, never client input. */
  businessId: string;
  conversationId: string;
  customerId: string;
  /** The persisted CUSTOMER message id. */
  customerMessageId: string;
  assistantAction: AssistantAction;
  /** Classified intent when the AI ran; null when deferred to staff. */
  intent: AiResponse["intent"] | null;
  conversationStatus: ConversationStatus;
  /**
   * The canonical TYPED cause when this turn ended in a handoff
   * (PROMPT-AI-ARCH-16 — Slice 7), or `null` when the turn did not hand off.
   * Explanatory ONLY: it is derived AFTER the authoritative engine/resolver
   * decision and can never change the turn's outcome. A staff-owned thread
   * (`DEFERRED_TO_STAFF`) intentionally carries NO cause — the taxonomy
   * describes why the ASSISTANT needed a human, not a staff routing.
   */
  handoffCause: HandoffCause | null;
  /** Assistant provider that answered (honest reporting). */
  assistantProvider: string;
  /**
   * ADDITIVE structured observables for the turn (PROMPT-AI-ARCH-02 Slice 0).
   * Optional: a producer that cannot observe a field omits it, and every
   * existing caller keeps working unchanged. Machine keys / bounded labels
   * only — never content, prompts, secrets, or chain-of-thought.
   */
  observability?: TurnObservability;
  /**
   * The RECORD-ONLY knowledge-gap observation created for this turn
   * (PROMPT-AI-ARCH-18 — Slice 9), or absent when the turn was not an
   * authoritative unresolved knowledge gap or the best-effort recording did
   * not happen. It is set AFTER the turn completed and the reply was sent,
   * carries a machine key only (never content), and never affects any other
   * field of the result.
   */
  knowledgeGap?: { id: string; category: KnowledgeGapCategory } | null;
  /** Best-effort outbound delivery report (null when nothing was sent). */
  delivery: { provider: string; delivered: boolean; error?: string } | null;
};

/**
 * Idempotent redelivery of an already-processed message: the ORIGINAL
 * conversation/message ids, zero new side effects. Webhook retries get
 * a 200 — they must not duplicate business actions (DECISIONS #34).
 */
export type InboundDuplicate = {
  ok: true;
  duplicate: true;
  conversationId: string;
  customerMessageId: string;
};

export type InboundResult = InboundFailure | InboundSuccess | InboundDuplicate;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * PROMPT-AI-OPS-22 — the deployment metadata stamped on every turn-evidence
 * record. Environment is the runtime deployment context (never a secret) and
 * the app version is the shipped release a turn ran on, so a record is always
 * attributable to the exact build that produced it.
 */
const TURN_EVIDENCE_META = {
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
  appVersion: pkg.version,
} as const;

const VALIDATION_MESSAGE = "بيانات الرسالة الواردة غير صالحة";
const BUSINESS_NOT_FOUND_MESSAGE = "تعذر تحديد المنشأة المستقبلة للرسالة";
const BUSINESS_INACTIVE_MESSAGE = "المنشأة غير مفعّلة حالياً";
const PERSISTENCE_FAILED_MESSAGE = "تعذر حفظ الرسالة الآن";

// Booking seam — Arabic customer-facing messages (no secrets, no chain-of-thought).
function bookingEligibilityErrorMessage(code: string): string {
  switch (code) {
    case "SERVICE_NOT_FOUND":
      return "الخدمة المطلوبة غير موجودة — يرجى التأكد من اسم الخدمة.";
    case "SERVICE_INACTIVE":
      return "الخدمة المطلوبة غير متاحة للحجز حالياً — سيتواصل معك أحد أعضاء الفريق.";
    case "BRANCH_NOT_FOUND":
      return "الفرع المطلوب غير موجود — سيتواصل معك أحد أعضاء الفريق.";
    case "NO_BUSINESS":
      return "أكمل إعداد المنشأة أولاً — سيتواصل معك أحد أعضاء الفريق.";
    case "INVALID_INPUT":
      return "بيانات الحجز غير مكتملة — سيتواصل معك أحد أعضاء الفريق.";
    default:
      return "تعذر إتمام الحجز حالياً — سيتواصل معك أحد أعضاء الفريق.";
  }
}
function bookingOptionsErrorMessage(code: string): string {
  if (code === "PROVIDER_NOT_ELIGIBLE")
    return "المزود المطلوب غير متاح لهذه الخدمة — يرجى اختيار مزود آخر أو اختيار أي مزود متاح.";
  return bookingEligibilityErrorMessage(code);
}
function bookingEmptyReasonMessage(reason: string, date: string): string {
  switch (reason) {
    case "NO_ELIGIBLE_PROVIDERS":
      return "لا يوجد مزود متاح لهذه الخدمة حالياً — سيتواصل معك أحد أعضاء الفريق.";
    case "BUSINESS_CLOSED":
      return `المنشأة مغلقة يوم ${date} — يرجى اختيار تاريخ آخر.`;
    case "SERVICE_TOO_LONG":
      return "مدة الخدمة أطول من ساعات العمل في ذلك اليوم — يرجى اختيار خدمة أخرى أو تاريخ آخر.";
    case "FULLY_BOOKED":
      return `جميع المواعيد محجوزة يوم ${date} — يرجى اختيار تاريخ آخر أو سيتواصل معك الفريق.`;
    default:
      return "لا تتوفر مواعيد حالياً — سيتواصل معك أحد أعضاء الفريق.";
  }
}
export function formatBookingOptionsMessage(
  serviceName: string,
  date: string,
  options: Array<{
    displayName: string;
    startAt?: string;
    endAt?: string;
    start?: string;
    end?: string;
    startTime?: string;
    endTime?: string;
    providerId?: string;
    index?: number;
  }>,
  followUpRequestId?: string | null,
): string {
  const lines = options.map((opt, idx) => {
    const start = opt.startAt
      ? opt.startAt.slice(11, 16)
      : (opt.start ?? opt.startTime ?? "");
    const end = opt.endAt
      ? opt.endAt.slice(11, 16)
      : (opt.end ?? opt.endTime ?? "");
    return `${idx + 1}. ${opt.displayName} — ${start} إلى ${end}`;
  });
  const followUpTag = followUpRequestId
    ? `\n[متابعة: ${followUpRequestId}]`
    : "";
  const header = followUpRequestId
    ? `تتوفر المواعيد التالية لمتابعة "${serviceName}" يوم ${date}:`
    : `تتوفر المواعيد التالية لخدمة "${serviceName}" يوم ${date}:`;
  return `${header}\n${lines.join("\n")}${followUpTag}\nيرجى اختيار أحد الخيارات وسيتواصل معك الفريق لإتمام الحجز.`;
}

/** Canonical phone form for the number-mapping lookup (digits + leading +). */
function canonicalPhone(phone: string): string {
  return phone.replace(/[\s-]/g, "");
}

/**
 * Provider-neutral, tenant-safe external message key: the transport's
 * message id when provided, else a deterministic SHA-256 of the
 * canonical payload (identical redeliveries hash identically; different
 * businesses never collide — the business id is part of the hash AND
 * part of the unique constraint).
 */
function externalMessageKey(
  businessId: string,
  inbound: InboundMessageInput,
): string {
  if (inbound.externalId) return inbound.externalId;
  return createHash("sha256")
    .update(
      `${businessId}|${canonicalPhone(inbound.to)}|${canonicalPhone(inbound.from)}|${inbound.text}|${inbound.receivedAt}`,
    )
    .digest("hex");
}

/** Placeholder identity for a brand-new inbound WhatsApp contact. */
function inboundCustomerName(phone: string): string {
  const digits = phone.replace(/[^\d]/g, "");
  return `عميل ${digits.slice(-4) || phone}`;
}

/** Best-effort usage telemetry — never fails the turn, never throws up. */
async function recordUsage(
  deps: ConversationEngineDeps,
  input: RecordUsageDto,
): Promise<void> {
  try {
    await deps.usageRepository.record(input);
  } catch {
    // Telemetry is observability, not a business action.
  }
}

function readAiTelemetry(ai: ConversationAi): AiTelemetry | null {
  const maybe = ai as unknown as { getLastTelemetry?: () => unknown };
  if (typeof maybe.getLastTelemetry !== "function") return null;
  try {
    const value = maybe.getLastTelemetry();
    if (
      value &&
      typeof value === "object" &&
      "finalProvider" in (value as Record<string, unknown>)
    ) {
      return value as AiTelemetry;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The B-01/B-02 SOURCE CLASSES of the facts that actually entered the request
 * (closed `KnowledgeFactSource` machine keys — never content). Additive
 * observability (PROMPT-AI-ARCH-02 Slice 0) only; it changes no context
 * decision and carries nothing customer-visible.
 */
function includedKnowledgeSources(
  facts: ReadonlyArray<{ included: boolean; source: string }>,
): string[] {
  return [
    ...new Set(
      facts.filter((fact) => fact.included).map((fact) => fact.source),
    ),
  ];
}

/**
 * Conversation State foundation (PROMPT-AI-ARCH-04 — Slice 2).
 *
 * Derive the engine-owned `ConversationState` from the already-persisted
 * history (the EXISTING persistence seam) and merge it ADDITIVELY with the
 * current turn's facts — the Slice-0 `factUpdates` plus the structured
 * `extraction`, fed uniformly through the ONE pure merge function
 * (`state + factUpdates → nextState`). It performs ZERO model inference, no
 * I/O, no persistence, and NO behavior change: the resulting state is only
 * projected into the additive Slice-0 observability as a content-free
 * `stateTransition` (bounded machine keys only — never message content). The
 * state is NOT yet authoritative over domain state; later slices consume it.
 *
 * Best-effort and total: a state-derivation error can never fail a customer
 * turn (same contract as usage telemetry).
 */
function observeConversationStateTransition(
  recentChronological: ReadonlyArray<{ senderType: string; content: string }>,
  decision: AiResponse | null,
): TurnStateTransitionObservation | undefined {
  if (!decision) return undefined;
  try {
    const base = deriveConversationStateFromHistory(recentChronological);
    const { transitions } = mergeConversationState(base, {
      factUpdates: [
        ...factUpdatesFromExtraction(decision.extraction),
        ...(decision.factUpdates ?? []),
      ],
      turnGoal: decision.intent,
      ...(decision.goals ? { goals: decision.goals } : {}),
    });
    const transition = transitions[0];
    if (!transition) return undefined;
    return {
      from: transition.from,
      to: transition.to,
      ...(transition.factKey ? { factKey: transition.factKey } : {}),
      ...(transition.isRevision !== undefined
        ? { isRevision: transition.isRevision }
        : {}),
    };
  } catch {
    // Conversation State is orchestration observability, not a business
    // action — a derivation error must never surface to the customer.
    return undefined;
  }
}

/**
 * Decision / Action Resolver (PROMPT-AI-ARCH-05 — Slice 3; CLARIFY activated
 * in PROMPT-AI-ARCH-06 — Slice 4).
 *
 * Run the ONE deterministic resolver for the finished turn and return its
 * `ResolvedTurn`. The resolver combines the normalized AI decision, the
 * engine-owned `ConversationState` (derived from the already-persisted history
 * + this turn's facts, seeded with any PENDING clarification reconstructed
 * from history so a resume is reflected), the existing deterministic/control
 * routing, and the existing safety/handoff constraints into ONE ordered plan.
 *
 * The plan is projected into observability (the SAME canonical `AiTurnPlan`).
 * Its `decisionClass` is now AUTHORITATIVE for ONE new branch only — a
 * first-class `CLARIFY` turn, which the engine emits as ONE bounded question
 * (AI_ACTIVE) instead of escalating. Every other decision class leaves the
 * existing execution path (booking seam, disclosure gate, reply/handoff)
 * authoritative and byte-for-byte unchanged. No additional model inference is
 * performed (the resolver is pure); the zero-or-one generative call invariant
 * holds. The domain outcome is passed as `PENDING`: the resolver never
 * computes availability/eligibility — the DOMAIN (CORE-01/CORE-02) stays
 * authoritative. Best-effort and total: a resolution error can never fail a
 * customer turn.
 */
function resolveFinishedTurn(
  recentChronological: ReadonlyArray<{ senderType: string; content: string }>,
  decision: AiResponse | null,
  routing: AiRoutingDecision,
  currentMessage: string,
  now: Date,
  timezone: string,
  /**
   * The turn's provider telemetry (PROMPT-AI-JEV-03B §8). For a semantic-JEV
   * turn it carries the validated JEV-derived resolver signals; for every other
   * turn it is unused and the lexical detector stays authoritative.
   */
  turnTelemetry?: AiTelemetry | null,
  priorState?: ConversationState | null,
): { plan: ResolvedTurn; state: ConversationState } | null {
  if (!decision) return null;
  try {
    // Deterministic, authoritative control/safety signals for THIS turn
    // (PROMPT-AI-EVAL-07). Reused by value from the SAME keyword tables the
    // deterministic classifier applies — no new classifier, no model call.
    //
    // PROMPT-AI-JEV-03B §8: for a turn the SEMANTIC JEV strategy owns, the
    // validated JEV-derived signals are fed to the ONE resolver instead. The
    // lexical detector MUST NOT run afterward and overwrite the JEV semantic
    // reading for a JEV-owned turn — but the ONE resolver still runs exactly
    // once and still decides the actual action (JEV never calls it). For every
    // other turn the lexical detector stays authoritative (the exact
    // pre-AI-JEV-03 behaviour).
    const semanticSignals =
      routing === "JEV"
        ? turnTelemetry?.jevDecision?.semantic?.signals
        : undefined;
    const signals = semanticSignals ?? detectTurnControlSignals(currentMessage);

    const base =
      priorState ?? deriveConversationStateFromHistory(recentChronological);
    // Reconstruct a pending clarification from history (migration-safe §9) so
    // the resumed state reflects what the engine actually asked last turn.
    const pending = derivePendingClarification(recentChronological);
    // Reconstruct a pending DOMAIN goal from an earlier answer-and-continue
    // turn (PROMPT-AI-ARCH-09 — Slice 5), from the same migration-safe history
    // marker — so a deferred booking goal SURVIVES into this turn's state.
    const pendingContinuation = derivePendingContinuation(recentChronological);
    const seededPendingGoals = pendingContinuation
      ? [
          {
            kind: "DOMAIN_ACTION",
            intent: pendingContinuation.intent,
            active: false,
          } as const,
        ]
      : base.pendingGoals;
    const seeded = {
      ...base,
      pendingGoals: seededPendingGoals,
      ...(pending
        ? {
            missingFacts: pending.missingFacts,
            lastClarification: { type: pending.type },
          }
        : {}),
    };

    const factUpdates = [
      ...factUpdatesFromExtraction(decision.extraction),
      ...(decision.factUpdates ?? []),
    ];

    // SUPPLIED-FACT RESUME binding (PROMPT-AI-EVAL-07). When a clarification is
    // pending for exactly ONE conversation fact and the model's extraction did
    // NOT already supply it, bind the current customer turn as that fact so the
    // clarification RESOLVES through the ONE merge path (never a second fact
    // model). Gated to a plain CONTINUATION answer: a sensitive / explicit-human
    // turn keeps safety precedence, and an explicit escalation (the model asked
    // for a human) is a benign interruption to PRESERVE (rule 6), never a fact —
    // so neither is silently bound as a booking fact.
    const modelEscalatesHuman =
      decision.intent === "HUMAN_REQUEST" ||
      decision.handoffReason === "HUMAN_REQUEST";
    if (
      pending &&
      pending.missingFacts.length === 1 &&
      !signals.sensitive &&
      !signals.explicitHuman &&
      !modelEscalatesHuman
    ) {
      const missing = pending.missingFacts[0]!;
      const alreadySupplied =
        factUpdates.some((u) => u.key === missing) ||
        base.knownFacts[missing] != null;
      const trimmed = currentMessage.trim();
      if (!alreadySupplied && trimmed.length > 0) {
        // SUPPLIED COLLOQUIAL DATE (PROMPT-AI-ARCH-08). When the pending fact is
        // the booking DATE and the customer supplied it in a supported
        // colloquial Egyptian relative form («الخميس», «بكرة», «بعد بكرة»…),
        // normalize it to the ISO `YYYY-MM-DD` the booking DOMAIN requires so
        // the supplied fact BINDS deterministically (never re-clarified) and
        // the booking advances. The AI contract can only carry ISO, so this
        // normalization is the engine's (Conversation orchestration's) job —
        // the DOMAIN still re-validates and executes. A non-colloquial answer
        // (a verbatim ISO date, or a free-form service) keeps the existing
        // raw-bind behavior.
        let value = trimmed;
        if (missing === "date") {
          const iso = resolveEgyptianRelativeDate(
            currentMessage,
            todayIsoInTimeZone(now, timezone),
          );
          if (iso) value = iso;
        }
        factUpdates.push({ key: missing, value });
      }

      // Preserve prior date and time-of-day preferences from recent customer messages
      const todayIso = todayIsoInTimeZone(now, timezone);
      if (!factUpdates.some((u) => u.key === "date") && !base.knownFacts.date) {
        for (let i = recentChronological.length - 1; i >= 0; i--) {
          const m = recentChronological[i]!;
          if (m.senderType === "CUSTOMER") {
            const rel = resolveEgyptianRelativeDate(m.content, todayIso);
            if (rel) {
              factUpdates.push({ key: "date", value: rel });
              break;
            }
            const iso = m.content.match(/\b\d{4}-\d{2}-\d{2}\b/);
            if (iso) {
              factUpdates.push({ key: "date", value: iso[0] });
              break;
            }
          }
        }
      }
      if (
        !factUpdates.some((u) => u.key === "timePreference") &&
        !base.knownFacts.timePreference
      ) {
        for (let i = recentChronological.length - 1; i >= 0; i--) {
          const m = recentChronological[i]!;
          if (m.senderType === "CUSTOMER") {
            const pref = extractTimeOfDayPreference(m.content);
            if (pref) {
              factUpdates.push({ key: "timePreference", value: pref });
              break;
            }
          }
        }
      }
    }

    const { state } = mergeConversationState(seeded, {
      factUpdates,
      turnGoal: decision.intent,
      ...(decision.goals ? { goals: decision.goals } : {}),
    });
    const plan = resolveTurnPlan({
      decision,
      state,
      routing,
      domain: { kind: "PENDING" },
      signals,
    });
    return { plan, state };
  } catch {
    // The resolver is orchestration — a resolution error must never surface to
    // the customer; the existing execution path then owns the turn.
    return null;
  }
}

/** The ISO date form (YYYY-MM-DD) the booking domain requires. */
const RESUME_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Supplement a booking AI response's extraction with facts the customer already
 * supplied for a pending booking clarification (merged into ConversationState)
 * but that the model omitted on THIS turn (PROMPT-AI-EVAL-07 supplied-fact
 * resume). The model's own extraction ALWAYS wins when present; a date is only
 * supplemented when it is ISO-shaped (the domain's required form). Pure and
 * additive — the DOMAIN still resolves/validates every fact and executes.
 */
function resumeBookingExtraction(
  response: AiResponse,
  state: ConversationState,
): AiResponse {
  const e = response.extraction;
  const serviceChanged = Boolean(
    e.service &&
    state.knownFacts.service &&
    e.service !== state.knownFacts.service,
  );
  const dateChanged = Boolean(
    e.date && state.knownFacts.date && e.date !== state.knownFacts.date,
  );
  const providerChanged = Boolean(
    e.provider &&
    state.knownFacts.provider &&
    e.provider !== state.knownFacts.provider,
  );

  const service = e.service ?? state.knownFacts.service ?? null;
  const provider = serviceChanged
    ? (e.provider ?? null)
    : (e.provider ?? state.knownFacts.provider ?? null);
  const timePreference =
    serviceChanged || dateChanged || providerChanged
      ? (e.timePreference ?? null)
      : (e.timePreference ?? state.knownFacts.timePreference ?? null);

  const stateDate = serviceChanged ? null : (state.knownFacts.date ?? null);
  const date =
    e.date ?? (stateDate && RESUME_ISO_DATE.test(stateDate) ? stateDate : null);
  if (
    service === e.service &&
    provider === e.provider &&
    timePreference === e.timePreference &&
    date === e.date
  ) {
    return response; // nothing to supplement — unchanged
  }
  return {
    ...response,
    extraction: { ...e, service, provider, date, timePreference },
  };
}

async function persistAssistantReply(
  deps: ConversationEngineDeps,
  conversationId: string,
  content: string,
  status: ConversationStatus,
): Promise<{ id: string }> {
  return deps.conversationRepository.addMessage(
    { conversationId, senderType: "AI", content },
    { status },
  ) as Promise<{ id: string }>;
}
async function deliverAssistantReply(
  deps: ConversationEngineDeps,
  customerPhone: string,
  businessName: string,
  conversationId: string,
  content: string,
  assistantMessageId: string,
  businessId: string,
  connectionId: string | null,
  replyMarkup?: Record<string, unknown>,
): Promise<InboundSuccess["delivery"]> {
  let delivery: InboundSuccess["delivery"] = null;
  try {
    const sent = await deps.transport.send({
      to: customerPhone,
      businessId,
      businessName,
      conversationId,
      content,
      connectionId: connectionId ?? undefined,
      ...(replyMarkup ? { replyMarkup } : {}),
    });
    delivery = {
      provider: sent.provider,
      delivered: sent.delivered,
      ...(sent.error ? { error: sent.error } : {}),
    };
  } catch (error) {
    delivery = {
      provider: deps.transport.providerName,
      delivered: false,
      error: error instanceof Error ? error.message : "transport error",
    };
  }
  await recordUsage(deps, {
    businessId,
    kind: "OUTBOUND_MESSAGE",
    conversationId,
    messageId: assistantMessageId,
    provider: delivery.provider,
    status: delivery.delivered ? "SUCCESS" : "FAILURE",
    occurredAt: new Date(),
  });
  return delivery;
}

function buildEligibilityDeps(deps: ConversationEngineDeps) {
  return {
    serviceRepository: {
      findById: async (id: string) => {
        const byId = (
          deps.serviceRepository as unknown as {
            findById?: (id: string) => Promise<unknown>;
          }
        ).findById;
        if (byId) return byId.call(deps.serviceRepository, id);
        return serviceRepository.findById(id);
      },
    },
    branchRepository: {
      findByIdWithinBusiness: async (id: string, bId: string) => {
        const fn = (
          deps.branchRepository as unknown as {
            findByIdWithinBusiness?: (
              id: string,
              bId: string,
            ) => Promise<unknown>;
          }
        ).findByIdWithinBusiness;
        if (fn) return fn.call(deps.branchRepository, id, bId);
        return branchRepository.findByIdWithinBusiness(id, bId);
      },
    },
    providerRepository: {
      listEligibleForService: async (
        bId: string,
        sId: string,
        opts?: { branchId?: string },
      ) => {
        const repo = deps.providerRepository ?? providerRepository;
        return (
          repo as unknown as {
            listEligibleForService: (
              bId: string,
              sId: string,
              opts?: { branchId?: string },
            ) => Promise<unknown[]>;
          }
        ).listEligibleForService(bId, sId, opts);
      },
    },
  };
}

function buildBookingDeps(
  deps: ConversationEngineDeps,
  eligibilityDeps: ReturnType<typeof buildEligibilityDeps>,
) {
  return {
    eligibility: eligibilityDeps,
    businessRepository: {
      findById: async (id: string) => {
        const fn = (
          deps.businessRepository as unknown as {
            findById?: (id: string) => Promise<unknown>;
          }
        ).findById;
        if (fn) return fn.call(deps.businessRepository, id);
        return businessRepository.findById(id);
      },
    },
    serviceRepository: {
      findById: async (id: string) => {
        const fn = (
          deps.serviceRepository as unknown as {
            findById?: (id: string) => Promise<unknown>;
          }
        ).findById;
        if (fn) return fn.call(deps.serviceRepository, id);
        return serviceRepository.findById(id);
      },
    },
    providerRepository: {
      listAssignmentSeams: async (bId: string, ids: string[]) => {
        const repo = deps.providerRepository ?? providerRepository;
        return (
          repo as unknown as {
            listAssignmentSeams: (
              bId: string,
              ids: string[],
            ) => Promise<unknown[]>;
          }
        ).listAssignmentSeams(bId, ids);
      },
    },
    appointmentRepository: {
      listBlockingByAssignees: async (
        bId: string,
        date: string,
        ids: string[],
      ) => {
        const repo = deps.appointmentRepository ?? appointmentRepository;
        return (
          repo as unknown as {
            listBlockingByAssignees: (
              bId: string,
              date: string,
              ids: string[],
            ) => Promise<unknown[]>;
          }
        ).listBlockingByAssignees(bId, date, ids);
      },
    },
  };
}

async function resolveAssigneeId(
  deps: ConversationEngineDeps,
  businessId: string,
  providerId: string,
): Promise<string | null> {
  const repo = deps.providerRepository ?? providerRepository;
  const seams = await (
    repo as unknown as {
      listAssignmentSeams: (
        bId: string,
        ids: string[],
      ) => Promise<Array<{ providerId: string; userId: string }>>;
    }
  ).listAssignmentSeams(businessId, [providerId]);
  return seams.find((s) => s.providerId === providerId)?.userId ?? null;
}

type BookingCreationOutcome =
  | { status: "created"; appointmentId: string }
  | { status: "conflict" }
  | { status: "invalid_follow_up" }
  | { status: "failed" };

/**
 * Canonical appointment write for the conversation close-the-loop: the
 * EXISTING `createWithConflictCheck` (SERIALIZABLE + retry) — never a
 * parallel booking implementation. `null` is the domain's typed
 * slot-conflict signal; a thrown error (or a missing seam in offline
 * deps) is an unexpected failure that must never surface as a
 * confirmation.
 */
async function createAppointmentForSelection(
  deps: ConversationEngineDeps,
  dto: {
    businessId: string;
    customerId: string;
    serviceId: string;
    branchId: string;
    assignedUserId: string;
    providerId?: string;
    date: string;
    startTime: string;
    endTime: string;
    status: string;
    followUpRequestId?: string | null;
  },
): Promise<BookingCreationOutcome> {
  const repo = deps.appointmentRepository ?? appointmentRepository;
  const create = (
    repo as unknown as {
      createWithConflictCheck?: (
        dto: unknown,
      ) => Promise<{ id: string } | null>;
    }
  ).createWithConflictCheck;
  if (typeof create !== "function") return { status: "failed" };
  try {
    const appointment = await create.call(repo, dto);
    if (!appointment) return { status: "conflict" };
    return { status: "created", appointmentId: appointment.id };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.message === "FOLLOW_UP_NOT_PENDING" ||
        err.message === "FOLLOW_UP_DATE_OUT_OF_RANGE")
    ) {
      return { status: "invalid_follow_up" };
    }
    return { status: "failed" };
  }
}

/** Server-derived scope the deterministic selection operates on. */
type BookingSelectionScope = {
  business: {
    id: string;
    name: string;
    confirmationMode: string;
    defaultBranchId: string | null;
  };
  conversation: Conversation;
  customer: { id: string; phone: string };
  customerMessageId: string;
  /** Server-resolved sending connection (provider identity path). */
  connectionId: string | null;
  services: ReadonlyArray<{
    id: string;
    name: string;
    durationMinutes: number;
  }>;
};

/**
 * Persist + deliver one selection-phase reply. `BOOKED` is applied
 * through `addMessage`'s transactional workflow — the canonical
 * conversation state transition (no parallel status write).
 */
async function selectionReply(
  deps: ConversationEngineDeps,
  scope: BookingSelectionScope,
  content: string,
  status: "AI_ACTIVE" | "NEED_HUMAN" | "BOOKED",
  cause: HandoffCause | null = null,
  replyMarkup?: Record<string, unknown>,
): Promise<InboundSuccess> {
  const assistantMessage = await persistAssistantReply(
    deps,
    scope.conversation.id,
    content,
    status,
  );
  const delivery = await deliverAssistantReply(
    deps,
    scope.customer.phone,
    scope.business.name,
    scope.conversation.id,
    content,
    assistantMessage.id,
    scope.business.id,
    scope.connectionId,
    replyMarkup,
  );
  return {
    ok: true,
    duplicate: false,
    businessId: scope.business.id,
    conversationId: scope.conversation.id,
    customerId: scope.customer.id,
    customerMessageId: scope.customerMessageId,
    assistantAction: status === "NEED_HUMAN" ? "AI_HANDOFF" : "AI_REPLY",
    intent: "BOOKING",
    conversationStatus: status,
    handoffCause: status === "NEED_HUMAN" ? cause : null,
    assistantProvider: deps.ai.providerName,
    delivery,
  };
}

const BOOKING_RETRY_MESSAGE =
  "تعذر إتمام الحجز الآن — سيتواصل معك أحد أعضاء الفريق.";
const BOOKING_INVALID_INDEX_MESSAGE = "الاختيار غير صالح";
const BOOKING_UNKNOWN_TIME_MESSAGE =
  "الوقت المحدد غير متاح — يرجى اختيار أحد الأوقات المعروضة.";
const BOOKING_AMBIGUOUS_TIME_MESSAGE =
  "هناك أكثر من موعد في ذلك الوقت — يرجى تحديد الاختيار برقمه (1-3).";
const BOOKING_CONFLICT_MESSAGE =
  "عذراً، تم حجز هذا الموعد للتو — يرجى اختيار موعد آخر.";

/**
 * Deterministic booking close-the-loop (PROMPT-AI-03B).
 *
 * The customer selected an option from the canonical offer. This
 * function NEVER calls the LLM and NEVER trusts client/AI identity:
 *
 *   1. resolve Business (caller: inbound number mapping) / Branch
 *      (conversation) / Service (persisted Business-owned rows),
 *   2. re-run CORE-01 `resolveEligibleProviders` fresh,
 *   3. re-run CORE-02 `resolveBookingOptions` fresh,
 *   4. verify the selected option still exists and is bookable,
 *   5. canonical `createWithConflictCheck` (SERIALIZABLE),
 *   6. BOOKED transition + authoritative confirmation via transport.
 *
 * Returns `null` when the text is not safely attributable to a booking
 * selection (e.g. a name-like message that matches no eligible
 * provider) — the normal AI turn then handles it. Every unsafe,
 * stale, ambiguous, empty or conflicting outcome answers safely with
 * ZERO appointment write.
 */
async function completeBookingSelection(
  deps: ConversationEngineDeps,
  scope: BookingSelectionScope,
  context: BookingSelectionContext,
  selection: BookingSelection,
  turnSession?: TurnStateSession,
): Promise<InboundSuccess | null> {
  const isTelegram = scope.customer.phone.startsWith("tg:");
  const reply = (
    content: string,
    status: "AI_ACTIVE" | "NEED_HUMAN" | "BOOKED",
    cause: HandoffCause | null = null,
    replyMarkup?: Record<string, unknown>,
  ) => selectionReply(deps, scope, content, status, cause, replyMarkup);

  // 1. Service — matched ONLY against the persisted Business services
  //    (the offer's service name is the selector, never an id source).
  const serviceMatch = matchServiceByName(
    context.serviceName,
    scope.services.map((service) => ({
      id: service.id,
      name: service.name,
    })),
  );
  if (serviceMatch.status !== "ok") {
    return reply(
      serviceMatch.status === "ambiguous"
        ? `هناك أكثر من خدمة تطابق "${context.serviceName}" — يرجى تحديد الخدمة بدقة.`
        : "الخدمة المطلوبة لم تعد متاحة — يرجى تحديد الخدمة مرة أخرى.",
      "AI_ACTIVE",
    );
  }
  const serviceId = serviceMatch.serviceId;
  const serviceName = serviceMatch.serviceName;
  const date = context.date;
  const branchId = (scope.conversation.branchId as string | null) ?? null;

  // 2. CORE-01 — fresh eligibility (server-derived business scope).
  const eligibilityDeps = buildEligibilityDeps(deps);
  const eligibility = await resolveEligibleProviders(
    eligibilityDeps as unknown as Parameters<
      typeof resolveEligibleProviders
    >[0],
    { businessId: scope.business.id },
    { serviceId, ...(branchId ? { branchId } : {}) },
  );
  if (!eligibility.success) {
    return reply(
      bookingEligibilityErrorMessage(eligibility.error.code),
      "NEED_HUMAN",
      eligibilityFailureCodeToCause(eligibility.error.code),
    );
  }

  // 3. Provider-name selections are verified against the FRESH eligible
  //    set; a name-like message that matches no real provider is not a
  //    selection and falls through to the normal AI turn.
  let providerId: string | undefined;
  if (selection.kind === "provider") {
    const isCandidate = isProviderNameCandidate(
      selection.providerText,
      eligibility.data.providers.map((provider) => provider.displayName),
    );
    if (!isCandidate) return null;
    const providerMatch = matchProviderByName(
      selection.providerText,
      eligibility.data.providers,
    );
    if (providerMatch.status === "missing") {
      return reply(
        providerMatch.reason === "ambiguous"
          ? "هناك أكثر من مزود يطابق طلبك — يرجى تحديد المزود بدقة."
          : "المزود المطلوب غير متاح لهذه الخدمة — يرجى اختيار مزود آخر أو اختيار أي مزود متاح.",
        "AI_ACTIVE",
      );
    }
    if (providerMatch.status === "any") return null;
    providerId = providerMatch.providerId;
  }

  // 4. CORE-02 — fresh options (reuses CORE-01 + the availability layer).
  const bookingDeps = buildBookingDeps(deps, eligibilityDeps);
  const bookingResult = await resolveBookingOptions(
    bookingDeps as unknown as Parameters<typeof resolveBookingOptions>[0],
    { userId: scope.customer.id, businessId: scope.business.id },
    {
      serviceId,
      ...(branchId ? { branchId } : {}),
      ...(providerId ? { providerId } : {}),
      date,
    },
  );
  if (!bookingResult.success) {
    return reply(
      bookingOptionsErrorMessage(bookingResult.error.code),
      "NEED_HUMAN",
      "DOMAIN_REQUIRES_HUMAN",
    );
  }
  const freshOptions = bookingResult.data.options;
  if (freshOptions.length === 0) {
    return reply(
      bookingEmptyReasonMessage(bookingResult.reason ?? "FULLY_BOOKED", date),
      "NEED_HUMAN",
      "DOMAIN_REQUIRES_HUMAN",
    );
  }

  // 4b. Deterministic navigation: more times / change date
  if (selection.kind === "more_times") {
    const maxPresentedIndex = context.options.reduce(
      (max, opt) => Math.max(max, opt.index),
      0,
    );
    const unpresented = freshOptions.slice(maxPresentedIndex);
    if (unpresented.length > 0) {
      const nextBatch = unpresented.slice(0, 5);
      let nextOffer: SlotOffer | null = null;
      if (turnSession?.enabled) {
        nextOffer = buildSlotOffer(
          { businessId: scope.business.id, conversationId: scope.conversation.id },
          crypto.randomUUID(),
          {
            serviceId,
            serviceName,
            serviceSource: context.serviceId ? "CUSTOMER" : "DEFAULT",
            providerId: providerId ?? null,
            date,
            followUpRequestId: context.followUpRequestId ?? null,
            shownCount: maxPresentedIndex + nextBatch.length,
            options: nextBatch.map((o) => ({
              providerId: o.providerId,
              displayName: o.displayName,
              startAt: o.startAt,
              endAt: o.endAt,
            })),
          },
          new Date(),
        );
        if (nextOffer) {
          turnSession.state = withPresentedOffer(
            turnSession.state ?? emptyConversationState(),
            nextOffer,
          );
          await turnSession.commit();
        }
      }
      const replyMarkup = isTelegram
        ? nextOffer
          ? slotOfferKeyboard(nextOffer)
          : {
              inline_keyboard: [
                nextBatch.map((_, i) => ({
                  text: `${maxPresentedIndex + i + 1}️⃣ اختيار ${maxPresentedIndex + i + 1}`,
                  callback_data: `opt_${maxPresentedIndex + i + 1}`,
                })),
                [
                  { text: "🔄 أوقات أخرى", callback_data: "more_times" },
                  { text: "📅 يوم آخر", callback_data: "change_date" },
                ],
              ],
            }
        : undefined;
      return reply(
        `إليك أوقاتاً أخرى متاحة لخدمة "${serviceName}" يوم ${date}:\n${formatBookingOptionsMessage(serviceName, date, nextBatch, context.followUpRequestId)}`,
        "AI_ACTIVE",
        null,
        replyMarkup,
      );
    }
    return reply(
      `هذه هي كل المواعيد المتاحة لخدمة "${serviceName}" يوم ${date}. يمكنك اختيار أحدها، أو طلب "يوم آخر".`,
      "AI_ACTIVE",
    );
  }

  if (selection.kind === "change_date") {
    return reply(
      `يرجى تحديد اليوم أو التاريخ الجديد المناسب لك لحجز خدمة "${serviceName}" (مثال: بكرة، الأسبوع القادم، أو اذكر يوماً محدداً):`,
      "AI_ACTIVE",
    );
  }

  // 5. Verify the selected option STILL exists and is bookable.
  let chosen: (typeof freshOptions)[number] | null = null;
  if (selection.kind === "index") {
    const offered = context.options.find(
      (option) => option.index === selection.index,
    );
    if (!offered) {
      if (context.options.length === 0) {
        return reply(
          `لم يعد بإمكاني التأكد من الخيارات المعروضة — إليك المواعيد المتاحة الآن:\n${formatBookingOptionsMessage(serviceName, date, freshOptions)}`,
          "AI_ACTIVE",
        );
      }
      return reply(
        `${BOOKING_INVALID_INDEX_MESSAGE} — يرجى اختيار رقم من 1 إلى ${context.options.length}.`,
        "AI_ACTIVE",
      );
    }
    chosen =
      freshOptions.find(
        (option) =>
          option.startAt.slice(11, 16) === offered.startTime &&
          normalizeArabicText(option.displayName) ===
            normalizeArabicText(offered.displayName),
      ) ?? null;
    if (!chosen) {
      // Stale presentation: the exact offered option is gone.
      return reply(
        `الخيار المحدد لم يعد متاحاً — إليك المواعيد المحدثة:\n${formatBookingOptionsMessage(serviceName, date, freshOptions)}`,
        "AI_ACTIVE",
      );
    }
  } else if (selection.kind === "time") {
    const matches = freshOptions.filter(
      (option) => option.startAt.slice(11, 16) === selection.time,
    );
    if (matches.length === 0) {
      return reply(BOOKING_UNKNOWN_TIME_MESSAGE, "AI_ACTIVE");
    }
    if (matches.length > 1) {
      return reply(BOOKING_AMBIGUOUS_TIME_MESSAGE, "AI_ACTIVE");
    }
    chosen = matches[0] ?? null;
  } else {
    // Provider selection: the provider's earliest currently-available
    // slot (the fresh CORE-02 result is the authority).
    chosen = freshOptions[0] ?? null;
  }
  if (!chosen) {
    return reply(BOOKING_RETRY_MESSAGE, "NEED_HUMAN", "DOMAIN_REQUIRES_HUMAN");
  }

  // 6. Authoritative creation values — server-derived exclusively.
  const startTime = chosen.startAt.slice(11, 16);
  const serviceRow = scope.services.find((service) => service.id === serviceId);
  const endTime =
    addMinutes(startTime, serviceRow?.durationMinutes ?? 30) ??
    chosen.endAt.slice(11, 16);
  const initialStatus =
    scope.business.confirmationMode === "automatic" ? "CONFIRMED" : "PENDING";
  const resolvedBranchId = branchId ?? scope.business.defaultBranchId ?? null;
  const assigneeId = chosen.providerId
    ? await resolveAssigneeId(deps, scope.business.id, chosen.providerId)
    : null;
  if (!resolvedBranchId || !assigneeId) {
    // The booking cannot be routed — the business's branch/assignee setup
    // cannot accept it. An operator can fix this configuration gap.
    return reply(BOOKING_RETRY_MESSAGE, "NEED_HUMAN", "TENANT_CONFIGURATION");
  }

  const followUpRequestId = context.followUpRequestId ?? null;
  if (followUpRequestId && deps.followUpRequestRepository?.findById) {
    const followUp = await deps.followUpRequestRepository.findById(
      followUpRequestId,
      scope.business.id,
    );
    if (!followUp || followUp.status !== "PENDING") {
      return reply(
        "عذراً، طلب المتابعة لم يعد متاحاً للجدولة (تم إلغاؤه أو جدولته مسبقاً أو خارج الفترة المحددة). يمكنك حجز موعد جديد مباشرة باختيار الخدمة المطلوبة.",
        "AI_ACTIVE",
      );
    }
    if (followUp.customerId !== scope.customer.id) {
      return reply(
        BOOKING_RETRY_MESSAGE,
        "NEED_HUMAN",
        "DOMAIN_REQUIRES_HUMAN",
      );
    }
  }

  const created = await createAppointmentForSelection(deps, {
    businessId: scope.business.id,
    customerId: scope.customer.id,
    serviceId,
    branchId: resolvedBranchId,
    assignedUserId: assigneeId,
    providerId: chosen.providerId ?? providerId,
    date,
    startTime,
    endTime,
    status: initialStatus,
    followUpRequestId,
  });

  if (created.status === "failed") {
    // Unexpected booking failure — NEVER a success confirmation.
    return reply(BOOKING_RETRY_MESSAGE, "NEED_HUMAN", "DOMAIN_REQUIRES_HUMAN");
  }
  if (created.status === "invalid_follow_up") {
    return reply(
      "عذراً، طلب المتابعة لم يعد متاحاً للجدولة (تم إلغاؤه أو جدولته مسبقاً أو خارج الفترة المحددة). يمكنك حجز موعد جديد مباشرة باختيار الخدمة المطلوبة.",
      "AI_ACTIVE",
    );
  }
  if (created.status === "conflict") {
    // SLOT_CONFLICT (concurrent close) — retry-safe: refresh + re-offer.
    const retry = await resolveBookingOptions(
      bookingDeps as unknown as Parameters<typeof resolveBookingOptions>[0],
      { userId: scope.customer.id, businessId: scope.business.id },
      { serviceId, ...(branchId ? { branchId } : {}), date },
    );
    if (retry.success && retry.data.options.length > 0) {
      let retryOffer: SlotOffer | null = null;
      if (turnSession?.enabled) {
        retryOffer = buildSlotOffer(
          { businessId: scope.business.id, conversationId: scope.conversation.id },
          crypto.randomUUID(),
          {
            serviceId,
            serviceName,
            serviceSource: context.serviceId ? "CUSTOMER" : "DEFAULT",
            providerId: providerId ?? null,
            date,
            followUpRequestId,
            shownCount: retry.data.options.length,
            options: retry.data.options.map((o) => ({
              providerId: o.providerId,
              displayName: o.displayName,
              startAt: o.startAt,
              endAt: o.endAt,
            })),
          },
          new Date(),
        );
        if (retryOffer) {
          turnSession.state = withPresentedOffer(
            turnSession.state ?? emptyConversationState(),
            retryOffer,
          );
          await turnSession.commit();
        }
      }
      const replyMarkup =
        isTelegram && retryOffer ? slotOfferKeyboard(retryOffer) : undefined;
      return reply(
        `عذراً، تم حجز هذا الموعد للتو — إليك المواعيد المتاحة الآن:\n${formatBookingOptionsMessage(serviceName, date, retry.data.options, followUpRequestId)}`,
        "AI_ACTIVE",
        null,
        replyMarkup,
      );
    }
    return reply(
      BOOKING_CONFLICT_MESSAGE,
      "NEED_HUMAN",
      "DOMAIN_REQUIRES_HUMAN",
    );
  }

  // 7. BOOKED transition + authoritative confirmation. The confirmation
  //    uses ONLY the created appointment's resolved values, and is
  //    persisted/delivered only AFTER creation succeeded.
  if (turnSession?.enabled) {
    turnSession.state = completeBookingTask(
      turnSession.state ?? emptyConversationState(),
      {
        appointmentId: created.appointmentId,
        serviceId,
        providerId: chosen.providerId ?? providerId ?? null,
        date,
        completedAt: new Date().toISOString(),
      },
    );
    await turnSession.commit();
  }

  const businessName = scope.business.name;
  const confirmation = followUpRequestId
    ? initialStatus === "CONFIRMED"
      ? `تم تأكيد حجز موعد المتابعة لخدمة "${serviceName}" يوم ${date} من ${startTime} إلى ${endTime} مع ${chosen.displayName} لدى ${businessName}.`
      : `تم استلام طلب حجز موعد المتابعة لخدمة "${serviceName}" يوم ${date} من ${startTime} إلى ${endTime} مع ${chosen.displayName} لدى ${businessName}. سيتواصل معك الفريق لتأكيد الموعد.`
    : initialStatus === "CONFIRMED"
      ? `تم تأكيد حجزك لخدمة "${serviceName}" يوم ${date} من ${startTime} إلى ${endTime} مع ${chosen.displayName} لدى ${businessName}.`
      : `تم استلام طلب حجزك لخدمة "${serviceName}" يوم ${date} من ${startTime} إلى ${endTime} مع ${chosen.displayName} لدى ${businessName}. سيتواصل معك الفريق لتأكيد الموعد.`;
  return reply(confirmation, "BOOKED");
}

// ─── The engine ──────────────────────────────────────────────────────────────

/**
 * Map a finished turn to the COARSE operator-attention reason (PROMPT-B04).
 *
 * Returns null when the turn did NOT end in a handoff (a safe AI reply, a
 * successful booking, a clarification) — those turns create no operator
 * attention. The reason is an operational category ONLY: it deliberately
 * collapses every "the assistant could not safely answer" cause (AI failure,
 * invalid output, a B-03 refused reply) into one jargon-free key, and never
 * carries prompts, chain-of-thought, provider payload, or disclosure-policy
 * internals. The operator sees the operational consequence, nothing else.
 */
function handoffAttentionReason(
  result: InboundSuccess,
): AttentionReason | null {
  if (result.conversationStatus !== "NEED_HUMAN") return null;
  if (result.assistantAction === "DEFERRED_TO_STAFF")
    return "DEFERRED_TO_STAFF";
  if (result.intent === "BOOKING") return "BOOKING_BLOCKED";
  return "AI_HANDOFF";
}

/**
 * Read the inbound message text WITHOUT re-validating the payload. It is used
 * ONLY to copy a bounded human-readable subject into the review record; it has
 * no authority and is never rendered to a customer.
 */
function readInboundText(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const text = (input as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

/**
 * Record the turn's knowledge-gap observation OFF the critical path
 * (PROMPT-AI-ARCH-18 — Slice 9).
 *
 * It runs ONLY on a finished, non-duplicate turn whose authoritative cause is
 * `KNOWLEDGE_GAP_UNRESOLVED` — i.e. the assistant genuinely could not answer
 * because authoritative knowledge was unresolved. The authoritative customer
 * reply was ALREADY persisted + delivered before this runs, so recording can
 * never change the outcome, the safety/handoff precedence, the booking result,
 * the price safety, the one-call invariant, or the one-send invariant.
 *
 * Total and best-effort, exactly like usage telemetry and operator attention:
 * a missing seam or a failed write yields `null` (observable as a missing
 * record) and can never fail, retry, or delay the customer turn. It performs
 * NO model call, NO transport call, NO second resolution, and NO knowledge
 * promotion.
 */
async function recordKnowledgeGapOffPath(
  deps: ConversationEngineDeps,
  result: InboundSuccess,
  input: unknown,
): Promise<{ id: string; category: KnowledgeGapCategory } | null> {
  if (!deps.knowledgeGapRepository) return null;
  try {
    const observation = deriveKnowledgeGapObservation({
      turn: {
        businessId: result.businessId,
        conversationId: result.conversationId,
        customerMessageId: result.customerMessageId,
        intent: result.intent,
        handoffCause: result.handoffCause,
      },
      messageText: readInboundText(input),
    });
    if (!observation) return null;
    const recorded = await deps.knowledgeGapRepository.record(observation);
    return {
      id: recorded.id,
      category: recorded.category ?? observation.category,
    };
  } catch {
    // A knowledge-gap write failure is classified SEPARATELY from the AI
    // behavioural outcome: it is a missing observation row, never a
    // PROVIDER_FAILURE, and it must never surface to the customer.
    return null;
  }
}

/**
 * Process ONE inbound WhatsApp-style message end-to-end. Idempotent at
 * every level: durable external-key dedupe before irreversible
 * processing, customer upsert + latest-conversation reuse, and
 * claim-coupled message persistence for concurrent redeliveries.
 *
 * This public entry point is the single choke point for operator attention
 * (PROMPT-B04): EVERY turn — whichever of the many handoff branches it took
 * — funnels back here, so a NEED_HUMAN outcome always records exactly ONE
 * idempotent attention row. The handoff itself is unchanged (status stays
 * the authoritative lifecycle); attention is the notification layer on top.
 * The write is best-effort, like usage telemetry: it can never fail the turn.
 *
 * It is ALSO the single choke point for the RECORD-ONLY knowledge-gap signal
 * (PROMPT-AI-ARCH-18 — Slice 9): a finished turn whose authoritative cause is
 * `KNOWLEDGE_GAP_UNRESOLVED` records ONE bounded gap observation, strictly
 * after the customer reply was persisted + sent. It cannot change the turn.
 */
export async function receiveInboundMessage(
  deps: ConversationEngineDeps,
  input: unknown,
  resolvedIdentity?: ResolvedInboundIdentity,
): Promise<InboundResult> {
  const result = await runInboundTurn(deps, input, resolvedIdentity);

  if (result.ok && !result.duplicate) {
    const reason = handoffAttentionReason(result);
    if (reason && deps.attentionRepository) {
      try {
        await deps.attentionRepository.open({
          businessId: result.businessId,
          conversationId: result.conversationId,
          reason,
          // PROMPT-AI-ARCH-16 (Slice 7) — the typed cause of THIS turn's
          // handoff, derived after the authoritative decision. Null for a
          // staff-owned thread (DEFERRED_TO_STAFF carries no AI cause).
          ...(result.handoffCause ? { cause: result.handoffCause } : {}),
        });
      } catch {
        // Attention is a notification layer, not a business action — an
        // attention write can never fail a customer turn (same contract as
        // usage telemetry above).
      }
    }

    // PROMPT-AI-OPS-22 — emit ONE bounded, content-free turn-evidence record.
    // This sits at the SAME single choke point as operator attention and the
    // knowledge-gap recorder, strictly AFTER the reply was persisted + sent,
    // so it is off the customer critical path and best-effort/total: a missing
    // sink, a disabled sink, or a throwing sink can never block, retry, or
    // alter the turn (the evidence is explanatory, never authoritative).
    if (deps.turnTelemetry) {
      try {
        deps.turnTelemetry.emit(buildTurnEvidence(result, TURN_EVIDENCE_META));
      } catch {
        // Observability failure must never change a customer outcome.
      }
    }

    // PROMPT-AI-ARCH-18 (Slice 9) — the record-only knowledge-gap signal,
    // written AFTER the authoritative turn (the reply is already persisted +
    // delivered) and after the operator attention above, so it is strictly
    // off the customer critical path. It reads ONLY the already-decided
    // typed cause; a non-gap turn (provider/AI failure, safety, human,
    // ambiguity, policy refusal, domain block, configuration) can never
    // create a record, and a failed record can never alter the turn.
    const knowledgeGap = await recordKnowledgeGapOffPath(deps, result, input);
    if (knowledgeGap) {
      return { ...result, knowledgeGap };
    }
  }

  return result;
}

async function runInboundTurn(
  deps: ConversationEngineDeps,
  input: unknown,
  resolvedIdentity?: ResolvedInboundIdentity,
): Promise<InboundResult> {
  const parsed = inboundMessageSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "VALIDATION",
      message: parsed.error.issues[0]?.message ?? VALIDATION_MESSAGE,
    };
  }
  const inbound: InboundMessageInput = parsed.data;

  // PROMPT-AI-OPS-22 — ONE correlation id for the whole turn, born before any
  // decision and carried on every downstream observation of this turn. Opaque,
  // random, never derived from content.
  const traceId = newTurnTraceId();

  // 1. Resolve the Business: the provider adapter's server-resolved
  //    identity wins when present (e.g. Meta `phone_number_id` →
  //    WhatsAppConnection → Business), else the established receiving-
  //    number mapping. NEVER client-controlled.
  const business = await resolveInboundBusiness(
    deps,
    inbound,
    resolvedIdentity,
  );
  if (!business) {
    return {
      ok: false,
      code: "BUSINESS_NOT_FOUND",
      message: BUSINESS_NOT_FOUND_MESSAGE,
    };
  }
  if (!business.isActive) {
    return {
      ok: false,
      code: "BUSINESS_INACTIVE",
      message: BUSINESS_INACTIVE_MESSAGE,
    };
  }

  // The server-resolved sending connection (when the provider adapter
  // resolved one) — carried into every outbound delivery for tenancy.
  const outboundConnectionId = resolvedIdentity?.connectionId ?? null;

  // 2. Claim the external message key (DURABLE, tenant-scoped) BEFORE
  //    any irreversible processing. A redelivery of an already-processed
  //    message stops here with zero side effects; a redelivery of a
  //    crashed attempt (claim without message) safely reprocesses.
  const claim = await deps.inboundDedupeRepository.claim(
    business.id,
    externalMessageKey(business.id, inbound),
  );
  if (claim.status === "duplicate") {
    return {
      ok: true,
      duplicate: true,
      conversationId: claim.conversationId ?? "",
      customerMessageId: claim.customerMessageId ?? "",
    };
  }

  try {
    // 3. Find or create the customer (canonical phone path).
    const customer = await deps.customerRepository.upsertByPhone(business.id, {
      name: inboundCustomerName(inbound.from),
      phone: canonicalPhone(inbound.from),
    });

    // 4. Find or create the conversation (latest thread per customer —
    //    no second conversation system, no duplicate active threads).
    //    New threads are Branch-aware: the Business's Default Branch,
    //    resolved server-side (DECISIONS #30 — never client input).
    const latest = await deps.conversationRepository.findLatestByCustomer(
      business.id,
      customer.id,
    );
    let conversation: Conversation | null = latest
      ? await deps.conversationRepository.findById(latest.id)
      : null;
    if (conversation && conversation.businessId !== business.id) {
      conversation = null; // defense in depth: never cross tenants
    }
    if (!conversation) {
      const defaultBranch = await deps.branchRepository.findDefaultByBusiness(
        business.id,
      );
      if (!defaultBranch) {
        // Broken invariant (creation path + backfill guarantee a
        // Default Branch) — fail safe without side effects.
        return {
          ok: false,
          code: "PERSISTENCE_FAILED",
          message: PERSISTENCE_FAILED_MESSAGE,
        };
      }
      conversation = await deps.conversationRepository.create({
        businessId: business.id,
        customerId: customer.id,
        branchId: defaultBranch.id,
      });
    }

    // 5. Persist the CUSTOMER message (immutable, single write path)
    //    with the transport-owned receive timestamp — and record the
    //    claim's message ids in the SAME transaction. A concurrent
    //    duplicate loses the conditional update, rolls back, and
    //    surfaces as an idempotent duplicate result.
    const wasBooked = conversation.status === "BOOKED";
    const aiEligible =
      (conversation.status === "AI_ACTIVE" || wasBooked) &&
      !conversation.assignedUserId;
    if (wasBooked && aiEligible) {
      conversation = {
        ...conversation,
        status: "AI_ACTIVE",
      };
    }
    let customerMessage;
    try {
      customerMessage = await deps.conversationRepository.addMessage(
        {
          conversationId: conversation.id,
          senderType: "CUSTOMER",
          content: inbound.text,
          createdAt: new Date(inbound.receivedAt),
        },
        // A thread that is not AI-eligible needs staff attention; the
        // assignment is preserved, only the status routes to the queue.
        // A thread that was BOOKED transitions back to AI_ACTIVE for the new turn.
        aiEligible
          ? wasBooked
            ? { status: "AI_ACTIVE" }
            : {}
          : { status: "NEED_HUMAN" },
        { claimId: claim.claimId },
      );
    } catch (error) {
      if (error instanceof InboundDuplicateError) {
        return {
          ok: true,
          duplicate: true,
          conversationId: error.conversationId ?? conversation.id,
          customerMessageId: error.customerMessageId ?? "",
        };
      }
      throw error;
    }
    await deps.customerRepository.touchConversation(customer.id);
    await recordUsage(deps, {
      businessId: business.id,
      kind: "INBOUND_MESSAGE",
      conversationId: conversation.id,
      messageId: customerMessage.id,
      status: "SUCCESS",
      occurredAt: customerMessage.createdAt,
    });

    // 6. AI turn — only on unassigned AI_ACTIVE threads.
    if (!aiEligible) {
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "DEFERRED_TO_STAFF",
        intent: null,
        conversationStatus: "NEED_HUMAN",
        // A staff-owned thread is not an assistant-initiated handoff — the
        // typed cause taxonomy describes why the ASSISTANT needed a human.
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery: null,
      };
    }

    // 7. Load minimal context for AI and for deterministic selection
    const [recent, services] = await Promise.all([
      deps.conversationRepository.getMessages(conversation.id, {
        pageSize: AI_RECENT_MESSAGE_LIMIT,
      }),
      deps.serviceRepository.listByBusiness(business.id),
    ]);
    const recentChronological = [...recent].reverse().map((message) => ({
      senderType: message.senderType,
      content: message.content,
    }));
    // CTX-01 (PERF-04) — the current customer message reaches the assistant
    // EXACTLY ONCE, through the CURRENT message slot (`sources.message`
    // below). It is therefore excluded from the bounded history window the
    // AI additionally receives, so `recentMessages` represents PRIOR turns
    // only. The deterministic paths below (booking selection, Conversation
    // State derivation, clarification/continuation reconstruction) keep the
    // FULL `recentChronological` — only the AI-facing window is narrowed.
    //
    // The exclusion is PROVEN, never assumed: the row is matched by its
    // unique id — the same id the `addMessage` write above returned for this
    // turn's CUSTOMER row — instead of blindly dropping the trailing
    // element. Id identity cannot remove an EARLIER message that repeats
    // the same text (a second "نعم" stays in history), does not depend on
    // the row being last, and is a no-op if the row is somehow absent from
    // the page (the message still arrives once via `sources.message`).
    const recentMessagesBeforeCurrent = recent
      .filter((message) => message.id !== customerMessage.id)
      .reverse()
      .map((message) => ({
        senderType: message.senderType,
        content: message.content,
      }));
    const now = new Date(inbound.receivedAt);
    const turnSession = await openTurnStateSession(
      deps.conversationStateRepository,
      { businessId: business.id, conversationId: conversation.id },
      now,
    );

    const selectionScope: BookingSelectionScope = {
      business,
      conversation,
      customer,
      customerMessageId: customerMessage.id,
      connectionId: outboundConnectionId,
      services,
    };

    // 7b. Mechanical selection resolver (CONV-CORE-01):
    // First, evaluate against any durable typed offer in state.
    // Falls back to legacy text-parsed selection when no typed offer is in state.
    const offerReply: OfferReply = turnSession.enabled
      ? interpretOfferReply(inbound.text, turnSession.state?.offer ?? null, now)
      : { kind: "none" };

    if (offerReply.kind === "slot") {
      const claim = await turnSession.claimOffer();
      if (claim === "conflict") {
        return selectionReply(
          deps,
          selectionScope,
          "جاري معالجة طلبك حالياً، يرجى الانتظار لحظات.",
          "AI_ACTIVE",
        );
      }
      const selectionResult = await completeBookingSelection(
        deps,
        selectionScope,
        offerReply.context,
        offerReply.selection,
        turnSession,
      );
      if (selectionResult) return selectionResult;
    } else if (offerReply.kind === "service") {
      if (turnSession.state) {
        turnSession.state = withOfferStatus(turnSession.state, "CONSUMED");
      }
      const knownDate = turnSession.state?.knownFacts.date;
      if (knownDate) {
        const branchId = (conversation.branchId as string | null) ?? null;
        const eligibilityDeps = buildEligibilityDeps(deps);
        const eligibility = await resolveEligibleProviders(
          eligibilityDeps as unknown as Parameters<
            typeof resolveEligibleProviders
          >[0],
          { businessId: business.id },
          {
            serviceId: offerReply.serviceId,
            ...(branchId ? { branchId } : {}),
          },
        );
        if (eligibility.success) {
          const bookingDeps = buildBookingDeps(deps, eligibilityDeps);
          const bookingResult = await resolveBookingOptions(
            bookingDeps as unknown as Parameters<
              typeof resolveBookingOptions
            >[0],
            { userId: customer.id, businessId: business.id },
            {
              serviceId: offerReply.serviceId,
              ...(branchId ? { branchId } : {}),
              date: knownDate,
            },
          );
          if (bookingResult.success && bookingResult.data.options.length > 0) {
            let bookableOptions = bookingResult.data.options;
            const timeOfDayPref = turnSession.state?.knownFacts.timePreference;
            if (timeOfDayPref) {
              const matchesPref = (startTime: string) => {
                const hour = parseInt(startTime.slice(0, 2), 10);
                if (Number.isNaN(hour)) return true;
                if (timeOfDayPref === "morning") return hour < 12;
                if (timeOfDayPref === "afternoon")
                  return hour >= 12 && hour < 17;
                if (timeOfDayPref === "evening") return hour >= 17;
                return true;
              };
              const preferred = bookableOptions.filter((o) =>
                matchesPref(o.startAt.slice(11, 16)),
              );
              const others = bookableOptions.filter(
                (o) => !matchesPref(o.startAt.slice(11, 16)),
              );
              if (preferred.length > 0)
                bookableOptions = [...preferred, ...others];
            }
            const slotOffer = buildSlotOffer(
              { businessId: business.id, conversationId: conversation.id },
              crypto.randomUUID(),
              {
                serviceId: offerReply.serviceId,
                serviceName: offerReply.serviceName,
                serviceSource: "CUSTOMER",
                providerId: null,
                date: knownDate,
                followUpRequestId: null,
                shownCount: bookableOptions.length,
                options: bookableOptions.map((o) => ({
                  providerId: o.providerId,
                  displayName: o.displayName,
                  startAt: o.startAt,
                  endAt: o.endAt,
                })),
              },
              now,
            );
            if (slotOffer && turnSession.enabled) {
              turnSession.state = withPresentedOffer(
                turnSession.state ?? emptyConversationState(),
                slotOffer,
              );
              await turnSession.commit();
            }
            const isTelegram = customer.phone.startsWith("tg:");
            const replyMarkup =
              isTelegram && slotOffer
                ? slotOfferKeyboard(slotOffer)
                : undefined;
            const optionsMsg = formatBookingOptionsMessage(
              offerReply.serviceName,
              knownDate,
              bookableOptions,
            );
            const assistantMessage = await persistAssistantReply(
              deps,
              conversation.id,
              optionsMsg,
              "AI_ACTIVE",
            );
            const delivery = await deliverAssistantReply(
              deps,
              customer.phone,
              business.name,
              conversation.id,
              optionsMsg,
              assistantMessage.id,
              business.id,
              outboundConnectionId,
              replyMarkup,
            );
            return {
              ok: true,
              duplicate: false,
              businessId: business.id,
              conversationId: conversation.id,
              customerId: customer.id,
              customerMessageId: customerMessage.id,
              assistantAction: "AI_REPLY",
              intent: "AVAILABILITY",
              conversationStatus: "AI_ACTIVE",
              handoffCause: null,
              assistantProvider: deps.ai.providerName,
              delivery,
            };
          }
        }
      }
      const dateMsg = `تم اختيار خدمة "${offerReply.serviceName}". يرجى تحديد اليوم أو التاريخ المناسب لك (مثال: بكرة، الأسبوع القادم، أو اذكر يوماً محدداً):`;
      if (turnSession.enabled) {
        turnSession.state = {
          ...(turnSession.state ?? emptyConversationState()),
          serviceId: offerReply.serviceId,
          selectedService: offerReply.serviceName,
          serviceSource: "CUSTOMER",
          knownFacts: {
            ...(turnSession.state?.knownFacts ?? {}),
            service: offerReply.serviceName,
          },
          missingFacts: ["date"],
          lastClarification: { type: "date" },
          offer: null,
          pendingOffer: null,
        };
        await turnSession.commit();
      }
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        dateMsg,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        dateMsg,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_REPLY",
        intent: "BOOKING",
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    } else if (offerReply.kind === "service_invalid_index") {
      const invalidMsg = `يرجى اختيار رقم من 1 إلى ${offerReply.max}.`;
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        invalidMsg,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        invalidMsg,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_REPLY",
        intent: "BOOKING",
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    } else if (offerReply.kind === "stale") {
      const staleMsg =
        offerReply.reason === "CLOSED"
          ? "هذا العرض لم يعد متاحاً (تم تأكيده مسبقاً أو تم استبداله). يمكنك طلب موعد جديد بتحديد الخدمة واليوم المناسب."
          : "انتهت صلاحية المواعيد المعروضة — يرجى تحديد اليوم والخدمة لعرض المواعيد المتاحة حالياً.";
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        staleMsg,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        staleMsg,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_REPLY",
        intent: "BOOKING",
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    } else {
      // Legacy text-parsing fallback:
      const selectionAttempt = wasBooked
        ? null
        : tryParseBookingSelection(inbound.text, recentChronological);
      if (selectionAttempt) {
        const selectionResult = await completeBookingSelection(
          deps,
          selectionScope,
          selectionAttempt.context,
          selectionAttempt.selection,
          turnSession,
        );
        if (selectionResult) return selectionResult;
      }
    }
    // 7c. B-02 — the Context Builder is the explicit AI boundary
    //     (PROMPT-B02): it takes the structured source facts already loaded
    //     above (Business record, services, conversation state, the
    //     customer message), classifies every candidate through the B-01
    //     knowledge-visibility policy, proves tenant scope against the
    //     server-derived businessId, drops provenance, and composes the
    //     minimal AiRequest. The engine keeps responsibility for
    //     orchestration; the builder owns AI-safe context assembly.
    const builtContext = buildAiContext({
      scope: { businessId: business.id },
      sources: {
        business,
        services,
        conversation: {
          status: conversation.status,
          recentMessages: recentMessagesBeforeCurrent,
        },
        message: inbound.text,
      },
    });
    // PROMPT-AI-JEV-03D — stamp the turn's OPAQUE correlation id onto the
    // request so a non-authoritative shadow evaluation can sample and
    // correlate turns deterministically without deriving anything from
    // content. Additive: the field is optional in the contract and every
    // downstream consumer behaves exactly as before when it is absent.
    const aiRequest: AiRequest = { ...builtContext.request, traceId };

    // PROMPT-AI-OPS-22 — the deterministic, text-derived task families and the
    // bounded channel facts of the ASSEMBLED request. Both are machine keys /
    // counters only; they never copy message text or a knowledge value, and
    // they make "was the expected context available?" answerable from evidence.
    const taskRelevance: TaskRelevance = deriveTaskRelevance(inbound.text);
    const contextChannels = readContextChannels(aiRequest);

    // 8. Deterministic bypass first (DECISIONS #33): turns safely
    //    decidable without an assistant never spend an AI call — and
    //    never produce an AI_TURN usage fact (no request was made).
    let turn: AiResponse | null = bypassDeterministicAi(aiRequest);
    // Additive observability only (PROMPT-AI-ARCH-02 Slice 0): remembers
    // WHICH routing produced the turn. It changes no branch.
    const deterministicBypass = turn !== null;
    let turnTelemetry: AiTelemetry | null = null;
    // PROMPT-AI-PERF-02 — the ONE attempt selection for the whole turn: the
    // SUCCESSFUL attempt wins, else the last attempt. It sources BOTH the
    // AI_TURN usage record's token counters AND the turn-evidence token
    // projection below, so the turn reads one counter, never two. Both stay
    // absent for a no-call / deterministic-bypass / JEV-deterministic turn.
    let successAttempt: AiTelemetryAttempt | undefined;
    let lastAttempt: AiTelemetryAttempt | undefined;
    if (!turn) {
      try {
        turn = await deps.ai.respond(aiRequest);
      } catch {
        turn = null;
      }
      turnTelemetry = readAiTelemetry(deps.ai);
      const telemetry = turnTelemetry;
      // A JEV deterministic termination (Slice 8) spends no provider call,
      // exactly like the built-in deterministic bypass: no AI_TURN usage fact
      // is recorded (no request was made).
      const isBypassTelemetry =
        telemetry?.finalProvider === "deterministic-bypass" ||
        telemetry?.finalProvider === JEV_DETERMINISTIC_PROVIDER;
      if (!isBypassTelemetry) {
        lastAttempt = telemetry?.attempts[telemetry.attempts.length - 1];
        successAttempt = telemetry
          ? [...telemetry.attempts]
              .reverse()
              .find((a) => a.status === "SUCCESS")
          : undefined;
        await recordUsage(deps, {
          businessId: business.id,
          kind: "AI_TURN",
          conversationId: conversation.id,
          provider: telemetry?.finalProvider ?? deps.ai.providerName,
          model: (successAttempt?.model ??
            telemetry?.finalModel ??
            undefined) as string | undefined,
          inputTokens:
            successAttempt?.inputTokens ??
            lastAttempt?.inputTokens ??
            undefined,
          outputTokens:
            successAttempt?.outputTokens ??
            lastAttempt?.outputTokens ??
            undefined,
          status: turn ? "SUCCESS" : "FAILURE",
          occurredAt: new Date(),
        });
      }
    }

    // 9. Validate the assistant output BEFORE persisting (AI is never
    //    the source of truth — invalid/absent output fails safe to a
    //    handoff). The customer is NOT left in silence: the turn delivers
    //    the SAME safe, deterministic handoff acknowledgment the #58
    //    disclosure-refusal path produces (`classifyCustomerMessage`
    //    never invents business data — no FAQ match means a typed handoff
    //    reply), then takes the existing NEED_HUMAN + operator-attention
    //    handoff path. This keeps the E2E WhatsApp reply path alive when
    //    the provider fails, times out, or returns an invalid response —
    //    without weakening parseAiResponse or bypassing Conversation
    //    Control. The AI/domain separation is unchanged: the
    //    acknowledgment is deterministic, and no AI-authored content is
    //    trusted, persisted, or sent.
    const validated = turn ? parseAiResponse(turn) : null;

    // 9a. ADDITIVE observability (PROMPT-AI-ARCH-02 Slice 0): a PURE
    //     projection of the finished decision through the ONE canonical
    //     contract. It adds no inference, no provider call, no persistence,
    //     and no behavior; it never carries content, prompts, or secrets.
    //     Today's producers emit no goals/clarification/cause/factUpdates,
    //     so those stay absent — or are synthesized by the single-goal
    //     compatibility bridge from the existing intent + action.
    const turnRouting: AiRoutingDecision = deterministicBypass
      ? "DETERMINISTIC_BYPASS"
      : turnTelemetry?.finalProvider === JEV_DETERMINISTIC_PROVIDER
        ? "JEV"
        : deps.ai.providerName === "deterministic"
          ? "DETERMINISTIC"
          : "LLM";
    // PROMPT-AI-ARCH-05 (Slice 3): the ONE deterministic resolver's ordered
    // single-goal TurnPlan. PROMPT-AI-ARCH-06 (Slice 4): its `decisionClass`
    // is AUTHORITATIVE for the first-class CLARIFY branch below; every other
    // class leaves the existing execution path authoritative and unchanged.
    const resolution = resolveFinishedTurn(
      recentChronological,
      validated,
      turnRouting,
      inbound.text,
      new Date(),
      business.timezone,
      turnTelemetry,
      turnSession.state,
    );
    const resolvedTurn = resolution?.plan ?? null;
    const resolvedState = resolution?.state ?? null;
    if (resolvedState && turnSession.enabled) {
      turnSession.state = resolvedState;
    }
    // PROMPT-AI-OPS-22 — provider execution facts for the evidence record.
    // `NOT_CALLED` marks a turn that spent no physical provider call (the
    // deterministic bypass / a JEV deterministic termination). When an adapter
    // exposes no telemetry the count falls back to 1 — a non-bypass turn DID
    // consult the adapter exactly once (the one-call invariant).
    const providerAttempts = deterministicBypass
      ? 0
      : (turnTelemetry?.retryTrace?.attempts.length ??
        turnTelemetry?.attempts.length ??
        1);
    const providerStatus: "SUCCESS" | "FAILURE" | "NOT_CALLED" =
      deterministicBypass
        ? "NOT_CALLED"
        : (turnTelemetry?.finalStatus ?? (validated ? "SUCCESS" : "FAILURE"));
    // PROMPT-AI-JEV-03B §12 — the TOTAL LOGICAL MODEL-CALL COUNT, INCLUDING a
    // JEV inference. A semantic JEV turn that spent one JEV call reports 1 even
    // though the generative provider's `providerAttempts` is [] (no LLM ran);
    // a deterministic turn reports 0; an ordinary generative turn reports its
    // physical attempt count. This is the ONE counter that makes the 0/1
    // model-call invariant measurable end-to-end.
    const jevCallSpent = !!turnTelemetry?.jevDecision?.semantic?.jevCallSpent;
    const modelCallCount = providerAttempts + (jevCallSpent ? 1 : 0);
    let turnObservability: TurnObservability = buildTurnObservability({
      routingDecision: turnRouting,
      response: validated,
      provider: deterministicBypass
        ? "deterministic-bypass"
        : (turnTelemetry?.finalProvider ?? deps.ai.providerName),
      model: turnTelemetry?.finalModel ?? null,
      fallbackUsed: turnTelemetry?.fallbackUsed ?? false,
      retryCount: turnTelemetry?.retryTrace
        ? Math.max(0, turnTelemetry.retryTrace.attempts.length - 1)
        : 0,
      latencyMs: turnTelemetry?.retryTrace?.totalElapsedMs,
      knowledgeSourceClass: includedKnowledgeSources(builtContext.facts),
      stateTransition: observeConversationStateTransition(
        recentChronological,
        validated,
      ),
      turnPlan: resolvedTurn?.plan,
      // PROMPT-AI-OPS-22 — turn correlation + the deterministic task families
      // + the request's channel facts + the provider execution facts.
      traceId,
      taskRelevance: armedRelevance(taskRelevance),
      contextChannels,
      providerAttempts,
      providerStatus,
      // PROMPT-AI-PERF-02 — the provider's OWN token counters for this turn,
      // passed through the single attempt selection above. Null when the
      // adapter exposes no token telemetry or no provider was consulted; the
      // evidence record then omits a counter rather than fabricating a zero.
      inputTokens:
        successAttempt?.inputTokens ?? lastAttempt?.inputTokens ?? null,
      outputTokens:
        successAttempt?.outputTokens ?? lastAttempt?.outputTokens ?? null,
      // Null for a bypass (no provider output existed to parse); true/false
      // only when a provider was actually consulted this turn.
      parseSuccess: deterministicBypass
        ? null
        : turn
          ? validated !== null
          : null,
      ...(resolvedTurn
        ? { answerAndContinue: resolvedTurn.answerAndContinue }
        : {}),
      ...(resolvedTurn && resolvedTurn.pendingGoals.length > 0
        ? { pendingGoals: resolvedTurn.pendingGoals }
        : {}),
      ...(resolvedTurn?.clarification
        ? {
            clarification: {
              type: resolvedTurn.clarification.type,
              ...(resolvedTurn.clarification.missingFacts.length > 0
                ? { missingFacts: [...resolvedTurn.clarification.missingFacts] }
                : {}),
            },
          }
        : {}),
      // PROMPT-AI-ARCH-17 (Slice 8) — the JEV gateway decision, auditable as
      // closed machine keys. Additive only; never customer-visible.
      jev: turnTelemetry?.jevDecision ?? null,
      // PROMPT-AI-JEV-03D — the NON-AUTHORITATIVE shadow JEV evidence
      // (OPTION E). Additive projection only: the slot is disjoint from
      // `jev` above and from the `modelCallCount` counter, which keeps
      // counting ONLY the customer-serving calls exactly as before.
      shadow: turnTelemetry?.shadow ?? null,
      // PROMPT-AI-JEV-03B §12 — the total logical model-call count (JEV +
      // generative). See `modelCallCount` above.
      modelCallCount,
      // PROMPT-AI-JEV-03B §12 — clarification anti-repeat / resume state: true
      // when the ONE resolver PRESERVED a pending task by re-asking its bounded
      // question instead of escalating (precedence rule 6).
      ...(resolvedTurn?.precedenceRule === "PENDING_TASK_PRESERVED"
        ? { clarifyAntiRepeat: true }
        : {}),
    });
    if (!validated) {
      const safeHandoff = classifyCustomerMessage(
        inbound.text,
        builtContext.request.faqs,
      );
      // PROMPT-AI-ARCH-16 (Slice 7) — type WHY the turn failed safe. The
      // provider-neutral Conversation Control outcome already classified the
      // failure (retry exhausted / provider unavailable / quota / auth /
      // invalid output / the customer's own human request). When none is
      // available the assistant's structured output was absent or invalid —
      // AI_FAILURE, never a mislabeled knowledge gap.
      const failureCause =
        controlHandoffReasonToCause(
          turnTelemetry?.conversationControl?.handoffReason ?? null,
        ) ?? "AI_FAILURE";
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        safeHandoff.content,
        "NEED_HUMAN",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        safeHandoff.content,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_HANDOFF",
        intent: null,
        conversationStatus: "NEED_HUMAN",
        handoffCause: failureCause,
        assistantProvider: deps.ai.providerName,
        observability: turnObservability,
        delivery,
      };
    }

    // 9a-pre. SAFETY / EXPLICIT-HUMAN PRECEDENCE (PROMPT-AI-EVAL-07). The ONE
    //     resolver applies DETERMINISTIC, authoritative safety precedence: a
    //     sensitive/restricted turn or an explicit human request hands off to a
    //     human EVEN WHEN the model proposed a clarification or a booking
    //     intent and did NOT self-report the safety reason. This branch runs
    //     BEFORE the first-class CLARIFY branch AND the booking/availability
    //     seam, so a safety-required turn can never be swallowed as CLARIFY or
    //     routed into a booking clarification (EVAL-07 `ho-sensitive-medical`
    //     reached CLARIFY_SERVICE + AI_ACTIVE — closed here). The customer sees
    //     the SAME safe, deterministic, knowledge-free handoff acknowledgment
    //     the other safe-handoff paths emit; the thread goes NEED_HUMAN and the
    //     central choke point records operator attention. No extra model call.
    if (
      resolvedTurn &&
      resolvedTurn.decisionClass === "HANDOFF" &&
      (resolvedTurn.precedenceRule === "SAFETY_RESTRICTED" ||
        resolvedTurn.precedenceRule === "EXPLICIT_HUMAN_REQUEST")
    ) {
      const safeHandoff = classifyCustomerMessage(
        inbound.text,
        builtContext.request.faqs,
      );
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        safeHandoff.content,
        "NEED_HUMAN",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        safeHandoff.content,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_HANDOFF",
        intent: validated.intent,
        conversationStatus: "NEED_HUMAN",
        // PROMPT-AI-ARCH-16 (Slice 7) — the resolver's AUTHORITATIVE
        // precedence rule is the cause: safety-sensitive vs the customer's
        // own explicit request. Derived AFTER the decision, so a safety
        // handoff can never be relabeled as something weaker.
        handoffCause:
          resolvedTurn.precedenceRule === "SAFETY_RESTRICTED"
            ? "SENSITIVE_OR_RESTRICTED"
            : "CUSTOMER_REQUESTED_HUMAN",
        assistantProvider: deps.ai.providerName,
        observability: turnObservability,
        delivery,
      };
    }

    // 9a-bis. FIRST-CLASS CLARIFY (PROMPT-AI-ARCH-06 — Slice 4). When the ONE
    //     resolver classifies this turn as CLARIFY (a genuinely clarifiable
    //     ambiguity: the classifier's `AMBIGUOUS`-reason turn, never SENSITIVE
    //     / NO_KNOWLEDGE / HUMAN_REQUEST, never a sensitive/human/domain-blocked
    //     turn — those are pre-empted by the resolver's precedence), the engine
    //     asks ONE bounded question and STAYS AI_ACTIVE instead of handing off
    //     to a human. The question is a fixed, engine-authored, knowledge-free
    //     template (B-03 §16): it names no business fact, so it crosses the
    //     customer boundary on its declared CLARIFY class, exactly like the
    //     GREETING knowledge-free protocol — the disclosure gate is never
    //     weakened. ZERO extra model inference: the clarification is produced
    //     by the pure resolver inside this same turn (zero-or-one call holds).
    //     The pending task + missing facts live in ConversationState (derived
    //     from history), so the next turn resumes. Booking/availability intents
    //     never reach here (their clarification is domain-owned, below).
    if (
      resolvedTurn &&
      resolvedTurn.decisionClass === "CLARIFY" &&
      resolvedTurn.clarification
    ) {
      const question = resolvedTurn.clarification.question;
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        question,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        question,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_REPLY",
        intent: validated.intent,
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        observability: turnObservability,
        delivery,
      };
    }

    // 9b. BOOKING/AVAILABILITY seam (PROMPT-AI-03): mapper → CORE-01 → CORE-02
    // Only for booking-related intents; all other intents fall through to
    // the generic reply/handoff path. No appointment mutation here.
    if (validated.intent === "BOOKING" || validated.intent === "AVAILABILITY") {
      const branchId = (conversation.branchId as string | null) ?? null;
      // SUPPLIED-FACT RESUME (PROMPT-AI-EVAL-07): honor a fact the customer
      // already supplied for the pending booking clarification (merged into
      // ConversationState) when the model's extraction for THIS turn omits it,
      // so the booking mapper never RE-ASKS a fact already given. Additive and
      // safe: a free-form fact (service / provider / time) is supplemented
      // verbatim; a date is supplemented ONLY when ISO-shaped (the domain's
      // required form) — the DOMAIN still re-verifies and executes. The AI's
      // own extraction always wins when present (never overwritten).
      let bookingAiResponse = resolvedState
        ? resumeBookingExtraction(validated, resolvedState)
        : validated;

      if (!bookingAiResponse.extraction.date) {
        const todayIso = todayIsoInTimeZone(
          new Date(),
          business.timezone ?? "UTC",
        );
        let relDate = resolveEgyptianRelativeDate(inbound.text, todayIso);
        if (!relDate && recentChronological) {
          for (let i = recentChronological.length - 1; i >= 0; i--) {
            const m = recentChronological[i]!;
            if (m.senderType === "CUSTOMER") {
              const prev = resolveEgyptianRelativeDate(m.content, todayIso);
              if (prev) {
                relDate = prev;
                break;
              }
            }
          }
        }
        if (relDate) {
          bookingAiResponse = {
            ...bookingAiResponse,
            extraction: {
              ...bookingAiResponse.extraction,
              date: relDate,
            },
          };
        }
      }

      if (!bookingAiResponse.extraction.timePreference) {
        let timePref = extractTimeOfDayPreference(inbound.text);
        if (!timePref && recentChronological) {
          for (let i = recentChronological.length - 1; i >= 0; i--) {
            const m = recentChronological[i]!;
            if (m.senderType === "CUSTOMER") {
              const prev = extractTimeOfDayPreference(m.content);
              if (prev) {
                timePref = prev;
                break;
              }
            }
          }
        }
        if (timePref) {
          bookingAiResponse = {
            ...bookingAiResponse,
            extraction: {
              ...bookingAiResponse.extraction,
              timePreference: timePref,
            },
          };
        }
      }

      const sameDoctorRequested =
        /(?:نفس\s+(?:الدكتور|الطبيب|الدكتورة|الطبيبة|المقدم)|مع\s+نفس)/.test(
          inbound.text,
        );
      if (sameDoctorRequested && !bookingAiResponse.extraction.provider) {
        if (resolvedState?.knownFacts?.provider) {
          bookingAiResponse = {
            ...bookingAiResponse,
            extraction: {
              ...bookingAiResponse.extraction,
              provider: resolvedState.knownFacts.provider,
            },
          };
        } else if (
          deps.appointmentRepository &&
          typeof deps.appointmentRepository.listRecentByCustomer === "function"
        ) {
          const recent = await deps.appointmentRepository.listRecentByCustomer(
            business.id,
            customer.id,
            1,
          );
          const firstRecent = recent?.[0];
          if (firstRecent && firstRecent.providerId) {
            const pId = firstRecent.providerId;
            const provRepo = deps.providerRepository ?? providerRepository;
            const providers = await provRepo.listEligibleForService(
              business.id,
              firstRecent.serviceId,
            );
            const matchedP = providers.find((p) => p.id === pId);
            if (matchedP) {
              bookingAiResponse = {
                ...bookingAiResponse,
                extraction: {
                  ...bookingAiResponse.extraction,
                  provider: matchedP.name ?? null,
                },
              };
            }
          }
        }
      }

      let activeFollowUpId: string | null =
        resolvedState?.knownFacts?.followUpRequestId ?? null;

      const isExplicitFollowUp = /(?:متابعة|متابعه)/.test(inbound.text);

      if (
        deps.followUpRequestRepository &&
        (isExplicitFollowUp || activeFollowUpId)
      ) {
        const eligibleFollowUps =
          await deps.followUpRequestRepository.getEligibleForChannel(
            business.id,
            customer.id,
          );

        if (
          isExplicitFollowUp &&
          eligibleFollowUps.length === 0 &&
          !activeFollowUpId
        ) {
          const noFollowUpMsg =
            "لا يوجد طلب متابعة معلّق مسجل لك حالياً لدى العيادة. يمكنك حجز موعد جديد مباشرة باختيار الخدمة المطلوبة.";
          const assistantMessage = await persistAssistantReply(
            deps,
            conversation.id,
            noFollowUpMsg,
            "AI_ACTIVE",
          );
          const delivery = await deliverAssistantReply(
            deps,
            customer.phone,
            business.name,
            conversation.id,
            noFollowUpMsg,
            assistantMessage.id,
            business.id,
            outboundConnectionId,
          );
          return {
            ok: true,
            duplicate: false,
            businessId: business.id,
            conversationId: conversation.id,
            customerId: customer.id,
            customerMessageId: customerMessage.id,
            assistantAction: "AI_REPLY",
            intent: validated.intent,
            conversationStatus: "AI_ACTIVE",
            handoffCause: null,
            assistantProvider: deps.ai.providerName,
            observability: turnObservability,
            delivery,
          };
        }

        let targetFollowUp = activeFollowUpId
          ? eligibleFollowUps.find((fu) => fu.id === activeFollowUpId)
          : null;

        if (!targetFollowUp && eligibleFollowUps.length === 1) {
          targetFollowUp = eligibleFollowUps[0]!;
        } else if (!targetFollowUp && eligibleFollowUps.length > 1) {
          const listText = eligibleFollowUps
            .map((fu, idx) => {
              const sName = fu.serviceName ?? "خدمة طبية";
              const pName = fu.preferredProviderName
                ? ` مع ${fu.preferredProviderName}`
                : "";
              const range =
                fu.startDate && fu.endDate
                  ? ` (الفترة المتاحة: من ${fu.startDate} إلى ${fu.endDate})`
                  : "";
              return `${idx + 1}. متابعة ${sName}${pName}${range}`;
            })
            .join("\n");
          const multiMsg = `لديك أكثر من طلب متابعة معلّق:\n${listText}\nيرجى تحديد أي متابعة ترغب في جدولتها.`;
          const assistantMessage = await persistAssistantReply(
            deps,
            conversation.id,
            multiMsg,
            "AI_ACTIVE",
          );
          const delivery = await deliverAssistantReply(
            deps,
            customer.phone,
            business.name,
            conversation.id,
            multiMsg,
            assistantMessage.id,
            business.id,
            outboundConnectionId,
          );
          return {
            ok: true,
            duplicate: false,
            businessId: business.id,
            conversationId: conversation.id,
            customerId: customer.id,
            customerMessageId: customerMessage.id,
            assistantAction: "AI_REPLY",
            intent: validated.intent,
            conversationStatus: "AI_ACTIVE",
            handoffCause: null,
            assistantProvider: deps.ai.providerName,
            observability: turnObservability,
            delivery,
          };
        }

        if (targetFollowUp) {
          activeFollowUpId = targetFollowUp.id;

          const updatedExtraction = { ...bookingAiResponse.extraction };
          if (!updatedExtraction.service && targetFollowUp.serviceName) {
            updatedExtraction.service = targetFollowUp.serviceName;
          }
          if (
            !updatedExtraction.provider &&
            targetFollowUp.preferredProviderName
          ) {
            updatedExtraction.provider = targetFollowUp.preferredProviderName;
          }
          bookingAiResponse = {
            ...bookingAiResponse,
            extraction: updatedExtraction,
          };

          if (!bookingAiResponse.extraction.date) {
            const rangeDesc =
              targetFollowUp.startDate && targetFollowUp.endDate
                ? `متاح في الفترة من ${targetFollowUp.startDate} إلى ${targetFollowUp.endDate}`
                : targetFollowUp.startDate
                  ? `ابتداءً من ${targetFollowUp.startDate}`
                  : null;
            const promptMsg = rangeDesc
              ? `لديك طلب متابعة مسجل لخدمة "${targetFollowUp.serviceName ?? "المتابعة"}" (${rangeDesc}). ما هو اليوم أو الوقت المناسب لك؟`
              : `لديك طلب متابعة مسجل لخدمة "${targetFollowUp.serviceName ?? "المتابعة"}". ما هو اليوم المناسب لك لحجز الموعد؟`;

            const assistantMessage = await persistAssistantReply(
              deps,
              conversation.id,
              promptMsg,
              "AI_ACTIVE",
            );
            const delivery = await deliverAssistantReply(
              deps,
              customer.phone,
              business.name,
              conversation.id,
              promptMsg,
              assistantMessage.id,
              business.id,
              outboundConnectionId,
            );
            return {
              ok: true,
              duplicate: false,
              businessId: business.id,
              conversationId: conversation.id,
              customerId: customer.id,
              customerMessageId: customerMessage.id,
              assistantAction: "AI_REPLY",
              intent: validated.intent,
              conversationStatus: "AI_ACTIVE",
              handoffCause: null,
              assistantProvider: deps.ai.providerName,
              observability: {
                ...turnObservability,
                turnPlan: {
                  steps: [{ kind: "CLARIFY", intent: validated.intent }],
                },
                clarification: {
                  type: "CLARIFY_DATE",
                  missingFacts: ["date"],
                },
              },
              delivery,
            };
          }

          const targetDate = bookingAiResponse.extraction.date;
          const isOutOfRange =
            (targetFollowUp.startDate &&
              targetDate < targetFollowUp.startDate) ||
            (targetFollowUp.endDate && targetDate > targetFollowUp.endDate);

          if (isOutOfRange) {
            const rangeDesc =
              targetFollowUp.startDate && targetFollowUp.endDate
                ? `من ${targetFollowUp.startDate} إلى ${targetFollowUp.endDate}`
                : targetFollowUp.startDate
                  ? `ابتداءً من ${targetFollowUp.startDate}`
                  : `حتى ${targetFollowUp.endDate}`;
            const outOfRangeMsg = `تاريخ الموعد المطلوب (${targetDate}) خارج الفترة المحددة للمتابعة من قِبل الطبيب (${rangeDesc}). يرجى اختيار تاريخ ضمن هذه الفترة.`;

            const assistantMessage = await persistAssistantReply(
              deps,
              conversation.id,
              outOfRangeMsg,
              "AI_ACTIVE",
            );
            const delivery = await deliverAssistantReply(
              deps,
              customer.phone,
              business.name,
              conversation.id,
              outOfRangeMsg,
              assistantMessage.id,
              business.id,
              outboundConnectionId,
            );
            return {
              ok: true,
              duplicate: false,
              businessId: business.id,
              conversationId: conversation.id,
              customerId: customer.id,
              customerMessageId: customerMessage.id,
              assistantAction: "AI_REPLY",
              intent: validated.intent,
              conversationStatus: "AI_ACTIVE",
              handoffCause: null,
              assistantProvider: deps.ai.providerName,
              observability: {
                ...turnObservability,
                turnPlan: {
                  steps: [{ kind: "CLARIFY", intent: validated.intent }],
                },
                clarification: {
                  type: "CLARIFY_DATE",
                  missingFacts: ["date"],
                },
              },
              delivery,
            };
          }
        }
      }

      const defaultServiceBookingEnabled = Boolean(
        (business as unknown as { defaultServiceBookingEnabled?: boolean })
          .defaultServiceBookingEnabled,
      );

      const defaultServiceId = defaultServiceBookingEnabled
        ? ((business as unknown as { defaultBookingServiceId?: string | null })
            .defaultBookingServiceId ??
          (business as unknown as { defaultServiceId?: string | null })
            .defaultServiceId ??
          (
            (
              business as unknown as {
                assistantStyle?: Record<string, unknown>;
              }
            ).assistantStyle as { defaultServiceId?: string } | undefined
          )?.defaultServiceId ??
          null)
        : null;

      const mapped = mapAiResponseToBookingInput({
        businessId: business.id,
        branchId,
        services: services.map((s) => ({ id: s.id, name: s.name })),
        aiResponse: bookingAiResponse,
        defaultServiceId,
      });
      if (mapped.kind === "needs_clarification") {
        // First-class CLARIFY (PROMPT-AI-ARCH-06 — Slice 4): the booking
        // missing/ambiguous fact already clarifies and stays AI_ACTIVE (no
        // handoff). The mapper (the DOMAIN boundary) authors the message; the
        // engine LABELS it a first-class CLARIFY for observability + state —
        // the pending missing fact (service / date) is recorded so the next
        // turn resumes the booking task. No behavior change, no extra model
        // call, domain authorship preserved.
        const bookingClarification = clarificationForBookingReason(
          mapped.reason,
          mapped.message,
        );
        const clarifyObservability: TurnObservability = {
          ...turnObservability,
          turnPlan: {
            steps: [{ kind: "CLARIFY", intent: validated.intent }],
          },
          clarification: {
            type: bookingClarification.type,
            missingFacts: [...bookingClarification.missingFacts],
          },
        };
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          mapped.message,
          "AI_ACTIVE",
        );
        const isTelegram = customer.phone.startsWith("tg:");
        let serviceOffer: ServiceOffer | null = null;
        if (
          turnSession.enabled &&
          (mapped.reason === "MISSING_SERVICE" ||
            mapped.reason === "AMBIGUOUS_SERVICE") &&
          services.length > 0
        ) {
          const activeServices = services.filter((s) => s.isActive);
          serviceOffer = buildServiceOffer(
            { businessId: business.id, conversationId: conversation.id },
            crypto.randomUUID(),
            activeServices.map((s) => ({ id: s.id, name: s.name })),
            now,
          );
          if (serviceOffer) {
            turnSession.state = withPresentedOffer(
              turnSession.state ?? resolvedState ?? emptyConversationState(),
              serviceOffer,
            );
            await turnSession.commit();
          }
        }
        let replyMarkup: Record<string, unknown> | undefined;
        if (
          isTelegram &&
          (mapped.reason === "MISSING_SERVICE" ||
            mapped.reason === "AMBIGUOUS_SERVICE") &&
          services.length > 0
        ) {
          replyMarkup = serviceOffer
            ? serviceOfferKeyboard(serviceOffer)
            : {
                inline_keyboard: services.slice(0, 5).map((s, idx) => [
                  {
                    text: `${idx + 1}️⃣ ${s.name}`,
                    callback_data: `service_${idx + 1}`,
                  },
                ]),
              };
        }
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          mapped.message,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
          replyMarkup,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: validated.intent,
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          observability: clarifyObservability,
          delivery,
        };
      }

      // CORE-01 — eligibility source of truth
      const eligibilityDeps = buildEligibilityDeps(deps);
      const eligibility = await resolveEligibleProviders(
        eligibilityDeps as unknown as Parameters<
          typeof resolveEligibleProviders
        >[0],
        { businessId: business.id },
        {
          serviceId: mapped.serviceId,
          ...(mapped.branchId ? { branchId: mapped.branchId } : {}),
        },
      );
      if (!eligibility.success) {
        const msg = bookingEligibilityErrorMessage(eligibility.error.code);
        // PROMPT-AI-ARCH-16 (Slice 7) — the DOMAIN (CORE-01) is the
        // authoritative source of truth: a missing/inactive business, branch
        // or service is a TENANT_CONFIGURATION cause the operator can fix;
        // any other eligibility block is a domain constraint needing a human.
        const eligibilityCause = eligibilityFailureCodeToCause(
          eligibility.error.code,
        );
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          msg,
          "NEED_HUMAN",
        );
        if (!conversation.aiSummary) {
          await deps.conversationRepository.update(conversation.id, {
            aiSummary: validated.summary ?? `طلب حجز: ${mapped.serviceName}`,
          });
        }
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          msg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_HANDOFF",
          intent: validated.intent,
          conversationStatus: "NEED_HUMAN",
          handoffCause: eligibilityCause,
          assistantProvider: deps.ai.providerName,
          observability: turnObservability,
          delivery,
        };
      }

      // Provider preference matching against the CORE-01 eligible set
      const providerMatch = matchProviderByName(
        mapped.providerText,
        eligibility.data.providers,
      );
      if (providerMatch.status === "missing") {
        const msg =
          providerMatch.reason === "ambiguous"
            ? "هناك أكثر من مزود يطابق طلبك — يرجى تحديد المزود بدقة."
            : "المزود المطلوب غير متاح لهذه الخدمة — يرجى اختيار مزود آخر أو اختيار أي مزود متاح.";
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          msg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          msg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: validated.intent,
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          observability: turnObservability,
          delivery,
        };
      }
      const providerId =
        providerMatch.status === "ok" ? providerMatch.providerId : undefined;

      // CORE-02 — deterministic booking options (reuses CORE-01 + availability layer)
      const bookingDeps = buildBookingDeps(deps, eligibilityDeps);
      const bookingResult = await resolveBookingOptions(
        bookingDeps as unknown as Parameters<typeof resolveBookingOptions>[0],
        { userId: customer.id, businessId: business.id },
        {
          serviceId: mapped.serviceId,
          ...(mapped.branchId ? { branchId: mapped.branchId } : {}),
          ...(providerId ? { providerId } : {}),
          date: mapped.date!,
        },
      );
      if (!bookingResult.success) {
        const msg = bookingOptionsErrorMessage(bookingResult.error.code);
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          msg,
          "NEED_HUMAN",
        );
        if (!conversation.aiSummary) {
          await deps.conversationRepository.update(conversation.id, {
            aiSummary: validated.summary ?? `طلب حجز: ${mapped.serviceName}`,
          });
        }
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          msg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_HANDOFF",
          intent: validated.intent,
          conversationStatus: "NEED_HUMAN",
          // CORE-02 blocked the booking — an authoritative domain constraint.
          handoffCause: "DOMAIN_REQUIRES_HUMAN",
          assistantProvider: deps.ai.providerName,
          observability: turnObservability,
          delivery,
        };
      }
      if (bookingResult.data.options.length === 0) {
        const reason = bookingResult.reason ?? "FULLY_BOOKED";
        const msg = bookingEmptyReasonMessage(reason, mapped.date!);
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          msg,
          "NEED_HUMAN",
        );
        if (!conversation.aiSummary && reason !== "FULLY_BOOKED") {
          await deps.conversationRepository.update(conversation.id, {
            aiSummary: validated.summary ?? `طلب حجز: ${mapped.serviceName}`,
          });
        }
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          msg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_HANDOFF",
          intent: validated.intent,
          conversationStatus: "NEED_HUMAN",
          // CORE-02 found no bookable options — a domain constraint the
          // assistant cannot resolve autonomously.
          handoffCause: "DOMAIN_REQUIRES_HUMAN",
          assistantProvider: deps.ai.providerName,
          observability: turnObservability,
          delivery,
        };
      }
      const timeOfDayPref =
        bookingAiResponse.extraction.timePreference ??
        extractTimeOfDayPreference(inbound.text);

      let bookableOptions = bookingResult.data.options;
      if (timeOfDayPref) {
        const matchesPref = (startTime: string) => {
          const hour = parseInt(startTime.slice(0, 2), 10);
          if (Number.isNaN(hour)) return true;
          if (timeOfDayPref === "morning") return hour < 12;
          if (timeOfDayPref === "afternoon") return hour >= 12 && hour < 17;
          if (timeOfDayPref === "evening") return hour >= 17;
          return true;
        };
        const preferred = bookableOptions.filter((o) =>
          matchesPref(o.startAt.slice(11, 16)),
        );
        const others = bookableOptions.filter(
          (o) => !matchesPref(o.startAt.slice(11, 16)),
        );
        if (preferred.length > 0) {
          bookableOptions = [...preferred, ...others];
        }
      }

      let slotOffer: SlotOffer | null = null;
      if (turnSession.enabled) {
        slotOffer = buildSlotOffer(
          { businessId: business.id, conversationId: conversation.id },
          crypto.randomUUID(),
          {
            serviceId: mapped.serviceId,
            serviceName: mapped.serviceName,
            serviceSource: mapped.serviceSource,
            providerId: mapped.providerText ?? null,
            date: mapped.date!,
            followUpRequestId: activeFollowUpId,
            shownCount: bookableOptions.length,
            options: bookableOptions.map((o) => ({
              providerId: o.providerId,
              displayName: o.displayName,
              startAt: o.startAt,
              endAt: o.endAt,
            })),
          },
          now,
        );
        if (slotOffer) {
          turnSession.state = withPresentedOffer(
            turnSession.state ?? resolvedState ?? emptyConversationState(),
            slotOffer,
          );
          await turnSession.commit();
        }
      }

      const isTelegram = customer.phone.startsWith("tg:");
      const replyMarkup = isTelegram
        ? slotOffer
          ? slotOfferKeyboard(slotOffer)
          : {
              inline_keyboard: [
                bookableOptions.slice(0, 3).map((_, i) => ({
                  text: `${i + 1}️⃣ اختيار ${i + 1}`,
                  callback_data: `opt_${i + 1}`,
                })),
                [
                  { text: "🔄 أوقات أخرى", callback_data: "more_times" },
                  { text: "📅 يوم آخر", callback_data: "change_date" },
                ],
              ],
            }
        : undefined;

      // Success with options — AI_REPLY, stay AI_ACTIVE (no appointment mutation)
      const optionsMsg = formatBookingOptionsMessage(
        mapped.serviceName,
        mapped.date!,
        bookableOptions,
        activeFollowUpId,
      );
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        optionsMsg,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        optionsMsg,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
        replyMarkup,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_REPLY",
        intent: validated.intent,
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        observability: turnObservability,
        delivery,
      };
    }
    // 9d. B-03 — the customer disclosure boundary (PROMPT-B03). "AI may
    //     know this" is not "AI may mention this": a fact the assistant was
    //     given (it entered the AiRequest) is not automatically something it
    //     may put in a reply. The gate reads the B-02 disclosure ledger and
    //     refuses to emit a self-authored reply whose task is not backed by
    //     an included + disclosable + carried fact — an INTERNAL fact can
    //     never back it, a CONDITIONAL fact only when its task is relevant,
    //     a FORBIDDEN fact never. Booking-intent content was authored by the
    //     domain above (CORE-01/CORE-02), so it never reaches this gate;
    //     only assistant-authored text does.
    const disclosure = enforceDisclosure({
      response: validated,
      context: { request: aiRequest, facts: builtContext.facts },
    });
    // PROMPT-AI-OPS-22 — record the gate's verdict on the evidence record so
    // "did disclosure allow or refuse this channel?" is answerable from
    // evidence. `channel` is the LEDGER FAMILY the gate decided on: the family
    // that actually backed a disclosed knowledge reply; `routing-action` when
    // the turn's output is a routing action (handoff / booking_handoff), which
    // discloses no knowledge and so is passed through; or the primary family a
    // refused self-authored reply needed. Closed machine keys only — never
    // reply text or policy internals surfaced to a customer.
    turnObservability = {
      ...turnObservability,
      disclosure: {
        channel:
          disclosure.kind === "disclosed"
            ? (disclosure.support[0] ?? "routing-action")
            : (TASK_SUPPORT_FAMILIES[validated.intent].family ??
              "declared-intent"),
        allowed: disclosure.kind === "disclosed",
        ...(disclosure.kind === "requires-human"
          ? { refusalReason: disclosure.reason }
          : {}),
      },
    };
    if (disclosure.kind !== "disclosed") {
      // 9d-pre. INTERRUPTION RECOVERY (PROMPT-AI-ARCH-08). When a refused
      //     self-authored reply is actually a BENIGN non-task interruption of a
      //     RESUMABLE booking/domain task (the engine-owned ConversationState
      //     marked the active task INTERRUPTED this turn), preserving the task
      //     is strictly better than escalating: the customer paused the booking
      //     with a social aside («ثواني بس، أنا في مكالمة») and expects to
      //     continue, not to be handed to a human. The engine drops the unbacked
      //     reply (disclosure safety is NOT weakened — nothing unjustified is
      //     emitted) and instead sends the fixed, knowledge-free interruption
      //     acknowledgment, staying AI_ACTIVE. The pending task survives in
      //     ConversationState + the authored offer in history, so the next turn
      //     resumes it deterministically. Scope is deliberately narrow:
      //       - a sensitive / explicit-human turn never reaches here (it was
      //         handed off at 9a-pre by the resolver's safety precedence), and
      //       - a knowledge QUESTION (ending «؟»/"?") stays a NEED_HUMAN
      //         knowledge gap — only a benign non-question interruption of an
      //         already-active task is preserved.
      const resumableInterruption =
        resolvedState != null &&
        resolvedState.bookingStage === "INTERRUPTED" &&
        resolvedState.activeTask != null &&
        !inbound.text.includes("؟") &&
        !inbound.text.includes("?");
      if (resumableInterruption) {
        const ack = clarificationForInterruption();
        const preserveObservability: TurnObservability = {
          ...turnObservability,
          turnPlan: {
            steps: [{ kind: "CLARIFY", intent: validated.intent }],
          },
          clarification: { type: ack.type },
        };
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          ack.question,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          ack.question,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: validated.intent,
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          observability: preserveObservability,
          delivery,
        };
      }
      // The refused self-authored reply is dropped — B-03 never persists or
      // sends a reply it cannot justify from the disclosure ledger. But the
      // customer is NOT left in silence: the turn delivers the SAME safe,
      // deterministic handoff acknowledgment the deterministic assistant
      // produces for this message (`classifyCustomerMessage` never invents
      // business data — no FAQ match means a typed handoff reply), then
      // takes the existing NEED_HUMAN + operator-attention handoff path.
      // This keeps the E2E WhatsApp reply path alive for conversational
      // turns a business has no knowledge store for (a greeting, a question
      // with no stored FAQ) without ever emitting an unbacked reply. The
      // refusal reason stays an operator-side diagnostic (never customer-
      // visible): the customer sees only the safe acknowledgment.
      const safeHandoff = classifyCustomerMessage(
        inbound.text,
        builtContext.request.faqs,
      );
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        safeHandoff.content,
        "NEED_HUMAN",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        safeHandoff.content,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
      );
      if (turnSession.enabled) {
        turnSession.state = withOfferStatus(
          turnSession.state ?? resolvedState ?? emptyConversationState(),
          "INVALIDATED",
        );
        await turnSession.commit();
      }
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_HANDOFF",
        intent: null,
        conversationStatus: "NEED_HUMAN",
        // The B-03 disclosure gate refused an unbacked self-authored reply —
        // the assistant could not justify the answer from authoritative
        // sources, which is a policy refusal, never a knowledge gap.
        handoffCause: "POLICY_REFUSED",
        assistantProvider: deps.ai.providerName,
        observability: turnObservability,
        delivery,
      };
    }
    const content = disclosure.response.content;

    // ANSWER-AND-CONTINUE (PROMPT-AI-ARCH-09 — Slice 5). When the SAME customer
    // turn expressed a KNOWLEDGE goal AND a DOMAIN/booking goal, the resolver
    // resolved it to ANSWER with the domain goal in `pendingGoals`
    // (`answerAndContinue`). The knowledge answer above was authored + disclosed
    // normally; here the engine COMPOSES exactly ONE coherent send by appending
    // the fixed, knowledge-free continuation invite (B-03 §16 — it names no
    // business fact), keeping the booking task alive. This produces NO second
    // send, NO second model call, and NO domain mutation: the booking goal is
    // preserved and the appended invite is also the migration-safe history
    // marker (`derivePendingContinuation`) the NEXT turn reads to resume it.
    // Safety is unaffected — a safety/human/domain-blocked turn never reaches
    // this disclosed-answer path (it handed off earlier), and a handoff turn
    // (`action !== "reply"`) never answer-and-continues.
    const answerAndContinue =
      validated.action === "reply" &&
      resolvedTurn?.answerAndContinue === true &&
      resolvedTurn.pendingGoals.length > 0;
    const finalContent = answerAndContinue
      ? `${content}\n\n${CONTINUE_DOMAIN_INVITE}`
      : content;

    // 10. Persist the assistant reply through the single write path with
    //     the workflow the turn decided.
    const assistantMessage = await deps.conversationRepository.addMessage(
      {
        conversationId: conversation.id,
        senderType: "AI",
        content: finalContent,
      },
      {
        status: validated.action === "reply" ? "AI_ACTIVE" : "NEED_HUMAN",
      },
    );

    // Booking-related handoffs record a short staff-facing summary in
    // the EXISTING aiSummary field — only when it is still empty (a
    // staff-written summary is never clobbered).
    if (validated.action === "booking_handoff" && !conversation.aiSummary) {
      await deps.conversationRepository.update(conversation.id, {
        aiSummary: validated.summary,
      });
    }

    // 11. Deliver through the transport boundary — best-effort; the
    //     persisted message is the record of truth, delivery is reported.
    let delivery: InboundSuccess["delivery"] = null;
    try {
      const sent = await deps.transport.send({
        to: customer.phone,
        businessId: business.id,
        businessName: business.name,
        conversationId: conversation.id,
        content: finalContent,
        connectionId: outboundConnectionId ?? undefined,
      });
      delivery = {
        provider: sent.provider,
        delivered: sent.delivered,
        ...(sent.error ? { error: sent.error } : {}),
      };
    } catch (error) {
      delivery = {
        provider: deps.transport.providerName,
        delivered: false,
        error: error instanceof Error ? error.message : "transport error",
      };
    }
    await recordUsage(deps, {
      businessId: business.id,
      kind: "OUTBOUND_MESSAGE",
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      provider: delivery.provider,
      status: delivery.delivered ? "SUCCESS" : "FAILURE",
      occurredAt: new Date(),
    });

    if (turnSession.enabled && resolvedState) {
      let finalState = resolvedState;
      if (
        validated.action !== "reply" ||
        validated.intent === "HUMAN_REQUEST" ||
        validated.handoffReason
      ) {
        finalState = withOfferStatus(finalState, "INVALIDATED");
      }
      turnSession.state = finalState;
      await turnSession.commit();
    }

    return {
      ok: true,
      duplicate: false,
      businessId: business.id,
      conversationId: conversation.id,
      customerId: customer.id,
      customerMessageId: customerMessage.id,
      assistantAction: validated.action === "reply" ? "AI_REPLY" : "AI_HANDOFF",
      intent: validated.intent,
      conversationStatus:
        validated.action === "reply" ? "AI_ACTIVE" : "NEED_HUMAN",
      // PROMPT-AI-ARCH-16 (Slice 7) — the turn's own decision is authoritative;
      // the cause only types it. A booking-related escalation is a domain
      // task routed to staff; any other handoff carries the model's VALIDATED
      // closed-enum reason (safety/human/knowledge/ambiguity already
      // pre-empted by the resolver's precedence above, so this can never
      // downgrade a safety handoff).
      handoffCause:
        validated.action === "booking_handoff"
          ? "DOMAIN_REQUIRES_HUMAN"
          : contractHandoffReasonToCause(validated.handoffReason),
      assistantProvider: deps.ai.providerName,
      observability: turnObservability,
      delivery,
    };
  } catch {
    return {
      ok: false,
      code: "PERSISTENCE_FAILED",
      message: PERSISTENCE_FAILED_MESSAGE,
    };
  }
}
