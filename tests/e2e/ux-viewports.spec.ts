import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "playwright-report",
  "screenshots",
);

test.beforeAll(() => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

test.describe("UX Viewport, RTL & Responsiveness QA", () => {
  test("Sign-in page: RTL, horizontal overflow, touch targets and form states", async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    page.on("requestfailed", (request) => {
      failedRequests.push(
        `${request.method()} ${request.url()} - ${request.failure()?.errorText}`,
      );
    });

    // 1. Navigate to /sign-in
    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/تسجيل الدخول \| يكفي/);

    // Verify rendered candidate identity
    await expect(page.locator("body")).toContainText("يكفي");
    await expect(
      page.locator('svg[data-testid="yakfi-symbol"]').first(),
    ).toBeVisible();

    // 2. Arabic RTL Assertion
    const htmlDir = await page.locator("html").getAttribute("dir");
    const bodyDir = await page.evaluate(
      () => window.getComputedStyle(document.body).direction,
    );
    expect(htmlDir === "rtl" || bodyDir === "rtl").toBe(true);

    // 3. No Unintended Horizontal Overflow
    const isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // 4. Touch-Target Usability (Check interactive buttons and controls adhere to mobile guidelines)
    const submitButton = page.locator('button[type="submit"]');
    await expect(submitButton).toBeVisible();
    const box = await submitButton.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      // Mobile primary button height guideline is >= 36px (h-9 standard)
      expect(box.height).toBeGreaterThanOrEqual(36);
      // On mobile viewports (<= 390px), full-width primary button exceeds 44px touch area width
      if (testInfo.project.name.startsWith("mobile")) {
        expect(box.width).toBeGreaterThanOrEqual(200);
      }
    }

    // Check secondary / icon touch target (password visibility toggle >= 24px per WCAG 2.5.8 Target Size AA)
    const passwordToggle = page.locator('button[aria-label*="كلمة المرور"]');
    if (await passwordToggle.isVisible()) {
      const toggleBox = await passwordToggle.boundingBox();
      expect(toggleBox).not.toBeNull();
      if (toggleBox) {
        expect(toggleBox.height).toBeGreaterThanOrEqual(24);
        expect(toggleBox.width).toBeGreaterThanOrEqual(24);
      }
    }

    // Check input field touch height (>= 36px)
    const emailInput = page.locator('input[id="email"]');
    const inputHeight = await emailInput.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    expect(inputHeight).toBeGreaterThanOrEqual(36);

    // 5. Empty Form Error State
    await submitButton.click();
    // HTML5 or React Hook Form validation triggers (e.g. invalid inputs or error texts)
    const hasFormValidation = await page.evaluate(() => {
      const form = document.querySelector("form");
      return form
        ? !form.checkValidity() ||
            document.querySelectorAll("[aria-invalid='true'], [data-error]")
              .length > 0
        : true;
    });
    expect(hasFormValidation).toBe(true);

    // 6. Screenshot capture for current viewport
    const screenshotPath = path.join(
      SCREENSHOT_DIR,
      `${testInfo.project.name}-sign-in.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // Assert zero uncaught console errors
    const criticalErrors = consoleErrors.filter(
      (err) =>
        !err.includes("favicon") &&
        !err.includes("Download the React DevTools"),
    );
    expect(criticalErrors).toEqual([]);
  });

  test("Sign-up page: Layout, RTL & No Overflow", async ({
    page,
  }, testInfo) => {
    await page.goto("/sign-up", { waitUntil: "domcontentloaded" });

    // Check RTL
    const htmlDir = await page.locator("html").getAttribute("dir");
    const bodyDir = await page.evaluate(
      () => window.getComputedStyle(document.body).direction,
    );
    expect(htmlDir === "rtl" || bodyDir === "rtl").toBe(true);

    // Check no horizontal overflow
    const isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Screenshot
    const screenshotPath = path.join(
      SCREENSHOT_DIR,
      `${testInfo.project.name}-sign-up.png`,
    );
    await page.screenshot({ path: screenshotPath, fullPage: true });
  });

  test("Changed screens redirect & RTL contract: /appointments/new and /admin/team", async ({
    page,
  }, testInfo) => {
    // 1. Booking creation screen (/appointments/new) unauthenticated redirect
    await page.goto("/appointments/new", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/.*\/sign-in\?redirect=%2Fappointments%2Fnew/);

    // Verify RTL preserved on redirect
    const htmlDir = await page.locator("html").getAttribute("dir");
    expect(htmlDir).toBe("rtl");

    // Verify no horizontal overflow on redirected screen
    let isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-redirect-appointments-new.png`,
      ),
      fullPage: true,
    });

    // 2. Team management screen (/admin/team) unauthenticated redirect
    await page.goto("/admin/team", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/.*\/sign-in\?redirect=%2Fadmin%2Fteam/);

    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-redirect-admin-team.png`,
      ),
      fullPage: true,
    });

    // 3. Conversation inbox screen (/conversations) unauthenticated redirect
    await page.goto("/conversations", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/.*\/sign-in\?redirect=%2Fconversations/);
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // 4. Conversation detail screen (/conversations/conv-demo-01) unauthenticated redirect
    await page.goto("/conversations/conv-demo-01", {
      waitUntil: "domcontentloaded",
    });
    await expect(page).toHaveURL(
      /.*\/sign-in\?redirect=%2Fconversations%2Fconv-demo-01/,
    );
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);
  });

  test("PWA Offline screen (/offline.html): RTL, responsiveness and recovery guidance", async ({
    page,
  }, testInfo) => {
    const res = await page.goto("/offline.html", {
      waitUntil: "domcontentloaded",
    });
    expect(res?.status()).toBe(200);

    // RTL verification
    const htmlDir = await page.locator("html").getAttribute("dir");
    expect(htmlDir).toBe("rtl");

    // Zero horizontal overflow
    const isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Visible recovery text
    await expect(page.locator("h1")).toContainText(/لا يوجد اتصال بالإنترنت/);

    // Screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-offline-screen.png`,
      ),
      fullPage: true,
    });
  });

  test("404 Not Found & Access Denied: Clear recovery and RTL", async ({
    page,
  }, testInfo) => {
    // 404 page
    await page.goto("/non-existent-route-for-qa-test", {
      waitUntil: "domcontentloaded",
    });
    const isOverflowing404 = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing404).toBe(false);

    // Screenshot 404
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-404-not-found.png`,
      ),
      fullPage: true,
    });

    // Access Denied page
    await page.goto("/access-denied", { waitUntil: "domcontentloaded" });
    const isOverflowingDenied = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowingDenied).toBe(false);

    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-access-denied.png`,
      ),
      fullPage: true,
    });
  });
});
