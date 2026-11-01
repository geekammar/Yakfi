/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

import { auth } from "../src/lib/auth";
import { db } from "../src/server/db";

function classifyTarget(
  url: string,
): { host: string; local: boolean; reason: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    const isLocal =
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === "";
    return {
      host,
      local: isLocal,
      reason: isLocal
        ? "local / disposable test database"
        : "remote host rejected",
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const classification = classifyTarget(dbUrl);
  if (!classification?.local) {
    console.error(
      "Refusing to execute against non-disposable target. DATABASE_URL must point to a local disposable test database (localhost/127.0.0.1).",
    );
    process.exit(1);
  }

  const [action, ...args] = process.argv.slice(2);

  if (action === "create-synthetic-user") {
    const [email, password, name] = args;
    if (!email || !password || !name) {
      console.error("Missing arguments for create-synthetic-user");
      process.exit(1);
    }

    await (auth.api.signUpEmail as any)({
      body: {
        email,
        password,
        name,
      },
    });

    const business = await db.business.create({
      data: {
        name: "Recovery Test Clinic",
        whatsappNumber: "+966500000001",
        timezone: "Asia/Riyadh",
        onboardingCompletedAt: new Date(),
      },
    });

    const user = await db.user.update({
      where: { email },
      data: {
        isActive: true,
        businessId: business.id,
        role: "ADMIN",
      },
    });

    console.log(JSON.stringify({ userId: user.id, businessId: business.id }));
    return;
  }

  if (action === "revoke-user-sessions") {
    const [userId] = args;
    if (!userId) {
      console.error("Missing userId for revoke-user-sessions");
      process.exit(1);
    }

    const deleted = await db.session.deleteMany({
      where: { userId },
    });

    console.log(JSON.stringify({ count: deleted.count }));
    return;
  }

  if (action === "expire-user-sessions") {
    const [userId] = args;
    if (!userId) {
      console.error("Missing userId for expire-user-sessions");
      process.exit(1);
    }

    const updated = await db.session.updateMany({
      where: { userId },
      data: {
        expiresAt: new Date(Date.now() - 3600_000),
      },
    });

    console.log(JSON.stringify({ count: updated.count }));
    return;
  }

  if (action === "cleanup-user") {
    const [userId, businessId] = args;
    if (userId) {
      await db.session.deleteMany({ where: { userId } });
      await db.account.deleteMany({ where: { userId } });
      await db.user.deleteMany({ where: { id: userId } });
    }
    if (businessId) {
      await db.business.deleteMany({ where: { id: businessId } });
    }
    console.log(JSON.stringify({ cleaned: true }));
    return;
  }

  console.error("Unknown action:", action);
  process.exit(1);
}

main().catch((err) => {
  console.error("Helper error:", err);
  process.exit(1);
});
