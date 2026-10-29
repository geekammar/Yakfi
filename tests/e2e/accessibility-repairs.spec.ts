import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "playwright-report",
  "screenshots",
  "accessibility-repairs",
);

test.beforeAll(() => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

test.describe("UI & Accessibility Repairs QA", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/qa/accessibility-repairs", {
      waitUntil: "domcontentloaded",
    });
  });

  test("1. Shared Dialog: RTL/LTR positioning, 44x44 target, Arabic label, Escape, focus trap & return", async ({
    page,
  }, testInfo) => {
    // ── RTL Dialog Verification ──
    const rtlTrigger = page.locator('[data-testid="open-rtl-dialog"]');
    await expect(rtlTrigger).toBeVisible();
    await rtlTrigger.focus();
    await rtlTrigger.click();

    const rtlContent = page.locator('[data-testid="dialog-rtl-content"]');
    await expect(rtlContent).toBeVisible();
    await page.waitForTimeout(150);

    // Check close button properties
    const rtlCloseButton = rtlContent.locator(
      'button[data-slot="dialog-close"]',
    );
    await expect(rtlCloseButton).toBeVisible();

    // Check accessible Arabic label "إغلاق"
    const closeLabel = await rtlCloseButton.getAttribute("aria-label");
    const closeSrText = await rtlCloseButton
      .locator("span.sr-only")
      .textContent();
    expect(closeLabel === "إغلاق" || closeSrText?.trim() === "إغلاق").toBe(
      true,
    );

    // Check touch target >= 44x44px
    const closeBox = await rtlCloseButton.boundingBox();
    const contentBox = await rtlContent.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    if (closeBox && contentBox) {
      expect(Math.round(closeBox.width)).toBeGreaterThanOrEqual(44);
      expect(Math.round(closeBox.height)).toBeGreaterThanOrEqual(44);

      // In RTL, close button must be on the LEFT side of dialog content
      const contentCenterX = contentBox.x + contentBox.width / 2;
      expect(
        closeBox.x,
        "Close button in RTL must be on the left half",
      ).toBeLessThan(contentCenterX);

      // Verify header space: DialogHeader reserves space so title text & icon cannot overlap close button
      const headerPadding = await page
        .locator('[data-testid="dialog-rtl-header"]')
        .evaluate((el) => {
          const style = window.getComputedStyle(el);
          return {
            paddingInlineEnd: parseFloat(style.paddingInlineEnd) || 0,
            paddingLeft: parseFloat(style.paddingLeft) || 0,
          };
        });
      expect(
        headerPadding.paddingInlineEnd >= 44 || headerPadding.paddingLeft >= 44,
        "DialogHeader must reserve at least 44px on inline-end / left in RTL",
      ).toBe(true);

      const iconBox = await page
        .locator('[data-testid="dialog-rtl-icon"]')
        .boundingBox();
      expect(iconBox).not.toBeNull();
      if (iconBox) {
        const iconOverlaps = !(
          closeBox.x + closeBox.width <= iconBox.x ||
          iconBox.x + iconBox.width <= closeBox.x ||
          closeBox.y + closeBox.height <= iconBox.y ||
          iconBox.y + iconBox.height <= closeBox.y
        );
        expect(
          iconOverlaps,
          "Title icon and close button must not overlap in RTL dialog header",
        ).toBe(false);
      }

      const textSpanBox = await page
        .locator('[data-testid="dialog-rtl-title"] span')
        .boundingBox();
      expect(textSpanBox).not.toBeNull();
      if (textSpanBox) {
        const textOverlaps = !(
          closeBox.x + closeBox.width <= textSpanBox.x ||
          textSpanBox.x + textSpanBox.width <= closeBox.x ||
          closeBox.y + closeBox.height <= textSpanBox.y ||
          textSpanBox.y + textSpanBox.height <= closeBox.y
        );
        expect(
          textOverlaps,
          "Title text and close button must not overlap in RTL dialog header",
        ).toBe(false);
      }
    }

    // Capture RTL Dialog Screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-rtl-dialog.png`,
      ),
      fullPage: false,
    });

    // Test focus trap: pressing Tab cycles focus inside dialog
    const inputInside = page.locator('[data-testid="dialog-first-input"]');
    await inputInside.focus();
    await expect(inputInside).toBeFocused();
    await page.keyboard.press("Tab");
    // Next focusable element is close button
    await expect(rtlCloseButton).toBeFocused();

    // Forward wrapping: pressing Tab from last element wraps back to first element
    await page.keyboard.press("Tab");
    await expect(inputInside).toBeFocused();

    // Reverse wrapping: pressing Shift+Tab from first element wraps in reverse to last element
    await page.keyboard.press("Shift+Tab");
    await expect(rtlCloseButton).toBeFocused();

    // Shift+Tab from close button moves backward to first element
    await page.keyboard.press("Shift+Tab");
    await expect(inputInside).toBeFocused();

    // Test Escape key handling and focus return
    await page.keyboard.press("Escape");
    await expect(rtlContent).not.toBeVisible();
    // Focus must return to the trigger element that opened the dialog
    await expect(rtlTrigger).toBeFocused();

    // ── LTR Dialog Verification ──
    const ltrTrigger = page.locator('[data-testid="open-ltr-dialog"]');
    await expect(ltrTrigger).toBeVisible();
    await ltrTrigger.click();

    const ltrContent = page.locator('[data-testid="dialog-ltr-content"]');
    await expect(ltrContent).toBeVisible();
    await page.waitForTimeout(150);

    const ltrCloseButton = ltrContent.locator(
      'button[data-slot="dialog-close"]',
    );
    await expect(ltrCloseButton).toBeVisible();

    const ltrCloseBox = await ltrCloseButton.boundingBox();
    const ltrContentBox = await ltrContent.boundingBox();
    expect(ltrCloseBox).not.toBeNull();
    expect(ltrContentBox).not.toBeNull();
    if (ltrCloseBox && ltrContentBox) {
      expect(Math.round(ltrCloseBox.width)).toBeGreaterThanOrEqual(44);
      expect(Math.round(ltrCloseBox.height)).toBeGreaterThanOrEqual(44);

      // In LTR, close button must be on the RIGHT side of dialog content
      const ltrContentCenterX = ltrContentBox.x + ltrContentBox.width / 2;
      expect(
        ltrCloseBox.x,
        "Close button in LTR must be on the right half",
      ).toBeGreaterThan(ltrContentCenterX);

      // Verify LTR header space reservation
      const ltrHeaderPadding = await page
        .locator('[data-testid="dialog-ltr-header"]')
        .evaluate((el) => {
          const style = window.getComputedStyle(el);
          return {
            paddingInlineEnd: parseFloat(style.paddingInlineEnd) || 0,
            paddingRight: parseFloat(style.paddingRight) || 0,
          };
        });
      expect(
        ltrHeaderPadding.paddingInlineEnd >= 44 ||
          ltrHeaderPadding.paddingRight >= 44,
        "DialogHeader in LTR must reserve at least 44px on inline-end / right",
      ).toBe(true);
    }

    // Capture LTR Dialog Screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-ltr-dialog.png`,
      ),
      fullPage: false,
    });

    await page.keyboard.press("Escape");
    await expect(ltrContent).not.toBeVisible();
    await expect(ltrTrigger).toBeFocused();
  });

  test("1b. CustomersDirectory → CustomerFormDialog: focus restoration to actual opener on Escape, Close button, and Cancel across primary and empty-state entries", async ({
    page,
  }) => {
    await page.locator('[data-testid="tab-dialogs"]').click();
    const section = page.locator(
      '[data-testid="section-customers-composition"]',
    );
    await expect(section).toBeVisible();

    // ── 1. Primary Create Button: Escape key ──
    const primaryBtn = page.locator(
      '[data-testid="customers-primary-create-btn"]',
    );
    await expect(primaryBtn).toBeVisible();
    await primaryBtn.focus();
    await expect(primaryBtn).toBeFocused();
    await primaryBtn.click();

    const dialogContent = page.locator('[data-slot="dialog-content"]');
    await expect(dialogContent).toBeVisible();
    await page.waitForTimeout(100);

    // Escape closes dialog and restores focus to primary button
    await page.keyboard.press("Escape");
    await expect(dialogContent).not.toBeVisible();
    await expect(primaryBtn).toBeFocused();

    // ── 2. Primary Create Button: Reopening & Close Button (X) ──
    await primaryBtn.click();
    await expect(dialogContent).toBeVisible();
    await page.waitForTimeout(100);

    const closeBtn = dialogContent.locator('button[data-slot="dialog-close"]');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(dialogContent).not.toBeVisible();
    await expect(primaryBtn).toBeFocused();

    // ── 3. Primary Create Button: Reopening & Cancel Button ("إلغاء") ──
    await primaryBtn.click();
    await expect(dialogContent).toBeVisible();
    await page.waitForTimeout(100);

    const cancelBtn = dialogContent.getByRole("button", { name: "إلغاء" });
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();
    await expect(dialogContent).not.toBeVisible();
    await expect(primaryBtn).toBeFocused();

    // ── 4. Empty State Create Button: Escape and Cancel ──
    await page.locator('[data-testid="toggle-customers-empty"]').click();
    const emptyBtn = page.locator('[data-testid="customers-empty-create-btn"]');
    await expect(emptyBtn).toBeVisible();
    await emptyBtn.focus();
    await expect(emptyBtn).toBeFocused();
    await emptyBtn.click();

    await expect(dialogContent).toBeVisible();
    await page.waitForTimeout(100);

    await page.keyboard.press("Escape");
    await expect(dialogContent).not.toBeVisible();
    await expect(emptyBtn).toBeFocused();

    // Reopen from empty state and close via Cancel
    await emptyBtn.click();
    await expect(dialogContent).toBeVisible();
    await page.waitForTimeout(100);

    const emptyCancelBtn = dialogContent.getByRole("button", { name: "إلغاء" });
    await expect(emptyCancelBtn).toBeVisible();
    await emptyCancelBtn.click();
    await expect(dialogContent).not.toBeVisible();
    await expect(emptyBtn).toBeFocused();
  });

  test("2. Working Hours Inputs: Unique day-specific labels and bindings", async ({
    page,
  }, testInfo) => {
    // Switch to working hours tab
    await page.locator('[data-testid="tab-working-hours"]').click();
    await expect(
      page.locator('[data-testid="section-working-hours"]'),
    ).toBeVisible();

    // Verify unique day-specific labels exist for all days
    const dayLabels = [
      { name: "السبت", key: "sat", closed: false },
      { name: "الأحد", key: "sun", closed: false },
      { name: "الاثنين", key: "mon", closed: false },
      { name: "الثلاثاء", key: "tue", closed: false },
      { name: "الأربعاء", key: "wed", closed: false },
      { name: "الخميس", key: "thu", closed: false },
      { name: "الجمعة", key: "fri", closed: true },
    ];

    for (const day of dayLabels) {
      const openInput = page.getByLabel(`بداية العمل يوم ${day.name}`);
      const closeInput = page.getByLabel(`نهاية العمل يوم ${day.name}`);

      await expect(openInput).toBeVisible();
      await expect(closeInput).toBeVisible();

      // Check ID binding with Label htmlFor
      const openId = await openInput.getAttribute("id");
      expect(openId).toBe(`working-hours-${day.key}-open`);
      const openLabel = page.locator(`label[for="${openId}"]`);
      await expect(openLabel).toBeVisible();

      const closeId = await closeInput.getAttribute("id");
      expect(closeId).toBe(`working-hours-${day.key}-close`);
      const closeLabel = page.locator(`label[for="${closeId}"]`);
      await expect(closeLabel).toBeVisible();

      // Verify closed day has disabled inputs
      if (day.closed) {
        await expect(openInput).toBeDisabled();
        await expect(closeInput).toBeDisabled();
      } else {
        await expect(openInput).toBeEnabled();
        await expect(closeInput).toBeEnabled();
        expect(await openInput.inputValue()).toBe("09:00");
        expect(await closeInput.inputValue()).toBe("17:00");
      }
    }

    // Capture Working Hours Form Screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-working-hours.png`,
      ),
      fullPage: false,
    });
  });

  test("3. Team Screen: Admin-only, mixed, and empty fixtures match count and list", async ({
    page,
  }, testInfo) => {
    // Switch to team screen tab
    await page.locator('[data-testid="tab-team"]').click();
    await expect(page.locator('[data-testid="section-team"]')).toBeVisible();

    // ── Case A: Admin-only fixture (1 Admin, 0 Staff) ──
    await page
      .locator('[data-testid="fixture-team-admin"]')
      .click({ force: true });
    const teamSection = page.locator("section", {
      hasText: "أعضاء المنشأة (حسابات الدخول)",
    });
    await expect(teamSection).toBeVisible();

    // Count heading must show "عضو واحد"
    await expect(teamSection).toContainText("عضو واحد");

    // Must NOT display empty state "لم يتم إضافة أعضاء بعد" or "لم تُضف موظفين بعد"
    await expect(
      teamSection.locator('text="لم يتم إضافة أعضاء بعد"'),
    ).toHaveCount(0);
    await expect(teamSection.locator('text="لم تُضف موظفين بعد"')).toHaveCount(
      0,
    );

    // Must display exactly 1 member card for the admin
    const memberItemsAdmin = teamSection.locator("ul > li");
    await expect(memberItemsAdmin).toHaveCount(1);
    await expect(memberItemsAdmin.first()).toContainText("أحمد المشرف");
    await expect(memberItemsAdmin.first()).toContainText("مدير");

    // Screenshot Admin-only fixture
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-team-admin-only.png`,
      ),
      fullPage: false,
    });

    // ── Case B: Mixed fixture (1 Admin + 2 Staff) ──
    await page
      .locator('[data-testid="fixture-team-mixed"]')
      .click({ force: true });
    await expect(teamSection).toContainText("3 أعضاء");
    const memberItemsMixed = teamSection.locator("ul > li");
    await expect(memberItemsMixed).toHaveCount(3);
    await expect(
      teamSection.locator('text="لم يتم إضافة أعضاء بعد"'),
    ).toHaveCount(0);

    // ── Case C: Empty fixture (0 Members) ──
    await page
      .locator('[data-testid="fixture-team-empty"]')
      .click({ force: true });
    await expect(teamSection).toContainText("لا يوجد أعضاء");
    await expect(teamSection.locator("ul > li")).toHaveCount(0);
    // Empty state MUST be visible
    await expect(
      teamSection.locator('text="لم يتم إضافة أعضاء بعد"'),
    ).toBeVisible();

    // Screenshot Empty fixture
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-team-empty.png`,
      ),
      fullPage: false,
    });
  });

  test("4. Appointment View Switch: aria-pressed semantics and non-color indicator", async ({
    page,
  }, testInfo) => {
    // Switch to appointments tab
    await page.locator('[data-testid="tab-appointments"]').click();
    await expect(
      page.locator('[data-testid="section-appointments"]'),
    ).toBeVisible();

    const switchGroup = page.locator(
      'div[role="group"][aria-label="طريقة عرض المواعيد"]',
    );
    await expect(switchGroup).toBeVisible();

    const listViewButton = switchGroup.locator("button", {
      hasText: "قائمة المواعيد",
    });
    const calendarViewButton = switchGroup.locator("button", {
      hasText: "الجدول الزمني",
    });

    // 1. Initial state: List view selected
    await expect(listViewButton).toHaveAttribute("aria-pressed", "true");
    await expect(calendarViewButton).toHaveAttribute("aria-pressed", "false");

    // Non-color indicator: dot indicator must be inside selected button
    const listDot = listViewButton.locator("span.rounded-full");
    await expect(listDot).toBeVisible();
    const calendarDotInitial = calendarViewButton.locator("span.rounded-full");
    await expect(calendarDotInitial).toHaveCount(0);

    // Assert content reflects List View: status filter select & timeline ol are visible, calendar timeline section is not
    const listStatusFilter = page.locator(
      'button[aria-label="تصفية حسب الحالة"]',
    );
    const listAppointmentsList = page.locator("ol");
    const calendarTimelineSection = page.locator(
      'section[aria-label="الجدول الزمني لليوم"]',
    );
    await expect(listStatusFilter).toBeVisible();
    await expect(listAppointmentsList).toBeVisible();
    await expect(calendarTimelineSection).toHaveCount(0);

    // Screenshot List View
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-appointment-list-view.png`,
      ),
      fullPage: false,
    });

    // 2. Switch to Calendar View
    await calendarViewButton.click();
    await expect(calendarViewButton).toHaveAttribute("aria-pressed", "true");
    await expect(listViewButton).toHaveAttribute("aria-pressed", "false");

    // Indicator moved to calendar button
    const calendarDot = calendarViewButton.locator("span.rounded-full");
    await expect(calendarDot).toBeVisible();
    await expect(listViewButton.locator("span.rounded-full")).toHaveCount(0);

    // Assert content reflects Calendar View: timeline section is rendered, list controls are hidden
    await expect(calendarTimelineSection).toBeVisible();
    await expect(
      calendarTimelineSection.locator("text=الجدول الزمني والفترات المتاحة"),
    ).toBeVisible();
    await expect(listStatusFilter).toHaveCount(0);
    await expect(listAppointmentsList).toHaveCount(0);

    // Screenshot Calendar View
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-appointment-calendar-view.png`,
      ),
      fullPage: false,
    });

    // 3. Switch back to List View
    await listViewButton.click();
    await expect(listViewButton).toHaveAttribute("aria-pressed", "true");
    await expect(calendarViewButton).toHaveAttribute("aria-pressed", "false");

    // Content changes back: List controls return and timeline section is removed
    await expect(listStatusFilter).toBeVisible();
    await expect(listAppointmentsList).toBeVisible();
    await expect(calendarTimelineSection).toHaveCount(0);
  });

  test("6. Readable Interaction History: summary visible, raw token hidden until expanded, keyboard expansion, no horizontal overflow at narrow viewports", async ({
    page,
  }, testInfo) => {
    // Navigate to interaction history tab
    const interactionsTab = page.locator('[data-testid="tab-interactions"]');
    await expect(interactionsTab).toBeVisible();
    await interactionsTab.click();

    const section = page.locator('[data-testid="section-interactions"]');
    await expect(section).toBeVisible();

    // 1. Confirmed choice readable text visible
    const confirmedText = page.locator(
      '[data-testid="qa-interaction-display-text"]',
    );
    await expect(confirmedText).toBeVisible();
    await expect(confirmedText).toHaveText("اختيار موعد: 10:00 ص");

    // 2. Neutral summary "عرض التفاصيل التقنية" is visible
    const summary = page.locator('[data-testid="qa-interaction-summary"]');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveText("عرض التفاصيل التقنية");

    // 3. Raw token is hidden while details is collapsed
    const rawToken = page.locator('[data-testid="qa-interaction-raw-token"]');
    await expect(rawToken).not.toBeVisible();

    // 4. Keyboard expansion: focus summary and press Enter
    await summary.focus();
    await page.keyboard.press("Enter");

    // Now raw token is revealed
    await expect(rawToken).toBeVisible();
    await expect(rawToken).toHaveText("fp:tok123:1");

    // Press Enter again to collapse
    await page.keyboard.press("Enter");
    await expect(rawToken).not.toBeVisible();

    // 5. Historical message has neutral fallback and collapsed raw details
    const historicalText = page.locator(
      '[data-testid="qa-interaction-historical-text"]',
    );
    await expect(historicalText).toBeVisible();
    await expect(historicalText).toHaveText(
      "محتوى تقني محفوظ؛ تفاصيل الاختيار غير متاحة",
    );

    const historicalRaw = page.locator(
      '[data-testid="qa-interaction-historical-raw-token"]',
    );
    await expect(historicalRaw).not.toBeVisible();

    // 6. No horizontal overflow in viewport
    const overflow = await page.evaluate(() => {
      return {
        bodyScrollWidth: document.body.scrollWidth,
        windowInnerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(
      overflow.docScrollWidth,
      `Horizontal overflow detected: doc scrollWidth ${overflow.docScrollWidth} > innerWidth ${overflow.windowInnerWidth}`,
    ).toBeLessThanOrEqual(overflow.windowInnerWidth);

    // Screenshot for visual evidence
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `${testInfo.project.name}-interaction-history.png`,
      ),
      fullPage: false,
    });
  });
});
