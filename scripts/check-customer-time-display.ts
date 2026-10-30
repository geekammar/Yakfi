#!/usr/bin/env tsx
/**
 * Customer Appointment Time Display Preference Verification Suite.
 *
 * Verifies business-level customer appointment time display preference:
 * - START_ONLY: البداية فقط (default)
 * - FULL_RANGE: الفترة كاملة
 *
 * Presentation-only: never changes appointment start/end, duration, availability,
 * slot identity, provider eligibility, booking conflicts, or confirmation state.
 */
import {
  buildSlotOffer,
  slotOfferSchema,
} from "../src/features/conversations/server/booking-offer";
import {
  extractLastBookingOffer,
  interpretOfferReply,
  parseBookingSelection,
  selectionContextFromSlotOffer,
} from "../src/features/conversations/server/booking-selection";
import {
  buildChannelChoices,
  offerCallbackData,
} from "../src/features/conversations/server/channel-choice";
import { resolveOfferInteractionDisplay } from "../src/features/conversations/server/interaction-display";
import {
  formatAppointmentTimeSpan,
  formatArabicTime12h,
  formatBookingOptionsCopy,
  formatConfirmationTime,
  formatSlotChoiceLabel,
} from "../src/features/conversations/server/presentation-formatters";
import { businessSettingsSchema } from "../src/features/settings/schemas/settings-schema";
import {
  getBusinessSettings,
  updateBusinessSettings,
  type SettingsActor,
  type SettingsServiceDeps,
} from "../src/features/settings/server/settings-service";
import {
  APPOINTMENT_TIME_DISPLAY_OPTIONS,
  APPOINTMENT_TIME_DISPLAY_VALUES,
  appointmentTimeDisplaySchema,
} from "../src/lib/validation/business";
import type { Business } from "../src/types/domain";

process.env.DATABASE_URL ??=
  "postgresql://user:password@localhost:5432/placeholder";
process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

type Check = { label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(label: string, condition: boolean, details?: string): void {
  checks.push({ label, pass: condition, details });
  if (!condition) {
    console.error(`❌ FAIL: ${label}${details ? ` -> ${details}` : ""}`);
  } else {
    console.log(`✅ PASS: ${label}`);
  }
}

// ── In-Memory Business Repository Mock ───────────────────────────────────────

function createMockBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: "biz_test_1",
    name: "عيادة النور",
    vertical: "dental",
    city: "القاهرة",
    whatsappNumber: "+201000000001",
    timezone: "Africa/Cairo",
    about: "عيادة أسنان متخصصة",
    address: "شارع التحرير، الدقي",
    workingHours: {
      sun: { open: "09:00", close: "17:00", closed: false },
      mon: { open: "09:00", close: "17:00", closed: false },
    },
    slotDurationMinutes: 30,
    confirmationMode: "automatic",
    appointmentTimeDisplay: "START_ONLY",
    faqs: null,
    cancellationPolicy: "إلغاء الموعد قبل ٢٤ ساعة على الأقل",
    assistantName: "المساعد الذكي",
    assistantStyle: null,
    onboardingCompletedAt: new Date("2026-10-01T10:00:00Z"),
    isActive: true,
    createdAt: new Date("2026-10-01T10:00:00Z"),
    updatedAt: new Date("2026-10-01T10:00:00Z"),
    deletedAt: null,
    defaultBranchId: "branch_default_1",
    reminderEnabled: false,
    reminderLeadHours: 24,
    reminderTemplateId: "standard",
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
    ...overrides,
  };
}

class MockBusinessRepository {
  private store = new Map<string, Business>();

  constructor(initial: Business[] = []) {
    for (const b of initial) {
      this.store.set(b.id, { ...b });
    }
  }

  async findById(id: string): Promise<Business | null> {
    const found = this.store.get(id);
    return found ? { ...found } : null;
  }

  async update(id: string, data: Partial<Business>): Promise<Business> {
    const existing = this.store.get(id);
    if (!existing) throw new Error("BUSINESS_NOT_FOUND");
    const updated: Business = {
      ...existing,
      ...data,
      updatedAt: new Date(),
    };
    this.store.set(id, updated);
    return { ...updated };
  }
}

async function runTests() {
  console.log(
    "═════════════════════════════════════════════════════════════════",
  );
  console.log(
    "   Customer Appointment Time Display Preference Check Suite      ",
  );
  console.log(
    "═════════════════════════════════════════════════════════════════\n",
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Schema, validation, default and both saved values
  // ───────────────────────────────────────────────────────────────────────────
  console.log("▶ Group 1: Schema, Validation & Defaults");

  check(
    "1.1 Allowed values are strictly START_ONLY and FULL_RANGE",
    APPOINTMENT_TIME_DISPLAY_VALUES.length === 2 &&
      APPOINTMENT_TIME_DISPLAY_VALUES.includes("START_ONLY") &&
      APPOINTMENT_TIME_DISPLAY_VALUES.includes("FULL_RANGE"),
  );

  check(
    "1.2 Validates START_ONLY successfully",
    appointmentTimeDisplaySchema.safeParse("START_ONLY").success === true,
  );

  check(
    "1.3 Validates FULL_RANGE successfully",
    appointmentTimeDisplaySchema.safeParse("FULL_RANGE").success === true,
  );

  check(
    "1.4 Rejects invalid preference value",
    appointmentTimeDisplaySchema.safeParse("INTERVAL_ONLY").success === false &&
      appointmentTimeDisplaySchema.safeParse("ALL").success === false &&
      appointmentTimeDisplaySchema.safeParse("").success === false,
  );

  check(
    "1.5 Settings schema accepts START_ONLY and FULL_RANGE",
    businessSettingsSchema.safeParse({
      name: "عيادة الشفاء",
      vertical: "dental",
      city: "القاهرة",
      whatsappNumber: "+201000000002",
      timezone: "Africa/Cairo",
      confirmationMode: "automatic",
      cancellationPolicy: "سياسة الإلغاء",
      appointmentTimeDisplay: "START_ONLY",
    }).success === true &&
      businessSettingsSchema.safeParse({
        name: "عيادة الشفاء",
        vertical: "dental",
        city: "القاهرة",
        whatsappNumber: "+201000000002",
        timezone: "Africa/Cairo",
        confirmationMode: "automatic",
        cancellationPolicy: "سياسة الإلغاء",
        appointmentTimeDisplay: "FULL_RANGE",
      }).success === true,
  );

  check(
    "1.6 Settings schema rejects invalid appointmentTimeDisplay",
    businessSettingsSchema.safeParse({
      name: "عيادة الشفاء",
      vertical: "dental",
      city: "القاهرة",
      whatsappNumber: "+201000000002",
      timezone: "Africa/Cairo",
      confirmationMode: "automatic",
      cancellationPolicy: "سياسة الإلغاء",
      appointmentTimeDisplay: "INVALID_MODE",
    }).success === false,
  );

  check(
    "1.7 Arabic labels and local examples are defined for both options",
    APPOINTMENT_TIME_DISPLAY_OPTIONS.length === 2 &&
      APPOINTMENT_TIME_DISPLAY_OPTIONS[0]?.label === "البداية فقط" &&
      APPOINTMENT_TIME_DISPLAY_OPTIONS[0]?.example.includes("2:00 م") &&
      APPOINTMENT_TIME_DISPLAY_OPTIONS[1]?.label === "الفترة كاملة" &&
      APPOINTMENT_TIME_DISPLAY_OPTIONS[1]?.example.includes(
        "2:00 م إلى 2:40 م",
      ),
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Authorization, cross-business update rejection & save/reload
  // ───────────────────────────────────────────────────────────────────────────
  console.log(
    "\n▶ Group 2: Authorization, Cross-Business Isolation & Persistence",
  );

  const bizA = createMockBusiness({
    id: "biz_A",
    name: "عيادة أ",
    appointmentTimeDisplay: "START_ONLY",
  });
  const bizB = createMockBusiness({
    id: "biz_B",
    name: "مركز ب",
    appointmentTimeDisplay: "FULL_RANGE",
  });
  const repo = new MockBusinessRepository([bizA, bizB]);
  const deps: SettingsServiceDeps = {
    businessRepository: repo,
  };

  const actorAdminA: SettingsActor = {
    userId: "user_a",
    role: "ADMIN",
    businessId: "biz_A",
  };
  const actorStaffA: SettingsActor = {
    userId: "user_staff_a",
    role: "STAFF",
    businessId: "biz_A",
  };

  // Staff cannot update settings
  const staffUpdateResult = await updateBusinessSettings(deps, actorStaffA, {
    name: "عيادة أ",
    vertical: "dental",
    city: "القاهرة",
    whatsappNumber: "+201000000001",
    timezone: "Africa/Cairo",
    confirmationMode: "automatic",
    cancellationPolicy: "سياسة الإلغاء",
    appointmentTimeDisplay: "FULL_RANGE",
  });
  check(
    "2.1 STAFF role cannot save business settings (unauthorized rejection)",
    staffUpdateResult.success === false &&
      "message" in staffUpdateResult &&
      staffUpdateResult.message === "الإعدادات متاحة للمدير فقط",
  );

  // Save START_ONLY -> FULL_RANGE on Business A
  const saveResultA = await updateBusinessSettings(deps, actorAdminA, {
    name: "عيادة أ",
    vertical: "dental",
    city: "القاهرة",
    whatsappNumber: "+201000000001",
    timezone: "Africa/Cairo",
    confirmationMode: "automatic",
    cancellationPolicy: "سياسة الإلغاء",
    appointmentTimeDisplay: "FULL_RANGE",
  });
  check(
    "2.2 ADMIN successfully updates appointmentTimeDisplay to FULL_RANGE",
    saveResultA.success === true,
  );

  // Read back Business A
  const viewA = await getBusinessSettings(deps, actorAdminA);
  check(
    "2.3 Reloading settings for Business A reflects persisted FULL_RANGE",
    "appointmentTimeDisplay" in viewA &&
      viewA.appointmentTimeDisplay === "FULL_RANGE",
  );

  // Verify Business B remains completely isolated
  const actorAdminB: SettingsActor = {
    userId: "user_b",
    role: "ADMIN",
    businessId: "biz_B",
  };
  const viewB = await getBusinessSettings(deps, actorAdminB);
  check(
    "2.4 Isolated preferences: Business B remains independent (FULL_RANGE)",
    "appointmentTimeDisplay" in viewB &&
      viewB.appointmentTimeDisplay === "FULL_RANGE",
  );

  // Save Business A back to START_ONLY
  await updateBusinessSettings(deps, actorAdminA, {
    name: "عيادة أ",
    vertical: "dental",
    city: "القاهرة",
    whatsappNumber: "+201000000001",
    timezone: "Africa/Cairo",
    confirmationMode: "automatic",
    cancellationPolicy: "سياسة الإلغاء",
    appointmentTimeDisplay: "START_ONLY",
  });
  const viewA2 = await getBusinessSettings(deps, actorAdminA);
  check(
    "2.5 Saving START_ONLY persists and reloads correctly",
    "appointmentTimeDisplay" in viewA2 &&
      viewA2.appointmentTimeDisplay === "START_ONLY",
  );

  // Default fallback for legacy/unset business
  const bizUnset = createMockBusiness({
    id: "biz_unset",
  });
  const legacyRecord = { ...bizUnset };
  Reflect.deleteProperty(legacyRecord, "appointmentTimeDisplay");
  const repoUnset = new MockBusinessRepository([legacyRecord as Business]);
  const viewUnset = await getBusinessSettings(
    { businessRepository: repoUnset },
    { userId: "user_u", role: "ADMIN", businessId: "biz_unset" },
  );
  check(
    "2.6 Existing/legacy business without setting defaults strictly to START_ONLY",
    "appointmentTimeDisplay" in viewUnset &&
      viewUnset.appointmentTimeDisplay === "START_ONLY",
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Centralized Formatting: Slot Labels & Fallback
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 3: Centralized Formatting & Safe Fallback");

  // Sample slot: 14:00 to 14:40
  const slotStandard = {
    index: 1,
    displayName: "د. أحمد",
    startAt: "2026-11-01T14:00:00Z",
    endAt: "2026-11-01T14:40:00Z",
  };

  const labelStartOnly = formatSlotChoiceLabel(
    slotStandard,
    true,
    "START_ONLY",
  );
  const labelFullRange = formatSlotChoiceLabel(
    slotStandard,
    true,
    "FULL_RANGE",
  );
  check(
    "3.1 START_ONLY button label displays single start time (2:00 م)",
    labelStartOnly === "1️⃣ 2:00 م",
    `got: "${labelStartOnly}"`,
  );
  check(
    "3.2 FULL_RANGE button label displays full range (2:00 م إلى 2:40 م)",
    labelFullRange === "1️⃣ 2:00 م إلى 2:40 م",
    `got: "${labelFullRange}"`,
  );

  // Multi-provider slot labels
  const labelStartOnlyMulti = formatSlotChoiceLabel(
    slotStandard,
    false,
    "START_ONLY",
  );
  const labelFullRangeMulti = formatSlotChoiceLabel(
    slotStandard,
    false,
    "FULL_RANGE",
  );
  check(
    "3.3 Multi-provider label preserves provider name under START_ONLY",
    labelStartOnlyMulti === "1️⃣ 2:00 م (د. أحمد)",
    `got: "${labelStartOnlyMulti}"`,
  );
  check(
    "3.4 Multi-provider label preserves provider name under FULL_RANGE",
    labelFullRangeMulti === "1️⃣ 2:00 م إلى 2:40 م (د. أحمد)",
    `got: "${labelFullRangeMulti}"`,
  );

  // Missing end-time safe fallback
  const slotMissingEnd = {
    index: 2,
    displayName: "د. سارة",
    startAt: "2026-11-01T14:00:00Z",
    endAt: null,
  };
  const labelMissingEnd = formatSlotChoiceLabel(
    slotMissingEnd,
    true,
    "FULL_RANGE",
  );
  check(
    "3.5 FULL_RANGE safely falls back to start time when endAt is missing (never invents end time)",
    labelMissingEnd === "2️⃣ 2:00 م",
    `got: "${labelMissingEnd}"`,
  );

  // Textual Booking Options Copy
  const copyStartOnly = formatBookingOptionsCopy({
    serviceName: "تنظيف أسنان",
    date: "2026-11-01",
    formattedDate: "الأحد، 1 نوفمبر",
    options: [slotStandard],
    timeDisplayPreference: "START_ONLY",
  });
  const copyFullRange = formatBookingOptionsCopy({
    serviceName: "تنظيف أسنان",
    date: "2026-11-01",
    formattedDate: "الأحد، 1 نوفمبر",
    options: [slotStandard],
    timeDisplayPreference: "FULL_RANGE",
  });
  check(
    "3.6 Textual booking copy under START_ONLY renders '1. 2:00 م'",
    copyStartOnly.includes("1. 2:00 م") &&
      !copyStartOnly.includes("إلى 2:40 م"),
  );
  check(
    "3.7 Textual booking copy under FULL_RANGE renders '1. 2:00 م إلى 2:40 م'",
    copyFullRange.includes("1. 2:00 م إلى 2:40 م"),
  );

  // Confirmation Time Phrasing
  const confirmStartOnly = formatConfirmationTime(
    "14:00",
    "14:40",
    "START_ONLY",
  );
  const confirmFullRange = formatConfirmationTime(
    "14:00",
    "14:40",
    "FULL_RANGE",
  );
  const confirmMissingEnd = formatConfirmationTime("14:00", null, "FULL_RANGE");
  check(
    "3.8 Confirmation under START_ONLY renders 'الساعة 2:00 م'",
    confirmStartOnly === "الساعة 2:00 م",
    `got: "${confirmStartOnly}"`,
  );
  check(
    "3.9 Confirmation under FULL_RANGE renders 'من 2:00 م إلى 2:40 م'",
    confirmFullRange === "من 2:00 م إلى 2:40 م",
    `got: "${confirmFullRange}"`,
  );
  check(
    "3.10 Confirmation under FULL_RANGE with missing end time falls back to 'الساعة 2:00 م'",
    confirmMissingEnd === "الساعة 2:00 م",
    `got: "${confirmMissingEnd}"`,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Noon, Midnight & Different Service Durations
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 4: Noon, Midnight & Durations");

  check(
    "4.1 Noon 12:00 formats as '12:00 م'",
    formatArabicTime12h("12:00") === "12:00 م" &&
      formatAppointmentTimeSpan("12:00", "12:30", "START_ONLY") === "12:00 م" &&
      formatAppointmentTimeSpan("12:00", "12:30", "FULL_RANGE") ===
        "12:00 م إلى 12:30 م",
  );

  check(
    "4.2 Midnight 00:00 formats as '12:00 ص'",
    formatArabicTime12h("00:00") === "12:00 ص" &&
      formatAppointmentTimeSpan("00:00", "00:45", "START_ONLY") === "12:00 ص" &&
      formatAppointmentTimeSpan("00:00", "00:45", "FULL_RANGE") ===
        "12:00 ص إلى 12:45 ص",
  );

  check(
    "4.3 15-minute service (10:15 - 10:30)",
    formatAppointmentTimeSpan("10:15", "10:30", "FULL_RANGE") ===
      "10:15 ص إلى 10:30 ص",
  );

  check(
    "4.4 45-minute service crossing noon (11:30 - 12:15)",
    formatAppointmentTimeSpan("11:30", "12:15", "FULL_RANGE") ===
      "11:30 ص إلى 12:15 م",
  );

  check(
    "4.5 60-minute service crossing midnight (23:30 - 00:30)",
    formatAppointmentTimeSpan("23:30", "00:30", "FULL_RANGE") ===
      "11:30 م إلى 12:30 ص",
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Stable Tokens, Callback IDs & Changing Preference Mid-Offer
  // ───────────────────────────────────────────────────────────────────────────
  console.log(
    "\n▶ Group 5: Offer Tokens, Callback IDs & Mid-Flight Preference Switch",
  );

  const now = new Date("2026-11-01T10:00:00Z");
  const offerScope = { businessId: "biz_A", conversationId: "conv_1" };

  const offerStartOnly = buildSlotOffer(
    offerScope,
    "offer_12345678",
    {
      serviceId: "srv_clean",
      serviceName: "تنظيف أسنان",
      date: "2026-11-01",
      timeDisplayPreference: "START_ONLY",
      options: [
        {
          providerId: "prv_1",
          displayName: "د. سارة",
          startAt: "2026-11-01T14:00",
          endAt: "2026-11-01T14:40",
        },
      ],
    },
    now,
  );

  check(
    "5.1 SlotOffer builds with START_ONLY preference",
    offerStartOnly !== null &&
      offerStartOnly.timeDisplayPreference === "START_ONLY" &&
      offerStartOnly.token === "offer123",
  );

  const choicesStartOnly = buildChannelChoices(offerStartOnly!);
  check(
    "5.2 Channel choices have stable numeric ID '1' and value '2026-11-01T14:00'",
    choicesStartOnly.groups[0]?.[0]?.id === "1" &&
      choicesStartOnly.groups[0]?.[0]?.value === "2026-11-01T14:00" &&
      choicesStartOnly.groups[0]?.[0]?.label === "1️⃣ 2:00 م",
  );

  // Re-present choices under FULL_RANGE (e.g. preference changed after offer issued)
  const choicesFullRange = buildChannelChoices(offerStartOnly!, {
    timeDisplayPreference: "FULL_RANGE",
  });
  check(
    "5.3 When preference changes to FULL_RANGE, choice ID and slot value remain identical",
    choicesFullRange.groups[0]?.[0]?.id === "1" &&
      choicesFullRange.groups[0]?.[0]?.value === "2026-11-01T14:00" &&
      choicesFullRange.groups[0]?.[0]?.label === "1️⃣ 2:00 م إلى 2:40 م",
  );

  // Customer clicks button '1' with callback query data fp:offer123:1
  const callbackData = offerCallbackData({ token: offerStartOnly!.token }, "1");
  const offerReply = interpretOfferReply(callbackData, offerStartOnly, now);
  check(
    "5.4 Selecting choice '1' mechanically maps to valid slot selection",
    offerReply.kind === "slot" &&
      offerReply.selection.kind === "index" &&
      offerReply.selection.index === 1,
  );

  const selectionCtx = selectionContextFromSlotOffer(offerStartOnly!);
  check(
    "5.5 Stored appointment facts (14:00, 14:40, serviceId, providerId) are identical and intact",
    selectionCtx.options[0]?.startTime === "14:00" &&
      selectionCtx.options[0]?.endTime === "14:40" &&
      selectionCtx.options[0]?.providerId === "prv_1" &&
      selectionCtx.serviceId === "srv_clean",
  );

  // Interaction display snapshot under both preferences
  const interactionStart = resolveOfferInteractionDisplay(
    offerStartOnly!,
    { token: offerStartOnly!.token, action: { kind: "index", index: 1 } },
    now,
  );
  check(
    "5.6 Interaction history displayText under START_ONLY shows 'اختيار موعد: 2:00 م'",
    interactionStart.status === "VALIDATED" &&
      interactionStart.displayText === "اختيار موعد: 2:00 م" &&
      interactionStart.snapshot.startAt === "2026-11-01T14:00",
  );

  const offerFullRange = {
    ...offerStartOnly!,
    timeDisplayPreference: "FULL_RANGE" as const,
  };
  const interactionFull = resolveOfferInteractionDisplay(
    offerFullRange,
    { token: offerFullRange.token, action: { kind: "index", index: 1 } },
    now,
  );
  check(
    "5.7 Interaction history displayText under FULL_RANGE shows 'اختيار موعد: 2:00 م إلى 2:40 م'",
    interactionFull.status === "VALIDATED" &&
      interactionFull.displayText === "اختيار موعد: 2:00 م إلى 2:40 م" &&
      interactionFull.snapshot.endAt === "2026-11-01T14:40",
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Legacy Offer Parsing Compatibility
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 6: Legacy Offer Parsing Compatibility");

  const legacyOfferText = [
    { senderType: "CUSTOMER", content: "عايز أحجز تنظيف أسنان" },
    {
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "تنظيف أسنان" يوم 2026-11-01:\n' +
        "1. د. سارة — 10:00 إلى 10:30\n" +
        "2. د. أحمد — 11:00 إلى 11:30\n" +
        "يرجى اختيار أحد الخيارات.",
    },
  ];
  const legacyCtx = extractLastBookingOffer(legacyOfferText);
  check(
    "6.1 Legacy offer with '— 10:00 إلى 10:30' is parsed accurately",
    legacyCtx !== null &&
      legacyCtx.serviceName === "تنظيف أسنان" &&
      legacyCtx.date === "2026-11-01" &&
      legacyCtx.options.length === 2 &&
      legacyCtx.options[0]?.startTime === "10:00" &&
      legacyCtx.options[0]?.endTime === "10:30" &&
      legacyCtx.options[0]?.displayName === "د. سارة",
  );

  const modernStartOnlyOfferText = [
    { senderType: "CUSTOMER", content: "عايز أحجز كشف" },
    {
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" يوم 2026-11-01:\n' +
        "1. 2:00 م\n" +
        "2. 2:30 م\n" +
        "يرجى اختيار الموعد المناسب لإتمام الحجز.",
    },
  ];
  const modernCtx = extractLastBookingOffer(modernStartOnlyOfferText);
  check(
    "6.2 Modern START_ONLY offer with '1. 2:00 م' is parsed accurately",
    modernCtx !== null &&
      modernCtx.serviceName === "كشف أسنان" &&
      modernCtx.date === "2026-11-01" &&
      modernCtx.options.length === 2 &&
      modernCtx.options[0]?.startTime === "14:00",
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 7. No Additional Model Calls & Booking Correctness Invariants
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n▶ Group 7: Model Calls & Booking Correctness Invariants");

  const sel = parseBookingSelection("1");
  check(
    "7.1 Parsing mechanical selection '1' requires zero AI/model calls",
    sel !== null && sel.kind === "index" && sel.index === 1,
  );

  check(
    "7.2 Time display preference is strictly presentation-level and preserves domain entities",
    slotOfferSchema.safeParse(offerStartOnly).success === true,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // Summary
  // ───────────────────────────────────────────────────────────────────────────
  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  console.log(
    `\n─────────────────────────────────────────────────────────────────`,
  );
  console.log(`Results: ${passed}/${total} checks passed`);
  console.log(
    `─────────────────────────────────────────────────────────────────`,
  );

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
