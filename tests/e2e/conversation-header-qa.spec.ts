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
    expectedStatusText: "تم الحجز",
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

      // Verify booking shortcut button is directly accessible
      const bookingLink = persistentHeader.locator('a[aria-label="حجز موعد"]');
      await expect(bookingLink).toBeVisible();
      const bookingBox = await bookingLink.boundingBox();
      expect(bookingBox).not.toBeNull();
      if (bookingBox) {
        expect(bookingBox.y).toBeGreaterThanOrEqual(headerBox.y);
        expect(bookingBox.y + bookingBox.height).toBeLessThanOrEqual(
          headerBox.y + headerBox.height + 2,
        );
      }

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

    // Verify UI state transition completed to BOOKED (status badge reflects «تم الحجز»)
    const bookedBadge = persistentHeader.locator(
      '[aria-label^="حالة المحادثة:"]',
    );
    await expect(bookedBadge).toContainText("تم الحجز");
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

    // 6. Desktop PR47 sidebar constraints assertion
    if (vpName.includes("desktop")) {
      const sidebarHeading = page.getByRole("heading", { name: "سياق العميل" });
      await expect(sidebarHeading).toBeVisible();

      // Window scroll position must remain at 0 (no document-level overflow runaway)
      const windowScrollY = await page.evaluate(
        () => window.scrollY || document.documentElement.scrollTop,
      );
      expect(windowScrollY).toBeLessThanOrEqual(10);
    }

    // 7. Zero document horizontal overflow
    const hasHorizontalOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);
  });
});
