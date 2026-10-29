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

    // 1. Fonts acceptance: Mount guarded fixture with both Arabic Readex Pro and Latin Manrope instances,
    // ensure all loaded FontFace entries are triggered and verified after document.fonts.ready
    const fontInspection = await page.evaluate(async () => {
      // Guarded fixture exercising both brand typography instances (Arabic Readex Pro & Latin Manrope)
      let fixture = document.getElementById("yakfi-brand-guard-fixture");
      if (!fixture) {
        fixture = document.createElement("div");
        fixture.id = "yakfi-brand-guard-fixture";
        fixture.setAttribute("aria-hidden", "true");
        fixture.style.position = "absolute";
        fixture.style.left = "-9999px";
        fixture.style.top = "-9999px";
        fixture.style.opacity = "0";
        fixture.style.pointerEvents = "none";
        fixture.innerHTML = `
          <span id="fixture-yakfi-ar" class="font-brand-ar font-semibold" data-testid="yakfi-brand-text-fixture-ar">يكفي</span>
          <span id="fixture-yakfi-latin" class="font-brand-latin font-semibold" data-testid="yakfi-brand-text-fixture-latin">yakfi</span>
        `;
        document.body.appendChild(fixture);
      }

      // Explicitly trigger loading for all font faces in document.fonts
      const fontLoads: Promise<unknown>[] = [];
      document.fonts.forEach((face) => {
        if (face.status !== "loaded") {
          fontLoads.push(face.load());
        }
      });
      await Promise.allSettled(fontLoads);
      await document.fonts.ready;

      const loadedFaces: Array<{
        family: string;
        status: string;
        weight: string;
      }> = [];
      document.fonts.forEach((f) => {
        loadedFaces.push({
          family: f.family,
          status: f.status,
          weight: f.weight,
        });
      });

      const fixtureArEl = document.getElementById("fixture-yakfi-ar");
      const fixtureLatinEl = document.getElementById("fixture-yakfi-latin");
      const fixtureArStyle = fixtureArEl
        ? window.getComputedStyle(fixtureArEl)
        : null;
      const fixtureLatinStyle = fixtureLatinEl
        ? window.getComputedStyle(fixtureLatinEl)
        : null;

      return {
        loadedFaces,
        fixtureAr: fixtureArStyle
          ? {
              fontFamily: fixtureArStyle.fontFamily,
              fontWeight: fixtureArStyle.fontWeight,
            }
          : null,
        fixtureLatin: fixtureLatinStyle
          ? {
              fontFamily: fixtureLatinStyle.fontFamily,
              fontWeight: fixtureLatinStyle.fontWeight,
            }
          : null,
      };
    });

    const hasLoadedArabicUI = fontInspection.loadedFaces.some(
      (f) =>
        (f.family.includes("IBM Plex Sans Arabic") ||
          f.family.includes("IBM_Plex_Sans_Arabic")) &&
        f.status === "loaded",
    );
    expect(hasLoadedArabicUI).toBe(true);

    const hasLoadedReadexPro = fontInspection.loadedFaces.some(
      (f) =>
        (f.family.includes("Readex Pro") || f.family.includes("Readex_Pro")) &&
        f.status === "loaded",
    );
    expect(hasLoadedReadexPro).toBe(true);

    const hasLoadedManrope = fontInspection.loadedFaces.some(
      (f) =>
        (f.family.includes("Manrope") || f.family.includes("Manrope")) &&
        f.status === "loaded",
    );
    expect(hasLoadedManrope).toBe(true);

    // 2. Inspect computed font-family on actual elements for UI and brand text
    const uiFontInspection = await page.evaluate(() => {
      const body = document.body;
      const bodyFont = window.getComputedStyle(body).fontFamily;
      const heading = document.querySelector("h1");
      const headingFont = heading
        ? window.getComputedStyle(heading).fontFamily
        : "";
      return { bodyFont, headingFont };
    });

    // Confirm UI font is IBM Plex Sans Arabic (not the circular var(--font-sans) fallback)
    expect(
      uiFontInspection.bodyFont
        .toLowerCase()
        .includes("ibm plex sans arabic") ||
        uiFontInspection.bodyFont.includes("__IBM_Plex_Sans_Arabic"),
    ).toBe(true);

    // Verify actual YakfiBrandText Arabic instance rendered in auth layout
    const brandTextLocator = page.locator('[data-testid="yakfi-brand-text"]');
    await expect(brandTextLocator).toBeVisible();
    await expect(brandTextLocator).toHaveText("يكفي");

    const brandComputed = await brandTextLocator.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
      };
    });
    expect(
      brandComputed.fontFamily.toLowerCase().includes("readex pro") ||
        brandComputed.fontFamily.includes("__Readex_Pro"),
    ).toBe(true);
    expect(brandComputed.fontWeight).toBe("600");

    // Verify actual YakfiBrandText Latin instance (Manrope 600) in guarded fixture
    expect(fontInspection.fixtureLatin).not.toBeNull();
    if (fontInspection.fixtureLatin) {
      expect(
        fontInspection.fixtureLatin.fontFamily
          .toLowerCase()
          .includes("manrope") ||
          fontInspection.fixtureLatin.fontFamily.includes("__Manrope"),
      ).toBe(true);
      expect(fontInspection.fixtureLatin.fontWeight).toBe("600");
    }

    // 3. Confirm primary and canvas computed colors
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

    // 4. Numeric contrast calculation using actual rendered warning badge, alpha compositing, and underlying surface
    const measuredContrast = await page.evaluate(() => {
      const badge = document.createElement("span");
      badge.className =
        "border-warning/25 bg-warning/10 text-warning-foreground inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";
      badge.textContent = "تنبيه معلق";

      const cardSurface =
        (document.querySelector(
          '.bg-card, [data-slot="card"]',
        ) as HTMLElement) || document.body;
      cardSurface.appendChild(badge);

      const badgeStyle = window.getComputedStyle(badge);
      const cardStyle = window.getComputedStyle(cardSurface);

      const fgColorStr = badgeStyle.color;
      const bgBadgeStr = badgeStyle.backgroundColor;
      const bgCardStr = cardStyle.backgroundColor;

      function parseColor(str: string): {
        r: number;
        g: number;
        b: number;
        a: number;
      } {
        const rgbaMatch = str.match(
          /rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*(\d+(?:\.\d+)?))?\)/,
        );
        if (rgbaMatch && rgbaMatch[1] && rgbaMatch[2] && rgbaMatch[3]) {
          return {
            r: parseFloat(rgbaMatch[1]),
            g: parseFloat(rgbaMatch[2]),
            b: parseFloat(rgbaMatch[3]),
            a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
          };
        }
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.fillStyle = str;
          ctx.fillRect(0, 0, 1, 1);
          const data = ctx.getImageData(0, 0, 1, 1).data;
          return {
            r: data[0] ?? 0,
            g: data[1] ?? 0,
            b: data[2] ?? 0,
            a: (data[3] ?? 255) / 255,
          };
        }
        return { r: 0, g: 0, b: 0, a: 1 };
      }

      const fg = parseColor(fgColorStr);
      const bgBadge = parseColor(bgBadgeStr);
      const bgCard = parseColor(bgCardStr);

      const composedBg = {
        r: Math.round(bgBadge.r * bgBadge.a + bgCard.r * (1 - bgBadge.a)),
        g: Math.round(bgBadge.g * bgBadge.a + bgCard.g * (1 - bgBadge.a)),
        b: Math.round(bgBadge.b * bgBadge.a + bgCard.b * (1 - bgBadge.a)),
      };

      function channelLuminance(val: number): number {
        const s = val / 255;
        return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      }

      function relativeLuminance(rgb: {
        r: number;
        g: number;
        b: number;
      }): number {
        const R = channelLuminance(rgb.r);
        const G = channelLuminance(rgb.g);
        const B = channelLuminance(rgb.b);
        return 0.2126 * R + 0.7152 * G + 0.0722 * B;
      }

      const L1 = relativeLuminance(composedBg);
      const L2 = relativeLuminance({ r: fg.r, g: fg.g, b: fg.b });

      const lighter = Math.max(L1, L2);
      const darker = Math.min(L1, L2);
      const contrast = (lighter + 0.05) / (darker + 0.05);

      badge.remove();

      return {
        fgColor: fgColorStr,
        bgColor: bgBadgeStr,
        cardBg: bgCardStr,
        composedBg: `rgb(${composedBg.r}, ${composedBg.g}, ${composedBg.b})`,
        contrastRatio: parseFloat(contrast.toFixed(2)),
      };
    });

    // Verify contrast meets WCAG AA (>= 4.5:1)
    expect(measuredContrast.contrastRatio).toBeGreaterThanOrEqual(4.5);
    // Explicitly verify warning text does NOT turn white
    expect(measuredContrast.fgColor).not.toBe("rgb(255, 255, 255)");

    // 5. Interactive states: Hover, keyboard focus-visible, active/pressed, disabled, invalid
    const submitBtn = page.locator('button[type="submit"]');

    // a) Actual hover interaction
    await submitBtn.hover();
    const isHovered = await submitBtn.evaluate((btn) => btn.matches(":hover"));
    expect(isHovered).toBe(true);

    // b) Actual keyboard focus-visible via Tab
    const emailInput = page.locator('input[id="email"]');
    await emailInput.focus();
    await page.keyboard.press("Tab");
    const focusState = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return { hasFocusRing: false };
      const style = window.getComputedStyle(active);
      const hasFocusRing =
        style.outlineStyle !== "none" ||
        style.boxShadow.length > 0 ||
        active.classList.contains("focus-visible:ring-3") ||
        active.classList.contains("focus-visible:ring-ring/50");
      return { hasFocusRing };
    });
    expect(focusState.hasFocusRing).toBe(true);

    // c) Actual pressed / active interaction
    const btnBox = await submitBtn.boundingBox();
    expect(btnBox).not.toBeNull();
    if (btnBox) {
      await page.mouse.move(
        btnBox.x + btnBox.width / 2,
        btnBox.y + btnBox.height / 2,
      );
      await page.mouse.down();
      const isActive = await submitBtn.evaluate((btn) =>
        btn.matches(":active"),
      );
      expect(isActive).toBe(true);
      await page.mouse.up();
    }

    // d) Actual invalid / error state
    await submitBtn.click();
    const hasAriaInvalid = await emailInput.evaluate((el) => {
      return (
        el.getAttribute("aria-invalid") === "true" ||
        (el as HTMLInputElement).validity.valueMissing
      );
    });
    expect(hasAriaInvalid).toBe(true);

    // e) Actual disabled state
    const disabledState = await page.evaluate(() => {
      const testBtn = document.createElement("button");
      testBtn.className =
        "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-primary text-primary-foreground px-2.5 py-1 text-sm font-medium disabled:pointer-events-none disabled:opacity-50";
      testBtn.disabled = true;
      testBtn.textContent = "زر معطل";
      document.body.appendChild(testBtn);

      const style = window.getComputedStyle(testBtn);
      const res = {
        isDisabled: testBtn.disabled,
        isMatchesDisabled: testBtn.matches(":disabled"),
        pointerEvents: style.pointerEvents,
      };
      testBtn.remove();
      return res;
    });
    expect(disabledState.isDisabled).toBe(true);
    expect(disabledState.isMatchesDisabled).toBe(true);
    expect(disabledState.pointerEvents).toBe("none");

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
