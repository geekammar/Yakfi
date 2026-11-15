import { execFileSync } from "node:child_process";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

function isDisposableDatabase(url?: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
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

function runHelper<T = unknown>(action: string, args: string[]): T {
  const helperPath = path.join(
    process.cwd(),
    "scripts",
    "conversation-refresh-browser-helper.ts",
  );
  const stdout = execFileSync(
    "pnpm",
    ["exec", "tsx", helperPath, action, ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    },
  );
  return JSON.parse(stdout.trim()) as T;
}

type Fixture = {
  userId: string;
  businessId: string;
  conversationId: string;
  customerId: string;
  serviceId: string;
};

type LiveUpdate = {
  customerMessage: string;
  aiMessage: string;
  serviceName: string;
};

test.describe("Conversation live refresh — authorized browser journey", () => {
  let fixture: Fixture | null = null;

  test.afterAll(() => {
    if (fixture) {
      try {
        runHelper("cleanup", [fixture.userId, fixture.businessId]);
      } catch {
        // Best-effort cleanup on a disposable database.
      }
    }
  });

  test("open conversation receives messages, appointment, status and ownership without reload", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    test.skip(
      !["mobile-390", "desktop-1280"].includes(testInfo.project.name),
      "Live refresh runs on mobile-390 and desktop-1280.",
    );
    test.skip(
      !isDisposableDatabase(process.env.DATABASE_URL),
      "Requires the isolated disposable PostgreSQL from CI.",
    );

    const suffix = Date.now();
    const email = `live.refresh.${suffix}@flowpilot.test`;
    const password = "ExamplePassword@1234";

    fixture = runHelper<Fixture>("create-fixture", [
      email,
      password,
      "مشغل التحديث الحيّ",
    ]);

    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => !url.pathname.includes("/sign-in"), {
      timeout: 15_000,
      waitUntil: "domcontentloaded",
    });

    await page.goto(`/conversations/${fixture.conversationId}`, {
      waitUntil: "domcontentloaded",
    });

    const log = page.locator('[role="log"]');
    await expect(log).toContainText("الرسالة الأولى قبل فتح المحادثة");

    const draft = "مسودة موظف لم تُرسل أثناء التحديث";
    const replyBox = page.locator('textarea[aria-label="رد على العميل"]');
    await replyBox.fill(draft);
    await expect(replyBox).toHaveValue(draft);

    const update = runHelper<LiveUpdate>("append-live-update", [
      fixture.conversationId,
    ]);

    await expect(log).toContainText(update.customerMessage, {
      timeout: 15_000,
    });
    await expect(log).toContainText(update.aiMessage, { timeout: 15_000 });

    await expect(replyBox).toHaveValue(draft);
    await expect(
      page.locator('[aria-label="حالة المحادثة: يحتاج تدخلاً بشرياً"]'),
    ).toBeVisible();
    await expect(
      page.locator('[aria-label="المسؤول الحالي: أنت"]'),
    ).toBeVisible();

    if (testInfo.project.name === "mobile-390") {
      await page
        .locator('button[aria-label="عرض تفاصيل العميل والمواعيد"]')
        .click();
      await expect(
        page.getByText(update.serviceName, { exact: true }),
      ).toBeVisible();
      await page.locator('button[aria-label="العودة إلى المحادثة"]').click();
      await expect(replyBox).toHaveValue(draft);
    } else {
      await expect(
        page.getByText(update.serviceName, { exact: true }),
      ).toBeVisible();
    }

    const attention = runHelper<{
      resolvedAt: string | null;
      resolvedById: string | null;
    }>("get-attention-state", [fixture.conversationId]);

    expect(attention.resolvedAt).toBeNull();
    expect(attention.resolvedById).toBeNull();
  });
});
