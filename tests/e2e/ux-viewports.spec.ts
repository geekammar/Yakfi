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
      // Documented subpixel rendering tolerance (0.05px) to account for fractional
      // device-pixel-ratio / subpixel layout rounding (e.g., 35.999969px in Chromium mobile-360)
      // while strictly preserving the >= 36px (h-9 standard) height threshold.
      const SUBPIXEL_TOLERANCE_PX = 0.05;
      expect(box.height + SUBPIXEL_TOLERANCE_PX).toBeGreaterThanOrEqual(36);
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
        // Documented subpixel rendering tolerance (0.05px) to account for fractional
        // device-pixel-ratio / subpixel layout rounding (e.g., 23.999969px in Chromium mobile-390)
        // while strictly preserving the intended >= 24px threshold.
        const SUBPIXEL_TOLERANCE_PX = 0.05;
        expect(toggleBox.height + SUBPIXEL_TOLERANCE_PX).toBeGreaterThanOrEqual(
          24,
        );
        expect(toggleBox.width + SUBPIXEL_TOLERANCE_PX).toBeGreaterThanOrEqual(
          24,
        );
      }
    }

    // Check input field touch height (>= 36px)
    const emailInput = page.locator('input[id="email"]');
    const inputHeight = await emailInput.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    const SUBPIXEL_TOLERANCE_PX = 0.05;
    expect(inputHeight + SUBPIXEL_TOLERANCE_PX).toBeGreaterThanOrEqual(36);

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
    // Navigate to the production-guarded QA harness
    await page.goto("/qa/accessibility-repairs", {
      waitUntil: "domcontentloaded",
    });

    // Switch to Wave B tab containing real components
    const tabWaveB = page.locator('[data-testid="tab-wave-b"]');
    await expect(tabWaveB).toBeVisible();
    await tabWaveB.click();

    // 1. Wait for relevant fonts before geometry and styling assertions
    await page.evaluate(async () => {
      document.fonts.forEach((face) => {
        if (face.status !== "loaded") {
          face.load();
        }
      });
      await document.fonts.ready;
    });

    // Verify matching loaded FontFace coverage in document.fonts
    const fontFaces = await page.evaluate(async () => {
      await document.fonts.ready;
      const loaded: Array<{ family: string; status: string; weight: string }> =
        [];
      document.fonts.forEach((f) => {
        loaded.push({ family: f.family, status: f.status, weight: f.weight });
      });
      return loaded;
    });

    const hasLoadedArabicUI = fontFaces.some(
      (f) =>
        (f.family.includes("IBM Plex Sans Arabic") ||
          f.family.includes("IBM_Plex_Sans_Arabic")) &&
        f.status === "loaded",
    );
    expect(hasLoadedArabicUI).toBe(true);

    const hasLoadedReadexPro = fontFaces.some(
      (f) =>
        (f.family.includes("Readex Pro") || f.family.includes("Readex_Pro")) &&
        f.status === "loaded",
    );
    expect(hasLoadedReadexPro).toBe(true);

    const hasLoadedManrope = fontFaces.some(
      (f) => f.family.includes("Manrope") && f.status === "loaded",
    );
    expect(hasLoadedManrope).toBe(true);

    // 2. Typography: Verify both real YakfiBrandText instances (Arabic & English)
    // a) Real Arabic YakfiBrandText
    const brandArLocator = page.locator(
      '[data-testid="qa-brand-text-ar"] [data-testid="yakfi-brand-text"]',
    );
    await expect(brandArLocator).toBeVisible();
    await expect(brandArLocator).toHaveText("يكفي");
    const brandArComputed = await brandArLocator.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
      };
    });
    expect(
      brandArComputed.fontFamily.toLowerCase().includes("readex pro") ||
        brandArComputed.fontFamily.includes("__Readex_Pro"),
    ).toBe(true);
    expect(brandArComputed.fontWeight).toBe("600");

    // b) Real English YakfiBrandText
    const brandEnLocator = page.locator(
      '[data-testid="qa-brand-text-en"] [data-testid="yakfi-brand-text"]',
    );
    await expect(brandEnLocator).toBeVisible();
    await expect(brandEnLocator).toHaveText("yakfi");
    const brandEnComputed = await brandEnLocator.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
      };
    });
    expect(
      brandEnComputed.fontFamily.toLowerCase().includes("manrope") ||
        brandEnComputed.fontFamily.includes("__Manrope"),
    ).toBe(true);
    expect(brandEnComputed.fontWeight).toBe("600");

    // c) Assert UI heading family as well as body family
    const uiFonts = await page.evaluate(() => {
      const body = document.body;
      const heading = document.querySelector('[data-testid="wave-b-heading"]');
      return {
        bodyFont: window.getComputedStyle(body).fontFamily,
        headingFont: heading ? window.getComputedStyle(heading).fontFamily : "",
      };
    });
    expect(
      uiFonts.bodyFont.toLowerCase().includes("ibm plex sans arabic") ||
        uiFonts.bodyFont.includes("__IBM_Plex_Sans_Arabic"),
    ).toBe(true);
    expect(
      uiFonts.headingFont.toLowerCase().includes("ibm plex sans arabic") ||
        uiFonts.headingFont.includes("__IBM_Plex_Sans_Arabic"),
    ).toBe(true);

    // 3. Confirm primary, canvas, and card tokens
    const colors = await page.evaluate(() => {
      const body = document.body;
      const card = document.querySelector(
        '[data-testid="wave-b-card"]',
      ) as HTMLElement;
      const primaryBtn = document.querySelector(
        '[data-testid="qa-interactive-button"]',
      ) as HTMLElement;
      return {
        canvasBg: window.getComputedStyle(body).backgroundColor,
        bodyColor: window.getComputedStyle(body).color,
        cardBg: card ? window.getComputedStyle(card).backgroundColor : "",
        cardRadius: card ? window.getComputedStyle(card).borderRadius : "",
        primaryBg: primaryBtn
          ? window.getComputedStyle(primaryBtn).backgroundColor
          : "",
        primaryText: primaryBtn
          ? window.getComputedStyle(primaryBtn).color
          : "",
        buttonRadius: primaryBtn
          ? window.getComputedStyle(primaryBtn).borderRadius
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

    // 4. Contrast: Numeric alpha-composited contrast on the ACTUAL warning StatusBadge over light card surface
    const measuredContrast = await page.evaluate(() => {
      const badge = document.querySelector(
        '[data-testid="qa-warning-badge"]',
      ) as HTMLElement;
      const cardSurface = document.querySelector(
        '[data-testid="wave-b-card"]',
      ) as HTMLElement;

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

      return {
        fgColor: fgColorStr,
        bgColor: bgBadgeStr,
        surfaceColor: bgCardStr,
        composedBg: `rgb(${composedBg.r}, ${composedBg.g}, ${composedBg.b})`,
        contrastRatio: parseFloat(contrast.toFixed(2)),
      };
    });

    // Log dynamically measured contrast values
    console.log(
      `[Contrast Evidence] Foreground: ${measuredContrast.fgColor}, BadgeBg: ${measuredContrast.bgColor}, Surface: ${measuredContrast.surfaceColor}, Composed: ${measuredContrast.composedBg}, Ratio: ${measuredContrast.contrastRatio}:1`,
    );

    // Verify contrast meets WCAG AA (>= 4.5:1)
    expect(measuredContrast.contrastRatio).toBeGreaterThanOrEqual(4.5);
    // Explicitly verify warning text does NOT turn white
    expect(measuredContrast.fgColor).not.toBe("rgb(255, 255, 255)");

    // 5. Real Interactive Evidence on Actual Shared Controls
    const interactiveBtn = page.locator(
      '[data-testid="qa-interactive-button"]',
    );
    await expect(interactiveBtn).toBeVisible();

    // a) Hover: compare computed appearance before/after actual hover
    const preHoverBg = await interactiveBtn.evaluate(
      (btn) => window.getComputedStyle(btn).backgroundColor,
    );
    await interactiveBtn.hover();
    const postHover = await interactiveBtn.evaluate((btn) => {
      const style = window.getComputedStyle(btn);
      return {
        isHovered: btn.matches(":hover"),
        backgroundColor: style.backgroundColor,
      };
    });
    expect(postHover.isHovered).toBe(true);
    expect(postHover.backgroundColor).not.toBe(preHoverBg);

    // b) Keyboard focus-visible: assert element is focused and matches :focus-visible,
    // then verify a computed visible indicator (treat boxShadow === "none" as no shadow).
    const prevTabControl = page.locator('[data-testid="tab-wave-b"]');
    await prevTabControl.focus();
    for (let i = 0; i < 10; i++) {
      const isTarget = await interactiveBtn.evaluate(
        (el) => document.activeElement === el,
      );
      if (isTarget) break;
      await page.keyboard.press("Tab");
    }
    const focusState = await interactiveBtn.evaluate((el) => {
      const active = document.activeElement;
      const isFocused = active === el;
      const matchesFocusVisible = el.matches(":focus-visible");
      const style = window.getComputedStyle(el);
      const hasOutline =
        style.outlineStyle !== "none" &&
        style.outlineWidth !== "0px" &&
        style.outlineWidth !== "";
      const hasBoxShadow =
        style.boxShadow !== "none" &&
        style.boxShadow.trim() !== "" &&
        style.boxShadow !== "none";
      return {
        isFocused,
        matchesFocusVisible,
        hasVisibleIndicator: hasOutline || hasBoxShadow,
        outlineStyle: style.outlineStyle,
        boxShadow: style.boxShadow,
      };
    });
    expect(focusState.isFocused).toBe(true);
    expect(focusState.matchesFocusVisible).toBe(true);
    expect(focusState.hasVisibleIndicator).toBe(true);

    // c) Active: verify the shared button's intended computed visual effect while the mouse is held down
    const btnBox = await interactiveBtn.boundingBox();
    expect(btnBox).not.toBeNull();
    if (btnBox) {
      await page.mouse.move(
        btnBox.x + btnBox.width / 2,
        btnBox.y + btnBox.height / 2,
      );
      const preActive = await interactiveBtn.evaluate((btn) => {
        const style = window.getComputedStyle(btn);
        const rect = btn.getBoundingClientRect();
        return {
          transform: style.transform,
          translate: style.translate,
          top: rect.top,
          y: rect.y,
        };
      });
      await page.mouse.down();
      const activeState = await interactiveBtn.evaluate((btn) => {
        const style = window.getComputedStyle(btn);
        const rect = btn.getBoundingClientRect();
        return {
          isActive: btn.matches(":active"),
          transform: style.transform,
          translate: style.translate,
          top: rect.top,
          y: rect.y,
        };
      });
      expect(activeState.isActive).toBe(true);
      // Button uses active:not-aria-[haspopup]:translate-y-px
      // In CSS, this manifests via the modern CSS translate property, transform matrix,
      // or a downward displacement in rendered bounding client rect geometry.
      const hasVisualShift =
        (Boolean(activeState.translate) &&
          activeState.translate !== "none" &&
          activeState.translate !== preActive.translate) ||
        (Boolean(activeState.transform) &&
          activeState.transform !== "none" &&
          activeState.transform !== preActive.transform) ||
        activeState.top >= preActive.top + 0.5 ||
        activeState.y >= preActive.y + 0.5;
      expect(hasVisualShift).toBe(true);
      await page.mouse.up();
    }

    // d) Disabled: use actual shared Button, assert disabled behavior, computed opacity, and pointer-events
    const disabledBtn = page.locator('[data-testid="qa-disabled-button"]');
    await expect(disabledBtn).toBeVisible();
    await expect(disabledBtn).toBeDisabled();
    const disabledComputed = await disabledBtn.evaluate((el) => {
      const btn = el as HTMLButtonElement;
      const style = window.getComputedStyle(btn);
      return {
        isDisabledProperty: btn.disabled,
        matchesDisabled: btn.matches(":disabled"),
        pointerEvents: style.pointerEvents,
        opacity: parseFloat(style.opacity),
      };
    });
    expect(disabledComputed.isDisabledProperty).toBe(true);
    expect(disabledComputed.matchesDisabled).toBe(true);
    expect(disabledComputed.pointerEvents).toBe("none");
    expect(disabledComputed.opacity).toBeLessThanOrEqual(0.6);

    // e) Invalid: use actual Input/form and verify invalid semantics plus intended computed error appearance
    const invalidInput = page.locator('[data-testid="qa-invalid-input"]');
    const normalInput = page.locator('[data-testid="qa-interactive-input"]');
    await expect(invalidInput).toBeVisible();
    await expect(normalInput).toBeVisible();

    const inputStyles = await page.evaluate(() => {
      const normal = document.querySelector(
        '[data-testid="qa-interactive-input"]',
      ) as HTMLElement;
      const invalid = document.querySelector(
        '[data-testid="qa-invalid-input"]',
      ) as HTMLElement;
      const normalStyle = window.getComputedStyle(normal);
      const invalidStyle = window.getComputedStyle(invalid);
      return {
        invalidAria: invalid.getAttribute("aria-invalid"),
        normalBorder: normalStyle.borderColor,
        invalidBorder: invalidStyle.borderColor,
        invalidBoxShadow: invalidStyle.boxShadow,
      };
    });
    expect(inputStyles.invalidAria).toBe("true");
    expect(inputStyles.invalidBorder).not.toBe(inputStyles.normalBorder);
    expect(
      inputStyles.invalidBoxShadow !== "none" ||
        inputStyles.invalidBorder !== inputStyles.normalBorder,
    ).toBe(true);

    // Screenshot Wave B visual state from the QA harness
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-yakfi-wave-b-tokens.png`,
      ),
      fullPage: true,
    });
  });
});
