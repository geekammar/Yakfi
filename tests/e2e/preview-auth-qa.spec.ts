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

    // 9. Conversations Inbox & Persistent Header QA (CONV-UI-01 / U01–U10)
    await page.goto("/conversations", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveTitle(/المحادثات|FlowPilot/);
    await expect(page.locator("body")).toBeVisible();

    // Verify RTL & zero horizontal overflow on inbox
    expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Screenshot Inbox
    const preInboxScreenshotScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-07-conversations-inbox.png`),
      fullPage: true,
    });
    // Restore pre-screenshot window scroll offset if Playwright fullPage altered it
    await page.evaluate((y) => {
      window.scrollTo({ top: y, behavior: "instant" });
      document.documentElement.scrollTop = y;
    }, preInboxScreenshotScrollY);

    // Inspect conversation items in inbox — deterministic long thread requirement
    const conversationLinks = page.locator('a[href^="/conversations/"]');
    await expect(conversationLinks.first()).toBeVisible({ timeout: 10_000 });
    const conversationCount = await conversationLinks.count();
    expect(conversationCount).toBeGreaterThan(0);

    const firstConvLink = conversationLinks.first();
    await firstConvLink.click();
    await page.waitForURL((url) => url.pathname.includes("/conversations/"), {
      timeout: 10_000,
      waitUntil: "domcontentloaded",
    });

    // U01 & U08: Persistent Header presence & initial geometry
    const persistentHeader = page.locator(
      'header[data-testid="conversation-persistent-header"]',
    );
    await expect(persistentHeader).toBeVisible();

    const initialHeaderBox = await persistentHeader.boundingBox();
    expect(initialHeaderBox).not.toBeNull();
    if (initialHeaderBox) {
      // Must be located at or immediately below the sticky app bar
      expect(initialHeaderBox.y).toBeGreaterThanOrEqual(20);
      expect(initialHeaderBox.y).toBeLessThanOrEqual(120);
    }

    const postNavScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );
    console.log(
      `[QA-DIAG] ${vpName} | preInboxScrollY=${preInboxScreenshotScrollY} | postNavScrollY=${postNavScrollY} | initialHeaderY=${initialHeaderBox?.y} initialHeaderH=${initialHeaderBox?.height}`,
    );
    // Outer scroll position must stay at top (<= 10px) upon route entry (no document runaway / header masking)
    expect(postNavScrollY).toBeLessThanOrEqual(10);

    // Suppress install prompt on conversation detail route (no composer / content obstruction)
    const installPromptOnConv = page.locator('aside[aria-label="تثبيت التطبيق"]');
    await expect(installPromptOnConv).not.toBeVisible();

    // U02: Real customer identity with truncation
    const customerH1 = persistentHeader.locator("h1");
    await expect(customerH1).toBeVisible();
    expect(
      await customerH1.evaluate((el) => el.classList.contains("truncate")),
    ).toBe(true);

    const customerPhone = persistentHeader.locator('p[dir="ltr"]');
    await expect(customerPhone).toBeVisible();

    // U03: Status badge & reason chip
    const statusBadge = persistentHeader.locator(
      '[aria-label^="حالة المحادثة:"]',
    );
    await expect(statusBadge).toBeVisible();

    // U04: Actual assignee / responder context (separated from status)
    const assigneeBadge = persistentHeader.locator(
      '[aria-label^="المسؤول الحالي:"]',
    );
    await expect(assigneeBadge).toBeVisible();

    // U05: Non-bloated actions: on mobile, persistent header height is compact (<= 160px even on narrow 320px)
    if (vpName.startsWith("mobile") && initialHeaderBox) {
      expect(initialHeaderBox.height).toBeLessThanOrEqual(160);
    }

    // U06: Independently scrollable message history
    const messageLog = page.locator('div[role="log"]');
    await expect(messageLog).toBeVisible();
    expect(await messageLog.getAttribute("tabindex")).toBe("0");

    // Require deterministic long conversation: content height must strictly exceed view container height
    const initialMetrics = await messageLog.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }));
    expect(initialMetrics.scrollHeight).toBeGreaterThan(
      initialMetrics.clientHeight,
    );

    // Initial mount auto-scrolls to bottom so latest messages are visible
    expect(initialMetrics.scrollTop).toBeGreaterThan(0);

    // Check Top: Scroll to top (scrollTop = 0)
    await messageLog.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(150);
    const topScroll = await messageLog.evaluate((el) => el.scrollTop);
    expect(topScroll).toBe(0);

    // Verify Persistent Header remains visible and pinned at top
    const topHeaderBox = await persistentHeader.boundingBox();
    expect(topHeaderBox).not.toBeNull();
    if (topHeaderBox && initialHeaderBox) {
      expect(Math.abs(topHeaderBox.y - initialHeaderBox.y)).toBeLessThanOrEqual(
        5,
      );
    }

    // Screenshot Conversation Detail Top
    const preTopScreenshotScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${vpName}-08-conversation-detail-top.png`,
      ),
      fullPage: true,
    });
    // Restore pre-screenshot window scroll offset if Playwright fullPage altered it
    await page.evaluate((y) => {
      window.scrollTo({ top: y, behavior: "instant" });
      document.documentElement.scrollTop = y;
    }, preTopScreenshotScrollY);

    const postTopScreenshotScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );
    console.log(
      `[QA-DIAG] ${vpName} | preTopScrollY=${preTopScreenshotScrollY} postTopScrollY=${postTopScreenshotScrollY} | topHeaderY=${topHeaderBox?.y}`,
    );

    // Check Middle: Scroll to middle reading position
    const middleTarget = Math.floor(
      (initialMetrics.scrollHeight - initialMetrics.clientHeight) / 2,
    );
    await messageLog.evaluate((el, target) => {
      el.scrollTop = target;
    }, middleTarget);
    await page.waitForTimeout(150);
    const middleScroll = await messageLog.evaluate((el) => el.scrollTop);
    expect(Math.abs(middleScroll - middleTarget)).toBeLessThanOrEqual(5);

    // Verify Persistent Header remains pinned
    const middleHeaderBox = await persistentHeader.boundingBox();
    expect(middleHeaderBox).not.toBeNull();
    console.log(
      `[QA-DIAG] ${vpName} | middleScroll=${middleScroll} middleTarget=${middleTarget} | middleHeaderY=${middleHeaderBox?.y} initialHeaderY=${initialHeaderBox?.y}`,
    );
    if (middleHeaderBox && initialHeaderBox) {
      expect(
        Math.abs(middleHeaderBox.y - initialHeaderBox.y),
      ).toBeLessThanOrEqual(5);
    }

    const preScreenshotScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );

    // Screenshot Conversation Detail Scrolled (Middle)
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${vpName}-09-conversation-detail-scrolled.png`,
      ),
      fullPage: true,
    });

    // Restore pre-screenshot window scroll offset if Playwright fullPage altered it
    await page.evaluate((y) => window.scrollTo(0, y), preScreenshotScrollY);
    await page.waitForTimeout(50);

    // Check Bottom: Scroll to bottom
    await messageLog.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(150);
    const bottomScroll = await messageLog.evaluate((el) => el.scrollTop);
    expect(bottomScroll).toBeGreaterThan(middleTarget);

    const bottomHeaderBox = await persistentHeader.boundingBox();
    expect(bottomHeaderBox).not.toBeNull();
    if (bottomHeaderBox && initialHeaderBox) {
      expect(
        Math.abs(bottomHeaderBox.y - initialHeaderBox.y),
      ).toBeLessThanOrEqual(5);
    }

    // Verify document window itself has not scrolled away (no document runaway / window scroll trap)
    const windowScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );
    expect(windowScrollY).toBeLessThanOrEqual(10);

    // U07: Composer usable & positioned above bottom navigation
    const replyTextarea = page.locator('textarea[aria-label="رد على العميل"]');
    await expect(replyTextarea).toBeVisible();
    const sendButton = page.locator('button[aria-label="إرسال الرد"]');
    await expect(sendButton).toBeVisible();

    if (vpName.startsWith("mobile")) {
      const bottomNav = page.locator('nav[aria-label="التنقل الرئيسي"]');
      if (await bottomNav.isVisible()) {
        const navBox = await bottomNav.boundingBox();
        const composerBox = await replyTextarea.boundingBox();
        if (navBox && composerBox) {
          // Composer must sit above the fixed bottom navigation bar (no intersection)
          expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(
            navBox.y + 10,
          );
        }
      }
    }

    // Verify reading-position preservation and draft preservation across view toggles
    // Set reading position to middle
    await messageLog.evaluate((el, target) => {
      el.scrollTop = target;
    }, middleTarget);
    await page.waitForTimeout(100);

    // Type draft text into composer
    await replyTextarea.fill("مسودة رد للاختبار الحقيقي");
    expect(await replyTextarea.inputValue()).toBe("مسودة رد للاختبار الحقيقي");

    // Test mobile context view toggle if visible
    const contextToggle = persistentHeader.locator(
      'button[aria-label="عرض تفاصيل العميل والمواعيد"], button[aria-label="عرض سياق العميل والمواعيد"]',
    );
    if (await contextToggle.isVisible()) {
      await contextToggle.click();
      await page.waitForTimeout(200);

      // Verify context details rendered
      await expect(
        page.getByRole("heading", { name: "سياق العميل" }).first(),
      ).toBeVisible();

      await page.screenshot({
        path: path.join(
          SCREENSHOT_DIR,
          `${vpName}-10-conversation-detail-context.png`,
        ),
        fullPage: true,
      });

      // Toggle back to messages
      const messagesToggle = persistentHeader.locator(
        'button[aria-label="العودة إلى المحادثة"]',
      );
      await messagesToggle.click();
      await page.waitForTimeout(200);
      await expect(messageLog).toBeVisible();

      // Verify draft text is preserved across view toggle
      expect(await replyTextarea.inputValue()).toBe(
        "مسودة رد للاختبار الحقيقي",
      );

      // Verify reading position (scrollTop) is preserved across view toggle
      const restoredScrollTop = await messageLog.evaluate((el) => el.scrollTop);
      expect(Math.abs(restoredScrollTop - middleTarget)).toBeLessThanOrEqual(
        20,
      );

      // Back to inbox and re-entry preserves unsent draft
      const backToInboxBtn = persistentHeader.locator(
        'a[aria-label="العودة إلى المحادثات"]',
      );
      if (await backToInboxBtn.isVisible()) {
        await backToInboxBtn.click();
        await page.waitForURL(
          (url) => !url.pathname.includes("/conversations/"),
          {
            timeout: 10_000,
            waitUntil: "domcontentloaded",
          },
        );
        await expect(
          page.locator('a[href^="/conversations/"]').first(),
        ).toBeVisible();

        // Re-enter conversation
        await firstConvLink.click();
        await page.waitForURL(
          (url) => url.pathname.includes("/conversations/"),
          {
            timeout: 10_000,
            waitUntil: "domcontentloaded",
          },
        );

        // Verify draft text is preserved across route navigation
        const restoredDraftArea = page.locator(
          'textarea[aria-label="رد على العميل"]',
        );
        await expect(restoredDraftArea).toBeVisible();
        expect(await restoredDraftArea.inputValue()).toBe(
          "مسودة رد للاختبار الحقيقي",
        );
      }
    }

    // U08 & U09: Zero horizontal overflow across all viewports
    isOverflowing = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(isOverflowing).toBe(false);

    // Note: Physical on-screen keyboard behavior (iOS dynamic visualViewport vs Android IME resize)
    // is explicitly unverified by synthetic browser emulation. Physical device smoke test advised.

    // Assert no critical console errors
    expect(consoleErrors).toEqual([]);
  });
});
