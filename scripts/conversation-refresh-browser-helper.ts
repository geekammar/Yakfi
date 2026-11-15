import "./setup-test-env";

import { randomUUID } from "node:crypto";

import { createLocalAccountIssuer } from "better-auth/db";
import { hashPassword } from "better-auth/crypto";

import { db } from "../src/server/db";

function isDisposableDatabase(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    return (
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

async function createFixture(email: string, password: string, name: string) {
  const userId = randomUUID();
  const suffix = Date.now().toString(36);
  const phoneSuffix = Date.now().toString().slice(-7);

  const business = await db.business.create({
    data: {
      name: "عيادة التحديث الحيّ",
      whatsappNumber: `+2010${phoneSuffix}`,
      timezone: "Africa/Cairo",
      onboardingCompletedAt: new Date(),
    },
  });

  const branch = await db.branch.create({
    data: { businessId: business.id, name: "الفرع الرئيسي" },
  });
  await db.business.update({
    where: { id: business.id },
    data: { defaultBranchId: branch.id },
  });
  await db.user.create({
    data: {
      id: userId,
      name,
      email,
      emailVerified: true,
      image: null,
      businessId: business.id,
      role: "ADMIN",
      isActive: true,
      accountType: "BUSINESS",
    },
  });
  await db.account.create({
    data: {
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      password: await hashPassword(password),
    },
  });

  const service = await db.service.create({
    data: {
      businessId: business.id,
      name: `استشارة ${suffix}`,
      durationMinutes: 30,
      isActive: true,
    },
  });

  const customer = await db.customer.create({
    data: {
      businessId: business.id,
      name: "عميل التحديث الحيّ",
      phone: `+2011${phoneSuffix}`,
    },
  });

  const conversation = await db.conversation.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      branchId: branch.id,
      status: "AI_ACTIVE",
      aiSummary: "ملخص أولي من الخادم",
      lastMessageAt: new Date("2026-11-20T09:00:01.000Z"),
      messages: {
        create: [
          {
            senderType: "CUSTOMER",
            content: "الرسالة الأولى قبل فتح المحادثة",
            createdAt: new Date("2026-11-20T09:00:00.000Z"),
          },
          {
            senderType: "AI",
            content: "رد المساعد الأول قبل فتح المحادثة",
            createdAt: new Date("2026-11-20T09:00:01.000Z"),
          },
        ],
      },
    },
  });

  await db.appointment.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      serviceId: service.id,
      branchId: branch.id,
      date: new Date("2026-11-20T00:00:00.000Z"),
      startTime: new Date("2026-11-20T10:00:00.000Z"),
      endTime: new Date("2026-11-20T10:30:00.000Z"),
      status: "CONFIRMED",
    },
  });

  return {
    userId,
    businessId: business.id,
    conversationId: conversation.id,
    customerId: customer.id,
    serviceId: service.id,
  };
}

async function appendLiveUpdate(conversationId: string) {
  const conversation = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
  });
  const owner = await db.user.findFirstOrThrow({
    where: { businessId: conversation.businessId, role: "ADMIN" },
  });
  const suffix = Date.now().toString(36);
  const now = Date.now();
  const service = await db.service.create({
    data: {
      businessId: conversation.businessId,
      name: `خدمة التحديث ${suffix}`,
      durationMinutes: 45,
      isActive: true,
    },
  });

  await db.message.createMany({
    data: [
      {
        conversationId,
        senderType: "CUSTOMER",
        content: `رسالة عميل جديدة ${suffix}`,
        createdAt: new Date(now - 1_000),
      },
      {
        conversationId,
        senderType: "AI",
        content: `رد المساعد الجديد ${suffix}`,
        createdAt: new Date(now),
      },
    ],
  });

  await db.conversation.update({
    where: { id: conversationId },
    data: {
      status: "NEED_HUMAN",
      assignedUserId: owner.id,
      lastMessageAt: new Date(now),
    },
  });

  await db.appointment.create({
    data: {
      businessId: conversation.businessId,
      customerId: conversation.customerId,
      serviceId: service.id,
      branchId: conversation.branchId,
      date: new Date("2026-11-25T00:00:00.000Z"),
      startTime: new Date("2026-11-25T11:00:00.000Z"),
      endTime: new Date("2026-11-25T11:45:00.000Z"),
      status: "CONFIRMED",
    },
  });

  await db.operatorAttention.upsert({
    where: { conversationId },
    create: {
      businessId: conversation.businessId,
      conversationId,
      reason: "AI_HANDOFF",
      cause: "CUSTOMER_REQUESTED_HUMAN",
    },
    update: {
      reason: "AI_HANDOFF",
      cause: "CUSTOMER_REQUESTED_HUMAN",
      createdAt: new Date(),
      resolvedAt: null,
      resolvedById: null,
    },
  });

  return {
    customerMessage: `رسالة عميل جديدة ${suffix}`,
    aiMessage: `رد المساعد الجديد ${suffix}`,
    serviceName: `خدمة التحديث ${suffix}`,
  };
}

async function getAttentionState(conversationId: string) {
  const row = await db.operatorAttention.findUnique({
    where: { conversationId },
  });
  return {
    resolvedAt: row?.resolvedAt?.toISOString() ?? null,
    resolvedById: row?.resolvedById ?? null,
  };
}

async function cleanup(userId: string, businessId: string) {
  if (userId) {
    await db.session.deleteMany({ where: { userId } });
    await db.account.deleteMany({ where: { userId } });
    await db.user.deleteMany({ where: { id: userId } });
  }
  if (businessId) {
    await db.business.deleteMany({ where: { id: businessId } });
  }
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!isDisposableDatabase(dbUrl)) {
    console.error(
      "Refusing to run: DATABASE_URL must point to a disposable local " +
        "database.",
    );
    process.exit(1);
  }

  const [action, ...args] = process.argv.slice(2);

  if (action === "create-fixture") {
    const [email, password, name] = args;
    if (!email || !password || !name) {
      console.error("Missing arguments for create-fixture");
      process.exit(1);
    }
    console.log(JSON.stringify(await createFixture(email, password, name)));
    return;
  }

  if (action === "append-live-update") {
    const [conversationId] = args;
    if (!conversationId) {
      console.error("Missing conversationId for append-live-update");
      process.exit(1);
    }
    console.log(JSON.stringify(await appendLiveUpdate(conversationId)));
    return;
  }

  if (action === "get-attention-state") {
    const [conversationId] = args;
    if (!conversationId) {
      console.error("Missing conversationId for get-attention-state");
      process.exit(1);
    }
    console.log(JSON.stringify(await getAttentionState(conversationId)));
    return;
  }

  if (action === "cleanup") {
    const [userId, businessId] = args;
    await cleanup(userId ?? "", businessId ?? "");
    console.log(JSON.stringify({ cleaned: true }));
    return;
  }

  console.error("Unknown action:", action);
  process.exit(1);
}

main().catch((error) => {
  console.error("Helper error:", error);
  process.exit(1);
});
