import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

const PREVIEW_URL =
  process.env.PLAYWRIGHT_PREVIEW_URL ||
  "https://flowpilot-prod-git-chore-devops-01-pr-preview-ci-ammarj1.vercel.app";

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
          !text.includes("incompatible library")
        ) {
          consoleErrors.push(text);
        }
      }
    });

    // 1. Health check verification
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

    // Fill login form
    await page.fill('input[id="email"]', "preview.admin@flowpilot.app");
    await page.fill('input[id="password"]', "Admin@1234");

    // Take screenshot of sign-in page with filled inputs
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-01-sign-in.png`),
      fullPage: true,
    });

    // Submit and wait for response & navigation
    const [response] = await Promise.all([
      page.waitForResponse((res) =>
        res.url().includes("/api/auth/sign-in/email"),
      ),
      page.click('button[type="submit"]'),
    ]);

    expect(response.status()).toBe(200);

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

    // 4. /admin/team page
    await page.goto("/admin/team", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/FlowPilot/);
    await expect(page.locator("body")).toBeVisible();

    // Verify RTL
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");

    // Verify no horizontal overflow
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

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

    // Screenshot Booking flow
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-04-booking-flow.png`),
      fullPage: true,
    });

    // Assert no critical console errors
    expect(consoleErrors).toEqual([]);
  });
});
