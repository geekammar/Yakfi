/**
 * FlowPilot Conversation Playground — 38 Golden Scenarios Corpus
 * Non-negotiable DECISION 0.1, 0.4, 0.5 (CONV-PLAY-01 Checkpoint 10)
 */

import { PLAYGROUND_IDS } from "./harness";
import type { ScenarioDefinition } from "./types";

export const GOLDEN_SCENARIOS: ScenarioDefinition[] = [
  // =========================================================================
  // Category 1: STANDARD_BOOKING (5 Scenarios)
  // =========================================================================
  {
    id: "GS-01",
    title: "حجز تلقائي مع خدمة نشطة واحدة دون أسئلة إضافية",
    category: "STANDARD_BOOKING",
    description:
      "عند وجود خدمة نشطة واحدة فقط، يجب اختيارها تلقائياً وعرض المواعيد فوراً.",
    setup: {
      services: [
        {
          id: PLAYGROUND_IDS.SERV_DENTAL,
          name: "كشف أسنان",
          price: 200,
          currency: "EGP",
          durationMinutes: 30,
          isActive: true,
        },
      ],
    },
    turns: [
      {
        input: "عايز احجز موعد بكرة",
        expectedAction: "AI_REPLY",
        forbiddenOutboundContains: ["اختار الخدمة", "تحديد الخدمة"],
      },
    ],
    expectations: {
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-02",
    title: "طلب حجز بدون تحديد خدمة مع وجود خدمات متعددة وبدون خدمة افتراضية",
    category: "STANDARD_BOOKING",
    description:
      "عند عدم تفعيل الخدمة الافتراضية، يجب عرض قائمة الخدمات المتاحة للعميل للاختيار.",
    setup: {
      businessConfig: {
        defaultServiceBookingEnabled: false,
        defaultBookingServiceId: null,
      },
    },
    turns: [
      {
        input: "عايز احجز موعد",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["كشف أسنان", "تنظيف أسنان"],
      },
    ],
    expectations: {
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-03",
    title: "الحجز السريع بالخدمة الافتراضية المفعلة",
    category: "STANDARD_BOOKING",
    description:
      "عند تفعيل الخدمة الافتراضية وطلب الحجز، تُختار الخدمة الافتراضية مباشرة وتُعرض مواعيدها.",
    setup: {
      businessConfig: {
        defaultServiceBookingEnabled: true,
        defaultBookingServiceId: PLAYGROUND_IDS.SERV_DENTAL,
      },
    },
    turns: [
      {
        input: "عايز احجز معاد بكرة الصبح",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["كشف أسنان"],
        forbiddenOutboundContains: ["اختار الخدمة"],
      },
    ],
    expectations: {
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-04",
    title: "احترام اختيار العميل الصريح للخدمة رغم تفعيل الخدمة الافتراضية",
    category: "STANDARD_BOOKING",
    description:
      "إذا طلب العميل صراحة خدمة أخرى غير الافتراضية، يجب احترام اختياره وعرض مواعيدها.",
    setup: {
      businessConfig: {
        defaultServiceBookingEnabled: true,
        defaultBookingServiceId: PLAYGROUND_IDS.SERV_DENTAL,
      },
    },
    turns: [
      {
        input: "عايز احجز تنظيف أسنان بكرة",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["تنظيف أسنان"],
      },
    ],
    expectations: {
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-05",
    title: "دورة حجز كاملة عبر خطوتين بالخدمة الافتراضية وتأكيد الحجز",
    category: "STANDARD_BOOKING",
    description:
      "الدورة الكاملة: طلب الحجز بالافتراضي ثم اختيار الموعد وتأكيده بنجاح.",
    setup: {
      businessConfig: {
        defaultServiceBookingEnabled: true,
        defaultBookingServiceId: PLAYGROUND_IDS.SERV_DENTAL,
      },
    },
    turns: [
      {
        input: "عايز احجز معاد بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "1",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["تم تأكيد حجزك", "عيادة النور"],
      },
    ],
    expectations: {
      shouldBook: true,
      maxLlmCalls: 1,
    },
  },

  // =========================================================================
  // Category 2: RELATIVE_DATES (7 Scenarios)
  // =========================================================================
  {
    id: "GS-06",
    title: "التعابير المصرية: عايز أحجز بكرة (+1 يوم)",
    category: "RELATIVE_DATES",
    description: "فهم تعبير 'بكرة' وحساب اليوم التالي بدقة.",
    turns: [
      {
        input: "عايز أحجز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (
            !turn.outbound.text.includes(
              'تتوفر المواعيد التالية لخدمة "كشف أسنان"',
            )
          ) {
            throw new Error("Did not offer appointment options for tomorrow");
          }
        },
      },
    ],
    expectations: {},
  },
  {
    id: "GS-07",
    title: "التعابير المصرية: الأسبوع الجاي (+7 أيام)",
    category: "RELATIVE_DATES",
    description: "فهم تعبير 'الأسبوع الجاي' وحساب +7 أيام.",
    turns: [
      {
        input: "ممكن أحجز كشف أسنان الأسبوع الجاي",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-08",
    title: "التعابير المصرية: الأحد بعد العصر (فترة بعد الظهر)",
    category: "RELATIVE_DATES",
    description: "استخراج تفضيل فترة 'بعد العصر' وتحديد يوم الأحد.",
    turns: [
      {
        input: "عايز كشف أسنان الأحد بعد العصر",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-09",
    title: "التعابير المصرية: فيه معاد النهاردة؟ (نفس اليوم)",
    category: "RELATIVE_DATES",
    description: "فهم تعبير 'النهاردة' وحساب تاريخ اليوم الحالي.",
    turns: [
      {
        input: "فيه معاد كشف أسنان النهاردة؟",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-10",
    title: "التعابير المصرية: بعد ٣ أسابيع (+21 يوم بالأرقام العربية)",
    category: "RELATIVE_DATES",
    description: "دقة استيعاب الأرقام المشرقية في 'بعد ٣ أسابيع'.",
    turns: [
      {
        input: "عايز كشف أسنان بعد ٣ أسابيع",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-11",
    title: "التعابير المصرية: كمان 3 أسابيع (+21 يوم بالأرقام اللاتينية)",
    category: "RELATIVE_DATES",
    description: "دقة استيعاب 'كمان 3 أسابيع'.",
    turns: [
      {
        input: "عايز كشف أسنان كمان 3 أسابيع",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-12",
    title: "التعابير المصرية: بعد بكرة (+2 يوم)",
    category: "RELATIVE_DATES",
    description: "فهم تعبير 'بعد بكرة' وحساب +2 يوم.",
    turns: [
      {
        input: "احجزلي كشف أسنان بعد بكرة",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (
            !turn.outbound.text.includes(
              'تتوفر المواعيد التالية لخدمة "كشف أسنان"',
            )
          ) {
            throw new Error(
              "Did not offer appointment options for day after tomorrow",
            );
          }
        },
      },
    ],
    expectations: {},
  },

  // =========================================================================
  // Category 3: PROVIDER_SELECTION (5 Scenarios)
  // =========================================================================
  {
    id: "GS-13",
    title: "تفضيل مقدم الخدمة: مع نفس الدكتور (تاريخ سابق)",
    category: "PROVIDER_SELECTION",
    description: "التعرف على موعد العميل السابق واختيار نفس الطبيب تلقائياً.",
    setup: {
      priorAppointment: true,
    },
    turns: [
      {
        input: "عايز أحجز كشف أسنان مع نفس الدكتور بكرة",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["د. أحمد سامي"],
      },
    ],
    expectations: {},
  },
  {
    id: "GS-14",
    title: "تفضيل مقدم الخدمة: أي مقدم خدمة متاح",
    category: "PROVIDER_SELECTION",
    description: "فهم تعبير 'أي مقدم خدمة متاح' دون فرض طبيب معين.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة مع أي مقدم خدمة متاح",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-15",
    title: "تفضيل مقدم الخدمة: اي مقدم خدمة بدون همزة",
    category: "PROVIDER_SELECTION",
    description: "تحمل التنوع الإملائي المصري في 'اي مقدم خدمة'.",
    turns: [
      {
        input: "كشف اسنان مع اي مقدم خدمة",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-16",
    title: "تفضيل مقدم الخدمة: مش فارقة",
    category: "PROVIDER_SELECTION",
    description: "فهم التعبير العامي المصري 'مش فارقة' كمطابقة لأي طبيب متاح.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة ومش فارقة مين الدكتور",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-17",
    title: "تفضيل مقدم الخدمة: تحديد طبيبة معينة بالاسم (د. سارة عادل)",
    category: "PROVIDER_SELECTION",
    description: "مطابقة اسم الطبيبة بدقة وتصفية المواعيد بناءً على جدولها.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة مع دكتورة سارة",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["د. سارة عادل"],
      },
    ],
    expectations: {},
  },

  // =========================================================================
  // Category 4: CLARIFICATION_RECOVERY (5 Scenarios)
  // =========================================================================
  {
    id: "GS-18",
    title: "استعادة التوضيح: إجابة العميل بكلمة 'كشف' بعد السؤال عن الخدمة",
    category: "CLARIFICATION_RECOVERY",
    description:
      "مطابقة الكلمة المفردة 'كشف' مع 'كشف أسنان' واستكمال الحجز فوراً.",
    turns: [
      {
        input: "عايز احجز موعد بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "كشف",
        expectedAction: "AI_REPLY",
        forbiddenOutboundContains: ["اختار الخدمة"],
      },
    ],
    expectations: {},
  },
  {
    id: "GS-19",
    title: "استعادة التوضيح: إجابة العميل بالاسم الكامل 'كشف أسنان'",
    category: "CLARIFICATION_RECOVERY",
    description: "تأكيد الخدمة واستعراض مواعيدها بعد التوضيح الكامل.",
    turns: [
      {
        input: "عايز احجز موعد بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "كشف أسنان",
        expectedAction: "AI_REPLY",
        forbiddenOutboundContains: ["اختار الخدمة"],
      },
    ],
    expectations: {},
  },
  {
    id: "GS-20",
    title: "الحفاظ على تفضيلات التاريخ والوقت المقدمة قبل تحديد الخدمة",
    category: "CLARIFICATION_RECOVERY",
    description:
      "ذكر 'بكرة الصبح' أولاً ثم تحديد الخدمة يحافظ على تفضيل الصباح واليوم التالي.",
    turns: [
      {
        input: "اهلا انا عايز احجز بكره الصبح",
        expectedAction: "AI_REPLY",
      },
      {
        input: "كشف أسنان",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["كشف أسنان"],
      },
    ],
    expectations: {},
  },
  {
    id: "GS-21",
    title: "منع حلقات التوضيح اللانهائية: التقدم المباشر فور الرد",
    category: "CLARIFICATION_RECOVERY",
    description: "التأكد من عدم تكرار نفس رسالة التوضيح بعد استجابة العميل.",
    turns: [
      {
        input: "عايز أحجز بكره",
        expectedAction: "AI_REPLY",
      },
      {
        input: "كشف",
        expectedAction: "AI_REPLY",
        assertFn: (turn, all) => {
          if (all[0] && turn.outbound.text === all[0].outbound.text) {
            throw new Error(
              "Infinite clarification loop: identical outbound repeated",
            );
          }
        },
      },
    ],
    expectations: {},
  },
  {
    id: "GS-22",
    title: "تحديد خدمة أخرى صراحة بعد التوضيح (احجز تنظيف أسنان)",
    category: "CLARIFICATION_RECOVERY",
    description:
      "السماح للعميل باختيار الخدمة المطلوبة والانتقال لمواعيدها بسلاسة.",
    turns: [
      {
        input: "عايز أحجز بكره",
        expectedAction: "AI_REPLY",
      },
      {
        input: "احجز تنظيف أسنان",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["تنظيف أسنان"],
      },
    ],
    expectations: {},
  },

  // =========================================================================
  // Category 5: SLOT_NAVIGATION (6 Scenarios)
  // =========================================================================
  {
    id: "GS-23",
    title: "تحديد الموعد بالترتيب اللفظي: 'الأول'",
    category: "SLOT_NAVIGATION",
    description: "مطابقة كلمة 'الأول' لاختيار الموعد رقم 1 وإتمام الحجز.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "الأول",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["تم تأكيد حجزك"],
        assertFn: (turn) => {
          if (turn.processing.llmCalls > 0) {
            throw new Error("Slot selection turn must use 0 LLM calls");
          }
        },
      },
    ],
    expectations: {
      shouldBook: true,
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-24",
    title: "تحديد الموعد بالترتيب اللفظي: 'التاني'",
    category: "SLOT_NAVIGATION",
    description: "مطابقة كلمة 'التاني' لاختيار الموعد رقم 2 وإتمام الحجز.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "التاني",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["تم تأكيد حجزك"],
        assertFn: (turn) => {
          if (turn.processing.llmCalls > 0) {
            throw new Error("Slot selection turn must use 0 LLM calls");
          }
        },
      },
    ],
    expectations: {
      shouldBook: true,
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-25",
    title: "تحديد الموعد بالترتيب اللفظي: 'التالت'",
    category: "SLOT_NAVIGATION",
    description: "مطابقة كلمة 'التالت' لاختيار الموعد رقم 3 وإتمام الحجز.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "التالت",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["تم تأكيد حجزك"],
        assertFn: (turn) => {
          if (turn.processing.llmCalls > 0) {
            throw new Error("Slot selection turn must use 0 LLM calls");
          }
        },
      },
    ],
    expectations: {
      shouldBook: true,
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-26",
    title: "التنقل بين الفترات: طلب 'أوقات أخرى' مع 0 مكالمات مدفوعة",
    category: "SLOT_NAVIGATION",
    description: "استعراض باقي المواعيد المتاحة لنفس اليوم بشكل قطعي تماماً.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "أوقات أخرى",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (turn.processing.llmCalls > 0) {
            throw new Error("Slot pagination must use 0 LLM calls");
          }
        },
      },
    ],
    expectations: {
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-27",
    title: "تغيير اليوم: طلب 'يوم آخر' مع الاحتفاظ بالخدمة المحددة",
    category: "SLOT_NAVIGATION",
    description:
      "إعادة ضبط اليوم وطلب تاريخ جديد مع بقاء خدمة كشف الأسنان دون إعادة سؤالها.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "يوم آخر",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (turn.processing.llmCalls > 0) {
            throw new Error("Date reset must use 0 LLM calls");
          }
        },
      },
    ],
    expectations: {
      maxLlmCalls: 1,
    },
  },
  {
    id: "GS-28",
    title: "تحديد الموعد برقم الزر أو المعرف الهيكلي 'opt_1' أو '1'",
    category: "SLOT_NAVIGATION",
    description: "دقة استيعاب معرف الزر في واتساب وتيليجرام لحجز الموعد فوراً.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "opt_1",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["تم تأكيد حجزك"],
        assertFn: (turn) => {
          if (turn.processing.llmCalls > 0) {
            throw new Error("Slot selection must use 0 LLM calls");
          }
        },
      },
    ],
    expectations: {
      shouldBook: true,
      maxLlmCalls: 1,
    },
  },

  // =========================================================================
  // Category 6: CATALOG_INQUIRY (3 Scenarios)
  // =========================================================================
  {
    id: "GS-29",
    title: "استفسار العميل: 'ايه الخدمات الموجودة عندكم؟'",
    category: "CATALOG_INQUIRY",
    description:
      "عرض دليل الخدمات النشطة وأسعارها بوضوح دون تحويل بشري وبدون تكلفة مدفوعة.",
    turns: [
      {
        input: "ايه الخدمات اللي موجوده عندكم؟",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["كشف أسنان", "تنظيف أسنان"],
        assertFn: (turn) => {
          if (turn.processing.llmCalls > 0) {
            throw new Error("Catalog inquiry must use 0 LLM calls");
          }
        },
      },
    ],
    expectations: {
      maxLlmCalls: 0,
    },
  },
  {
    id: "GS-30",
    title: "استفسار الدليل متبوعاً بحجز: الانتقال السلس من الدليل للمواعيد",
    category: "CATALOG_INQUIRY",
    description:
      "عرض الخدمات ثم اختيار العميل لخدمة معينة والانتقال لطلب الموعد.",
    turns: [
      {
        input: "ايه الخدمات المتاحة عندكم؟",
        expectedAction: "AI_REPLY",
      },
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
        forbiddenOutboundContains: ["اختار الخدمة"],
      },
    ],
    expectations: {},
  },
  {
    id: "GS-31",
    title: "استفسار الدليل: استعراض تفاصيل وقائمة الخدمات المتاحة",
    category: "CATALOG_INQUIRY",
    description: "توفير معلومات دليل الخدمات وأسعارها بوضوح.",
    turns: [
      {
        input: "ممكن قائمة الخدمات المتاحة؟",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["كشف أسنان", "تنظيف أسنان"],
      },
    ],
    expectations: {},
  },

  // =========================================================================
  // Category 7: CHANNEL_FORMATTING (4 Scenarios)
  // =========================================================================
  {
    id: "GS-32",
    title: "تنسيق تيليجرام: توليد لوحة أزرار مدمجة (inline_keyboard)",
    category: "CHANNEL_FORMATTING",
    description:
      "التأكد من احتواء ردود تيليجرام على أزرار التفاعل المدمجة للمواعيد والخدمات.",
    channel: "TELEGRAM",
    turns: [
      {
        input: "عايز احجز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
        assertFn: (turn) => {
          if (!turn.outbound.replyMarkup?.inline_keyboard) {
            throw new Error("Telegram options missing inline_keyboard");
          }
        },
      },
    ],
    expectations: {},
  },
  {
    id: "GS-33",
    title: "تفاعل تيليجرام: استلام callback_data واختيار الخدمة (service_1)",
    category: "CHANNEL_FORMATTING",
    description: "معالجة ضغطة زر تيليجرام برمز الخدمة والانتقال للمواعيد.",
    channel: "TELEGRAM",
    turns: [
      {
        input: "service_1",
        expectedAction: "AI_REPLY",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-34",
    title: "تفاعل واتساب: أولوية معرف الزر (button_reply id) على النص الطويل",
    category: "CHANNEL_FORMATTING",
    description: "قبول معرف الزر القصير '1' المرتجع من واتساب.",
    channel: "WHATSAPP",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "1",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["تم تأكيد حجزك"],
      },
    ],
    expectations: {
      shouldBook: true,
    },
  },
  {
    id: "GS-35",
    title: "تأكيد الحجز متضمن اسم المنشأة المحددة ('لدى عيادة...')",
    category: "CHANNEL_FORMATTING",
    description:
      "التأكد من احتواء ملخص التأكيد الرسمي على اسم المنشأة لضمان الثقة.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "1",
        expectedAction: "AI_REPLY",
        expectedOutboundContains: ["لدى عيادة النور لطب الأسنان"],
      },
    ],
    expectations: {
      shouldBook: true,
    },
  },

  // =========================================================================
  // Category 8: SAFETY_HANDOFF (3 Scenarios)
  // =========================================================================
  {
    id: "GS-36",
    title: "الأمان والتحويل البشري: طلب صريح للتحدث مع إنسان ('حولني لموظف')",
    category: "SAFETY_HANDOFF",
    description:
      "أولوية التحويل البشري الفوري عند طلب العميل لموظف بشري دون إصرار الآلي.",
    turns: [
      {
        input: "حولني لموظف خدمة العملاء لو سمحت",
        expectedAction: "AI_HANDOFF",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-37",
    title: "الأمان والتحويل البشري: طارئ طبي أو حالة حرجة ('عندي نزيف شديد')",
    category: "SAFETY_HANDOFF",
    description:
      "إيقاف الحوار الآلي فوراً عند رصد أي حالة طبية طارئة وتحويلها لفريق العيادة.",
    turns: [
      {
        input: "عندي نزيف شديد في اللثة ومش بيوقف",
        expectedAction: "AI_HANDOFF",
      },
    ],
    expectations: {},
  },
  {
    id: "GS-38",
    title: "عدم تكرار الحجز (Idempotency): منع تكرار الحجز عند الضغط المزدوج",
    category: "SAFETY_HANDOFF",
    description: "الضغط مرتين متتاليتين على نفس الموعد لا ينشئ موعدين مكررين.",
    turns: [
      {
        input: "عايز كشف أسنان بكرة",
        expectedAction: "AI_REPLY",
      },
      {
        input: "1",
        expectedAction: "AI_REPLY",
      },
      {
        input: "1",
        expectedAction: "DEFERRED_TO_STAFF",
        assertFn: (turn) => {
          if (turn.diagnostics.appointmentCreated) {
            throw new Error(
              "Duplicate booking created on redundant selection click",
            );
          }
        },
      },
    ],
    expectations: {
      shouldBook: true,
    },
  },
];
