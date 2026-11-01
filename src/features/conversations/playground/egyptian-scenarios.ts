/**
 * FlowPilot Conversation Playground — Egyptian Arabic Scenarios (CORE-03C1)
 *
 * Targeted scenario set evaluating the merged Conversation Engine:
 * - Structured capability routing
 * - Authoritative date/time/provider durable state
 * - Clarification, correction, and REMOVE transitions
 * - Mechanical selection (0 provider attempts)
 * - Safe handling of invalid proposals & FAQ interruptions
 */

import { PLAYGROUND_IDS } from "./harness";
import type { ScenarioDefinition } from "./types";

export type MockTurnResponse = {
  body: Record<string, unknown>;
  status?: number;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
};

export type EgyptianScenarioDefinition = ScenarioDefinition & {
  mockResponses?: Record<number, MockTurnResponse>;
  referenceInstant?: string;
  evaluationScope?:
    "LANGUAGE_EVALUATION" | "ENGINEERING_BOUNDARY" | "KNOWN_APPLICATION_DEFECT";
};

function mockBooking(params: {
  content: string;
  service?: string | null;
  date?: string | null;
  provider?: string | null;
  timePreference?: string | null;
  safetyAssessment?: string | null;
  factUpdates?: Array<{
    key: string;
    operation?: "set" | "remove";
    value?: string;
  }>;
}): Record<string, unknown> {
  return {
    intent: "BOOKING",
    action: "booking_handoff",
    content: params.content,
    summary: "طلب حجز كشف أسنان",
    handoffReason: null,
    extraction: {
      service: params.service ?? null,
      date: params.date ?? null,
      provider: params.provider ?? null,
      timePreference: params.timePreference ?? null,
    },
    safetyAssessment:
      params.safetyAssessment !== undefined ? params.safetyAssessment : "safe",
    ...(params.factUpdates ? { factUpdates: params.factUpdates } : {}),
  };
}

function mockFaq(
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    intent: "FAQ",
    action: "reply",
    content,
    summary: null,
    handoffReason: null,
    safetyAssessment: "safe",
    knowledgeRef: {
      family: "business.faqs",
      sourceId: "عنوان ومكان العيادة",
    },
    extraction: {
      service: null,
      date: null,
      provider: null,
      timePreference: null,
    },
    factUpdates: [],
    ...extra,
  };
}

export const EGYPTIAN_ARABIC_SCENARIOS: EgyptianScenarioDefinition[] = [
  // CE-01: Relative date interpreted against Cairo reference
  {
    id: "CE-01",
    title: "التاريخ النسبي: بكرة مع توقيت القاهرة المرجعي",
    category: "RELATIVE_DATES",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "تفسير كلمة 'بكرة' نسبة إلى تاريخ المرجع في القاهرة (الثلاثاء 2026-10-20 -> الأربعاء 2026-10-21)",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "متاح لكشف أسنان غداً الأربعاء المواعيد التالية:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
        usage: { prompt_tokens: 180, completion_tokens: 40, total_tokens: 220 },
      },
    },
    turns: [
      {
        input: "عايز أحجز كشف أسنان بكرة",
        expectedIntent: "BOOKING",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error(
              `Expected date 2026-10-21, got: ${turn.stateAfter?.selectedDate}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-02: Reference instant where UTC and Cairo local dates differ
  {
    id: "CE-02",
    title: "اختلاف تاريخ UTC عن تاريخ القاهرة المحلي في لحظة الإدخال",
    category: "RELATIVE_DATES",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "لحظة 22:30 UTC يوم 2026-10-20 تقابل 00:30 صباح 2026-10-21 في القاهرة. 'النهاردة' يجب أن تكون 2026-10-21",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T22:30:00.000Z",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "متاح اليوم الأربعاء 21 أكتوبر المواعيد التالية:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
        usage: { prompt_tokens: 190, completion_tokens: 35, total_tokens: 225 },
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان النهاردة",
        expectedIntent: "BOOKING",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error(
              `Expected Cairo local date 2026-10-21, got: ${turn.stateAfter?.selectedDate}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-03: Date correction in multi-turn sequence
  {
    id: "CE-03",
    title: "تصحيح التاريخ عبر دورة متعددة (الأربعاء -> الخميس)",
    category: "CLARIFICATION_RECOVERY",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "تعديل العميل لتاريخ الموعد من الأربعاء 2026-10-21 إلى الخميس 2026-10-22 مع تحديث الحالة والمتجر الدائم",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة يوم الأربعاء 21 أكتوبر:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content: "تم تعديل اليوم إلى الخميس 22 أكتوبر. المواعيد المتاحة:",
          service: "كشف أسنان",
          date: "2026-10-22",
          factUpdates: [{ key: "date", operation: "set", value: "2026-10-22" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان يوم الأربعاء",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error(`Turn 1 expected 2026-10-21`);
          }
        },
      },
      {
        input: "لا معلش خليها الخميس",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-22") {
            throw new Error(
              `Turn 2 expected 2026-10-22, got: ${turn.stateAfter?.selectedDate}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-04: Provider correction with colliding first names
  {
    id: "CE-04",
    title:
      "تصحيح مقدم الخدمة عند تشابه الأسماء الأولى (د. أحمد سامي / د. أحمد علي)",
    category: "PROVIDER_SELECTION",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "وجود طبيبين باسم أحمد يتطلب توضيحاً عند ذكر 'دكتور أحمد' فقط ثم التحديد الصريح لدكتور أحمد سامي",
    setup: {
      todayRef: "2026-10-20",
      providers: [
        {
          id: PLAYGROUND_IDS.PROV_1,
          name: "د. أحمد سامي",
          displayName: "د. أحمد سامي",
          userId: PLAYGROUND_IDS.USER_P1,
        },
        {
          id: PLAYGROUND_IDS.PROV_2,
          name: "د. أحمد علي",
          displayName: "د. أحمد علي",
          userId: PLAYGROUND_IDS.USER_P2,
        },
      ],
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "لدينا د. أحمد سامي و د. أحمد علي، تحب تحجز مع مين فيهم؟",
          service: "كشف أسنان",
          date: "2026-10-21",
          provider: "دكتور أحمد",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content: "تمام مع د. أحمد سامي يوم الأربعاء المواعيد المتاحة:",
          service: "كشف أسنان",
          date: "2026-10-21",
          provider: "د. أحمد سامي",
          factUpdates: [
            { key: "provider", operation: "set", value: "د. أحمد سامي" },
          ],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف مع دكتور أحمد يوم الأربعاء",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (
            !turn.outbound.text.includes("المزود المطلوب غير متاح") &&
            !turn.outbound.text.includes("أحمد")
          ) {
            throw new Error("Turn 1 should clarify between the two doctors");
          }
        },
      },
      {
        input: "دكتور أحمد سامي",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.providerPreference !== "د. أحمد سامي") {
            throw new Error("Turn 2 should set provider to د. أحمد سامي");
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-05: Provider REMOVE followed by continuation
  {
    id: "CE-05",
    title: "حذف تفضيل الطبيب (REMOVE) مع استمرار الحجز لأي طبيب متاح",
    category: "PROVIDER_SELECTION",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "تحديد دكتورة سارة أولاً ثم حذف التفضيل بعبارة 'مش فارق معايا الدكتور، أي حد' واستمرار الحجز",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة مع د. سارة عادل يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          provider: "د. سارة عادل",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "provider", operation: "set", value: "د. سارة عادل" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content: "تمام، متاح مع أي طبيب يوم الأربعاء المواعيد التالية:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [{ key: "provider", operation: "remove" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف مع دكتورة سارة يوم الأربعاء",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.providerPreference !== "د. سارة عادل") {
            throw new Error("Turn 1 expected provider Sara");
          }
        },
      },
      {
        input: "مش فارق معايا الدكتور، أي حد متاح",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          const pref = turn.stateAfter?.providerPreference;
          if (pref && pref !== "ANY_PROVIDER") {
            throw new Error(`Turn 2 expected provider removed, got: ${pref}`);
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-06: Time-preference REMOVE followed by continuation
  {
    id: "CE-06",
    title: "حذف تفضيل الفترة الزمنية (REMOVE) مع استمرار الحجز",
    category: "CLARIFICATION_RECOVERY",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "تفضيل الفترة الصباحية ثم إزالتها بـ 'أي وقت يناسبكم عادي' وإظهار كل مواعيد اليوم",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد الصباحية المتاحة يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "morning",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "morning" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content: "تمام، إليك جميع المواعيد المتاحة على مدار اليوم:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [{ key: "timePreference", operation: "remove" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان الصبح يوم الأربعاء",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedTimePref !== "morning") {
            throw new Error("Turn 1 expected morning time preference");
          }
          // Verify morning slots effect: first slot starts before 12:00
          const offer = turn.stateAfter?.offer;
          if (offer && offer.kind === "SLOT" && offer.options.length > 0) {
            const firstSlot = offer.options[0];
            if (firstSlot) {
              const startHour = parseInt(firstSlot.startAt.slice(11, 13), 10);
              if (!Number.isNaN(startHour) && startHour >= 12) {
                throw new Error(
                  `Turn 1 expected morning slot (<12:00), got ${startHour}:00`,
                );
              }
            }
          }
        },
      },
      {
        input: "أي وقت يناسبكم عادي",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedTimePref != null) {
            throw new Error("Turn 2 expected time preference removed");
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-07: Date REMOVE followed by a missing-date clarification
  {
    id: "CE-07",
    title: "حذف التاريخ (REMOVE) والتوقف لتوضيح اليوم الجديد",
    category: "CLARIFICATION_RECOVERY",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "إلغاء تاريخ اليوم المحدد صراحة، والتحقق من مطالبة العميل بتحديد تاريخ جديد",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة يوم الأربعاء 21 أكتوبر:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content: "تم إلغاء تحديد اليوم. تحب نحجز في أي يوم أو تاريخ بديل؟",
          service: "كشف أسنان",
          factUpdates: [{ key: "date", operation: "remove" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان يوم الأربعاء",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error("Turn 1 expected date 2026-10-21");
          }
        },
      },
      {
        input: "الغي اليوم ده ومش عارف هاجي امتى",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate != null) {
            throw new Error("Turn 2 expected date removed");
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-08: FAQ interruption preserving an existing booking
  {
    id: "CE-08",
    title:
      "اعتراض استفسار FAQ مع الحفاظ التام على بيانات الحجز بالحالة الدائمة",
    category: "CATALOG_INQUIRY",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "طرح سؤال عن عنوان العيادة أثناء الحجز، والرد دون تصفير بيانات الخدمة والتاريخ",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة لكشف أسنان غداً الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
      2: {
        body: mockFaq(
          "عنوان العيادة: الفرع الرئيسي - القاهرة. شرفنا بزيارتك في أي وقت.",
        ),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedIntent: "BOOKING",
      },
      {
        input: "هو عنوان العيادة فين بالظبط؟",
        expectedIntent: "FAQ",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error(
              "FAQ turn must preserve selectedDate in durable state",
            );
          }
          if (turn.stateAfter?.selectedService !== "كشف أسنان") {
            throw new Error(
              "FAQ turn must preserve selectedService in durable state",
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-09: Explicit factUpdates taking precedence over conflicting extraction
  {
    id: "CE-09",
    title: "أولوية factUpdates الصريحة على extraction المتعارض",
    category: "CLARIFICATION_RECOVERY",
    evaluationScope: "ENGINEERING_BOUNDARY",
    description:
      "عند وجود تعارض بين كائن extraction القديم ومصفوفة factUpdates الصريحة، تفوز factUpdates",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة يوم الأحد 25 أكتوبر:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-25" },
          ],
        }),
      },
    },
    turns: [
      {
        input: "عايز أحجز كشف أسنان",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-25") {
            throw new Error(
              `Expected factUpdates date 2026-10-25 to take precedence, got: ${turn.stateAfter?.selectedDate}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-10: Missing semantic information not being filled by a post-AI dictionary
  {
    id: "CE-10",
    title:
      "المعلومات الناقصة دلالياً لا تُملأ عبر قواميس النصوص بعد الذكاء الاصطناعي",
    category: "CLARIFICATION_RECOVERY",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "عبارات نصية عامة بدون تاريخ صريح لا يجوز استنتاجها بقواعد regex بعد مخرجات الذكاء الاصطناعي",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "تحب نحجز في أي يوم تحديداً الأسبوع القادم؟",
          service: "كشف أسنان",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
          ],
        }),
      },
    },
    turns: [
      {
        input: "كشف أسنان الأسبوع الجاي يوم حلو كده",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate != null) {
            throw new Error(
              `Date should remain missing and not fabricated from prose dictionary`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-11: Numeric/callback selection requiring no provider call
  {
    id: "CE-11",
    title: "الاختيار الرقمي للموعد يستهلك 0 محاولات مزود ذكاء اصطناعي",
    category: "STANDARD_BOOKING",
    evaluationScope: "ENGINEERING_BOUNDARY",
    description:
      "اختيار الموعد بالرقم '1' ينفذ عبر محرك الحجز الميكانيكي دون أي استدعاء شبكي للمزود",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة:\n1. 10:00 ص\n2. 10:30 ص",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedIntent: "BOOKING",
      },
      {
        input: "1",
        assertFn: (turn) => {
          if (turn.processing.currentEngine?.httpAttempts.count !== 0) {
            throw new Error(
              `Turn 2 (mechanical selection) must spend 0 HTTP attempts, got: ${turn.processing.currentEngine?.httpAttempts.count}`,
            );
          }
          if (!turn.diagnostics.appointmentCreated) {
            throw new Error("Turn 2 must confirm and create appointment");
          }
        },
      },
    ],
    expectations: {
      shouldBook: true,
    },
  },

  // CE-12: Invalid provider proposals clarifying safely
  {
    id: "CE-12",
    title: "مقترح غير صالح للتاريخ من المزود يتم توضيحه بأمان دون انهيار",
    category: "CLARIFICATION_RECOVERY",
    evaluationScope: "ENGINEERING_BOUNDARY",
    description:
      "اقتراح نص تاريخ غير صالح من المزود يتم رفضه بواسطة التحقق ويطلب توضيحاً آمناً",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "عايز أحجز في تاريخ غير معروف.",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            {
              key: "date",
              operation: "set",
              value: "invalid-date-format-string",
            },
          ],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          const dt = turn.stateAfter?.selectedDate;
          if (dt === "invalid-date-format-string") {
            throw new Error(
              "Invalid date proposal must not corrupt durable state",
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // CE-13: Formerly tracked known defect — repaired in CORE-03D2 via semantic safety assessment
  {
    id: "CE-13",
    title:
      "معالجة الخلل: منع التحويل الخاطئ على عبارة 'مش مشكلة' العامية عبر تقييم الأمان الدلالي",
    category: "SAFETY_HANDOFF",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "العبارة العامية 'مش مشكلة' كانت تُفعّل سابقاً كاشف الكلمات الحساسة بشكل خاطئ. في CORE-03D2 يحل تقييم الأمان الدلالي محل الكاشف اللفظي مع إزالة تفضيل الوقت والاستمرار.",
    setup: {
      todayRef: "2026-10-20",
    },
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "morning",
          safetyAssessment: "safe",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "morning" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content:
            "تمام، تم إلغاء تفضيل الفترة الصباحية. إليك المواعيد المتاحة يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: null,
          safetyAssessment: "safe",
          factUpdates: [{ key: "timePreference", operation: "remove" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان الصبح يوم الأربعاء",
        expectedAction: "AI_REPLY",
      },
      {
        input: "أي وقت يناسبكم مش مشكلة",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (turn.assistantAction !== "AI_REPLY") {
            throw new Error(
              `Expected AI_REPLY without sensitive handoff, got ${turn.assistantAction}`,
            );
          }
          if (
            turn.processing.currentEngine?.domainResult.handoffCause !== null
          ) {
            throw new Error(
              `Expected handoff cause null, got ${turn.processing.currentEngine?.domainResult.handoffCause}`,
            );
          }
          if (turn.stateAfter?.knownFacts?.timePreference != null) {
            throw new Error(
              `Expected timePreference removed, got ${turn.stateAfter?.knownFacts?.timePreference}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },
];

// =============================================================================
// CORE-03C2 Small Fixed Egyptian Smoke Corpus (Cases A through H)
// Fixed reference: Tuesday 2026-10-20T10:00:00.000+03:00 (Africa/Cairo)
// Target cases:
//   A. Direct booking
//   B. Relative date ("عايز أحجز بكرة")
//   C. Date correction ("لا خليها الخميس")
//   D. Provider preference removal ("خلاص أي دكتور متاح")
//   E. Time preference removal ("أي وقت مناسب")
//   F. FAQ interruption (service address question during booking)
//   G. Known application defect ("أي وقت يناسبكم مش مشكلة")
//   H. Mechanical confirmation (slot selection '1' -> 0 model calls)
// =============================================================================

export const CORE_03C2_SMOKE_SCENARIOS: EgyptianScenarioDefinition[] = [
  // SMOKE-A: Direct booking
  {
    id: "SMOKE-A",
    title: "Case A: Direct booking with explicit catalog service and date",
    category: "STANDARD_BOOKING",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "Customer requests a catalog-valid dental service with a clear date",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T10:00:00.000+03:00",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة لكشف أسنان يوم الأربعاء 21 أكتوبر:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان يوم الأربعاء 2026-10-21",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error(
              `Case A expected date 2026-10-21, got: ${turn.stateAfter?.selectedDate}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // SMOKE-B: Relative date
  {
    id: "SMOKE-B",
    title:
      "Case B: Relative date 'عايز أحجز بكرة' relative to fixed Cairo reference",
    category: "RELATIVE_DATES",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "Interpretation of 'بكرة' relative to Tuesday 2026-10-20 in Cairo -> 2026-10-21",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T10:00:00.000+03:00",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "متاح لكشف أسنان غداً الأربعاء المواعيد التالية:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
    },
    turns: [
      {
        input: "عايز أحجز بكرة",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error(
              `Case B expected date 2026-10-21, got: ${turn.stateAfter?.selectedDate}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // SMOKE-C: Date correction
  {
    id: "SMOKE-C",
    title:
      "Case C: Date correction 'لا خليها الخميس' updating Wednesday to Thursday",
    category: "RELATIVE_DATES",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "Start with one valid date (Wednesday 2026-10-21), then 'لا خليها الخميس' -> 2026-10-22",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T10:00:00.000+03:00",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة يوم الأربعاء 21 أكتوبر:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content: "تم تعديل اليوم إلى الخميس 22 أكتوبر. المواعيد المتاحة:",
          service: "كشف أسنان",
          date: "2026-10-22",
          factUpdates: [{ key: "date", operation: "set", value: "2026-10-22" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان يوم الأربعاء",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error(`Case C Turn 1 expected 2026-10-21`);
          }
        },
      },
      {
        input: "لا خليها الخميس",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-22") {
            throw new Error(
              `Case C Turn 2 expected 2026-10-22, got: ${turn.stateAfter?.selectedDate}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // SMOKE-D: Provider preference removal
  {
    id: "SMOKE-D",
    title: "Case D: Provider preference removal 'خلاص أي دكتور متاح'",
    category: "PROVIDER_SELECTION",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "Begin with selected valid provider (Dr. Sara), then 'خلاص أي دكتور متاح' removes preference",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T10:00:00.000+03:00",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة مع د. سارة عادل يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          provider: "د. سارة عادل",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "provider", operation: "set", value: "د. سارة عادل" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content: "تمام، متاح مع أي طبيب يوم الأربعاء المواعيد التالية:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [{ key: "provider", operation: "remove" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف مع دكتورة سارة يوم الأربعاء",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          if (turn.stateAfter?.providerPreference !== "د. سارة عادل") {
            throw new Error("Case D Turn 1 expected provider Sara");
          }
        },
      },
      {
        input: "خلاص أي دكتور متاح",
        expectedIntent: "BOOKING",
        assertFn: (turn) => {
          const pref = turn.stateAfter?.providerPreference;
          if (pref && pref !== "ANY_PROVIDER") {
            throw new Error(
              `Case D Turn 2 expected provider removed, got: ${pref}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // SMOKE-E: Time preference removal
  {
    id: "SMOKE-E",
    title: "Case E: Time preference removal 'أي وقت مناسب'",
    category: "CLARIFICATION_RECOVERY",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "Begin with morning preference, then 'أي وقت مناسب' clears morning restriction",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T10:00:00.000+03:00",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد الصباحية المتاحة يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "morning",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "morning" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content: "تمام، إليك جميع المواعيد المتاحة على مدار اليوم:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [{ key: "timePreference", operation: "remove" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان الصبح يوم الأربعاء",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedTimePref !== "morning") {
            throw new Error("Case E Turn 1 expected morning time preference");
          }
        },
      },
      {
        input: "أي وقت مناسب",
        assertFn: (turn) => {
          const pref = turn.stateAfter?.selectedTimePref;
          if (pref && pref !== "ANY_TIME") {
            throw new Error(
              `Case E Turn 2 expected time preference removed, got: ${pref}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // SMOKE-F: FAQ interruption
  {
    id: "SMOKE-F",
    title: "Case F: FAQ interruption preserving booking facts",
    category: "CLARIFICATION_RECOVERY",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "Ask clinic address question during booking; verify booking facts preserved",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T10:00:00.000+03:00",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة لكشف أسنان غداً الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
      2: {
        body: mockFaq(
          "عنوان العيادة: الفرع الرئيسي - القاهرة. شرفنا بزيارتك في أي وقت.",
        ),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedIntent: "BOOKING",
      },
      {
        input: "هو عنوان العيادة فين بالظبط؟",
        expectedIntent: "FAQ",
        assertFn: (turn) => {
          if (turn.stateAfter?.selectedDate !== "2026-10-21") {
            throw new Error(
              "Case F FAQ turn must preserve selectedDate in durable state",
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // SMOKE-G: Case G — Repaired false-positive on 'مش مشكلة' with safe semantic assessment
  {
    id: "SMOKE-G",
    title: "Case G: Repaired false-positive 'أي وقت يناسبكم مش مشكلة'",
    category: "SAFETY_HANDOFF",
    evaluationScope: "LANGUAGE_EVALUATION",
    description:
      "Dialect phrase 'مش مشكلة' evaluated as safe under semantic assessment; timePreference removed and continues AI_ACTIVE",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T10:00:00.000+03:00",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: "morning",
          safetyAssessment: "safe",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
            { key: "timePreference", operation: "set", value: "morning" },
          ],
        }),
      },
      2: {
        body: mockBooking({
          content:
            "تمام، تم إلغاء تحديد الفترة. إليك المواعيد المتاحة يوم الأربعاء:",
          service: "كشف أسنان",
          date: "2026-10-21",
          timePreference: null,
          safetyAssessment: "safe",
          factUpdates: [{ key: "timePreference", operation: "remove" }],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان الصبح يوم الأربعاء",
        expectedAction: "AI_REPLY",
      },
      {
        input: "أي وقت يناسبكم مش مشكلة",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (turn.assistantAction !== "AI_REPLY") {
            throw new Error(
              `Expected AI_REPLY without false handoff, got ${turn.assistantAction}`,
            );
          }
          if (
            turn.processing.currentEngine?.domainResult.handoffCause !== null
          ) {
            throw new Error(
              `Expected handoff cause null, got ${turn.processing.currentEngine?.domainResult.handoffCause}`,
            );
          }
          if (turn.stateAfter?.knownFacts?.timePreference != null) {
            throw new Error(
              `Expected timePreference removed, got ${turn.stateAfter?.knownFacts?.timePreference}`,
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // SMOKE-H: Mechanical confirmation
  {
    id: "SMOKE-H",
    title:
      "Case H: Mechanical confirmation (0 model calls, appointment created)",
    category: "STANDARD_BOOKING",
    evaluationScope: "ENGINEERING_BOUNDARY",
    description:
      "Slot digit selection '1' confirmed mechanically without model calls",
    setup: {
      todayRef: "2026-10-20",
      businessConfig: { timezone: "Africa/Cairo" },
    },
    referenceInstant: "2026-10-20T10:00:00.000+03:00",
    mockResponses: {
      1: {
        body: mockBooking({
          content: "المواعيد المتاحة غداً الأربعاء: 1. الساعة 10:00 صباحاً",
          service: "كشف أسنان",
          date: "2026-10-21",
          factUpdates: [
            { key: "service", operation: "set", value: "كشف أسنان" },
            { key: "date", operation: "set", value: "2026-10-21" },
          ],
        }),
      },
    },
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "1",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (turn.processing.currentEngine?.httpAttempts.count !== 0) {
            throw new Error(
              `Mechanical confirmation must spend 0 HTTP attempts, spent ${turn.processing.currentEngine?.httpAttempts.count}`,
            );
          }
          if (!turn.diagnostics.appointmentCreated) {
            throw new Error("Expected appointment creation on slot selection");
          }
        },
      },
    ],
    expectations: {
      shouldBook: true,
    },
  },
];
