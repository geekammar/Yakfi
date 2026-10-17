#!/usr/bin/env node
// FlowPilot resolve-preview-url.mjs
// Dynamically resolves the Vercel Preview URL for the current PR and commit.
// Verifies deployment health and commit SHA before passing to Playwright.
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const MAX_WAIT_SECONDS = 90;
const POLL_INTERVAL_MS = 5000;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyPreviewHealth(url, expectedSha) {
  try {
    const healthUrl = `${url.replace(/\/+$/, "")}/api/health`;
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "ok" || !data.deploymentReady) return null;
    if (expectedSha && data.commitSha && data.commitSha !== expectedSha) {
      console.log(
        `⏳ Preview deployed commit (${data.commitSha.slice(0, 7)}) does not match expected PR head (${expectedSha.slice(0, 7)}) yet...`,
      );
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

async function fetchPrComments(repo, prNumber, token) {
  if (token) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "flowpilot-preview-resolver",
          },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // Fall through to gh cli
    }
  }

  try {
    const out = execSync(`gh api repos/${repo}/issues/${prNumber}/comments`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

async function main() {
  console.log("🔍 Resolving dynamic Vercel Preview deployment URL...");

  const repo = process.env.GITHUB_REPOSITORY || "geekammar/flowpilot";
  const prNumber =
    process.env.PR_NUMBER ||
    process.env.GITHUB_EVENT_PULL_REQUEST_NUMBER ||
    (process.env.GITHUB_REF?.match(/refs\/pull\/(\d+)\//)?.[1] ?? null);
  const headSha =
    process.env.HEAD_SHA ||
    process.env.GITHUB_SHA ||
    process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA ||
    null;
  const token = process.env.GITHUB_TOKEN || null;

  // 1. If PLAYWRIGHT_PREVIEW_URL is explicitly given, verify it
  const explicitUrl = process.env.PLAYWRIGHT_PREVIEW_URL?.trim();
  if (explicitUrl) {
    console.log(
      `ℹ️  Checking explicitly configured preview URL: ${explicitUrl}`,
    );
    const health = await verifyPreviewHealth(explicitUrl, headSha);
    if (health) {
      console.log(`✅ Preview verified healthy (commit: ${health.commitSha})`);
      if (process.env.GITHUB_ENV) {
        appendFileSync(
          process.env.GITHUB_ENV,
          `PLAYWRIGHT_PREVIEW_URL=${explicitUrl}\n`,
        );
      }
      return;
    }
    console.warn(
      `⚠️ Explicit preview URL did not pass health check. Attempting dynamic PR resolution...`,
    );
  }

  if (!prNumber) {
    console.error(
      "❌ Could not determine PR number. Set PR_NUMBER or PLAYWRIGHT_PREVIEW_URL.",
    );
    process.exit(1);
  }

  console.log(
    `📋 Repository: ${repo}, PR #${prNumber}, Head SHA: ${headSha ? headSha.slice(0, 7) : "any"}`,
  );

  const startTime = Date.now();
  let resolvedUrl = null;

  while ((Date.now() - startTime) / 1000 < MAX_WAIT_SECONDS) {
    const comments = await fetchPrComments(repo, prNumber, token);
    if (Array.isArray(comments)) {
      const vercelComments = comments
        .filter(
          (c) =>
            c.user &&
            (c.user.login === "vercel[bot]" || c.user.login === "vercel"),
        )
        .reverse();

      for (const comment of vercelComments) {
        const body = comment.body || "";
        // Match flowpilot-prod preview URL pattern
        const prodMatch = body.match(
          /https:\/\/flowpilot-prod-git-[a-zA-Z0-9_\-\.]+\.vercel\.app/i,
        );
        if (prodMatch) {
          const candidateUrl = prodMatch[0];
          const health = await verifyPreviewHealth(candidateUrl, headSha);
          if (health) {
            resolvedUrl = candidateUrl;
            console.log(
              `✅ Resolved active Vercel Preview URL: ${resolvedUrl} (commit: ${health.commitSha})`,
            );
            break;
          }
        }
      }
    }

    if (resolvedUrl) break;

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(
      `⏳ Waiting for Vercel Preview deployment to be ready... (${elapsed}s elapsed)`,
    );
    await sleep(POLL_INTERVAL_MS);
  }

  if (!resolvedUrl) {
    console.error(
      `❌ Failed to dynamically resolve a healthy Vercel Preview URL within ${MAX_WAIT_SECONDS}s.`,
    );
    console.error(
      "Ensure Vercel preview deployment has completed for PR #" +
        prNumber +
        ".",
    );
    process.exit(1);
  }

  if (process.env.GITHUB_ENV) {
    appendFileSync(
      process.env.GITHUB_ENV,
      `PLAYWRIGHT_PREVIEW_URL=${resolvedUrl}\n`,
    );
    console.log(`📌 Exported PLAYWRIGHT_PREVIEW_URL to GITHUB_ENV`);
  }
}

main().catch((err) => {
  console.error("❌ Fatal error resolving preview URL:", err);
  process.exit(1);
});
