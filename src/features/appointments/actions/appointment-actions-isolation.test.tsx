// @vitest-environment node
/**
 * FlowPilot — REAL appointment action tenant-isolation evidence.
 *
 * These tests import the REAL exported server actions
 * (`updateAppointmentStatus` / `rescheduleAppointment`) and exercise the REAL
 * repository + PostgreSQL write paths against a disposable CI database.
 *
 * BOUNDARY (explicit): this is not a browser-auth test. The Next.js
 * `requireUser()` session boundary is controlled at the module seam; the
 * action still performs its own `session.user.id -> persisted user -> tenant`
 * resolution through the REAL `userRepository.findById` and the REAL database.
 * A spoofed session business claim and a client-supplied `businessId` are both
 * ignored; the persisted user's tenant is the only authority. Full cookie /
 * Better Auth browser verification remains covered by the existing browser
 * recovery journey, not by this file.
 *
 * SAFETY: the run refuses any non-loopback DATABASE_URL before fixture writes.
 * CI supplies only the job-local `postgres:16` service, never runtime/Neon
 * credentials.
 */
import { randomUUID } from "node:crypto";

import { db } from "@/server/db";
import type { AppointmentStatus } from "@/types/domain";

import {
  rescheduleAppointment,
  updateAppointmentStatus,
} from "./appointment-actions";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const { requireUserMock, revalidatePathMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(),
  revalidatePathMock: vi.fn(),
}));

vi.mock("@/server/auth/guards", () => ({
  requireUser: requireUserMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

function classifyLocalDatabaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    return (
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === ""
    );
  } catch {
    return false;
  }
}

function toDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toTime(time: string): Date {
  return new Date(`1970-01-01T${time}:00.000Z`);
}

type Fixture = {
  businessId: string;
  branchId: string;
  userId: string;
  serviceId: string;
  customerId: string;
};

const createdBusinessIds: string[] = [];
const createdUserIds: string[] = [];

let businessA: Fixture | undefined;
let businessB: Fixture | undefined;
let tenantlessUserId: string | undefined;

function requireFixtureA(): Fixture {
  if (!businessA) throw new Error("FIXTURE_A_NOT_READY");
  return businessA;
}

function requireFixtureB(): Fixture {
  if (!businessB) throw new Error("FIXTURE_B_NOT_READY");
  return businessB;
}

async function createFixture(name: string): Promise<Fixture> {
  const businessId = randomUUID();
  const branchId = randomUUID();
  const userId = randomUUID();
  const serviceId = randomUUID();
  const customerId = randomUUID();
  createdBusinessIds.push(businessId);
  createdUserIds.push(userId);

  await db.business.create({
    data: {
      id: businessId,
      name,
      whatsappNumber: `+2012${Math.floor(10000000 + Math.random() * 90000000)}`,
      isActive: true,
      timezone: "Africa/Cairo",
      confirmationMode: "automatic",
      reminderEnabled: false,
    },
  });
  await db.branch.create({
    data: { id: branchId, businessId, name: "الفرع الرئيسي" },
  });
  await db.business.update({
    where: { id: businessId },
    data: { defaultBranchId: branchId },
  });
  await db.user.create({
    data: {
      id: userId,
      name: `مدير ${name}`,
      email: `${userId}@flowpilot.invalid`,
      emailVerified: false,
      accountType: "BUSINESS",
      businessId,
      role: "ADMIN",
      isActive: true,
    },
  });
  await db.service.create({
    data: {
      id: serviceId,
      businessId,
      name: `خدمة ${name}`,
      durationMinutes: 30,
      isActive: true,
    },
  });
  await db.customer.create({
    data: {
      id: customerId,
      businessId,
      name: `عميل ${name}`,
      phone: `+2011${Math.floor(10000000 + Math.random() * 90000000)}`,
    },
  });

  return { businessId, branchId, userId, serviceId, customerId };
}

async function createAppointment(
  fixture: Fixture,
  options: {
    date: string;
    startTime?: string;
    endTime?: string;
    status?: AppointmentStatus;
  },
) {
  const startTime = options.startTime ?? "09:00";
  const endTime = options.endTime ?? "09:30";
  const appointment = await db.appointment.create({
    data: {
      businessId: fixture.businessId,
      branchId: fixture.branchId,
      customerId: fixture.customerId,
      serviceId: fixture.serviceId,
      date: toDate(options.date),
      startTime: toTime(startTime),
      endTime: toTime(endTime),
      status: options.status ?? "CONFIRMED",
    },
  });
  const reminder = await db.appointmentReminder.create({
    data: {
      businessId: fixture.businessId,
      appointmentId: appointment.id,
      status: "PENDING",
      dueAt: new Date(`${options.date}T06:00:00.000Z`),
      leadHours: 24,
    },
  });
  return { appointment, reminder };
}

function sessionFor(userId: string, businessId?: string) {
  return {
    user: {
      id: userId,
      ...(businessId ? { businessId } : {}),
    },
  };
}

beforeAll(async () => {
  if (!classifyLocalDatabaseUrl(process.env.DATABASE_URL ?? "")) {
    throw new Error(
      "DEV_DB_INTEGRATION_BLOCKED: DATABASE_URL must point to a local disposable test database.",
    );
  }

  businessA = await createFixture("منشأة أف");
  businessB = await createFixture("منشأة باء");

  tenantlessUserId = randomUUID();
  createdUserIds.push(tenantlessUserId);
  await db.user.create({
    data: {
      id: tenantlessUserId,
      name: "مستخدم بلا منشأة",
      email: `${tenantlessUserId}@flowpilot.invalid`,
      emailVerified: false,
      accountType: "BUSINESS",
      role: "STAFF",
      isActive: true,
    },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  if (createdBusinessIds.length > 0) {
    await db.appointmentReminder.deleteMany({
      where: { businessId: { in: createdBusinessIds } },
    });
    await db.appointment.deleteMany({
      where: { businessId: { in: createdBusinessIds } },
    });
    await db.customer.deleteMany({
      where: { businessId: { in: createdBusinessIds } },
    });
    await db.service.deleteMany({
      where: { businessId: { in: createdBusinessIds } },
    });
    await db.business.updateMany({
      where: { id: { in: createdBusinessIds } },
      data: { defaultBranchId: null },
    });
    await db.branch.deleteMany({
      where: { businessId: { in: createdBusinessIds } },
    });
    await db.business.deleteMany({
      where: { id: { in: createdBusinessIds } },
    });
  }
  if (createdUserIds.length > 0) {
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

describe("disposable database safety", () => {
  it("rejects runtime/Neon targets and accepts loopback targets", () => {
    expect(
      classifyLocalDatabaseUrl(
        "postgresql://user:password@ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech/neondb",
      ),
    ).toBe(false);
    expect(
      classifyLocalDatabaseUrl(
        "postgresql://user:password@flowpilot-prod.example.com/neondb",
      ),
    ).toBe(false);
    expect(
      classifyLocalDatabaseUrl(
        "postgresql://postgres:password@localhost:5432/flowpilot_test",
      ),
    ).toBe(true);
  });
});

describe("updateAppointmentStatus tenant isolation", () => {
  it("rejects actor A cancelling B's appointment and leaves the foreign row + reminder unchanged", async () => {
    const a = requireFixtureA();
    const b = requireFixtureB();
    const { appointment: foreign, reminder } = await createAppointment(b, {
      date: "2031-04-10",
    });
    const beforeAppointment = await db.appointment.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    const beforeReminder = await db.appointmentReminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });

    requireUserMock.mockResolvedValue(sessionFor(a.userId));
    const result = await updateAppointmentStatus({
      id: foreign.id,
      status: "CANCELLED",
    });

    expect(result.success).toBe(false);
    const afterAppointment = await db.appointment.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    const afterReminder = await db.appointmentReminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });
    expect(afterAppointment).toEqual(beforeAppointment);
    expect(afterReminder).toEqual(beforeReminder);
    expect(afterAppointment.status).toBe("CONFIRMED");
    expect(afterReminder.status).toBe("PENDING");
  });

  it("same-business control: actor A cancels A's appointment and reconciles its reminder", async () => {
    const a = requireFixtureA();
    const { appointment, reminder } = await createAppointment(a, {
      date: "2031-04-11",
    });

    requireUserMock.mockResolvedValue(sessionFor(a.userId));
    const result = await updateAppointmentStatus({
      id: appointment.id,
      status: "CANCELLED",
    });

    expect(result.success).toBe(true);
    const updated = await db.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    const updatedReminder = await db.appointmentReminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });
    expect(updated.status).toBe("CANCELLED");
    expect(updatedReminder.status).toBe("CANCELLED");
    expect(updatedReminder.lastError).toBe("APPOINTMENT_CANCELLED");
  });
});

describe("rescheduleAppointment tenant isolation", () => {
  it("rejects actor A rescheduling B's appointment and leaves foreign state unchanged", async () => {
    const a = requireFixtureA();
    const b = requireFixtureB();
    const { appointment: foreign, reminder } = await createAppointment(b, {
      date: "2031-04-12",
      startTime: "10:00",
      endTime: "10:30",
    });
    const beforeAppointment = await db.appointment.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    const beforeReminder = await db.appointmentReminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });

    requireUserMock.mockResolvedValue(sessionFor(a.userId));
    const result = await rescheduleAppointment({
      id: foreign.id,
      date: "2031-04-13",
      startTime: "16:00",
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.code).toBe("NOT_FOUND");
    const afterAppointment = await db.appointment.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    const afterReminder = await db.appointmentReminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });
    expect(afterAppointment).toEqual(beforeAppointment);
    expect(afterReminder).toEqual(beforeReminder);
  });

  it("same-business control: actor A reschedules A's appointment through the real conflict-checked write", async () => {
    const a = requireFixtureA();
    const { appointment, reminder } = await createAppointment(a, {
      date: "2031-04-14",
      startTime: "09:00",
      endTime: "09:30",
    });

    requireUserMock.mockResolvedValue(sessionFor(a.userId));
    const result = await rescheduleAppointment({
      id: appointment.id,
      date: "2031-04-15",
      startTime: "15:45",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.appointmentId).toBe(appointment.id);
      expect(result.date).toBe("2031-04-15");
      expect(result.startTime).toBe("15:45");
      expect(result.endTime).toBe("16:15");
    }
    const updated = await db.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    const updatedReminder = await db.appointmentReminder.findUniqueOrThrow({
      where: { id: reminder.id },
    });
    expect(updated.date.toISOString().slice(0, 10)).toBe("2031-04-15");
    expect(updated.startTime.toISOString().slice(11, 16)).toBe("15:45");
    expect(updated.endTime.toISOString().slice(11, 16)).toBe("16:15");
    expect(updatedReminder.status).toBe("CANCELLED");
    expect(updatedReminder.lastError).toBe("RESCHEDULED");
  });
});

describe("session-to-persisted-user/tenant boundary", () => {
  it("ignores a spoofed session tenant and client businessId; persisted user tenant wins", async () => {
    const a = requireFixtureA();
    const b = requireFixtureB();
    const { appointment: own } = await createAppointment(a, {
      date: "2031-04-16",
    });
    const { appointment: foreign } = await createAppointment(b, {
      date: "2031-04-16",
    });
    const beforeForeign = await db.appointment.findUniqueOrThrow({
      where: { id: foreign.id },
    });

    requireUserMock.mockResolvedValue(sessionFor(a.userId, b.businessId));
    const result = await updateAppointmentStatus({
      id: own.id,
      status: "CANCELLED",
      businessId: b.businessId,
    });

    expect(result.success).toBe(true);
    const updatedOwn = await db.appointment.findUniqueOrThrow({
      where: { id: own.id },
    });
    const afterForeign = await db.appointment.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(updatedOwn.status).toBe("CANCELLED");
    expect(afterForeign).toEqual(beforeForeign);
  });

  it("rejects a session id with no persisted user and a persisted user without a tenant", async () => {
    const a = requireFixtureA();
    const { appointment } = await createAppointment(a, {
      date: "2031-04-17",
    });
    const before = await db.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });

    requireUserMock.mockResolvedValue(sessionFor(randomUUID()));
    const missingUser = await updateAppointmentStatus({
      id: appointment.id,
      status: "CANCELLED",
    });
    expect(missingUser.success).toBe(false);

    if (!tenantlessUserId) throw new Error("TENANTLESS_USER_NOT_READY");
    requireUserMock.mockResolvedValue(sessionFor(tenantlessUserId));
    const noTenant = await updateAppointmentStatus({
      id: appointment.id,
      status: "CANCELLED",
    });
    expect(noTenant.success).toBe(false);

    const after = await db.appointment.findUniqueOrThrow({
      where: { id: appointment.id },
    });
    expect(after).toEqual(before);
    expect(after.status).toBe("CONFIRMED");
  });
});
