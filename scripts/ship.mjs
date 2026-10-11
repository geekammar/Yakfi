#!/usr/bin/env node
// FlowPilot ship — lightweight operator release path (DECISIONS #26), gated
// by the canonical pre-ship contract (PROMPT-OPS-REL-01).
//
// SHIP OWNS THE RELEASE COMMIT. The human implementation ends as a
// working-tree release candidate; pre-ship certifies THAT candidate; ship then
// commits it. A non-clean working tree is therefore expected, not a failure.
// What ship refuses is a candidate that is not exactly the one pre-ship
// reviewed.
//
// For routine shipping after a finished prompt: the canonical pre-ship gate
// (`pnpm pre-ship`, scripts/pre-ship.mjs) MUST pass first — it composes git
// baseline + exact release candidate + `git diff --check` + `pnpm security` +
// `pnpm check:ai-prompts` + `pnpm verify` and detects high-risk release
// surfaces. Only then: version bump → `git add -A` → one conventional commit
// (pre-commit hook stays active) → annotated tag vX.Y.Z → push main + tag →
// published GitHub Release. Ship never deploys and never touches the database.
// The full gated path (`pnpm release`, DECISIONS #18) is unchanged for
// recovery / high-confidence releases.
//
// Usage:
//   pnpm ship patch               0.14.0 → 0.14.1   commit: fix: release …
//   pnpm ship minor               0.14.0 → 0.15.0   commit: feat: release …
//   pnpm ship --version 0.14.0    explicit target (must be > current)
//   pnpm ship patch --ack-manual-review   proceed after a human reviewed a
//                                        MANUAL_RELEASE_REVIEW_REQUIRED diff
//   pnpm ship --help
//
// Safety: main-branch only; refuses an empty candidate, an ambiguous baseline
// (unmerged paths / a merge-rebase in progress / origin/main ahead), existing
// tags (local + origin), major bumps, and non-fast-forward pushes; no force
// flags anywhere; a failure after a successful push prints the exact manual
// recovery command. The pre-ship gate runs before ANY mutation — package.json
// and git state are untouched if it blocks. After `git add -A`, ship re-proves
// the staged release is exactly the reviewed candidate plus the version-bump
// delta, and nothing else.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DECISIONS,
  resolveRoot,
  runPreShipGate,
  snapshotCandidate,
  verifyReleaseStage,
} from "./pre-ship-lib.mjs";

const root = resolveRoot();
const pkgPath = join(root, "package.json");
const BUILD_STATE = join(root, "docs", "BUILD_STATE.md");

const USAGE = `FlowPilot ship — lightweight operator release

Usage:
  pnpm ship patch               bump patch   (0.14.0 → 0.14.1)
  pnpm ship minor               bump minor   (0.14.0 → 0.15.0)
  pnpm ship --version 0.14.0    explicit version (must be > current)
  pnpm ship patch --ack-manual-review   proceed after manually reviewing a
                                MANUAL_RELEASE_REVIEW_REQUIRED diff
  pnpm ship help                this help (pnpm intercepts --help;
                               pnpm run ship --help also works)

First runs the canonical pre-ship gate (pnpm pre-ship): git baseline +
exact release candidate + git diff --check + pnpm security +
pnpm check:ai-prompts + pnpm verify + non-mutation witness. If it blocks,
ship exits BEFORE touching package.json or git state. A
MANUAL_RELEASE_REVIEW_REQUIRED diff (schema/migration, auth/security, release
tooling, deploy config, env contract) additionally requires
--ack-manual-review (an acknowledgement never bypasses a failed mandatory
gate).

Then: version bump → git add -A → re-prove the staged release is exactly the
reviewed candidate + the version-bump delta → one conventional commit
(pre-commit hook active) → annotated tag v<version> → push main + tag →
published GitHub Release. Ship never deploys and never touches the database.

Full gated path (gh auth → doctor → verify → security): pnpm release
See docs/RELEASE_PROCESS.md → Lightweight Operator Ship.`;

// ── helpers ──────────────────────────────────────────────────────────────────
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
};

const fail = (msg, hint) => {
  console.error(`\n✗ ${msg}`);
  if (hint) console.error(`  → ${hint}`);
  process.exit(1);
};

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);
const step = (n, label) => console.log(`\n[${n}/7] ${label}`);

// ── version math ─────────────────────────────────────────────────────────────
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const parseVersion = (v) => v.split(".").map(Number);
const compareVersions = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};

// ── argument parsing ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

let bumpKind = null; // "patch" | "minor" | null (explicit version)
let explicitVersion = null;
const ackManualReview = args.includes("--ack-manual-review");
const positional = args.filter((a) => a !== "--ack-manual-review");

if (positional.length === 0) {
  console.error(USAGE);
  process.exit(1);
} else if (positional[0] === "--version") {
  if (positional.length !== 2) {
    fail(
      "--version requires exactly one value: pnpm ship --version 0.14.0",
      "or use a bare version: pnpm ship 0.14.0",
    );
  }
  explicitVersion = positional[1];
  if (!VERSION_RE.test(explicitVersion)) {
    fail(`invalid version "${explicitVersion}" — expected X.Y.Z (e.g. 0.14.0)`);
  }
} else if (positional.length !== 1) {
  fail(`unexpected arguments: ${positional.join(" ")}`, USAGE);
} else if (positional[0] === "patch" || positional[0] === "minor") {
  bumpKind = positional[0];
} else if (positional[0] === "major") {
  fail(
    "major bumps are not supported by pnpm ship — only patch and minor are allowed (pre-1.0; see docs/RELEASE_PROCESS.md → Versioning)",
    "for a major release, make an operator decision first, then use the full gated path: pnpm release",
  );
} else if (VERSION_RE.test(positional[0])) {
  explicitVersion = positional[0];
} else {
  fail(
    `unknown bump type "${positional[0]}" — use: pnpm ship patch | pnpm ship minor | pnpm ship --version X.Y.Z`,
  );
}

// ── pre-flight: git, branch, package.json version ────────────────────────────
if (!run("git", ["--version"]).ok) {
  fail("git is not available on PATH");
}
if (!run("git", ["rev-parse", "--is-inside-work-tree"]).ok) {
  fail("not inside a git repository — run ship from the FlowPilot repository");
}

// branch is read for the plan below; the canonical pre-ship gate (step 1)
// validates branch=main / baseline / release candidate — ship no longer
// duplicates that logic.
const branch = run("git", ["branch", "--show-current"]).stdout;

if (!existsSync(pkgPath)) {
  fail("package.json not found — run ship from the FlowPilot repository");
}

let pkgRaw;
let currentVersion;
try {
  pkgRaw = readFileSync(pkgPath, "utf8");
  currentVersion = JSON.parse(pkgRaw).version;
} catch {
  fail("package.json could not be read or is not valid JSON");
}
if (typeof currentVersion !== "string" || !VERSION_RE.test(currentVersion)) {
  fail(
    `package.json version is not a valid X.Y.Z version: ${JSON.stringify(currentVersion)}`,
  );
}

const parseCurrent = parseVersion(currentVersion);
let targetVersion;
if (explicitVersion) {
  targetVersion = explicitVersion;
  if (compareVersions(parseVersion(explicitVersion), parseCurrent) <= 0) {
    fail(
      `target version ${explicitVersion} must be greater than the current package.json version ${currentVersion}`,
      "never move a version backwards; if package.json is stale after an interrupted ship, restore it first: git checkout -- package.json",
    );
  }
} else {
  const [maj, min, pat] = parseCurrent;
  targetVersion =
    bumpKind === "patch" ? `${maj}.${min}.${pat + 1}` : `${maj}.${min + 1}.0`;
}
const targetTag = `v${targetVersion}`;
const commitType =
  bumpKind === "patch" ||
  (explicitVersion && parseVersion(explicitVersion)[2] > 0)
    ? "fix"
    : "feat";
const commitMessage = `${commitType}: release ${targetTag}`;

// ── release context (titles/notes come only from real repo data) ─────────────
const deriveTitle = () => {
  if (existsSync(BUILD_STATE)) {
    const m = /^>\s*Last updated:\s*(.+?)\s*$/m.exec(
      readFileSync(BUILD_STATE, "utf8"),
    );
    if (m) {
      let t = m[1].replace(/\.$/, "");
      const inner = /^PROMPT-[\d.]+\s*\((.+)\)$/i.exec(t);
      if (inner) t = inner[1];
      t = t.trim();
      if (t) return t.length > 64 ? `${t.slice(0, 61)}…` : t;
    }
  }
  return bumpKind ? `${bumpKind} release` : "release";
};

const previousTag = () => {
  const r = run("git", ["describe", "--tags", "--abbrev=0"]);
  return r.ok ? r.stdout : null;
};

const capLines = (lines, max) =>
  lines.length <= max
    ? lines
    : [...lines.slice(0, max), `- … and ${lines.length - max} more`];

const buildNotes = (title, prevTag) => {
  const logArgs = ["log", "--format=- %s (%h)"];
  if (prevTag) logArgs.push(`${prevTag}..HEAD`);
  else logArgs.push("-n", "15");
  const commits = capLines(
    run("git", logArgs).stdout.split("\n").filter(Boolean),
    15,
  );
  const diffArgs = ["diff", "--name-only"];
  if (prevTag) diffArgs.push(`${prevTag}..HEAD`);
  else diffArgs.push("HEAD^", "HEAD");
  const fileCount = run("git", diffArgs)
    .stdout.split("\n")
    .filter(Boolean).length;
  return [
    `## FlowPilot ${targetTag} — ${title}`,
    "",
    `Shipped with \`pnpm ship\` (${bumpKind ?? "explicit version"} bump) after the canonical pre-ship gate (\`pnpm pre-ship\`: git baseline + exact release candidate + diff --check + security + ai-prompts + verify) passed and ship re-proved the staged release was exactly that candidate plus the version bump.`,
    "",
    `Commits since ${prevTag ?? "the beginning of history"}:`,
    ...commits,
    "",
    `Changed files in this range: ${fileCount}.`,
    "",
    "Current state and known limitations: `docs/BUILD_STATE.md`.",
  ].join("\n");
};

// ── plan ─────────────────────────────────────────────────────────────────────
console.log("FlowPilot ship — lightweight operator release\n");
console.log("Release:");
console.log(`  current:  v${currentVersion}`);
console.log(`  target:   v${targetVersion}`);
console.log(`  tag:      ${targetTag}`);
console.log(`  branch:   ${branch}`);

// ── [1/7] release candidate + canonical pre-ship gate (before ANY mutation) ──
// The single repository-owned release gate (scripts/pre-ship-lib.mjs), the
// same one `pnpm pre-ship` runs. If it blocks, ship exits here — package.json
// and git state are still untouched.
step(1, "Release candidate + pre-ship gate (canonical — pnpm pre-ship)");

// Discover the exact candidate this release would commit BEFORE the gate runs,
// so the gate's own snapshot can be cross-checked against it (contract D).
const candidateBeforeGate = snapshotCandidate(root);
if (candidateBeforeGate.count === 0) {
  fail(
    "no release candidate — the working tree is identical to HEAD, so there is nothing to release",
    "finish the intended change first, then: pnpm pre-ship",
  );
}
console.log(
  `  candidate: ${candidateBeforeGate.count} path(s), fingerprint ${candidateBeforeGate.fingerprint.slice(0, 12)}`,
);

const gate = runPreShipGate(root);
for (const g of gate.gates) {
  const icon = g.status === "PASS" ? "✓" : g.status === "FAIL" ? "✗" : "·";
  const secs = g.seconds ? ` ${g.seconds}s` : "";
  const detail = g.detail ? ` — ${g.detail.slice(0, 100)}` : "";
  console.log(`  ${icon} ${g.label.padEnd(14)} ${g.status}${secs}${detail}`);
}
for (const s of gate.risk.high)
  warn(`HIGH risk surface: ${s.label} — ${s.files.join(", ")}`);
for (const s of gate.risk.elevated)
  console.log(
    `  elevated surface: ${s.label} → review with: ${s.checks.join(", ")}`,
  );

if (gate.decision === DECISIONS.BLOCKED) {
  for (const g of gate.gates.filter((g) => g.status === "FAIL" && g.output)) {
    console.error(`\n── ${g.label} output ──────────────────────`);
    console.error(g.output.split("\n").slice(-40).join("\n"));
  }
  fail(
    "PRE_SHIP_BLOCKED — the canonical pre-ship gate failed; nothing was changed",
    gate.nextAction.split("\n")[0],
  );
}
if (gate.decision === DECISIONS.MANUAL && !ackManualReview) {
  for (const s of gate.risk.high) console.error(`  • ${s.label}: ${s.routing}`);
  fail(
    "MANUAL_RELEASE_REVIEW_REQUIRED — a high-risk release surface changed and the machine cannot certify it",
    "review the surfaces above, then re-run ship with --ack-manual-review (e.g. pnpm ship patch --ack-manual-review)",
  );
}
if (gate.decision === DECISIONS.MANUAL) {
  warn(
    "MANUAL_RELEASE_REVIEW_REQUIRED acknowledged by the operator (--ack-manual-review) — proceeding",
  );
}

// The candidate ship is about to release must be the exact candidate the gate
// just certified (contract D). An acknowledgement never licenses a different
// tree than the one the human reviewed.
if (gate.candidate.fingerprint !== candidateBeforeGate.fingerprint) {
  fail(
    "RELEASE CANDIDATE DRIFT — the candidate changed between discovery and the gate; nothing was changed",
    "re-run pnpm pre-ship and review the current candidate, then re-run ship",
  );
}
ok(
  `candidate fingerprint matches the reviewed candidate (${gate.candidate.count} path(s))`,
);
ok(
  gate.decision === DECISIONS.GREEN
    ? "pre-ship gate green — safe to release"
    : "pre-ship gate passed with manual review acknowledged",
);

// ── [2/7] validate publish context (network + tag availability) ──────────────
step(2, "Validate publish context");

if (run("git", ["rev-parse", "-q", "--verify", `refs/tags/${targetTag}`]).ok) {
  fail(
    `tag ${targetTag} already exists locally — never move an existing tag`,
    "choose a different version (patch/minor bumps always produce a fresh one)",
  );
}
ok(`tag ${targetTag} is free locally`);

const origin = run("git", ["remote", "get-url", "origin"]);
if (!origin.ok) {
  fail(
    "origin remote is not configured — ship only publishes to an existing origin",
    "initial repository setup is done by the full path: pnpm release (scripts/release.sh)",
  );
}

const remoteTag = run("git", [
  "ls-remote",
  "--tags",
  "origin",
  `refs/tags/${targetTag}`,
]);
if (!remoteTag.ok) {
  fail(
    "could not query origin for existing tags (network / auth problem)",
    "check connectivity and the remote URL, then re-run ship",
  );
}
if (remoteTag.stdout) {
  fail(
    `tag ${targetTag} already exists on origin — never move an existing tag`,
    "choose a different version, or delete the remote release/tag deliberately (docs/RELEASE_PROCESS.md → Rollback / Recovery)",
  );
}
ok(`tag ${targetTag} is free on origin`);

const remoteMain = run("git", ["ls-remote", "origin", "refs/heads/main"]);
if (!remoteMain.ok) {
  fail("could not query origin/main (network / auth problem)");
}
if (remoteMain.stdout) {
  const remoteSha = remoteMain.stdout.split("\t")[0];
  const ancestor = run("git", [
    "merge-base",
    "--is-ancestor",
    remoteSha,
    "HEAD",
  ]);
  if (!ancestor.ok) {
    fail(
      "origin/main has commits that are not in local main — pushing would be rejected",
      "git pull --rebase origin main, resolve, then re-run ship (never force-push)",
    );
  }
  ok("origin/main is an ancestor of local main (push will fast-forward)");
} else {
  warn("origin/main does not exist yet — the push will create it");
}

if (!run("gh", ["--version"]).ok) {
  fail("gh CLI is not installed — see https://cli.github.com/");
}
if (!run("gh", ["auth", "status"]).ok) {
  fail(
    "not authenticated with GitHub",
    "gh auth login  (GitHub.com → HTTPS → browser), then re-run ship",
  );
}
if (!run("gh", ["repo", "view", "--json", "name"]).ok) {
  fail(
    "gh cannot access the origin repository (auth / scopes / visibility)",
    "check gh auth status and the repository visibility, then re-run ship",
  );
}
ok("gh authenticated with repository access");

if (!run("git", ["config", "core.hooksPath"]).stdout) {
  warn(
    "pre-commit hook is not installed (core.hooksPath unset) — run: pnpm run hooks:install",
  );
}

const latestTag = previousTag();
if (latestTag && latestTag !== `v${currentVersion}`) {
  warn(
    `latest tag ${latestTag} ≠ package.json version ${currentVersion} — proceeding; verify the target above is intended`,
  );
}

// ── [3/7] version bump ───────────────────────────────────────────────────────
step(3, "Version bump");
const versionLine = /^(\s*"version"\s*:\s*")(\d+\.\d+\.\d+)(")/m;
if (!versionLine.test(pkgRaw)) {
  fail('could not locate the "version" field in package.json');
}
writeFileSync(pkgPath, pkgRaw.replace(versionLine, `$1${targetVersion}$3`));
console.log(
  `  package.json: "version": "${currentVersion}" → "${targetVersion}"`,
);

// ── [4/7] commit ─────────────────────────────────────────────────────────────
step(4, "Commit");
const add = run("git", ["add", "-A"]);
if (!add.ok) {
  writeFileSync(pkgPath, pkgRaw);
  fail("git add failed — the version bump was rolled back", add.stderr);
}
const stagedFiles = run("git", ["diff", "--cached", "--name-only"])
  .stdout.split("\n")
  .filter(Boolean);

// The release-mutation seam: the staged release must be EXACTLY the candidate
// the canonical gate reviewed, plus the version-bump delta in package.json —
// no more, no less. Verified with the same canonical module that fingerprinted
// the candidate, so no path (including an untracked one) can be swept in here.
const exact = verifyReleaseStage(
  root,
  gate.candidate,
  stagedFiles,
  pkgRaw,
  targetVersion,
);
if (!exact.ok) {
  writeFileSync(pkgPath, pkgRaw);
  for (const problem of exact.problems) console.error(`  ✗ ${problem}`);
  fail(
    "the staged release is not exactly the reviewed candidate + version bump — the version bump was rolled back; no commit, no tag, no push, no release",
    "re-run pnpm pre-ship on the current candidate, then re-run ship",
  );
}
ok("staged release is exactly the reviewed candidate + version bump");

if (stagedFiles.length === 0) {
  writeFileSync(pkgPath, pkgRaw);
  fail(
    "nothing to commit — a release needs the candidate (or at least the version bump)",
    "this should not happen; if it does, inspect: git status",
  );
}
console.log(`  files to be committed (${stagedFiles.length}):`);
for (const file of capLines(stagedFiles, 50)) console.log(`    ${file}`);

const commit = run("git", ["commit", "-m", commitMessage]);
if (!commit.ok) {
  writeFileSync(pkgPath, pkgRaw);
  run("git", ["add", pkgPath]);
  if (commit.stdout || commit.stderr)
    console.error(commit.stdout || commit.stderr);
  fail(
    "commit failed — the version bump was rolled back; staged prompt changes are untouched; no tag, no push, no release",
    "the pre-commit hook or git rejected the commit (see output above)",
  );
}
const sha = run("git", ["rev-parse", "--short", "HEAD"]).stdout;
ok(`committed ${sha} — ${commitMessage}`);

// ── [5/7] annotated tag ──────────────────────────────────────────────────────
step(5, "Annotated tag");
const title = deriveTitle();
const tagMessage = `FlowPilot ${targetTag} — ${title}`;
const tag = run("git", ["tag", "-a", targetTag, "-m", tagMessage]);
if (!tag.ok) {
  if (tag.stderr) console.error(tag.stderr);
  fail(
    "tag creation failed — the release commit exists locally, but nothing was pushed",
    `recovery: git tag -a ${targetTag} -m "${tagMessage}" && git push origin main && git push origin ${targetTag} && gh release create ${targetTag} --verify-tag --title "${tagMessage}" --notes "…"`,
  );
}
ok(`${targetTag} — "${tagMessage}"`);

// ── [6/7] push ───────────────────────────────────────────────────────────────
step(6, "Push");
const pushMain = run("git", ["push", "origin", "main"]);
if (!pushMain.ok) {
  if (pushMain.stderr) console.error(pushMain.stderr);
  fail(
    "push of main failed — the commit and tag exist locally only; nothing was published",
    `recovery: fix the cause above, then: git push origin main && git push origin ${targetTag} && gh release create ${targetTag} --verify-tag
if main was rejected as non-fast-forward: git tag -d ${targetTag} && git pull --rebase origin main && git tag -a ${targetTag} -m "${tagMessage}" && git push origin main && git push origin ${targetTag} (never force-push)`,
  );
}
ok("origin main updated");

const pushTag = run("git", ["push", "origin", targetTag]);
if (!pushTag.ok) {
  if (pushTag.stderr) console.error(pushTag.stderr);
  fail(
    `push of ${targetTag} failed — main IS already published; the tag is not`,
    `recovery: git push origin ${targetTag} && gh release create ${targetTag} --verify-tag --title "${tagMessage}" --notes "…"`,
  );
}
ok(`origin ${targetTag} pushed`);

// ── [7/7] GitHub Release ─────────────────────────────────────────────────────
step(7, "GitHub Release");
const notes = buildNotes(title, latestTag);
const releaseTitle = tagMessage;
if (run("gh", ["release", "view", targetTag]).ok) {
  warn(`GitHub Release for ${targetTag} already exists — skipping creation`);
} else {
  const release = run("gh", [
    "release",
    "create",
    targetTag,
    "--verify-tag",
    "--title",
    releaseTitle,
    "--notes",
    notes,
  ]);
  if (!release.ok) {
    if (release.stderr) console.error(release.stderr);
    fail(
      "GitHub Release creation failed — the commit and tag are ALREADY published on origin",
      `manual recovery: gh release create ${targetTag} --verify-tag --title "${releaseTitle}" --notes "<notes>"`,
    );
  }
}
const releaseUrl = run("gh", [
  "release",
  "view",
  targetTag,
  "--json",
  "url",
  "--jq",
  ".url",
]).stdout;
ok(`published: ${releaseTitle}`);
if (releaseUrl) console.log(`  ${releaseUrl}`);

// ── summary ──────────────────────────────────────────────────────────────────
console.log("\nSHIP COMPLETE\n");
console.log(`Version: ${targetTag}`);
console.log(`Commit: ${sha}`);
console.log(`Tag: ${targetTag}`);
console.log("GitHub Release: published");
