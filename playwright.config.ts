import { defineConfig } from "@playwright/test";

/**
 * FlowPilot Playwright Configuration (DEVOPS-01 UX QA Gate)
 *
 * Requirements:
 * - 320px mobile (iPhone SE / small mobile)
 * - 390px mobile (iPhone 12/13/14 / Android standard)
 * - 768px tablet (iPad / Tablet)
 * - 1280px desktop (Desktop standard)
 * - Arabic RTL assertion & horizontal overflow checks
 * - Console error & network failure capture
 * - Screenshots and Playwright traces on failure
 */

const PORT = process.env.PORT || 3099;
const BASE_URL =
  process.env.PLAYWRIGHT_TEST_BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: process.env.PLAYWRIGHT_PREVIEW_URL?.trim()
    ? []
    : ["**/preview-auth-qa.spec.ts"],
  timeout: 30_000,
  expect: {
    timeout: 5000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report/html" }],
    ["json", { outputFile: "playwright-report/playwright-results.json" }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "mobile-320",
      use: {
        browserName: "chromium",
        viewport: { width: 320, height: 568 },
        isMobile: true,
      },
    },
    {
      name: "mobile-360",
      use: {
        browserName: "chromium",
        viewport: { width: 360, height: 640 },
        isMobile: true,
      },
    },
    {
      name: "mobile-390",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
      },
    },
    {
      name: "tablet-768",
      use: {
        browserName: "chromium",
        viewport: { width: 768, height: 1024 },
      },
    },
    {
      name: "desktop-1280",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: process.env.PLAYWRIGHT_TEST_BASE_URL
    ? undefined
    : {
        command: `pnpm start -p ${PORT}`,
        url: `http://localhost:${PORT}/api/health`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
