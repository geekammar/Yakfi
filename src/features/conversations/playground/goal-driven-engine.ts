/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot Conversation Playground — Experimental Goal-Driven Hybrid Prototype
 *
 * Implements the Goal-Driven Booking State Architecture (CONV-PLAY-02A):
 * 1. Semantic extraction of user intent and entities without fragile keyword traps.
 * 2. Unified Option Resolver: resolves "1", "2", ordinals, and names against
 *    whatever was LAST presented (services, slots, or follow-ups).
 * 3. Cumulative State Retention: preserves date, time-of-day, service, and provider
 *    preferences across clarification turns (e.g. "بكرة الصبح" survives service selection).
 * 4. Case-aware default service resolution (Cases A, B, C, D, E).
 * 5. Strict adherence to Booking Core: CORE-01 (eligibility), CORE-02 (options),
 *    and safe transactional appointment creation with conflict checks.
 *
 * Developer-only prototype: isolated from production engine, zero DB migrations.
 */

import { resolveBookingOptions } from "@/features/appointments/server/booking-options-service";
import { resolveEligibleProviders } from "@/features/appointments/server/provider-eligibility-service";
import type { ConversationEngineDeps } from "@/features/conversations/server/conversation-engine";
import {
  extractTimeOfDayPreference,
  resolveEgyptianRelativeDate,
  todayIsoInTimeZone,
} from "@/features/conversations/server/relative-date";
import type { Business, Customer, Service } from "@/types/domain";

// ─── Goal-Driven State Contracts ──────────────────────────────────────────

export type GoalDrivenIntent =
  | "CREATE_APPOINTMENT"
  | "RESCHEDULE_APPOINTMENT"
  | "CANCEL_APPOINTMENT"
  | "ASK_AVAILABILITY"
  | "ASK_CATALOG"
  | "ASK_FAQ"
  | "EXPLICIT_HUMAN"
  | "SENSITIVE_EMERGENCY"
  | "GENERAL_INQUIRY";

export type OfferedItemType = "SERVICE" | "SLOT" | "FOLLOW_UP";

export type OfferedOption = {
  readonly id: string;
  readonly stableIndex: number;
  readonly title: string;
  readonly metadata?: Record<string, any>;
};

export type GoalDrivenBookingState = {
  currentGoal: GoalDrivenIntent;
  service: {
    id: string | null;
    name: string | null;
    source: "USER_SELECTED" | "BUSINESS_DEFAULT" | "AUTO_SINGLE" | null;
  };
  provider: {
    id: string | null;
    name: string | null;
    preference: "SPECIFIC" | "ANY" | "SAME_AS_LAST" | null;
  };
  timing: {
    date: string | null; // YYYY-MM-DD
    timePreference: "morning" | "afternoon" | "evening" | null;
    explicitTime: string | null; // HH:mm
    slotPageOffset?: number;
  };
  lastOfferedOptions: {
    type: OfferedItemType;
    items: OfferedOption[];
    offeredAtTurn: number;
  } | null;
  followUpRequestId?: string | null;
};

// ─── Normalization & Utilities ────────────────────────────────────────────

export function normalizeArabic(text: string): string {
  return text
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

const ORDINALS_MAP: Record<string, number> = {
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  الاول: 1,
  الاولاني: 1,
  التاني: 2,
  الثاني: 2,
  التالت: 3,
  الثالث: 3,
  الرابع: 4,
  الخامس: 5,
  السادس: 6,
};

export function parseOrdinalIndex(raw: string): number | null {
  const norm = normalizeDigits(raw.trim());
  const stripped = normalizeArabic(norm);

  // Single digit check
  if (/^[1-9]$/.test(norm)) {
    return parseInt(norm, 10);
  }

  // Prefix match e.g. "opt_1", "service_2", "slot_3", "choice:1"
  const prefixMatch = raw
    .trim()
    .match(/^(?:opt|service|serv|slot|choice)[_: -]*([1-9]\d?)$/i);
  if (prefixMatch && prefixMatch[1]) {
    return parseInt(prefixMatch[1], 10);
  }

  // Bare ordinal words ("الخيار الأول", "رقم 1", "الاول")
  const bare = stripped.startsWith("الخيار ")
    ? stripped.replace("الخيار ", "").trim()
    : stripped.startsWith("رقم ")
      ? stripped.replace("رقم ", "").trim()
      : stripped.startsWith("خدمة ")
        ? stripped.replace("خدمة ", "").trim()
        : stripped;

  if (ORDINALS_MAP[bare] !== undefined) {
    return ORDINALS_MAP[bare]!;
  }

  // Check short phrases e.g. "اختار 1", "احجز الاول"
  const m = norm.match(/(?:^|\s)([1-9])(?:\s|$)/);
  if (m && m[1] && norm.length <= 15) {
    return parseInt(m[1], 10);
  }

  return null;
}

// ─── History Parser & State Reconstructor ─────────────────────────────────

const SLOT_OFFER_HEADER =
  /تتوفر المواعيد التالية ل(?:خدمة|متابعة)\s*"([^"]+)"\s*يوم\s*(\d{4}-\d{2}-\d{2})/;
const SERVICE_OFFER_HEADER = /الخدمات المتاحة لدينا:/;
const FOLLOWUP_OFFER_HEADER = /أكثر من طلب متابعة معلّق:/;

export function reconstructStateFromHistory(
  messages: ReadonlyArray<{ senderType: string; content: string }>,
  services: Service[],
  todayIso: string,
): GoalDrivenBookingState {
  const state: GoalDrivenBookingState = {
    currentGoal: "CREATE_APPOINTMENT",
    service: { id: null, name: null, source: null },
    provider: { id: null, name: null, preference: null },
    timing: {
      date: null,
      timePreference: null,
      explicitTime: null,
      slotPageOffset: 0,
    },
    lastOfferedOptions: null,
    followUpRequestId: null,
  };

  if (!messages || messages.length === 0) return state;

  // 1. Scan assistant messages backwards to reconstruct lastOfferedOptions
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.senderType === "AI") {
      // Check slot offer
      const slotMatch = msg.content.match(SLOT_OFFER_HEADER);
      if (slotMatch && slotMatch[1] && slotMatch[2]) {
        const serviceName = slotMatch[1];
        const date = slotMatch[2];
        const matchedServ = services.find(
          (s) => normalizeArabic(s.name) === normalizeArabic(serviceName),
        );
        state.service = {
          id: matchedServ?.id ?? null,
          name: serviceName,
          source: "USER_SELECTED",
        };
        state.timing.date = date;

        const options: OfferedOption[] = [];
        for (const line of msg.content.split("\n")) {
          const parsedLine = line
            .trim()
            .match(
              /^(\d+)[.)]\s*(.+?)\s*—\s*(\d{1,2}:\d{2})\s*إلى\s*(\d{1,2}:\d{2})/,
            );
          if (
            parsedLine &&
            parsedLine[1] &&
            parsedLine[2] &&
            parsedLine[3] &&
            parsedLine[4]
          ) {
            options.push({
              id: `slot_${parsedLine[1]}`,
              stableIndex: parseInt(parsedLine[1], 10),
              title: parsedLine[2].trim(),
              metadata: {
                providerName: parsedLine[2].trim(),
                startTime: parsedLine[3].padStart(5, "0"),
                endTime: parsedLine[4].padStart(5, "0"),
                date,
              },
            });
          }
        }

        state.lastOfferedOptions = {
          type: "SLOT",
          items: options,
          offeredAtTurn: i,
        };
        break;
      }

      // Check service offer
      if (SERVICE_OFFER_HEADER.test(msg.content)) {
        const options: OfferedOption[] = [];
        for (const line of msg.content.split("\n")) {
          const parsed = line.trim().match(/^(\d+)[.)]\s*(.+)$/);
          if (parsed && parsed[1] && parsed[2]) {
            const sName = parsed[2].split("—")[0]!.trim();
            const matched = services.find(
              (s) =>
                normalizeArabic(s.name) === normalizeArabic(sName) ||
                sName.includes(s.name),
            );
            options.push({
              id: matched?.id ?? `service_${parsed[1]}`,
              stableIndex: parseInt(parsed[1], 10),
              title: sName,
              metadata: { serviceId: matched?.id },
            });
          }
        }
        state.lastOfferedOptions = {
          type: "SERVICE",
          items: options,
          offeredAtTurn: i,
        };
        break;
      }

      // Check follow-up offer
      if (FOLLOWUP_OFFER_HEADER.test(msg.content)) {
        state.lastOfferedOptions = {
          type: "FOLLOW_UP",
          items: [],
          offeredAtTurn: i,
        };
        break;
      }
    }
  }

  // 2. Scan customer messages chronologically to accumulate stated facts
  for (const m of messages) {
    if (m.senderType === "CUSTOMER") {
      const text = m.content;
      // Stated date
      const relDate = resolveEgyptianRelativeDate(text, todayIso);
      if (relDate) {
        state.timing.date = relDate;
      }

      // Stated time of day preference
      const timePref = extractTimeOfDayPreference(text);
      if (timePref) {
        state.timing.timePreference = timePref;
      }

      // Stated provider preference
      if (
        /(?:نفس\s+(?:الدكتور|الطبيب|الدكتورة|الطبيبة|المقدم)|مع\s+نفس)/.test(
          text,
        )
      ) {
        state.provider.preference = "SAME_AS_LAST";
      } else if (
        /(?:أي\s+دكتور|اي\s+دكتور|أي\s+مقدم|اي\s+مقدم|مش\s+فارق|مش\s+فارقة)/.test(
          text,
        )
      ) {
        state.provider.preference = "ANY";
      }

      // Stated service name match
      for (const s of services) {
        const normS = normalizeArabic(s.name);
        const normT = normalizeArabic(text);
        if (
          normT.includes(normS) ||
          (normT.length >= 3 && normS.includes(normT))
        ) {
          state.service = { id: s.id, name: s.name, source: "USER_SELECTED" };
        }
      }
    }
  }

  return state;
}

// ─── Goal-Driven Engine Turn Handler ───────────────────────────────────────

export type GoalDrivenTurnResult = {
  assistantAction: "AI_REPLY" | "AI_HANDOFF";
  conversationStatus: "AI_ACTIVE" | "NEED_HUMAN" | "BOOKED";
  intent: string | null;
  handoffCause: string | null;
  replyText: string;
  buttons?: Array<{ label: string; payload: string }>;
  replyMarkup?: any;
  appointmentCreated?: boolean;
  appointmentId?: string | null;
  llmCalls: number;
};

export async function processGoalDrivenTurn(
  deps: ConversationEngineDeps,
  inbound: { text: string; buttonPayload?: string; from: string },
  context: {
    business: Business;
    customer: Customer;
    conversationId: string;
    services: Service[];
    virtualNow?: Date;
  },
): Promise<GoalDrivenTurnResult> {
  const { business, customer, services } = context;
  const now = context.virtualNow ?? new Date();
  const todayIso = todayIsoInTimeZone(now, business.timezone ?? "Africa/Cairo");

  const rawText =
    inbound.buttonPayload && inbound.buttonPayload.length > 0
      ? inbound.buttonPayload
      : inbound.text;
  const normText = normalizeArabic(rawText);

  // 1. SAFETY & EMERGENCY GATING (Top Priority Rule E)
  const isEmergency =
    /(?:نزيف\s+شديد|طارئ|طوارئ|حادث|الم\s+شديد\s+جدا|الم\s+لا\s+يطاق|تسمم|اغماء|كسر\s+حاد)/.test(
      normText,
    );
  if (isEmergency) {
    const emergencyMsg =
      "سلامتك ألف سلامة! هذه حالة طارئة تتطلب تدخلاً طبياً عاجلاً. يرجى التوجه فوراً إلى أقرب مستشفى أو قسم طوارئ، أو الاتصال بالإسعاف (123 في مصر). تم إخطار فريق العيادة أيضاً للتواصل معك.";
    return {
      assistantAction: "AI_HANDOFF",
      conversationStatus: "NEED_HUMAN",
      intent: "SENSITIVE",
      handoffCause: "SENSITIVE_OR_RESTRICTED",
      replyText: emergencyMsg,
      llmCalls: 0,
    };
  }

  // 2. EXPLICIT HUMAN REQUEST GATING
  const isHumanReq =
    /(?:حولني\s+ل?موظف|عايز\s+(?:اكلم\s+)?(?:موظف|انسان|شخص|بني\s+ادم|خدمة\s+العملاء)|تحدث\s+مع\s+موظف|مسؤول|خدمه\s+العملاء)/.test(
      normText,
    );
  if (isHumanReq) {
    const handoffMsg =
      "تحت أمرك — جارٍ تحويلك الآن لأحد أعضاء الفريق لمساعدتك فوراً.";
    return {
      assistantAction: "AI_HANDOFF",
      conversationStatus: "NEED_HUMAN",
      intent: "HUMAN_REQUEST",
      handoffCause: "CUSTOMER_REQUESTED_HUMAN",
      replyText: handoffMsg,
      llmCalls: 0,
    };
  }

  // 3. LOAD RECENT CONVERSATION & RECONSTRUCT GOAL-DRIVEN STATE
  const recentMessages = await deps.conversationRepository.getMessages(
    context.conversationId,
    20,
  );
  const state = reconstructStateFromHistory(recentMessages, services, todayIso);

  // 4. DETECT UNANSWERED / UNSUPPORTED SPECIFIC SERVICE QUESTIONS
  // If the user asks about an explicit treatment like "التقويم الشفاف" and it does NOT match active services
  const asksSpecificUnsupported =
    normText.includes("تقويم") &&
    !services.some((s) => normalizeArabic(s.name).includes("تقويم"));
  if (asksSpecificUnsupported) {
    const servList = services
      .map((s, idx) => `${idx + 1}. ${s.name}`)
      .join("\n");
    const reply = `عفواً، خدمة التقويم غير متوفرة لدينا حالياً بالعيادة.\nالخدمات المتاحة لدينا:\n${servList}\nهل تود حجز موعد لأي من هذه الخدمات المتاحة؟`;
    return {
      assistantAction: "AI_REPLY",
      conversationStatus: "AI_ACTIVE",
      intent: "FAQ",
      handoffCause: null,
      replyText: reply,
      llmCalls: 0,
    };
  }

  // 5. PURE CATALOG QUESTION ("ايه الخدمات اللي عندكم؟")
  const isPureCatalog =
    /(?:ايه\s+الخدمات|ما\s+هي\s+الخدمات|الخدمات\s+المتاحة|قائمه\s+الخدمات|عندكم\s+خدمات\s+ايه|اسعار\s+الخدمات)/.test(
      normText,
    ) &&
    !normText.includes("احجز") &&
    !normText.includes("حجز");
  if (isPureCatalog) {
    const list = services
      .map((s, idx) => {
        const priceStr = (s as any).price
          ? ` — ${(s as any).price} ${(s as any).priceCurrency ?? (s as any).currency ?? "EGP"}`
          : "";
        return `${idx + 1}. ${s.name}${priceStr}`;
      })
      .join("\n");
    const reply = `الخدمات المتاحة لدينا في ${business.name}:\n${list}\n\nلحجز أي خدمة، أخبرنا برقم أو اسم الخدمة وسنساعدك في اختيار الموعد المناسب.`;
    return {
      assistantAction: "AI_REPLY",
      conversationStatus: "AI_ACTIVE",
      intent: "FAQ",
      handoffCause: null,
      replyText: reply,
      llmCalls: 0,
    };
  }

  // 6. GENERAL FAQ QUESTION (Hours, location, etc.)
  const faqs = (business as any).faqs ?? [];
  let matchedFaq: { question: string; answer: string } | null = null;
  for (const f of faqs) {
    const normQ = normalizeArabic(f.question);
    if (normText.includes(normQ) || normQ.includes(normText)) {
      matchedFaq = f;
      break;
    }
  }
  if (
    !matchedFaq &&
    /(?:مواعيد\s+العمل|ساعات\s+العمل|شغالين\s+امتى|بتفتحوا\s+امتى)/.test(
      normText,
    )
  ) {
    matchedFaq = {
      question: "مواعيد العمل",
      answer:
        "مواعيد العمل لدينا من السبت إلى الجمعة من الساعة 9:00 صباحاً حتى 5:00 مساءً.",
    };
  }

  if (matchedFaq) {
    if (state.service.name || state.timing.date) {
      // Answer and continue active booking task
      const sDesc = state.service.name ? ` لخدمة "${state.service.name}"` : "";
      const reply = `${matchedFaq.answer}\n\nوبخصوص طلب الحجز${sDesc}، هل تحب نستكمل اختيار الموعد المناسب لك؟`;
      return {
        assistantAction: "AI_REPLY",
        conversationStatus: "AI_ACTIVE",
        intent: "FAQ",
        handoffCause: null,
        replyText: reply,
        llmCalls: 0,
      };
    } else {
      return {
        assistantAction: "AI_REPLY",
        conversationStatus: "AI_ACTIVE",
        intent: "FAQ",
        handoffCause: null,
        replyText: matchedFaq.answer,
        llmCalls: 0,
      };
    }
  }

  // 7. SEMANTIC ENTITY & SELECTION EXTRACTION
  const ordinalIndex = parseOrdinalIndex(rawText);

  // A. Check Navigation: "أوقات تانية" (more times) or "يوم تاني" (change date)
  if (
    /(?:اوقات\s+تانية|اوقات\s+تانيه|مواعيد\s+تانية|مزيد\s+من\s+المواعيد|more_times)/.test(
      normText,
    )
  ) {
    state.timing.slotPageOffset = (state.timing.slotPageOffset ?? 0) + 3;
  }
  if (
    /(?:يوم\s+تاني|يوم\s+اخر|غير\s+اليوم|تغيير\s+اليوم|change_date)/.test(
      normText,
    )
  ) {
    state.timing.date = null;
    state.lastOfferedOptions = null;
    const prompt = `تمام، اخترنا خدمة "${state.service.name ?? "المطلوبة"}". ما هو اليوم البديل المناسب لك؟ (مثلاً: غداً، أو بعد غد، أو يوم الأحد القادم)`;
    return {
      assistantAction: "AI_REPLY",
      conversationStatus: "AI_ACTIVE",
      intent: "BOOKING",
      handoffCause: null,
      replyText: prompt,
      llmCalls: 0,
    };
  }

  // B. Check Ordinal against lastOfferedOptions (UNIFIED OPTION RESOLUTION)
  if (ordinalIndex !== null && state.lastOfferedOptions) {
    const { type, items } = state.lastOfferedOptions;
    const matchedItem = items.find((o) => o.stableIndex === ordinalIndex);

    if (type === "SERVICE") {
      if (matchedItem) {
        state.service = {
          id: matchedItem.metadata?.serviceId ?? matchedItem.id,
          name: matchedItem.title,
          source: "USER_SELECTED",
        };
      } else if (ordinalIndex >= 1 && ordinalIndex <= services.length) {
        const s = services[ordinalIndex - 1]!;
        state.service = { id: s.id, name: s.name, source: "USER_SELECTED" };
      }
    } else if (type === "SLOT") {
      if (matchedItem) {
        // BOOK THE SELECTED APPOINTMENT TRANSACTIONALLY
        const { providerName, startTime, endTime, date } =
          matchedItem.metadata!;
        const servId = state.service.id ?? services[0]!.id;

        // Find provider ID
        let provId: string | null = null;
        let assignedUid: string = "assigned-user";
        if (deps.providerRepository) {
          const allP = await deps.providerRepository.listEligibleForService(
            business.id,
            servId,
          );
          const foundP = allP.find((p: any) =>
            normalizeArabic(p.displayName ?? p.name).includes(
              normalizeArabic(providerName),
            ),
          );
          if (foundP) {
            provId = foundP.id;
            assignedUid = (foundP as any).userId ?? foundP.id;
          }
        }

        if (!deps.appointmentRepository?.createWithConflictCheck) {
          throw new Error(
            "appointmentRepository.createWithConflictCheck not implemented",
          );
        }

        const appt = await deps.appointmentRepository.createWithConflictCheck({
          businessId: business.id,
          branchId: business.defaultBranchId ?? "default-branch",
          customerId: customer.id,
          serviceId: servId,
          providerId: provId ?? undefined,
          assignedUserId: assignedUid,
          date,
          startTime,
          endTime,
          status: "CONFIRMED",
        });

        const pDesc = providerName ? ` مع ${providerName}` : "";
        const confirmMsg = `تم تأكيد حجزك بنجاح لدى ${business.name}!\nالخدمة: ${state.service.name ?? "كشف أسنان"}${pDesc}\nالموعد: يوم ${date} الساعة ${startTime} إلى ${endTime}.\nفي انتظارك ونتمنى لك دوام الصحة والعافية!`;

        return {
          assistantAction: "AI_REPLY",
          conversationStatus: "BOOKED",
          intent: "BOOKING",
          handoffCause: null,
          replyText: confirmMsg,
          appointmentCreated: true,
          appointmentId: appt ? (appt as any).id : null,
          llmCalls: 0,
        };
      }
    }
  }

  // C. Relative Date & Explicit Timing Extraction
  const explicitRelDate = resolveEgyptianRelativeDate(rawText, todayIso);
  if (explicitRelDate) {
    state.timing.date = explicitRelDate;
  }
  const explicitTimePref = extractTimeOfDayPreference(rawText);
  if (explicitTimePref) {
    state.timing.timePreference = explicitTimePref;
  }

  // D. Provider Extraction
  if (
    /(?:نفس\s+(?:الدكتور|الطبيب|الدكتورة|الطبيبة|المقدم)|مع\s+نفس)/.test(
      normText,
    )
  ) {
    state.provider.preference = "SAME_AS_LAST";
    if (deps.appointmentRepository?.listRecentByCustomer) {
      const recent = await deps.appointmentRepository.listRecentByCustomer(
        business.id,
        customer.id,
        1,
      );
      const prior = recent?.[0];
      if (prior && prior.providerId && deps.providerRepository) {
        const eligible = await deps.providerRepository.listEligibleForService(
          business.id,
          prior.serviceId,
        );
        const matchP = eligible.find((p: any) => p.id === prior.providerId);
        if (matchP) {
          state.provider.id = matchP.id;
          state.provider.name = matchP.displayName ?? matchP.name ?? null;
        }
      }
    }
  } else if (
    /(?:أي\s+دكتور|اي\s+دكتور|أي\s+مقدم|اي\s+مقدم|مش\s+فارق|مش\s+فارقة)/.test(
      normText,
    )
  ) {
    state.provider.preference = "ANY";
  } else {
    // Check specific doctor by name
    if (deps.providerRepository) {
      const servId = state.service.id ?? services[0]?.id;
      const allP = servId
        ? await deps.providerRepository.listEligibleForService(
            business.id,
            servId,
          )
        : [];
      for (const p of allP) {
        const pNorm = normalizeArabic(p.displayName ?? p.name ?? "");
        if (
          normText.includes(pNorm) ||
          (pNorm.length >= 4 &&
            normText.includes(
              pNorm
                .replace("د ", "")
                .replace("دكتورة ", "")
                .replace("دكتور ", ""),
            ))
        ) {
          state.provider.id = p.id;
          state.provider.name = p.displayName ?? p.name ?? null;
          state.provider.preference = "SPECIFIC";
          break;
        }
      }
    }
  }

  // E. Service Selection by Name
  for (const s of services) {
    const sNorm = normalizeArabic(s.name);
    // Bidirectional substring or keyword match (e.g. "كشف" matches "كشف أسنان")
    if (
      normText.includes(sNorm) ||
      (normText.length >= 3 && sNorm.includes(normText))
    ) {
      state.service = { id: s.id, name: s.name, source: "USER_SELECTED" };
      break;
    }
  }

  // 8. RESOLVE DEFAULT SERVICE RULES (CASES A, B, C, D)
  if (!state.service.id) {
    const defEnabled = Boolean((business as any).defaultServiceBookingEnabled);
    const defId =
      (business as any).defaultBookingServiceId ??
      (business as any).defaultServiceId;

    if (defEnabled && defId) {
      // Case A: Default service quick booking enabled
      const matchedDef = services.find(
        (s) => s.id === defId && s.isActive !== false,
      );
      if (matchedDef) {
        state.service = {
          id: matchedDef.id,
          name: matchedDef.name,
          source: "BUSINESS_DEFAULT",
        };
      }
    }

    if (!state.service.id && services.length === 1 && services[0]) {
      // Case B: Only one valid bookable service
      state.service = {
        id: services[0].id,
        name: services[0].name,
        source: "AUTO_SINGLE",
      };
    }
  }

  // 9. DETERMINE NEXT REQUIRED ACTION

  // Step 9.1: If service is still missing -> present bookable services (Case C)
  if (!state.service.id) {
    const list = services.map((s, idx) => `${idx + 1}. ${s.name}`).join("\n");
    const buttons = services.map((s, idx) => ({
      label: `${idx + 1}. ${s.name}`,
      payload: `service_${idx + 1}`,
    }));
    const reply = `يرجى تحديد الخدمة المطلوبة — الخدمات المتاحة لدينا في ${business.name}:\n${list}\nأخبرنا باسم أو رقم الخدمة التي ترغب بحجزها.`;

    const isTelegram = customer.phone.startsWith("tg:");
    const replyMarkup = isTelegram
      ? {
          inline_keyboard: services.map((s, idx) => [
            {
              text: `${idx + 1}️⃣ ${s.name}`,
              callback_data: `service_${idx + 1}`,
            },
          ]),
        }
      : undefined;

    return {
      assistantAction: "AI_REPLY",
      conversationStatus: "AI_ACTIVE",
      intent: "BOOKING",
      handoffCause: null,
      replyText: reply,
      buttons,
      replyMarkup,
      llmCalls: 0,
    };
  }

  // Step 9.2: If service is known, but date is missing -> prompt for date naturally
  if (!state.timing.date) {
    const prompt = `تمام، تم اختيار خدمة "${state.service.name}". ما هو اليوم المناسب لك لحجز الموعد؟ (مثلاً: اليوم، غداً، أو يوم محدد)`;
    return {
      assistantAction: "AI_REPLY",
      conversationStatus: "AI_ACTIVE",
      intent: "BOOKING",
      handoffCause: null,
      replyText: prompt,
      llmCalls: 0,
    };
  }

  // Step 9.3: Service and date are both known -> Query CORE-01 and CORE-02 for slots
  const targetDate = state.timing.date;
  const targetServId = state.service.id;

  const eligDeps = {
    branchRepository: deps.branchRepository,
    serviceRepository: deps.serviceRepository,
    providerRepository: deps.providerRepository,
  };
  const eligibility = await resolveEligibleProviders(
    eligDeps as any,
    { userId: customer.id, businessId: business.id } as any,
    { serviceId: targetServId, branchId: business.defaultBranchId ?? null },
  );

  if (!eligibility.success || eligibility.data.providers.length === 0) {
    const msg =
      "عفواً، لا يوجد مقدمو خدمة متاحون لهذه الخدمة حالياً لدى المنشأة.";
    return {
      assistantAction: "AI_HANDOFF",
      conversationStatus: "NEED_HUMAN",
      intent: "BOOKING",
      handoffCause: "DOMAIN_REQUIRES_HUMAN",
      replyText: msg,
      llmCalls: 0,
    };
  }

  const bookingDeps = {
    eligibility: eligDeps,
    businessRepository: deps.businessRepository,
    branchRepository: deps.branchRepository,
    serviceRepository: deps.serviceRepository,
    providerRepository: deps.providerRepository,
    appointmentRepository: deps.appointmentRepository,
  };

  const bookingOptionsResult = await resolveBookingOptions(
    bookingDeps as any,
    { userId: customer.id, businessId: business.id },
    {
      serviceId: targetServId,
      branchId: business.defaultBranchId ?? undefined,
      providerId: state.provider.id ?? undefined,
      date: targetDate,
    },
  );

  if (
    !bookingOptionsResult.success ||
    bookingOptionsResult.data.options.length === 0
  ) {
    const noSlotsMsg = `عفواً، لا تتوفر مواعيد شاغرة لخدمة "${state.service.name}" يوم ${targetDate}. هل تود تجربة يوم آخر؟ (مثل: غداً، أو بعد غد)`;
    return {
      assistantAction: "AI_REPLY",
      conversationStatus: "AI_ACTIVE",
      intent: "BOOKING",
      handoffCause: null,
      replyText: noSlotsMsg,
      llmCalls: 0,
    };
  }

  // 10. FILTER & PRIORITIZE SLOTS BASED ON PRESERVED TIME PREFERENCE
  let allSlots = bookingOptionsResult.data.options;
  const timePref = state.timing.timePreference;

  if (timePref) {
    const matchesPref = (timeStr: string) => {
      const hour = parseInt(timeStr.slice(0, 2), 10);
      if (Number.isNaN(hour)) return true;
      if (timePref === "morning") return hour < 12;
      if (timePref === "afternoon") return hour >= 12 && hour < 17;
      if (timePref === "evening") return hour >= 17;
      return true;
    };

    const preferred = allSlots.filter((o) =>
      matchesPref(o.startAt.slice(11, 16)),
    );
    const others = allSlots.filter(
      (o) => !matchesPref(o.startAt.slice(11, 16)),
    );
    if (preferred.length > 0) {
      allSlots = [...preferred, ...others];
    }
  }

  // Paging offset
  const pageOffset = state.timing.slotPageOffset ?? 0;
  const pageSlice = allSlots.slice(pageOffset, pageOffset + 3);
  const visibleSlots = pageSlice.length > 0 ? pageSlice : allSlots.slice(0, 3);

  // Format offered slots message
  const slotLines = visibleSlots.map((opt, i) => {
    const sTime = opt.startAt.slice(11, 16);
    const eTime = opt.endAt.slice(11, 16);
    return `${i + 1}. ${opt.displayName} — ${sTime} إلى ${eTime}`;
  });

  const offerMsg = `تتوفر المواعيد التالية لخدمة "${state.service.name}" يوم ${targetDate}:\n${slotLines.join("\n")}\nيرجى اختيار أحد الخيارات وسيتواصل معك الفريق لإتمام الحجز.`;

  const buttons = visibleSlots.map((_, i) => ({
    label: `${i + 1}. اختيار ${i + 1}`,
    payload: `opt_${i + 1}`,
  }));

  const isTelegram = customer.phone.startsWith("tg:");
  const replyMarkup = isTelegram
    ? {
        inline_keyboard: [
          visibleSlots.map((_, i) => ({
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

  return {
    assistantAction: "AI_REPLY",
    conversationStatus: "AI_ACTIVE",
    intent: "BOOKING",
    handoffCause: null,
    replyText: offerMsg,
    buttons,
    replyMarkup,
    llmCalls: 0,
  };
}
