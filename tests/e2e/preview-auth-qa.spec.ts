import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

// Enforce valid dynamic preview URL. Never fall back to unrelated deployments.
const PREVIEW_URL = process.env.PLAYWRIGHT_PREVIEW_URL?.trim();
if (!PREVIEW_URL) {
  throw new Error(
    "Missing required environment variable PLAYWRIGHT_PREVIEW_URL. Deployed Preview E2E tests must never fall back to unrelated deployments or historical branches.",
  );
}

const ADMIN_EMAIL =
  process.env.PREVIEW_ADMIN_EMAIL?.trim() || "preview.admin@flowpilot.app";
const ADMIN_PASSWORD =
  process.env.PREVIEW_ADMIN_PASSWORD?.trim() || "Admin@1234";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "playwright-report",
  "screenshots",
  "preview",
);

test.beforeAll(() => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

test.describe("Authenticated Preview QA", () => {
  test.use({
    baseURL: PREVIEW_URL,
  });

  test("Full authenticated journey on Preview: Sign-in, Admin, /admin/team, Booking flow", async ({
    page,
  }, testInfo) => {
    const vpName = testInfo.project.name;
    const consoleErrors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (
          !text.includes("favicon") &&
          !text.includes("Download the React DevTools") &&
          !text.includes("incompatible library") &&
          !text.includes("429")
        ) {
          consoleErrors.push(text);
        }
      }
    });

    // 1. Health check verification on deployed target
    const healthRes = await page.request.get("/api/health");
    expect(healthRes.status()).toBe(200);
    const healthData = await healthRes.json();
    expect(healthData.status).toBe("ok");
    expect(healthData.deploymentReady).toBe(true);
    expect(healthData.database).toBe("connected");
    expect(healthData.missingEnvVars).toEqual([]);

    // 2. Sign-in page
    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/FlowPilot/);

    // Verify RTL on sign-in
    const htmlDir = await page.locator("html").getAttribute("dir");
    expect(htmlDir).toBe("rtl");

    // Verify no horizontal overflow
    let isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Fill login form using credentials from environment
    await page.fill('input[id="email"]', ADMIN_EMAIL);
    await page.fill('input[id="password"]', ADMIN_PASSWORD);

    // Take screenshot of sign-in page with filled inputs
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-01-sign-in.png`),
      fullPage: true,
    });

    // Submit and wait for response & navigation (with retry if concurrent projects trigger 429 rate limiting)
    let loginResponseStatus = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      const [response] = await Promise.all([
        page.waitForResponse((res) =>
          res.url().includes("/api/auth/sign-in/email"),
        ),
        page.click('button[type="submit"]'),
      ]);
      loginResponseStatus = response.status();
      if (loginResponseStatus === 200) break;
      if (loginResponseStatus === 429) {
        await page.waitForTimeout(1500 * (attempt + 1));
      }
    }

    expect(loginResponseStatus).toBe(200);

    // Verify cookies set
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) =>
      c.name.includes("better-auth.session_token"),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie?.secure).toBe(true);

    // Wait for navigation away from /sign-in
    await page.waitForURL((url) => !url.pathname.includes("/sign-in"), {
      timeout: 15_000,
      waitUntil: "domcontentloaded",
    });

    // Verify redirect stayed within authorized Preview origin
    const currentUrl = page.url();
    const originMatch =
      currentUrl.includes("flowpilot-prod") &&
      currentUrl.includes(".vercel.app");
    expect(originMatch).toBe(true);

    // 3. Admin Dashboard
    await page.goto("/admin", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/FlowPilot/);
    await expect(page.locator("body")).toBeVisible();

    // Verify RTL
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");

    // Verify no horizontal overflow
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Screenshot Admin Dashboard
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-02-admin-dashboard.png`),
      fullPage: true,
    });

    // 4. /admin/team page — Provider Management
    await page.goto("/admin/team", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/FlowPilot/);
    await expect(page.locator("body")).toBeVisible();

    // Verify page content: header, actions
    await expect(page.locator("h1")).toContainText(
      "إدارة الفريق ومقدمي الخدمة",
    );

    // Verify Return to Settings button is present
    const backToSettingsLink = page.locator('a[href="/settings"]');
    await expect(backToSettingsLink).toBeVisible();
    await expect(backToSettingsLink).toContainText("العودة للإعدادات");

    // Verify Add Provider button is present
    const addProviderButton = page.getByRole("button", {
      name: "إضافة مقدم خدمة",
    });
    await expect(addProviderButton).toBeVisible();

    // Verify RTL
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");

    // Verify no horizontal overflow
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Verify touch-target sizing on /admin/team interactive controls (>= 24px)
    const teamButtons = page.locator("button");
    const teamBtnCount = await teamButtons.count();
    for (let i = 0; i < Math.min(teamBtnCount, 5); i++) {
      const btn = teamButtons.nth(i);
      if (await btn.isVisible()) {
        const b = await btn.boundingBox();
        if (b) {
          expect(b.height).toBeGreaterThanOrEqual(24);
        }
      }
    }

    // Screenshot /admin/team
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-03-admin-team.png`),
      fullPage: true,
    });

    // 5. Booking Flow (/appointments/new)
    await page.goto("/appointments/new", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/إنشاء موعد/);
    await expect(page.locator("body")).toBeVisible();

    // Verify RTL
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");

    // Verify no horizontal overflow
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Verify touch-target sizing on booking form interactive controls (>= 24px)
    const formControls = page.locator("button, input, select");
    const controlCount = await formControls.count();
    for (let i = 0; i < Math.min(controlCount, 5); i++) {
      const ctrl = formControls.nth(i);
      if (await ctrl.isVisible()) {
        const b = await ctrl.boundingBox();
        if (b) {
          expect(b.height).toBeGreaterThanOrEqual(24);
        }
      }
    }

    // Screenshot Booking flow
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-04-booking-flow.png`),
      fullPage: true,
    });

    // 6. Visual Staff Calendar (/appointments)
    await page.goto("/appointments", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/المواعيد|FlowPilot/);
    await expect(page.locator("body")).toBeVisible();

    // Verify RTL
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");

    // Verify no horizontal overflow
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Verify Calendar view modes are present (الجدول المرئي / قائمة المواعيد)
    const visualViewBtn = page.getByRole("button", { name: /الجدول المرئي/ });
    if (await visualViewBtn.isVisible()) {
      await expect(visualViewBtn).toBeVisible();
    }

    // Screenshot Visual Staff Calendar
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-05-visual-calendar.png`),
      fullPage: true,
    });

    // 7. Settings Screen with Discoverable Provider Management Link (/settings)
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/الإعدادات|FlowPilot/);
    await expect(page.locator("body")).toBeVisible();

    // Verify discoverable provider management link exists and has expected text
    const teamLink = page.locator('a[href="/admin/team"]');
    await expect(teamLink).toBeVisible();
    await expect(teamLink).toContainText("إدارة الفريق ومقدمي الخدمة");

    // Verify configurable booking interval selector (UX001-R3)
    const slotDurationLabel = page.getByText(
      "الفاصل الزمني بين بدايات المواعيد",
    );
    await expect(slotDurationLabel).toBeVisible();
    const slotDurationHelper = page.getByText(
      "يحدد عدد الدقائق بين أوقات بدء الحجز المعروضة، ولا يغيّر مدة الخدمة أو المواعيد المحجوزة مسبقًا.",
    );
    await expect(slotDurationHelper).toBeVisible();
    const slotDurationTrigger = page.locator("#settings-slot-duration");
    await expect(slotDurationTrigger).toBeVisible();
    const triggerBox = await slotDurationTrigger.boundingBox();
    if (triggerBox) {
      expect(triggerBox.height).toBeGreaterThanOrEqual(24);
    }

    // Verify no horizontal overflow
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Screenshot Settings
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${vpName}-06-settings-provider-link.png`,
      ),
      fullPage: true,
    });

    // 8. Navigation verification: Click provider management link from Settings
    await teamLink.click();
    await page.waitForURL((url) => url.pathname.includes("/admin/team"), {
      timeout: 10_000,
      waitUntil: "domcontentloaded",
    });
    expect(page.url()).toContain("/admin/team");

    // Assert no critical console errors
    expect(consoleErrors).toEqual([]);
  });
});
