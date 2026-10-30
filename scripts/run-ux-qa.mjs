#!/usr/bin/env node
// FlowPilot run-ux-qa.mjs — Automated UX QA runner (DEVOPS-01 Phase E & UX001-R2)
//
// Runs Playwright tests against:
// - 320px mobile
// - 360px mobile
// - 390px mobile
// - 768px tablet
// - 1280px desktop
// Validates Arabic RTL, horizontal overflow, touch-target sizing, booking flows,
// and outputs an accurate, honest machine-readable and human-readable summary.
// Never claims unexecuted or failed scenarios passed.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const reportDir = join(root, "playwright-report");
const screenshotDir = join(reportDir, "screenshots");
const resultsFile = join(reportDir, "playwright-results.json");

if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });

console.log("🚀 Starting FlowPilot Automated UX QA Suite...");
console.log("   - Testing viewports: 320px, 360px, 390px, 768px, 1280px");
console.log(
  `   - Preview URL: ${process.env.PLAYWRIGHT_PREVIEW_URL ? process.env.PLAYWRIGHT_PREVIEW_URL : "Not set (local browser tests only)"}`,
);

const t0 = Date.now();
const playwrightArgs = ["exec", "playwright", "test"];

// Pass through any CLI filter arguments (e.g. --project=mobile-390)
const extraArgs = process.argv.slice(2);
const result = spawnSync("pnpm", [...playwrightArgs, ...extraArgs], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    PORT: process.env.PORT || "3099",
    FLOWPILOT_ENABLE_QA_HARNESS:
      process.env.FLOWPILOT_ENABLE_QA_HARNESS || "true",
  },
});

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const passed = result.status === 0;

// Scan screenshots recursively
function getScreenshots(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getScreenshots(full));
    } else if (entry.name.endsWith(".png")) {
      files.push(full.replace(reportDir + "/", ""));
    }
  }
  return files;
}

const screenshots = getScreenshots(reportDir);

// Parse Playwright json results
let testStats = {
  total: 0,
  expected: 0,
  unexpected: 0,
  skipped: 0,
  flaky: 0,
};

let rawSuites = [];
let topErrors = [];

if (existsSync(resultsFile)) {
  try {
    const jsonContent = JSON.parse(readFileSync(resultsFile, "utf8"));
    if (jsonContent.stats) {
      testStats = {
        total:
          (jsonContent.stats.expected || 0) +
          (jsonContent.stats.unexpected || 0) +
          (jsonContent.stats.skipped || 0) +
          (jsonContent.stats.flaky || 0),
        expected: jsonContent.stats.expected || 0,
        unexpected: jsonContent.stats.unexpected || 0,
        skipped: jsonContent.stats.skipped || 0,
        flaky: jsonContent.stats.flaky || 0,
      };
    }
    if (jsonContent.suites) rawSuites = jsonContent.suites;
    if (jsonContent.errors) topErrors = jsonContent.errors;
  } catch (err) {
    console.warn(
      "⚠️ Warning: could not parse playwright-results.json:",
      err.message,
    );
  }
}

// Flatten specs
function extractSpecs(suites) {
  const specs = [];
  function recurse(s, currentFile = "") {
    const file = s.file || currentFile;
    if (s.specs) {
      for (const spec of s.specs) {
        specs.push({
          title: spec.title,
          file: spec.file || file,
          ok: spec.ok,
          tests: spec.tests || [],
        });
      }
    }
    if (s.suites) {
      for (const child of s.suites) {
        recurse(child, file);
      }
    }
  }
  for (const suite of suites) {
    recurse(suite);
  }
  return specs;
}

const allSpecs = extractSpecs(rawSuites);

// Audit domain contracts based on executed specs
function evaluateContract(specFilter) {
  const matching = allSpecs.filter(specFilter);
  if (matching.length === 0)
    return { ran: false, passed: false, status: "⏭️ SKIPPED" };
  const allOk = matching.every((s) => s.ok);
  return {
    ran: true,
    passed: allOk,
    status: allOk ? "✅ Verified" : "❌ FAILED",
    count: matching.length,
  };
}

const rtlContract = evaluateContract(
  (s) =>
    s.title.toLowerCase().includes("rtl") ||
    s.title.includes("Sign-in") ||
    s.title.includes("Sign-up"),
);

const overflowContract = evaluateContract((s) =>
  s.title.toLowerCase().includes("overflow"),
);

const bookingContract = evaluateContract((s) =>
  s.file.includes("booking-flows.spec.ts"),
);

const previewAuthContract = evaluateContract((s) =>
  s.file.includes("preview-auth-qa.spec.ts"),
);

// Collect failed specs for report
const failedSpecs = allSpecs.filter((s) => !s.ok);

const summary = {
  timestamp: new Date().toISOString(),
  durationSeconds: elapsed,
  passed,
  exitCode: result.status,
  stats: testStats,
  contracts: {
    rtl: rtlContract,
    horizontalOverflow: overflowContract,
    bookingContracts: bookingContract,
    previewAuth: previewAuthContract,
  },
  failedSpecs: failedSpecs.map((s) => ({
    title: s.title,
    file: s.file,
  })),
  errors: topErrors.map((e) => e.message || String(e)),
  screenshotsCount: screenshots.length,
  screenshots,
};

writeFileSync(
  join(reportDir, "ux-summary.json"),
  JSON.stringify(summary, null, 2),
);

const mdSummaryLines = [
  "### 📱 FlowPilot Automated UX QA Report",
  "",
  `- **Status**: ${passed ? "✅ PASSED" : "❌ FAILED"} (exit code: ${result.status})`,
  `- **Execution Time**: ${elapsed}s`,
  `- **Tests**: ${testStats.total} total (${testStats.expected} passed, ${testStats.flaky > 0 ? `${testStats.flaky} flaky, ` : ""}${testStats.unexpected} failed, ${testStats.skipped} skipped)`,
  `- **Arabic RTL Layout**: ${rtlContract.status}`,
  `- **Horizontal Overflow**: ${overflowContract.status}`,
  `- **Booking Provider Contracts**: ${bookingContract.status}`,
  `- **Preview Authenticated QA**: ${previewAuthContract.status}`,
  `- **Screenshots Captured**: ${screenshots.length} visual artifacts`,
  "",
];

if (failedSpecs.length > 0) {
  mdSummaryLines.push("#### ❌ Failed Tests:");
  for (const s of failedSpecs) {
    mdSummaryLines.push(`  - \`${s.file}\` › **${s.title}**`);
  }
  mdSummaryLines.push("");
}

if (topErrors.length > 0) {
  mdSummaryLines.push("#### ⚠️ Runner Errors:");
  for (const err of topErrors) {
    const msg =
      typeof err === "string" ? err : err.message || JSON.stringify(err);
    mdSummaryLines.push(`  - ${msg.split("\n")[0]}`);
  }
  mdSummaryLines.push("");
}

if (screenshots.length > 0) {
  mdSummaryLines.push("#### Visual Artifacts:");
  for (const s of screenshots) {
    mdSummaryLines.push(`  - \`${s}\``);
  }
  mdSummaryLines.push("");
}

const mdSummary = mdSummaryLines.join("\n");
writeFileSync(join(reportDir, "ux-summary.md"), mdSummary);

console.log("\n" + mdSummary);

if (!passed) {
  console.error("❌ UX QA checks failed. Inspect errors above.");
  process.exit(result.status ?? 1);
}

console.log("✅ All executed UX QA checks passed successfully.");
process.exit(0);
