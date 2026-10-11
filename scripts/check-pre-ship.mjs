#!/usr/bin/env node
// FlowPilot pre-ship regression proof (PROMPT-OPS-REL-01, corrected by
// PROMPT-OPS-REL-01-R — release candidate, not clean tree).
//
// Repository-owned, NON-VACUOUS proof that the canonical pre-ship gate and
// the ship integration behave as contracted. It drives the REAL gate engine
// (scripts/pre-ship-lib.mjs), the REAL `pnpm pre-ship` CLI, the REAL
// `pnpm ship` CLI, and the REAL secret scanner (scripts/security-check.mjs,
// copied byte-for-byte into the fixture so the fixture's `pnpm security` runs
// the genuine scanner over the fixture tree) — never a reimplementation of
// their logic — against throwaway fixture repositories created under the OS
// temp dir via the documented FLOWPILOT_RELEASE_ROOT test seam. The real
// working tree is only read (witnessed by R12c).
//
//   pnpm check:pre-ship
//
// The corrected contract under test — the invariant is
// "EXACT, INSPECTED, STABLE RELEASE CANDIDATE", not "clean working tree":
//   R1  an intended modified tracked file is a valid release candidate; a
//       dirty tree is not, by itself, a pre-ship failure
//   R2  a new untracked non-ignored file is part of the candidate and cannot
//       be silently swept into the release by ship's `git add -A`
//   R3  a failing mandatory gate blocks ship before package.json / HEAD /
//       tag / push / release mutation
//   R4  a gate that changes a candidate file is caught by the non-mutation
//       witness and fails closed
//   R5  a HIGH release-tooling candidate → MANUAL_RELEASE_REVIEW_REQUIRED
//   R6  the same HIGH candidate without --ack-manual-review aborts ship
//       before its first mutation
//   R7  with the acknowledgement, ship proceeds past the canonical gate
//       toward its release-mutation seam (stopped there by the offline
//       publish-context validation — no real publish is ever performed)
//   R8  an ambiguous baseline (a non-main branch, divergence, unmerged paths,
//       a pending merge) fails closed
//   R9  the real current OPS-REL-01 candidate reaches the correct review
//       decision (MANUAL_RELEASE_REVIEW_REQUIRED), not PRE_SHIP_BLOCKED
//       merely because intended files are uncommitted
//   R10 the candidate immediately before ship's first mutation is the
//       candidate the gate certified; the staged release is exactly that
//       candidate + the version-bump delta
//   R11 a secret placed in an untracked candidate file is blocked, and the
//       secret value is never printed
//   R12 the baseline guarantees of the old clean-tree proof remain enforced:
//       the gate set stays offline/non-side-effecting (R12a), a tree with no
//       candidate fails closed deterministically instead of silently passing
//       (R12b — the old "clean fixture → GREEN" case is now the degenerate
//       "nothing to release" case, which must never be certified GREEN), and
//       the real working tree is untouched (R12c)
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_GATES,
  DECISIONS,
  candidatePaths,
  classifyRisk,
  collectBaseline,
  git,
  pendingOperation,
  resolveRoot,
  runGates,
  runPreShipGate,
  snapshotCandidate,
  verifyReleaseStage,
} from "./pre-ship-lib.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = resolveRoot(); // real repo (read-only here)

const results = [];
const proof = (name, pass, detail) => results.push({ name, pass, detail });

const runQuiet = (cmd, args, cwd, env = {}) => {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
};

const decisionOf = (stdout) => {
  for (const line of stdout.split("\n"))
    if (/^\s*PRE_SHIP_|MANUAL_RELEASE_REVIEW_REQUIRED/.test(line))
      return line.trim();
  return null;
};

// ── fixture factory ───────────────────────────────────────────────────────────
// A minimal repo whose package.json mirrors the real command names, with the
// expensive gates stubbed. `realSecurity` instead installs the GENUINE
// scripts/security-check.mjs (byte copy) so the fixture's `pnpm security` is
// the real secret scanner over the fixture tree — no reimplementation.
const STUBBED_GATES = ["verify.mjs", "check-ai-prompts.mjs"];

function makeFixture(name, opts = {}) {
  const { gateExit = 0, realSecurity = false } = opts;
  const dir = mkdtempSync(join(tmpdir(), `flowpilot-preship-${name}-`));
  const pkg = {
    name: "flowpilot-fixture",
    version: "0.0.2",
    private: true,
    scripts: {
      verify: "node scripts/verify.mjs",
      security: "node scripts/security-check.mjs",
      "check:ai-prompts": "node scripts/check-ai-prompts.mjs",
    },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  // Mirror the real repo's hygiene so build/runtime artifacts (.next/,
  // tsbuildinfo) stay ignored — the candidate never includes them (R2a).
  writeFileSync(
    join(dir, ".gitignore"),
    "/node_modules\npnpm-lock.yaml\n.next\ntsconfig.tsbuildinfo\nnext-env.d.ts\n",
  );
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.ts"), "export const x = 1;\n");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  for (const f of STUBBED_GATES)
    writeFileSync(join(dir, "scripts", f), `process.exit(${gateExit});\n`);
  if (realSecurity)
    copyFileSync(
      join(SCRIPTS, "security-check.mjs"),
      join(dir, "scripts", "security-check.mjs"),
    );
  else
    writeFileSync(
      join(dir, "scripts", "security-check.mjs"),
      `process.exit(${gateExit});\n`,
    );

  git(["init", "-q", "-b", "main"], dir);
  git(["add", "-A"], dir);
  git(
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      "feat: initial fixture",
    ],
    dir,
  );
  git(["tag", "-a", "v0.0.1", "-m", "fixture v0.0.1"], dir);
  return dir;
}

// Create a candidate file WITHOUT committing it (modified tracked or new
// untracked) — the working-tree release candidate the contract is about.
function writeCandidate(dir, path, content) {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function commitFile(dir, path, content, subject) {
  writeCandidate(dir, path, content);
  git(["add", "-A"], dir);
  git(
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "-m",
      subject,
    ],
    dir,
  );
}

const FIXTURES = [];
const withFixture = (name, opts, fn) => {
  const dir = makeFixture(name, opts);
  FIXTURES.push(dir);
  return Promise.resolve(fn(dir));
};

// ── R12a: the canonical gate set is offline and non-side-effecting ───────────
{
  const FORBIDDEN =
    /(migrate|db:push|db:seed|db:deploy|deploy|vercel|probe:|eval:run|gh\s|release\s+create|git\s+(push|add|commit|tag)|publish|seed|bootstrap)/;
  const cmds = CANONICAL_GATES.filter((g) => g.cmd).map((g) => g.cmd[1][0]);
  const ids = CANONICAL_GATES.map((g) => g.id);
  const expectedIds = [
    "git-state",
    "git-diff-check",
    "security",
    "ai-prompts",
    "verify",
    "candidate-stable",
  ];
  proof(
    "R12a canonical gate set is offline & non-side-effecting",
    cmds.join("|") === "security|check:ai-prompts|verify" &&
      ids.length === expectedIds.length &&
      ids.every((id, i) => id === expectedIds[i]) &&
      !cmds.some((c) => FORBIDDEN.test(c)),
    `gates: ${ids.join(", ")}; composed quality commands: ${cmds.join(", ")} (no migrate/db/deploy/probe/eval/publish/git-write)`,
  );
}

// ── R1: an intended modified tracked file is a valid release candidate ───────
await withFixture("r1-dirty-tracked", { gateExit: 0 }, (dir) => {
  writeCandidate(dir, "src/lib.ts", "export const x = 2;\n"); // modified TRACKED
  const snap = snapshotCandidate(dir);
  const r = runQuiet("node", [join(SCRIPTS, "pre-ship.mjs")], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  const decision = decisionOf(r.stdout);
  proof(
    "R1 modified tracked file is a valid candidate → PRE_SHIP_GREEN",
    r.status === 0 &&
      decision === DECISIONS.GREEN &&
      snap.paths.includes("src/lib.ts"),
    `exit ${r.status}; decision ${decision}; candidate ${JSON.stringify(snap.paths)}`,
  );
});

// ── R2: untracked non-ignored files are in the candidate and cannot escape ───
await withFixture("r2-untracked", { gateExit: 0 }, (dir) => {
  writeCandidate(dir, "src/lib.ts", "export const x = 2;\n"); // tracked change
  writeCandidate(dir, "src/new-feature.ts", "export const y = 3;\n"); // UNTRACKED
  writeCandidate(dir, ".next/server/build.json", "{}\n"); // IGNORED artifact
  writeCandidate(dir, "tsconfig.tsbuildinfo", "ignored\n"); // IGNORED artifact
  const paths = candidatePaths(dir);

  // R2a: the real engine lists the untracked file, not the ignored artifacts.
  proof(
    "R2a untracked file is in the candidate, ignored artifacts are not",
    paths.includes("src/new-feature.ts") &&
      paths.includes("src/lib.ts") &&
      !paths.some((p) => p.startsWith(".next/")) &&
      !paths.includes("tsconfig.tsbuildinfo"),
    `candidatePaths: ${JSON.stringify(paths)}`,
  );

  // R2b: the gate's report inventory is the same set.
  const report = runPreShipGate(dir);
  proof(
    "R2b the gate's report inventory equals the discovered candidate",
    report.candidate.paths.length === paths.length &&
      report.candidate.paths.every((p) => paths.includes(p)) &&
      report.candidate.count === 2,
    `report candidate: ${JSON.stringify(report.candidate.paths)}`,
  );

  // R2c: `git status --porcelain` collapses the untracked directory (this is
  // why it is NOT the source of truth), yet nothing is lost with ls-files -o.
  const collapsed = git(["status", "--porcelain"], dir).stdout;
  proof(
    "R2c porcelain directory-collapsing does not hide untracked files",
    collapsed.includes("src/") && paths.includes("src/new-feature.ts"),
    `porcelain: ${JSON.stringify(collapsed.split("\n"))}`,
  );

  // R2d: EXACTNESS — what ship's `git add -A` would commit is exactly the
  // candidate, and nothing more. Proven with a real `git add -A` in the
  // (throwaway) fixture, then unstaged again.
  git(["add", "-A"], dir);
  const staged = git(["diff", "--cached", "--name-only"], dir)
    .stdout.split("\n")
    .filter(Boolean)
    .sort();
  git(["reset", "-q"], dir);
  const expected = [...paths].sort();
  proof(
    "R2d git add -A stages exactly the candidate — nothing escapes inspection",
    staged.length === expected.length &&
      staged.every((p, i) => p === expected[i]),
    `staged ${JSON.stringify(staged)} vs candidate ${JSON.stringify(expected)}`,
  );
});

// ── R3: a failing mandatory gate blocks ship before any mutation ─────────────
await withFixture("r3-failing-gate", { gateExit: 1 }, (dir) => {
  writeCandidate(dir, "src/lib.ts", "export const x = 2;\n");
  const headBefore = git(["rev-parse", "HEAD"], dir).stdout;
  const pkgBefore = readFileSync(join(dir, "package.json"), "utf8");

  const pre = runQuiet("node", [join(SCRIPTS, "pre-ship.mjs")], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  proof(
    "R3a failing mandatory check → PRE_SHIP_BLOCKED (exit 1)",
    pre.status === 1 && decisionOf(pre.stdout) === DECISIONS.BLOCKED,
    `exit ${pre.status}; decision ${decisionOf(pre.stdout)}`,
  );

  const r = runQuiet("node", [join(SCRIPTS, "ship.mjs"), "patch"], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  const version = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ).version;
  const headAfter = git(["rev-parse", "HEAD"], dir).stdout;
  const tagExists = git(
    ["rev-parse", "-q", "--verify", "refs/tags/v0.0.3"],
    dir,
  ).ok;
  const blockedByGate = /PRE_SHIP_BLOCKED/.test(r.stdout + r.stderr);
  proof(
    "R3b ship aborts before its first mutation on a failed gate",
    r.status !== 0 &&
      version === "0.0.2" &&
      headAfter === headBefore &&
      !tagExists &&
      blockedByGate &&
      readFileSync(join(dir, "package.json"), "utf8") === pkgBefore,
    `exit ${r.status}; package.json ${version}; HEAD unchanged: ${headAfter === headBefore}; tag v0.0.3 absent: ${!tagExists}; stopped by gate: ${blockedByGate}`,
  );
});

// ── R4: a gate that mutates the candidate fails closed ───────────────────────
await withFixture("r4-mutation", { gateExit: 0 }, (dir) => {
  writeCandidate(dir, "src/lib.ts", "export const x = 2;\n");
  const dirtyingGates = [
    ...CANONICAL_GATES.slice(0, 5),
    {
      id: "dirtying",
      label: "dirtying",
      desc: "simulates a gate that writes a new candidate file",
      kind: "read",
      run: (root) => {
        writeFileSync(join(root, "MUTATED.txt"), "gate side effect\n");
        return { pass: true, detail: "mutated" };
      },
    },
    ...CANONICAL_GATES.slice(5),
  ];
  const { results, blocked } = runGates(dir, dirtyingGates);
  const stable = results.find((g) => g.id === "candidate-stable");
  proof(
    "R4 a gate that adds a candidate file fails closed at non-mutation",
    blocked &&
      stable?.status === "FAIL" &&
      stable.detail.includes("changed the release candidate") &&
      stable.detail.includes("MUTATED.txt"),
    stable?.detail ?? "candidate-stable gate did not run",
  );
});

// ── R5/R6/R7: a HIGH release-tooling candidate ────────────────────────────────
await withFixture("r5-high-candidate", { gateExit: 0 }, (dir) => {
  // A release-tooling candidate file — matches the HIGH surface in
  // pre-ship-lib.mjs, and mirrors the real OPS-REL-01 slice.
  writeCandidate(dir, "scripts/ship.mjs", "// changed release tooling\n");
  const report = runPreShipGate(dir);
  proof(
    "R5a release-tooling candidate classifies HIGH",
    report.risk.high.some((s) => s.id === "release-tooling") &&
      report.risk.high.length === 1,
    `high surfaces: ${report.risk.high.map((s) => s.id).join(",") || "none"}`,
  );

  // R5b: the real CLI reports MANUAL_RELEASE_REVIEW_REQUIRED (exit 2) — not
  // PRE_SHIP_BLOCKED, because the tree is only "dirty", not invalid.
  const r = runQuiet("node", [join(SCRIPTS, "pre-ship.mjs")], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  proof(
    "R5b HIGH candidate → MANUAL_RELEASE_REVIEW_REQUIRED (exit 2)",
    r.status === 2 && decisionOf(r.stdout) === DECISIONS.MANUAL,
    `exit ${r.status}; decision ${decisionOf(r.stdout)}`,
  );

  // R6: ship WITHOUT the acknowledgement aborts before its first mutation.
  const headBefore = git(["rev-parse", "HEAD"], dir).stdout;
  const rNoAck = runQuiet("node", [join(SCRIPTS, "ship.mjs"), "patch"], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  const versionNoAck = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ).version;
  proof(
    "R6 HIGH candidate without --ack aborts ship before its first mutation",
    rNoAck.status !== 0 &&
      versionNoAck === "0.0.2" &&
      git(["rev-parse", "HEAD"], dir).stdout === headBefore &&
      /MANUAL_RELEASE_REVIEW_REQUIRED/.test(rNoAck.stdout + rNoAck.stderr) &&
      !/--ack-manual-review acknowledged/.test(rNoAck.stdout),
    `exit ${rNoAck.status}; package.json ${versionNoAck}; HEAD unchanged`,
  );

  // R7: WITH the acknowledgement ship passes the canonical gate and reaches
  // the release-mutation seam. It stops at the OFFLINE publish-context
  // validation (the fixture has no origin remote) — no real publish, no
  // network, no tag, no mutation. package.json and HEAD are still untouched.
  const rAck = runQuiet(
    "node",
    [join(SCRIPTS, "ship.mjs"), "patch", "--ack-manual-review"],
    dir,
    { FLOWPILOT_RELEASE_ROOT: dir },
  );
  const versionAck = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ).version;
  const gateCertified = runPreShipGate(dir).candidate.fingerprint;
  const printedFingerprint = /fingerprint ([0-9a-f]{12})/.exec(rAck.stdout);
  const stopLine = (rAck.stderr || rAck.stdout)
    .split("\n")
    .filter((l) => /origin|not configured/i.test(l))[0];
  proof(
    "R7 --ack-manual-review carries ship past the gate to the mutation seam",
    rAck.status !== 0 &&
      /acknowledged by the operator/.test(rAck.stdout) &&
      /candidate fingerprint matches the reviewed candidate/.test(
        rAck.stdout,
      ) &&
      !/PRE_SHIP_BLOCKED/.test(rAck.stdout + rAck.stderr) &&
      versionAck === "0.0.2" &&
      git(["rev-parse", "HEAD"], dir).stdout === headBefore,
    `ack accepted; gate passed; stopped at publish context (${stopLine ?? "?"}); no mutation`,
  );
  proof(
    "R7b the candidate ship moved toward is the one the gate certified",
    Boolean(printedFingerprint) &&
      printedFingerprint[1] === gateCertified.slice(0, 12),
    `ship printed ${printedFingerprint?.[1]}; gate certified ${gateCertified.slice(0, 12)} (12-char prefix of the same sha256)`,
  );
});

// ── R10: the release-mutation seam — exactly reviewed candidate + bump ────────
await withFixture("r10-seam", { gateExit: 0 }, (dir) => {
  writeCandidate(dir, "src/lib.ts", "export const x = 2;\n"); // tracked change
  writeCandidate(dir, "docs/NEW.md", "# new\n"); // untracked candidate file
  const reviewed = snapshotCandidate(dir);
  const pkgBefore = readFileSync(join(dir, "package.json"), "utf8");

  // The version bump is the ONLY tolerated change.
  writeFileSync(
    join(dir, "package.json"),
    pkgBefore.replace(/"version": "0.0.2"/, '"version": "0.0.3"'),
  );
  git(["add", "-A"], dir);
  const staged = git(["diff", "--cached", "--name-only"], dir)
    .stdout.split("\n")
    .filter(Boolean);
  const exact = verifyReleaseStage(dir, reviewed, staged, pkgBefore, "0.0.3");
  proof(
    "R10a reviewed candidate + version bump passes the seam check",
    exact.ok &&
      staged.includes("package.json") &&
      staged.includes("docs/NEW.md") &&
      staged.includes("src/lib.ts"),
    `ok: ${exact.ok}; staged ${JSON.stringify(staged)}`,
  );

  // A stray file swept in by `git add -A` that was NOT in the reviewed
  // candidate must be rejected.
  writeCandidate(dir, "STRAY.md", "not reviewed\n");
  git(["add", "-A"], dir);
  const staged2 = git(["diff", "--cached", "--name-only"], dir)
    .stdout.split("\n")
    .filter(Boolean);
  const reject = verifyReleaseStage(dir, reviewed, staged2, pkgBefore, "0.0.3");
  proof(
    "R10b an unreviewed file in the stage is rejected",
    !reject.ok &&
      reject.problems.some((p) => p.includes("STRAY.md")) &&
      !reject.problems.some((p) => p.includes("not valid JSON")),
    `problems: ${reject.problems.join(" | ")}`,
  );

  // A package.json mutated beyond the version field is rejected too.
  git(["reset", "-q"], dir);
  writeFileSync(
    join(dir, "package.json"),
    pkgBefore.replace(
      /"version": "0.0.2"/,
      '"version": "0.0.3", "injected": true',
    ),
  );
  git(["add", "-A"], dir);
  const staged3 = git(["diff", "--cached", "--name-only"], dir)
    .stdout.split("\n")
    .filter(Boolean);
  const reject2 = verifyReleaseStage(
    dir,
    reviewed,
    staged3,
    pkgBefore,
    "0.0.3",
  );
  proof(
    "R10c a package.json change beyond the version field is rejected",
    !reject2.ok && reject2.problems.some((p) => p.includes('"injected"')),
    `problems: ${reject2.problems.join(" | ")}`,
  );
});

// ── R8: ambiguous baselines fail closed ───────────────────────────────────────
await withFixture("r8-branch", { gateExit: 0 }, (dir) => {
  writeCandidate(dir, "src/lib.ts", "export const x = 2;\n");
  git(["checkout", "-q", "-b", "feature"], dir);
  const r = runQuiet("node", [join(SCRIPTS, "pre-ship.mjs")], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  proof(
    "R8a a non-main branch fails closed",
    r.status === 1 &&
      decisionOf(r.stdout) === DECISIONS.BLOCKED &&
      /not on main/.test(r.stdout),
    `exit ${r.status}; decision ${decisionOf(r.stdout)}`,
  );
});

await withFixture("r8-behind", { gateExit: 0 }, (dir) => {
  const head = git(["rev-parse", "HEAD"], dir).stdout;
  // Simulate origin/main holding a commit local HEAD does not have: the push
  // would be rejected.
  commitFile(
    dir,
    "src/remote-only.ts",
    "export const z = 9;\n",
    "feat: remote",
  );
  const remoteSha = git(["rev-parse", "HEAD"], dir).stdout;
  git(["update-ref", "refs/remotes/origin/main", remoteSha], dir);
  git(["reset", "--hard", "-q", head], dir);
  writeCandidate(dir, "src/lib.ts", "export const x = 2;\n");
  const r = runQuiet("node", [join(SCRIPTS, "pre-ship.mjs")], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  proof(
    "R8b origin/main ahead of HEAD fails closed (no force push, no ambiguity)",
    r.status === 1 &&
      decisionOf(r.stdout) === DECISIONS.BLOCKED &&
      /origin\/main has commits that are not in HEAD/.test(r.stdout),
    `exit ${r.status}; decision ${decisionOf(r.stdout)}; origin/main is ahead`,
  );
});

await withFixture("r8-unmerged", { gateExit: 0 }, (dir) => {
  commitFile(dir, "src/other.ts", "export const a = 1;\n", "feat: base");
  git(["checkout", "-q", "-b", "other"], dir);
  commitFile(dir, "src/other.ts", "export const a = 2;\n", "feat: other side");
  git(["checkout", "-q", "main"], dir);
  commitFile(dir, "src/other.ts", "export const a = 3;\n", "feat: main side");
  const merged = git(["merge", "-q", "other"], dir);
  const unmergedCount = git(["ls-files", "-u"], dir)
    .stdout.split("\n")
    .filter(Boolean).length;
  const state = runGates(dir, CANONICAL_GATES.slice(0, 2));
  const gitState = state.results.find((g) => g.id === "git-state");
  const pending = pendingOperation(dir);
  git(["merge", "-q", "--abort"], dir);
  proof(
    "R8c unmerged paths fail closed",
    !merged.ok &&
      unmergedCount > 0 &&
      gitState?.status === "FAIL" &&
      gitState.detail.includes("unmerged") &&
      pending === "merge",
    `merge exit ${merged.ok ? 0 : 1}; ${unmergedCount} unmerged stage(s); git-state: ${gitState?.detail ?? "did not run"}`,
  );
});

await withFixture("r8-pending", { gateExit: 0 }, (dir) => {
  commitFile(dir, "src/other.ts", "export const a = 1;\n", "feat: base");
  git(["checkout", "-q", "-b", "other"], dir);
  commitFile(dir, "src/unrelated.ts", "export const b = 1;\n", "feat: other");
  git(["checkout", "-q", "main"], dir);
  writeCandidate(dir, "src/lib.ts", "export const x = 2;\n");
  // A clean, unfinished merge: no unmerged paths, but MERGE_HEAD exists — the
  // baseline is ambiguous even though no file conflicts. --no-ff forces a real
  // merge (a fast-forward would simply move HEAD and leave nothing pending).
  const merged = git(["merge", "--no-ff", "--no-commit", "-q", "other"], dir);
  const unmergedCount = git(["ls-files", "-u"], dir)
    .stdout.split("\n")
    .filter(Boolean).length;
  const state = runGates(dir, CANONICAL_GATES.slice(0, 2));
  const gitState = state.results.find((g) => g.id === "git-state");
  const pending = pendingOperation(dir);
  git(["merge", "-q", "--abort"], dir);
  proof(
    "R8d a pending (unfinished) merge fails closed even without conflicts",
    merged.ok &&
      unmergedCount === 0 &&
      pending === "merge" &&
      gitState?.status === "FAIL" &&
      gitState.detail.includes("merge is in progress"),
    `merge ok: ${merged.ok}; unmerged: ${unmergedCount}; pending: ${pending}; git-state: ${gitState?.detail ?? "did not run"}`,
  );
});

// ── R9: the REAL OPS-REL-01 candidate — the contradiction this contract fixes ─
{
  // Read-only over the real repository: git-state + diff --check only. The
  // composed quality gates (security / ai-prompts / verify) are deliberately
  // NOT run here — they are run by the operator in Phase 6, offline.
  const baseline = collectBaseline(REAL_ROOT);
  const state = runGates(REAL_ROOT, CANONICAL_GATES.slice(0, 2), baseline);
  const gitState = state.results.find((g) => g.id === "git-state");
  const candidate = state.candidateBefore;
  const risk = classifyRisk([
    ...new Set([...(candidate?.paths ?? []), ...baseline.unreleasedFiles]),
  ]);
  const untracked = candidate
    ? candidate.paths.filter((p) => candidate.untracked.includes(p))
    : [];
  proof(
    "R9a the real dirty candidate is ACCEPTED — not blocked for being dirty",
    gitState?.status === "PASS" && Boolean(candidate) && candidate.count > 0,
    `git-state: ${gitState?.detail ?? "did not run"} (this is the gate that previously failed with "uncommitted path(s)")`,
  );
  proof(
    "R9b the real candidate's decision is MANUAL_RELEASE_REVIEW_REQUIRED",
    risk.high.some((s) => s.id === "release-tooling"),
    `candidate ${candidate?.count ?? 0} path(s) (${untracked.length} untracked: ${untracked.join(", ") || "none"}); HIGH surfaces: ${risk.high.map((s) => s.id).join(",") || "none"}`,
  );
}

// ── R11: a secret in an untracked candidate file is blocked, value never shown ─
await withFixture("r11-secret", { gateExit: 0, realSecurity: true }, (dir) => {
  // A fake value assembled at runtime so THIS harness source contains no
  // secret-shaped literal (the real scanner scans this file too). Once
  // assembled it matches a genuine GitHub classic token shape, which the
  // real scanner must flag in the untracked candidate file.
  const SECRET = ["ghp_", "FIXTURE", "SECRET", "0123456789", "ABCDEFGH"].join(
    "",
  );
  writeCandidate(dir, "src/config.ts", `export const token = "${SECRET}";\n`);
  const r = runQuiet("node", [join(SCRIPTS, "pre-ship.mjs")], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  const output = `${r.stdout}\n${r.stderr}`;
  proof(
    "R11 a secret in an untracked candidate file blocks the release",
    r.status === 1 && decisionOf(r.stdout) === DECISIONS.BLOCKED,
    `exit ${r.status}; decision ${decisionOf(r.stdout)} (the real secret scanner, copied into the fixture, flagged the untracked candidate file)`,
  );
  proof(
    "R11b the secret value is never printed — only file:line + kind",
    !output.includes(SECRET) &&
      /src\/config\.ts:1 — possible GitHub token/.test(output) &&
      /\[value redacted, \d+ chars\]/.test(output),
    `secret literal present in output: ${output.includes(SECRET)}; redacted finding present: ${/\[value redacted/.test(output)}`,
  );
});

// ── R12b: a tree with no candidate fails closed deterministically ─────────────
await withFixture("r12-clean", { gateExit: 0 }, (dir) => {
  // The old "clean baseline" case. Under the corrected contract there is no
  // release candidate, so the gate must say so explicitly rather than
  // certifying an empty release GREEN.
  const r = runQuiet("node", [join(SCRIPTS, "pre-ship.mjs")], dir, {
    FLOWPILOT_RELEASE_ROOT: dir,
  });
  proof(
    "R12b an empty candidate fails closed with an actionable reason",
    r.status === 1 &&
      decisionOf(r.stdout) === DECISIONS.BLOCKED &&
      /no release candidate/.test(r.stdout),
    `exit ${r.status}; decision ${decisionOf(r.stdout)} — a clean tree means "nothing to release", never PRE_SHIP_GREEN`,
  );
});

// ── R12c: this proof leaves the real working tree untouched ───────────────────
{
  const before = git(["status", "--porcelain"], REAL_ROOT).stdout;
  const head = git(["rev-parse", "HEAD"], REAL_ROOT).stdout;
  const tags = git(["tag", "--list"], REAL_ROOT).stdout;
  const candidateBefore = snapshotCandidate(REAL_ROOT).fingerprint;
  // Re-run the real gate engine read-only over the real repository.
  runGates(REAL_ROOT, CANONICAL_GATES.slice(0, 2));
  const after = git(["status", "--porcelain"], REAL_ROOT).stdout;
  const candidateAfter = snapshotCandidate(REAL_ROOT).fingerprint;
  proof(
    "R12c real working tree untouched by the proof",
    before === after &&
      git(["rev-parse", "HEAD"], REAL_ROOT).stdout === head &&
      git(["tag", "--list"], REAL_ROOT).stdout === tags &&
      candidateBefore === candidateAfter,
    "porcelain / HEAD / tags / candidate fingerprint identical before and after",
  );
}

// ── report ───────────────────────────────────────────────────────────────────
console.log("FlowPilot pre-ship regression proof (OPS-REL-01 corrected)\n");
for (const r of results)
  console.log(`${r.pass ? "✅" : "❌"} ${r.name}\n     ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log("");
if (failed.length === 0)
  console.log(
    `RESULT: PASSED ✅ — ${results.length}/${results.length} proofs green.`,
  );
else
  console.log(
    `RESULT: FAILED ❌ — ${failed.length}/${results.length} proof(s) failed: ${failed.map((f) => f.name).join(", ")}`,
  );

for (const dir of FIXTURES) rmSync(dir, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
