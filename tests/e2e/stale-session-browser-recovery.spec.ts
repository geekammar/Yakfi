/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, test } from "@playwright/test";

import { auth } from "@/lib/auth";
import { db } from "@/server/db";

/**
 * FlowPilot — Stale-Session Browser Recovery Journey (ISS-017)
 *
 * Verifies real end-to-end browser cookie handling and authentication recovery
 * against a real Next.js application and disposable PostgreSQL database in CI:
 *
 * 1. Creates an authorized synthetic user through supported auth.api.signUpEmail.
 * 2. Completes real UI sign-in through the actual login form.
 * 3. Keeps the same browser context and cookies.
 * 4. Revokes the session server-side in the disposable database.
 * 5. Visits "/" and direct "/sign-in"; confirms bounded navigation terminates at usable form.
 * 6. Submits valid credentials through the UI in the SAME browser context.
 * 7. Verifies protected page loads with authenticated identity.
 * 8. Repeats recovery with controlled session expiration (expiresAt in the past).
 */

function isDisposableDb(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    return (
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === ""
    );
  } catch {
    return false;
  }
}

test.describe("Full Browser Recovery Journey (ISS-017)", () => {
  const dbUrl = process.env.DATABASE_URL;
  let testUserId: string | null = null;
  let testBusinessId: string | null = null;

  test.afterAll(async () => {
    if (testUserId) {
      try {
        await db.session.deleteMany({ where: { userId: testUserId } });
        await db.account.deleteMany({ where: { userId: testUserId } });
        await db.user.deleteMany({ where: { id: testUserId } });
      } catch {
        // Best-effort cleanup
      }
    }
    if (testBusinessId) {
      try {
        await db.business.deleteMany({ where: { id: testBusinessId } });
      } catch {
        // Best-effort cleanup
      }
    }
  });

  test("Complete same-browser recovery: server revocation and controlled expiration", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-1280",
      "Scenario runs once in isolated desktop-1280 profile against disposable PostgreSQL",
    );

    test.skip(
      !isDisposableDb(dbUrl),
      "Requires disposable PostgreSQL database (flowpilot_test) in isolated CI",
    );

    const testEmail = `browser.recovery.${Date.now()}@flowpilot.test`;
    const testPassword = "ExamplePassword@1234";
    const testName = "Synthetic Recovery User";

    // a. Create authorized synthetic user through supported auth.api path
    await (auth.api.signUpEmail as any)({
      body: {
        email: testEmail,
        name: testName,
        password: testPassword,
      },
    });

    const business = await db.business.create({
      data: {
        name: "Recovery Test Clinic",
        whatsappNumber: "+966500000001",
        timezone: "Asia/Riyadh",
        onboardingCompletedAt: new Date(),
      },
    });
    testBusinessId = business.id;

    const user = await db.user.update({
      where: { email: testEmail },
      data: {
        isActive: true,
        businessId: business.id,
        role: "ADMIN",
      },
    });
    testUserId = user.id;

    // b. Initial sign in through actual UI
    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
    const emailInput = page.locator("#email");
    const passwordInput = page.locator("#password");
    const submitBtn = page.locator('button[type="submit"]');

    await emailInput.fill(testEmail);
    await passwordInput.fill(testPassword);
    await submitBtn.click();

    await page.waitForURL((u) => !u.pathname.includes("/sign-in"), {
      timeout: 15_000,
      waitUntil: "domcontentloaded",
    });
    expect(page.url()).not.toContain("/sign-in");

    const userMenuBtn = page.locator('button[aria-label="قائمة الحساب"]');
    await expect(userMenuBtn).toBeVisible({ timeout: 10_000 });

    // c. Keep the SAME browser context and cookies.
    // d. Revoke session server-side in the disposable DB.
    const activeDbSession = await db.session.findFirst({
      where: { userId: user.id },
    });
    expect(activeDbSession).toBeTruthy();
    await db.session.delete({ where: { id: activeDbSession!.id } });

    // e. Visit "/" and direct "/sign-in"; navigation must terminate at a usable form without cycle
    let revocationRedirectHops = 0;
    const countRevocationHop = (res: any) => {
      if ([301, 302, 307, 308].includes(res.status())) revocationRedirectHops++;
    };
    page.on("response", countRevocationHop);

    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 15_000 });
    page.off("response", countRevocationHop);

    expect(page.url()).toContain("/sign-in");
    expect(revocationRedirectHops).toBeLessThanOrEqual(3);

    // Direct /sign-in also terminates at the form
    await page.goto("/sign-in", {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    expect(page.url()).toContain("/sign-in");

    await expect(emailInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(submitBtn).toBeVisible();

    // f. Submit valid credentials through the UI in the SAME browser context
    await emailInput.fill(testEmail);
    await passwordInput.fill(testPassword);
    await submitBtn.click();

    // g. Verify protected page actually loads with the authenticated identity
    await page.waitForURL((u) => !u.pathname.includes("/sign-in"), {
      timeout: 15_000,
      waitUntil: "domcontentloaded",
    });
    expect(page.url()).not.toContain("/sign-in");
    await expect(userMenuBtn).toBeVisible({ timeout: 10_000 });

    // h. Repeat recovery path with controlled session expiration
    const freshDbSession = await db.session.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(freshDbSession).toBeTruthy();

    // Expire the session in the past
    await db.session.update({
      where: { id: freshDbSession!.id },
      data: { expiresAt: new Date(Date.now() - 3600_000) },
    });

    // In the SAME browser context, visit "/"
    let expirationRedirectHops = 0;
    const countExpirationHop = (res: any) => {
      if ([301, 302, 307, 308].includes(res.status())) expirationRedirectHops++;
    };
    page.on("response", countExpirationHop);

    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 15_000 });
    page.off("response", countExpirationHop);

    expect(page.url()).toContain("/sign-in");
    expect(expirationRedirectHops).toBeLessThanOrEqual(3);

    // Form is usable
    await expect(emailInput).toBeVisible();
    await expect(passwordInput).toBeVisible();

    // Recover again via UI
    await emailInput.fill(testEmail);
    await passwordInput.fill(testPassword);
    await submitBtn.click();

    await page.waitForURL((u) => !u.pathname.includes("/sign-in"), {
      timeout: 15_000,
      waitUntil: "domcontentloaded",
    });
    expect(page.url()).not.toContain("/sign-in");
    await expect(userMenuBtn).toBeVisible({ timeout: 10_000 });
  });
});
