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
import {
  resolveWorkingDay,
  weekdayOf,
} from "@/features/appointments/server/availability-service";
import { resolveBookingOptions } from "@/features/appointments/server/booking-options-service";
import {
  composeExactTimeResponse,
  evaluateExactTimeAvailability,
} from "@/features/appointments/server/exact-time-service";
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
  AiFactUpdate,
  AiRequest,
  AiResponse,
  CanonicalTimePreference,
  RequiredSemanticCapability,
} from "@/features/conversations/server/ai-contract";
import {
  AI_RECENT_MESSAGE_LIMIT,
  isCanonicalTimePreference,
  parseAiResponse,
} from "@/features/conversations/server/ai-contract";
import {
  TASK_SUPPORT_FAMILIES,
  enforceDisclosure,
  isExplicitIdentityGoal,
} from "@/features/conversations/server/ai-disclosure";
import type {
  AiRoutingDecision,
  TurnExecutionAttempt,
  TurnObservability,
  TurnStateTransitionObservation,
} from "@/features/conversations/server/ai-observability";
import { buildTurnObservability } from "@/features/conversations/server/ai-observability";
import {
  isProviderNameCandidate,
  mapAiResponseToBookingInput,
  matchProviderByName,
  matchServiceByName,
} from "@/features/conversations/server/booking-mapper";
import type {
  DateOffer,
  ProviderOffer,
  ServiceOffer,
  SlotOffer,
} from "@/features/conversations/server/booking-offer";
import {
  buildDateOffer,
  buildProviderOffer,
  buildServiceDetailOffer,
  buildServiceOffer,
  buildSlotOffer,
  buildWelcomeOffer,
  isOfferLive,
} from "@/features/conversations/server/booking-offer";
import type {
  BookingSelection,
  BookingSelectionContext,
  OfferReply,
} from "@/features/conversations/server/booking-selection";
import {
  interpretOfferReply,
  tryParseBookingSelection,
} from "@/features/conversations/server/booking-selection";
import {
  buildChannelChoices,
  parseOfferCallback,
  type ChannelChoicePresentation,
} from "@/features/conversations/server/channel-choice";
import {
  CONTINUE_DOMAIN_INVITE,
  clarificationForBookingReason,
  clarificationForInterruption,
  derivePendingClarification,
  derivePendingContinuation,
} from "@/features/conversations/server/clarification";
import type { ConversationAi } from "@/features/conversations/server/conversation-ai";
import {
  SAFE_HANDOFF_REPLIES,
  buildBusinessIdentityContent,
  bypassDeterministicAi,
  normalizeArabicText,
  resolveSafeFailureReply,
  resolveTurnControlSignals,
} from "@/features/conversations/server/conversation-ai";
import {
  completeBookingTask,
  deriveConversationStateFromHistory,
  emptyConversationState,
  mergeConversationState,
  pendingOfferMirror,
  withOfferStatus,
  withPresentedOffer,
} from "@/features/conversations/server/conversation-state";
import type {
  ConversationFactKey,
  ConversationState,
} from "@/features/conversations/server/conversation-state";
import type {
  ConversationStateStore,
  TurnStateSession,
} from "@/features/conversations/server/conversation-state-store";
import { openTurnStateSession } from "@/features/conversations/server/conversation-state-store";
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
  filterElapsedSlots,
  formatArabicDate,
  formatArabicDateRange,
  formatBookingOptionsCopy,
  sampleRepresentativeSlots,
} from "@/features/conversations/server/presentation-formatters";
import {
  extractProviderPreferenceDetailed,
  extractTimeOfDayPreference,
  extractTimeOfDayPreferenceDetailed,
  resolveEgyptianRelativeDate,
  resolveEgyptianRelativeDateDetailed,
  todayIsoInTimeZone,
} from "@/features/conversations/server/relative-date";
import {
  reconcileTurnSemanticFacts,
  type ReconciledTurnFacts,
} from "@/features/conversations/server/semantic-facts";
import {
  addDaysToIso,
  daysBetweenIso,
  resolveServerTemporalRequest,
  resolveValidTimeZone,
} from "@/features/conversations/server/temporal-context";
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
import { nowTimeInTimeZone } from "@/lib/scheduling/slot-grid";
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
  /**
   * CORE-03B2A: Server-derived semantic capability requirement for free-form turns.
   * Defaults to "structured_turn" in production. Legacy callers may supply null
   * to preserve legacy bounded JEV behavior without capability routing.
   */
  requiredSemanticCapability?: RequiredSemanticCapability | null;
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
  requiredSemanticCapability: "structured_turn",
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
function bookingEmptyReasonMessage(
  reason: string,
  date: string,
  timePreference?: CanonicalTimePreference | null,
): string {
  switch (reason) {
    case "NO_ELIGIBLE_PROVIDERS":
      return "لا يوجد مزود متاح لهذه الخدمة حالياً — سيتواصل معك أحد أعضاء الفريق.";
    case "BUSINESS_CLOSED":
      return `المنشأة مغلقة يوم ${date} — يرجى اختيار تاريخ آخر.`;
    case "SERVICE_TOO_LONG":
      return "مدة الخدمة أطول من ساعات العمل في ذلك اليوم — يرجى اختيار خدمة أخرى أو تاريخ آخر.";
    case "NO_PERIOD_SLOTS": {
      const periodLabel =
        timePreference === "morning"
          ? "الصباحية"
          : timePreference === "afternoon"
            ? "بعد الظهر"
            : timePreference === "evening"
              ? "المسائية"
              : "المحددة";
      return `لا تتوفر مواعيد في الفترة ${periodLabel} يوم ${date}. يمكنك اختيار فترة أخرى أو يوم آخر.`;
    }
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
  isMoreTimes?: boolean,
): string {
  const normalizedOptions = options.map((opt, idx) => ({
    index: opt.index ?? idx + 1,
    providerId: opt.providerId,
    displayName: opt.displayName,
    startAt: opt.startAt ?? opt.start ?? opt.startTime ?? "",
    endAt: opt.endAt ?? opt.end ?? opt.endTime ?? null,
  }));

  const formattedDate = formatArabicDate(date);

  return formatBookingOptionsCopy({
    serviceName,
    date,
    formattedDate,
    options: normalizedOptions,
    followUpRequestId,
    isMoreTimes,
  });
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
    const reconciled = reconcileTurnSemanticFacts(
      decision.extraction,
      decision.factUpdates,
    );
    const { transitions } = mergeConversationState(base, {
      factUpdates: reconciled.effectiveFactUpdates,
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
  isStructuredSemanticTurn?: boolean,
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
    // CONV-CORE-02 & CORE-03D2: Single Decision Ownership & Safety Precedence.
    // Pure source-selection helper centralizes turn control signals:
    // - JEV semantic signals remain authoritative for JEV-owned turns.
    // - Structured generative turns use validated semantic safety assessment,
    //   preventing broad lexical false-handoffs on harmless wording while
    //   preserving genuine sensitive escalation, contradiction guards, and explicit human requests.
    // - Legacy turns fall back to the deterministic lexical detector.
    const signals = resolveTurnControlSignals({
      currentMessage,
      routing,
      decision,
      turnTelemetry,
      isStructuredSemanticTurn,
    });

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

    const turnReconciled = reconcileTurnSemanticFacts(
      decision.extraction,
      decision.factUpdates,
    );
    const factUpdates: AiFactUpdate[] = [
      ...turnReconciled.effectiveFactUpdates,
    ];

    const todayIso = todayIsoInTimeZone(now, timezone);
    const droppedFacts: ConversationFactKey[] = [];

    // CONV-CORE-02 / CORE-03A: Explicit unambiguous date in current turn (colloquial Egyptian date or ISO).
    // Reconciled semantic factUpdates/extraction are authoritative — only run lexical helper if date was NOT touched.
    // CORE-03B2B1: On structured semantic turns, prose must not supply or drop date.
    const dateRes = isStructuredSemanticTurn
      ? { positiveDate: null, negatedDates: [] as string[] }
      : resolveEgyptianRelativeDateDetailed(currentMessage, todayIso);
    if (!isStructuredSemanticTurn && !turnReconciled.isTouched("date")) {
      if (dateRes.positiveDate) {
        factUpdates.push({
          key: "date",
          value: dateRes.positiveDate,
          isRevision: Boolean(
            base.knownFacts.date &&
            base.knownFacts.date !== dateRes.positiveDate,
          ),
        });
      } else if (
        base.knownFacts.date &&
        dateRes.negatedDates.includes(base.knownFacts.date)
      ) {
        // Customer explicitly negated the currently-held date without positive replacement
        droppedFacts.push("date");
      }
    }

    // Explicit unambiguous time of day preference in current turn.
    // Reconciled semantic factUpdates/extraction are authoritative — only run lexical helper if timePreference was NOT touched.
    // CORE-03B2B1: On structured semantic turns, prose must not supply or drop timePreference.
    const timeRes = isStructuredSemanticTurn
      ? {
          positiveTime: null,
          negatedTimes: [] as Array<"morning" | "afternoon" | "evening">,
        }
      : extractTimeOfDayPreferenceDetailed(currentMessage);
    if (
      !isStructuredSemanticTurn &&
      !turnReconciled.isTouched("timePreference")
    ) {
      if (timeRes.positiveTime) {
        factUpdates.push({
          key: "timePreference",
          value: timeRes.positiveTime,
          isRevision: Boolean(
            base.knownFacts.timePreference &&
            base.knownFacts.timePreference !== timeRes.positiveTime,
          ),
        });
      } else if (
        base.knownFacts.timePreference &&
        timeRes.negatedTimes.includes(
          base.knownFacts.timePreference as "morning" | "afternoon" | "evening",
        )
      ) {
        // Customer explicitly negated the currently-held time preference without positive replacement
        droppedFacts.push("timePreference");
      }
    }

    // Explicit provider preference in current turn.
    // Reconciled semantic factUpdates/extraction are authoritative — only run lexical helper if provider was NOT touched.
    // CORE-03B2B1: On structured semantic turns, prose must not supply or drop provider.
    const provRes = isStructuredSemanticTurn
      ? { positiveProvider: null, negatedProviders: [] as string[] }
      : extractProviderPreferenceDetailed(currentMessage);
    if (!isStructuredSemanticTurn && !turnReconciled.isTouched("provider")) {
      if (provRes.positiveProvider) {
        factUpdates.push({
          key: "provider",
          value: provRes.positiveProvider,
          isRevision: Boolean(
            base.knownFacts.provider &&
            base.knownFacts.provider !== provRes.positiveProvider,
          ),
        });
      } else if (
        base.knownFacts.provider &&
        provRes.negatedProviders.some((np) => {
          const normNp = normalizeArabicText(np);
          const normHeld = normalizeArabicText(base.knownFacts.provider!);
          return (
            normNp === normHeld ||
            normHeld.includes(normNp) ||
            normNp.includes(normHeld)
          );
        })
      ) {
        // Customer explicitly negated the currently-held provider without positive replacement
        droppedFacts.push("provider");
      }
    }

    // SUPPLIED-FACT RESUME binding (PROMPT-AI-EVAL-07). When a clarification is
    // pending for exactly ONE conversation fact and the model's extraction did
    // NOT already supply it, bind the current customer turn as that fact so the
    // clarification RESOLVES through the ONE merge path (never a second fact
    // model). Gated to a plain CONTINUATION answer: a sensitive / explicit-human
    // turn keeps safety precedence, and an explicit escalation (the model asked
    // for a human) is a benign interruption to PRESERVE (rule 6), never a fact —
    // so neither is silently bound as a booking fact.
    // CORE-03B2B1: Scoped booking facts (date, timePreference, provider) must not
    // be bound from arbitrary customer prose after AI on structured semantic turns.
    const modelEscalatesHuman =
      decision.intent === "HUMAN_REQUEST" ||
      decision.handoffReason === "HUMAN_REQUEST";
    const isInterruption =
      decision.intent === "FAQ" ||
      decision.intent === "GREETING" ||
      decision.intent === "AMBIGUOUS";
    if (
      pending &&
      pending.missingFacts.length === 1 &&
      !signals.sensitive &&
      !signals.explicitHuman &&
      !modelEscalatesHuman &&
      !isInterruption
    ) {
      const missing = pending.missingFacts[0]!;
      const alreadySupplied =
        factUpdates.some((u) => u.key === missing) ||
        turnReconciled.isRemoved(missing) ||
        base.knownFacts[missing] != null;
      const trimmed = currentMessage.trim();
      const isScopedFact =
        missing === "date" ||
        missing === "timePreference" ||
        missing === "provider";
      if (!isStructuredSemanticTurn || !isScopedFact) {
        if (!alreadySupplied && trimmed.length > 0) {
          if (missing === "date") {
            const iso = resolveEgyptianRelativeDate(currentMessage, todayIso);
            if (iso) {
              factUpdates.push({ key: missing, value: iso });
            }
          } else {
            factUpdates.push({ key: missing, value: trimmed });
          }
        }
      }
    }

    // Preserve prior date and time-of-day preferences from recent customer messages
    // ONLY for legacy unmanaged initialization (when valid durable priorState is absent).
    // When priorState is loaded, durable knownFacts is authoritative and deleted/cleared facts
    // must not be repeatedly reconstructed from older conversation text.
    // CORE-03B2B1: On structured semantic turns, history scans must not reconstruct scoped facts.
    if (!priorState && !isStructuredSemanticTurn) {
      if (
        !turnReconciled.isTouched("date") &&
        !factUpdates.some((u) => u.key === "date") &&
        !base.knownFacts.date &&
        dateRes.negatedDates.length === 0
      ) {
        const historyNegatedDates: string[] = [...dateRes.negatedDates];
        for (let i = recentChronological.length - 1; i >= 0; i--) {
          const m = recentChronological[i]!;
          if (m.senderType === "CUSTOMER") {
            const detailed = resolveEgyptianRelativeDateDetailed(
              m.content,
              todayIso,
            );
            for (const nd of detailed.negatedDates) {
              if (!historyNegatedDates.includes(nd)) {
                historyNegatedDates.push(nd);
              }
            }
            if (
              detailed.positiveDate &&
              !historyNegatedDates.includes(detailed.positiveDate)
            ) {
              factUpdates.push({ key: "date", value: detailed.positiveDate });
              break;
            }
            const iso = m.content.match(/\b\d{4}-\d{2}-\d{2}\b/);
            if (iso && !historyNegatedDates.includes(iso[0])) {
              factUpdates.push({ key: "date", value: iso[0] });
              break;
            }
          }
        }
      }
      if (
        !turnReconciled.isTouched("timePreference") &&
        !factUpdates.some((u) => u.key === "timePreference") &&
        !base.knownFacts.timePreference &&
        timeRes.negatedTimes.length === 0
      ) {
        const historyNegatedTimes: Array<"morning" | "afternoon" | "evening"> =
          [...timeRes.negatedTimes];
        for (let i = recentChronological.length - 1; i >= 0; i--) {
          const m = recentChronological[i]!;
          if (m.senderType === "CUSTOMER") {
            const detailed = extractTimeOfDayPreferenceDetailed(m.content);
            for (const nt of detailed.negatedTimes) {
              if (!historyNegatedTimes.includes(nt)) {
                historyNegatedTimes.push(nt);
              }
            }
            if (
              detailed.positiveTime &&
              !historyNegatedTimes.includes(detailed.positiveTime)
            ) {
              factUpdates.push({
                key: "timePreference",
                value: detailed.positiveTime,
              });
              break;
            }
          }
        }
      }
    }

    const deferredGoals = decision.goals
      ?.slice(1)
      .filter((g) => g.kind === "DOMAIN_ACTION");
    const { state } = mergeConversationState(seeded, {
      factUpdates,
      turnGoal: decision.intent,
      ...(decision.goals ? { goals: decision.goals } : {}),
      ...(deferredGoals && deferredGoals.length > 0 ? { deferredGoals } : {}),
      ...(droppedFacts.length > 0 ? { droppedFacts } : {}),
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
  reconciled?: ReconciledTurnFacts,
): AiResponse {
  const rec =
    reconciled ??
    reconcileTurnSemanticFacts(response.extraction, response.factUpdates);
  const e = rec.normalizedExtraction;
  const serviceChanged = Boolean(
    e.service &&
    state.knownFacts.service &&
    e.service !== state.knownFacts.service,
  );

  const service = rec.isRemoved("service")
    ? null
    : (rec.setFacts.get("service")?.value ??
      e.service ??
      state.knownFacts.service ??
      null);

  const turnProvider =
    rec.setFacts.get("provider")?.value ?? e.provider ?? null;
  const provider = rec.isRemoved("provider")
    ? null
    : serviceChanged
      ? turnProvider
      : (turnProvider ?? state.knownFacts.provider ?? null);

  const rawTimePreference = rec.isRemoved("timePreference")
    ? null
    : (rec.setFacts.get("timePreference")?.value ??
      e.timePreference ??
      state.knownFacts.timePreference ??
      null);
  const timePreference: CanonicalTimePreference | null =
    isCanonicalTimePreference(rawTimePreference) ? rawTimePreference : null;

  // Distinguish temporal proposals made in THIS turn from facts inherited from previous turns.
  // When the current turn explicitly proposes or modifies temporal context (a new temporalRequest,
  // date in extraction/setFacts, or an explicit date/dateRange remove), inherited date must not
  // be injected to falsely contradict the current proposal.
  const hasTurnTemporalProposal =
    rec.isTouched("date") ||
    rec.isTouched("dateRange") ||
    Boolean(e.date) ||
    Boolean(e.temporalRequest) ||
    Boolean(response.extraction.temporalRequest);

  const stateDate =
    serviceChanged || hasTurnTemporalProposal
      ? null
      : (state.knownFacts.date ?? null);
  const date = rec.isRemoved("date")
    ? null
    : (rec.setFacts.get("date")?.value ??
      e.date ??
      (stateDate && RESUME_ISO_DATE.test(stateDate) ? stateDate : null));

  let exactTime = e.exactTime ?? null;
  if (rec.isRemoved("exactTime")) {
    exactTime = null;
  } else if (rec.setFacts.has("exactTime")) {
    exactTime = {
      type: "specific",
      time: rec.setFacts.get("exactTime")!.value,
    };
  } else if (!rec.isTouched("exactTime") && !e.exactTime) {
    if (state.knownFacts.exactTime) {
      exactTime = {
        type: "specific",
        time: state.knownFacts.exactTime,
      };
    } else if (state.knownFacts.unresolvedTime) {
      exactTime = {
        type: "unresolved_period",
        hour: state.knownFacts.unresolvedTime.hour,
        minute: state.knownFacts.unresolvedTime.minute ?? 0,
      };
    }
  }

  const exactTimeUnchanged =
    (exactTime === null && response.extraction.exactTime == null) ||
    (exactTime?.type === "specific" &&
      response.extraction.exactTime?.type === "specific" &&
      exactTime.time === response.extraction.exactTime.time) ||
    (exactTime?.type === "unresolved_period" &&
      response.extraction.exactTime?.type === "unresolved_period" &&
      exactTime.hour === response.extraction.exactTime.hour &&
      (exactTime.minute ?? 0) === (response.extraction.exactTime.minute ?? 0));

  const factUpdatesModifiedExtraction =
    rec.isTouched("service") ||
    rec.isTouched("provider") ||
    rec.isTouched("date") ||
    rec.isTouched("dateRange") ||
    rec.isTouched("timePreference") ||
    rec.isTouched("exactTime");

  if (
    !factUpdatesModifiedExtraction &&
    service === response.extraction.service &&
    provider === response.extraction.provider &&
    timePreference === response.extraction.timePreference &&
    date === response.extraction.date &&
    exactTimeUnchanged
  ) {
    return response; // nothing to supplement — unchanged
  }
  return {
    ...response,
    extraction: { ...e, service, provider, date, timePreference, exactTime },
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
  choices?: ChannelChoicePresentation,
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
      ...(choices ? { choices } : {}),
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
    timezone?: string | null;
    workingHours?: unknown;
    defaultServiceBookingEnabled?: boolean;
    defaultBookingServiceId?: string | null;
    defaultServiceId?: string | null;
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
    price?: number | null;
    description?: string | null;
    isActive?: boolean;
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
  observability?: TurnObservability,
  choices?: ChannelChoicePresentation,
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
    choices,
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
    assistantProvider: observability?.provider ?? deps.ai.providerName,
    delivery,
    observability:
      observability ??
      buildTurnObservability({
        routingDecision: "DETERMINISTIC_BYPASS",
        provider: deps.ai.providerName,
        providerAttempts: 0,
        providerStatus: "NOT_CALLED",
        modelCallCount: 0,
      }),
  };
}

export type UpcomingBookingDatesResult =
  | {
      readonly status: "success";
      readonly dates: Array<{ date: string; label: string }>;
      readonly hasMore: boolean;
      readonly pageOffset: number;
      readonly totalEligibleCount: number;
      readonly range?: { startDate: string; endDate: string } | null;
      readonly cursorDate?: string | null;
      readonly shownDates?: string[];
    }
  | {
      readonly status: "too_broad";
      readonly requestedDays: number;
      readonly maxDays: number;
      readonly startDate: string;
      readonly endDate: string;
    }
  | {
      readonly status: "error";
      readonly code:
        "INFRASTRUCTURE_FAILURE" | "DOMAIN_ERROR" | "PARTIAL_FAILURE";
      readonly error?: { code: string; message: string };
      readonly dates?: Array<{ date: string; label: string }>;
      readonly hasMore?: boolean;
      readonly pageOffset?: number;
      readonly totalEligibleCount?: number;
      readonly range?: { startDate: string; endDate: string } | null;
      readonly cursorDate?: string | null;
      readonly shownDates?: string[];
    };

export async function resolveUpcomingBookingDates(
  deps: ConversationEngineDeps,
  scope: {
    business: {
      id: string;
      timezone?: string | null;
      workingHours?: unknown;
      slotDurationMinutes?: number;
    };
    branchId?: string | null;
    customerId?: string;
  },
  input: {
    serviceId: string;
    providerId?: string | null;
    timePreference?: CanonicalTimePreference | null;
    range?: { startDate: string; endDate: string } | null;
    offsetIndex?: number;
    cursorDate?: string | null;
    shownDates?: string[];
  },
  now: Date,
  count = 4,
): Promise<UpcomingBookingDatesResult> {
  const tz = resolveValidTimeZone(scope.business.timezone);
  const todayIso = todayIsoInTimeZone(now, tz);
  const currentTime = nowTimeInTimeZone(now, tz);

  if (input.range) {
    const spanDays =
      daysBetweenIso(input.range.startDate, input.range.endDate) + 1;
    if (spanDays > 14) {
      return {
        status: "too_broad",
        requestedDays: spanDays,
        maxDays: 14,
        startDate: input.range.startDate,
        endDate: input.range.endDate,
      };
    }
    if (input.range.endDate < todayIso) {
      return {
        status: "success",
        dates: [],
        hasMore: false,
        pageOffset: 0,
        totalEligibleCount: 0,
        range: input.range,
        cursorDate: null,
        shownDates: [],
      };
    }
  }

  const scanStartIso = input.range
    ? input.range.startDate < todayIso
      ? todayIso
      : input.range.startDate
    : todayIso;
  const daysToScan = input.range
    ? Math.max(0, daysBetweenIso(scanStartIso, input.range.endDate) + 1)
    : 14;

  const [y, m, d] = todayIso.split("-").map(Number);
  const tomorrowCandidate = new Date(Date.UTC(y!, m! - 1, d! + 1));
  const tomorrowIso = tomorrowCandidate.toISOString().slice(0, 10);
  const allEligibleDates: Array<{ date: string; label: string }> = [];

  const eligibilityDeps = buildEligibilityDeps(deps);
  const bookingDeps = buildBookingDeps(deps, eligibilityDeps);

  let succeededDays = 0;
  let exceptionsCount = 0;
  const domainErrors: Array<{ code: string; message: string }> = [];

  for (let i = 0; i < daysToScan; i++) {
    const iso = addDaysToIso(scanStartIso, i);
    const weekday = weekdayOf(iso);
    const workingDay = resolveWorkingDay(
      scope.business as unknown as Parameters<typeof resolveWorkingDay>[0],
      weekday,
    );
    if (!workingDay) continue;

    if (iso === todayIso) {
      const [hh, mm] = currentTime.split(":").map(Number);
      const currentMins = (hh ?? 0) * 60 + (mm ?? 0);
      if (currentMins >= workingDay.closeMinutes) {
        continue; // Today's business hours have closed
      }
    }

    try {
      const bookingResult = await resolveBookingOptions(
        bookingDeps as unknown as Parameters<typeof resolveBookingOptions>[0],
        { userId: scope.customerId ?? "guest", businessId: scope.business.id },
        {
          serviceId: input.serviceId,
          ...(scope.branchId ? { branchId: scope.branchId } : {}),
          date: iso,
          ...(input.providerId ? { providerId: input.providerId } : {}),
          ...(input.timePreference
            ? { timePreference: input.timePreference }
            : {}),
          ...(iso === todayIso ? { minStartTime: currentTime } : {}),
          limit: 50,
        },
      );

      if (!bookingResult.success) {
        domainErrors.push(bookingResult.error);
      } else {
        succeededDays++;
        const validOptions = filterElapsedSlots(
          bookingResult.data.options,
          iso,
          now,
          tz,
        );
        if (validOptions.length > 0) {
          const label = formatArabicDate(iso, {
            todayIso,
            tomorrowIso,
            withRelativePrefix: true,
          });
          allEligibleDates.push({ date: iso, label });
        }
      }
    } catch {
      exceptionsCount++;
    }
  }

  const pageOffset = input.offsetIndex ?? 0;
  const totalEligibleCount = allEligibleDates.length;

  let pagedDates: Array<{ date: string; label: string }>;
  let hasMore: boolean;

  if (input.cursorDate) {
    const datesAfterCursor = allEligibleDates.filter(
      (d) => d.date > input.cursorDate!,
    );
    pagedDates = datesAfterCursor.slice(0, count);
    hasMore = datesAfterCursor.length > count;
  } else {
    pagedDates = allEligibleDates.slice(pageOffset, pageOffset + count);
    hasMore = pageOffset + count < totalEligibleCount;
  }

  const cursorDate =
    pagedDates.length > 0
      ? pagedDates[pagedDates.length - 1]!.date
      : (input.cursorDate ?? null);
  const shownDates = Array.from(
    new Set([...(input.shownDates ?? []), ...pagedDates.map((d) => d.date)]),
  );

  if (exceptionsCount === 0 && domainErrors.length === 0) {
    return {
      status: "success",
      dates: pagedDates,
      hasMore,
      pageOffset,
      totalEligibleCount,
      range: input.range ?? null,
      cursorDate,
      shownDates,
    };
  }

  if (pagedDates.length > 0) {
    return {
      status: "error",
      code: "PARTIAL_FAILURE",
      dates: pagedDates,
      hasMore,
      pageOffset,
      totalEligibleCount,
      range: input.range ?? null,
      cursorDate,
      shownDates,
      error: domainErrors[0] ?? {
        code: "PARTIAL_FAILURE",
        message: "حدث تعذر جزئي أثناء التحقق من المواعيد",
      },
    };
  }

  // results.length === 0 and there were failures
  if (succeededDays > 0) {
    return {
      status: "error",
      code: "PARTIAL_FAILURE",
      dates: [],
      hasMore: false,
      pageOffset,
      totalEligibleCount: 0,
      range: input.range ?? null,
      error: domainErrors[0] ?? {
        code: "PARTIAL_FAILURE",
        message: "حدث تعذر جزئي أثناء التحقق من المواعيد",
      },
    };
  }

  if (exceptionsCount > 0 && domainErrors.length === 0) {
    return {
      status: "error",
      code: "INFRASTRUCTURE_FAILURE",
      error: {
        code: "DATABASE_ERROR",
        message: "تعذر الاتصال بقاعدة البيانات",
      },
    };
  }

  if (domainErrors.length > 0 && exceptionsCount === 0) {
    return {
      status: "error",
      code: "DOMAIN_ERROR",
      error: domainErrors[0],
    };
  }

  return {
    status: "error",
    code: "INFRASTRUCTURE_FAILURE",
    error: {
      code: "INFRASTRUCTURE_FAILURE",
      message: "تعذر التحقق من المواعيد المتاحة",
    },
  };
}

type ProviderResolutionResult =
  | { readonly kind: "resolved"; readonly providerId: string | null }
  | {
      readonly kind: "clarification";
      readonly eligibleProviders: ReadonlyArray<{
        readonly providerId: string;
        readonly displayName: string;
      }>;
      readonly reason: "not_found" | "ambiguous";
    };

async function resolveProviderCandidate(
  deps: ConversationEngineDeps,
  businessId: string,
  branchId: string | null,
  serviceId: string,
  candidateText: string | null | undefined,
  mode: "catalog_strict" | "legacy" = "catalog_strict",
): Promise<ProviderResolutionResult> {
  if (!candidateText || candidateText.trim().length === 0) {
    return { kind: "resolved", providerId: null };
  }

  const eligibilityDeps = buildEligibilityDeps(deps);
  const elig = await resolveEligibleProviders(
    eligibilityDeps as unknown as Parameters<
      typeof resolveEligibleProviders
    >[0],
    { businessId },
    {
      serviceId,
      ...(branchId ? { branchId } : {}),
    },
  );

  if (!elig.success) {
    return {
      kind: "clarification",
      eligibleProviders: [],
      reason: "not_found",
    };
  }

  const direct = elig.data.providers.find(
    (p) => p.providerId === candidateText,
  );
  if (direct) {
    return { kind: "resolved", providerId: direct.providerId };
  }

  const match = matchProviderByName(candidateText, elig.data.providers, {
    mode,
  });

  if (match.status === "ok") {
    return { kind: "resolved", providerId: match.providerId };
  }
  if (match.status === "any") {
    return { kind: "resolved", providerId: null };
  }

  return {
    kind: "clarification",
    eligibleProviders: elig.data.providers,
    reason: match.reason,
  };
}

async function promptProviderClarificationReply(
  deps: ConversationEngineDeps,
  scope: BookingSelectionScope,
  input: {
    serviceId: string;
    serviceName: string;
    date: string | null;
    eligibleProviders: ReadonlyArray<{
      readonly providerId: string;
      readonly displayName: string;
    }>;
    reason: "not_found" | "ambiguous";
    intent?: AiResponse["intent"] | null;
    observability?: InboundSuccess["observability"];
  },
  turnSession: TurnStateSession,
  now: Date,
): Promise<InboundSuccess> {
  const msg =
    input.reason === "ambiguous"
      ? "هناك أكثر من مزود يطابق طلبك — يرجى تحديد المزود بدقة."
      : "المزود المطلوب غير متاح لهذه الخدمة — يرجى اختيار مزود آخر أو اختيار أي مزود متاح.";
  let providerOffer: ProviderOffer | null = null;
  if (turnSession.enabled && input.eligibleProviders.length > 0) {
    const eligibleProviders: Array<{
      providerId: string | null;
      name: string;
    }> = input.eligibleProviders.map((p) => ({
      providerId: p.providerId,
      name: p.displayName,
    }));
    eligibleProviders.push({
      providerId: null,
      name: "أي مقدم خدمة متاح",
    });
    providerOffer = buildProviderOffer(
      { businessId: scope.business.id, conversationId: scope.conversation.id },
      crypto.randomUUID(),
      {
        serviceId: input.serviceId,
        serviceName: input.serviceName,
        date: input.date,
        providers: eligibleProviders,
      },
      now,
    );
    if (providerOffer) {
      turnSession.state = withPresentedOffer(
        turnSession.state ?? emptyConversationState(),
        providerOffer,
      );
      const ok = await turnSession.commit();
      if (!ok) {
        return selectionReply(
          deps,
          scope,
          "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
          "AI_ACTIVE",
          null,
          undefined,
          input.observability,
        );
      }
    }
  }
  const choices = providerOffer
    ? buildChannelChoices(providerOffer)
    : undefined;
  const assistantMessage = await persistAssistantReply(
    deps,
    scope.conversation.id,
    msg,
    "AI_ACTIVE",
  );
  const delivery = await deliverAssistantReply(
    deps,
    scope.customer.phone,
    scope.business.name,
    scope.conversation.id,
    msg,
    assistantMessage.id,
    scope.business.id,
    scope.connectionId,
    choices,
  );
  return {
    ok: true,
    duplicate: false,
    businessId: scope.business.id,
    conversationId: scope.conversation.id,
    customerId: scope.customer.id,
    customerMessageId: scope.customerMessageId,
    assistantAction: "AI_REPLY",
    intent: input.intent ?? "AVAILABILITY",
    conversationStatus: "AI_ACTIVE",
    handoffCause: null,
    assistantProvider: deps.ai.providerName,
    observability: input.observability,
    delivery,
  };
}

async function presentDateChoices(
  deps: ConversationEngineDeps,
  scope: BookingSelectionScope,
  input: {
    serviceId: string;
    serviceName: string;
    serviceSource: "CUSTOMER" | "DEFAULT";
    providerId: string | null;
    timePreference?: CanonicalTimePreference | null;
    observability?: InboundSuccess["observability"];
    range?: { startDate: string; endDate: string } | null;
    pageOffset?: number;
    cursorDate?: string | null;
    shownDates?: string[];
  },
  turnSession: TurnStateSession,
  now: Date,
): Promise<InboundSuccess> {
  const range = input.range ?? turnSession.state?.knownFacts.dateRange ?? null;
  const pageOffset = input.pageOffset ?? 0;

  const datesResult = await resolveUpcomingBookingDates(
    deps,
    {
      business: scope.business,
      branchId: scope.conversation.branchId,
      customerId: scope.customer.id,
    },
    {
      serviceId: input.serviceId,
      providerId: input.providerId,
      timePreference: input.timePreference,
      range,
      offsetIndex: pageOffset,
      cursorDate: input.cursorDate,
      shownDates: input.shownDates,
    },
    now,
  );

  if (datesResult.status === "too_broad") {
    return selectionReply(
      deps,
      scope,
      "نطاق البحث المطلوب يتجاوز 14 يوماً. يرجى اختيار أسبوع محدد أو تحديد فترة أقصر (حتى 14 يوماً) لعرض المواعيد المتاحة.",
      "AI_ACTIVE",
      null,
      undefined,
      input.observability,
    );
  }

  if (
    datesResult.status === "error" &&
    (!datesResult.dates || datesResult.dates.length === 0)
  ) {
    return selectionReply(
      deps,
      scope,
      "تعذر التحقق من المواعيد المتاحة حالياً بسبب مشكلة تقنية مؤقتة. يرجى المحاولة بعد قليل.",
      "AI_ACTIVE",
      null,
      undefined,
      input.observability,
    );
  }

  const upcomingDates = datesResult.dates ?? [];
  let dateOffer: DateOffer | null = null;
  if (datesResult.status === "success") {
    dateOffer = buildDateOffer(
      { businessId: scope.business.id, conversationId: scope.conversation.id },
      crypto.randomUUID(),
      {
        serviceId: input.serviceId,
        serviceName: input.serviceName,
        providerId: input.providerId,
        timePreference: input.timePreference,
        dates: upcomingDates,
        range,
        pageOffset:
          datesResult.status === "success"
            ? datesResult.pageOffset
            : pageOffset,
        cursorDate: datesResult.cursorDate,
        shownDates: datesResult.shownDates,
        hasMore: datesResult.status === "success" ? datesResult.hasMore : false,
        totalEligibleCount:
          datesResult.status === "success"
            ? datesResult.totalEligibleCount
            : upcomingDates.length,
      },
      now,
    );
  }

  const lines = [];
  if (range) {
    const rangeLabel = formatArabicDateRange(range.startDate, range.endDate);
    lines.push(
      `تم اختيار خدمة "${input.serviceName}". المواعيد المتاحة للفترة (${rangeLabel}):`,
    );
  } else {
    lines.push(
      `تم اختيار خدمة "${input.serviceName}". يرجى تحديد اليوم أو التاريخ المناسب لك:`,
    );
  }

  if (upcomingDates.length > 0) {
    for (let i = 0; i < upcomingDates.length; i++) {
      const displayIndex = (pageOffset ?? 0) + i + 1;
      lines.push(`${displayIndex}️⃣ ${upcomingDates[i]!.label}`);
    }
    if (datesResult.status === "success" && datesResult.hasMore) {
      lines.push("(اضغط على «مواعيد أخرى» لعرض المزيد من الأيام)");
    }
    if (range) {
      lines.push(
        "(أو يمكنك اختيار «فترة أخرى» لتغيير نطاق البحث أو كتابة تاريخ مباشرة)",
      );
    } else {
      lines.push("(أو يمكنك كتابة أي تاريخ آخر مباشرة في أي وقت)");
    }
  } else {
    if (range) {
      const rangeLabel = formatArabicDateRange(range.startDate, range.endDate);
      lines.push(
        `لا تتوفر مواعيد متاحة لهذه الخدمة خلال الفترة (${rangeLabel}). يمكنك اختيار فترة أخرى أو تجربة تاريخ مختلف:`,
      );
    } else {
      lines.push(
        "لا تتوفر مواعيد متاحة لهذه الخدمة خلال الـ 14 يوماً القادمة. يمكنك تجربة تحديد تاريخ آخر أو تغيير تفضيل الوقت:",
      );
    }
  }
  const dateMsg = lines.join("\n");

  if (turnSession.enabled) {
    if (dateOffer) {
      turnSession.state = withPresentedOffer(
        turnSession.state ?? emptyConversationState(),
        dateOffer,
      );
    }
    const existingFacts = turnSession.state?.knownFacts ?? {};
    turnSession.state = {
      ...(turnSession.state ?? emptyConversationState()),
      knownFacts: {
        ...existingFacts,
        service: input.serviceName,
        ...(input.timePreference
          ? { timePreference: input.timePreference }
          : {}),
        ...(range ? { dateRange: range } : {}),
      },
      serviceId: input.serviceId,
      selectedService: input.serviceName,
      serviceSource: input.serviceSource,
      providerPreference:
        input.providerId ?? turnSession.state?.providerPreference ?? null,
      selectedTimePref:
        input.timePreference ?? turnSession.state?.selectedTimePref ?? null,
      dateRange: range ?? turnSession.state?.dateRange ?? null,
      missingFacts: ["date"],
      lastClarification: { type: "date" },
      bookingStage: "SERVICE_SUPPLIED",
      activeTask: {
        kind: "BOOKING",
        stage: "SERVICE_SUPPLIED",
      },
    };
    const ok = await turnSession.commit();
    if (!ok) {
      return selectionReply(
        deps,
        scope,
        "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
        "AI_ACTIVE",
        null,
        undefined,
        input.observability,
      );
    }
  }

  const choices = dateOffer ? buildChannelChoices(dateOffer) : undefined;
  const assistantMessage = await persistAssistantReply(
    deps,
    scope.conversation.id,
    dateMsg,
    "AI_ACTIVE",
  );
  const delivery = await deliverAssistantReply(
    deps,
    scope.customer.phone,
    scope.business.name,
    scope.conversation.id,
    dateMsg,
    assistantMessage.id,
    scope.business.id,
    scope.connectionId,
    choices,
  );
  return {
    ok: true,
    duplicate: false,
    businessId: scope.business.id,
    conversationId: scope.conversation.id,
    customerId: scope.customer.id,
    customerMessageId: scope.customerMessageId,
    assistantAction: "AI_REPLY",
    intent: "AVAILABILITY",
    conversationStatus: "AI_ACTIVE",
    handoffCause: null,
    assistantProvider: input.observability?.provider ?? deps.ai.providerName,
    delivery,
    observability:
      input.observability ??
      buildTurnObservability({
        routingDecision: "DETERMINISTIC_BYPASS",
        provider: deps.ai.providerName,
        providerAttempts: 0,
        providerStatus: "NOT_CALLED",
        modelCallCount: 0,
      }),
  };
}

async function presentSlotChoices(
  deps: ConversationEngineDeps,
  scope: BookingSelectionScope,
  input: {
    serviceId: string;
    serviceName: string;
    serviceSource: "CUSTOMER" | "DEFAULT";
    providerId: string | null;
    date: string;
    timePreference?: CanonicalTimePreference | null;
    observability?: InboundSuccess["observability"];
    range?: { startDate: string; endDate: string } | null;
  },
  turnSession: TurnStateSession,
  now: Date,
): Promise<InboundSuccess> {
  const rawSavedTimeOfDay = turnSession.state?.knownFacts.timePreference;
  if (
    typeof rawSavedTimeOfDay === "string" &&
    rawSavedTimeOfDay.trim().length > 0 &&
    !isCanonicalTimePreference(rawSavedTimeOfDay)
  ) {
    if (turnSession.enabled) {
      await turnSession.invalidateOffer();
    }
    const clarMsg =
      "يرجى تحديد وقت الحجز المفضل: صباحاً، بعد الظهر، أو مساءً (أو اذكر أن أي وقت مناسب).";
    const assistantMessage = await persistAssistantReply(
      deps,
      scope.conversation.id,
      clarMsg,
      "AI_ACTIVE",
    );
    const delivery = await deliverAssistantReply(
      deps,
      scope.customer.phone,
      scope.business.name,
      scope.conversation.id,
      clarMsg,
      assistantMessage.id,
      scope.business.id,
      scope.connectionId,
    );
    return {
      ok: true,
      duplicate: false,
      businessId: scope.business.id,
      conversationId: scope.conversation.id,
      customerId: scope.customer.id,
      customerMessageId: scope.customerMessageId,
      assistantAction: "AI_REPLY",
      intent: "AVAILABILITY",
      conversationStatus: "AI_ACTIVE",
      handoffCause: null,
      assistantProvider: deps.ai.providerName,
      delivery,
    };
  }

  const branchId = (scope.conversation.branchId as string | null) ?? null;
  const timeOfDayPref =
    input.timePreference !== undefined
      ? input.timePreference
      : isCanonicalTimePreference(turnSession.state?.knownFacts.timePreference)
        ? turnSession.state.knownFacts.timePreference
        : null;
  const eligibilityDeps = buildEligibilityDeps(deps);
  const eligibility = await resolveEligibleProviders(
    eligibilityDeps as unknown as Parameters<
      typeof resolveEligibleProviders
    >[0],
    { businessId: scope.business.id },
    {
      serviceId: input.serviceId,
      ...(branchId ? { branchId } : {}),
      ...(input.providerId ? { providerId: input.providerId } : {}),
    },
  );

  if (eligibility.success) {
    const tz = resolveValidTimeZone(scope.business.timezone);
    const todayIso = todayIsoInTimeZone(now, tz);
    const isToday = input.date === todayIso;
    const currentTime = nowTimeInTimeZone(now, tz);

    const bookingDeps = buildBookingDeps(deps, eligibilityDeps);
    const bookingResult = await resolveBookingOptions(
      bookingDeps as unknown as Parameters<typeof resolveBookingOptions>[0],
      { userId: scope.customer.id, businessId: scope.business.id },
      {
        serviceId: input.serviceId,
        ...(branchId ? { branchId } : {}),
        date: input.date,
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(timeOfDayPref ? { timePreference: timeOfDayPref } : {}),
        ...(isToday ? { minStartTime: currentTime } : {}),
        limit: 50,
      },
    );

    if (bookingResult.success && bookingResult.data.options.length > 0) {
      const tz = resolveValidTimeZone(scope.business.timezone);
      let bookableOptions = filterElapsedSlots(
        bookingResult.data.options,
        input.date,
        now,
        tz,
      );
      if (timeOfDayPref) {
        const matchesPref = (startTime: string) => {
          const hour = parseInt(startTime.slice(0, 2), 10);
          if (Number.isNaN(hour)) return false;
          if (timeOfDayPref === "morning") return hour < 12;
          if (timeOfDayPref === "afternoon") return hour >= 12 && hour < 17;
          if (timeOfDayPref === "evening") return hour >= 17;
          return false;
        };
        bookableOptions = bookableOptions.filter((o) =>
          matchesPref(o.startAt.slice(11, 16)),
        );
      }

      if (bookableOptions.length > 0) {
        const representativeOptions = sampleRepresentativeSlots(
          bookableOptions,
          4,
        );
        const slotOffer: SlotOffer | null = buildSlotOffer(
          {
            businessId: scope.business.id,
            conversationId: scope.conversation.id,
          },
          crypto.randomUUID(),
          {
            serviceId: input.serviceId,
            serviceName: input.serviceName,
            serviceSource: input.serviceSource,
            providerId: input.providerId,
            timePreference: timeOfDayPref ?? null,
            date: input.date,
            range:
              input.range ?? turnSession.state?.knownFacts.dateRange ?? null,
            followUpRequestId: null,
            shownCount: representativeOptions.length,
            shownSlotKeys: representativeOptions.map(
              (o) => `${o.providerId}:${o.startAt}`,
            ),
            options: representativeOptions.map((o) => ({
              providerId: o.providerId,
              displayName: o.displayName,
              startAt: o.startAt,
              endAt: o.endAt,
            })),
          },
          now,
        );
        if (slotOffer && turnSession.enabled) {
          const currentRange =
            input.range ?? turnSession.state?.knownFacts.dateRange ?? null;
          turnSession.state = {
            ...withPresentedOffer(
              turnSession.state ?? emptyConversationState(),
              slotOffer,
            ),
            selectedDate: input.date,
            selectedService: input.serviceName,
            serviceId: input.serviceId,
            serviceSource: input.serviceSource,
            providerPreference:
              input.providerId ?? turnSession.state?.providerPreference ?? null,
            selectedTimePref: timeOfDayPref ?? null,
            dateRange: currentRange,
            knownFacts: {
              ...(turnSession.state?.knownFacts ?? {}),
              date: input.date,
              service: input.serviceName,
              ...(timeOfDayPref ? { timePreference: timeOfDayPref } : {}),
              ...(currentRange ? { dateRange: currentRange } : {}),
            },
          };
          const ok = await turnSession.commit();
          if (!ok) {
            return selectionReply(
              deps,
              scope,
              "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
              "AI_ACTIVE",
              null,
              undefined,
              input.observability,
            );
          }
        }

        const choices = slotOffer ? buildChannelChoices(slotOffer) : undefined;
        const optionsMsg = formatBookingOptionsMessage(
          input.serviceName,
          input.date,
          representativeOptions,
        );
        const assistantMessage = await persistAssistantReply(
          deps,
          scope.conversation.id,
          optionsMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          scope.customer.phone,
          scope.business.name,
          scope.conversation.id,
          optionsMsg,
          assistantMessage.id,
          scope.business.id,
          scope.connectionId,
          choices,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: scope.business.id,
          conversationId: scope.conversation.id,
          customerId: scope.customer.id,
          customerMessageId: scope.customerMessageId,
          assistantAction: "AI_REPLY",
          intent: "AVAILABILITY",
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider:
            input.observability?.provider ?? deps.ai.providerName,
          delivery,
          observability:
            input.observability ??
            buildTurnObservability({
              routingDecision: "DETERMINISTIC_BYPASS",
              provider: deps.ai.providerName,
              providerAttempts: 0,
              providerStatus: "NOT_CALLED",
              modelCallCount: 0,
            }),
        };
      }
    }

    if (bookingResult.success && bookingResult.reason === "NO_PERIOD_SLOTS") {
      const msg = bookingEmptyReasonMessage(
        "NO_PERIOD_SLOTS",
        input.date,
        timeOfDayPref,
      );
      const assistantMessage = await persistAssistantReply(
        deps,
        scope.conversation.id,
        msg,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        scope.customer.phone,
        scope.business.name,
        scope.conversation.id,
        msg,
        assistantMessage.id,
        scope.business.id,
        scope.connectionId,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: scope.business.id,
        conversationId: scope.conversation.id,
        customerId: scope.customer.id,
        customerMessageId: scope.customerMessageId,
        assistantAction: "AI_REPLY",
        intent: "AVAILABILITY",
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    }
  }

  // No slots available on this date
  return presentDateChoices(
    deps,
    scope,
    {
      serviceId: input.serviceId,
      serviceName: input.serviceName,
      serviceSource: input.serviceSource,
      providerId: input.providerId,
      timePreference: timeOfDayPref,
    },
    turnSession,
    now,
  );
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
  now: Date = new Date(),
): Promise<InboundSuccess | null> {
  const reply = (
    content: string,
    status: "AI_ACTIVE" | "NEED_HUMAN" | "BOOKED",
    cause: HandoffCause | null = null,
    replyMarkup?: Record<string, unknown>,
    choices?: ChannelChoicePresentation,
  ) =>
    selectionReply(
      deps,
      scope,
      content,
      status,
      cause,
      replyMarkup,
      undefined,
      choices,
    );

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
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
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
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
    return reply(
      bookingEligibilityErrorMessage(eligibility.error.code),
      "NEED_HUMAN",
      eligibilityFailureCodeToCause(eligibility.error.code),
    );
  }

  // 3. Provider-name selections are verified against the FRESH eligible
  //    set; a name-like message that matches no real provider is not a
  //    selection and falls through to the normal AI turn.
  const rawTimePref =
    context.timePreference ?? turnSession?.state?.knownFacts.timePreference;
  if (
    typeof rawTimePref === "string" &&
    rawTimePref.trim().length > 0 &&
    !isCanonicalTimePreference(rawTimePref)
  ) {
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
    return reply(
      "يرجى تحديد وقت الحجز المفضل: صباحاً، بعد الظهر، أو مساءً (أو اذكر أن أي وقت مناسب).",
      "AI_ACTIVE",
    );
  }
  const canonicalTimePref =
    rawTimePref && isCanonicalTimePreference(rawTimePref)
      ? rawTimePref
      : undefined;

  let providerId: string | undefined = context.providerId ?? undefined;
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
      if (turnSession?.enabled) {
        await turnSession.releaseClaim();
      }
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

  if (selection.kind === "change_date") {
    if (turnSession?.enabled) {
      const activeRange =
        context.range ?? turnSession.state?.knownFacts.dateRange ?? null;
      if (turnSession.state) {
        turnSession.state = {
          ...turnSession.state,
          selectedDate: null,
          knownFacts: {
            ...turnSession.state.knownFacts,
            date: undefined,
            ...(activeRange ? { dateRange: activeRange } : {}),
            ...(canonicalTimePref ? { timePreference: canonicalTimePref } : {}),
          },
          dateRange: activeRange,
          ...(canonicalTimePref ? { selectedTimePref: canonicalTimePref } : {}),
        };
      }
      await turnSession.invalidateOffer();
      return presentDateChoices(
        deps,
        scope,
        {
          serviceId,
          serviceName,
          serviceSource: context.serviceId ? "CUSTOMER" : "DEFAULT",
          providerId: providerId ?? null,
          timePreference: canonicalTimePref,
          range: activeRange,
        },
        turnSession,
        now,
      );
    }
    return reply(
      `يرجى تحديد اليوم أو التاريخ الجديد المناسب لك لحجز خدمة "${serviceName}":`,
      "AI_ACTIVE",
    );
  }

  // 4. CORE-02 — fresh options (reuses CORE-01 + the availability layer).
  const tz = resolveValidTimeZone(scope.business.timezone);
  const todayIso = todayIsoInTimeZone(now, tz);
  const isToday = date === todayIso;
  const currentTime = nowTimeInTimeZone(now, tz);

  const bookingDeps = buildBookingDeps(deps, eligibilityDeps);
  const bookingResult = await resolveBookingOptions(
    bookingDeps as unknown as Parameters<typeof resolveBookingOptions>[0],
    { userId: scope.customer.id, businessId: scope.business.id },
    {
      serviceId,
      ...(branchId ? { branchId } : {}),
      ...(providerId ? { providerId } : {}),
      ...(canonicalTimePref ? { timePreference: canonicalTimePref } : {}),
      date,
      ...(isToday ? { minStartTime: currentTime } : {}),
      limit: 50,
    },
  );
  if (!bookingResult.success) {
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
    return reply(
      bookingOptionsErrorMessage(bookingResult.error.code),
      "NEED_HUMAN",
      "DOMAIN_REQUIRES_HUMAN",
    );
  }
  const freshOptions = bookingResult.data.options;
  if (freshOptions.length === 0) {
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
    const reason = bookingResult.reason ?? "FULLY_BOOKED";
    if (reason === "NO_PERIOD_SLOTS") {
      return reply(
        bookingEmptyReasonMessage(reason, date, canonicalTimePref),
        "AI_ACTIVE",
      );
    }
    return reply(
      bookingEmptyReasonMessage(reason, date),
      "NEED_HUMAN",
      "DOMAIN_REQUIRES_HUMAN",
    );
  }

  // 4b. Deterministic navigation: more times
  if (selection.kind === "more_times") {
    const tz = resolveValidTimeZone(scope.business.timezone);
    const candidates = filterElapsedSlots(freshOptions, date, now, tz);

    const previouslyShownKeys = new Set<string>();
    if (turnSession?.state?.offer?.kind === "SLOT") {
      for (const k of turnSession.state.offer.shownSlotKeys ?? []) {
        previouslyShownKeys.add(k);
      }
    }
    for (const opt of context.options) {
      if (opt.providerId) {
        previouslyShownKeys.add(`${opt.providerId}:${opt.startTime}`);
      }
    }

    const unpresented = candidates.filter((o) => {
      const shortKey = `${o.providerId}:${o.startAt.slice(11, 16)}`;
      const fullKey = `${o.providerId}:${o.startAt}`;
      return (
        !previouslyShownKeys.has(shortKey) && !previouslyShownKeys.has(fullKey)
      );
    });

    if (unpresented.length > 0) {
      const nextBatch = sampleRepresentativeSlots(unpresented, 4);
      const newShownKeys = [
        ...previouslyShownKeys,
        ...nextBatch.map((o) => `${o.providerId}:${o.startAt}`),
      ];
      let nextOffer: SlotOffer | null = null;
      if (turnSession?.enabled) {
        nextOffer = buildSlotOffer(
          {
            businessId: scope.business.id,
            conversationId: scope.conversation.id,
          },
          crypto.randomUUID(),
          {
            serviceId,
            serviceName,
            serviceSource: context.serviceId ? "CUSTOMER" : "DEFAULT",
            providerId: providerId ?? null,
            timePreference: canonicalTimePref,
            date,
            followUpRequestId: context.followUpRequestId ?? null,
            shownCount: newShownKeys.length,
            shownSlotKeys: newShownKeys,
            options: nextBatch.map((o) => ({
              providerId: o.providerId,
              displayName: o.displayName,
              startAt: o.startAt,
              endAt: o.endAt,
            })),
          },
          now,
        );
        if (nextOffer) {
          turnSession.state = withPresentedOffer(
            turnSession.state ?? emptyConversationState(),
            nextOffer,
          );
          const ok = await turnSession.commit();
          if (!ok) {
            nextOffer = null;
          }
        }
      }
      const choices = nextOffer ? buildChannelChoices(nextOffer) : undefined;
      const optionsMsg = formatBookingOptionsMessage(
        serviceName,
        date,
        nextBatch,
        context.followUpRequestId,
        true,
      );
      return reply(optionsMsg, "AI_ACTIVE", null, undefined, choices);
    }
    if (turnSession?.enabled) {
      await turnSession.releaseClaim();
    }
    const searchCapped =
      bookingResult.data.isCapped ?? freshOptions.length >= 50;
    const allMsg = searchCapped
      ? `هذه هي المواعيد المعروضة حالياً لخدمة "${serviceName}" يوم ${formatArabicDate(date)}. يمكنك اختيار أحدها، أو طلب "يوم آخر".`
      : `هذه هي كل المواعيد المتاحة لخدمة "${serviceName}" يوم ${formatArabicDate(date)}. يمكنك اختيار أحدها، أو طلب "يوم آخر".`;
    return reply(allMsg, "AI_ACTIVE");
  }

  // 5. Verify the selected option STILL exists and is bookable.
  let chosen: (typeof freshOptions)[number] | null = null;
  if (selection.kind === "index") {
    const offered = context.options.find(
      (option) => option.index === selection.index,
    );
    if (!offered) {
      if (context.options.length === 0) {
        if (turnSession?.enabled) {
          await turnSession.invalidateOffer();
        }
        return reply(
          `لم يعد بإمكاني التأكد من الخيارات المعروضة — إليك المواعيد المتاحة الآن:\n${formatBookingOptionsMessage(serviceName, date, freshOptions)}`,
          "AI_ACTIVE",
        );
      }
      if (turnSession?.enabled) {
        await turnSession.releaseClaim();
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
          (!offered.providerId || option.providerId === offered.providerId) &&
          normalizeArabicText(option.displayName) ===
            normalizeArabicText(offered.displayName),
      ) ?? null;
    if (!chosen) {
      // Stale presentation: the exact offered option is gone.
      if (turnSession?.enabled) {
        await turnSession.invalidateOffer();
      }
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
      if (turnSession?.enabled) {
        await turnSession.releaseClaim();
      }
      return reply(BOOKING_UNKNOWN_TIME_MESSAGE, "AI_ACTIVE");
    }
    if (matches.length > 1) {
      if (turnSession?.enabled) {
        await turnSession.releaseClaim();
      }
      return reply(BOOKING_AMBIGUOUS_TIME_MESSAGE, "AI_ACTIVE");
    }
    chosen = matches[0] ?? null;
  } else {
    // Provider selection: the provider's earliest currently-available
    // slot (the fresh CORE-02 result is the authority).
    chosen = freshOptions[0] ?? null;
  }
  if (!chosen) {
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
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
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
    return reply(BOOKING_RETRY_MESSAGE, "NEED_HUMAN", "TENANT_CONFIGURATION");
  }

  const followUpRequestId = context.followUpRequestId ?? null;
  if (followUpRequestId && deps.followUpRequestRepository?.findById) {
    const followUp = await deps.followUpRequestRepository.findById(
      followUpRequestId,
      scope.business.id,
    );
    if (!followUp || followUp.status !== "PENDING") {
      if (turnSession?.enabled) {
        await turnSession.invalidateOffer();
      }
      return reply(
        "عذراً، طلب المتابعة لم يعد متاحاً للجدولة (تم إلغاؤه أو جدولته مسبقاً أو خارج الفترة المحددة). يمكنك حجز موعد جديد مباشرة باختيار الخدمة المطلوبة.",
        "AI_ACTIVE",
      );
    }
    if (followUp.customerId !== scope.customer.id) {
      if (turnSession?.enabled) {
        await turnSession.invalidateOffer();
      }
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
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
    return reply(BOOKING_RETRY_MESSAGE, "NEED_HUMAN", "DOMAIN_REQUIRES_HUMAN");
  }
  if (created.status === "invalid_follow_up") {
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
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
      {
        serviceId,
        ...(branchId ? { branchId } : {}),
        ...(providerId ? { providerId } : {}),
        ...(canonicalTimePref ? { timePreference: canonicalTimePref } : {}),
        date,
        ...(isToday ? { minStartTime: currentTime } : {}),
      },
    );
    if (retry.success && retry.data.options.length > 0) {
      let retryOffer: SlotOffer | null = null;
      if (turnSession?.enabled) {
        retryOffer = buildSlotOffer(
          {
            businessId: scope.business.id,
            conversationId: scope.conversation.id,
          },
          crypto.randomUUID(),
          {
            serviceId,
            serviceName,
            serviceSource: context.serviceId ? "CUSTOMER" : "DEFAULT",
            providerId: providerId ?? null,
            timePreference: canonicalTimePref ?? null,
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
          const ok = await turnSession.commit();
          if (!ok) {
            retryOffer = null;
          }
        }
      }
      const choices = retryOffer ? buildChannelChoices(retryOffer) : undefined;
      return reply(
        `عذراً، تم حجز هذا الموعد للتو — إليك المواعيد المتاحة الآن:\n${formatBookingOptionsMessage(serviceName, date, retry.data.options, followUpRequestId)}`,
        "AI_ACTIVE",
        null,
        undefined,
        choices,
      );
    }
    if (turnSession?.enabled) {
      await turnSession.invalidateOffer();
    }
    const retryReason =
      retry.success && retry.reason === "NO_PERIOD_SLOTS"
        ? "NO_PERIOD_SLOTS"
        : "FULLY_BOOKED";
    if (retryReason === "NO_PERIOD_SLOTS") {
      return reply(
        bookingEmptyReasonMessage(retryReason, date, canonicalTimePref),
        "AI_ACTIVE",
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
    const ok = await turnSession.commit();
    if (!ok) {
      // Safe retry: reload latest state row and re-apply completeBookingTask so CONSUMED status lands
      await turnSession.reload();
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
 * CORE-04A: Truthful physical and logical counter resolution for an inbound turn.
 * Disentangles physical HTTP attempts across wire calls from logical serving activity.
 */
export function resolveTurnCounters(params: {
  deterministicBypass: boolean;
  providerName: string;
  turnTelemetry: AiTelemetry | null;
}): {
  providerAttempts: number | null;
  modelCallCount: number;
} {
  const { deterministicBypass, providerName, turnTelemetry } = params;
  const jevCallSpent = !!turnTelemetry?.jevDecision?.semantic?.jevCallSpent;

  if (
    deterministicBypass ||
    providerName === "deterministic" ||
    turnTelemetry?.finalProvider === "deterministic-bypass"
  ) {
    return {
      providerAttempts: 0,
      modelCallCount: 0,
    };
  }

  if (turnTelemetry?.finalProvider === JEV_DETERMINISTIC_PROVIDER) {
    const attempts = jevCallSpent ? 1 : 0;
    return {
      providerAttempts: attempts,
      modelCallCount: attempts,
    };
  }

  // Generative LLM path
  let providerAttempts: number | null = null;
  if (turnTelemetry?.totalHttpAttempts !== undefined) {
    providerAttempts = turnTelemetry.totalHttpAttempts;
  } else if (turnTelemetry?.retryTrace?.totalHttpAttempts !== undefined) {
    providerAttempts = turnTelemetry.retryTrace.totalHttpAttempts;
  } else if (
    turnTelemetry?.retryTrace?.attempts &&
    turnTelemetry.retryTrace.attempts.length > 0
  ) {
    const allKnown = turnTelemetry.retryTrace.attempts.every(
      (a) => a.httpAttempts !== undefined && a.httpAttempts !== null,
    );
    providerAttempts = allKnown
      ? turnTelemetry.retryTrace.attempts.reduce(
          (sum, a) => sum + (a.httpAttempts ?? 0),
          0,
        )
      : null;
  } else if (turnTelemetry?.attempts && turnTelemetry.attempts.length > 0) {
    const allKnown = turnTelemetry.attempts.every(
      (a) => a.httpAttempts !== undefined && a.httpAttempts !== null,
    );
    providerAttempts = allKnown
      ? turnTelemetry.attempts.reduce(
          (sum, a) => sum + (a.httpAttempts ?? 0),
          0,
        )
      : null;
  } else {
    providerAttempts = null;
  }

  // Logical serving activity: if physical attempts are known to be 0 (e.g. preflight failure),
  // then no model call was made. Otherwise, exactly 1 logical generative call was attempted/served.
  const modelCallCount = providerAttempts === 0 ? 0 : 1;

  return {
    providerAttempts,
    modelCallCount,
  };
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
      const rawPersistedTimePref = turnSession.state?.knownFacts.timePreference;
      if (
        typeof rawPersistedTimePref === "string" &&
        rawPersistedTimePref.trim().length > 0 &&
        !isCanonicalTimePreference(rawPersistedTimePref)
      ) {
        if (turnSession.enabled) {
          await turnSession.invalidateOffer();
        }
        return selectionReply(
          deps,
          selectionScope,
          "يرجى تحديد وقت الحجز المفضل: صباحاً، بعد الظهر، أو مساءً (أو اذكر أن أي وقت مناسب).",
          "AI_ACTIVE",
        );
      }
      const claim = await turnSession.claimOffer();
      if (claim === "conflict") {
        return selectionReply(
          deps,
          selectionScope,
          "جاري معالجة طلبك حالياً، يرجى الانتظار لحظات.",
          "AI_ACTIVE",
        );
      }
      try {
        const selectionResult = await completeBookingSelection(
          deps,
          selectionScope,
          offerReply.context,
          offerReply.selection,
          turnSession,
          now,
        );
        if (selectionResult) return selectionResult;
      } catch (err) {
        if (
          turnSession.enabled &&
          turnSession.state?.offer?.status === "CLAIMED"
        ) {
          await turnSession.invalidateOffer();
        }
        throw err;
      }
      if (
        turnSession.enabled &&
        turnSession.state?.offer?.status === "CLAIMED"
      ) {
        await turnSession.releaseClaim();
      }
    } else if (offerReply.kind === "welcome_action") {
      if (offerReply.action === "book") {
        // If there is an active suspended slot or date offer that is still live, check compatibility and resume it!
        const suspended = turnSession.state?.suspendedOffer;
        if (
          suspended &&
          suspended.kind === "SLOT" &&
          isOfferLive(suspended, now)
        ) {
          const currServiceId = turnSession.state?.serviceId;
          const currServiceName = turnSession.state?.knownFacts.service;
          const currDate = turnSession.state?.knownFacts.date;
          const currProvider = turnSession.state?.knownFacts.provider;

          const serviceMatch =
            (currServiceId == null || currServiceId === suspended.serviceId) &&
            (currServiceName == null ||
              currServiceName === suspended.serviceName);
          const dateMatch = currDate != null && currDate === suspended.date;
          let providerMatch = true;
          if (currProvider == null || currProvider.trim().length === 0) {
            if (suspended.providerId !== null) {
              providerMatch = false;
            }
          } else {
            const provRes = await resolveProviderCandidate(
              deps,
              business.id,
              conversation.branchId as string | null,
              suspended.serviceId,
              currProvider,
            );
            if (
              provRes.kind !== "resolved" ||
              provRes.providerId !== suspended.providerId
            ) {
              providerMatch = false;
            }
          }

          if (serviceMatch && dateMatch && providerMatch) {
            turnSession.state = {
              ...(turnSession.state ?? emptyConversationState()),
              offer: suspended,
              suspendedOffer: null,
              pendingOffer: pendingOfferMirror(suspended),
              activeTask: { kind: "BOOKING", stage: "AVAILABILITY_RESOLVED" },
              bookingStage: "AVAILABILITY_RESOLVED",
            };
            const ok = await turnSession.commit();
            if (!ok) {
              return selectionReply(
                deps,
                selectionScope,
                "عذراً، حدث تعارض أثناء تحديث المحادثة. يُرجى المحاولة مرة أخرى.",
                "AI_ACTIVE",
                null,
                undefined,
              );
            }
            const choices = buildChannelChoices(suspended);
            const optionsMsg = formatBookingOptionsMessage(
              suspended.serviceName,
              suspended.date,
              suspended.options.map((o) => ({
                index: o.index,
                displayName: o.displayName,
                startAt: o.startAt,
                endAt: o.endAt,
              })),
            );
            return selectionReply(
              deps,
              selectionScope,
              optionsMsg,
              "AI_ACTIVE",
              null,
              undefined,
              undefined,
              choices,
            );
          } else {
            if (turnSession.state) {
              turnSession.state = {
                ...turnSession.state,
                suspendedOffer: null,
              };
            }
          }
        } else if (
          suspended &&
          suspended.kind === "DATE" &&
          isOfferLive(suspended, now)
        ) {
          const currServiceId = turnSession.state?.serviceId;
          const currDate = turnSession.state?.knownFacts.date;
          if (
            currDate == null &&
            (currServiceId == null || currServiceId === suspended.serviceId)
          ) {
            turnSession.state = {
              ...(turnSession.state ?? emptyConversationState()),
              offer: suspended,
              suspendedOffer: null,
              pendingOffer: pendingOfferMirror(suspended),
              activeTask: {
                kind: "BOOKING",
                stage: turnSession.state?.activeTask?.stage ?? "GOAL_STATED",
              },
            };
            const ok = await turnSession.commit();
            if (!ok) {
              return selectionReply(
                deps,
                selectionScope,
                "عذراً، حدث تعارض أثناء تحديث المحادثة. يُرجى المحاولة مرة أخرى.",
                "AI_ACTIVE",
                null,
                undefined,
              );
            }
            const choices = buildChannelChoices(suspended);
            const lines = [
              `تم اختيار خدمة "${suspended.serviceName}". يرجى تحديد اليوم أو التاريخ المناسب لك:`,
            ];
            for (let i = 0; i < suspended.options.length; i++) {
              lines.push(`${i + 1}️⃣ ${suspended.options[i]!.label}`);
            }
            lines.push("(أو يمكنك كتابة أي تاريخ آخر مباشرة في أي وقت)");
            return selectionReply(
              deps,
              selectionScope,
              lines.join("\n"),
              "AI_ACTIVE",
              null,
              undefined,
              undefined,
              choices,
            );
          } else {
            if (turnSession.state) {
              turnSession.state = {
                ...turnSession.state,
                suspendedOffer: null,
              };
            }
          }
        }

        const knownService = turnSession.state?.selectedService;
        let resolvedServiceId = turnSession.state?.serviceId ?? null;
        let resolvedServiceName = knownService ?? null;
        let serviceSource: "CUSTOMER" | "DEFAULT" =
          turnSession.state?.serviceSource ?? "CUSTOMER";

        if (!resolvedServiceId || !resolvedServiceName) {
          const defaultServiceBookingEnabled = Boolean(
            (business as unknown as { defaultServiceBookingEnabled?: boolean })
              .defaultServiceBookingEnabled,
          );
          const defaultServiceId = defaultServiceBookingEnabled
            ? ((
                business as unknown as {
                  defaultBookingServiceId?: string | null;
                }
              ).defaultBookingServiceId ??
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

          const defaultService = defaultServiceId
            ? services.find(
                (s) => s.id === defaultServiceId && s.isActive !== false,
              )
            : null;
          const activeServices = services.filter((s) => s.isActive !== false);
          const singleService =
            !defaultService && activeServices.length === 1
              ? activeServices[0]
              : null;
          const autoService = defaultService ?? singleService;
          if (autoService) {
            resolvedServiceId = autoService.id;
            resolvedServiceName = autoService.name;
            serviceSource = defaultService ? "DEFAULT" : "CUSTOMER";
          }
        }

        if (resolvedServiceId && resolvedServiceName) {
          const knownDate = turnSession.state?.knownFacts.date;
          const candidateProvider =
            turnSession.state?.knownFacts.provider ?? null;
          const provRes = await resolveProviderCandidate(
            deps,
            business.id,
            conversation.branchId as string | null,
            resolvedServiceId,
            candidateProvider,
          );
          if (provRes.kind === "clarification") {
            return promptProviderClarificationReply(
              deps,
              selectionScope,
              {
                serviceId: resolvedServiceId,
                serviceName: resolvedServiceName,
                date: knownDate ?? null,
                eligibleProviders: provRes.eligibleProviders,
                reason: provRes.reason,
              },
              turnSession,
              now,
            );
          }
          if (knownDate) {
            return presentSlotChoices(
              deps,
              selectionScope,
              {
                serviceId: resolvedServiceId,
                serviceName: resolvedServiceName,
                serviceSource,
                providerId: provRes.providerId,
                date: knownDate,
              },
              turnSession,
              now,
            );
          }
          return presentDateChoices(
            deps,
            selectionScope,
            {
              serviceId: resolvedServiceId,
              serviceName: resolvedServiceName,
              serviceSource,
              providerId: provRes.providerId,
            },
            turnSession,
            now,
          );
        }

        const activeServices = services.filter((s) => s.isActive !== false);
        let serviceOffer: ServiceOffer | null = null;
        if (activeServices.length > 0) {
          serviceOffer = buildServiceOffer(
            { businessId: business.id, conversationId: conversation.id },
            crypto.randomUUID(),
            activeServices.map((s) => ({ id: s.id, name: s.name })),
            now,
            "BOOKING",
          );
        }
        if (serviceOffer && turnSession.enabled) {
          turnSession.state = withPresentedOffer(
            turnSession.state ?? emptyConversationState(),
            serviceOffer,
          );
          const ok = await turnSession.commit();
          if (!ok) {
            return selectionReply(
              deps,
              selectionScope,
              "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
              "AI_ACTIVE",
            );
          }
        }
        const choices = serviceOffer
          ? buildChannelChoices(serviceOffer)
          : undefined;
        const listText =
          activeServices.length > 0
            ? activeServices
                .slice(0, 5)
                .map((s, idx) => `${idx + 1}️⃣ ${s.name}`)
                .join("\n")
            : "";
        const serviceMsg = `يرجى تحديد الخدمة المطلوبة — الخدمات المتاحة لدينا:\n${listText}\n(يمكنك اختيار الخدمة أو كتابة اسمها مباشرة)`;
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          serviceMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          serviceMsg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
          choices,
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
      } else {
        const activeServices = services.filter((s) => s.isActive !== false);
        let serviceOffer: ServiceOffer | null = null;
        if (activeServices.length > 0) {
          serviceOffer = buildServiceOffer(
            { businessId: business.id, conversationId: conversation.id },
            crypto.randomUUID(),
            activeServices.map((s) => ({ id: s.id, name: s.name })),
            now,
            "INQUIRY",
          );
        }
        if (serviceOffer && turnSession.enabled) {
          turnSession.state = withPresentedOffer(
            turnSession.state ?? emptyConversationState(),
            serviceOffer,
          );
          const ok = await turnSession.commit();
          if (!ok) {
            return selectionReply(
              deps,
              selectionScope,
              "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
              "AI_ACTIVE",
            );
          }
        }
        const choices = serviceOffer
          ? buildChannelChoices(serviceOffer)
          : undefined;
        const listText =
          activeServices.length > 0
            ? activeServices
                .slice(0, 5)
                .map((s, idx) => `${idx + 1}️⃣ ${s.name}`)
                .join("\n")
            : "";
        const inquiryMsg = `تفضل بالاطلاع على خدماتنا المتاحة، اختر الخدمة لمعرفة تفاصيلها:\n${listText}\n(يمكنك الضغط على الخدمة أو كتابة اسمها للاستفسار عنها)`;
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          inquiryMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          inquiryMsg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
          choices,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: "FAQ",
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          delivery,
        };
      }
    } else if (offerReply.kind === "service") {
      if (turnSession.state) {
        turnSession.state = withOfferStatus(turnSession.state, "CONSUMED");
      }
      const knownDate = turnSession.state?.knownFacts.date;
      const candidateProvider = turnSession.state?.knownFacts.provider ?? null;
      const provRes = await resolveProviderCandidate(
        deps,
        business.id,
        conversation.branchId as string | null,
        offerReply.serviceId,
        candidateProvider,
      );
      if (provRes.kind === "clarification") {
        return promptProviderClarificationReply(
          deps,
          selectionScope,
          {
            serviceId: offerReply.serviceId,
            serviceName: offerReply.serviceName,
            date: knownDate ?? null,
            eligibleProviders: provRes.eligibleProviders,
            reason: provRes.reason,
          },
          turnSession,
          now,
        );
      }
      if (knownDate) {
        return presentSlotChoices(
          deps,
          selectionScope,
          {
            serviceId: offerReply.serviceId,
            serviceName: offerReply.serviceName,
            serviceSource: "CUSTOMER",
            providerId: provRes.providerId,
            date: knownDate,
          },
          turnSession,
          now,
        );
      }
      return presentDateChoices(
        deps,
        selectionScope,
        {
          serviceId: offerReply.serviceId,
          serviceName: offerReply.serviceName,
          serviceSource: "CUSTOMER",
          providerId: provRes.providerId,
        },
        turnSession,
        now,
      );
    } else if (offerReply.kind === "service_inquiry") {
      const targetService = services.find((s) => s.id === offerReply.serviceId);
      const sName = targetService?.name ?? offerReply.serviceName;
      const lines = [`خدمة "${sName}":`];
      const priceVal =
        targetService?.priceAmount ??
        (targetService as unknown as { price?: number | null })?.price;
      if (priceVal != null) {
        const currencyVal = targetService?.priceCurrency ?? "ج.م";
        lines.push(`💵 السعر: ${priceVal} ${currencyVal}`);
      }
      if (targetService?.durationMinutes != null) {
        lines.push(`⏱️ المدة: ${targetService.durationMinutes} دقيقة`);
      }
      if (targetService?.description) {
        lines.push(`📝 الوصف: ${targetService.description}`);
      }
      lines.push(
        "\nيمكنك حجز هذه الخدمة الآن أو الاستفسار عن خدمة أخرى:\n1️⃣ حجز هذه الخدمة\n2️⃣ خدمة أخرى\n3️⃣ القائمة الرئيسية",
      );
      const inquiryText = lines.join("\n");

      const detailOffer = buildServiceDetailOffer(
        { businessId: business.id, conversationId: conversation.id },
        crypto.randomUUID(),
        offerReply.serviceId,
        sName,
        now,
      );
      if (detailOffer && turnSession.enabled) {
        turnSession.state = withPresentedOffer(
          turnSession.state ?? emptyConversationState(),
          detailOffer,
        );
        const ok = await turnSession.commit();
        if (!ok) {
          return selectionReply(
            deps,
            selectionScope,
            "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
            "AI_ACTIVE",
          );
        }
      }
      const choices = detailOffer
        ? buildChannelChoices(detailOffer)
        : undefined;
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        inquiryText,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        inquiryText,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
        choices,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_REPLY",
        intent: "FAQ",
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    } else if (offerReply.kind === "service_detail_action") {
      if (offerReply.action === "book_service") {
        const knownDate = turnSession.state?.knownFacts.date;
        const candidateProvider =
          turnSession.state?.knownFacts.provider ?? null;
        const provRes = await resolveProviderCandidate(
          deps,
          business.id,
          conversation.branchId as string | null,
          offerReply.serviceId,
          candidateProvider,
        );
        if (provRes.kind === "clarification") {
          return promptProviderClarificationReply(
            deps,
            selectionScope,
            {
              serviceId: offerReply.serviceId,
              serviceName: offerReply.serviceName,
              date: knownDate ?? null,
              eligibleProviders: provRes.eligibleProviders,
              reason: provRes.reason,
            },
            turnSession,
            now,
          );
        }
        if (knownDate) {
          return presentSlotChoices(
            deps,
            selectionScope,
            {
              serviceId: offerReply.serviceId,
              serviceName: offerReply.serviceName,
              serviceSource: "CUSTOMER",
              providerId: provRes.providerId,
              date: knownDate,
            },
            turnSession,
            now,
          );
        }
        return presentDateChoices(
          deps,
          selectionScope,
          {
            serviceId: offerReply.serviceId,
            serviceName: offerReply.serviceName,
            serviceSource: "CUSTOMER",
            providerId: provRes.providerId,
          },
          turnSession,
          now,
        );
      } else if (offerReply.action === "other_services") {
        const activeServices = services.filter((s) => s.isActive !== false);
        let serviceOffer: ServiceOffer | null = null;
        if (activeServices.length > 0) {
          serviceOffer = buildServiceOffer(
            { businessId: business.id, conversationId: conversation.id },
            crypto.randomUUID(),
            activeServices.map((s) => ({ id: s.id, name: s.name })),
            now,
            "INQUIRY",
          );
        }
        if (serviceOffer && turnSession.enabled) {
          turnSession.state = withPresentedOffer(
            turnSession.state ?? emptyConversationState(),
            serviceOffer,
          );
          const ok = await turnSession.commit();
          if (!ok) {
            return selectionReply(
              deps,
              selectionScope,
              "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
              "AI_ACTIVE",
            );
          }
        }
        const choices = serviceOffer
          ? buildChannelChoices(serviceOffer)
          : undefined;
        const listText =
          activeServices.length > 0
            ? activeServices
                .slice(0, 5)
                .map((s, idx) => `${idx + 1}️⃣ ${s.name}`)
                .join("\n")
            : "";
        const inquiryMsg = `تفضل بالاطلاع على بقية الخدمات:\n${listText}`;
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          inquiryMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          inquiryMsg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
          choices,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: "FAQ",
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          delivery,
        };
      } else {
        const welcomeOffer = buildWelcomeOffer(
          { businessId: business.id, conversationId: conversation.id },
          crypto.randomUUID(),
          now,
        );
        if (welcomeOffer && turnSession.enabled) {
          turnSession.state = withPresentedOffer(
            turnSession.state ?? emptyConversationState(),
            welcomeOffer,
          );
          const ok = await turnSession.commit();
          if (!ok) {
            return selectionReply(
              deps,
              selectionScope,
              "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
              "AI_ACTIVE",
            );
          }
        }
        const welcomeText = `القائمة الرئيسية:\n1️⃣ حجز موعد\n2️⃣ استفسار عن خدمة`;
        const choices = welcomeOffer
          ? buildChannelChoices(welcomeOffer)
          : undefined;
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          welcomeText,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          welcomeText,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
          choices,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: "GREETING",
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          delivery,
        };
      }
    } else if (offerReply.kind === "date") {
      if (turnSession.state) {
        turnSession.state = withOfferStatus(turnSession.state, "CONSUMED");
      }
      const serviceSource = turnSession.state?.serviceSource ?? "CUSTOMER";
      const candidateProvider =
        offerReply.providerId ?? turnSession.state?.knownFacts.provider ?? null;
      const provRes = await resolveProviderCandidate(
        deps,
        business.id,
        conversation.branchId as string | null,
        offerReply.serviceId,
        candidateProvider,
      );
      if (provRes.kind === "clarification") {
        return promptProviderClarificationReply(
          deps,
          selectionScope,
          {
            serviceId: offerReply.serviceId,
            serviceName: offerReply.serviceName,
            date: offerReply.date,
            eligibleProviders: provRes.eligibleProviders,
            reason: provRes.reason,
          },
          turnSession,
          now,
        );
      }
      return presentSlotChoices(
        deps,
        selectionScope,
        {
          serviceId: offerReply.serviceId,
          serviceName: offerReply.serviceName,
          serviceSource,
          providerId: provRes.providerId,
          date: offerReply.date,
          timePreference: offerReply.timePreference,
          range:
            offerReply.range ?? turnSession.state?.knownFacts.dateRange ?? null,
        },
        turnSession,
        now,
      );
    } else if (offerReply.kind === "date_more") {
      const serviceSource = turnSession.state?.serviceSource ?? "CUSTOMER";
      const candidateProvider =
        offerReply.providerId ?? turnSession.state?.knownFacts.provider ?? null;
      const provRes = await resolveProviderCandidate(
        deps,
        business.id,
        conversation.branchId as string | null,
        offerReply.serviceId,
        candidateProvider,
      );
      if (provRes.kind === "clarification") {
        return promptProviderClarificationReply(
          deps,
          selectionScope,
          {
            serviceId: offerReply.serviceId,
            serviceName: offerReply.serviceName,
            date: null,
            eligibleProviders: provRes.eligibleProviders,
            reason: provRes.reason,
          },
          turnSession,
          now,
        );
      }
      const nextOffset =
        (offerReply.offer.pageOffset ?? 0) +
        (offerReply.offer.options.length || 4);
      const targetRange =
        offerReply.offer.range ??
        turnSession.state?.knownFacts.dateRange ??
        null;
      const lastOptionDate =
        offerReply.offer.options.length > 0
          ? offerReply.offer.options[offerReply.offer.options.length - 1]!.date
          : null;
      const cursorDate = offerReply.offer.cursorDate ?? lastOptionDate;
      const shownDates = [
        ...(offerReply.offer.shownDates ??
          offerReply.offer.options.map((o) => o.date)),
      ];

      return presentDateChoices(
        deps,
        selectionScope,
        {
          serviceId: offerReply.serviceId,
          serviceName: offerReply.serviceName,
          serviceSource,
          providerId: provRes.providerId,
          timePreference: offerReply.timePreference,
          range: targetRange,
          pageOffset: nextOffset,
          cursorDate,
          shownDates,
        },
        turnSession,
        now,
      );
    } else if (offerReply.kind === "date_other") {
      const askMsg =
        "يرجى كتابة التاريخ أو اليوم الذي يناسبك (مثال: بكرة، الأسبوع القادم، أو اذكر يوماً محدداً):";
      if (turnSession.enabled) {
        const {
          date: _droppedDate,
          dateRange: _droppedRange,
          ...remainingFacts
        } = turnSession.state?.knownFacts ?? {};
        void _droppedDate;
        void _droppedRange;
        turnSession.state = {
          ...(turnSession.state ?? emptyConversationState()),
          knownFacts: {
            ...remainingFacts,
            service: offerReply.serviceName,
            ...(offerReply.timePreference
              ? { timePreference: offerReply.timePreference }
              : {}),
          },
          serviceId: offerReply.serviceId,
          selectedService: offerReply.serviceName,
          selectedDate: null,
          dateRange: null,
          providerPreference:
            offerReply.providerId ??
            turnSession.state?.providerPreference ??
            null,
          selectedTimePref:
            offerReply.timePreference ??
            turnSession.state?.selectedTimePref ??
            null,
          serviceSource: turnSession.state?.serviceSource ?? "CUSTOMER",
          missingFacts: ["date"],
          lastClarification: { type: "date" },
          offer: null,
          pendingOffer: null,
        };
        const ok = await turnSession.commit();
        if (!ok) {
          return selectionReply(
            deps,
            selectionScope,
            "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
            "AI_ACTIVE",
          );
        }
      }
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        askMsg,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        askMsg,
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
        intent: "AVAILABILITY",
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    } else if (offerReply.kind === "date_invalid_index") {
      const invalidMsg = `يرجى اختيار رقم تاريخ من 1 إلى ${offerReply.max}.`;
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
        intent: "AVAILABILITY",
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    } else if (offerReply.kind === "provider") {
      if (turnSession.state) {
        if (offerReply.providerId === null) {
          const nextFacts = { ...turnSession.state.knownFacts };
          delete nextFacts.provider;
          turnSession.state = {
            ...turnSession.state,
            knownFacts: nextFacts,
            providerPreference: null,
          };
        } else {
          turnSession.state = {
            ...turnSession.state,
            knownFacts: {
              ...turnSession.state.knownFacts,
              provider: offerReply.providerName ?? offerReply.providerId,
            },
            providerPreference:
              offerReply.providerName ?? offerReply.providerId,
          };
        }
      }
      const knownDate = offerReply.date ?? turnSession.state?.knownFacts.date;
      if (knownDate) {
        return presentSlotChoices(
          deps,
          selectionScope,
          {
            serviceId: offerReply.serviceId,
            serviceName: offerReply.serviceName,
            serviceSource: turnSession.state?.serviceSource ?? "CUSTOMER",
            providerId: offerReply.providerId,
            date: knownDate,
          },
          turnSession,
          now,
        );
      }
      return presentDateChoices(
        deps,
        selectionScope,
        {
          serviceId: offerReply.serviceId,
          serviceName: offerReply.serviceName,
          serviceSource: turnSession.state?.serviceSource ?? "CUSTOMER",
          providerId: offerReply.providerId,
        },
        turnSession,
        now,
      );
    } else if (offerReply.kind === "provider_invalid_index") {
      const invalidMsg = `يرجى اختيار رقم مقدم خدمة من 1 إلى ${offerReply.max}.`;
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
        intent: "AVAILABILITY",
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
      const parsedCb = inbound.text.startsWith("fp:")
        ? parseOfferCallback(inbound.text)
        : null;
      const callbackToken = parsedCb?.token ?? null;
      const staleOffer = offerReply.offer ?? turnSession.state?.offer ?? null;
      const currentOffer = turnSession.state?.offer ?? null;
      const isCurrentOfferLive = currentOffer
        ? isOfferLive(currentOffer, now)
        : false;

      // 1. Preserve newer active offers:
      // If customer clicked an older button while a newer offer is currently live,
      // preserve the active offer and direct them to it without adding duplicate markup here.
      const isClickOnOlderThanCurrent = Boolean(
        callbackToken &&
        currentOffer &&
        callbackToken !== currentOffer.token &&
        isCurrentOfferLive,
      );

      if (isClickOnOlderThanCurrent) {
        const msg =
          "هذا الاختيار يتبع عرضاً سابقاً لم يعد متاحاً. يرجى الاختيار من العرض الحالي المعروض.";
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
          intent: "BOOKING",
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          delivery,
        };
      }

      // Check if this interaction was on an already completed/consumed booking or unknown/malformed callback
      const wasAlreadyBooked =
        wasBooked ||
        turnSession.state?.bookingStage === "COMPLETED" ||
        staleOffer?.status === "CONSUMED";

      const isUnknownCallback =
        offerReply.reason === "UNKNOWN_TOKEN" || !parsedCb;

      if (!wasAlreadyBooked && !isUnknownCallback) {
        // 2. Resolve trusted context for mechanical recovery
        const serviceId =
          turnSession.state?.serviceId ??
          (staleOffer && "serviceId" in staleOffer
            ? staleOffer.serviceId
            : null);
        const serviceName =
          turnSession.state?.selectedService ??
          (staleOffer && "serviceName" in staleOffer
            ? staleOffer.serviceName
            : null) ??
          services.find((s) => s.id === serviceId)?.name ??
          null;
        const serviceSource = turnSession.state?.serviceSource ?? "CUSTOMER";
        const candidateDate =
          turnSession.state?.selectedDate ??
          turnSession.state?.knownFacts.date ??
          (staleOffer && "date" in staleOffer ? staleOffer.date : null);
        const tz = resolveValidTimeZone(business.timezone);
        const todayIso = todayIsoInTimeZone(now, tz);
        const isFutureDate = candidateDate ? candidateDate >= todayIso : false;
        const resolvedDate = isFutureDate ? candidateDate : null;

        const providerId =
          turnSession.state?.providerPreference ??
          (staleOffer && "providerId" in staleOffer
            ? staleOffer.providerId
            : null);
        const timePref = isCanonicalTimePreference(
          turnSession.state?.selectedTimePref,
        )
          ? turnSession.state.selectedTimePref
          : isCanonicalTimePreference(
                turnSession.state?.knownFacts.timePreference,
              )
            ? turnSession.state.knownFacts.timePreference
            : staleOffer &&
                "timePreference" in staleOffer &&
                isCanonicalTimePreference(staleOffer.timePreference)
              ? staleOffer.timePreference
              : null;

        // 3. Sufficient context for SLOTS: serviceId + serviceName + future date
        if (serviceId && serviceName && resolvedDate) {
          return presentSlotChoices(
            deps,
            selectionScope,
            {
              serviceId,
              serviceName,
              serviceSource,
              providerId,
              date: resolvedDate,
              timePreference: timePref,
            },
            turnSession,
            now,
          );
        }

        // 4. Sufficient context for DATES: serviceId + serviceName
        if (serviceId && serviceName) {
          return presentDateChoices(
            deps,
            selectionScope,
            {
              serviceId,
              serviceName,
              serviceSource,
              providerId,
              timePreference: timePref,
            },
            turnSession,
            now,
          );
        }
      }

      // 5. Default stale message (insufficient context, malformed, or already consumed/booked)
      const staleMsg =
        offerReply.reason === "CLOSED" || wasAlreadyBooked
          ? "هذا العرض لم يعد متاحاً (تم تأكيده مسبقاً أو تم استبداله). يرجى تحديد الخدمة واليوم المناسب لعرض المواعيد المتاحة حالياً."
          : "انتهت صلاحية المواعيد المعروضة — يرجى تحديد الخدمة المطلوبة لعرض المواعيد المتاحة حالياً.";
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
      // Legacy text-parsing fallback (only when no typed offer is in state):
      const selectionAttempt =
        wasBooked || (turnSession.enabled && turnSession.state?.offer)
          ? null
          : tryParseBookingSelection(inbound.text, recentChronological);
      if (selectionAttempt) {
        const selectionResult = await completeBookingSelection(
          deps,
          selectionScope,
          selectionAttempt.context,
          selectionAttempt.selection,
          turnSession,
          now,
        );
        if (selectionResult) return selectionResult;
      }
    }

    // UX001: Telegram /start command protocol (Zero JEV & Zero generative model calls)
    if (/^\/start(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(inbound.text.trim())) {
      const rawPersistedTimePref = turnSession.state?.knownFacts.timePreference;
      if (
        typeof rawPersistedTimePref === "string" &&
        rawPersistedTimePref.trim().length > 0 &&
        !isCanonicalTimePreference(rawPersistedTimePref)
      ) {
        if (turnSession.enabled) {
          await turnSession.invalidateOffer();
        }
        const clarMsg =
          "يرجى تحديد وقت الحجز المفضل: صباحاً، بعد الظهر، أو مساءً (أو اذكر أن أي وقت مناسب).";
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          clarMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          clarMsg,
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
          intent: "GREETING",
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          delivery,
        };
      }
      const activeOffer = turnSession.state?.offer;
      const isOfferValid =
        activeOffer &&
        activeOffer.status === "ACTIVE" &&
        new Date(activeOffer.expiresAt).getTime() > now.getTime();

      if (isOfferValid) {
        let continuationMsg: string;

        if (activeOffer.kind === "SLOT") {
          continuationMsg = `أهلاً بك مجدداً في ${business.name}. ما زالت المواعيد المقترحة متاحة لاختيارك:\n(أو يمكنك كتابة أي استفسار أو موعد آخر مباشرة)`;
        } else if (activeOffer.kind === "DATE") {
          continuationMsg = `أهلاً بك مجدداً في ${business.name}. يرجى تحديد اليوم أو التاريخ المناسب لمتابعة حجزك:\n(أو يمكنك كتابة أي تاريخ مباشرة)`;
        } else if (activeOffer.kind === "SERVICE") {
          continuationMsg = `أهلاً بك مجدداً في ${business.name}. يرجى اختيار الخدمة المطلوبة لمتابعة حجزك:\n(أو يمكنك كتابة اسم الخدمة مباشرة)`;
        } else if (activeOffer.kind === "PROVIDER") {
          continuationMsg = `أهلاً بك مجدداً في ${business.name}. يرجى اختيار مقدم الخدمة:\n(أو يمكنك كتابة اسم الطبيب أو الاختيار مباشرة)`;
        } else if (activeOffer.kind === "SERVICE_DETAIL") {
          continuationMsg = `أهلاً بك مجدداً في ${business.name}. تفاصيل الخدمة معروضة أدناه للمتابعة:`;
        } else {
          continuationMsg = `أهلاً بك في ${business.name}! يمكنك الاختيار من الخيارات التالية أو كتابة استفسارك مباشرة:`;
        }

        const choices = buildChannelChoices(activeOffer);
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          continuationMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          continuationMsg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
          choices,
        );
        return {
          ok: true,
          duplicate: false,
          businessId: business.id,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: "GREETING",
          conversationStatus: "AI_ACTIVE",
          handoffCause: null,
          assistantProvider: deps.ai.providerName,
          delivery,
        };
      }

      // If active booking task is missing date
      if (
        turnSession.state?.activeTask?.kind === "BOOKING" &&
        turnSession.state.selectedService &&
        turnSession.state.serviceId
      ) {
        const knownDate = turnSession.state.knownFacts.date;
        const candidateProvider = turnSession.state.knownFacts.provider ?? null;
        const provRes = await resolveProviderCandidate(
          deps,
          business.id,
          conversation.branchId as string | null,
          turnSession.state.serviceId,
          candidateProvider,
        );
        if (provRes.kind === "clarification") {
          return promptProviderClarificationReply(
            deps,
            selectionScope,
            {
              serviceId: turnSession.state.serviceId,
              serviceName: turnSession.state.selectedService,
              date: knownDate ?? null,
              eligibleProviders: provRes.eligibleProviders,
              reason: provRes.reason,
            },
            turnSession,
            now,
          );
        }
        if (knownDate) {
          return presentSlotChoices(
            deps,
            selectionScope,
            {
              serviceId: turnSession.state.serviceId,
              serviceName: turnSession.state.selectedService,
              serviceSource: turnSession.state.serviceSource ?? "CUSTOMER",
              providerId: provRes.providerId,
              date: knownDate,
            },
            turnSession,
            now,
          );
        }
        return presentDateChoices(
          deps,
          selectionScope,
          {
            serviceId: turnSession.state.serviceId,
            serviceName: turnSession.state.selectedService,
            serviceSource: turnSession.state.serviceSource ?? "CUSTOMER",
            providerId: provRes.providerId,
          },
          turnSession,
          now,
        );
      }

      // Idle or fresh conversation: present Welcome offer
      const welcomeOffer = buildWelcomeOffer(
        { businessId: business.id, conversationId: conversation.id },
        crypto.randomUUID(),
        now,
      );
      if (welcomeOffer && turnSession.enabled) {
        turnSession.state = withPresentedOffer(
          turnSession.state ?? emptyConversationState(),
          welcomeOffer,
        );
        const ok = await turnSession.commit();
        if (!ok) {
          return selectionReply(
            deps,
            selectionScope,
            "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
            "AI_ACTIVE",
          );
        }
      }

      const welcomeMsg = `أهلاً بك في ${business.name}!\nيسعدنا مساعدتك في حجز موعد أو الإجابة عن استفساراتك:\n1️⃣ حجز موعد\n2️⃣ استفسار عن خدمة\n(يمكنك الاختيار من الخيارات أعلاه أو كتابة طلبك مباشرة في أي وقت)`;
      const choices = welcomeOffer
        ? buildChannelChoices(welcomeOffer)
        : undefined;
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        welcomeMsg,
        "AI_ACTIVE",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        welcomeMsg,
        assistantMessage.id,
        business.id,
        outboundConnectionId,
        choices,
      );
      return {
        ok: true,
        duplicate: false,
        businessId: business.id,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_REPLY",
        intent: "GREETING",
        conversationStatus: "AI_ACTIVE",
        handoffCause: null,
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    }
    // 7c. B-02 — the Context Builder is the explicit AI boundary
    //     (PROMPT-B02): it takes the structured source facts already loaded
    //     above (Business record, services, conversation state, the
    //     customer message), classifies every candidate through the B-01
    //     knowledge-visibility policy, proves tenant scope against the
    //     server-derived businessId, drops provenance, and composes the
    //     minimal AiRequest. The engine keeps responsibility for
    //     orchestration; the builder owns AI-safe context assembly.
    // CORE-03B2A: Server-derived capability requirement for free-form turns.
    // Defaults to "structured_turn" in production. Legacy callers may supply null
    // to preserve legacy bounded JEV behavior without capability routing.
    const effectiveCapability =
      deps.requiredSemanticCapability !== undefined
        ? (deps.requiredSemanticCapability ?? undefined)
        : "structured_turn";

    const builtContext = buildAiContext({
      scope: { businessId: business.id },
      sources: {
        business,
        services,
        conversation: {
          id: conversation.id,
          status: conversation.status,
          recentMessages: recentMessagesBeforeCurrent,
        },
        message: inbound.text,
        conversationState: turnSession.state,
        conversationStateEnvelope: {
          businessId: business.id,
          conversationId: conversation.id,
        },
        now,
        ...(effectiveCapability
          ? { requiredSemanticCapability: effectiveCapability }
          : {}),
      },
    });
    // PROMPT-AI-JEV-03D — stamp the turn's OPAQUE correlation id onto the
    // request so a non-authoritative shadow evaluation can sample and
    // correlate turns deterministically without deriving anything from
    // content. Additive: the field is optional in the contract and every
    // downstream consumer behaves exactly as before when it is absent.
    const aiRequest: AiRequest = {
      ...builtContext.request,
      traceId,
      ...(effectiveCapability
        ? { requiredSemanticCapability: effectiveCapability }
        : {}),
    };

    // PROMPT-AI-OPS-22 — the deterministic, text-derived task families and the
    // bounded channel facts of the ASSEMBLED request. Both are machine keys /
    // counters only; they never copy message text or a knowledge value, and
    // they make "was the expected context available?" answerable from evidence.
    const taskRelevance: TaskRelevance = deriveTaskRelevance(inbound.text);
    const contextChannels = readContextChannels(aiRequest);

    // 8. Deterministic bypass first (DECISIONS #33): turns safely
    //    decidable without an assistant never spend an AI call — and
    //    never produce an AI_TURN usage fact (no request was made).
    // CORE-03B2A: Free-form turns requiring structured interpretation
    // skip the lexical bypass before ai.respond to ensure structured capability.
    let turn: AiResponse | null =
      aiRequest.requiredSemanticCapability === "structured_turn"
        ? null
        : bypassDeterministicAi(aiRequest);
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
      const jevCallSpent = !!telemetry?.jevDecision?.semantic?.jevCallSpent;
      const isBypassTelemetry =
        deps.ai.providerName === "deterministic" ||
        telemetry?.finalProvider === "deterministic-bypass" ||
        (telemetry?.finalProvider === JEV_DETERMINISTIC_PROVIDER &&
          !jevCallSpent);
      if (!isBypassTelemetry) {
        lastAttempt = telemetry?.attempts[telemetry.attempts.length - 1];
        successAttempt = telemetry
          ? [...telemetry.attempts]
              .reverse()
              .find((a) => a.status === "SUCCESS")
          : undefined;
        // CORE-04A: In the legacy AI_TURN record, record the final/successful model metrics.
        // Full multi-attempt execution, tokens, and reported cost (including failed primary
        // requests before secondary fallback) are preserved truthfully on TurnEvidence.executionAttempts.
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
    //    the safe, deterministic failure acknowledgment via resolveSafeFailureReply,
    //    then takes the existing NEED_HUMAN + operator-attention
    //    handoff path. This keeps the E2E WhatsApp reply path alive when
    //    the provider fails, times out, or returns an invalid response —
    //    without weakening parseAiResponse or bypassing Conversation
    //    Control. The AI/domain separation is unchanged: the
    //    acknowledgment is deterministic, and no AI-authored content is
    //    trusted, persisted, or sent.
    const rawValidated = turn ? parseAiResponse(turn) : null;

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

    // CORE-03B2B1: Identify candidate generative structured turn.
    const isGenerativeStructuredTurn =
      effectiveCapability === "structured_turn" &&
      !deterministicBypass &&
      turnRouting === "LLM" &&
      turnTelemetry?.finalProvider !== "deterministic" &&
      deps.ai.providerName !== "deterministic";

    // CORE-03D2: On structured generative turns, a valid explicit safetyAssessment
    // is strictly required before ordinary structured execution can proceed.
    // Missing or malformed assessment must not count as safe and must not fall back
    // to lexical absence to authorize execution; it fails closed via the existing
    // safe failure/handoff path (AI_FAILURE).
    const isMissingRequiredSafetyAssessment =
      isGenerativeStructuredTurn &&
      rawValidated !== null &&
      rawValidated.safetyAssessment == null;

    const validated = isMissingRequiredSafetyAssessment ? null : rawValidated;

    // CORE-03B2B1 & CORE-03D2: Identify the structured semantic path precisely.
    // Reuses server-derived capability and verified generative response provenance.
    const isStructuredSemanticTurn =
      isGenerativeStructuredTurn && validated !== null;

    // PROMPT-AI-ARCH-05 (Slice 3): the ONE deterministic resolver's ordered
    // single-goal TurnPlan. PROMPT-AI-ARCH-06 (Slice 4): its `decisionClass`
    // is AUTHORITATIVE for the first-class CLARIFY branch below; every other
    // class leaves the existing execution path authoritative and unchanged.
    const resolution = resolveFinishedTurn(
      recentChronological,
      validated,
      turnRouting,
      inbound.text,
      now,
      business.timezone,
      turnTelemetry,
      turnSession.state,
      isStructuredSemanticTurn,
    );
    const resolvedTurn = resolution?.plan ?? null;
    let resolvedState = resolution?.state ?? null;
    if (resolvedState && turnSession.enabled) {
      turnSession.state = resolvedState;
    }
    // PROMPT-AI-OPS-22 & CORE-04A: Truthful physical-attempt accounting.
    // Count physical HTTP attempts actually invoked over the wire.
    // Deterministic bypass = 0. Mechanical protocol = 0. Preflight failure = 0.
    // Disentangles physical HTTP attempts across wire calls from logical serving activity.
    const { providerAttempts, modelCallCount } = resolveTurnCounters({
      deterministicBypass,
      providerName: deps.ai.providerName,
      turnTelemetry,
    });

    const executionAttempts: TurnExecutionAttempt[] =
      turnTelemetry?.retryTrace?.attempts &&
      turnTelemetry.retryTrace.attempts.length > 0
        ? turnTelemetry.retryTrace.attempts.map((a, idx) => ({
            attempt: a.attempt ?? idx + 1,
            provider:
              a.provider ??
              turnTelemetry?.finalProvider ??
              deps.ai.providerName,
            model: a.model ?? undefined,
            status: a.outcome === "SUCCESS" ? "SUCCESS" : "FAILURE",
            ...(a.httpAttempts !== undefined
              ? { httpAttempts: a.httpAttempts }
              : {}),
            ...(a.inputTokens !== undefined
              ? { inputTokens: a.inputTokens }
              : {}),
            ...(a.outputTokens !== undefined
              ? { outputTokens: a.outputTokens }
              : {}),
            ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}),
            ...(a.costUsd !== undefined
              ? { costSource: "PROVIDER_REPORTED" as const }
              : {}),
            ...(a.errorCode ? { errorCode: a.errorCode } : {}),
            ...(typeof a.httpStatus === "number" &&
            Number.isInteger(a.httpStatus) &&
            a.httpStatus >= 300 &&
            a.httpStatus <= 599
              ? { httpStatus: a.httpStatus }
              : {}),
          }))
        : turnTelemetry?.attempts && turnTelemetry.attempts.length > 0
          ? turnTelemetry.attempts.map((a, idx) => ({
              attempt: idx + 1,
              provider: a.provider,
              model: a.model ?? undefined,
              status: a.status,
              ...(a.httpAttempts !== undefined
                ? { httpAttempts: a.httpAttempts }
                : {}),
              ...(a.inputTokens !== undefined
                ? { inputTokens: a.inputTokens }
                : {}),
              ...(a.outputTokens !== undefined
                ? { outputTokens: a.outputTokens }
                : {}),
              ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}),
              ...(a.costUsd !== undefined
                ? { costSource: "PROVIDER_REPORTED" as const }
                : {}),
              ...(a.errorCode ? { errorCode: a.errorCode } : {}),
              ...(typeof a.httpStatus === "number" &&
              Number.isInteger(a.httpStatus) &&
              a.httpStatus >= 300 &&
              a.httpStatus <= 599
                ? { httpStatus: a.httpStatus }
                : {}),
            }))
          : [];

    const lastFailedAttempt = [...executionAttempts]
      .reverse()
      .find((a) => a.status === "FAILURE");
    const turnErrorCode = lastFailedAttempt?.errorCode ?? null;
    const turnHttpStatus = lastFailedAttempt?.httpStatus ?? null;

    const totalCostUsd =
      turnTelemetry?.totalCostUsd ??
      turnTelemetry?.retryTrace?.totalCostUsd ??
      null;
    const knownCostSubtotalUsd =
      turnTelemetry?.knownCostSubtotalUsd ??
      turnTelemetry?.retryTrace?.knownCostSubtotalUsd ??
      null;
    const costCompleteness =
      turnTelemetry?.costCompleteness ??
      turnTelemetry?.retryTrace?.costCompleteness ??
      (executionAttempts.length > 0 ? "UNAVAILABLE" : null);

    const providerStatus: "SUCCESS" | "FAILURE" | "NOT_CALLED" =
      deterministicBypass || providerAttempts === 0
        ? "NOT_CALLED"
        : (turnTelemetry?.finalStatus ?? (validated ? "SUCCESS" : "FAILURE"));

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
      executionAttempts:
        executionAttempts.length > 0 ? executionAttempts : null,
      totalCostUsd,
      knownCostSubtotalUsd,
      costCompleteness,
      stopReason: turnTelemetry?.stopReason ?? null,
      errorCode: turnErrorCode,
      httpStatus: turnHttpStatus,
      // PROMPT-AI-JEV-03B §12 — clarification anti-repeat / resume state: true
      // when the ONE resolver PRESERVED a pending task by re-asking its bounded
      // question instead of escalating (precedence rule 6).
      ...(resolvedTurn?.precedenceRule === "PENDING_TASK_PRESERVED"
        ? { clarifyAntiRepeat: true }
        : {}),
    });
    if (!validated) {
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
      const failureReply = resolveSafeFailureReply({
        controlHandoffReason:
          turnTelemetry?.conversationControl?.handoffReason ?? null,
        failureCause,
      });
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        failureReply,
        "NEED_HUMAN",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        failureReply,
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
      const handoffReply =
        resolvedTurn.precedenceRule === "EXPLICIT_HUMAN_REQUEST"
          ? SAFE_HANDOFF_REPLIES.HUMAN_REQUEST
          : SAFE_HANDOFF_REPLIES.SENSITIVE;
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        handoffReply,
        "NEED_HUMAN",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        handoffReply,
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
      // CORE-03A: One reconciled fact set for saved state and booking input.
      const turnReconciled = reconcileTurnSemanticFacts(
        validated.extraction,
        validated.factUpdates,
      );
      let bookingAiResponse = resolvedState
        ? resumeBookingExtraction(validated, resolvedState, turnReconciled)
        : {
            ...validated,
            extraction: turnReconciled.normalizedExtraction,
          };

      const todayIso = todayIsoInTimeZone(now, business.timezone ?? "UTC");

      if (isStructuredSemanticTurn) {
        // CORE-03B2B1: On structured semantic turns, validated AI proposals and authoritative
        // durable state are the sole sources of date, timePreference, and provider facts.
        // Customer prose must not be reinterpreted to invent, replace, remove, or restore those facts.

        // Date / Temporal handling: validated AI proposals and authoritative durable state
        if (
          turnReconciled.isRemoved("date") ||
          turnReconciled.isRemoved("dateRange")
        ) {
          bookingAiResponse = {
            ...bookingAiResponse,
            extraction: {
              ...bookingAiResponse.extraction,
              date: null,
              temporalRequest: null,
            },
          };
          if (resolvedState) {
            const nextFacts = { ...resolvedState.knownFacts };
            delete nextFacts.date;
            delete nextFacts.dateRange;
            resolvedState = {
              ...resolvedState,
              knownFacts: nextFacts,
              selectedDate: null,
              dateRange: null,
            };
            if (turnSession.enabled) {
              turnSession.state = resolvedState;
            }
          }
        } else {
          const explicitDate =
            turnReconciled.setFacts.get("date")?.value ??
            bookingAiResponse.extraction.date ??
            null;
          const serverTemporal = resolveServerTemporalRequest(
            bookingAiResponse.extraction.temporalRequest ?? null,
            explicitDate,
            now,
            business.timezone ?? "UTC",
          );

          if (serverTemporal.kind === "range_too_broad") {
            const broadMsg =
              "نطاق البحث المطلوب يتجاوز 14 يوماً. يرجى اختيار أسبوع محدد أو تحديد فترة أقصر (حتى 14 يوماً) لعرض المواعيد المتاحة.";
            const assistantMessage = await persistAssistantReply(
              deps,
              conversation.id,
              broadMsg,
              "AI_ACTIVE",
            );
            const delivery = await deliverAssistantReply(
              deps,
              customer.phone,
              business.name,
              conversation.id,
              broadMsg,
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
              delivery,
            };
          }

          if (serverTemporal.kind === "invalid") {
            let invalidMsg = "التاريخ المطلوب غير صالح، يرجى تحديد تاريخ قادم.";
            if (serverTemporal.reason === "PAST_DATE") {
              invalidMsg = "التاريخ المحدد في الماضي، يرجى اختيار تاريخ قادم.";
            } else if (serverTemporal.reason === "OUT_OF_BOUNDS") {
              invalidMsg =
                "نعتذر، الحجز متاح فقط خلال الـ 60 يوماً القادمة. يرجى اختيار موعد ضمن هذه الفترة.";
            } else if (serverTemporal.reason === "CONTRADICTION") {
              invalidMsg =
                "حدث تعارض في تحديد التاريخ، يرجى توضيح اليوم أو الأسبوع المطلوب.";
            }
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
              intent: validated.intent,
              conversationStatus: "AI_ACTIVE",
              handoffCause: null,
              assistantProvider: deps.ai.providerName,
              delivery,
            };
          }

          if (serverTemporal.kind === "single_date") {
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                date: serverTemporal.date,
                temporalRequest: {
                  type: "exact_date",
                  date: serverTemporal.date,
                },
              },
            };
            if (resolvedState) {
              const nextFacts = {
                ...resolvedState.knownFacts,
                date: serverTemporal.date,
              };
              delete nextFacts.dateRange;
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                selectedDate: serverTemporal.date,
                dateRange: null,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          } else if (serverTemporal.kind === "date_range") {
            const rangeObj = {
              startDate: serverTemporal.startDate,
              endDate: serverTemporal.endDate,
            };
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                date: null,
                temporalRequest: {
                  type: "date_range",
                  startDate: rangeObj.startDate,
                  endDate: rangeObj.endDate,
                },
              },
            };
            if (resolvedState) {
              const nextFacts = { ...resolvedState.knownFacts };
              delete nextFacts.date;
              nextFacts.dateRange = rangeObj;
              const hasObsoleteSlotOffer =
                turnSession.state?.offer?.kind === "SLOT" ||
                resolvedState.offer?.kind === "SLOT";
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                selectedDate: null,
                dateRange: rangeObj,
                offer: hasObsoleteSlotOffer ? null : resolvedState.offer,
              };
              if (turnSession.enabled) {
                if (turnSession.state?.offer?.kind === "SLOT") {
                  await turnSession.invalidateOffer();
                }
                turnSession.state = resolvedState;
              }
            }
          }
        }

        // Time preference handling: authoritative state / explicit turn proposals only
        if (turnReconciled.isTouched("timePreference")) {
          if (turnReconciled.isRemoved("timePreference")) {
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                timePreference: null,
              },
            };
            if (resolvedState) {
              const nextFacts = { ...resolvedState.knownFacts };
              delete nextFacts.timePreference;
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                selectedTimePref: null,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          } else {
            const rawExplicitTime =
              turnReconciled.setFacts.get("timePreference")?.value ??
              bookingAiResponse.extraction.timePreference ??
              null;
            const explicitTime: CanonicalTimePreference | null =
              isCanonicalTimePreference(rawExplicitTime)
                ? rawExplicitTime
                : null;
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                timePreference: explicitTime ?? null,
              },
            };
            if (resolvedState && explicitTime) {
              resolvedState = {
                ...resolvedState,
                knownFacts: {
                  ...resolvedState.knownFacts,
                  timePreference: explicitTime,
                },
                selectedTimePref: explicitTime,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          }
        }

        // Provider handling: authoritative state / explicit turn proposals only
        if (turnReconciled.isTouched("provider")) {
          if (turnReconciled.isRemoved("provider")) {
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                provider: null,
              },
            };
            if (resolvedState) {
              const nextFacts = { ...resolvedState.knownFacts };
              delete nextFacts.provider;
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                providerPreference: null,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          } else {
            const explicitProvider =
              turnReconciled.setFacts.get("provider")?.value ??
              bookingAiResponse.extraction.provider ??
              null;
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                provider: explicitProvider,
              },
            };
            if (resolvedState && explicitProvider) {
              resolvedState = {
                ...resolvedState,
                knownFacts: {
                  ...resolvedState.knownFacts,
                  provider: explicitProvider,
                },
                providerPreference: explicitProvider,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          }
        }

        // Exact time handling: authoritative state / explicit turn proposals only
        if (turnReconciled.isTouched("exactTime")) {
          if (turnReconciled.isRemoved("exactTime")) {
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                exactTime: null,
              },
            };
            if (resolvedState) {
              const {
                exactTime: _droppedEt,
                unresolvedTime: _droppedUt,
                ...nextFacts
              } = resolvedState.knownFacts;
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                lastClarification:
                  resolvedState.lastClarification?.type === "exact_time_period"
                    ? null
                    : resolvedState.lastClarification,
                offer: null,
                suspendedOffer: null,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          } else {
            const rawExplicitExact =
              turnReconciled.setFacts.get("exactTime")?.value ??
              (bookingAiResponse.extraction.exactTime?.type === "specific"
                ? bookingAiResponse.extraction.exactTime.time
                : null);
            if (rawExplicitExact) {
              bookingAiResponse = {
                ...bookingAiResponse,
                extraction: {
                  ...bookingAiResponse.extraction,
                  exactTime: { type: "specific", time: rawExplicitExact },
                },
              };
              if (resolvedState) {
                const { unresolvedTime: _droppedUt, ...nextFacts } =
                  resolvedState.knownFacts;
                resolvedState = {
                  ...resolvedState,
                  knownFacts: {
                    ...nextFacts,
                    exactTime: rawExplicitExact,
                  },
                };
                if (turnSession.enabled) {
                  turnSession.state = resolvedState;
                }
              }
            } else if (
              bookingAiResponse.extraction.exactTime?.type ===
              "unresolved_period"
            ) {
              const currentUnresolved = bookingAiResponse.extraction.exactTime;
              if (resolvedState) {
                const { exactTime: _droppedEt, ...nextFacts } =
                  resolvedState.knownFacts;
                void _droppedEt;
                resolvedState = {
                  ...resolvedState,
                  knownFacts: {
                    ...nextFacts,
                    unresolvedTime: {
                      hour: currentUnresolved.hour,
                      minute: currentUnresolved.minute ?? 0,
                    },
                  },
                  lastClarification: {
                    type: "exact_time_period",
                    unresolvedTime: {
                      hour: currentUnresolved.hour,
                      minute: currentUnresolved.minute ?? 0,
                    },
                  },
                  offer: null,
                  suspendedOffer: null,
                };
                if (turnSession.enabled) {
                  turnSession.state = resolvedState;
                }
              }
            }
          }
        }
      } else {
        const turnDateRes = resolveEgyptianRelativeDateDetailed(
          inbound.text,
          todayIso,
        );
        if (
          turnReconciled.isRemoved("date") ||
          turnReconciled.isRemoved("dateRange")
        ) {
          bookingAiResponse = {
            ...bookingAiResponse,
            extraction: {
              ...bookingAiResponse.extraction,
              date: null,
              temporalRequest: null,
            },
          };
          if (resolvedState) {
            const nextFacts = { ...resolvedState.knownFacts };
            delete nextFacts.date;
            delete nextFacts.dateRange;
            resolvedState = {
              ...resolvedState,
              knownFacts: nextFacts,
              selectedDate: null,
              dateRange: null,
            };
            if (turnSession.enabled) {
              turnSession.state = resolvedState;
            }
          }
        } else {
          let explicitDate =
            turnReconciled.setFacts.get("date")?.value ??
            bookingAiResponse.extraction.date ??
            turnDateRes.positiveDate ??
            null;
          const candidateTemporal =
            bookingAiResponse.extraction.temporalRequest ??
            turnDateRes.positiveTemporal ??
            null;

          const isLegacyUnmanaged = !resolvedState && !turnSession.enabled;
          if (
            !explicitDate &&
            !candidateTemporal &&
            isLegacyUnmanaged &&
            recentChronological &&
            turnDateRes.negatedDates.length === 0
          ) {
            const historyNegatedDates: string[] = [...turnDateRes.negatedDates];
            for (let i = recentChronological.length - 1; i >= 0; i--) {
              const m = recentChronological[i]!;
              if (m.senderType === "CUSTOMER") {
                const detailed = resolveEgyptianRelativeDateDetailed(
                  m.content,
                  todayIso,
                );
                for (const nd of detailed.negatedDates) {
                  if (!historyNegatedDates.includes(nd)) {
                    historyNegatedDates.push(nd);
                  }
                }
                if (
                  detailed.positiveDate &&
                  !historyNegatedDates.includes(detailed.positiveDate)
                ) {
                  explicitDate = detailed.positiveDate;
                  break;
                }
              }
            }
          }

          const serverTemporal = resolveServerTemporalRequest(
            candidateTemporal,
            explicitDate,
            now,
            business.timezone ?? "UTC",
          );

          if (serverTemporal.kind === "range_too_broad") {
            const broadMsg =
              "نطاق البحث المطلوب يتجاوز 14 يوماً. يرجى اختيار أسبوع محدد أو تحديد فترة أقصر (حتى 14 يوماً) لعرض المواعيد المتاحة.";
            const assistantMessage = await persistAssistantReply(
              deps,
              conversation.id,
              broadMsg,
              "AI_ACTIVE",
            );
            const delivery = await deliverAssistantReply(
              deps,
              customer.phone,
              business.name,
              conversation.id,
              broadMsg,
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
              delivery,
            };
          }

          if (serverTemporal.kind === "invalid") {
            let invalidMsg = "التاريخ المطلوب غير صالح، يرجى تحديد تاريخ قادم.";
            if (serverTemporal.reason === "PAST_DATE") {
              invalidMsg = "التاريخ المحدد في الماضي، يرجى اختيار تاريخ قادم.";
            } else if (serverTemporal.reason === "OUT_OF_BOUNDS") {
              invalidMsg =
                "نعتذر، الحجز متاح فقط خلال الـ 60 يوماً القادمة. يرجى اختيار موعد ضمن هذه الفترة.";
            } else if (serverTemporal.reason === "CONTRADICTION") {
              invalidMsg =
                "حدث تعارض في تحديد التاريخ، يرجى توضيح اليوم أو الأسبوع المطلوب.";
            }
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
              intent: validated.intent,
              conversationStatus: "AI_ACTIVE",
              handoffCause: null,
              assistantProvider: deps.ai.providerName,
              delivery,
            };
          }

          if (serverTemporal.kind === "single_date") {
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                date: serverTemporal.date,
                temporalRequest: {
                  type: "exact_date",
                  date: serverTemporal.date,
                },
              },
            };
            if (resolvedState) {
              const nextFacts = {
                ...resolvedState.knownFacts,
                date: serverTemporal.date,
              };
              delete nextFacts.dateRange;
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                selectedDate: serverTemporal.date,
                dateRange: null,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          } else if (serverTemporal.kind === "date_range") {
            const rangeObj = {
              startDate: serverTemporal.startDate,
              endDate: serverTemporal.endDate,
            };
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                date: null,
                temporalRequest: {
                  type: "date_range",
                  startDate: rangeObj.startDate,
                  endDate: rangeObj.endDate,
                },
              },
            };
            if (resolvedState) {
              const nextFacts = { ...resolvedState.knownFacts };
              delete nextFacts.date;
              nextFacts.dateRange = rangeObj;
              const hasObsoleteSlotOffer =
                turnSession.state?.offer?.kind === "SLOT" ||
                resolvedState.offer?.kind === "SLOT";
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                selectedDate: null,
                dateRange: rangeObj,
                offer: hasObsoleteSlotOffer ? null : resolvedState.offer,
              };
              if (turnSession.enabled) {
                if (turnSession.state?.offer?.kind === "SLOT") {
                  await turnSession.invalidateOffer();
                }
                turnSession.state = resolvedState;
              }
            }
          }
        }

        const turnTimeRes = extractTimeOfDayPreferenceDetailed(inbound.text);
        if (turnReconciled.isTouched("timePreference")) {
          if (turnReconciled.isRemoved("timePreference")) {
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                timePreference: null,
              },
            };
            if (resolvedState) {
              const nextFacts = { ...resolvedState.knownFacts };
              delete nextFacts.timePreference;
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                selectedTimePref: null,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          } else {
            const rawExplicitTime =
              turnReconciled.setFacts.get("timePreference")?.value ??
              bookingAiResponse.extraction.timePreference ??
              null;
            const explicitTime: CanonicalTimePreference | null =
              isCanonicalTimePreference(rawExplicitTime)
                ? rawExplicitTime
                : null;
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                timePreference: explicitTime ?? null,
              },
            };
            if (resolvedState && explicitTime) {
              resolvedState = {
                ...resolvedState,
                knownFacts: {
                  ...resolvedState.knownFacts,
                  timePreference: explicitTime,
                },
                selectedTimePref: explicitTime,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          }
        } else if (!bookingAiResponse.extraction.timePreference) {
          let timePref = turnTimeRes.positiveTime;
          const isLegacyUnmanaged = !resolvedState && !turnSession.enabled;
          if (
            !timePref &&
            isLegacyUnmanaged &&
            recentChronological &&
            turnTimeRes.negatedTimes.length === 0
          ) {
            const historyNegatedTimes: Array<
              "morning" | "afternoon" | "evening"
            > = [...turnTimeRes.negatedTimes];
            for (let i = recentChronological.length - 1; i >= 0; i--) {
              const m = recentChronological[i]!;
              if (m.senderType === "CUSTOMER") {
                const detailed = extractTimeOfDayPreferenceDetailed(m.content);
                for (const nt of detailed.negatedTimes) {
                  if (!historyNegatedTimes.includes(nt)) {
                    historyNegatedTimes.push(nt);
                  }
                }
                if (
                  detailed.positiveTime &&
                  !historyNegatedTimes.includes(detailed.positiveTime)
                ) {
                  timePref = detailed.positiveTime;
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

        // Provider resolution: One reconciled authoritative fact set for saved state and booking input (CORE-03A).
        if (turnReconciled.isTouched("provider")) {
          if (turnReconciled.isRemoved("provider")) {
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                provider: null,
              },
            };
            if (resolvedState) {
              const nextFacts = { ...resolvedState.knownFacts };
              delete nextFacts.provider;
              resolvedState = {
                ...resolvedState,
                knownFacts: nextFacts,
                providerPreference: null,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          } else {
            const explicitProvider =
              turnReconciled.setFacts.get("provider")?.value ??
              bookingAiResponse.extraction.provider ??
              null;
            bookingAiResponse = {
              ...bookingAiResponse,
              extraction: {
                ...bookingAiResponse.extraction,
                provider: explicitProvider,
              },
            };
            if (resolvedState && explicitProvider) {
              resolvedState = {
                ...resolvedState,
                knownFacts: {
                  ...resolvedState.knownFacts,
                  provider: explicitProvider,
                },
                providerPreference: explicitProvider,
              };
              if (turnSession.enabled) {
                turnSession.state = resolvedState;
              }
            }
          }
        } else {
          // No current validated provider update: manage carried preferences,
          // removals of stale rejected preferences, and genuine corrections.
          let provider = bookingAiResponse.extraction.provider ?? null;
          const turnProvRes = extractProviderPreferenceDetailed(inbound.text);

          if (
            provider &&
            turnProvRes.negatedProviders.some((np) => {
              const normNp = normalizeArabicText(np);
              const normP = normalizeArabicText(provider!);
              return (
                normNp === normP ||
                normP.includes(normNp) ||
                normNp.includes(normP)
              );
            })
          ) {
            provider = null;
          }

          const sameDoctorRequested =
            /(?:نفس\s+(?:الدكتور|الطبيب|الدكتورة|الطبيبة|المقدم)|مع\s+نفس)/.test(
              inbound.text,
            );
          if (sameDoctorRequested && !provider) {
            if (resolvedState?.knownFacts?.provider) {
              provider = resolvedState.knownFacts.provider;
            } else if (
              deps.appointmentRepository &&
              typeof deps.appointmentRepository.listRecentByCustomer ===
                "function"
            ) {
              const recent =
                await deps.appointmentRepository.listRecentByCustomer(
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
                  provider = matchedP.name ?? null;
                }
              }
            }
          } else if (turnProvRes.positiveProvider) {
            provider = turnProvRes.positiveProvider;
          }

          bookingAiResponse = {
            ...bookingAiResponse,
            extraction: {
              ...bookingAiResponse.extraction,
              provider,
            },
          };

          if (resolvedState) {
            const nextFacts = { ...resolvedState.knownFacts };
            if (provider) {
              nextFacts.provider = provider;
            } else {
              delete nextFacts.provider;
            }
            resolvedState = {
              ...resolvedState,
              knownFacts: nextFacts,
              providerPreference: provider,
            };
            if (turnSession.enabled) {
              turnSession.state = resolvedState;
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
        let serviceOffer: ServiceOffer | null = null;
        let dateOffer: DateOffer | null = null;
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
            const ok = await turnSession.commit();
            if (!ok) {
              return selectionReply(
                deps,
                selectionScope,
                "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
                "AI_ACTIVE",
                null,
                undefined,
                clarifyObservability,
              );
            }
          }
        } else if (
          turnSession.enabled &&
          mapped.reason === "MISSING_DATE" &&
          turnSession.state?.offer?.status !== "INVALIDATED"
        ) {
          const targetServiceId =
            mapped.serviceId ?? turnSession.state?.serviceId ?? "";
          const candidateProvider =
            mapped.providerText ??
            turnSession.state?.knownFacts.provider ??
            null;
          const timePref = isCanonicalTimePreference(
            turnSession.state?.knownFacts.timePreference,
          )
            ? turnSession.state.knownFacts.timePreference
            : null;

          let matchedProviderId: string | null = null;
          if (targetServiceId && candidateProvider) {
            const provRes = await resolveProviderCandidate(
              deps,
              business.id,
              branchId,
              targetServiceId,
              candidateProvider,
              isStructuredSemanticTurn ? "catalog_strict" : "legacy",
            );
            if (provRes.kind === "resolved") {
              matchedProviderId = provRes.providerId;
            } else {
              return promptProviderClarificationReply(
                deps,
                selectionScope,
                {
                  serviceId: targetServiceId,
                  serviceName:
                    mapped.serviceName ??
                    turnSession.state?.selectedService ??
                    "",
                  date: null,
                  eligibleProviders: provRes.eligibleProviders,
                  reason: provRes.reason,
                  intent: validated.intent,
                  observability: clarifyObservability,
                },
                turnSession,
                now,
              );
            }
          }

          const upcomingDatesResult = await resolveUpcomingBookingDates(
            deps,
            { business, branchId, customerId: customer.id },
            {
              serviceId: targetServiceId,
              providerId: matchedProviderId,
              timePreference: timePref,
              range: turnSession.state?.knownFacts.dateRange ?? null,
            },
            now,
          );

          if (upcomingDatesResult.status === "too_broad") {
            return selectionReply(
              deps,
              selectionScope,
              "نطاق البحث المطلوب يتجاوز 14 يوماً. يرجى اختيار أسبوع محدد أو تحديد فترة أقصر (حتى 14 يوماً) لعرض المواعيد المتاحة.",
              "AI_ACTIVE",
              null,
              undefined,
              clarifyObservability,
            );
          }

          if (
            upcomingDatesResult.status === "error" &&
            (!upcomingDatesResult.dates ||
              upcomingDatesResult.dates.length === 0)
          ) {
            return selectionReply(
              deps,
              selectionScope,
              "تعذر التحقق من المواعيد المتاحة حالياً بسبب مشكلة تقنية مؤقتة. يرجى المحاولة بعد قليل.",
              "AI_ACTIVE",
              null,
              undefined,
              clarifyObservability,
            );
          }

          const upcomingDates = upcomingDatesResult.dates ?? [];
          if (upcomingDatesResult.status === "success") {
            dateOffer = buildDateOffer(
              { businessId: business.id, conversationId: conversation.id },
              crypto.randomUUID(),
              {
                serviceId: targetServiceId,
                serviceName:
                  mapped.serviceName ??
                  turnSession.state?.selectedService ??
                  "",
                providerId: matchedProviderId,
                timePreference: timePref,
                dates: upcomingDates,
                range: turnSession.state?.knownFacts.dateRange ?? null,
                pageOffset: upcomingDatesResult.pageOffset,
                cursorDate: upcomingDatesResult.cursorDate,
                shownDates: upcomingDatesResult.shownDates,
                hasMore: upcomingDatesResult.hasMore,
                totalEligibleCount: upcomingDatesResult.totalEligibleCount,
              },
              now,
            );
            if (dateOffer) {
              turnSession.state = withPresentedOffer(
                turnSession.state ?? resolvedState ?? emptyConversationState(),
                dateOffer,
              );
              const ok = await turnSession.commit();
              if (!ok) {
                return selectionReply(
                  deps,
                  selectionScope,
                  "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
                  "AI_ACTIVE",
                  null,
                  undefined,
                  clarifyObservability,
                );
              }
            }
          }
        }
        if (turnSession.enabled && !serviceOffer && !dateOffer) {
          turnSession.state =
            turnSession.state ?? resolvedState ?? emptyConversationState();
          await turnSession.commit();
        }
        let choices: ChannelChoicePresentation | undefined;
        let clarifyMsgToSend = mapped.message;
        if (
          (mapped.reason === "MISSING_SERVICE" ||
            mapped.reason === "AMBIGUOUS_SERVICE") &&
          services.length > 0 &&
          serviceOffer
        ) {
          choices = buildChannelChoices(serviceOffer);
        } else if (mapped.reason === "MISSING_DATE" && dateOffer) {
          choices = buildChannelChoices(dateOffer);
          const serviceName =
            mapped.serviceName ??
            turnSession.state?.selectedService ??
            "المطلوبة";
          const currentRange = turnSession.state?.knownFacts.dateRange;
          const lines = [];
          if (dateOffer.options.length > 0) {
            if (currentRange) {
              const rangeStr = formatArabicDateRange(
                currentRange.startDate,
                currentRange.endDate,
              );
              lines.push(
                `تم تحديد الفترة (${rangeStr}) لحجز خدمة "${serviceName}". يرجى اختيار اليوم المناسب:`,
              );
            } else {
              lines.push(
                `يرجى تحديد اليوم أو التاريخ المناسب لك لحجز خدمة "${serviceName}":`,
              );
            }
            for (const opt of dateOffer.options) {
              lines.push(`${opt.index}️⃣ ${opt.label}`);
            }
            if (dateOffer.hasMore) {
              lines.push("(اضغط على «مواعيد أخرى» لعرض المزيد من الأيام)");
            }
            if (currentRange) {
              lines.push(
                "(أو يمكنك اختيار «فترة أخرى» لتغيير نطاق البحث أو كتابة تاريخ مباشرة)",
              );
            } else {
              lines.push("(أو يمكنك كتابة أي تاريخ آخر مباشرة في أي وقت)");
            }
          } else {
            if (currentRange) {
              const rangeStr = formatArabicDateRange(
                currentRange.startDate,
                currentRange.endDate,
              );
              lines.push(
                `لا تتوفر مواعيد متاحة لخدمة "${serviceName}" خلال الفترة (${rangeStr}). يمكنك اختيار فترة أخرى أو كتابة تاريخ محدد:`,
              );
            } else {
              lines.push(
                `لا تتوفر مواعيد متاحة لخدمة "${serviceName}" خلال الفترة المحددة. يمكنك اختيار تاريخ آخر:`,
              );
            }
          }
          clarifyMsgToSend = lines.join("\n");
        } else if (
          mapped.reason === "MISSING_DATE" &&
          !dateOffer &&
          turnSession.state?.knownFacts.dateRange
        ) {
          const serviceName =
            mapped.serviceName ??
            turnSession.state?.selectedService ??
            "المطلوبة";
          const currentRange = turnSession.state.knownFacts.dateRange;
          const rangeStr = formatArabicDateRange(
            currentRange.startDate,
            currentRange.endDate,
          );
          clarifyMsgToSend = `لا تتوفر مواعيد متاحة لخدمة "${serviceName}" خلال الفترة (${rangeStr}). يمكنك اختيار فترة أخرى أو كتابة تاريخ محدد:`;
        }
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          clarifyMsgToSend,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          clarifyMsgToSend,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
          choices,
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
        { mode: isStructuredSemanticTurn ? "catalog_strict" : "legacy" },
      );
      if (providerMatch.status === "missing") {
        return promptProviderClarificationReply(
          deps,
          selectionScope,
          {
            serviceId: mapped.serviceId,
            serviceName: mapped.serviceName,
            date: mapped.date,
            eligibleProviders: eligibility.data.providers,
            reason: providerMatch.reason,
            intent: validated.intent,
            observability: turnObservability,
          },
          turnSession,
          now,
        );
      }
      const providerId =
        providerMatch.status === "ok" ? providerMatch.providerId : undefined;

      // CORE-03B2B1, CORE-03D1: Final time-preference filtering on structured semantic turns respects
      // validated extraction / durable state only — never reinterprets raw inbound prose.
      const persistedTimeOfDay =
        turnSession.state?.knownFacts.timePreference ??
        resolvedState?.knownFacts.timePreference;
      if (
        typeof persistedTimeOfDay === "string" &&
        persistedTimeOfDay.trim().length > 0 &&
        !isCanonicalTimePreference(persistedTimeOfDay)
      ) {
        if (turnSession.enabled) {
          await turnSession.invalidateOffer();
        }
        const clarMsg =
          "يرجى تحديد وقت الحجز المفضل: صباحاً، بعد الظهر، أو مساءً (أو اذكر أن أي وقت مناسب).";
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          clarMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          clarMsg,
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

      const rawTimeOfDayPref = isStructuredSemanticTurn
        ? (bookingAiResponse.extraction.timePreference ?? null)
        : turnReconciled.isTouched("timePreference")
          ? (bookingAiResponse.extraction.timePreference ?? null)
          : (bookingAiResponse.extraction.timePreference ??
            extractTimeOfDayPreference(inbound.text));
      const timeOfDayPref: CanonicalTimePreference | null =
        isCanonicalTimePreference(rawTimeOfDayPref) ? rawTimeOfDayPref : null;

      // CORE-02 — deterministic booking options (reuses CORE-01 + availability layer)
      const turnBusinessTz = resolveValidTimeZone(business.timezone);
      const isToday = mapped.date === todayIso;
      const currentTime = nowTimeInTimeZone(now, turnBusinessTz);

      const bookingDeps = buildBookingDeps(deps, eligibilityDeps);

      let rawExactTime = bookingAiResponse.extraction.exactTime ?? null;

      const hasTurnExactProposal =
        turnReconciled.isTouched("exactTime") ||
        Boolean(validated.extraction.exactTime);

      const hasTurnPeriodClarification =
        turnReconciled.isTouched("timePreference") &&
        Boolean(
          turnReconciled.setFacts.get("timePreference")?.value ??
          validated.extraction.timePreference,
        );
      const turnPeriodRaw = hasTurnPeriodClarification
        ? (turnReconciled.setFacts.get("timePreference")?.value ??
          validated.extraction.timePreference ??
          null)
        : null;
      const currentPeriodClarification: CanonicalTimePreference | null =
        isCanonicalTimePreference(turnPeriodRaw) ? turnPeriodRaw : null;

      // Pending uncertainty from prior turn
      const pendingClar =
        turnSession.state?.lastClarification?.type === "exact_time_period"
          ? turnSession.state.lastClarification
          : null;
      const priorUnresolved =
        pendingClar?.unresolvedTime ??
        turnSession.state?.knownFacts.unresolvedTime ??
        null;

      if (hasTurnExactProposal && rawExactTime?.type === "unresolved_period") {
        // A current explicit ambiguous proposal was stated on this turn.
        // If and only if the current turn ALSO provided an explicit period clarification,
        // resolve using the CURRENT proposal's hour and minute.
        // Stale/inherited timePreference must NEVER override a current unresolved proposal.
        if (currentPeriodClarification) {
          const h = rawExactTime.hour;
          const m = rawExactTime.minute ?? 0;
          let resolvedHour: number;
          if (
            currentPeriodClarification === "afternoon" ||
            currentPeriodClarification === "evening"
          ) {
            resolvedHour = h === 12 ? 12 : h + 12;
          } else {
            resolvedHour = h === 12 ? 0 : h;
          }
          rawExactTime = {
            type: "specific",
            time: `${String(resolvedHour).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
          };
        }
      } else if (
        !hasTurnExactProposal &&
        priorUnresolved &&
        currentPeriodClarification
      ) {
        // Legitimate follow-up turn: customer answered the pending AM/PM clarification
        // with explicit morning/afternoon/evening on this turn.
        const h = priorUnresolved.hour;
        const m = priorUnresolved.minute ?? 0;
        let resolvedHour: number;
        if (
          currentPeriodClarification === "afternoon" ||
          currentPeriodClarification === "evening"
        ) {
          resolvedHour = h === 12 ? 12 : h + 12;
        } else {
          resolvedHour = h === 12 ? 0 : h;
        }
        rawExactTime = {
          type: "specific",
          time: `${String(resolvedHour).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
        };
      }

      // PROMPT-EXACT-TIME: AM/PM unresolved ambiguity (e.g. "الساعة 3")
      if (rawExactTime && rawExactTime.type === "unresolved_period") {
        if (turnSession.enabled) {
          await turnSession.invalidateOffer();
          const { exactTime: _droppedTime, ...prevFacts } =
            turnSession.state?.knownFacts ?? {};
          void _droppedTime;
          turnSession.state = {
            ...(turnSession.state ?? resolvedState ?? emptyConversationState()),
            activeTask: {
              kind: "BOOKING",
              stage: "DATE_SUPPLIED",
            },
            knownFacts: {
              ...prevFacts,
              service: mapped.serviceName,
              date: mapped.date!,
              unresolvedTime: {
                hour: rawExactTime.hour,
                minute: rawExactTime.minute ?? 0,
              },
              ...(providerId ? { provider: providerId } : {}),
            },
            lastClarification: {
              type: "exact_time_period",
              unresolvedTime: {
                hour: rawExactTime.hour,
                minute: rawExactTime.minute ?? 0,
              },
            },
            offer: null,
            suspendedOffer: null,
          };
          await turnSession.commit();
        }
        const minStr =
          rawExactTime.minute && rawExactTime.minute > 0
            ? `:${String(rawExactTime.minute).padStart(2, "0")}`
            : "";
        const clarMsg = `هل تقصد الساعة ${rawExactTime.hour}${minStr} عصراً (مساءً) أم ${rawExactTime.hour}${minStr} فجراً (صباحاً)؟`;
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          clarMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          clarMsg,
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

      // PROMPT-EXACT-TIME: Specific exact time requested or inquired
      if (rawExactTime && rawExactTime.type === "specific") {
        const exactTimeRequested = rawExactTime.time;
        const exactTimeEval = await evaluateExactTimeAvailability(
          bookingDeps as unknown as Parameters<
            typeof evaluateExactTimeAvailability
          >[0],
          { userId: customer.id, businessId: business.id },
          {
            serviceId: mapped.serviceId,
            branchId: mapped.branchId ?? null,
            providerId: providerId ?? null,
            date: mapped.date!,
            requestedTime: exactTimeRequested,
            now,
            businessTimezone: turnBusinessTz,
          },
        );

        const { message: exactTimeMsg, slotsToOffer } =
          composeExactTimeResponse({
            evaluation: exactTimeEval,
            date: mapped.date!,
            requestedTime: exactTimeRequested,
            intent: validated.intent,
          });

        let slotOffer: SlotOffer | null = null;
        if (turnSession.enabled && slotsToOffer.length > 0) {
          slotOffer = buildSlotOffer(
            { businessId: business.id, conversationId: conversation.id },
            crypto.randomUUID(),
            {
              serviceId: mapped.serviceId,
              serviceName: mapped.serviceName,
              serviceSource: mapped.serviceSource,
              providerId: providerId ?? null,
              timePreference: timeOfDayPref ?? null,
              date: mapped.date!,
              followUpRequestId: activeFollowUpId,
              shownCount: slotsToOffer.length,
              shownSlotKeys: slotsToOffer.map(
                (o) => `${o.providerId}:${mapped.date}T${o.startTime}`,
              ),
              options: slotsToOffer.map((o) => ({
                providerId: o.providerId,
                displayName: o.displayName,
                startAt: `${mapped.date}T${o.startTime}`,
                endAt: `${mapped.date}T${o.endTime}`,
              })),
            },
            now,
          );
          if (slotOffer) {
            turnSession.state = withPresentedOffer(
              turnSession.state ?? resolvedState ?? emptyConversationState(),
              slotOffer,
            );
            const { unresolvedTime: _droppedUnr, ...cleanKnown } =
              turnSession.state.knownFacts ?? {};
            void _droppedUnr;
            turnSession.state = {
              ...turnSession.state,
              activeTask: {
                kind: "BOOKING",
                stage: "AVAILABILITY_RESOLVED",
              },
              bookingStage: "AVAILABILITY_RESOLVED",
              knownFacts: {
                ...cleanKnown,
                service: mapped.serviceName,
                date: mapped.date!,
                exactTime: exactTimeRequested,
                ...(timeOfDayPref ? { timePreference: timeOfDayPref } : {}),
                ...(providerId ? { provider: providerId } : {}),
              },
              lastClarification: null,
            };
            await turnSession.commit();
          }
        } else if (turnSession.enabled) {
          await turnSession.invalidateOffer();
          const { unresolvedTime: _droppedUnr, ...cleanKnown } =
            turnSession.state?.knownFacts ?? {};
          void _droppedUnr;
          turnSession.state = {
            ...(turnSession.state ?? resolvedState ?? emptyConversationState()),
            activeTask: {
              kind: "BOOKING",
              stage: "DATE_SUPPLIED",
            },
            knownFacts: {
              ...cleanKnown,
              service: mapped.serviceName,
              date: mapped.date!,
              exactTime: exactTimeRequested,
              ...(timeOfDayPref ? { timePreference: timeOfDayPref } : {}),
              ...(providerId ? { provider: providerId } : {}),
            },
            lastClarification: null,
            offer: null,
            suspendedOffer: null,
          };
          await turnSession.commit();
        }

        const choices = slotOffer ? buildChannelChoices(slotOffer) : undefined;
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          exactTimeMsg,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          exactTimeMsg,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
          choices,
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
      const bookingResult = await resolveBookingOptions(
        bookingDeps as unknown as Parameters<typeof resolveBookingOptions>[0],
        { userId: customer.id, businessId: business.id },
        {
          serviceId: mapped.serviceId,
          ...(mapped.branchId ? { branchId: mapped.branchId } : {}),
          ...(providerId ? { providerId } : {}),
          date: mapped.date!,
          ...(timeOfDayPref ? { timePreference: timeOfDayPref } : {}),
          ...(isToday ? { minStartTime: currentTime } : {}),
          limit: 50,
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

      let bookableOptions = filterElapsedSlots(
        bookingResult.data.options,
        mapped.date!,
        now,
        turnBusinessTz,
      );
      if (timeOfDayPref) {
        const matchesPref = (startTime: string) => {
          const hour = parseInt(startTime.slice(0, 2), 10);
          if (Number.isNaN(hour)) return false;
          if (timeOfDayPref === "morning") return hour < 12;
          if (timeOfDayPref === "afternoon") return hour >= 12 && hour < 17;
          if (timeOfDayPref === "evening") return hour >= 17;
          return false;
        };
        bookableOptions = bookableOptions.filter((o) =>
          matchesPref(o.startAt.slice(11, 16)),
        );
      }

      if (bookableOptions.length === 0) {
        const reason =
          bookingResult.data.options.length === 0
            ? (bookingResult.reason ?? "FULLY_BOOKED")
            : "FULLY_BOOKED";
        if (reason === "NO_PERIOD_SLOTS") {
          if (turnSession.enabled) {
            await turnSession.commit();
          }
          const msg = bookingEmptyReasonMessage(
            "NO_PERIOD_SLOTS",
            mapped.date!,
            timeOfDayPref,
          );
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

      const representativeOptions = sampleRepresentativeSlots(
        bookableOptions,
        4,
      );

      let slotOffer: SlotOffer | null = null;
      if (turnSession.enabled) {
        slotOffer = buildSlotOffer(
          { businessId: business.id, conversationId: conversation.id },
          crypto.randomUUID(),
          {
            serviceId: mapped.serviceId,
            serviceName: mapped.serviceName,
            serviceSource: mapped.serviceSource,
            providerId: providerId ?? null,
            timePreference: timeOfDayPref ?? null,
            date: mapped.date!,
            followUpRequestId: activeFollowUpId,
            shownCount: representativeOptions.length,
            shownSlotKeys: representativeOptions.map(
              (o) => `${o.providerId}:${o.startAt}`,
            ),
            options: representativeOptions.map((o) => ({
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
          const ok = await turnSession.commit();
          if (!ok) {
            return selectionReply(
              deps,
              selectionScope,
              "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.",
              "AI_ACTIVE",
              null,
              undefined,
              turnObservability,
            );
          }
        }
      }

      const choices = slotOffer ? buildChannelChoices(slotOffer) : undefined;

      // Success with options — AI_REPLY, stay AI_ACTIVE (no appointment mutation)
      const optionsMsg = formatBookingOptionsMessage(
        mapped.serviceName,
        mapped.date!,
        representativeOptions,
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
        choices,
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
      // customer is NOT left in silence: the turn delivers the safe, deterministic
      // handoff acknowledgment for unbacked knowledge turns (SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED),
      // then takes the existing NEED_HUMAN + operator-attention handoff path.
      // This keeps the E2E WhatsApp reply path alive for conversational
      // turns a business has no knowledge store for (a greeting, a question
      // with no stored FAQ) without ever emitting an unbacked reply. The
      // refusal reason stays an operator-side diagnostic (never customer-
      // visible): the customer sees only the safe acknowledgment.
      const refusalReply = SAFE_HANDOFF_REPLIES.DISCLOSURE_REFUSED;
      const assistantMessage = await persistAssistantReply(
        deps,
        conversation.id,
        refusalReply,
        "NEED_HUMAN",
      );
      const delivery = await deliverAssistantReply(
        deps,
        customer.phone,
        business.name,
        conversation.id,
        refusalReply,
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
    // Bounded domain rendering for business identity (PROMPT-AI-UX-02 / Semantic Authority Repair):
    // An identity reply is backed by the authoritative business.name fact. When the turn's
    // active answer goal is business identity (or backed by business.identity support), the domain
    // renders the canonical, bounded Arabic identity acknowledgement, guaranteeing that arbitrary
    // unbacked prose (such as fabricated prices or procedure claims) is never emitted.
    const isIdentityAnswer =
      disclosure.support.includes("business.identity") ||
      isExplicitIdentityGoal(resolvedTurn?.plan?.steps[0]);
    const content = isIdentityAnswer
      ? buildBusinessIdentityContent(business.name)
      : disclosure.response.content;

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
    const computedContent = answerAndContinue
      ? `${content}\n\n${CONTINUE_DOMAIN_INVITE}`
      : content;
    let finalContent = computedContent;

    let choices: ChannelChoicePresentation | undefined;
    let greetingOfferCommitted = false;
    let greetingOfferConflict = false;

    // Persist-before-present invariant: Any actionable offer must be
    // successfully persisted before its choices are presented to the transport.
    if (validated.action === "reply") {
      const activeOffer = turnSession.state?.offer;
      const isOfferValid =
        activeOffer &&
        activeOffer.status === "ACTIVE" &&
        new Date(activeOffer.expiresAt).getTime() > now.getTime();

      if (isOfferValid) {
        choices = buildChannelChoices(activeOffer);
      } else if (
        validated.intent === "GREETING" &&
        !turnSession.state?.activeTask
      ) {
        const welcomeOffer = buildWelcomeOffer(
          { businessId: business.id, conversationId: conversation.id },
          crypto.randomUUID(),
          now,
        );
        if (welcomeOffer) {
          if (turnSession.enabled) {
            turnSession.state = withPresentedOffer(
              turnSession.state ?? resolvedState ?? emptyConversationState(),
              welcomeOffer,
            );
            const ok = await turnSession.commit();
            if (ok) {
              choices = buildChannelChoices(welcomeOffer);
              greetingOfferCommitted = true;
            } else {
              // Commit conflict or persistence failure:
              // Never send unconfirmed offer buttons. Return safe retry copy.
              greetingOfferConflict = true;
              choices = undefined;
              finalContent =
                "حدث تعارض مؤقت أثناء معالجة طلبك، يرجى إعادة المحاولة.";
            }
          } else {
            // Durable state storage is unavailable: do not send actionable
            // welcome choices whose callbacks cannot be resolved or matched
            // against persisted state. Preserve plain-text greeting response.
            choices = undefined;
          }
        }
      }
    }

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
        ...(choices ? { choices } : {}),
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

    if (turnSession.enabled && (resolvedState || turnSession.state)) {
      let finalState = turnSession.state ?? resolvedState!;
      if (
        validated.action !== "reply" ||
        validated.intent === "HUMAN_REQUEST" ||
        validated.handoffReason
      ) {
        finalState = withOfferStatus(finalState, "INVALIDATED");
        turnSession.state = finalState;
        await turnSession.commit();
      } else if (!greetingOfferCommitted && !greetingOfferConflict) {
        turnSession.state = finalState;
        await turnSession.commit();
      }
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
