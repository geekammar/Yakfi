import { isQaHarnessAllowed } from "@/lib/qa-harness";

import { AccessibilityRepairsHarness } from "./accessibility-repairs-harness";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "QA — Accessibility & UI Repairs Verification",
};

export default function AccessibilityRepairsPage() {
  if (!isQaHarnessAllowed()) {
    notFound();
  }

  return <AccessibilityRepairsHarness />;
}
