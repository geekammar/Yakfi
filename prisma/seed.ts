/**
 * FlowPilot seed — Arabic demo dataset (Egyptian dental-clinic demo business
 * only for local discovery; the product itself stays vertical-agnostic).
 *
 * Run with: pnpm db:seed
 * Requires a reachable DATABASE_URL. Idempotent: wipes demo rows first.
 * All content lives in prisma/demo-data.ts (pure, deterministic, testable).
 */

import { PrismaClient } from "../src/generated/prisma/client";
import {
  BUSINESS_TIMEZONE,
  DEMO_IDS,
  dateIn,
  demoAppointments,
  demoBusiness,
  demoConversations,
  demoCustomers,
  demoServices,
  demoTeam,
  stableId,
} from "./demo-data";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { createLocalAccountIssuer } from "better-auth/db";

import "dotenv/config";

function makeDb(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      "❌ DATABASE_URL غير معرّف. انسخ .env.example إلى .env وضع قيمة صحيحة.",
    );
    process.exit(1);
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const prisma = makeDb();

async function main() {
  console.log("🌱 بدء تعبئة البيانات التجريبية…");

  // ── Wipe previous demo data (idempotent re-runs, demo business only) ──
  await prisma.usageRecord.deleteMany({
    where: { businessId: DEMO_IDS.business },
  });
  await prisma.inboundMessageDedupe.deleteMany({
    where: { businessId: DEMO_IDS.business },
  });
  await prisma.message.deleteMany({
    where: { conversation: { businessId: DEMO_IDS.business } },
  });
  await prisma.conversation.deleteMany({
    where: { businessId: DEMO_IDS.business },
  });
  await prisma.appointment.deleteMany({
    where: { businessId: DEMO_IDS.business },
  });
  await prisma.customer.deleteMany({
    where: { businessId: DEMO_IDS.business },
  });
  await prisma.service.deleteMany({
    where: { businessId: DEMO_IDS.business },
  });
  // Release the Default-Branch pointer before deleting branches (ARCH-02:
  // businesses.default_branch_id → branches is ON DELETE RESTRICT — without
  // this, a re-run would fail on the FK while wiping). No-op on a fresh
  // database where the demo business does not exist yet.
  await prisma.business.updateMany({
    where: { id: DEMO_IDS.business },
    data: { defaultBranchId: null },
  });
  await prisma.branch.deleteMany({
    where: { businessId: DEMO_IDS.business },
  });

  // ── Business: عيادة الابتسامة (كفر الشيخ) ──
  const business = await prisma.business.upsert({
    where: { id: DEMO_IDS.business },
    update: {
      name: demoBusiness.name,
      vertical: demoBusiness.vertical,
      city: demoBusiness.city,
      whatsappNumber: demoBusiness.whatsappNumber,
      timezone: BUSINESS_TIMEZONE,
      about: demoBusiness.about,
      cancellationPolicy: demoBusiness.cancellationPolicy,
      workingHours: demoBusiness.workingHours,
      slotDurationMinutes: demoBusiness.slotDurationMinutes,
      faqs: demoBusiness.faqs,
      onboardingCompletedAt: new Date(),
      isActive: true,
    },
    create: {
      id: DEMO_IDS.business,
      name: demoBusiness.name,
      vertical: demoBusiness.vertical,
      city: demoBusiness.city,
      whatsappNumber: demoBusiness.whatsappNumber,
      timezone: BUSINESS_TIMEZONE,
      about: demoBusiness.about,
      cancellationPolicy: demoBusiness.cancellationPolicy,
      workingHours: demoBusiness.workingHours,
      slotDurationMinutes: demoBusiness.slotDurationMinutes,
      faqs: demoBusiness.faqs,
      onboardingCompletedAt: new Date(),
      isActive: true,
    },
  });
  console.log("✔ المنشأة:", business.name, `(${demoBusiness.city})`);

  // ── Default Branch (DECISIONS #30, PROMPT-ARCH-02) ──
  const branch = await prisma.branch.create({
    data: {
      id: stableId("branch", "default"),
      businessId: business.id,
      name: "الفرع الرئيسي",
      isActive: true,
    },
  });
  await prisma.business.update({
    where: { id: business.id },
    data: { defaultBranchId: branch.id },
  });
  console.log("✔ الفرع الافتراضي:", branch.name);

  // ── Team: ADMIN + STAFF demo users (with login credentials) ──
  const users = new Map<"admin" | "staff", string>();

  const userId = (key: "admin" | "staff" | null): string | undefined => {
    if (!key) return undefined;
    const id = users.get(key);
    if (!id) throw new Error(`حساب الفريق مفقود: ${key}`);
    return id;
  };

  for (const member of demoTeam) {
    const user = await prisma.user.upsert({
      where: { email: member.email },
      update: {
        name: member.name,
        role: member.role,
        businessId: business.id,
        isActive: true,
      },
      create: {
        id: member.id,
        name: member.name,
        email: member.email,
        emailVerified: true,
        image: null,
        role: member.role,
        businessId: business.id,
        isActive: true,
      },
    });

    // Better Auth credential account — lets the demo user sign in immediately.
    // `issuer` (Better Auth v1.7 core field) is required by sign-in's
    // credential-account matching (sign-in looks up providerId "credential"
    // + issuer "local:credential" + accountId = user id).
    const existing = await prisma.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
    });
    if (!existing) {
      await prisma.account.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          password: await hashPassword(member.password),
        },
      });
    } else if (existing.issuer !== createLocalAccountIssuer("credential")) {
      // Repair pre-issuer accounts (seeded before the column existed).
      await prisma.account.update({
        where: { id: existing.id },
        data: { issuer: createLocalAccountIssuer("credential") },
      });
    }

    users.set(member.key, user.id);
  }

  console.log(
    "✔ الفريق:",
    demoTeam.map((member) => member.name).join(" و"),
    `— دخول تجريبي: ${demoTeam[0]!.email} / ${demoTeam[0]!.password} · ${demoTeam[1]!.email} / ${demoTeam[1]!.password}`,
  );

  // ── Services ──
  const serviceIds: Record<string, string> = {};

  for (const service of demoServices) {
    const created = await prisma.service.create({
      data: {
        id: stableId("service", service.key),
        businessId: business.id,
        name: service.name,
        description: service.description,
        durationMinutes: service.durationMinutes,
        isActive: true,
      },
    });
    serviceIds[service.key] = created.id;
  }
  console.log(
    `✔ الخدمات: ${demoServices.length} (${demoServices.map((s) => s.name).join("، ")})`,
  );

  // ── Customers ──
  const customerIds: string[] = [];

  for (const customer of demoCustomers) {
    await prisma.customer.create({
      data: {
        id: customer.id,
        businessId: business.id,
        name: customer.name,
        phone: customer.phone,
        notes: customer.notes ?? undefined,
      },
    });
    customerIds.push(customer.id);
  }
  console.log(`✔ العملاء: ${demoCustomers.length} عميل بأرقام مصرية`);

  // ── Conversations + messages (real Egyptian-Arabic WhatsApp flow) ──
  for (const conversation of demoConversations) {
    const customerId = customerIds[conversation.customerIndex];
    if (!customerId) {
      throw new Error(
        `customerIndex خارج النطاق: ${conversation.customerIndex}`,
      );
    }

    const lastMessage =
      conversation.messages[conversation.messages.length - 1] ?? null;
    const lastMessageAt = lastMessage
      ? new Date(Date.now() - lastMessage.minutesAgo * 60_000)
      : new Date();

    const created = await prisma.conversation.create({
      data: {
        id: conversation.id,
        businessId: business.id,
        customerId,
        branchId: branch.id,
        assignedUserId: userId(conversation.assignee),
        status: conversation.status,
        aiSummary: conversation.aiSummary ?? undefined,
        lastMessageAt,
      },
    });

    await prisma.message.createMany({
      data: conversation.messages.map((message) => ({
        conversationId: created.id,
        senderType: message.senderType,
        content: message.content,
        createdAt: new Date(Date.now() - message.minutesAgo * 60_000),
      })),
    });

    await prisma.customer.update({
      where: { id: customerId },
      data: { lastConversationAt: lastMessageAt },
    });
  }
  console.log(
    `✔ المحادثات: ${demoConversations.length} محادثة (${demoConversations.reduce((total, conversation) => total + conversation.messages.length, 0)} رسالة)`,
  );

  // ── Appointments (all statuses, past/today/upcoming) ──
  const now = new Date();
  const statusCount: Record<string, number> = {};

  for (const appointment of demoAppointments) {
    const customerId = customerIds[appointment.customerIndex];
    const serviceId = serviceIds[appointment.serviceKey];
    if (!customerId || !serviceId) {
      throw new Error(
        `مرجع غير صالح في المواعيد: عميل ${appointment.customerIndex} / خدمة ${appointment.serviceKey}`,
      );
    }

    const date = dateIn(now, appointment.dayOffset);

    await prisma.appointment.create({
      data: {
        id: stableId(
          "appointment",
          `${appointment.dayOffset}-${appointment.start}-${appointment.customerIndex}`,
        ),
        businessId: business.id,
        customerId,
        serviceId,
        branchId: branch.id,
        assignedUserId: userId(appointment.assignee),
        date: new Date(`${date}T00:00:00.000Z`),
        startTime: new Date(`1970-01-01T${appointment.start}:00.000Z`),
        endTime: new Date(`1970-01-01T${appointment.end}:00.000Z`),
        status: appointment.status,
        notes: appointment.notes ?? undefined,
      },
    });

    statusCount[appointment.status] =
      (statusCount[appointment.status] ?? 0) + 1;

    if (appointment.dayOffset < 0) {
      await prisma.customer.update({
        where: { id: customerId },
        data: { lastAppointmentAt: new Date(`${date}T00:00:00.000Z`) },
      });
    }
  }
  console.log(
    `✔ المواعيد: ${demoAppointments.length} (${Object.entries(statusCount)
      .map(([status, count]) => `${count} ${status}`)
      .join(" · ")})`,
  );

  console.log("✅ تمت تعبئة البيانات التجريبية بنجاح — البيانات للتجربة فقط.");
}

main()
  .catch((error) => {
    console.error("❌ فشلت عملية التعبئة:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
