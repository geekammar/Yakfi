import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "playwright-report",
  "screenshots",
  "sign-in",
);

test.beforeAll(() => {
  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }
});

test.describe("Sign-in validation and recovery UX", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
  });

  test("1. Initial state: Arabic RTL, remember-me unchecked, no initial errors", async ({
    page,
  }, testInfo) => {
    // Assert heading and page structure
    const heading = page.locator("h1");
    await expect(heading).toHaveText("تسجيل الدخول");

    // RTL direction on document or container
    const isRtl = await page.evaluate(() => {
      const dir =
        document.documentElement.dir ||
        document.body.dir ||
        window.getComputedStyle(document.body).direction;
      return dir === "rtl";
    });
    expect(isRtl).toBe(true);

    // Inputs have LTR direction for email & password formatting
    const emailInput = page.locator("#email");
    const passwordInput = page.locator("#password");
    await expect(emailInput).toHaveAttribute("dir", "ltr");
    await expect(passwordInput).toHaveAttribute("dir", "ltr");

    // Remember-me starts UNCHECKED
    const rememberMeCheckbox = page.locator("#rememberMe");
    await expect(rememberMeCheckbox).toHaveAttribute("data-state", "unchecked");
    await expect(rememberMeCheckbox).toHaveAttribute("aria-checked", "false");

    // No field or form errors visible initially
    await expect(page.locator("#email-error")).toHaveCount(0);
    await expect(page.locator("#password-error")).toHaveCount(0);
    await expect(page.locator("#login-form-error")).toHaveCount(0);

    // Capture initial screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `initial-state-${testInfo.project.name}.png`,
      ),
      fullPage: true,
    });
  });

  test("2. Empty submit shows field errors, links aria attributes, focuses first invalid, no horizontal overflow", async ({
    page,
  }, testInfo) => {
    let authRequests = 0;
    await page.route("**/api/auth/**", async (route) => {
      authRequests++;
      await route.abort();
    });

    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();

    // Zero API requests on invalid submit
    expect(authRequests).toBe(0);

    // Concise Arabic errors adjacent to fields
    const emailError = page.locator("#email-error");
    const passwordError = page.locator("#password-error");
    await expect(emailError).toBeVisible();
    await expect(emailError).toHaveText("بريد إلكتروني غير صالح");
    await expect(passwordError).toBeVisible();
    await expect(passwordError).toHaveText("كلمة المرور قصيرة جداً");

    // Accessible associations
    const emailInput = page.locator("#email");
    const passwordInput = page.locator("#password");
    await expect(emailInput).toHaveAttribute("aria-invalid", "true");
    await expect(emailInput).toHaveAttribute("aria-describedby", "email-error");
    await expect(passwordInput).toHaveAttribute("aria-invalid", "true");
    await expect(passwordInput).toHaveAttribute(
      "aria-describedby",
      "password-error",
    );

    // Focus moves to first invalid input (email)
    await expect(emailInput).toBeFocused();

    // Verify no horizontal overflow across 320px, 390px, and desktop
    const overflowCheck = await page.evaluate(() => {
      const scrollW = document.documentElement.scrollWidth;
      const clientW = document.documentElement.clientWidth;
      return { scrollW, clientW, hasOverflow: scrollW > clientW };
    });
    expect(overflowCheck.hasOverflow).toBe(false);

    // Capture validation errors screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `validation-errors-${testInfo.project.name}.png`,
      ),
      fullPage: true,
    });
  });

  test("3. Editing one field clears only its stale error and preserves the other", async ({
    page,
  }) => {
    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();

    const emailInput = page.locator("#email");
    const passwordInput = page.locator("#password");
    const emailError = page.locator("#email-error");
    const passwordError = page.locator("#password-error");

    await expect(emailError).toBeVisible();
    await expect(passwordError).toBeVisible();

    // Typing into email clears only email error
    await emailInput.fill("user@flowpilot.app");
    await expect(emailError).toHaveCount(0);
    await expect(emailInput).not.toHaveAttribute("aria-invalid", "true");
    await expect(passwordError).toBeVisible();
    await expect(passwordInput).toHaveAttribute("aria-invalid", "true");

    // Submitting now focuses password because email is valid
    await submitBtn.click();
    await expect(passwordInput).toBeFocused();

    // Typing into password clears password error
    await passwordInput.fill("Password123!");
    await expect(passwordError).toHaveCount(0);
    await expect(passwordInput).not.toHaveAttribute("aria-invalid", "true");
  });

  test("4. Deterministic auth failure (401) shows generic alert, preserves values, supports explicit rememberMe", async ({
    page,
  }, testInfo) => {
    let capturedPayload: {
      email?: string;
      password?: string;
      rememberMe?: boolean;
    } | null = null;

    await page.route("**/api/auth/**", async (route) => {
      try {
        capturedPayload = route.request().postDataJSON();
      } catch {
        capturedPayload = null;
      }
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          status: 401,
          message: "Invalid email or password",
        }),
      });
    });

    const emailInput = page.locator("#email");
    const passwordInput = page.locator("#password");
    const rememberMe = page.locator("#rememberMe");
    const submitBtn = page.locator('button[type="submit"]');

    await emailInput.fill("unregistered@flowpilot.app");
    await passwordInput.fill("WrongPass123!");

    // Submit with remember-me unchecked
    await submitBtn.click();

    // Check payload sent rememberMe: false
    await expect(submitBtn).toBeEnabled();
    expect(capturedPayload).not.toBeNull();
    expect(capturedPayload?.rememberMe).toBe(false);

    // Form-level error is generic and does not disclose account existence
    const formError = page.locator("#login-form-error");
    await expect(formError).toBeVisible();
    await expect(formError).toHaveAttribute("role", "alert");
    await expect(formError).toHaveText(
      "البريد الإلكتروني أو كلمة المرور غير صحيحة",
    );

    // Entered values remain intact after failure
    await expect(emailInput).toHaveValue("unregistered@flowpilot.app");
    await expect(passwordInput).toHaveValue("WrongPass123!");

    // Capture 401 screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `auth-failure-401-${testInfo.project.name}.png`,
      ),
      fullPage: true,
    });

    // Check remember-me explicitly via its label
    const rememberMeLabel = page.locator("label[for='rememberMe']");
    await rememberMeLabel.click();
    await expect(rememberMe).toHaveAttribute("data-state", "checked");

    // Resubmit and verify rememberMe: true in payload
    await submitBtn.click();
    await expect(submitBtn).toBeEnabled();
    expect(capturedPayload?.rememberMe).toBe(true);
  });

  test("5. Network/connection failure shows concise Arabic message and recovers on retry", async ({
    page,
  }, testInfo) => {
    let attempt = 0;
    await page.route("**/api/auth/**", async (route) => {
      attempt++;
      if (attempt === 1) {
        // First attempt drops / aborts
        await route.abort("connectionfailed");
      } else {
        // Second attempt fails with 401
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ status: 401 }),
        });
      }
    });

    const emailInput = page.locator("#email");
    const passwordInput = page.locator("#password");
    const submitBtn = page.locator('button[type="submit"]');

    await emailInput.fill("user@flowpilot.app");
    await passwordInput.fill("Password123!");

    // First attempt -> drops connection
    await submitBtn.click();

    const formError = page.locator("#login-form-error");
    await expect(formError).toBeVisible();
    await expect(formError).toHaveAttribute("role", "alert");
    await expect(formError).toHaveText("تعذر الاتصال بالخادم، حاول مرة أخرى");

    // Pending state cleared: button re-enabled
    await expect(submitBtn).toBeEnabled();

    // Capture connection failure screenshot
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        `connection-failure-${testInfo.project.name}.png`,
      ),
      fullPage: true,
    });

    // Editing clears the error
    await emailInput.press("Backspace");
    await expect(formError).toHaveCount(0);

    await emailInput.press("p");
    // Retry succeeds to execute next request
    await submitBtn.click();
    await expect(formError).toHaveText(
      "البريد الإلكتروني أو كلمة المرور غير صحيحة",
    );
  });
});
