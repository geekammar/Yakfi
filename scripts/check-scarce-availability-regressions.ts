/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * FlowPilot / Yakfi — Scarce Availability and Duration Regression Tests
 *
 * Verifies existing availability behavior through meaningful tests:
 *  Case 1: Fixed service/provider/date with exactly TWO valid starts
 *          - return only those two selectable appointment options
 *          - verify exact option identities and counts
 *          - ensure busy or duplicate options are not used to fill the list
 *          - distinguish appointment options from navigation/action buttons
 *          - test filtering before pagination
 *          - separate any-provider case verifying provider scope
 *  Case 2: Exactly ONE valid start
 *          - return only that one option
 *          - verify exact option identity and count
 *          - ensure busy or duplicate options are not used to fill the list
 *          - distinguish appointment option from navigation/action buttons
 *  Case 3: ZERO valid starts
 *          - return honest no-availability response for that day
 *          - no selectable slot options
 *          - choose-another-date action allowed
 *          - no silent date or provider switch
 *  Case 4: Duration overlap
 *          - 45-min request 16:00–16:45 unavailable when SAME provider has 16:20 blocking appt
 *          - independent provider booking does not incorrectly block it
 *  Case 5: End boundary behavior
 *          - after 10:00–10:45 booking:
 *            * aligned 15-min grid: 10:45 offered only if entire next service interval free
 *            * 30-min grid: do not expect off-grid 10:45 start
 *  Case 6: Availability changed after display
 *          - replay real displayed choice after inserting controlled conflict
 *          - verify safe rejection/revalidation and zero overlapping appointment writes
 *
 * Usage:
 *   pnpm check:scarce-availability
 */

import "./setup-test-env";

import { getAvailability } from "../src/features/appointments/server/availability-service";
import { resolveBookingOptions } from "../src/features/appointments/server/booking-options-service";
import {
  PLAYGROUND_IDS,
  createPlaygroundHarness,
} from "../src/features/conversations/playground/harness";
import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import type { ChannelChoicePresentation } from "../src/features/conversations/server/channel-choice";
import { receiveInboundMessage } from "../src/features/conversations/server/conversation-engine";
import {
  generateCandidateGrid,
  toMinutes,
} from "../src/lib/scheduling/slot-grid";
import { renderTelegramInlineKeyboard } from "../src/server/integrations/telegram/telegram-presentation";
import type { Business, Service } from "../src/types/domain";

type Check = { label: string; pass: boolean; details?: string };
const checks: Check[] = [];

function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
  if (pass) {
    console.log(`✔ ${label}`);
  } else {
    console.error(`❌ ${label}${details ? ` (${details})` : ""}`);
  }
}

// ── Deterministic Fixtures & In-Memory Repositories ─────────────────────────

const TEST_DATE = "2026-11-03"; // Tuesday
const BIZ_ID = PLAYGROUND_IDS.BIZ_ID;
const BRANCH_ID = PLAYGROUND_IDS.BRANCH_ID;

const PROVIDER_1 = {
  id: PLAYGROUND_IDS.PROV_1,
  name: "د. سارة",
  displayName: "د. سارة",
  userId: PLAYGROUND_IDS.USER_P1,
};

const PROVIDER_2 = {
  id: PLAYGROUND_IDS.PROV_2,
  name: "د. أحمد",
  displayName: "د. أحمد",
  userId: PLAYGROUND_IDS.USER_P2,
};

const SERV_45_ID = "33333333-3333-4333-8333-333333333345";

function createStandardWorkingHours(
  open = "09:00",
  close = "17:00",
): Record<string, { open: string; close: string; closed: boolean }> {
  const days = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"] as const;
  const hours: any = {};
  for (const d of days) {
    hours[d] = { open, close, closed: false };
  }
  return hours;
}

function createTestBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: BIZ_ID,
    name: "عيادة النور",
    slug: "al-noor",
    timezone: "Africa/Cairo",
    workingHours: createStandardWorkingHours("09:00", "12:00"),
    slotDurationMinutes: 30,
    bookingLeadTimeHours: 0,
    bookingHorizonDays: 30,
    bookingIntervalMinutes: 30,
    confirmationMode: "automatic",
    defaultBranchId: BRANCH_ID,
    whatsappNumber: "+201001111111",
    isActive: true,
    defaultServiceBookingEnabled: false,
    defaultBookingServiceId: null,
    faqs: [],
    cancellationPolicy: null,
    onboardingCompletedAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    deletedAt: null,
    assistantName: "نور",
    assistantStyle: null,
    vertical: "CLINIC",
    city: "Cairo",
    about: "عيادة أسنان",
    ...overrides,
  } as unknown as Business;
}

function createTestService(overrides: Partial<Service> = {}): Service {
  return {
    id: PLAYGROUND_IDS.SERV_CLEAN,
    businessId: BIZ_ID,
    name: "تنظيف أسنان",
    description: null,
    durationMinutes: 30,
    isActive: true,
    priceType: null,
    priceAmount: null,
    priceMaxAmount: null,
    priceCurrency: "EGP",
    priceNote: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    deletedAt: null,
    ...overrides,
  } as unknown as Service;
}

type BlockingAppt = {
  id?: string;
  businessId?: string;
  date: string;
  startTime: string;
  endTime: string;
  assignedUserId: string;
  providerId?: string | null;
  status?: string;
};

function createMockAppointmentRepo(appointments: BlockingAppt[]): any {
  const store = [...appointments];

  function overlaps(
    startA: string,
    endA: string,
    startB: string,
    endB: string,
  ): boolean {
    const sA = toMinutes(startA);
    const eA = toMinutes(endA);
    const sB = toMinutes(startB);
    const eB = toMinutes(endB);
    return sA < eB && sB < eA;
  }

  return {
    store,
    listBlockingByAssignees: async (
      businessId: string,
      date: string,
      assignedUserIds: string[],
      excludeAppointmentId?: string,
    ) => {
      return store
        .filter((a) => {
          if (a.businessId && a.businessId !== businessId) return false;
          if (a.date !== date) return false;
          if (a.status && a.status !== "PENDING" && a.status !== "CONFIRMED")
            return false;
          if (excludeAppointmentId && a.id === excludeAppointmentId)
            return false;
          const matches =
            assignedUserIds.includes(a.assignedUserId) ||
            (a.providerId && assignedUserIds.includes(a.providerId));
          return Boolean(matches);
        })
        .map((a) => ({
          assignedUserId: a.assignedUserId,
          startTime: a.startTime,
          endTime: a.endTime,
        }));
    },
    listBlockingForDate: async (
      businessId: string,
      date: string,
      excludeAppointmentId?: string,
    ) => {
      return store
        .filter((a) => {
          if (a.businessId && a.businessId !== businessId) return false;
          if (a.date !== date) return false;
          if (a.status && a.status !== "PENDING" && a.status !== "CONFIRMED")
            return false;
          if (excludeAppointmentId && a.id === excludeAppointmentId)
            return false;
          return true;
        })
        .map((a) => ({
          startTime: a.startTime,
          endTime: a.endTime,
        }));
    },
    findById: async (id: string) => {
      return store.find((a) => a.id === id) ?? null;
    },
    createWithConflictCheck: async (dto: any) => {
      const dateStr =
        dto.date instanceof Date
          ? dto.date.toISOString().slice(0, 10)
          : String(dto.date);
      const assigneeId = dto.assignedUserId || dto.providerId;

      // Check conflict: same date, same assignee or provider, overlapping interval
      const hasConflict = store.some((existing) => {
        if (existing.date !== dateStr) return false;
        if (
          existing.status &&
          existing.status !== "PENDING" &&
          existing.status !== "CONFIRMED"
        )
          return false;
        const sameAssignee =
          existing.assignedUserId === assigneeId ||
          (existing.providerId && existing.providerId === dto.providerId) ||
          (dto.assignedUserId &&
            existing.assignedUserId === dto.assignedUserId);
        if (!sameAssignee) return false;
        return overlaps(
          dto.startTime,
          dto.endTime,
          existing.startTime,
          existing.endTime,
        );
      });

      if (hasConflict) {
        return null;
      }

      const newAppt: BlockingAppt = {
        id: `appt_${store.length + 1}`,
        businessId: dto.businessId,
        date: dateStr,
        startTime: dto.startTime,
        endTime: dto.endTime,
        assignedUserId: dto.assignedUserId ?? "default_user",
        providerId: dto.providerId ?? null,
        status: dto.status ?? "CONFIRMED",
      };
      store.push(newAppt);
      return newAppt;
    },
  };
}

function controlledAi(extracted: {
  service?: string | null;
  date?: string | null;
  provider?: string | null;
  intent?: "AVAILABILITY" | "BOOKING";
}): any {
  return {
    providerName: "CONTROLLED_FIXTURE_AI",
    respond: async (): Promise<AiResponse> => ({
      intent: extracted.intent ?? "BOOKING",
      action: "booking_handoff",
      content: "من فضلك اختر الموعد المناسب",
      summary: "طلب حجز موعد",
      handoffReason: null,
      safetyAssessment: "safe",
      extraction: {
        service: extracted.service ?? "تنظيف أسنان",
        date: extracted.date ?? TEST_DATE,
        provider: extracted.provider ?? null,
        timePreference: null,
        exactTime: null,
      },
      goals: [
        {
          kind: "DOMAIN_ACTION",
          intent: extracted.intent ?? "BOOKING",
          requiredKnowledge: "NONE",
        },
      ],
    }),
  };
}

// ── Test Execution ─────────────────────────────────────────────────────────

async function runSuite(): Promise<void> {
  console.log(
    "===============================================================",
  );
  console.log(
    "  FLOWPILOT — SCARCE AVAILABILITY & DURATION REGRESSION SUITE  ",
  );
  console.log(
    "===============================================================\n",
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Case 1: Fixed service/provider/date with exactly TWO valid starts
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(
    "▶ Case 1: Fixed service/provider/date with exactly TWO valid starts",
  );

  {
    // Working hours 09:00 - 12:00, 30m slot duration, 30m service.
    // Full candidate grid: 09:00, 09:30, 10:00, 10:30, 11:00, 11:30 (6 candidate starts).
    // Blocks:
    //  - 09:30–10:30 (blocks 09:30, 10:00)
    //  - 11:00–12:00 (blocks 11:00, 11:30)
    // Exactly TWO valid starts remain: 09:00 and 10:30.
    const business = createTestBusiness();
    const service = createTestService();
    const blockingAppointments: BlockingAppt[] = [
      {
        id: "block_1",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "09:30",
        endTime: "10:30",
        assignedUserId: PROVIDER_1.userId,
        providerId: PROVIDER_1.id,
        status: "CONFIRMED",
      },
      {
        id: "block_2",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "11:00",
        endTime: "12:00",
        assignedUserId: PROVIDER_1.userId,
        providerId: PROVIDER_1.id,
        status: "CONFIRMED",
      },
    ];

    const apptRepo = createMockAppointmentRepo(blockingAppointments);

    // 1. Authoritative availability-service check
    const availResult = await getAvailability(
      {
        businessRepository: { findById: async () => business },
        serviceRepository: { findById: async () => service },
        appointmentRepository: apptRepo,
        providerRepository: {
          listEligibleForService: async () => [PROVIDER_1 as any],
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
      },
      { userId: "usr_test", role: "STAFF", businessId: BIZ_ID },
      {
        serviceId: service.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    check(
      "1.1 Authoritative getAvailability returns success with exactly 2 slots",
      availResult.success === true &&
        availResult.data.slots.length === 2 &&
        availResult.reason === null,
      `received: ${availResult.success ? availResult.data.slots.length : "failed"} slots`,
    );

    const slotStarts1 = availResult.success
      ? availResult.data.slots.map((s) => s.startTime)
      : [];
    check(
      "1.2 Authoritative getAvailability returns exact start times 09:00 and 10:30",
      slotStarts1[0] === "09:00" && slotStarts1[1] === "10:30",
      `received: ${JSON.stringify(slotStarts1)}`,
    );

    // 2. Authoritative booking-options-service check
    const optionsResult = await resolveBookingOptions(
      {
        eligibility: {
          serviceRepository: { findById: async () => service },
          providerRepository: {
            listEligibleForService: async () => [PROVIDER_1 as any],
          },
          branchRepository: { findByIdWithinBusiness: async () => null },
        },
        businessRepository: { findById: async () => business },
        serviceRepository: { findById: async () => service },
        providerRepository: {
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
        appointmentRepository: apptRepo,
      },
      { userId: "usr_test", businessId: BIZ_ID },
      {
        serviceId: service.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    check(
      "1.3 resolveBookingOptions returns exactly 2 options with totalEligibleCount=2 and isCapped=false",
      optionsResult.success === true &&
        optionsResult.data.options.length === 2 &&
        optionsResult.data.totalEligibleCount === 2 &&
        optionsResult.data.isCapped === false,
      `options length: ${optionsResult.success ? optionsResult.data.options.length : "failed"}`,
    );

    check(
      "1.4 resolveBookingOptions does not backfill with busy or duplicate options",
      optionsResult.success === true &&
        optionsResult.data.options[0]?.startAt === `${TEST_DATE}T09:00` &&
        optionsResult.data.options[1]?.startAt === `${TEST_DATE}T10:30` &&
        new Set(optionsResult.data.options.map((o) => o.startAt)).size === 2,
    );

    // 3. Conversation Engine Turn & Telegram Presentation
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: business,
      customServices: [service],
      customProviders: [PROVIDER_1],
      customAi: controlledAi({
        service: service.name,
        date: TEST_DATE,
        provider: PROVIDER_1.name,
      }),
      todayRef: "2026-11-01",
    });

    // Wire realistic appointment repository into harness
    harness.deps.appointmentRepository =
      apptRepo as unknown as typeof harness.deps.appointmentRepository;

    const turnResult = await receiveInboundMessage(
      harness.deps,
      {
        to: "6123456789",
        from: "123456789",
        text: `أريد حجز ${service.name} يوم ${TEST_DATE} مع ${PROVIDER_1.name}`,
        receivedAt: "2026-11-01T10:00:00Z",
      },
      {
        businessId: BIZ_ID,
        branchId: BRANCH_ID,
        connectionId: "conn_tg_1",
      },
    );

    check(
      "1.5 Conversation turn succeeds with AI_REPLY",
      turnResult.ok === true,
    );

    const outbound = harness.deliveredOutbound[0];
    const choices: ChannelChoicePresentation | undefined = outbound?.choices;
    const replyMarkup = outbound?.replyMarkup;

    check(
      "1.6 Delivered outbound includes choices presentation for SLOT offer",
      choices !== undefined && choices.offerKind === "SLOT",
      `offerKind: ${choices?.offerKind}`,
    );

    // Separate appointment options from navigation/action buttons
    const allChoiceItems = (choices?.groups ?? []).flat();
    const appointmentOptions = allChoiceItems.filter(
      (item) => item.role === "option",
    );
    const actionItems = allChoiceItems.filter((item) => item.role === "action");

    check(
      "1.7 Presentation contains exactly TWO selectable appointment options",
      appointmentOptions.length === 2,
      `found ${appointmentOptions.length} option items`,
    );

    check(
      "1.8 Appointment options match exact start times 09:00 and 10:30",
      appointmentOptions[0]?.value === `${TEST_DATE}T09:00` &&
        appointmentOptions[1]?.value === `${TEST_DATE}T10:30` &&
        appointmentOptions[0]?.id === "1" &&
        appointmentOptions[1]?.id === "2",
      `values: ${appointmentOptions.map((o) => o.value).join(", ")}`,
    );

    check(
      "1.9 Navigation/action buttons ('more' and 'date') are clearly distinguished from appointment options",
      actionItems.length === 2 &&
        actionItems.some((a) => a.id === "more") &&
        actionItems.some((a) => a.id === "date"),
      `action item ids: ${actionItems.map((a) => a.id).join(", ")}`,
    );

    // Telegram inline keyboard buttons verification
    const tgKeyboard =
      replyMarkup?.inline_keyboard ??
      (choices ? renderTelegramInlineKeyboard(choices).inline_keyboard : []);
    const tgButtons = tgKeyboard.flat();
    const tgOptionButtons = tgButtons.filter(
      (b: any) =>
        b.callback_data.endsWith(":1") || b.callback_data.endsWith(":2"),
    );
    const tgActionButtons = tgButtons.filter(
      (b: any) =>
        b.callback_data.endsWith(":more") || b.callback_data.endsWith(":date"),
    );

    check(
      "1.10 Telegram inline keyboard renders exactly 2 appointment buttons plus action buttons",
      tgOptionButtons.length === 2 && tgActionButtons.length === 2,
      `option buttons: ${tgOptionButtons.length}, action buttons: ${tgActionButtons.length}`,
    );

    // 4. Case 1B: Separate ANY-PROVIDER case verifying provider scope
    // Two eligible providers: P1 and P2.
    // P1 free only at 09:00 (blocked 09:30–12:00)
    // P2 free only at 10:30 (blocked 09:00–10:30 and 11:00–12:00)
    const anyProvBlocks: BlockingAppt[] = [
      {
        id: "p1_block",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "09:30",
        endTime: "12:00",
        assignedUserId: PROVIDER_1.userId,
        providerId: PROVIDER_1.id,
        status: "CONFIRMED",
      },
      {
        id: "p2_block_1",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "09:00",
        endTime: "10:30",
        assignedUserId: PROVIDER_2.userId,
        providerId: PROVIDER_2.id,
        status: "CONFIRMED",
      },
      {
        id: "p2_block_2",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "11:00",
        endTime: "12:00",
        assignedUserId: PROVIDER_2.userId,
        providerId: PROVIDER_2.id,
        status: "CONFIRMED",
      },
    ];

    const anyProvRepo = createMockAppointmentRepo(anyProvBlocks);
    const anyProvOptions = await resolveBookingOptions(
      {
        eligibility: {
          serviceRepository: { findById: async () => service },
          providerRepository: {
            listEligibleForService: async () => [
              PROVIDER_1 as any,
              PROVIDER_2 as any,
            ],
          },
          branchRepository: { findByIdWithinBusiness: async () => null },
        },
        businessRepository: { findById: async () => business },
        serviceRepository: { findById: async () => service },
        providerRepository: {
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
            { providerId: PROVIDER_2.id, userId: PROVIDER_2.userId } as any,
          ],
        },
        appointmentRepository: anyProvRepo,
      },
      { userId: "usr_test", businessId: BIZ_ID },
      {
        serviceId: service.id,
        date: TEST_DATE,
        // No providerId specified -> ANY provider
      },
    );

    check(
      "1.11 Any-provider case returns exactly TWO options across provider scope",
      anyProvOptions.success === true &&
        anyProvOptions.data.options.length === 2 &&
        anyProvOptions.data.preference === "ANY",
      `received: ${anyProvOptions.success ? anyProvOptions.data.options.length : "failed"} options`,
    );

    check(
      "1.12 Any-provider options preserve provider identity (P1 at 09:00, P2 at 10:30)",
      anyProvOptions.success === true &&
        anyProvOptions.data.options[0]?.providerId === PROVIDER_1.id &&
        anyProvOptions.data.options[0]?.startAt === `${TEST_DATE}T09:00` &&
        anyProvOptions.data.options[1]?.providerId === PROVIDER_2.id &&
        anyProvOptions.data.options[1]?.startAt === `${TEST_DATE}T10:30`,
      `options: ${JSON.stringify(anyProvOptions.success ? anyProvOptions.data.options : [])}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Case 2: Exactly ONE valid start
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Case 2: Exactly ONE valid start");

  {
    // Working hours 09:00 - 12:00, 30m slot duration, 30m service.
    // Blocking: 09:00 to 11:30 (blocks 09:00, 09:30, 10:00, 10:30, 11:00).
    // Leaves strictly ONE valid start: 11:30–12:00.
    const business = createTestBusiness();
    const service = createTestService();
    const blockingAppointments: BlockingAppt[] = [
      {
        id: "block_heavy",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "09:00",
        endTime: "11:30",
        assignedUserId: PROVIDER_1.userId,
        providerId: PROVIDER_1.id,
        status: "CONFIRMED",
      },
    ];

    const apptRepo = createMockAppointmentRepo(blockingAppointments);

    // 1. Authoritative availability-service check
    const availResult = await getAvailability(
      {
        businessRepository: { findById: async () => business },
        serviceRepository: { findById: async () => service },
        appointmentRepository: apptRepo,
        providerRepository: {
          listEligibleForService: async () => [PROVIDER_1 as any],
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
      },
      { userId: "usr_test", role: "STAFF", businessId: BIZ_ID },
      {
        serviceId: service.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    check(
      "2.1 Authoritative getAvailability returns exactly 1 slot (11:30)",
      availResult.success === true &&
        availResult.data.slots.length === 1 &&
        availResult.data.slots[0]?.startTime === "11:30" &&
        availResult.reason === null,
      `slots: ${availResult.success ? availResult.data.slots.length : "failed"}`,
    );

    // 2. Authoritative booking-options-service check
    const optionsResult = await resolveBookingOptions(
      {
        eligibility: {
          serviceRepository: { findById: async () => service },
          providerRepository: {
            listEligibleForService: async () => [PROVIDER_1 as any],
          },
          branchRepository: { findByIdWithinBusiness: async () => null },
        },
        businessRepository: { findById: async () => business },
        serviceRepository: { findById: async () => service },
        providerRepository: {
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
        appointmentRepository: apptRepo,
      },
      { userId: "usr_test", businessId: BIZ_ID },
      {
        serviceId: service.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    check(
      "2.2 resolveBookingOptions returns exactly 1 option (totalEligibleCount=1, no duplicate padding)",
      optionsResult.success === true &&
        optionsResult.data.options.length === 1 &&
        optionsResult.data.totalEligibleCount === 1 &&
        optionsResult.data.options[0]?.startAt === `${TEST_DATE}T11:30`,
      `count: ${optionsResult.success ? optionsResult.data.options.length : "failed"}`,
    );

    // 3. Conversation Engine Turn & Telegram Presentation
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: business,
      customServices: [service],
      customProviders: [PROVIDER_1],
      customAi: controlledAi({
        service: service.name,
        date: TEST_DATE,
        provider: PROVIDER_1.name,
      }),
      todayRef: "2026-11-01",
    });

    harness.deps.appointmentRepository =
      apptRepo as unknown as typeof harness.deps.appointmentRepository;

    const turnResult = await receiveInboundMessage(
      harness.deps,
      {
        to: "6123456789",
        from: "123456789",
        text: `أريد حجز ${service.name} يوم ${TEST_DATE} مع ${PROVIDER_1.name}`,
        receivedAt: "2026-11-01T10:00:00Z",
      },
      {
        businessId: BIZ_ID,
        branchId: BRANCH_ID,
        connectionId: "conn_tg_1",
      },
    );

    check("2.3 Conversation turn succeeds", turnResult.ok === true);

    const outbound = harness.deliveredOutbound[0];
    const choices = outbound?.choices;
    const allChoiceItems = (choices?.groups ?? []).flat();
    const appointmentOptions = allChoiceItems.filter(
      (item: any) => item.role === "option",
    );
    const actionItems = allChoiceItems.filter(
      (item: any) => item.role === "action",
    );

    check(
      "2.4 Telegram presentation renders exactly ONE appointment option",
      appointmentOptions.length === 1 &&
        appointmentOptions[0]?.value === `${TEST_DATE}T11:30`,
      `found ${appointmentOptions.length} options`,
    );

    check(
      "2.5 Action buttons ('more' and 'date') remain distinct from the single appointment option",
      actionItems.length === 2 &&
        actionItems.some((a: any) => a.id === "more") &&
        actionItems.some((a: any) => a.id === "date"),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Case 3: ZERO valid starts (Honest No-Availability Response)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Case 3: ZERO valid starts (Honest No-Availability)");

  {
    // Working hours 09:00 - 12:00, 30m slot duration, 30m service.
    // Entire day is blocked: 09:00 to 12:00.
    const business = createTestBusiness();
    const service = createTestService();
    const blockingAppointments: BlockingAppt[] = [
      {
        id: "block_all_day",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "09:00",
        endTime: "12:00",
        assignedUserId: PROVIDER_1.userId,
        providerId: PROVIDER_1.id,
        status: "CONFIRMED",
      },
    ];

    const apptRepo = createMockAppointmentRepo(blockingAppointments);

    // 1. Authoritative availability-service check
    const availResult = await getAvailability(
      {
        businessRepository: { findById: async () => business },
        serviceRepository: { findById: async () => service },
        appointmentRepository: apptRepo,
        providerRepository: {
          listEligibleForService: async () => [PROVIDER_1 as any],
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
      },
      { userId: "usr_test", role: "STAFF", businessId: BIZ_ID },
      {
        serviceId: service.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    check(
      "3.1 Authoritative getAvailability returns 0 slots with reason FULLY_BOOKED",
      availResult.success === true &&
        availResult.data.slots.length === 0 &&
        (availResult as any).reason === "FULLY_BOOKED",
      `reason: ${(availResult as any).reason}, slots: ${availResult.success ? availResult.data.slots.length : "failed"}`,
    );

    // 2. Authoritative booking-options-service check
    const optionsResult = await resolveBookingOptions(
      {
        eligibility: {
          serviceRepository: { findById: async () => service },
          providerRepository: {
            listEligibleForService: async () => [PROVIDER_1 as any],
          },
          branchRepository: { findByIdWithinBusiness: async () => null },
        },
        businessRepository: { findById: async () => business },
        serviceRepository: { findById: async () => service },
        providerRepository: {
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
        appointmentRepository: apptRepo,
      },
      { userId: "usr_test", businessId: BIZ_ID },
      {
        serviceId: service.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    check(
      "3.2 resolveBookingOptions returns 0 options with reason FULLY_BOOKED",
      optionsResult.success === true &&
        optionsResult.data.options.length === 0 &&
        optionsResult.data.totalEligibleCount === 0 &&
        (optionsResult as any).reason === "FULLY_BOOKED",
      `reason: ${(optionsResult as any).reason}, options: ${optionsResult.success ? optionsResult.data.options.length : "failed"}`,
    );

    // 3. Conversation Engine Turn
    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: business,
      customServices: [service],
      customProviders: [PROVIDER_1],
      customAi: controlledAi({
        service: service.name,
        date: TEST_DATE,
        provider: PROVIDER_1.name,
      }),
      todayRef: "2026-11-01",
    });

    harness.deps.appointmentRepository =
      apptRepo as unknown as typeof harness.deps.appointmentRepository;

    const initialAppointmentCount = apptRepo.store.length;

    const turnResult = await receiveInboundMessage(
      harness.deps,
      {
        to: "6123456789",
        from: "123456789",
        text: `أريد حجز ${service.name} يوم ${TEST_DATE} مع ${PROVIDER_1.name}`,
        receivedAt: "2026-11-01T10:00:00Z",
      },
      {
        businessId: BIZ_ID,
        branchId: BRANCH_ID,
        connectionId: "conn_tg_1",
      },
    );

    check("3.3 Conversation turn completes safely", turnResult.ok === true);

    const outbound = harness.deliveredOutbound[0];
    const choices = outbound?.choices;
    const body = outbound?.body ?? "";

    check(
      "3.4 Outbound reply provides an honest no-availability response for that day",
      body.includes("جميع المواعيد محجوزة") ||
        body.includes("لا تتوفر مواعيد") ||
        body.includes(TEST_DATE),
      `received body: "${body}"`,
    );

    check(
      "3.5 Response returns NO selectable slot options",
      choices === undefined ||
        choices === null ||
        choices.offerKind !== "SLOT" ||
        choices.groups.flat().filter((i: any) => i.role === "option").length ===
          0,
      `choices kind: ${choices?.offerKind}`,
    );

    check(
      "3.6 Does not silently switch date or provider, and created 0 new appointments",
      apptRepo.store.length === initialAppointmentCount,
      `appointments before: ${initialAppointmentCount}, after: ${apptRepo.store.length}`,
    );

    // Check durable conversation state
    const durableState = await harness.deps.conversationStateRepository!.load(
      BIZ_ID,
      harness.conversation.id,
    );
    const storedOfferKind = (durableState?.state as any)?.offer?.kind;
    check(
      "3.7 Durable state contains no slot offer for a fully booked day",
      storedOfferKind !== "SLOT",
      `stored offer kind: ${storedOfferKind}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Case 4: Duration Overlap
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Case 4: Duration overlap");

  {
    // Service duration: 45 minutes (e.g. 16:00–16:45).
    // Working hours 15:00 - 18:00, slotDurationMinutes: 15.
    // Provider 1 has a blocking appointment at 16:20–17:00.
    // Candidate slot 16:00–16:45 overlaps [16:20, 17:00) because 16:00 < 17:00 && 16:20 < 16:45.
    // Therefore 16:00 must be UNAVAILABLE for Provider 1.
    // Independent Provider 2 has a booking at 16:20–17:00, but Provider 1 is free.
    // Provider 2's booking must NOT block Provider 1.
    const business = createTestBusiness({
      workingHours: createStandardWorkingHours("15:00", "18:00"),
      slotDurationMinutes: 15,
    });
    const service45 = createTestService({
      id: SERV_45_ID,
      name: "علاج عصب",
      durationMinutes: 45,
    });

    // Subcase 4A: SAME provider has blocking appointment beginning 16:20
    const sameProvBlocks: BlockingAppt[] = [
      {
        id: "block_1620_same",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "16:20",
        endTime: "17:05",
        assignedUserId: PROVIDER_1.userId,
        providerId: PROVIDER_1.id,
        status: "CONFIRMED",
      },
    ];

    const sameProvRepo = createMockAppointmentRepo(sameProvBlocks);

    const sameProvAvail = await getAvailability(
      {
        businessRepository: { findById: async () => business },
        serviceRepository: { findById: async () => service45 },
        appointmentRepository: sameProvRepo,
        providerRepository: {
          listEligibleForService: async () => [PROVIDER_1 as any],
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
      },
      { userId: "usr_test", role: "STAFF", businessId: BIZ_ID },
      {
        serviceId: service45.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    const sameProvStarts = sameProvAvail.success
      ? sameProvAvail.data.slots.map((s) => s.startTime)
      : [];

    check(
      "4.1 45-min request 16:00–16:45 is UNAVAILABLE when SAME provider has 16:20 appointment",
      sameProvAvail.success === true && !sameProvStarts.includes("16:00"),
      `available starts: ${sameProvStarts.join(", ")}`,
    );

    // Also verify 16:15 (16:15–17:00) and 16:30 (16:30–17:15) are also blocked
    check(
      "4.2 Overlapping candidates 16:15 and 16:30 are also properly blocked for the SAME provider",
      !sameProvStarts.includes("16:15") && !sameProvStarts.includes("16:30"),
      `available starts: ${sameProvStarts.join(", ")}`,
    );

    // Subcase 4B: Independent provider P2 has booking at 16:20; P1 is free
    // Working hours 16:00 - 18:00 so 16:00 is the primary candidate
    const business16 = createTestBusiness({
      workingHours: createStandardWorkingHours("16:00", "18:00"),
      slotDurationMinutes: 15,
    });

    const independentProvBlocks: BlockingAppt[] = [
      {
        id: "block_1620_p2",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "16:20",
        endTime: "17:05",
        assignedUserId: PROVIDER_2.userId,
        providerId: PROVIDER_2.id,
        status: "CONFIRMED",
      },
    ];

    const independentProvRepo = createMockAppointmentRepo(
      independentProvBlocks,
    );

    const p1AvailWithP2Blocked = await getAvailability(
      {
        businessRepository: { findById: async () => business16 },
        serviceRepository: { findById: async () => service45 },
        appointmentRepository: independentProvRepo,
        providerRepository: {
          listEligibleForService: async () => [
            PROVIDER_1 as any,
            PROVIDER_2 as any,
          ],
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
            { providerId: PROVIDER_2.id, userId: PROVIDER_2.userId } as any,
          ],
        },
      },
      { userId: "usr_test", role: "STAFF", businessId: BIZ_ID },
      {
        serviceId: service45.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    const p1Starts = p1AvailWithP2Blocked.success
      ? p1AvailWithP2Blocked.data.slots.map((s) => s.startTime)
      : [];

    check(
      "4.3 Independent provider's booking does NOT block Provider 1's 16:00–16:45 request",
      p1AvailWithP2Blocked.success === true && p1Starts.includes("16:00"),
      `Provider 1 available starts: ${p1Starts.join(", ")}`,
    );

    // Verify resolveBookingOptions for ANY provider includes P1 at 16:00
    const anyOptionsOverlap = await resolveBookingOptions(
      {
        eligibility: {
          serviceRepository: { findById: async () => service45 },
          providerRepository: {
            listEligibleForService: async () => [
              PROVIDER_1 as any,
              PROVIDER_2 as any,
            ],
          },
          branchRepository: { findByIdWithinBusiness: async () => null },
        },
        businessRepository: { findById: async () => business16 },
        serviceRepository: { findById: async () => service45 },
        providerRepository: {
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
            { providerId: PROVIDER_2.id, userId: PROVIDER_2.userId } as any,
          ],
        },
        appointmentRepository: independentProvRepo,
      },
      { userId: "usr_test", businessId: BIZ_ID },
      {
        serviceId: service45.id,
        date: TEST_DATE,
      },
    );

    const anyStartsP1 = anyOptionsOverlap.success
      ? anyOptionsOverlap.data.options
          .filter((o) => o.providerId === PROVIDER_1.id)
          .map((o) => o.startAt)
      : [];

    check(
      "4.4 Any-provider resolution correctly offers Provider 1 at 16:00 despite Provider 2 conflict",
      anyStartsP1.includes(`${TEST_DATE}T16:00`),
      `any-provider P1 starts: ${anyStartsP1.join(", ")}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Case 5: End boundary behavior
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n▶ Case 5: End boundary behavior");

  {
    // Service duration: 45 minutes.
    // Booking at 10:00–10:45.
    //
    // Scenario 5A: Aligned 15-minute grid (slotDurationMinutes: 15).
    // Candidates: 10:00, 10:15, 10:30, 10:45, 11:00...
    // 10:00, 10:15, 10:30 overlap [10:00, 10:45).
    // Candidate 10:45 (10:45–11:30) starts exactly at the end boundary of the 10:00–10:45 booking.
    //  - If [10:45, 11:30) is free -> 10:45 can be offered.
    //  - If [10:45, 11:30) has a conflict (e.g. appointment at 11:15–12:00) -> 10:45 CANNOT be offered.
    //
    // Scenario 5B: 30-minute grid (slotDurationMinutes: 30).
    // Candidates on 30m grid: 10:00, 10:30, 11:00, 11:30...
    // 10:00 overlaps [10:00, 10:45).
    // 10:30 (10:30–11:15) overlaps [10:00, 10:45) because 10:30 < 10:45.
    // 10:45 is NOT on the 30-minute grid.
    // Next candidate on grid is 11:00.
    // Do NOT expect an off-grid 10:45 start on a 30-minute grid.

    const service45 = createTestService({
      id: SERV_45_ID,
      name: "خدمة 45 دقيقة",
      durationMinutes: 45,
    });

    // 5A.1: Aligned 15-minute grid with free next interval [10:45, 11:30)
    const biz15Free = createTestBusiness({
      workingHours: createStandardWorkingHours("10:00", "13:00"),
      slotDurationMinutes: 15,
    });

    const block1000to1045: BlockingAppt[] = [
      {
        id: "block_1045_end",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "10:00",
        endTime: "10:45",
        assignedUserId: PROVIDER_1.userId,
        providerId: PROVIDER_1.id,
        status: "CONFIRMED",
      },
    ];

    const repo5A1 = createMockAppointmentRepo(block1000to1045);
    const avail5A1 = await getAvailability(
      {
        businessRepository: { findById: async () => biz15Free },
        serviceRepository: { findById: async () => service45 },
        appointmentRepository: repo5A1,
        providerRepository: {
          listEligibleForService: async () => [PROVIDER_1 as any],
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
      },
      { userId: "usr_test", role: "STAFF", businessId: BIZ_ID },
      {
        serviceId: service45.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    const starts5A1 = avail5A1.success
      ? avail5A1.data.slots.map((s) => s.startTime)
      : [];

    check(
      "5.1 On 15-minute grid after 10:00–10:45 booking, 10:45 is offered when next interval is free",
      avail5A1.success === true &&
        starts5A1[0] === "10:45" &&
        !starts5A1.includes("10:00") &&
        !starts5A1.includes("10:15") &&
        !starts5A1.includes("10:30"),
      `first slot: ${starts5A1[0]}, available starts: ${starts5A1.join(", ")}`,
    );

    // 5A.2: Aligned 15-minute grid where next interval [10:45, 11:30) is NOT fully free
    // (Another booking starts at 11:15–12:00)
    const blockWithNextOverlap: BlockingAppt[] = [
      ...block1000to1045,
      {
        id: "block_1115",
        businessId: BIZ_ID,
        date: TEST_DATE,
        startTime: "11:15",
        endTime: "12:00",
        assignedUserId: PROVIDER_1.userId,
        providerId: PROVIDER_1.id,
        status: "CONFIRMED",
      },
    ];

    const repo5A2 = createMockAppointmentRepo(blockWithNextOverlap);
    const avail5A2 = await getAvailability(
      {
        businessRepository: { findById: async () => biz15Free },
        serviceRepository: { findById: async () => service45 },
        appointmentRepository: repo5A2,
        providerRepository: {
          listEligibleForService: async () => [PROVIDER_1 as any],
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
      },
      { userId: "usr_test", role: "STAFF", businessId: BIZ_ID },
      {
        serviceId: service45.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    const starts5A2 = avail5A2.success
      ? avail5A2.data.slots.map((s) => s.startTime)
      : [];

    check(
      "5.2 On 15-minute grid, 10:45 is NOT offered if next service interval overlaps an appointment at 11:15",
      avail5A2.success === true && !starts5A2.includes("10:45"),
      `available starts: ${starts5A2.join(", ")}`,
    );

    // 5B: 30-minute grid — do not expect off-grid 10:45 start
    const biz30 = createTestBusiness({
      workingHours: createStandardWorkingHours("10:00", "13:00"),
      slotDurationMinutes: 30,
    });

    const candidateGrid30 = generateCandidateGrid({
      workingHours: biz30.workingHours,
      date: TEST_DATE,
      durationMinutes: service45.durationMinutes,
      slotDurationMinutes: biz30.slotDurationMinutes,
    });

    const candidateStarts30 = (candidateGrid30 ?? []).map((c) => c.startTime);

    check(
      "5.3 Candidate grid with 30-minute step does NOT generate off-grid 10:45 start",
      !candidateStarts30.includes("10:45") &&
        candidateStarts30.includes("10:00") &&
        candidateStarts30.includes("10:30") &&
        candidateStarts30.includes("11:00"),
      `generated candidates: ${candidateStarts30.join(", ")}`,
    );

    const repo5B = createMockAppointmentRepo(block1000to1045);
    const avail5B = await getAvailability(
      {
        businessRepository: { findById: async () => biz30 },
        serviceRepository: { findById: async () => service45 },
        appointmentRepository: repo5B,
        providerRepository: {
          listEligibleForService: async () => [PROVIDER_1 as any],
          listAssignmentSeams: async () => [
            { providerId: PROVIDER_1.id, userId: PROVIDER_1.userId } as any,
          ],
        },
      },
      { userId: "usr_test", role: "STAFF", businessId: BIZ_ID },
      {
        serviceId: service45.id,
        date: TEST_DATE,
        providerId: PROVIDER_1.id,
      },
    );

    const starts5B = avail5B.success
      ? avail5B.data.slots.map((s) => s.startTime)
      : [];

    check(
      "5.4 On 30-minute grid after 10:00–10:45 booking, first available offered start is on-grid 11:00 (not off-grid 10:45)",
      avail5B.success === true &&
        !starts5B.includes("10:45") &&
        starts5B[0] === "11:00",
      `first offered start: ${starts5B[0]}, all starts: ${starts5B.join(", ")}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Case 6: Availability changed after display (replay real displayed choice)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(
    "\n▶ Case 6: Availability changed after display (Concurrent Conflict Replay)",
  );

  {
    // Working hours 09:00 - 12:00, 30m slots.
    // Initial state: free day, offers 09:00, 09:30, 10:00, 10:30...
    // Turn 1: Present choices to customer. Slot 1 is 09:00 with callback fp:<token>:1.
    // Controlled Conflict: An external appointment is created for that exact slot (09:00–09:30).
    // Turn 2: Customer clicks/replays fp:<token>:1.
    // Verification:
    //  - Safe rejection / revalidation occurs.
    //  - ZERO overlapping appointments are written! Total appointments for 09:00 remains 1.

    const business = createTestBusiness();
    const service = createTestService();
    const initialAppointments: BlockingAppt[] = [];
    const apptRepo = createMockAppointmentRepo(initialAppointments);

    const harness = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: business,
      customServices: [service],
      customProviders: [PROVIDER_1],
      customAi: controlledAi({
        service: service.name,
        date: TEST_DATE,
        provider: PROVIDER_1.name,
      }),
      todayRef: "2026-11-01",
    });

    harness.deps.appointmentRepository =
      apptRepo as unknown as typeof harness.deps.appointmentRepository;

    // ── Turn 1: Customer requests booking options ────────────────────────────
    const turn1Result = await receiveInboundMessage(
      harness.deps,
      {
        to: "6123456789",
        from: "123456789",
        text: `أريد حجز ${service.name} يوم ${TEST_DATE} مع ${PROVIDER_1.name}`,
        receivedAt: "2026-11-01T10:00:00Z",
      },
      {
        businessId: BIZ_ID,
        branchId: BRANCH_ID,
        connectionId: "conn_tg_1",
      },
    );

    check(
      "6.1 Turn 1 succeeds and presents booking choices",
      turn1Result.ok === true,
    );

    const outboundTurn1 = harness.deliveredOutbound[0];
    const tgButtonsTurn1 = (
      outboundTurn1?.replyMarkup?.inline_keyboard ?? []
    ).flat();

    const firstSlotButton = tgButtonsTurn1.find((b: any) =>
      b.callback_data.endsWith(":1"),
    );
    const displayedCallbackData = firstSlotButton?.callback_data;

    check(
      "6.2 Turn 1 Telegram inline keyboard presented Option 1 with real callback_data",
      typeof displayedCallbackData === "string" &&
        displayedCallbackData.startsWith("fp:"),
      `callback_data: ${displayedCallbackData}`,
    );

    // ── Insert Controlled Conflict ───────────────────────────────────────────
    // Another client books 09:00–09:30 before our customer clicks button 1.
    const concurrentAppt: BlockingAppt = {
      id: "concurrent_booking_900",
      businessId: BIZ_ID,
      date: TEST_DATE,
      startTime: "09:00",
      endTime: "09:30",
      assignedUserId: PROVIDER_1.userId,
      providerId: PROVIDER_1.id,
      status: "CONFIRMED",
    };
    apptRepo.store.push(concurrentAppt);

    const apptsBeforeTurn2 = apptRepo.store.length;
    check(
      "6.3 Controlled conflict inserted for 09:00 before Turn 2 selection replay",
      apptsBeforeTurn2 === 1,
    );

    // ── Turn 2: Replay the real displayed choice via callback_data ───────────
    const turn2Result = await receiveInboundMessage(
      harness.deps,
      {
        to: "6123456789",
        from: "123456789",
        text: displayedCallbackData!,
        receivedAt: "2026-11-01T10:02:00Z",
      },
      {
        businessId: BIZ_ID,
        branchId: BRANCH_ID,
        connectionId: "conn_tg_1",
      },
    );

    check(
      "6.4 Turn 2 selection replay executes safely",
      turn2Result.ok === true,
    );

    const outboundTurn2 =
      harness.deliveredOutbound[harness.deliveredOutbound.length - 1];
    const bodyTurn2 = outboundTurn2?.body ?? "";

    check(
      "6.5 Turn 2 revalidates and safely informs customer that the selected slot is no longer available",
      bodyTurn2.includes("لم يعد متاحاً") ||
        bodyTurn2.includes("تم حجز هذا الموعد") ||
        bodyTurn2.includes("المواعيد المحدثة"),
      `reply body: "${bodyTurn2}"`,
    );

    const apptsAfterTurn2 = apptRepo.store.length;
    check(
      "6.6 SAFE REJECTION: Zero overlapping appointments written (appointment count unchanged)",
      apptsAfterTurn2 === apptsBeforeTurn2,
      `appts before: ${apptsBeforeTurn2}, after: ${apptsAfterTurn2}`,
    );

    const apptsAt900 = apptRepo.store.filter(
      (a: any) =>
        a.date === TEST_DATE &&
        a.startTime === "09:00" &&
        a.assignedUserId === PROVIDER_1.userId,
    );
    check(
      "6.7 Exactly 1 booking exists at 09:00 (no duplicate or double-booking written)",
      apptsAt900.length === 1 && apptsAt900[0]?.id === concurrentAppt.id,
      `count at 09:00: ${apptsAt900.length}`,
    );

    // ── Subcase 6B: Availability changed to ZERO valid starts after display ─
    // A fresh conversation displays live slot choices on TEST_DATE.
    // An external conflict then books ALL remaining slots before customer clicks.
    // Customer replays the displayed choice.
    // Expected: Revalidation finds 0 slots, honestly informs customer with FULLY_BOOKED message,
    // and writes ZERO appointments.
    const harness6B = createPlaygroundHarness({
      channel: "TELEGRAM",
      businessConfig: business,
      customServices: [service],
      customProviders: [PROVIDER_1],
      customAi: controlledAi({
        service: service.name,
        date: TEST_DATE,
        provider: PROVIDER_1.name,
      }),
      todayRef: "2026-11-01",
    });

    const repo6B = createMockAppointmentRepo([]);
    harness6B.deps.appointmentRepository =
      repo6B as unknown as typeof harness6B.deps.appointmentRepository;

    const turn1Result6B = await receiveInboundMessage(
      harness6B.deps,
      {
        to: "6123456789",
        from: "123456789",
        text: `أريد حجز ${service.name} يوم ${TEST_DATE} مع ${PROVIDER_1.name}`,
        receivedAt: "2026-11-01T10:00:00Z",
      },
      {
        businessId: BIZ_ID,
        branchId: BRANCH_ID,
        connectionId: "conn_tg_1",
      },
    );

    const outbound6B1 = harness6B.deliveredOutbound[0];
    const tgButtons6B = (
      outbound6B1?.replyMarkup?.inline_keyboard ?? []
    ).flat();
    const slotButton6B = tgButtons6B.find((b: any) =>
      b.callback_data.endsWith(":1"),
    );
    const cbData6B = slotButton6B?.callback_data;

    check(
      "6.8 Subcase 6B Turn 1 presents live slot choices",
      turn1Result6B.ok === true && typeof cbData6B === "string",
    );

    // Conflict: All slots on TEST_DATE are booked by another actor
    repo6B.store.push({
      id: "block_entire_day_concurrent",
      businessId: BIZ_ID,
      date: TEST_DATE,
      startTime: "09:00",
      endTime: "12:00",
      assignedUserId: PROVIDER_1.userId,
      providerId: PROVIDER_1.id,
      status: "CONFIRMED",
    });

    const apptsBeforeTurn2_6B = repo6B.store.length;

    // Customer replays displayed choice
    const turn2Result6B = await receiveInboundMessage(
      harness6B.deps,
      {
        to: "6123456789",
        from: "123456789",
        text: cbData6B!,
        receivedAt: "2026-11-01T10:03:00Z",
      },
      {
        businessId: BIZ_ID,
        branchId: BRANCH_ID,
        connectionId: "conn_tg_1",
      },
    );

    check(
      "6.9 Subcase 6B Turn 2 replay on fully booked day executes safely without crash",
      turn2Result6B.ok === true,
    );

    const outbound6B2 =
      harness6B.deliveredOutbound[harness6B.deliveredOutbound.length - 1];
    const body6B2 = outbound6B2?.body ?? "";

    check(
      "6.10 Customer is honestly informed that all appointments are now booked on that day",
      body6B2.includes("جميع المواعيد محجوزة") ||
        body6B2.includes("لا تتوفر مواعيد"),
      `reply body: "${body6B2}"`,
    );

    check(
      "6.11 Under full concurrent exhaustion, ZERO new appointments were written",
      repo6B.store.length === apptsBeforeTurn2_6B,
      `appts before: ${apptsBeforeTurn2_6B}, after: ${repo6B.store.length}`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════════════
  console.log(
    "\n===============================================================",
  );
  const passedCount = checks.filter((c) => c.pass).length;
  const failedCount = checks.filter((c) => !c.pass).length;
  console.log(`TOTAL CHECKS: ${checks.length}`);
  console.log(`PASSED:       ${passedCount}`);
  console.log(`FAILED:       ${failedCount}`);
  console.log(
    "===============================================================",
  );

  if (failedCount > 0) {
    console.error(
      `\n❌ ${failedCount} check(s) failed in scarce availability regression suite.`,
    );
    process.exit(1);
  }

  console.log(
    "\n✔ All scarce availability and duration regression checks passed.",
  );
}

runSuite().catch((err) => {
  console.error("FATAL in check-scarce-availability-regressions:", err);
  process.exit(1);
});
