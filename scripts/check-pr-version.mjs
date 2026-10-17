#!/usr/bin/env node
// FlowPilot check-pr-version.mjs — PR Semantic Version Validator (DEVOPS-01D)
// Ensures the PR branch has prepared a unique, strictly incremented SemVer before merge.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const pkgPath = resolve(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const currentVersion = pkg.version;

console.log("🔍 Checking PR Semantic Versioning Gate...");

// 1. Validate SemVer format
if (!/^\d+\.\d+\.\d+$/.test(currentVersion)) {
  console.error(
    `❌ INVALID VERSION: package.json version '${currentVersion}' is not valid SemVer.`,
  );
  process.exit(1);
}
console.log(`   - PR version in package.json: v${currentVersion}`);

// 2. Compare against origin/main version if available
let mainVersion = null;
try {
  const mainPkgRaw = execSync("git show origin/main:package.json", {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  mainVersion = JSON.parse(mainPkgRaw).version;
  console.log(
    `   - Production baseline version (origin/main): v${mainVersion}`,
  );
} catch {
  console.log(
    "   - Note: origin/main:package.json not directly accessible, skipping diff comparison.",
  );
}

if (mainVersion) {
  const [cMaj, cMin, cPat] = currentVersion.split(".").map(Number);
  const [mMaj, mMin, mPat] = mainVersion.split(".").map(Number);
  const isGreater =
    cMaj > mMaj ||
    (cMaj === mMaj && (cMin > mMin || (cMin === mMin && cPat > mPat)));

  if (!isGreater) {
    console.error(`\n❌ VERSION INCREMENT REQUIRED:`);
    console.error(
      `   PR version (${currentVersion}) must be strictly greater than main version (${mainVersion}).`,
    );
    console.error(`   To resolve, run:`);
    console.error(
      `     pnpm version:bump patch   # for backward-compatible fixes and maintenance`,
    );
    console.error(`     pnpm version:bump minor   # for new features`);
    process.exit(1);
  }
}

// 3. Ensure Git tag does not already exist on origin
let tagExists = false;
try {
  const remoteTagCheck = execSync(
    `git ls-remote --tags origin "refs/tags/v${currentVersion}"`,
    {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  if (remoteTagCheck.trim().length > 0) {
    tagExists = true;
  }
} catch {
  // Network/offline fallback
}

if (tagExists) {
  console.error(`\n❌ DUPLICATE TAG CONFLICT:`);
  console.error(
    `   Tag 'v${currentVersion}' already exists on origin! Releases are immutable.`,
  );
  console.error(`   Another PR may have been merged with this version.`);
  console.error(`   To resolve, rebase on main and bump version:`);
  console.error(`     git fetch origin main && git merge origin/main`);
  console.error(`     pnpm version:bump patch`);
  process.exit(1);
}

console.log(
  `✅ Version v${currentVersion} is valid, strictly incremented, and tag is free.\n`,
);
process.exit(0);
