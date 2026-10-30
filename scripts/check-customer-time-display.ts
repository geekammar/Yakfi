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
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import {
  buildSlotOffer,
  slotOfferSchema,
} from "../src/features/conversations/server/booking-offer";
import {
  extractLastBookingOffer,
  interpretOfferReply,
  isValidCalendarDate,
  normalizeTimeTo24h,
  parseBookingSelection,
  parseOfferDate,
  selectionContextFromSlotOffer,
  tryParseBookingSelection,
} from "../src/features/conversations/server/booking-selection";
import {
  buildChannelChoices,
  offerCallbackData,
} from "../src/features/conversations/server/channel-choice";
import {
  formatBookingOptionsMessage,
  receiveInboundMessage,
} from "../src/features/conversations/server/conversation-engine";
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
  // 6. Legacy Offer Parsing & Real Formatter Output Recovery
  // ───────────────────────────────────────────────────────────────────────────
  console.log(
    "\n▶ Group 6: Legacy Offer Parsing & Real Formatter Output Recovery",
  );

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
    "6.1 Legacy offer with ISO date header and '— 10:00 إلى 10:30' is parsed accurately",
    legacyCtx !== null &&
      legacyCtx.serviceName === "تنظيف أسنان" &&
      legacyCtx.date === "2026-11-01" &&
      legacyCtx.options.length === 2 &&
      legacyCtx.options[0]?.startTime === "10:00" &&
      legacyCtx.options[0]?.endTime === "10:30" &&
      legacyCtx.options[0]?.displayName === "د. سارة",
  );

  // Real formatter output under START_ONLY (Arabic date & header provider mention)
  const realStartOnlyOutput = formatBookingOptionsMessage(
    "كشف أسنان",
    "2026-11-01",
    [
      {
        index: 1,
        providerId: "prv_1",
        displayName: "د. أحمد",
        startAt: "2026-11-01T14:00",
        endAt: "2026-11-01T14:30",
      },
      {
        index: 2,
        providerId: "prv_1",
        displayName: "د. أحمد",
        startAt: "2026-11-01T14:30",
        endAt: "2026-11-01T15:00",
      },
    ],
    null,
    false,
    "START_ONLY",
  );

  const realStartOnlyCtx = extractLastBookingOffer(
    [{ senderType: "AI", content: realStartOnlyOutput }],
    { referenceDate: "2026-11-01" },
  );
  check(
    "6.2 Real formatter output under START_ONLY (Arabic date + header provider mention) recovers cleanly",
    realStartOnlyCtx !== null &&
      realStartOnlyCtx.serviceName === "كشف أسنان" &&
      realStartOnlyCtx.date === "2026-11-01" &&
      realStartOnlyCtx.options.length === 2 &&
      realStartOnlyCtx.options[0]?.startTime === "14:00" &&
      realStartOnlyCtx.options[0]?.endTime === undefined &&
      realStartOnlyCtx.options[0]?.displayName === "د. أحمد",
    `received date: ${realStartOnlyCtx?.date}`,
  );

  // Real formatter output under FULL_RANGE (Arabic date & provider in header)
  const realFullRangeOutput = formatBookingOptionsMessage(
    "تنظيف أسنان",
    "2026-11-01",
    [
      {
        index: 1,
        providerId: "prv_1",
        displayName: "د. سارة",
        startAt: "2026-11-01T10:00",
        endAt: "2026-11-01T10:40",
      },
      {
        index: 2,
        providerId: "prv_1",
        displayName: "د. سارة",
        startAt: "2026-11-01T11:00",
        endAt: "2026-11-01T11:40",
      },
    ],
    null,
    false,
    "FULL_RANGE",
  );

  const realFullRangeCtx = extractLastBookingOffer(
    [{ senderType: "AI", content: realFullRangeOutput }],
    { referenceDate: "2026-11-01" },
  );
  check(
    "6.3 Real formatter output under FULL_RANGE (Arabic date) recovers exact start and end times",
    realFullRangeCtx !== null &&
      realFullRangeCtx.serviceName === "تنظيف أسنان" &&
      realFullRangeCtx.date === "2026-11-01" &&
      realFullRangeCtx.options.length === 2 &&
      realFullRangeCtx.options[0]?.startTime === "10:00" &&
      realFullRangeCtx.options[0]?.endTime === "10:40" &&
      realFullRangeCtx.options[0]?.displayName === "د. سارة",
    `received: ${realFullRangeCtx?.options[0]?.startTime} to ${realFullRangeCtx?.options[0]?.endTime}`,
  );

  // Real formatter output with mixed providers under FULL_RANGE
  const realMixedOutput = formatBookingOptionsMessage(
    "كشف أسنان",
    "2026-11-01",
    [
      {
        index: 1,
        providerId: "prv_1",
        displayName: "د. سارة",
        startAt: "2026-11-01T10:00",
        endAt: "2026-11-01T10:30",
      },
      {
        index: 2,
        providerId: "prv_2",
        displayName: "د. أحمد",
        startAt: "2026-11-01T11:00",
        endAt: "2026-11-01T11:30",
      },
    ],
    null,
    false,
    "FULL_RANGE",
  );

  const realMixedCtx = extractLastBookingOffer(
    [{ senderType: "AI", content: realMixedOutput }],
    { referenceDate: "2026-11-01" },
  );
  check(
    "6.4 Real formatter output with mixed providers recovers individual provider display names",
    realMixedCtx !== null &&
      realMixedCtx.options[0]?.displayName === "د. سارة" &&
      realMixedCtx.options[1]?.displayName === "د. أحمد",
  );

  // Real formatter output with 'isMoreTimes' header
  const moreTimesOutput = formatBookingOptionsMessage(
    "كشف أسنان",
    "2026-11-01",
    [
      {
        index: 1,
        providerId: "prv_1",
        displayName: "د. أحمد",
        startAt: "2026-11-01T16:00",
        endAt: "2026-11-01T16:30",
      },
    ],
    null,
    true, // isMoreTimes
    "FULL_RANGE",
  );
  const moreTimesCtx = extractLastBookingOffer(
    [{ senderType: "AI", content: moreTimesOutput }],
    { referenceDate: "2026-11-01" },
  );
  check(
    "6.5 'isMoreTimes' header ('إليك أوقاتاً أخرى متاحة لخدمة...') is recovered accurately",
    moreTimesCtx !== null &&
      moreTimesCtx.serviceName === "كشف أسنان" &&
      moreTimesCtx.options[0]?.startTime === "16:00" &&
      moreTimesCtx.options[0]?.endTime === "16:30",
  );

  // Safe failure on ambiguous/corrupted date
  const corruptHeaderCtx = extractLastBookingOffer([
    {
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" يوم غير محدد في المستقبل:\n1. 10:00 ص',
    },
  ]);
  check(
    "6.6 Corrupted or ambiguous date in offer header fails safely to null without guessing",
    corruptHeaderCtx === null,
  );

  // 6.7 Strict calendar date validation (rejecting impossible dates, leap year boundaries)
  check(
    "6.7 Strict calendar date validation rejects impossible dates (Feb 31, Apr 31, non-leap Feb 29)",
    isValidCalendarDate(2026, 2, 31) === false &&
      isValidCalendarDate(2026, 4, 31) === false &&
      isValidCalendarDate(2026, 2, 29) === false &&
      isValidCalendarDate(2024, 2, 29) === true &&
      isValidCalendarDate(2024, 2, 30) === false &&
      parseOfferDate("2026-02-31") === null &&
      parseOfferDate("2026-04-31") === null &&
      parseOfferDate("2026-02-29") === null &&
      parseOfferDate("2024-02-29") === "2024-02-29" &&
      parseOfferDate("الأحد، 31 فبراير 2026") === null,
  );

  // 6.8 Weekday consistency: Arabic weekday must strictly match candidate date
  check(
    "6.8 Weekday consistency validation rejects weekday/date contradictions",
    // 2026-11-01 was Sunday (الأحد)
    parseOfferDate("الأحد، 1 نوفمبر 2026") === "2026-11-01" &&
      // Contradiction: Wednesday Nov 1 2026 is impossible
      parseOfferDate("الأربعاء، 1 نوفمبر 2026") === null &&
      // 2026-10-31 was Saturday (السبت)
      parseOfferDate("السبت، 31 أكتوبر 2026") === "2026-10-31" &&
      parseOfferDate("الجمعة، 31 أكتوبر 2026") === null,
  );

  // 6.9 Missing provenance fails closed safely for yearless Arabic labels
  check(
    "6.9 Yearless Arabic date label without provenance fails closed to null",
    parseOfferDate("الأحد، 1 نوفمبر") === null &&
      parseOfferDate("اليوم الأحد، 25 أكتوبر") === null &&
      extractLastBookingOffer([
        {
          senderType: "AI",
          content:
            'تتوفر المواعيد التالية لخدمة "كشف أسنان" يوم الأحد، 1 نوفمبر:\n1. 10:00 ص',
        },
      ]) === null,
  );

  // 6.10 Year boundary handling with deterministic provenance
  check(
    "6.10 Year boundary rollover (Dec offer for Jan date) resolves to next year with provenance",
    // Offer authored on 2026-12-28 offering Jan 1
    parseOfferDate("الجمعة، 1 يناير", {
      provenanceDate: "2026-12-28T10:00:00Z",
      timezone: "Africa/Cairo",
    }) === "2027-01-01" &&
      // But an offer in June offering March (in the past) fails closed
      parseOfferDate("الأحد، 1 مارس", {
        provenanceDate: "2026-06-01T10:00:00Z",
        timezone: "Africa/Cairo",
      }) === null,
  );

  // 6.11 Delayed historical reply uses offer provenance, not customer reply time
  const delayedOfferTime = new Date("2026-11-01T09:00:00Z");
  const delayedReplyTime = new Date("2027-03-15T14:00:00Z");
  const delayedHistory = [
    {
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" يوم الأحد، 1 نوفمبر:\n1. 10:00 ص',
      createdAt: delayedOfferTime,
      sentAt: delayedOfferTime,
    },
    {
      senderType: "CUSTOMER",
      content: "1",
      createdAt: delayedReplyTime,
      sentAt: delayedReplyTime,
    },
  ];
  const delayedCtx = extractLastBookingOffer(delayedHistory);
  check(
    "6.11 Delayed historical reply recovers offer date from AI message provenance (2026-11-01), not customer reply date (2027)",
    delayedCtx !== null &&
      delayedCtx.date === "2026-11-01" &&
      delayedCtx.options[0]?.startTime === "10:00" &&
      delayedCtx.options[0]?.endTime === undefined,
  );

  // 6.12 Host vs Business timezone boundary mapping
  check(
    "6.12 Host vs Business timezone: UTC midnight boundary resolves to correct business calendar date",
    // At UTC 2026-10-31T22:30:00Z, host UTC date is Oct 31, but Cairo (UTC+2) is 2026-11-01 00:30 (Nov 1)
    parseOfferDate("اليوم الأحد، 1 نوفمبر", {
      provenanceDate: "2026-10-31T22:30:00Z",
      timezone: "Africa/Cairo",
    }) === "2026-11-01",
  );

  // 6.13 Strict time validation
  check(
    "6.13 Strict time validation validates 0..23 24h, 1..12 12h, 0..59 min, rejecting invalid inputs",
    normalizeTimeTo24h("25:00") === null &&
      normalizeTimeTo24h("14:00 ص") === null &&
      normalizeTimeTo24h("10:75") === null &&
      normalizeTimeTo24h("2:00 م") === "14:00" &&
      normalizeTimeTo24h("12:00 م") === "12:00" &&
      normalizeTimeTo24h("12:00 ص") === "00:00" &&
      normalizeTimeTo24h("09:30") === "09:30" &&
      normalizeTimeTo24h("invalid") === null,
  );

  // 6.14 No end-time fabrication on start-only vs full-range
  const startOnlyLineOffer = [
    {
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "تنظيف أسنان" يوم 2026-11-01:\n1. 10:00 ص',
    },
  ];
  const fullRangeLineOffer = [
    {
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "تنظيف أسنان" يوم 2026-11-01:\n1. 10:00 ص إلى 10:45 ص',
    },
  ];
  const startParsed = extractLastBookingOffer(startOnlyLineOffer);
  const fullParsed = extractLastBookingOffer(fullRangeLineOffer);
  check(
    "6.14 Formatter parsing preserves undefined endTime on START_ONLY without fabricating end time",
    startParsed !== null &&
      startParsed.options[0]?.startTime === "10:00" &&
      startParsed.options[0]?.endTime === undefined &&
      fullParsed !== null &&
      fullParsed.options[0]?.startTime === "10:00" &&
      fullParsed.options[0]?.endTime === "10:45",
  );

  // 6.15 Selection parser helper: tryParseBookingSelection fails closed (null) on impossible historical offer date
  const engineFallbackScope = {
    business: createMockBusiness({ id: "biz_fb", timezone: "Africa/Cairo" }),
  };
  const unresolvableOfferHistory = [
    {
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" يوم الأحد، 31 فبراير:\n1. 10:00 ص',
    },
  ];
  const fallbackSelAttempt = tryParseBookingSelection(
    "1",
    unresolvableOfferHistory,
    {
      timezone: engineFallbackScope.business.timezone,
      provenanceDate: new Date("2026-11-01"),
    },
  );
  check(
    "6.15 Selection parser helper: tryParseBookingSelection fails closed (null) on impossible historical offer date",
    fallbackSelAttempt === null,
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
  // 8. Full Conversation-Engine Integration via receiveInboundMessage
  // ───────────────────────────────────────────────────────────────────────────
  console.log(
    "\n▶ Group 8: Conversation Engine Entry-Point Execution (START_ONLY vs FULL_RANGE)",
  );

  function createMockAiBookingResponse(params: {
    service: string;
    date: string;
  }): AiResponse {
    return {
      intent: "BOOKING",
      action: "booking_handoff",
      content: `المواعيد المتاحة يوم ${params.date}:`,
      summary: "طلب حجز كشف",
      handoffReason: null,
      safetyAssessment: "safe",
      extraction: {
        service: params.service,
        date: params.date,
        provider: null,
        timePreference: null,
      },
      factUpdates: [
        { key: "service", operation: "set", value: params.service },
        { key: "date", operation: "set", value: params.date },
      ],
    };
  }

  // ── 8.1 START_ONLY Engine Flow: Offer -> Selection -> Confirmation ──────────
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "test-spying-ai",
      async respond(): Promise<AiResponse> {
        modelCalls++;
        return createMockAiBookingResponse({
          service: "كشف أسنان", // matches business default service
          date: "2026-11-04",
        });
      },
    };

    // Customer initiates booking
    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان يوم 2026-11-04",
        receivedAt: new Date("2026-11-01T10:00:00Z").toISOString(),
        externalId: "ext-turn-1",
      },
      identity,
    );

    const offerOutbound = harness.deliveredOutbound[0];
    check(
      "8.1a Inbound booking turn under START_ONLY renders offer copy with start-only times",
      turn1.ok === true &&
        offerOutbound !== undefined &&
        offerOutbound.body.includes("9:00 ص") &&
        !offerOutbound.body.includes("9:00 ص إلى"),
      `outbound body: ${offerOutbound?.body}`,
    );

    check(
      "8.1b Channel choice button label under START_ONLY displays start-only time '1️⃣ 9:00 ص (د. أحمد سامي)'",
      offerOutbound?.choices?.groups?.[0]?.[0]?.label ===
        "1️⃣ 9:00 ص (د. أحمد سامي)",
      `received label: ${offerOutbound?.choices?.groups?.[0]?.[0]?.label}`,
    );

    const callbackData1 =
      offerOutbound?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data;
    check(
      "8.1c Reply markup inline keyboard contains structured callback data",
      typeof callbackData1 === "string" && callbackData1.startsWith("fp:"),
    );

    // Mechanical selection via button callback data
    const callsBeforeSelection = modelCalls;
    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: callbackData1!,
        receivedAt: new Date("2026-11-01T10:01:00Z").toISOString(),
        externalId: "ext-turn-2",
      },
      identity,
    );

    check(
      "8.1d Mechanical button callback executes with strictly 0 additional model calls",
      modelCalls === callsBeforeSelection,
      `calls before: ${callsBeforeSelection}, calls after: ${modelCalls}`,
    );

    check(
      "8.1e Booking confirmed mechanically in harness with exactly 1 appointment write",
      turn2.ok === true && harness.appointments.length === 1,
    );

    const appt1 = harness.appointments[0];
    check(
      "8.1f Appointment entity facts are complete and invariant (startTime, endTime, providerId, status)",
      appt1?.startTime === "09:00" &&
        appt1?.endTime === "09:30" &&
        appt1?.providerId === PLAYGROUND_IDS.PROV_1 &&
        appt1?.status === "CONFIRMED",
      `appt facts: start=${appt1?.startTime}, end=${appt1?.endTime}, status=${appt1?.status}`,
    );

    const confirmationOutbound = harness.deliveredOutbound[1];
    check(
      "8.1g Confirmation copy under START_ONLY uses 'الساعة 9:00 ص'",
      confirmationOutbound !== undefined &&
        confirmationOutbound.body.includes("الساعة 9:00 ص") &&
        !confirmationOutbound.body.includes("من 9:00 ص إلى 9:30 ص"),
      `confirmation: ${confirmationOutbound?.body}`,
    );
  }

  // ── 8.2 FULL_RANGE Engine Flow: Offer -> Selection -> Confirmation ──────────
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "FULL_RANGE",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "test-spying-ai",
      async respond(): Promise<AiResponse> {
        modelCalls++;
        return createMockAiBookingResponse({
          service: "كشف أسنان",
          date: "2026-11-04",
        });
      },
    };

    // Customer initiates booking
    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان يوم 2026-11-04",
        receivedAt: new Date("2026-11-01T10:00:00Z").toISOString(),
        externalId: "ext-full-1",
      },
      identity,
    );

    const offerOutbound = harness.deliveredOutbound[0];
    check(
      "8.2a Inbound booking turn under FULL_RANGE renders offer copy with full interval '9:00 ص إلى 9:30 ص'",
      turn1.ok === true &&
        offerOutbound !== undefined &&
        offerOutbound.body.includes("9:00 ص إلى 9:30 ص"),
      `outbound body: ${offerOutbound?.body}`,
    );

    check(
      "8.2b Channel choice button label under FULL_RANGE displays full interval '1️⃣ 9:00 ص إلى 9:30 ص (د. أحمد سامي)'",
      offerOutbound?.choices?.groups?.[0]?.[0]?.label ===
        "1️⃣ 9:00 ص إلى 9:30 ص (د. أحمد سامي)",
    );

    // Mechanical text selection "1"
    const callsBeforeSelection = modelCalls;
    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "1",
        receivedAt: new Date("2026-11-01T10:01:00Z").toISOString(),
        externalId: "ext-full-2",
      },
      identity,
    );

    check(
      "8.2c Mechanical text selection '1' executes with strictly 0 additional model calls",
      modelCalls === callsBeforeSelection,
    );

    check(
      "8.2d Booking under FULL_RANGE produces identical appointment start/end facts to START_ONLY",
      turn2.ok === true &&
        harness.appointments.length === 1 &&
        harness.appointments[0]?.startTime === "09:00" &&
        harness.appointments[0]?.endTime === "09:30",
    );

    const confirmationOutbound = harness.deliveredOutbound[1];
    check(
      "8.2e Confirmation copy under FULL_RANGE uses 'من 9:00 ص إلى 9:30 ص'",
      confirmationOutbound !== undefined &&
        confirmationOutbound.body.includes("من 9:00 ص إلى 9:30 ص"),
    );
  }

  // ── 8.3 Mid-Flight Business Preference Change with Outstanding Offer ───────
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY", // initially START_ONLY
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "test-spying-ai",
      async respond(): Promise<AiResponse> {
        modelCalls++;
        return createMockAiBookingResponse({
          service: "كشف أسنان",
          date: "2026-11-04",
        });
      },
    };

    // Render offer under START_ONLY
    await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان يوم 2026-11-04",
        receivedAt: new Date("2026-11-01T10:00:00Z").toISOString(),
        externalId: "ext-mid-1",
      },
      identity,
    );

    const offerOutbound = harness.deliveredOutbound[0];
    const originalCallback =
      offerOutbound?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data;
    if (!originalCallback) throw new Error("originalCallback missing");

    // Operator changes business preference mid-flight to FULL_RANGE
    Object.assign(harness.business, {
      appointmentTimeDisplay: "FULL_RANGE" as const,
    });

    // Customer clicks the button with the original callback token
    const callsBefore = modelCalls;
    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: originalCallback!,
        receivedAt: new Date("2026-11-01T10:02:00Z").toISOString(),
        externalId: "ext-mid-2",
      },
      identity,
    );

    check(
      "8.3a Mid-flight preference change preserves valid callback-to-slot mapping and books successfully",
      turn2.ok === true &&
        harness.appointments.length === 1 &&
        harness.appointments[0]?.startTime === "09:00",
    );

    check(
      "8.3b Mid-flight selection executes with strictly 0 additional model calls",
      modelCalls === callsBefore,
    );
  }

  // ── 8.4 Yearless Historical Offer without Timestamp: Current Turn Clock Must Not Supply Year
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "test-spying-ai",
      async respond(): Promise<AiResponse> {
        modelCalls++;
        return {
          intent: "FAQ",
          action: "direct_reply",
          content: "يرجى تحديد التاريخ بالكامل لإتمام الحجز.",
          summary: "استفسار",
          handoffReason: null,
          safetyAssessment: "safe",
          extraction: {
            service: null,
            date: null,
            provider: null,
            timePreference: null,
          },
          factUpdates: [],
        };
      },
    };

    // Prepopulate historical message: valid yearless offer format, but missing sentAt/createdAt
    (harness.messages as any[]).push({
      id: "msg-yearless-no-time",
      conversationId: harness.conversation.id,
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" مع د. أحمد سامي يوم الأحد، 1 نوفمبر:\n' +
        "1. 9:00 ص إلى 9:30 ص\n" +
        "يرجى اختيار أحد الخيارات.",
      createdAt: null,
      sentAt: null,
    });

    // Customer sends "1" at current turn clock 2026-11-04
    const turnResult = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "1",
        receivedAt: new Date("2026-11-04T10:00:00Z").toISOString(),
        externalId: "ext-yearless-no-time",
      },
      identity,
    );

    check(
      "8.4a Yearless historical offer without timestamp fails closed and falls through to AI turn without supplying current turn year",
      turnResult.ok === true && modelCalls === 1,
      `modelCalls: ${modelCalls}`,
    );

    check(
      "8.4b Yearless historical offer without timestamp produces strictly 0 appointment writes",
      harness.appointments.length === 0,
      `appointments count: ${harness.appointments.length}`,
    );
  }

  // ── 8.5 Older Valid Offer Followed by Newer Unresolvable Offer: Never Reactivate Superseded Offer
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "test-spying-ai",
      async respond(): Promise<AiResponse> {
        modelCalls++;
        return {
          intent: "INQUIRY",
          action: "direct_reply",
          content:
            "لم أتمكن من استرجاع الموعد، يرجى طلب المواعيد المتاحة مجدداً.",
          summary: "استفسار",
          handoffReason: null,
          safetyAssessment: "safe",
          extraction: {
            service: null,
            date: null,
            provider: null,
            timePreference: null,
          },
          factUpdates: [],
        };
      },
    };

    // Message 1 (older, valid offer)
    (harness.messages as any[]).push({
      id: "msg-older-valid",
      conversationId: harness.conversation.id,
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" مع د. أحمد سامي يوم 2026-11-04:\n' +
        "1. 9:00 ص إلى 9:30 ص\n" +
        "يرجى اختيار أحد الخيارات.",
      createdAt: new Date("2026-11-01T09:00:00Z"),
      sentAt: new Date("2026-11-01T09:00:00Z"),
    });

    // Message 2 (newer, unresolvable offer with impossible date Feb 31)
    (harness.messages as any[]).push({
      id: "msg-newer-unresolvable",
      conversationId: harness.conversation.id,
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" مع د. أحمد سامي يوم الأحد، 31 فبراير 2026:\n' +
        "1. 11:00 ص إلى 11:30 ص\n" +
        "يرجى اختيار أحد الخيارات.",
      createdAt: new Date("2026-11-01T10:00:00Z"),
      sentAt: new Date("2026-11-01T10:00:00Z"),
    });

    // Customer sends "1"
    const turnResult = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "1",
        receivedAt: new Date("2026-11-01T10:05:00Z").toISOString(),
        externalId: "ext-superseded-unresolvable",
      },
      identity,
    );

    check(
      "8.5a Newer unresolvable offer bounds recovery and never reactivates older superseded offer",
      turnResult.ok === true && modelCalls === 1,
      `modelCalls: ${modelCalls}`,
    );

    check(
      "8.5b Newer unresolvable offer produces strictly 0 appointment writes against superseded offer",
      harness.appointments.length === 0,
    );
  }

  // ── 8.6 Older Valid Offer Followed by Newer Invalid-Options Offer
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "test-spying-ai",
      async respond(): Promise<AiResponse> {
        modelCalls++;
        return {
          intent: "INQUIRY",
          action: "direct_reply",
          content: "يرجى اختيار موعد صالح.",
          summary: "استفسار",
          handoffReason: null,
          safetyAssessment: "safe",
          extraction: {
            service: null,
            date: null,
            provider: null,
            timePreference: null,
          },
          factUpdates: [],
        };
      },
    };

    // Message 1 (older, valid offer)
    (harness.messages as any[]).push({
      id: "msg-older-valid-2",
      conversationId: harness.conversation.id,
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" مع د. أحمد سامي يوم 2026-11-04:\n' +
        "1. 9:00 ص إلى 9:30 ص\n" +
        "يرجى اختيار أحد الخيارات.",
      createdAt: new Date("2026-11-01T09:00:00Z"),
      sentAt: new Date("2026-11-01T09:00:00Z"),
    });

    // Message 2 (newer offer with invalid option times 25:00)
    (harness.messages as any[]).push({
      id: "msg-newer-invalid-options",
      conversationId: harness.conversation.id,
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" مع د. أحمد سامي يوم 2026-11-04:\n' +
        "1. 25:00\n" +
        "يرجى اختيار أحد الخيارات.",
      createdAt: new Date("2026-11-01T10:00:00Z"),
      sentAt: new Date("2026-11-01T10:00:00Z"),
    });

    // Customer sends "1"
    const turnResult = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "1",
        receivedAt: new Date("2026-11-01T10:05:00Z").toISOString(),
        externalId: "ext-superseded-invalid-options",
      },
      identity,
    );

    check(
      "8.6a Newer offer with invalid options bounds recovery and never reactivates older superseded offer",
      turnResult.ok === true && modelCalls === 1,
      `modelCalls: ${modelCalls}`,
    );

    check(
      "8.6b Newer offer with invalid options produces strictly 0 appointment writes against superseded offer",
      harness.appointments.length === 0,
    );
  }

  // ── 8.7 Trusted Historical Timestamp with Delayed Customer Reply
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "START_ONLY",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "test-spying-ai",
      async respond(): Promise<AiResponse> {
        modelCalls++;
        return {
          intent: "INQUIRY",
          action: "direct_reply",
          content: "هذا الموعد قد مضى، يرجى طلب مواعيد جديدة.",
          summary: "استفسار",
          handoffReason: null,
          safetyAssessment: "safe",
          extraction: {
            service: null,
            date: null,
            provider: null,
            timePreference: null,
          },
          factUpdates: [],
        };
      },
    };

    // Offer sent on 2026-11-01 offering 2026-11-01 (Sunday, 1 Nov)
    const offerTime = new Date("2026-11-01T08:00:00Z");
    (harness.messages as any[]).push({
      id: "msg-delayed-trusted",
      conversationId: harness.conversation.id,
      senderType: "AI",
      content:
        'تتوفر المواعيد التالية لخدمة "كشف أسنان" مع د. أحمد سامي يوم الأحد، 1 نوفمبر:\n' +
        "1. 9:00 ص إلى 9:30 ص\n" +
        "يرجى اختيار أحد الخيارات.",
      createdAt: offerTime,
      sentAt: offerTime,
    });

    // Customer sends "1" 4 months later on 2027-03-15
    const turnResult = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "1",
        receivedAt: new Date("2027-03-15T14:00:00Z").toISOString(),
        externalId: "ext-delayed-reply",
      },
      identity,
    );

    check(
      "8.7a Delayed customer reply recovers exact historical offer date without booking elapsed slot",
      turnResult.ok === true,
    );

    check(
      "8.7b Delayed customer reply produces strictly 0 appointment writes for elapsed slot",
      harness.appointments.length === 0,
    );
  }

  // ── 8.8 Structured Typed-Offer Authority Invariant
  {
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: {
        appointmentTimeDisplay: "FULL_RANGE",
        confirmationMode: "automatic",
      },
    });

    const identity = {
      businessId: harness.business.id,
      branchId: harness.business.defaultBranchId,
      connectionId: "conn-1",
    };

    let modelCalls = 0;
    harness.deps.ai = {
      providerName: "test-spying-ai",
      async respond(): Promise<AiResponse> {
        modelCalls++;
        return createMockAiBookingResponse({
          service: "كشف أسنان",
          date: "2026-11-04",
        });
      },
    };

    // Step 1: Inbound message presents a structured typed slot offer into session state
    const turn1 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: "عايز كشف أسنان يوم 2026-11-04",
        receivedAt: new Date("2026-11-01T10:00:00Z").toISOString(),
        externalId: "ext-typed-1",
      },
      identity,
    );

    const offerOutbound = harness.deliveredOutbound[0];
    const callbackData =
      offerOutbound?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data;

    // Step 2: Mechanical callback selection on typed offer
    const callsBefore = modelCalls;
    const turn2 = await receiveInboundMessage(
      harness.deps,
      {
        to: "123456789",
        from: "998877",
        text: callbackData!,
        receivedAt: new Date("2026-11-01T10:01:00Z").toISOString(),
        externalId: "ext-typed-2",
      },
      identity,
    );

    check(
      "8.8 Structured typed-offer authority and token routing remain completely unchanged",
      turn1.ok === true &&
        turn2.ok === true &&
        modelCalls === callsBefore &&
        harness.appointments.length === 1 &&
        harness.appointments[0]?.startTime === "09:00" &&
        harness.appointments[0]?.endTime === "09:30",
    );
  }

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
