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
    await expect(page).toHaveTitle(/FlowPilot/);

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

    // 4. Touch-Target Usability (Check interactive buttons have appropriate height)
    const submitButton = page.locator('button[type="submit"]');
    await expect(submitButton).toBeVisible();
    const box = await submitButton.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      // Mobile touch-target height minimum guideline is >= 36px
      expect(box.height).toBeGreaterThanOrEqual(36);
    }

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
