/**
 * Conversation Copy Registry — the CANONICAL registry (UX-LAB-01A, Slice 1).
 *
 * One code-only source of truth for every deterministic CUSTOMER-FACING copy
 * item the conversation engine emits (DISC-UX-01 inventory, re-verified
 * against `main` v0.43.4). Slice 1 is PASSIVE: production code keeps using its
 * own constants / functions / inline strings — nothing here is imported at
 * runtime. The registry only becomes the Founder Conversation Lab's
 * metadata / default source in a later slice.
 *
 * Preservation contract (binding for this slice):
 *  - `defaultText` is the CURRENT production wording, byte-for-byte. Wording
 *    improvements are a later task (BOOK-UX-01); this registry deliberately
 *    ships the exact present-day text, awkward phrasing included.
 *  - EDITABLE_TEMPLATE `defaultText` carries `{placeholder}` tokens from the
 *    closed PLACEHOLDER_VALUES set only.
 *  - PROTECTED_COPY (the handoff / safety acknowledgments) is registered so
 *    the Lab can SEE it, but stays non-editable — its «سيتواصل معك أحد أعضاء
 *    الفريق» follow-up promise is a safety contract.
 *  - Parser / state markers (OFFER_HEADER, OFFER_LINE, the pending-clarification
 *    and pending-continuation recognition phrases) are NOT registry entries;
 *    they are listed in NOT_COPY_EXCLUSIONS, and the ones embedded in editable
 *    text are tracked as `markers` so a future rewording cannot silently break
 *    the deterministic history-derived state.
 */
import type {
  CopyCategory,
  CopyClassification,
  CopyRegistryEntry,
  PlaceholderName,
} from "@/features/conversation-copy/types";

// ─── Source locations (repo-relative) ────────────────────────────────────────

const AI = "src/features/conversations/server/conversation-ai.ts";
const CLARIFY = "src/features/conversations/server/clarification.ts";
const MAPPER = "src/features/conversations/server/booking-mapper.ts";
const ENGINE = "src/features/conversations/server/conversation-engine.ts";
const FORMATTERS =
  "src/features/conversations/server/presentation-formatters.ts";
const TELEGRAM_WEBHOOK =
  "src/server/integrations/telegram/telegram-webhook-handler.ts";

// ─── NOT_COPY — parser/state contracts (deliberately NOT registry entries) ─

/**
 * Deterministic strings the whole-codebase scan (UX-LAB-01A2) classified
 * NOT_COPY. Two shapes live here:
 *
 *  1. Parser/state markers — machine contracts, not customer copy (the five
 *     original Slice-1 entries). They are tracked as `markers` on the
 *     editable bearing editable entries instead.
 *  2. Deterministic-but-not-customer copy found outside the conversation
 *     engine in this task (the Conversation Control handoff seam, the
 *     Telegram MANAGER bot, channel webhook/transport API errors). Each is
 *     documented with the reason it cannot reach a customer today.
 *
 * This list is the authoritative exclusion set the offline check
 * (`pnpm check:copy-lab`, section H) guards.
 */
export const NOT_COPY_EXCLUSIONS = [
  {
    id: "OFFER_HEADER",
    location: `${ENGINE} (booking-selection import path)`,
    note: "The booking-selection parser's offer-header regex. A presented offer is recognized by this header; it is tracked as a MARKER on `booking.offer`, never exposed as editable copy.",
  },
  {
    id: "OFFER_LINE",
    location: `${ENGINE} (booking-selection import path)`,
    note: "The booking-selection parser's per-option line format («N. name — start إلى end»). It is the offer's line contract, not customer copy, so `booking.offer` exposes only the header/footer plus the `{offer}` placeholder.",
  },
  {
    id: "PENDING_CLARIFY_SERVICE_PHRASE",
    location: `${CLARIFY} derivePendingClarification`,
    note: "The recognition phrase for a pending CLARIFY_SERVICE. Tracked as a MARKER on `clarify.service` / `clarify.service_ambiguous` / `clarify.service_ambiguous_offer`, not an editable key.",
  },
  {
    id: "PENDING_CLARIFY_DATE_PHRASE",
    location: `${CLARIFY} derivePendingClarification`,
    note: "The recognition phrase for a pending CLARIFY_DATE. Tracked as a MARKER on `clarify.date`, not an editable key.",
  },
  {
    id: "PENDING_CONTINUATION_LINE",
    location: `${CLARIFY} derivePendingContinuation`,
    note: "The whole `continue.invite` line is the migration-safe pending-BOOKING marker. Tracked as a MARKER on `continue.invite`, not a separate editable key.",
  },
  {
    id: "HANDOFF_POLICY_MESSAGES",
    location:
      "src/server/integrations/ai/conversation-control/handoff-policy.ts HANDOFF_MESSAGES",
    note: "The Conversation Control layer's per-reason handoff text (8 reasons). Deterministic and safety-shaped, but NOT a current customer delivery path: the engine's handoff branches send `classifyCustomerMessage(...).content` (the `REPLIES.*` canonical keys) instead, and the control outcome's `handoffMessage` is consumed only by telemetry + offline scripts. Three entries already exist as canonical wording — CUSTOMER_REQUESTED_HUMAN = `handoff.human_request`, UNSUPPORTED_REQUEST = `handoff.ambiguous`, SENSITIVE_OR_RESTRICTED_REQUEST = `handoff.sensitive` — so no duplicate key was created. The other five (AI_REQUESTED_HANDOFF, RETRY_EXHAUSTED, PROVIDER_UNAVAILABLE, QUOTA_EXHAUSTED, AUTH_OR_CONFIGURATION_FAILURE) are genuinely distinct but currently reach no customer; they stay out until a runtime seam delivers them (a later slice, reported then).",
  },
  {
    id: "TELEGRAM_MANAGER_COPY",
    location:
      "src/server/integrations/telegram/telegram-manager-webhook-handler.ts (START_WELCOME / START_WELCOME_WITH_LINK / START_INVALID / OTHER_MESSAGE_GUIDE / PROVISIONED_NOTICE / PROVISION_FAILED_NOTICE)",
    note: "The Telegram MANAGER bot speaks to the BUSINESS OPERATOR (bot provisioning/activation), never to a customer. Operator copy is out of scope for the customer copy registry. The CUSTOMER bot's `/start` welcome is a separate, customer-facing constant and IS registered as `channel.telegram.start_welcome`.",
  },
  {
    id: "CHANNEL_WEBHOOK_API_ERRORS",
    location: `${TELEGRAM_WEBHOOK} (unauthorized/validation JSON bodies) + src/server/transport/whatsapp-transport.ts (Zod refine messages + resolveInboundConnection / resolveConnectionForSend failure messages)`,
    note: "Provider-neutral API/validation error strings returned in typed 401/400 JSON bodies or transport-resolution results. They are answered to the provider's webhook servers / returned as typed results, never composed into a customer send. Every customer-facing WhatsApp/Telegram reply comes from the shared Conversation Engine (or the registered channel welcome), so no channel-specific duplicate is needed.",
  },
] as const;

// ─── Marker fragments (single source for the protected substrings) ──────────

const MARKER_PENDING_SERVICE = "يرجى تحديد الخدمة المطلوبة";
const MARKER_PENDING_DATE = "يرجى تحديد التاريخ المطلوب";
const MARKER_AMBIGUOUS_SERVICE = "هناك أكثر من خدمة تطابق";
const MARKER_OFFER_HEADER = "تتوفر المواعيد التالية لخدمة";

// ─── The canonical registry ──────────────────────────────────────────────────

export const COPY_REGISTRY = [
  // ── greeting.* — the deterministic greeting protocol (knowledge-free) ────

  {
    key: "greeting.ack.salam",
    category: "greeting",
    humanLabel: "رد تحية السلام",
    defaultText: "وعليكم السلام ورحمة الله وبركاته",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: AI,
      symbol: "greetingAcknowledgement (salam)",
      exported: false,
    },
  },
  {
    key: "greeting.ack.morning",
    category: "greeting",
    humanLabel: "رد تحية الصباح",
    defaultText: "صباح النور",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: AI,
      symbol: "greetingAcknowledgement (morning)",
      exported: false,
    },
  },
  {
    key: "greeting.ack.evening",
    category: "greeting",
    humanLabel: "رد تحية المساء",
    defaultText: "مساء النور",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: AI,
      symbol: "greetingAcknowledgement (evening)",
      exported: false,
    },
  },
  {
    key: "greeting.ack.default",
    category: "greeting",
    humanLabel: "رد التحية الافتراضي",
    defaultText: "أهلاً بك",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: AI,
      symbol: "greetingAcknowledgement (fallback)",
      exported: false,
    },
  },
  {
    key: "greeting.invite",
    category: "greeting",
    humanLabel: "دعوة التحية للمساعدة",
    defaultText: "أنا مساعدك للحجز والمواعيد — كيف يمكنني مساعدتك اليوم؟",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "GREETING_INVITE", exported: false },
  },

  // ── welcome.* — the fresh/idle conversation welcome introduction ─────────

  {
    key: "welcome.intro",
    category: "greeting",
    humanLabel: "مقدمة الترحيب عند بدء المحادثة",
    defaultText:
      "أهلاً بك في {businessName}!\nيسعدنا مساعدتك في حجز موعد أو الإجابة عن استفساراتك:",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["businessName"],
    requiredPlaceholders: ["businessName"],
    source: {
      file: ENGINE,
      symbol: "DEFAULT_WELCOME_INTRO_TEMPLATE",
      exported: true,
    },
  },

  // ── identity.* — the deterministic business-identity confirmation ────────

  {
    key: "identity.reply",
    category: "identity",
    humanLabel: "تأكيد هوية المنشأة",
    defaultText: "أيوه، {businessName} معاك. تحب نساعدك إزاي؟",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["businessName"],
    requiredPlaceholders: ["businessName"],
    source: {
      file: AI,
      symbol: "buildBusinessIdentityContent + IDENTITY_INVITE",
      exported: false,
    },
  },

  // ── clarify.* — the bounded, knowledge-free clarification questions ──────

  {
    key: "clarify.intent",
    category: "clarification",
    humanLabel: "سؤال توضيح النية العامة",
    defaultText:
      "لم أفهم طلبك تماماً — ممكن توضّح أكثر؟ أقدر أساعدك في حجز موعد، أو معرفة الأوقات المتاحة، أو الرد على استفساراتك.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: CLARIFY,
      symbol: "CLARIFY_INTENT_QUESTION",
      exported: true,
    },
  },
  {
    key: "clarify.service",
    category: "clarification",
    humanLabel: "سؤال تحديد الخدمة",
    defaultText:
      "يرجى تحديد الخدمة المطلوبة — أخبرنا باسم الخدمة التي ترغب بحجزها.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    markers: [
      {
        id: "clarify.service.pending-service-phrase",
        substring: MARKER_PENDING_SERVICE,
        reason:
          "derivePendingClarification recognizes a pending CLARIFY_SERVICE by this exact phrase.",
        sourceKey: "clarify.service",
      },
    ],
    source: {
      file: CLARIFY,
      symbol:
        "QUESTION_BY_TYPE.CLARIFY_SERVICE (also booking-mapper MISSING_SERVICE)",
      exported: false,
    },
  },
  {
    key: "clarify.date",
    category: "clarification",
    humanLabel: "سؤال تحديد التاريخ",
    defaultText:
      "يرجى تحديد التاريخ المطلوب (مثال: غداً، أو اذكر يوماً وتاريخاً محدداً).",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    markers: [
      {
        id: "clarify.date.pending-date-phrase",
        substring: MARKER_PENDING_DATE,
        reason:
          "derivePendingClarification recognizes a pending CLARIFY_DATE by this exact phrase.",
        sourceKey: "clarify.date",
      },
    ],
    source: {
      file: CLARIFY,
      symbol: "CLARIFY_DATE_QUESTION (also booking-mapper MISSING_DATE)",
      exported: true,
    },
  },
  {
    key: "clarify.service_ambiguous",
    category: "clarification",
    humanLabel: "سؤال ترجيح خدمة متعددة المطابقة",
    defaultText:
      "هناك أكثر من خدمة تطابق طلبك ({candidateNames}) — يرجى تحديد الخدمة بدقة.",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["candidateNames"],
    requiredPlaceholders: ["candidateNames"],
    markers: [
      {
        id: "clarify.service_ambiguous.pending-service-phrase",
        substring: MARKER_AMBIGUOUS_SERVICE,
        reason:
          "derivePendingClarification recognizes a pending ambiguous-service clarification by this exact phrase.",
        sourceKey: "clarify.service_ambiguous",
      },
    ],
    source: {
      file: MAPPER,
      symbol: "mapAiResponseToBookingInput (AMBIGUOUS_SERVICE)",
      exported: false,
    },
  },
  {
    key: "clarify.service_ambiguous_offer",
    category: "clarification",
    humanLabel: "ترجيح خدمة أثناء اختيار الموعد",
    defaultText:
      'هناك أكثر من خدمة تطابق "{serviceName}" — يرجى تحديد الخدمة بدقة.',
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["serviceName"],
    requiredPlaceholders: ["serviceName"],
    markers: [
      {
        id: "clarify.service_ambiguous_offer.pending-service-phrase",
        substring: MARKER_AMBIGUOUS_SERVICE,
        reason:
          "derivePendingClarification recognizes a pending ambiguous-service clarification by this exact phrase.",
        sourceKey: "clarify.service_ambiguous_offer",
      },
    ],
    source: {
      file: ENGINE,
      symbol: "completeBookingSelection (ambiguous service)",
      exported: false,
    },
  },

  // ── interruption.* — the interruption-recovery acknowledgment ───────────

  {
    key: "interruption.ack",
    category: "interruption",
    humanLabel: "تأكيد استئناف بعد المقاطعة",
    defaultText: "خذ وقتك — أنا في انتظارك لإكمال طلبك متى ما كنت جاهزاً.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: CLARIFY,
      symbol: "INTERRUPTION_ACK_QUESTION",
      exported: true,
    },
  },

  // ── continue.* — the answer-and-continue invitation ──────────────────────

  {
    key: "continue.invite",
    category: "continuation",
    humanLabel: "دعوة استئناف طلب الحجز",
    defaultText: "وبخصوص طلب الحجز، أنا جاهز أكمل معك — تحب نحجز إمتى؟",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    markers: [
      {
        id: "continue.invite.pending-continuation-line",
        // The WHOLE line is the migration-safe pending-BOOKING marker.
        substring: "وبخصوص طلب الحجز، أنا جاهز أكمل معك — تحب نحجز إمتى؟",
        reason:
          "derivePendingContinuation recognizes a pending BOOKING continuation by this whole line.",
        sourceKey: "continue.invite",
      },
    ],
    source: { file: CLARIFY, symbol: "CONTINUE_DOMAIN_INVITE", exported: true },
  },

  // ── booking.* — the deterministic booking offer / confirmation flow ──────

  {
    key: "booking.offer",
    category: "booking",
    humanLabel: "عرض المواعيد المتاحة",
    defaultText:
      'تتوفر المواعيد التالية لخدمة "{serviceName}" يوم {date}:\n{offer}\nيرجى اختيار الموعد المناسب لإتمام الحجز.',
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["serviceName", "date", "offer"],
    requiredPlaceholders: ["serviceName", "date", "offer"],
    markers: [
      {
        id: "booking.offer.offer-header",
        substring: MARKER_OFFER_HEADER,
        reason:
          "The OFFER_HEADER parser (booking-selection) recognizes a presented offer by this header; extractLastBookingOffer depends on it.",
        sourceKey: "booking.offer",
      },
    ],
    source: {
      file: FORMATTERS,
      symbol: "formatBookingOptionsCopy",
      exported: true,
    },
  },
  {
    key: "booking.invalid_index",
    category: "error",
    humanLabel: "تنبيه لاختيار رقم غير صالح",
    defaultText: "الاختيار غير صالح — يرجى اختيار رقم من 1 إلى {maxIndex}.",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["maxIndex"],
    requiredPlaceholders: ["maxIndex"],
    source: {
      file: ENGINE,
      symbol: "BOOKING_INVALID_INDEX_MESSAGE + offered-range line",
      exported: false,
    },
  },
  {
    key: "booking.unknown_time",
    category: "error",
    humanLabel: "تنبيه لوقت غير متاح",
    defaultText: "الوقت المحدد غير متاح — يرجى اختيار أحد الأوقات المعروضة.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "BOOKING_UNKNOWN_TIME_MESSAGE",
      exported: false,
    },
  },
  {
    key: "booking.ambiguous_time",
    category: "error",
    humanLabel: "تنبيه لتعدد المواعيد في وقت واحد",
    defaultText:
      "هناك أكثر من موعد في ذلك الوقت — يرجى تحديد الاختيار برقمه (1-3).",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "BOOKING_AMBIGUOUS_TIME_MESSAGE",
      exported: false,
    },
  },
  {
    key: "booking.conflict",
    category: "error",
    humanLabel: "تنبيه لحجز الموعد للتو",
    defaultText: "عذراً، تم حجز هذا الموعد للتو — يرجى اختيار موعد آخر.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "BOOKING_CONFLICT_MESSAGE",
      exported: false,
    },
  },
  {
    key: "booking.retry",
    category: "error",
    humanLabel: "تعذر إتمام الحجز",
    defaultText: "تعذر إتمام الحجز الآن — سيتواصل معك أحد أعضاء الفريق.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: ENGINE, symbol: "BOOKING_RETRY_MESSAGE", exported: false },
  },
  {
    key: "booking.confirmed",
    category: "booking",
    humanLabel: "تأكيد الحجز (تأكيد تلقائي)",
    defaultText:
      'تم تأكيد حجزك لخدمة "{serviceName}" يوم {date} من {startTime} إلى {endTime} مع {providerName}.',
    classification: "EDITABLE_TEMPLATE",
    placeholders: [
      "serviceName",
      "date",
      "startTime",
      "endTime",
      "providerName",
    ],
    requiredPlaceholders: [
      "serviceName",
      "date",
      "startTime",
      "endTime",
      "providerName",
    ],
    source: {
      file: ENGINE,
      symbol: "completeBookingSelection (automatic confirmation)",
      exported: false,
    },
  },
  {
    key: "booking.pending",
    category: "booking",
    humanLabel: "استلام طلب الحجز (تأكيد يدوي)",
    defaultText:
      'تم استلام طلب حجزك لخدمة "{serviceName}" يوم {date} من {startTime} إلى {endTime} مع {providerName}. سيتواصل معك الفريق لتأكيد الموعد.',
    classification: "EDITABLE_TEMPLATE",
    placeholders: [
      "serviceName",
      "date",
      "startTime",
      "endTime",
      "providerName",
    ],
    requiredPlaceholders: [
      "serviceName",
      "date",
      "startTime",
      "endTime",
      "providerName",
    ],
    source: {
      file: ENGINE,
      symbol: "completeBookingSelection (manual confirmation)",
      exported: false,
    },
  },
  {
    key: "booking.stale_options",
    category: "booking",
    humanLabel: "تحديث الخيارات بعد فقد السياق",
    defaultText:
      "لم يعد بإمكاني التأكد من الخيارات المعروضة — إليك المواعيد المتاحة الآن:\n{offer}",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["offer"],
    requiredPlaceholders: ["offer"],
    markers: [
      {
        id: "booking.stale_options.offer-header",
        substring: MARKER_OFFER_HEADER,
        reason:
          "Re-offers {offer}; the rendered offer must still carry the OFFER_HEADER marker so the selection parser keeps working.",
        carriedByPlaceholder: "offer",
        sourceKey: "booking.offer",
      },
    ],
    source: {
      file: ENGINE,
      symbol: "completeBookingSelection (no offered option)",
      exported: false,
    },
  },
  {
    key: "booking.stale_option",
    category: "booking",
    humanLabel: "الخيار المختار لم يعد متاحاً",
    defaultText:
      "الخيار المحدد لم يعد متاحاً — إليك المواعيد المحدثة:\n{offer}",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["offer"],
    requiredPlaceholders: ["offer"],
    markers: [
      {
        id: "booking.stale_option.offer-header",
        substring: MARKER_OFFER_HEADER,
        reason:
          "Re-offers {offer}; the rendered offer must still carry the OFFER_HEADER marker so the selection parser keeps working.",
        carriedByPlaceholder: "offer",
        sourceKey: "booking.offer",
      },
    ],
    source: {
      file: ENGINE,
      symbol: "completeBookingSelection (stale presented option)",
      exported: false,
    },
  },
  {
    key: "booking.slot_taken",
    category: "booking",
    humanLabel: "حجز الموعد أثناء الإغلاق",
    defaultText:
      "عذراً، تم حجز هذا الموعد للتو — إليك المواعيد المتاحة الآن:\n{offer}",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["offer"],
    requiredPlaceholders: ["offer"],
    markers: [
      {
        id: "booking.slot_taken.offer-header",
        substring: MARKER_OFFER_HEADER,
        reason:
          "Re-offers {offer} after a slot conflict; the rendered offer must still carry the OFFER_HEADER marker so the selection parser keeps working.",
        carriedByPlaceholder: "offer",
        sourceKey: "booking.offer",
      },
    ],
    source: {
      file: ENGINE,
      symbol: "completeBookingSelection (SLOT_CONFLICT retry)",
      exported: false,
    },
  },
  {
    key: "booking.service_unavailable",
    category: "error",
    humanLabel: "الخدمة لم تعد متاحة",
    defaultText: "الخدمة المطلوبة لم تعد متاحة — يرجى تحديد الخدمة مرة أخرى.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "completeBookingSelection (missing service)",
      exported: false,
    },
  },
  {
    key: "booking.service_not_found",
    category: "error",
    humanLabel: "الخدمة غير موجودة",
    defaultText: "الخدمة المطلوبة غير موجودة — يرجى التأكد من اسم الخدمة.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEligibilityErrorMessage (SERVICE_NOT_FOUND)",
      exported: false,
    },
  },
  {
    key: "booking.service_inactive",
    category: "error",
    humanLabel: "الخدمة غير متاحة للحجز",
    defaultText:
      "الخدمة المطلوبة غير متاحة للحجز حالياً — سيتواصل معك أحد أعضاء الفريق.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEligibilityErrorMessage (SERVICE_INACTIVE)",
      exported: false,
    },
  },
  {
    key: "booking.branch_not_found",
    category: "error",
    humanLabel: "الفرع غير موجود",
    defaultText: "الفرع المطلوب غير موجود — سيتواصل معك أحد أعضاء الفريق.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEligibilityErrorMessage (BRANCH_NOT_FOUND)",
      exported: false,
    },
  },
  {
    key: "booking.no_business",
    category: "error",
    humanLabel: "إعداد المنشأة ناقص",
    defaultText: "أكمل إعداد المنشأة أولاً — سيتواصل معك أحد أعضاء الفريق.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEligibilityErrorMessage (NO_BUSINESS)",
      exported: false,
    },
  },
  {
    key: "booking.invalid_input",
    category: "error",
    humanLabel: "بيانات الحجز غير مكتملة",
    defaultText: "بيانات الحجز غير مكتملة — سيتواصل معك أحد أعضاء الفريق.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEligibilityErrorMessage (INVALID_INPUT)",
      exported: false,
    },
  },
  {
    key: "booking.booking_failed",
    category: "error",
    humanLabel: "تعذر إتمام الحجز (عام)",
    defaultText: "تعذر إتمام الحجز حالياً — سيتواصل معك أحد أعضاء الفريق.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEligibilityErrorMessage (default)",
      exported: false,
    },
  },
  {
    key: "booking.provider_not_eligible",
    category: "error",
    humanLabel: "المزود غير متاح للخدمة",
    defaultText:
      "المزود المطلوب غير متاح لهذه الخدمة — يرجى اختيار مزود آخر أو اختيار أي مزود متاح.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingOptionsErrorMessage (PROVIDER_NOT_ELIGIBLE)",
      exported: false,
    },
  },
  {
    key: "booking.provider_ambiguous",
    category: "error",
    humanLabel: "تعدد المزودين المطابقين",
    defaultText: "هناك أكثر من مزود يطابق طلبك — يرجى تحديد المزود بدقة.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "completeBookingSelection (ambiguous provider)",
      exported: false,
    },
  },
  {
    key: "booking.no_eligible_providers",
    category: "error",
    humanLabel: "لا يوجد مزود متاح",
    defaultText:
      "لا يوجد مزود متاح لهذه الخدمة حالياً — سيتواصل معك أحد أعضاء الفريق.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEmptyReasonMessage (NO_ELIGIBLE_PROVIDERS)",
      exported: false,
    },
  },
  {
    key: "booking.business_closed",
    category: "error",
    humanLabel: "المنشأة مغلقة",
    defaultText: "المنشأة مغلقة يوم {date} — يرجى اختيار تاريخ آخر.",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["date"],
    requiredPlaceholders: ["date"],
    source: {
      file: ENGINE,
      symbol: "bookingEmptyReasonMessage (BUSINESS_CLOSED)",
      exported: false,
    },
  },
  {
    key: "booking.service_too_long",
    category: "error",
    humanLabel: "مدة الخدمة تتجاوز ساعات العمل",
    defaultText:
      "مدة الخدمة أطول من ساعات العمل في ذلك اليوم — يرجى اختيار خدمة أخرى أو تاريخ آخر.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEmptyReasonMessage (SERVICE_TOO_LONG)",
      exported: false,
    },
  },
  {
    key: "booking.fully_booked",
    category: "error",
    humanLabel: "جميع المواعيد محجوزة",
    defaultText:
      "جميع المواعيد محجوزة يوم {date} — يرجى اختيار تاريخ آخر أو سيتواصل معك الفريق.",
    classification: "EDITABLE_TEMPLATE",
    placeholders: ["date"],
    requiredPlaceholders: ["date"],
    source: {
      file: ENGINE,
      symbol: "bookingEmptyReasonMessage (FULLY_BOOKED)",
      exported: false,
    },
  },
  {
    key: "booking.no_options",
    category: "error",
    humanLabel: "لا توجد مواعيد متاحة",
    defaultText: "لا تتوفر مواعيد حالياً — سيتواصل معك أحد أعضاء الفريق.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: ENGINE,
      symbol: "bookingEmptyReasonMessage (default)",
      exported: false,
    },
  },
  {
    key: "booking.request",
    category: "booking",
    humanLabel: "إقرار استلام طلب الحجز",
    defaultText:
      "يسعدنا خدمتك! سيتواصل معك أحد أعضاء الفريق لإتمام الحجز وتحديد الوقت المناسب.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "REPLIES.BOOKING", exported: false },
  },
  {
    key: "booking.availability",
    category: "booking",
    humanLabel: "إقرار الاستفسار عن الأوقات",
    defaultText:
      "شكراً لسؤالك — سيرسل لك أحد أعضاء الفريق الأوقات المتاحة قريباً.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "REPLIES.AVAILABILITY", exported: false },
  },
  {
    key: "booking.reschedule",
    category: "booking",
    humanLabel: "إقرار تعديل الموعد",
    defaultText: "بالطبع — سيتولى أحد أعضاء الفريق تعديل موعدك والتواصل معك.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "REPLIES.RESCHEDULE", exported: false },
  },
  {
    key: "booking.cancellation",
    category: "booking",
    humanLabel: "إقرار إلغاء الموعد",
    defaultText: "تمام — سيتواصل معك أحد أعضاء الفريق لإتمام إلغاء الموعد.",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "REPLIES.CANCELLATION", exported: false },
  },

  // ── handoff.* — the SAFE-HANDOFF acknowledgments (PROTECTED_COPY) ────────
  //
  // These are the deterministic replies the engine emits when it MUST defer to
  // a human (explicit human request, sensitive/high-stakes language, an
  // unbacked knowledge answer, or unresolved ambiguity — incl. the disclosure
  // refusal and provider-failure safe-handoff paths). Each promises human
  // follow-up, which is the safety contract; they are registered so the Lab
  // can see them, but must stay non-editable.

  {
    key: "handoff.human_request",
    category: "handoff",
    humanLabel: "تحويل لطلب الإنسان (محمي)",
    defaultText: "تحت أمرك — تم تحويل المحادثة لفريق العمل للمتابعة.",
    classification: "PROTECTED_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "REPLIES.HUMAN_REQUEST", exported: false },
  },
  {
    key: "handoff.sensitive",
    category: "handoff",
    humanLabel: "رد الطلب الحساس (محمي)",
    defaultText: "سنعتني بطلبك — تم تحويل المحادثة لفريق العمل للمتابعة.",
    classification: "PROTECTED_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "REPLIES.SENSITIVE", exported: false },
  },
  {
    key: "handoff.no_knowledge",
    category: "handoff",
    humanLabel: "رد انعدام المعرفة (محمي)",
    defaultText: "شكراً لسؤالك — تم تحويل استفسارك لفريق العمل للمتابعة.",
    classification: "PROTECTED_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "REPLIES.NO_KNOWLEDGE", exported: false },
  },
  {
    key: "handoff.ambiguous",
    category: "handoff",
    humanLabel: "رد الغموض غير المحلول (محمي)",
    defaultText:
      "لم أفهم طلبك تماماً — تم تحويل المحادثة لفريق العمل للمساعدة.",
    classification: "PROTECTED_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: { file: AI, symbol: "REPLIES.AMBIGUOUS", exported: false },
  },

  // ── channel.* — deterministic CHANNEL-LEVEL copy (UX-LAB-01A2) ──────────
  //
  // Copy a channel/transport owns outright and emits ITSELF, outside the
  // shared Conversation Engine. One family for every channel — there is no
  // per-channel registry; a semantic reply several channels share stays a
  // single canonical key. Only genuinely channel-owned, customer-bound,
  // deterministic text lives here.

  {
    key: "channel.telegram.start_welcome",
    category: "channel",
    humanLabel: "ترحيب تيليجرام عند /start",
    defaultText: "أهلاً بك 👋\nمرحبًا بك! كيف يمكنني مساعدتك؟",
    classification: "EDITABLE_COPY",
    placeholders: [],
    requiredPlaceholders: [],
    source: {
      file: TELEGRAM_WEBHOOK,
      symbol: "CUSTOMER_START_WELCOME",
      exported: true,
    },
  },
] as const satisfies readonly CopyRegistryEntry[];

// ─── Derived helpers (pure; the smallest useful surface for later slices) ───

/** Every canonical key, in registry order. */
export const COPY_REGISTRY_KEYS: readonly string[] = COPY_REGISTRY.map(
  (entry) => entry.key,
);

/** Stable canonical key union for consumers (the Lab, later slices). */
export type CanonicalCopyKey = (typeof COPY_REGISTRY)[number]["key"];

/** Look up one entry by canonical key. Returns null for an unknown key. */
export function getCopyEntry(key: string): CopyRegistryEntry | null {
  return COPY_REGISTRY.find((entry) => entry.key === key) ?? null;
}

/** The default text for a canonical key, or null when the key is unknown. */
export function getDefaultText(key: string): string | null {
  return getCopyEntry(key)?.defaultText ?? null;
}

/** Count entries by classification (used by the offline check + reporting). */
export function countByClassification(
  classification: CopyClassification,
): number {
  return COPY_REGISTRY.filter(
    (entry) => entry.classification === classification,
  ).length;
}

/** Count entries by category (used by the offline check + reporting). */
export function countByCategory(category: CopyCategory): number {
  return COPY_REGISTRY.filter((entry) => entry.category === category).length;
}

/**
 * The canonical key that owns the rendered text for a placeholder, when the
 * placeholder's value is itself canonical copy. Today only `{offer}` resolves
 * to another registry entry (`booking.offer`); this keeps the marker
 * inheritance check (and later rendering) deterministic.
 */
export const PLACEHOLDER_SOURCE_KEY: Readonly<
  Partial<Record<PlaceholderName, CanonicalCopyKey>>
> = {
  offer: "booking.offer",
};

/** Re-export the marker/source types for consumers of the registry module. */
export type {
  CopyCategory,
  CopyClassification,
  CopyMarker,
  CopyRegistryEntry,
  CopySource,
  PlaceholderName,
} from "@/features/conversation-copy/types";
