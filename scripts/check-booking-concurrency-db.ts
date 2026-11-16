/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { randomUUID } from "node:crypto";

import { getAppointmentDetail } from "@/features/appointments/server/appointment-queries";
import {
  createAppointmentRecord,
  defaultAppointmentCreateServiceDeps,
} from "@/features/appointments/server/appointment-create-service";
import {
  defaultAvailabilityServiceDeps,
  getAvailability,
} from "@/features/appointments/server/availability-service";
import {
  defaultBookingFlowServiceDeps,
  resolveBookingContext,
} from "@/features/appointments/server/booking-flow-service";
import { buildSlotOffer } from "@/features/conversations/server/booking-offer";
import {
  dehydrateConversationState,
  emptyConversationState,
  withPresentedOffer,
} from "@/features/conversations/server/conversation-state";
import { receiveInboundMessage } from "@/features/conversations/server/conversation-engine";
import type { MessageTransport } from "@/features/conversations/server/conversation-transport";
import { db } from "@/server/db";
import {
  AppointmentRepository,
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
import type { UserRole } from "@/types/domain";

type Check = { label: string; pass: boolean; details?: string };

const checks: Check[] = [];

function check(label: string, pass: boolean, details?: string): void {
  checks.push({ label, pass, details });
  const mark = pass ? "✅ PASS" : "❌ FAIL";
  console.log(`${mark} : ${label}${details ? ` (${details})` : ""}`);
}

function classifyTarget(
  url: string,
): { host: string; local: boolean } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const local =
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === "";
    return { host, local };
  } catch {
    return null;
  }
}

function toDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toTime(time: string): Date {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function createRendezvous(participants: number, timeoutMs: number) {
  let arrived = 0;
  let released = false;
  let release: () => void = () => {};
  const releasedPromise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    async wait(): Promise<void> {
      if (released) return;
      arrived += 1;
      if (arrived >= participants) {
        released = true;
        release();
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          releasedPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("RENDEZVOUS_TIMEOUT")),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

function createControlledDb(rendezvous: {
  wait: () => Promise<void>;
}): typeof db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        return async function (
          fn: (tx: any) => Promise<any>,
          options?: any,
        ) {
          return target.$transaction(async (tx: any) => {
            const wrapped = new Proxy(tx, {
              get(txTarget, txProp, txReceiver) {
                if (txProp === "appointment") {
                  const model = Reflect.get(txTarget, txProp, txReceiver);
                  return new Proxy(model, {
                    get(modelTarget, modelProp, modelReceiver) {
                      if (modelProp === "count") {
                        return async (...args: any[]) => {
                          const result = await modelTarget.count(...args);
                          await rendezvous.wait();
                          return result;
                        };
                      }
                      return Reflect.get(
                        modelTarget,
                        modelProp,
                        modelReceiver,
                      );
                    },
                  });
                }
                return Reflect.get(txTarget, txProp, txReceiver);
              },
            });
            return fn(wrapped);
          }, options);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const testTransport: MessageTransport = {
  providerName: "offline-db-concurrency-transport",
  async send(message) {
    void message;
    return { provider: "offline-db-concurrency-transport", delivered: true };
  },
};

async function createBusinessFixture(name: string) {
  const businessId = randomUUID();
  const branchId = randomUUID();
  const phone = `+2010${Math.floor(10000000 + Math.random() * 90000000)}`;
  await db.business.create({
    data: {
      id: businessId,
      name,
      whatsappNumber: phone,
      isActive: true,
      timezone: "Africa/Cairo",
      confirmationMode: "automatic",
      slotDurationMinutes: 30,
      workingHours: {
        sat: { open: "09:00", close: "18:00", closed: false },
        sun: { open: "09:00", close: "18:00", closed: false },
        mon: { open: "09:00", close: "18:00", closed: false },
        tue: { open: "09:00", close: "18:00", closed: false },
        wed: { open: "09:00", close: "18:00", closed: false },
        thu: { open: "09:00", close: "18:00", closed: false },
        fri: { open: "09:00", close: "18:00", closed: false },
      },
    },
  });
  await db.branch.create({
    data: { id: branchId, businessId, name: "الفرع الرئيسي" },
  });
  await db.business.update({
    where: { id: businessId },
    data: { defaultBranchId: branchId },
  });
  return { businessId, branchId, phone };
}

async function createCustomer(businessId: string, name: string) {
  return db.customer.create({
    data: {
      businessId,
      name,
      phone: `+2011${Math.floor(10000000 + Math.random() * 90000000)}`,
    },
  });
}

async function createService(businessId: string, name: string) {
  return db.service.create({
    data: {
      businessId,
      name,
      durationMinutes: 30,
      isActive: true,
    },
  });
}

async function createProvider(businessId: string, name: string) {
  const provider = await providerRepository.createProfile(businessId, {
    name,
    displayName: name,
    servicePolicy: "ALL_SERVICES",
  });
  if (!provider) throw new Error("PROVIDER_CREATE_FAILED");
  return provider;
}

async function seedSlotOffer(input: {
  businessId: string;
  branchId: string;
  providerId: string;
  providerName: string;
  serviceId: string;
  serviceName: string;
  customerId: string;
  date: string;
  startTime: string;
  endTime: string;
}) {
  const conversation = await conversationRepository.create({
    businessId: input.businessId,
    customerId: input.customerId,
    branchId: input.branchId,
  });
  const offer = buildSlotOffer(
    {
      businessId: input.businessId,
      conversationId: conversation.id,
    },
    randomUUID(),
    {
      serviceId: input.serviceId,
      serviceName: input.serviceName,
      serviceSource: "CUSTOMER",
      providerId: input.providerId,
      timePreference: null,
      date: input.date,
      followUpRequestId: null,
      shownCount: 1,
      options: [
        {
          providerId: input.providerId,
          displayName: input.providerName,
          startAt: `${input.date}T${input.startTime}`,
          endAt: `${input.date}T${input.endTime}`,
        },
      ],
    },
    new Date(),
  );
  if (!offer) throw new Error("SLOT_OFFER_BUILD_FAILED");
  const state = withPresentedOffer(emptyConversationState(), offer);
  const saved = await conversationStateRepository.save(
    input.businessId,
    conversation.id,
    null,
    dehydrateConversationState(state),
  );
  if (saved.status !== "saved") throw new Error("STATE_SEED_FAILED");
  return { conversationId: conversation.id, offer };
}

function makeEngineDeps() {
  return {
    businessRepository,
    branchRepository,
    customerRepository,
    conversationRepository,
    serviceRepository,
    inboundDedupeRepository,
    usageRepository,
    attentionRepository: operatorAttentionRepository,
    knowledgeGapRepository,
    conversationStateRepository,
    providerRepository,
    appointmentRepository,
    followUpRequestRepository,
    ai: {
      providerName: "must-not-be-called",
      async respond() {
        throw new Error("AI_MUST_NOT_BE_CALLED_FOR_MECHANICAL_SELECTION");
      },
    },
    transport: testTransport,
    requiredSemanticCapability: "structured_turn" as const,
  } as unknown as Parameters<typeof receiveInboundMessage>[0];
}

async function main(): Promise<void> {
  console.log(
    "▶ Running booking concurrency and tenant-isolation real-DB checks...",
  );

  const target = classifyTarget(process.env.DATABASE_URL ?? "");
  if (!target || !target.local) {
    console.error(
      "❌ DEV_DB_INTEGRATION_BLOCKED: DATABASE_URL must point to a local disposable test database.",
    );
    process.exit(1);
  }
  console.log(`🔒 Target database verified local: ${target.host}`);

  const businessA = await createBusinessFixture("منشأة التدقيق أ");
  const businessB = await createBusinessFixture("منشأة التدقيق ب");
  const serviceA = await createService(businessA.businessId, "استشارة أ");
  const serviceB = await createService(businessB.businessId, "استشارة ب");
  const providerA = await createProvider(businessA.businessId, "د. أ");
  const providerA2 = await createProvider(businessA.businessId, "د. ب");
  const providerB = await createProvider(businessB.businessId, "د. ج");
  await db.providerBranch.createMany({
    data: [
      { providerId: providerA.id, branchId: businessA.branchId },
      { providerId: providerA2.id, branchId: businessA.branchId },
      { providerId: providerB.id, branchId: businessB.branchId },
    ],
  });
  const customerA1 = await createCustomer(businessA.businessId, "عميل أ1");
  const customerA2 = await createCustomer(businessA.businessId, "عميل أ2");
  const customerA3 = await createCustomer(businessA.businessId, "عميل أ3");
  const customerA4 = await createCustomer(businessA.businessId, "عميل أ4");
  const customerB = await createCustomer(businessB.businessId, "عميل ب");

  const actorA = {
    userId: randomUUID(),
    role: "ADMIN" as UserRole,
    businessId: businessA.businessId,
  };
  const actorB = {
    userId: randomUUID(),
    role: "ADMIN" as UserRole,
    businessId: businessB.businessId,
  };

  const baseDate = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const dateA = baseDate;
  const dateB = addDays(baseDate, 1);
  const dateC = addDays(baseDate, 2);
  const dateD = addDays(baseDate, 3);
  const dateE = addDays(baseDate, 4);
  const dateF = addDays(baseDate, 5);
  const dateG = addDays(baseDate, 6);

  try {
    check(
      "0. Fixtures created for two isolated businesses with real providers/services/customers",
      Boolean(
        businessA.businessId &&
          businessB.businessId &&
          providerA.id &&
          providerB.id,
      ),
    );

    {
      const rendezvous = createRendezvous(2, 15000);
      const repository = new AppointmentRepository(
        createControlledDb(rendezvous),
      );
      const deps = {
        ...defaultAppointmentCreateServiceDeps,
        appointmentRepository: repository,
      };
      const [first, second] = await Promise.all([
        createAppointmentRecord(deps, actorA, {
          customerId: customerA1.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: dateA,
          startTime: "10:00",
          notes: "",
        }),
        createAppointmentRecord(deps, actorA, {
          customerId: customerA2.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: dateA,
          startTime: "10:00",
          notes: "",
        }),
      ]);
      const successes = [first, second].filter((result) => result.success);
      const conflicts = [first, second].filter(
        (result) => !result.success && result.code === "SLOT_CONFLICT",
      );
      const persisted = await db.appointment.count({
        where: {
          businessId: businessA.businessId,
          providerId: providerA.id,
          date: toDate(dateA),
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      });
      check(
        "A. Concurrent identical-slot claims by two customers leave exactly one active booking",
        successes.length === 1 && conflicts.length === 1 && persisted === 1,
        `successes=${successes.length}, conflicts=${conflicts.length}, persisted=${persisted}`,
      );
    }

    {
      const rendezvous = createRendezvous(2, 15000);
      const repository = new AppointmentRepository(
        createControlledDb(rendezvous),
      );
      const deps = {
        ...defaultAppointmentCreateServiceDeps,
        appointmentRepository: repository,
      };
      const [first, second] = await Promise.all([
        createAppointmentRecord(deps, actorA, {
          customerId: customerA1.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: dateB,
          startTime: "11:00",
          notes: "",
        }),
        createAppointmentRecord(deps, actorA, {
          customerId: customerA2.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: dateB,
          startTime: "11:15",
          notes: "",
        }),
      ]);
      const successes = [first, second].filter((result) => result.success);
      const conflicts = [first, second].filter(
        (result) => !result.success && result.code === "SLOT_CONFLICT",
      );
      const rows = await db.appointment.findMany({
        where: {
          businessId: businessA.businessId,
          providerId: providerA.id,
          date: toDate(dateB),
          status: { in: ["PENDING", "CONFIRMED"] },
        },
        select: { startTime: true, endTime: true },
      });
      const overlapCount =
        rows.length === 2
          ? rows.filter(
              (row, index) =>
                rows.some(
                  (other, otherIndex) =>
                    otherIndex > index &&
                    row.startTime < other.endTime &&
                    row.endTime > other.startTime,
                ),
            ).length
          : 0;
      check(
        "B. Concurrent overlapping (not identical) intervals leave exactly one active booking",
        successes.length === 1 &&
          conflicts.length === 1 &&
          rows.length === 1 &&
          overlapCount === 0,
        `successes=${successes.length}, conflicts=${conflicts.length}, persisted=${rows.length}`,
      );
    }

    {
      const seeded = await seedSlotOffer({
        businessId: businessA.businessId,
        branchId: businessA.branchId,
        providerId: providerA.id,
        providerName: providerA.displayName ?? providerA.name,
        serviceId: serviceA.id,
        serviceName: serviceA.name,
        customerId: customerA3.id,
        date: dateC,
        startTime: "09:00",
        endTime: "09:30",
      });
      const deps = makeEngineDeps();
      const externalId = `${randomUUID()}-confirm`;
      const confirmationInput = {
        externalId,
        from: customerA3.phone,
        to: businessA.phone,
        text: "1",
        receivedAt: new Date().toISOString(),
      };
      const attempts = await Promise.all([
        receiveInboundMessage(deps, confirmationInput, {
          businessId: businessA.businessId,
        }),
        receiveInboundMessage(deps, confirmationInput, {
          businessId: businessA.businessId,
        }),
      ]);
      const processed = attempts.filter(
        (attempt) => attempt.ok && attempt.duplicate === false,
      );
      const duplicates = attempts.filter(
        (attempt) => attempt.ok && attempt.duplicate === true,
      );
      const afterConfirm = await db.appointment.count({
        where: {
          businessId: businessA.businessId,
          customerId: customerA3.id,
          date: toDate(dateC),
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      });
      const repeatedTap = await receiveInboundMessage(
        deps,
        {
          ...confirmationInput,
          externalId: `${externalId}-retry`,
          receivedAt: new Date().toISOString(),
        },
        { businessId: businessA.businessId },
      );
      const afterRepeatedTap = await db.appointment.count({
        where: {
          businessId: businessA.businessId,
          customerId: customerA3.id,
          date: toDate(dateC),
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      });
      check(
        "C. Concurrent duplicate confirmation and replay yield exactly one appointment",
        Boolean(
          seeded.offer &&
            processed.length === 1 &&
            duplicates.length === 1 &&
            afterConfirm === 1 &&
            repeatedTap.ok &&
            afterRepeatedTap === 1,
        ),
        `processed=${processed.length}, duplicates=${duplicates.length}, afterConfirm=${afterConfirm}, afterRepeat=${afterRepeatedTap}`,
      );
    }

    {
      const seeded = await seedSlotOffer({
        businessId: businessA.businessId,
        branchId: businessA.branchId,
        providerId: providerA.id,
        providerName: providerA.displayName ?? providerA.name,
        serviceId: serviceA.id,
        serviceName: serviceA.name,
        customerId: customerA4.id,
        date: dateD,
        startTime: "09:00",
        endTime: "09:30",
      });
      const rival = await appointmentRepository.createWithConflictCheck({
        businessId: businessA.businessId,
        branchId: businessA.branchId,
        customerId: customerA2.id,
        serviceId: serviceA.id,
        providerId: providerA.id,
        date: dateD,
        startTime: "09:00",
        endTime: "09:30",
        status: "CONFIRMED",
      });
      const selection = await receiveInboundMessage(
        makeEngineDeps(),
        {
          externalId: `${randomUUID()}-stale-offer`,
          from: customerA4.phone,
          to: businessA.phone,
          text: "1",
          receivedAt: new Date().toISOString(),
        },
        { businessId: businessA.businessId },
      );
      const customerBookings = await db.appointment.count({
        where: {
          businessId: businessA.businessId,
          customerId: customerA4.id,
          date: toDate(dateD),
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      });
      const slotBookings = await db.appointment.count({
        where: {
          businessId: businessA.businessId,
          providerId: providerA.id,
          date: toDate(dateD),
          startTime: toTime("09:00"),
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      });
      check(
        "D. A slot occupied after offer issuance is revalidated with no second booking",
        Boolean(
          seeded.offer &&
            rival &&
            selection.ok &&
            customerBookings === 0 &&
            slotBookings === 1,
        ),
        `rival=${Boolean(rival)}, selectionOk=${selection.ok}, customerBookings=${customerBookings}, slotBookings=${slotBookings}`,
      );
    }

    {
      await db.appointment.create({
        data: {
          businessId: businessA.businessId,
          branchId: businessA.branchId,
          customerId: customerA1.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: toDate(dateE),
          startTime: toTime("09:00"),
          endTime: toTime("09:30"),
          status: "CANCELLED",
        },
      });
      const canceledSlot = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorA,
        {
          customerId: customerA2.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: dateE,
          startTime: "09:00",
          notes: "",
        },
      );
      await db.appointment.create({
        data: {
          businessId: businessA.businessId,
          branchId: businessA.branchId,
          customerId: customerA1.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: toDate(dateE),
          startTime: toTime("10:00"),
          endTime: toTime("10:30"),
          status: "PENDING",
        },
      });
      const activeSlot = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorA,
        {
          customerId: customerA2.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: dateE,
          startTime: "10:00",
          notes: "",
        },
      );
      await db.appointment.create({
        data: {
          businessId: businessA.businessId,
          branchId: businessA.branchId,
          customerId: customerA1.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: toDate(dateE),
          startTime: toTime("11:00"),
          endTime: toTime("11:30"),
          status: "COMPLETED",
        },
      });
      const completedSlot = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorA,
        {
          customerId: customerA2.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: dateE,
          startTime: "11:00",
          notes: "",
        },
      );
      check(
        "E. Status policy releases CANCELLED/COMPLETED slots and blocks PENDING/CONFIRMED",
        canceledSlot.success === true &&
          !activeSlot.success &&
          activeSlot.code === "SLOT_CONFLICT" &&
          completedSlot.success === true,
        `canceled=${canceledSlot.success}, active=${!activeSlot.success ? activeSlot.code : "SUCCESS"}, completed=${completedSlot.success}`,
      );
    }

    {
      const appointmentB = await db.appointment.create({
        data: {
          businessId: businessB.businessId,
          branchId: businessB.branchId,
          customerId: customerB.id,
          serviceId: serviceB.id,
          providerId: providerB.id,
          date: toDate(dateF),
          startTime: toTime("14:00"),
          endTime: toTime("14:30"),
          status: "CONFIRMED",
        },
      });
      const foreignCustomer = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorA,
        {
          customerId: customerB.id,
          serviceId: serviceA.id,
          date: dateF,
          startTime: "15:00",
          notes: "",
        },
      );
      const foreignService = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorA,
        {
          customerId: customerA1.id,
          serviceId: serviceB.id,
          date: dateF,
          startTime: "15:00",
          notes: "",
        },
      );
      const foreignProvider = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorA,
        {
          customerId: customerA1.id,
          serviceId: serviceA.id,
          providerId: providerB.id,
          date: dateF,
          startTime: "15:00",
          notes: "",
        },
      );
      const foreignAvailability = await getAvailability(
        defaultAvailabilityServiceDeps,
        actorA,
        { serviceId: serviceB.id, date: dateF },
      );
      const foreignExclude = await getAvailability(
        defaultAvailabilityServiceDeps,
        actorA,
        {
          serviceId: serviceA.id,
          date: dateF,
          excludeAppointmentId: appointmentB.id,
        },
      );
      const foreignDetail = await getAppointmentDetail(
        businessA.businessId,
        appointmentB.id,
      );
      const foreignContext = await resolveBookingContext(
        defaultBookingFlowServiceDeps,
        actorA,
        {
          customerId: customerB.id,
          serviceId: serviceB.id,
          providerId: providerB.id,
        },
      );
      const foreignMutation =
        await appointmentRepository.correctPerformedService(
          appointmentB.id,
          businessA.businessId,
          {
            performedServiceId: serviceB.id,
            correctedById: randomUUID(),
            historyEntry: { probe: true },
          },
        );
      const unchangedB = await db.appointment.findUnique({
        where: { id: appointmentB.id },
      });
      check(
        "F. Cross-tenant customer/service/provider/appointment use is rejected without mutation",
        Boolean(
          !foreignCustomer.success &&
            foreignCustomer.code === "CUSTOMER_NOT_FOUND" &&
            !foreignService.success &&
            foreignService.code === "SERVICE_UNAVAILABLE" &&
            !foreignProvider.success &&
            foreignProvider.code === "PROVIDER_NOT_ELIGIBLE" &&
            !foreignAvailability.success &&
            foreignAvailability.error.code === "SERVICE_NOT_FOUND" &&
            !foreignExclude.success &&
            foreignExclude.error.code === "FORBIDDEN" &&
            foreignDetail === null &&
            foreignContext.customer === null &&
            foreignContext.serviceId === null &&
            foreignContext.providerId === null &&
            foreignMutation === null &&
            unchangedB?.performedServiceId === null,
        ),
        `customer=${!foreignCustomer.success ? foreignCustomer.code : "SUCCESS"}, service=${!foreignService.success ? foreignService.code : "SUCCESS"}, provider=${!foreignProvider.success ? foreignProvider.code : "SUCCESS"}, exclude=${!foreignExclude.success ? foreignExclude.error.code : "SUCCESS"}`,
      );
    }

    {
      await db.appointment.create({
        data: {
          businessId: businessB.businessId,
          branchId: businessB.branchId,
          customerId: customerB.id,
          serviceId: serviceB.id,
          providerId: providerB.id,
          date: toDate(dateG),
          startTime: toTime("14:00"),
          endTime: toTime("14:30"),
          status: "CONFIRMED",
        },
      });
      const providerABooking = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorA,
        {
          customerId: customerA1.id,
          serviceId: serviceA.id,
          providerId: providerA.id,
          date: dateG,
          startTime: "12:00",
          notes: "",
        },
      );
      const providerA2Availability = await getAvailability(
        defaultAvailabilityServiceDeps,
        actorA,
        {
          serviceId: serviceA.id,
          providerId: providerA2.id,
          date: dateG,
        },
      );
      const providerA2Slot =
        providerA2Availability.success &&
        providerA2Availability.data.slots.some(
          (slot) => slot.startTime === "12:00",
        );
      const providerA2Booking = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorA,
        {
          customerId: customerA2.id,
          serviceId: serviceA.id,
          providerId: providerA2.id,
          date: dateG,
          startTime: "12:00",
          notes: "",
        },
      );
      const businessBBooking = await createAppointmentRecord(
        defaultAppointmentCreateServiceDeps,
        actorB,
        {
          customerId: customerB.id,
          serviceId: serviceB.id,
          providerId: providerB.id,
          date: dateG,
          startTime: "12:00",
          notes: "",
        },
      );
      check(
        "G. Unrelated provider and unrelated business bookings do not block the target provider",
        providerABooking.success === true &&
          providerA2Booking.success === true &&
          businessBBooking.success === true &&
          providerA2Slot === true,
        `providerA=${providerABooking.success}, providerA2=${providerA2Booking.success}, businessB=${businessBBooking.success}, providerA2Slot=${providerA2Slot}`,
      );
    }
  } finally {
    const businessIds = [businessA.businessId, businessB.businessId];
    await db.appointmentReminder.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.appointment.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.followUpRequest.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.message.deleteMany({
      where: { conversation: { businessId: { in: businessIds } } },
    });
    await db.operatorAttention.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.knowledgeGap.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.conversationStateRecord.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.inboundMessageDedupe.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.usageRecord.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.conversation.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.customer.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.providerServiceExclusion.deleteMany({
      where: { provider: { businessId: { in: businessIds } } },
    });
    await db.providerService.deleteMany({
      where: { provider: { businessId: { in: businessIds } } },
    });
    await db.providerProfile.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.service.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.business.updateMany({
      where: { id: { in: businessIds } },
      data: { defaultBranchId: null },
    });
    await db.branch.deleteMany({
      where: { businessId: { in: businessIds } },
    });
    await db.business.deleteMany({ where: { id: { in: businessIds } } });
  }

  const failed = checks.filter((entry) => !entry.pass);
  console.log(
    `\nTotal: ${checks.length} | Passed: ${checks.length - failed.length} | Failed: ${failed.length}`,
  );
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Booking concurrency/tenant-isolation DB check failed:", error);
  process.exit(1);
});
