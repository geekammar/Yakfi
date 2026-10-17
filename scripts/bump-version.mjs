#!/usr/bin/env node
// FlowPilot bump-version.mjs — Automated version bump utility (DEVOPS-01D)
// Increments SemVer in package.json to prepare releases inside the PR before merge.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const bumpType = (process.argv[2] || "patch").toLowerCase();
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error("Usage: node scripts/bump-version.mjs [patch|minor|major]");
  process.exit(1);
}

const pkgPath = resolve(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const currentVersion = pkg.version;

let baseVersion = currentVersion;
try {
  const mainPkgRaw = execSync("git show origin/main:package.json", {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"],
  });
  const mainVer = JSON.parse(mainPkgRaw).version;
  const [cMaj, cMin, cPat] = currentVersion.split(".").map(Number);
  const [mMaj, mMin, mPat] = mainVer.split(".").map(Number);
  const isCurrentGreater =
    cMaj > mMaj ||
    (cMaj === mMaj && (cMin > mMin || (cMin === mMin && cPat > mPat)));
  if (!isCurrentGreater) {
    baseVersion = mainVer;
  }
} catch {
  // If origin/main is not fetched or available, baseVersion remains currentVersion
}

const [major, minor, patch] = baseVersion.split(".").map(Number);
let nextVersion;
if (bumpType === "major") {
  nextVersion = `${major + 1}.0.0`;
} else if (bumpType === "minor") {
  nextVersion = `${major}.${minor + 1}.0`;
} else {
  nextVersion = `${major}.${minor}.${patch + 1}`;
}

pkg.version = nextVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

try {
  execSync("pnpm prettier --write package.json", { stdio: "inherit" });
} catch {
  // fallback if prettier fails
}

console.log(
  `🚀 Version bumped: v${currentVersion} → v${nextVersion} (${bumpType})`,
);
