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
import type {
  AiRequest,
  AiResponse,
} from "@/features/conversations/server/ai-contract";
import {
  AI_KNOWLEDGE_ENTRY_LIMIT,
  AI_RECENT_MESSAGE_LIMIT,
  parseAiResponse,
} from "@/features/conversations/server/ai-contract";
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
import { tryParseBookingSelection } from "@/features/conversations/server/booking-selection";
import type { ConversationAi } from "@/features/conversations/server/conversation-ai";
import {
  bypassDeterministicAi,
  normalizeArabicText,
} from "@/features/conversations/server/conversation-ai";
import type { MessageTransport } from "@/features/conversations/server/conversation-transport";
import { offlineMessageTransport } from "@/features/conversations/server/conversation-transport";
import { faqEntrySchema } from "@/lib/validation";
import type { RecordUsageDto } from "@/lib/validation";
import { createPolicyBackedAi } from "@/server/integrations/ai/factory";
import type { AiTelemetry } from "@/server/integrations/ai/types";
import type {
  AppointmentRepository,
  BranchRepository,
  BusinessRepository,
  ConversationRepository,
  CustomerRepository,
  InboundDedupeRepository,
  ProviderRepository,
  ServiceRepository,
  UsageRepository,
} from "@/server/repositories";
import {
  appointmentRepository,
  branchRepository,
  businessRepository,
  conversationRepository,
  customerRepository,
  inboundDedupeRepository,
  providerRepository,
  serviceRepository,
  usageRepository,
} from "@/server/repositories";
import { InboundDuplicateError } from "@/server/repositories/inbound-dedupe.repository";
import type { Conversation, ConversationStatus } from "@/types/domain";

import { z } from "zod";

/** Stored knowledge contract reuse (same shape the knowledge feature manages). */
const storedFaqsSchema = z.array(faqEntrySchema);

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
  providerRepository?: Pick<
    ProviderRepository,
    "listEligibleForService" | "listAssignmentSeams"
  >;
  appointmentRepository?: Pick<
    AppointmentRepository,
    "listBlockingByAssignees"
  > &
    Partial<Pick<AppointmentRepository, "createWithConflictCheck">>;
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
  providerRepository,
  appointmentRepository,
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
  conversationId: string;
  customerId: string;
  /** The persisted CUSTOMER message id. */
  customerMessageId: string;
  assistantAction: AssistantAction;
  /** Classified intent when the AI ran; null when deferred to staff. */
  intent: AiResponse["intent"] | null;
  conversationStatus: ConversationStatus;
  /** Assistant provider that answered (honest reporting). */
  assistantProvider: string;
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
function formatBookingOptionsMessage(
  serviceName: string,
  date: string,
  options: Array<{ displayName: string; startAt: string; endAt: string }>,
): string {
  const lines = options.map((opt, idx) => {
    const start = opt.startAt.slice(11, 16);
    const end = opt.endAt.slice(11, 16);
    return `${idx + 1}. ${opt.displayName} — ${start} إلى ${end}`;
  });
  return `تتوفر المواعيد التالية لخدمة "${serviceName}" يوم ${date}:\n${lines.join("\n")}\nيرجى اختيار أحد الخيارات وسيتواصل معك الفريق لإتمام الحجز.`;
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

/** Malformed stored FAQ JSON degrades to "no knowledge" — never crashes. */
function safeFaqs(raw: unknown): Array<{ question: string; answer: string }> {
  const parsed = storedFaqsSchema.safeParse(raw ?? []);
  return parsed.success ? parsed.data.slice(0, AI_KNOWLEDGE_ENTRY_LIMIT) : [];
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
    date: string;
    startTime: string;
    endTime: string;
    status: string;
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
  } catch {
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
  );
  return {
    ok: true,
    duplicate: false,
    conversationId: scope.conversation.id,
    customerId: scope.customer.id,
    customerMessageId: scope.customerMessageId,
    assistantAction: status === "NEED_HUMAN" ? "AI_HANDOFF" : "AI_REPLY",
    intent: "BOOKING",
    conversationStatus: status,
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
): Promise<InboundSuccess | null> {
  const reply = (
    content: string,
    status: "AI_ACTIVE" | "NEED_HUMAN" | "BOOKED",
  ) => selectionReply(deps, scope, content, status);

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
    );
  }
  const freshOptions = bookingResult.data.options;
  if (freshOptions.length === 0) {
    return reply(
      bookingEmptyReasonMessage(bookingResult.reason ?? "FULLY_BOOKED", date),
      "NEED_HUMAN",
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
    return reply(BOOKING_RETRY_MESSAGE, "NEED_HUMAN");
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
  const assigneeId = await resolveAssigneeId(
    deps,
    scope.business.id,
    chosen.providerId,
  );
  if (!resolvedBranchId || !assigneeId) {
    return reply(BOOKING_RETRY_MESSAGE, "NEED_HUMAN");
  }

  const created = await createAppointmentForSelection(deps, {
    businessId: scope.business.id,
    customerId: scope.customer.id,
    serviceId,
    branchId: resolvedBranchId,
    assignedUserId: assigneeId,
    date,
    startTime,
    endTime,
    status: initialStatus,
  });

  if (created.status === "failed") {
    // Unexpected booking failure — NEVER a success confirmation.
    return reply(BOOKING_RETRY_MESSAGE, "NEED_HUMAN");
  }
  if (created.status === "conflict") {
    // SLOT_CONFLICT (concurrent close) — retry-safe: refresh + re-offer.
    const retry = await resolveBookingOptions(
      bookingDeps as unknown as Parameters<typeof resolveBookingOptions>[0],
      { userId: scope.customer.id, businessId: scope.business.id },
      { serviceId, ...(branchId ? { branchId } : {}), date },
    );
    if (retry.success && retry.data.options.length > 0) {
      return reply(
        `عذراً، تم حجز هذا الموعد للتو — إليك المواعيد المتاحة الآن:\n${formatBookingOptionsMessage(serviceName, date, retry.data.options)}`,
        "AI_ACTIVE",
      );
    }
    return reply(BOOKING_CONFLICT_MESSAGE, "NEED_HUMAN");
  }

  // 7. BOOKED transition + authoritative confirmation. The confirmation
  //    uses ONLY the created appointment's resolved values, and is
  //    persisted/delivered only AFTER creation succeeded.
  const confirmation =
    initialStatus === "CONFIRMED"
      ? `تم تأكيد حجزك لخدمة "${serviceName}" يوم ${date} من ${startTime} إلى ${endTime} مع ${chosen.displayName}.`
      : `تم استلام طلب حجزك لخدمة "${serviceName}" يوم ${date} من ${startTime} إلى ${endTime} مع ${chosen.displayName}. سيتواصل معك الفريق لتأكيد الموعد.`;
  return reply(confirmation, "BOOKED");
}

// ─── The engine ──────────────────────────────────────────────────────────────

/**
 * Process ONE inbound WhatsApp-style message end-to-end. Idempotent at
 * every level: durable external-key dedupe before irreversible
 * processing, customer upsert + latest-conversation reuse, and
 * claim-coupled message persistence for concurrent redeliveries.
 */
export async function receiveInboundMessage(
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
    const aiEligible =
      conversation.status === "AI_ACTIVE" && !conversation.assignedUserId;
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
        aiEligible ? {} : { status: "NEED_HUMAN" },
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
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "DEFERRED_TO_STAFF",
        intent: null,
        conversationStatus: "NEED_HUMAN",
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
    // 7b. Deterministic booking selection close-the-loop (PROMPT-AI-03B):
    // Never calls LLM, never fabricates ids — customer chose 1/2/3 or
    // HH:mm or provider-name after an offer. Re-derive Business/Branch/
    // Service server-side, re-run CORE-01+CORE-02 fresh, then canonical
    // createWithConflictCheck → BOOKED + confirmation (zero write on
    // stale/invalid/ambiguous).
    const selectionAttempt = tryParseBookingSelection(
      inbound.text,
      recentChronological,
    );
    if (selectionAttempt) {
      const selectionResult = await completeBookingSelection(
        deps,
        {
          business,
          conversation,
          customer,
          customerMessageId: customerMessage.id,
          connectionId: outboundConnectionId,
          services,
        },
        selectionAttempt.context,
        selectionAttempt.selection,
      );
      if (selectionResult) return selectionResult;
    }
    const aiRequest: AiRequest = {
      message: inbound.text,
      conversationStatus: conversation.status,
      recentMessages: recentChronological,
      businessName: business.name,
      services: services.map((service) => ({
        name: service.name,
        durationMinutes: service.durationMinutes,
      })),
      faqs: safeFaqs(business.faqs),
    };

    // 8. Deterministic bypass first (DECISIONS #33): turns safely
    //    decidable without an assistant never spend an AI call — and
    //    never produce an AI_TURN usage fact (no request was made).
    let turn: AiResponse | null = bypassDeterministicAi(aiRequest);
    if (!turn) {
      try {
        turn = await deps.ai.respond(aiRequest);
      } catch {
        turn = null;
      }
      // Rich AI_TURN telemetry when the adapter exposes it (LLM path);
      // deterministic / non-telemetry adapters keep the lightweight record.
      // The orchestrator's deterministic-bypass telemetry is still a bypass
      // - no AI_TURN fact is recorded (no provider call was spent).
      const telemetry = readAiTelemetry(deps.ai);
      const isBypassTelemetry =
        telemetry?.finalProvider === "deterministic-bypass";
      if (!isBypassTelemetry) {
        const lastAttempt = telemetry?.attempts[telemetry.attempts.length - 1];
        const successAttempt = telemetry
          ? [...telemetry.attempts]
              .reverse()
              .find((a) => a.status === "SUCCESS")
          : null;
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
    //    silent handoff).
    const validated = turn ? parseAiResponse(turn) : null;
    if (!validated) {
      await deps.conversationRepository.updateWorkflow(conversation.id, {
        status: "NEED_HUMAN",
      });
      return {
        ok: true,
        duplicate: false,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_HANDOFF",
        intent: null,
        conversationStatus: "NEED_HUMAN",
        assistantProvider: deps.ai.providerName,
        delivery: null,
      };
    }

    // 9b. BOOKING/AVAILABILITY seam (PROMPT-AI-03): mapper → CORE-01 → CORE-02
    // Only for booking-related intents; all other intents fall through to
    // the generic reply/handoff path. No appointment mutation here.
    if (validated.intent === "BOOKING" || validated.intent === "AVAILABILITY") {
      const branchId = (conversation.branchId as string | null) ?? null;
      const mapped = mapAiResponseToBookingInput({
        businessId: business.id,
        branchId,
        services: services.map((s) => ({ id: s.id, name: s.name })),
        aiResponse: validated,
      });
      if (mapped.kind === "needs_clarification") {
        const assistantMessage = await persistAssistantReply(
          deps,
          conversation.id,
          mapped.message,
          "AI_ACTIVE",
        );
        const delivery = await deliverAssistantReply(
          deps,
          customer.phone,
          business.name,
          conversation.id,
          mapped.message,
          assistantMessage.id,
          business.id,
          outboundConnectionId,
        );
        return {
          ok: true,
          duplicate: false,
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: validated.intent,
          conversationStatus: "AI_ACTIVE",
          assistantProvider: deps.ai.providerName,
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
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_HANDOFF",
          intent: validated.intent,
          conversationStatus: "NEED_HUMAN",
          assistantProvider: deps.ai.providerName,
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
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_REPLY",
          intent: validated.intent,
          conversationStatus: "AI_ACTIVE",
          assistantProvider: deps.ai.providerName,
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
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_HANDOFF",
          intent: validated.intent,
          conversationStatus: "NEED_HUMAN",
          assistantProvider: deps.ai.providerName,
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
          conversationId: conversation.id,
          customerId: customer.id,
          customerMessageId: customerMessage.id,
          assistantAction: "AI_HANDOFF",
          intent: validated.intent,
          conversationStatus: "NEED_HUMAN",
          assistantProvider: deps.ai.providerName,
          delivery,
        };
      }
      // Success with options — AI_REPLY, stay AI_ACTIVE (no appointment mutation)
      const optionsMsg = formatBookingOptionsMessage(
        mapped.serviceName,
        mapped.date!,
        bookingResult.data.options,
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
      );
      return {
        ok: true,
        duplicate: false,
        conversationId: conversation.id,
        customerId: customer.id,
        customerMessageId: customerMessage.id,
        assistantAction: "AI_REPLY",
        intent: validated.intent,
        conversationStatus: "AI_ACTIVE",
        assistantProvider: deps.ai.providerName,
        delivery,
      };
    }
    const content = validated.content;

    // 10. Persist the assistant reply through the single write path with
    //     the workflow the turn decided.
    const assistantMessage = await deps.conversationRepository.addMessage(
      {
        conversationId: conversation.id,
        senderType: "AI",
        content,
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
        content,
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

    return {
      ok: true,
      duplicate: false,
      conversationId: conversation.id,
      customerId: customer.id,
      customerMessageId: customerMessage.id,
      assistantAction: validated.action === "reply" ? "AI_REPLY" : "AI_HANDOFF",
      intent: validated.intent,
      conversationStatus:
        validated.action === "reply" ? "AI_ACTIVE" : "NEED_HUMAN",
      assistantProvider: deps.ai.providerName,
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
