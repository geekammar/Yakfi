import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "playwright-report",
  "screenshots",
  "conversation-header",
);

test.beforeAll(() => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

const FIXTURES = [
  {
    key: "need_human_unassigned",
    label: "NEED_HUMAN unassigned with attention cause",
    expectedStatusText: "بانتظار موظف",
    expectedAssigneeText: "غير معينة",
    expectedPrimaryActionLabel: "تولّي المحادثة",
    hasAttentionChip: true,
    hasMoreMenu: true,
  },
  {
    key: "ai_active",
    label: "AI_ACTIVE unassigned",
    expectedStatusText: "نشط",
    expectedAssigneeText: "المساعد الذكي",
    expectedPrimaryActionLabel: "تولّي المحادثة",
    hasAttentionChip: false,
    hasMoreMenu: true,
  },
  {
    key: "assigned_me",
    label: "NEED_HUMAN assigned to current operator",
    expectedStatusText: "بانتظار موظف",
    expectedAssigneeText: "أنت",
    expectedPrimaryActionLabel: "إعادة للمساعد",
    hasAttentionChip: false,
    hasMoreMenu: true,
  },
  {
    key: "assigned_other",
    label: "NEED_HUMAN assigned to another operator",
    expectedStatusText: "بانتظار موظف",
    expectedAssigneeText: "سارة المديرة",
    expectedPrimaryActionLabel: "إعادة للمساعد",
    hasAttentionChip: false,
    hasMoreMenu: true,
  },
  {
    key: "booked",
    label: "BOOKED terminal state",
    expectedStatusText: "محجوز",
    expectedAssigneeText: "غير معينة",
    expectedPrimaryActionLabel: "إعادة للمساعد",
    hasAttentionChip: false,
    hasMoreMenu: false, // In BOOKED state, secondary actions menu is not shown
  },
];

test.describe("Focused Responsive Conversation Header & Direct Actions QA", () => {
  for (const fixture of FIXTURES) {
    test(`Header layout & geometry measurements [${fixture.key}]`, async ({
      page,
    }, testInfo) => {
      const vpName = testInfo.project.name;
      const viewport = page.viewportSize();
      const viewportWidth = viewport?.width ?? 320;

      // Navigate to controlled fixture
      await page.goto(`/qa/conversation-header?fixture=${fixture.key}`, {
        waitUntil: "domcontentloaded",
      });

      // 1. Zero document horizontal overflow (RTL document)
      const isOverflowing = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });
      expect(isOverflowing).toBe(false);

      // Verify header presence and bounding box
      const persistentHeader = page.locator(
        'header[data-testid="conversation-persistent-header"]',
      );
      await expect(persistentHeader).toBeVisible();
      const headerBox = await persistentHeader.boundingBox();
      expect(headerBox).not.toBeNull();
      if (!headerBox) return;

      // Header bounds must stay strictly within viewport width
      expect(headerBox.x).toBeGreaterThanOrEqual(0);
      expect(headerBox.x + headerBox.width).toBeLessThanOrEqual(
        viewportWidth + 1,
      );

      // Enforce <=160px mobile header height ceiling across all five fixtures
      if (vpName.startsWith("mobile")) {
        expect(headerBox.height).toBeLessThanOrEqual(160);
      }

      // 2. Customer Identity measurements (independent layout area, long Arabic name)
      const customerH1 = persistentHeader.locator("h1");
      await expect(customerH1).toBeVisible();
      const nameBox = await customerH1.boundingBox();
      expect(nameBox).not.toBeNull();
      if (!nameBox) return;

      // Real geometry assertions: usable width and height (never collapsed to 0)
      expect(nameBox.width).toBeGreaterThanOrEqual(100);
      expect(nameBox.height).toBeGreaterThanOrEqual(20);

      // Verify name wraps to at most 2 lines (line-clamp-2) by measuring actual clientHeight vs computed lineHeight
      const lineMetrics = await customerH1.evaluate((el) => {
        const computed = window.getComputedStyle(el);
        const lh = parseFloat(computed.lineHeight) || 20;
        return { clientHeight: el.clientHeight, lineHeight: lh };
      });
      expect(lineMetrics.clientHeight).toBeLessThanOrEqual(
        lineMetrics.lineHeight * 2.5,
      );

      // Verify phone number has explicit LTR direction
      const customerPhone = persistentHeader.locator('p[dir="ltr"]');
      await expect(customerPhone).toBeVisible();
      const phoneBox = await customerPhone.boundingBox();
      expect(phoneBox).not.toBeNull();
      if (phoneBox) {
        expect(phoneBox.width).toBeGreaterThan(60);
      }

      // 3. Status and Assignee context (dedicated wrapping area)
      const statusBadge = persistentHeader.locator(
        '[aria-label^="حالة المحادثة:"]',
      );
      await expect(statusBadge).toBeVisible();
      const statusBox = await statusBadge.boundingBox();
      expect(statusBox).not.toBeNull();
      if (statusBox) {
        expect(statusBox.width).toBeGreaterThanOrEqual(30);
        expect(statusBox.height).toBeGreaterThanOrEqual(18);
      }

      const assigneeBadge = persistentHeader.locator(
        '[aria-label^="المسؤول الحالي:"]',
      );
      await expect(assigneeBadge).toBeVisible();
      const assigneeBox = await assigneeBadge.boundingBox();
      expect(assigneeBox).not.toBeNull();
      if (assigneeBox) {
        expect(assigneeBox.width).toBeGreaterThanOrEqual(30);
      }

      // 4. Primary direct action is directly visible without opening details
      const primaryAction = persistentHeader.locator(
        'button[aria-label="تولّي المحادثة"], button[aria-label="إعادة للمساعد"]',
      );
      await expect(primaryAction).toBeVisible();
      if (fixture.expectedPrimaryActionLabel === "تولّي المحادثة") {
        // Must show complete visible label «تولّي المحادثة» at every viewport
        await expect(primaryAction).toContainText("تولّي المحادثة");
      }
      const primaryBox = await primaryAction.boundingBox();
      expect(primaryBox).not.toBeNull();
      if (!primaryBox) return;

      // Action touch-target and layout bounds
      expect(primaryBox.width).toBeGreaterThanOrEqual(36);
      expect(primaryBox.height).toBeGreaterThanOrEqual(30);
      if (vpName.startsWith("mobile")) {
        // Mobile touch height standard: min-h-11 (44px)
        expect(primaryBox.height).toBeGreaterThanOrEqual(40);
      }

      // Verify primary action bounds stay inside the persistent header
      expect(primaryBox.y).toBeGreaterThanOrEqual(headerBox.y);
      expect(primaryBox.y + primaryBox.height).toBeLessThanOrEqual(
        headerBox.y + headerBox.height + 2,
      );

      // Verify booking shortcut button is directly accessible with complete visible label «حجز موعد»
      const bookingLink = persistentHeader.locator('a[aria-label="حجز موعد"]');
      await expect(bookingLink).toBeVisible();
      await expect(bookingLink).toContainText("حجز موعد");
      const bookingBox = await bookingLink.boundingBox();
      expect(bookingBox).not.toBeNull();
      if (bookingBox) {
        expect(bookingBox.y).toBeGreaterThanOrEqual(headerBox.y);
        expect(bookingBox.y + bookingBox.height).toBeLessThanOrEqual(
          headerBox.y + headerBox.height + 2,
        );
      }

      console.log(
        `[GEOMETRY] ${vpName} | ${fixture.key} => Header: ${Math.round(headerBox.width)}x${Math.round(headerBox.height)}px | PrimaryBtn: ${Math.round(primaryBox.width)}x${Math.round(primaryBox.height)}px | BookingBtn: ${bookingBox ? `${Math.round(bookingBox.width)}x${Math.round(bookingBox.height)}px` : "N/A"} | CustomerNameWidth: ${Math.round(nameBox.width)}px`,
      );

      // Verify details toggle («التفاصيل») is visible on mobile/tablet viewports
      if (!vpName.includes("desktop")) {
        const detailsToggle = persistentHeader.locator(
          'button[aria-label="عرض تفاصيل العميل والمواعيد"]',
        );
        await expect(detailsToggle).toBeVisible();
        const detailsBox = await detailsToggle.boundingBox();
        expect(detailsBox).not.toBeNull();
        if (detailsBox) {
          expect(detailsBox.y).toBeGreaterThanOrEqual(headerBox.y);
          expect(detailsBox.y + detailsBox.height).toBeLessThanOrEqual(
            headerBox.y + headerBox.height + 2,
          );
        }
      }

      // 5. Ancestor clipping verification via document.elementFromPoint
      // Proves that no ancestor overflow-hidden or clipping rect obscures the primary action
      const isPrimaryActionClickable = await page.evaluate(
        ({ x, y, width, height }) => {
          const centerX = x + width / 2;
          const centerY = y + height / 2;
          const el = document.elementFromPoint(centerX, centerY);
          if (!el) return false;
          const button = el.closest(
            'button[aria-label="تولّي المحادثة"], button[aria-label="إعادة للمساعد"]',
          );
          return button !== null;
        },
        primaryBox,
      );
      expect(isPrimaryActionClickable).toBe(true);

      // Capture screenshot for visual audit
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${vpName}-${fixture.key}-header.png`),
        fullPage: false,
      });
    });
  }

  test("Secondary actions menu: keyboard opening, navigation, Escape, focus return & intercepted payload", async ({
    page,
  }, testInfo) => {
    const vpName = testInfo.project.name;

    await page.goto("/qa/conversation-header?fixture=need_human_unassigned", {
      waitUntil: "domcontentloaded",
    });

    const persistentHeader = page.locator(
      'header[data-testid="conversation-persistent-header"]',
    );
    await expect(persistentHeader).toBeVisible();

    const moreBtn = persistentHeader.locator(
      'button[aria-label="المزيد من الإجراءات"]',
    );
    await expect(moreBtn).toBeVisible();

    // 1. Focus the «المزيد» menu trigger
    await moreBtn.focus();
    const isTriggerFocused = await moreBtn.evaluate(
      (el) => document.activeElement === el,
    );
    expect(isTriggerFocused).toBe(true);

    // 2. Open dropdown menu via physical keyboard key (Enter)
    await page.keyboard.press("Enter");
    const menuContent = page.locator('[role="menu"]');
    await expect(menuContent).toBeVisible();

    // Screenshot open dropdown menu
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${vpName}-more-menu-open.png`),
      fullPage: false,
    });

    // 3. Navigate with ArrowDown
    await page.keyboard.press("ArrowDown");
    const focusedItem = page.locator('[role="menuitem"]:focus');
    await expect(focusedItem).toBeVisible();

    // 4. Test Escape key closes menu and returns focus to trigger
    await page.keyboard.press("Escape");
    await expect(menuContent).not.toBeVisible();
    const isFocusRestored = await moreBtn.evaluate(
      (el) => document.activeElement === el,
    );
    expect(isFocusRestored).toBe(true);

    // 5. Test available secondary action with intercepted payload
    // Intercept/monitor POST action request to verify unchanged payload contract
    let interceptedPostData: string | null = null;
    page.on("request", (req) => {
      if (req.method() === "POST") {
        interceptedPostData = req.postData();
      }
    });

    // Re-open menu to trigger MARK_BOOKED action
    await moreBtn.click();
    await expect(menuContent).toBeVisible();

    const markBookedItem = page.locator('[role="menuitem"]', {
      hasText: "تحديد كمحجوز",
    });
    await expect(markBookedItem).toBeVisible();

    // Trigger action and wait for response
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST"),
      markBookedItem.click(),
    ]);

    // Verify dropdown menu closed after action selection
    await expect(menuContent).not.toBeVisible();

    // Verify transition payload sent by client contains exact transition identifier and id
    const postDataStr = String(interceptedPostData ?? "");
    expect(postDataStr).toContain("MARK_BOOKED");
    expect(postDataStr).toContain("conv-qa-fixture-01");

    // Verify UI state transition completed to BOOKED (status badge reflects «محجوز»)
    const bookedBadge = persistentHeader.locator(
      '[aria-label^="حالة المحادثة:"]',
    );
    await expect(bookedBadge).toContainText("محجوز");
  });

  test("Preserve shell invariants: scroll thresholds, pinned header, composer clearance, draft & reading position", async ({
    page,
  }, testInfo) => {
    const vpName = testInfo.project.name;

    await page.goto("/qa/conversation-header?fixture=need_human_unassigned", {
      waitUntil: "domcontentloaded",
    });

    const persistentHeader = page.locator(
      'header[data-testid="conversation-persistent-header"]',
    );
    await expect(persistentHeader).toBeVisible();
    const initialHeaderBox = await persistentHeader.boundingBox();
    expect(initialHeaderBox).not.toBeNull();
    if (!initialHeaderBox) return;

    // Enforce <=160px mobile header height ceiling
    if (vpName.startsWith("mobile")) {
      expect(initialHeaderBox.height).toBeLessThanOrEqual(160);
    }

    // 1. Message log scrollability threshold assertion
    const messageLog = page.locator('div[role="log"]');
    await expect(messageLog).toBeVisible();

    const initialMetrics = await messageLog.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }));
    // Height threshold: scrollHeight must strictly exceed clientHeight
    expect(initialMetrics.scrollHeight).toBeGreaterThan(
      initialMetrics.clientHeight,
    );
    // Initial mount auto-scrolls to bottom
    expect(initialMetrics.scrollTop).toBeGreaterThan(0);

    // 2. Scroll to top: Header must remain pinned at top
    await messageLog.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(100);
    const topHeaderBox = await persistentHeader.boundingBox();
    expect(topHeaderBox).not.toBeNull();
    if (topHeaderBox) {
      expect(Math.abs(topHeaderBox.y - initialHeaderBox.y)).toBeLessThanOrEqual(
        5,
      );
    }

    // 3. Scroll to middle reading position
    const middleTarget = Math.floor(
      (initialMetrics.scrollHeight - initialMetrics.clientHeight) / 2,
    );
    await messageLog.evaluate((el, target) => {
      el.scrollTop = target;
    }, middleTarget);
    await page.waitForTimeout(100);

    // 4. Verify composer visibility & positioning above mobile bottom navigation
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
          expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(
            navBox.y + 10,
          );
        }
      }
    }

    // 5. Draft text preservation and reading position across mobile view toggle
    if (!vpName.includes("desktop")) {
      const draftMessage = "مسودة رد تجريبي لحفظ النص";
      await replyTextarea.fill(draftMessage);
      expect(await replyTextarea.inputValue()).toBe(draftMessage);

      const contextToggle = persistentHeader.locator(
        'button[aria-label="عرض تفاصيل العميل والمواعيد"]',
      );
      await expect(contextToggle).toBeVisible();
      await contextToggle.click();
      await page.waitForTimeout(150);

      // Context view opened
      await expect(
        page.getByRole("heading", { name: "سياق العميل" }).first(),
      ).toBeVisible();

      // Screenshot Context view
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, `${vpName}-context-details-open.png`),
        fullPage: false,
      });

      // Toggle back to messages
      const messagesToggle = persistentHeader.locator(
        'button[aria-label="العودة إلى المحادثة"]',
      );
      await expect(messagesToggle).toBeVisible();
      await messagesToggle.click();
      await page.waitForTimeout(150);

      // Verify draft preservation
      expect(await replyTextarea.inputValue()).toBe(draftMessage);

      // Verify reading position (scrollTop) preservation
      const restoredScrollTop = await messageLog.evaluate((el) => el.scrollTop);
      expect(Math.abs(restoredScrollTop - middleTarget)).toBeLessThanOrEqual(
        30,
      );
    }

    // 6. Window scroll position must remain <= 10px across all viewports (no document runaway / scroll trap)
    const windowScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );
    expect(windowScrollY).toBeLessThanOrEqual(10);

    if (vpName.includes("desktop")) {
      const sidebarHeading = page.getByRole("heading", { name: "سياق العميل" });
      await expect(sidebarHeading).toBeVisible();
    }

    // 7. Zero document horizontal overflow
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);
  });

  test("Controlled beforeinstallprompt event & route-based install banner suppression", async ({
    page,
  }) => {
    // 1. Allowed Settings route: banner appears when beforeinstallprompt fires and dismissal is honored
    await page.goto("/qa/conversation-header?installRoute=/settings", {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(() => window.localStorage.clear());
    await page.waitForSelector('html[data-install-prompt-ready="true"]');

    const installBanner = page.locator('aside[aria-label="تثبيت التطبيق"]');
    await expect(installBanner).not.toBeVisible();

    // Fire controlled beforeinstallprompt event
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "prompt", {
        value: () => Promise.resolve(),
      });
      Object.defineProperty(event, "userChoice", {
        value: Promise.resolve({ outcome: "accepted" }),
      });
      window.dispatchEvent(event);
    });

    await expect(installBanner).toBeVisible();

    // Dismiss banner
    const dismissBtn = installBanner.locator('button[aria-label="إغلاق"]');
    await dismissBtn.click();
    await expect(installBanner).not.toBeVisible();

    // Subsequent beforeinstallprompt event within cooldown does NOT show banner
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "prompt", {
        value: () => Promise.resolve(),
      });
      Object.defineProperty(event, "userChoice", {
        value: Promise.resolve({ outcome: "accepted" }),
      });
      window.dispatchEvent(event);
    });
    await expect(installBanner).not.toBeVisible();

    // 2. Conversation detail route: banner is strictly suppressed (even without dismissal cooldown)
    await page.goto(
      "/qa/conversation-header?installRoute=/conversations/conv-123",
      {
        waitUntil: "domcontentloaded",
      },
    );
    await page.evaluate(() => window.localStorage.clear());
    await page.waitForSelector('html[data-install-prompt-ready="true"]');
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "prompt", {
        value: () => Promise.resolve(),
      });
      Object.defineProperty(event, "userChoice", {
        value: Promise.resolve({ outcome: "accepted" }),
      });
      window.dispatchEvent(event);
    });
    await expect(installBanner).not.toBeVisible();

    // 3. Booking task route: banner is strictly suppressed (even without dismissal cooldown)
    await page.goto("/qa/conversation-header?installRoute=/appointments/new", {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(() => window.localStorage.clear());
    await page.waitForSelector('html[data-install-prompt-ready="true"]');
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(event, "prompt", {
        value: () => Promise.resolve(),
      });
      Object.defineProperty(event, "userChoice", {
        value: Promise.resolve({ outcome: "accepted" }),
      });
      window.dispatchEvent(event);
    });
    await expect(installBanner).not.toBeVisible();
  });

  test("Deterministic inbox restoration: 30 fixture rows, non-zero scroll, Back/Forward & draft preservation", async ({
    page,
  }, testInfo) => {
    const vpName = testInfo.project.name;
    const isMobile = vpName.startsWith("mobile");

    // 1. Load inbox with 30 fixture rows
    await page.goto("/qa/conversation-header?view=inbox", {
      waitUntil: "domcontentloaded",
    });

    // Verify inbox rendered
    const searchInput = page.locator(
      'input[placeholder="ابحث باسم العميل أو الرسالة"]',
    );
    await expect(searchInput).toBeVisible();

    // Set non-empty search and status filter
    await searchInput.fill("سارة");
    const statusSelect = page.locator('button[aria-label="تصفية حسب الحالة"]');
    await statusSelect.click();
    await page.getByRole("option", { name: "تحتاج تدخلاً" }).click();

    // Verify filtered items rendered
    const conversationLinks = page.locator('a[href*="view=conversation"]');
    await expect(conversationLinks.first()).toBeVisible();
    const count = await conversationLinks.count();
    expect(count).toBeGreaterThan(0);

    // Scroll inbox down to non-zero position
    await page.evaluate(() => window.scrollTo(0, 200));
    const initialScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );
    expect(initialScrollY).toBeGreaterThan(0);

    // Open first filtered conversation
    await conversationLinks.first().click();

    // Assert outer scroll is <= 10px immediately upon entry
    await page.waitForSelector(
      'header[data-testid="conversation-persistent-header"]',
    );
    const entryScrollY = await page.evaluate(
      () => window.scrollY || document.documentElement.scrollTop,
    );
    expect(entryScrollY).toBeLessThanOrEqual(10);

    // Complete customer identity visible
    const customerH1 = page.locator(
      'header[data-testid="conversation-persistent-header"] h1',
    );
    await expect(customerH1).toBeVisible();

    // Type a draft
    const replyTextarea = page.locator('textarea[aria-label="رد على العميل"]');
    await expect(replyTextarea).toBeVisible();
    const testDraft = "مسودة اختبار استعادة الفلاتر والتمرير";
    await replyTextarea.fill(testDraft);

    // If mobile, test details screen toggle preserves draft
    if (isMobile) {
      const detailsToggle = page.locator(
        'button[aria-label="عرض تفاصيل العميل والمواعيد"]',
      );
      if (await detailsToggle.isVisible()) {
        await detailsToggle.click();
        await expect(
          page.getByRole("heading", { name: "سياق العميل" }).first(),
        ).toBeVisible();

        const backToggle = page.locator(
          'button[aria-label="العودة إلى المحادثة"]',
        );
        await backToggle.click();
        await expect(replyTextarea).toHaveValue(testDraft);
      }
    }

    // 2. Return using in-app Back button
    const backBtn = page.locator('a[aria-label="العودة إلى المحادثات"]');
    await backBtn.click();

    // Verify restored search and filter
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveValue("سارة");

    // Verify restored scroll position
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => window.scrollY || document.documentElement.scrollTop,
          ),
      )
      .toBeGreaterThan(0);

    // Reopen the conversation and verify draft intact
    await conversationLinks.first().click();
    await expect(replyTextarea).toBeVisible();
    await expect(replyTextarea).toHaveValue(testDraft);

    // 3. Test browser Back and Forward navigation
    await page.goBack();
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toHaveValue("سارة");
    await expect
      .poll(
        async () =>
          await page.evaluate(
            () => window.scrollY || document.documentElement.scrollTop,
          ),
      )
      .toBeGreaterThan(0);

    await page.goForward();
    await expect(replyTextarea).toBeVisible();
    await expect(replyTextarea).toHaveValue(testDraft);
  });

  test("Mobile composer geometry and bottom navigation clearance across viewports", async ({
    page,
  }, testInfo) => {
    const vpName = testInfo.project.name;
    const isMobile = vpName.startsWith("mobile");
    if (!isMobile) return;

    await page.goto("/qa/conversation-header?fixture=need_human_unassigned", {
      waitUntil: "domcontentloaded",
    });

    const replyTextarea = page.locator('textarea[aria-label="رد على العميل"]');
    const sendButton = page.locator('button[aria-label="إرسال الرد"]');
    const bottomNav = page.locator('nav[aria-label="التنقل الرئيسي"]');

    await expect(replyTextarea).toBeVisible();
    await expect(sendButton).toBeVisible();
    await expect(bottomNav).toBeVisible();

    // Evaluate geometry on normal height and reduced height (e.g. SE/landscape clearance)
    const testHeights = [844, 667, 600];
    const viewport = page.viewportSize();
    const width = viewport?.width ?? 390;

    for (const h of testHeights) {
      await page.setViewportSize({ width, height: h });
      await page.waitForTimeout(50);

      const composerBox = await replyTextarea.boundingBox();
      const sendBox = await sendButton.boundingBox();
      const navBox = await bottomNav.boundingBox();

      expect(composerBox).not.toBeNull();
      expect(sendBox).not.toBeNull();
      expect(navBox).not.toBeNull();

      if (composerBox && navBox && sendBox) {
        // 1. Composer textarea is inside the viewport
        expect(composerBox.y).toBeGreaterThanOrEqual(0);
        expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(h);

        // 2. Composer textarea is strictly above the bottom navigation (unobstructed)
        expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(
          navBox.y,
        );

        // 3. Send button is inside viewport and above bottom navigation
        expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(navBox.y);
        expect(sendBox.width).toBeGreaterThanOrEqual(44);
        expect(sendBox.height).toBeGreaterThanOrEqual(44);

        // 4. Zero horizontal overflow
        const isOverflowing = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth,
        );
        expect(isOverflowing).toBe(false);
      }
    }
  });

  test("QA harness route boundaries: fixture available in intended CI test configuration & broad /qa/ closed", async ({
    page,
  }) => {
    // 1. Fixture route is available in the intended CI test configuration
    const res = await page.goto(
      "/qa/conversation-header?fixture=need_human_unassigned",
      {
        waitUntil: "domcontentloaded",
      },
    );
    expect(res?.status()).toBe(200);
    await expect(
      page.locator('header[data-testid="conversation-persistent-header"]'),
    ).toBeVisible();

    // 2. Broad /qa/ path and unknown subpaths are not public (redirected to /sign-in or 404)
    const unauthorizedRes = await page.goto("/qa/unauthorized-subroute", {
      waitUntil: "domcontentloaded",
    });
    // Proxy redirects unauthenticated non-public paths to /sign-in, or server returns 404
    expect(page.url()).toMatch(/\/sign-in|\/qa\/unauthorized-subroute/);
    if (!page.url().includes("/sign-in")) {
      expect(unauthorizedRes?.status()).toBe(404);
    }
  });
});
