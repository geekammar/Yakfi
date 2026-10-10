/**
 * FlowPilot — Vitest config (UX-LAB-01D-P1 / B2).
 *
 * This exists for exactly one reason: the Copy Lab gate (`pnpm
 * check:copy-lab`) is source/pure-function only, so it could not observe the
 * React lifecycle that produced B1 (an entry stuck in first-open loading with
 * no editor). These tests MOUNT the real component in jsdom instead.
 *
 * Deliberately minimal: no browser stack (no Playwright/Cypress/Puppeteer),
 * no new build pipeline — Vitest transforms the existing TSX with esbuild, and
 * the `@` path alias mirrors `tsconfig.json` so the tests import production
 * code unchanged.
 */
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  esbuild: {
    // The codebase compiles with `jsx: "react-jsx"`; match it so components
    // that only use named React imports transform correctly.
    jsx: "automatic",
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    // Keep Vitest's own globals out of the codebase's type surface; the tests
    // import what they need explicitly.
    globals: false,
    setupFiles: ["./vitest.setup.ts"],
  },
});
