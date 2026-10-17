import { execFileSync } from "node:child_process";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * FlowPilot — Booking Invariants & Provider Flow QA (DEVOPS-01 Phase E)
 *
 * Verifies core booking scenarios required by DEVOPS-01 Section 8:
 * - Zero-provider setup (must not report false full; reports setup required / NO_ELIGIBLE_PROVIDERS)
 * - One-provider automatic assignment (auto-assigned, selection hidden)
 * - Multiple-provider selection (independent availability)
 * - Correct appointment availability (conflict rejection, capacity)
 * - Staff and provider management invariants
 * - Service exclusions
 * - Confirmation flow
 */

test.describe("Booking Invariants & Provider Flow QA", () => {
  test("Unified Provider-Aware Booking Contract (check:booking-modes)", async () => {
    // Run the canonical booking modes check suite verifying 18/18 provider-aware requirements
    const scriptPath = path.join(
      process.cwd(),
      "scripts",
      "check-booking-modes.ts",
    );
    const output = execFileSync("pnpm", ["exec", "tsx", scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://user:password@localhost:5432/placeholder",
        BETTER_AUTH_SECRET: "0".repeat(32),
        BETTER_AUTH_URL: "http://localhost:3000",
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      },
    });

    expect(output).toContain("اكتمال الفحوصات: 18/18 فحص ناجح بنسبة 100%");
    expect(output).toContain("1. إنشاء منشأة بلا مزودين");
    expect(output).toContain(
      "4. انعدام المزودين لا يعيد أبداً FULLY_BOOKED زائفاً",
    );
    expect(output).toContain(
      "5. مزود وحيد مؤهل: يتم تعيينه تلقائياً للموعد من السيرفر",
    );
    expect(output).toContain("7. مزودان: إتاحة مستقلة لكل مزود");
    expect(output).toContain(
      "8. نفس المزود: رفض الحجز المتداخل في نفس الوقت (SLOT_CONFLICT)",
    );
    expect(output).toContain(
      "9. مزودان مختلفان: السماح بالحجز المتزامن في نفس الوقت",
    );
  });

  test("Booking Options & Deterministic Ranking (check:booking-options)", async () => {
    const scriptPath = path.join(
      process.cwd(),
      "scripts",
      "check-booking-options.ts",
    );
    const output = execFileSync("pnpm", ["exec", "tsx", scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://user:password@localhost:5432/placeholder",
        BETTER_AUTH_SECRET: "0".repeat(32),
      },
    });

    expect(output).toContain("32/32 فحص ناجح");
  });

  test("Staff & Provider Management Invariants (check:staff-provider-01)", async () => {
    const scriptPath = path.join(
      process.cwd(),
      "scripts",
      "check-staff-provider-01.ts",
    );
    const output = execFileSync("pnpm", ["exec", "tsx", scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://user:password@localhost:5432/placeholder",
        BETTER_AUTH_SECRET: "0".repeat(32),
      },
    });

    expect(output).toContain("PASS");
  });

  test("Booking UX & Friction Audit Invariants (check:booking-ux)", async () => {
    const scriptPath = path.join(
      process.cwd(),
      "scripts",
      "check-booking-ux.ts",
    );
    const output = execFileSync("pnpm", ["exec", "tsx", scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://user:password@localhost:5432/placeholder",
        BETTER_AUTH_SECRET: "0".repeat(32),
      },
    });

    expect(output).toContain("RESULT: PASSED");
  });
});
