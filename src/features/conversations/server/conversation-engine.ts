/**
 * Conversation engine (PROMPT-19; hardened in PROMPT-ARCH-02) — the ONE
 * canonical inbound path that turns an incoming WhatsApp-style customer
 * message into a safe assistant response:
 *
 *   inbound message → resolve business (by receiving WhatsApp number)
 *   → claim the external message key (DURABLE idempotency, before any
 *   irreversible processing) → find-or-create customer (`upsertByPhone`)
 *   → find-or-create conversation (Branch-aware) → persist the CUSTOMER
 *   message (the claim's message ids recorded in the SAME transaction)
 *   → load the conversation's minimal business context → typed AI turn
 *   (deterministic turns may BYPASS the assistant entirely) → safe
 *   reply OR NEED_HUMAN → persist the assistant reply → deliver through
 *   the transport boundary → best-effort usage telemetry.
 *
 * Product rules encoded here:
 * - The payload NEVER controls authority: no `businessId`, role,
 *   customer/conversation ids, assignment, or tenant identity can enter
 *   through the inbound contract — the Business is resolved server-side
 *   from the receiving WhatsApp number via the established
 *   `BusinessRepository.findByWhatsappNumber` mapping.
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
 *   before persistence, and booking intents hand off to staff, who
 *   complete bookings through the EXISTING canonical booking flow. The
 *   engine never creates appointments.
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
import type { ConversationAi } from "@/features/conversations/server/conversation-ai";
import { bypassDeterministicAi } from "@/features/conversations/server/conversation-ai";
import type { MessageTransport } from "@/features/conversations/server/conversation-transport";
import { offlineMessageTransport } from "@/features/conversations/server/conversation-transport";
import { faqEntrySchema } from "@/lib/validation";
import type { RecordUsageDto } from "@/lib/validation";
import { createPolicyBackedAi } from "@/server/integrations/ai/factory";
import type { AiTelemetry } from "@/server/integrations/ai/types";
import type {
  BranchRepository,
  BusinessRepository,
  ConversationRepository,
  CustomerRepository,
  InboundDedupeRepository,
  ServiceRepository,
  UsageRepository,
} from "@/server/repositories";
import {
  branchRepository,
  businessRepository,
  conversationRepository,
  customerRepository,
  inboundDedupeRepository,
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
  businessRepository: Pick<BusinessRepository, "findByWhatsappNumber">;
  branchRepository: Pick<BranchRepository, "findDefaultByBusiness">;
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
  serviceRepository: Pick<ServiceRepository, "listByBusiness">;
  inboundDedupeRepository: Pick<InboundDedupeRepository, "claim">;
  usageRepository: Pick<UsageRepository, "record">;
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
  ai: policyBackedAi,
  transport: offlineMessageTransport,
};

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

  // 1. Resolve the Business from the receiving WhatsApp number — the
  //    established inbound transport mapping. NEVER client-controlled.
  const business = await deps.businessRepository.findByWhatsappNumber(
    canonicalPhone(inbound.to),
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

    // 7. Build the MINIMAL AI context (DECISIONS #33): the current
    //    message, compact conversation state, and only the
    //    task-relevant facts — never the complete business context.
    //    (providerPreference / availability blocks stay unset until
    //    those flows exist.)
    const [recent, services] = await Promise.all([
      deps.conversationRepository.getMessages(conversation.id, {
        pageSize: AI_RECENT_MESSAGE_LIMIT,
      }),
      deps.serviceRepository.listByBusiness(business.id),
    ]);
    const aiRequest: AiRequest = {
      message: inbound.text,
      conversationStatus: conversation.status,
      recentMessages: [...recent].reverse().map((message) => ({
        senderType: message.senderType,
        content: message.content,
      })),
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
        businessName: business.name,
        conversationId: conversation.id,
        content,
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
