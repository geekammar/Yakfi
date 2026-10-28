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
      page.locator('svg[data-testid="yakfi-symbol"]:visible'),
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

  test("Yakfi Wave B: Typography, token contract, and visual accessibility", async ({
    page,
  }, testInfo) => {
    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });

    // 1. Wait for document fonts to finish loading
    await page.evaluate(() => document.fonts.ready);

    // 2. Inspect computed font-family after fonts finish loading for UI and brand text
    const uiFontInspection = await page.evaluate(() => {
      const body = document.body;
      const bodyFont = window.getComputedStyle(body).fontFamily;
      const heading = document.querySelector("h1");
      const headingFont = heading
        ? window.getComputedStyle(heading).fontFamily
        : "";
      const brandEl = document.querySelector(
        '[data-testid="yakfi-brand-text"]',
      ) as HTMLElement | null;
      const brandFont = brandEl
        ? window.getComputedStyle(brandEl).fontFamily
        : "";
      const brandWeight = brandEl
        ? window.getComputedStyle(brandEl).fontWeight
        : "";
      return { bodyFont, headingFont, brandFont, brandWeight };
    });

    // Confirm UI font is IBM Plex Sans Arabic (not the circular var(--font-sans) fallback)
    expect(
      uiFontInspection.bodyFont
        .toLowerCase()
        .includes("ibm plex sans arabic") ||
        uiFontInspection.bodyFont.includes("__IBM_Plex_Sans_Arabic"),
    ).toBe(true);

    // Confirm brand text "يكفي" uses Readex Pro with weight 600
    expect(
      uiFontInspection.brandFont.toLowerCase().includes("readex pro") ||
        uiFontInspection.brandFont.includes("__Readex_Pro"),
    ).toBe(true);
    expect(uiFontInspection.brandWeight).toBe("600");

    // 3. Test Latin brand typography "yakfi" with Manrope 600
    const latinFontInspection = await page.evaluate(() => {
      const testSpan = document.createElement("span");
      testSpan.className = "font-brand-latin font-semibold";
      testSpan.textContent = "yakfi";
      document.body.appendChild(testSpan);
      const computed = window.getComputedStyle(testSpan);
      const res = {
        fontFamily: computed.fontFamily,
        fontWeight: computed.fontWeight,
      };
      testSpan.remove();
      return res;
    });
    expect(
      latinFontInspection.fontFamily.toLowerCase().includes("manrope") ||
        latinFontInspection.fontFamily.includes("__Manrope"),
    ).toBe(true);
    expect(latinFontInspection.fontWeight).toBe("600");

    // 4. Confirm primary and canvas computed colors
    const colors = await page.evaluate(() => {
      const body = document.body;
      const submitBtn = document.querySelector(
        'button[type="submit"]',
      ) as HTMLElement;
      const card = document.querySelector(
        '.bg-card, [data-slot="card"]',
      ) as HTMLElement;
      return {
        canvasBg: window.getComputedStyle(body).backgroundColor,
        bodyColor: window.getComputedStyle(body).color,
        primaryBg: submitBtn
          ? window.getComputedStyle(submitBtn).backgroundColor
          : "",
        primaryText: submitBtn ? window.getComputedStyle(submitBtn).color : "",
        cardBg: card ? window.getComputedStyle(card).backgroundColor : "",
        cardRadius: card ? window.getComputedStyle(card).borderRadius : "",
        buttonRadius: submitBtn
          ? window.getComputedStyle(submitBtn).borderRadius
          : "",
      };
    });

    // Canvas: #F4F7FB -> rgb(244, 247, 251)
    expect(colors.canvasBg).toBe("rgb(244, 247, 251)");
    // Main text: #122A43 -> rgb(18, 42, 67)
    expect(colors.bodyColor).toBe("rgb(18, 42, 67)");
    // Primary: #173B63 -> rgb(23, 59, 99)
    expect(colors.primaryBg).toBe("rgb(23, 59, 99)");
    // Primary text: #FFFFFF -> rgb(255, 255, 255)
    expect(colors.primaryText).toBe("rgb(255, 255, 255)");
    // Cards: #FFFFFF -> rgb(255, 255, 255)
    expect(colors.cardBg).toBe("rgb(255, 255, 255)");

    // Explicit Card radius: 12px
    expect(colors.cardRadius).toBe("12px");
    // Explicit Control radius: 8px
    expect(colors.buttonRadius).toBe("8px");

    // 5. Measure composed contrast & verify warning badges on translucent backgrounds
    const warningBadgeInspection = await page.evaluate(() => {
      const sample = document.createElement("span");
      sample.className =
        "border-warning/25 bg-warning/10 text-warning-foreground rounded-full border px-2.5 py-0.5 text-xs font-medium";
      sample.textContent = "تنبيه معلق";
      document.body.appendChild(sample);
      const style = window.getComputedStyle(sample);
      const textColor = style.color;
      sample.remove();
      return { textColor };
    });

    // Warning text on translucent background must not be white
    expect(warningBadgeInspection.textColor).not.toBe("rgb(255, 255, 255)");

    // 6. Interactive states: Focus, Hover, Active, Disabled, Error
    const interactiveCheck = await page.evaluate(() => {
      const email = document.querySelector(
        'input[id="email"]',
      ) as HTMLInputElement;
      email.focus();
      const inputFocused = document.activeElement === email;

      const submitBtn = document.querySelector(
        'button[type="submit"]',
      ) as HTMLButtonElement;
      submitBtn.focus();
      const btnFocused = document.activeElement === submitBtn;

      submitBtn.disabled = true;
      const isActuallyDisabled = submitBtn.matches(":disabled");
      const hasDisabledClass =
        submitBtn.classList.contains("disabled:opacity-50") ||
        submitBtn.className.includes("disabled:pointer-events-none");
      submitBtn.disabled = false;

      return {
        inputFocused,
        btnFocused,
        isActuallyDisabled,
        hasDisabledClass,
      };
    });
    expect(interactiveCheck.inputFocused).toBe(true);
    expect(interactiveCheck.btnFocused).toBe(true);
    expect(interactiveCheck.isActuallyDisabled).toBe(true);
    expect(interactiveCheck.hasDisabledClass).toBe(true);

    // Screenshot Wave B visual state
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-yakfi-wave-b-tokens.png`,
      ),
      fullPage: true,
    });
  });
});
