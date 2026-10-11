// FlowPilot pre-ship gate — the canonical release-readiness engine
// (PROMPT-OPS-REL-01).
//
// ONE repository-owned source of truth for "is this tree safe to ship?".
// Both the operator-facing `pnpm pre-ship` (scripts/pre-ship.mjs) and the
// release path `pnpm ship` (scripts/ship.mjs) import THIS module, so the
// release gate can never drift between the report the human reviews and the
// gate ship actually enforces.
//
// RELEASE CANDIDATE — the invariant this gate certifies.
// FlowPilot's release model is SHIP OWNS THE RELEASE COMMIT: the human
// implementation ends as a working-tree release candidate, `pnpm pre-ship`
// certifies THAT candidate, and `pnpm ship` later commits it with one
// conventional release commit. Therefore a non-clean working tree is not a
// pre-ship failure — the candidate IS the uncommitted work.
//
// The candidate is EXACTLY the set of non-ignored paths `git add -A` would
// commit (scripts/ship.mjs stages with `git add -A`), discovered from two
// git primitives so nothing can escape inspection:
//     git diff HEAD --name-only   tracked changes vs HEAD (unstaged + staged
//                                 modifications, additions, and deletions)
//     git ls-files -o              new untracked, non-ignored files
//                                 (--exclude-standard honors .gitignore, so
//                                 .next/ / *.tsbuildinfo / .env* are excluded)
// `git status --porcelain` is deliberately NOT the source of truth: it
// collapses untracked directories to a single `?? dir/` entry, which would
// hide the individual files ship would commit.
//
// CONTRACT — the gate is strictly NON-MUTATING and OFFLINE:
//   - no git add/commit/push/tag, no GitHub Release, no deploy, no Vercel
//   - no prisma migrate / db push / db seed / DB write of any kind
//   - no provider calls, no eval/probe runs, no credits consumed
//   - no customer messages, no bookings, no Production users/config
//   - does not require Production secrets
// It only READS repository state and runs sanctioned offline quality checks.
// The `candidate-stable` gate fingerprints the candidate before and after the
// quality gates, so a mutation introduced inside a gate fails closed —
// without false drift from ignored build artifacts such as `.next/` or
// `*.tsbuildinfo`, which are never part of the candidate.
//
// The human operator remains the SemVer authority: this module RECOMMENDS a
// bounded bump from commit subjects and never performs any release action.
//
// Decision vocabulary (stable, machine-readable):
//   PRE_SHIP_GREEN                 every gate passed; no high-risk surface
//   PRE_SHIP_BLOCKED               a mandatory gate failed — do not ship
//   MANUAL_RELEASE_REVIEW_REQUIRED  a high-risk surface changed; the machine
//                                  cannot certify it; a human must review

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Repository root. `FLOWPILOT_RELEASE_ROOT` is a documented test seam that
 * lets the repository-owned regression proof (scripts/check-pre-ship.mjs)
 * drive the REAL gate/ship against a throwaway fixture repository without
 * ever touching the real working tree. It only changes the working
 * directory — it cannot reach any remote, provider, or database.
 */
export function resolveRoot(override = process.env.FLOWPILOT_RELEASE_ROOT) {
  return override && override.trim() !== ""
    ? override.trim()
    : join(SCRIPT_DIR, "..");
}

// ── git helper (offline; never writes) ───────────────────────────────────────
export function git(args, root, opts = {}) {
  const r = spawnSync("git", args, {
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
}

// ── the release candidate (exact, inspectable, fingerprintable) ───────────────
// Digest used for a path that is part of the candidate but absent from the
// working tree (a deletion `git add -A` would stage). A real file can never
// hash to this value, so deleted vs. empty-content stays unambiguous.
const DELETED_DIGEST = "<deleted>";

/**
 * The exact, deterministic path list `git add -A` would commit: tracked
 * changes vs HEAD (unstaged + staged, including deletions) plus new
 * untracked non-ignored files. Nothing that `git add -A` would commit can be
 * absent from this list, and nothing ignored (.next/, *.tsbuildinfo, .env*)
 * can appear in it. Returned sorted for stable output.
 */
export function candidatePaths(root) {
  const paths = new Set();
  const tracked = git(
    ["diff", "HEAD", "--name-only", "--no-renames", "-z"],
    root,
  );
  if (tracked.ok)
    for (const p of tracked.stdout.split("\0")) if (p !== "") paths.add(p);
  const untracked = git(["ls-files", "-o", "--exclude-standard", "-z"], root);
  if (untracked.ok)
    for (const p of untracked.stdout.split("\0")) if (p !== "") paths.add(p);
  return [...paths].sort();
}

/**
 * Snapshot the release candidate: paths + a per-path sha256 content digest +
 * one sha256 fingerprint over the whole (sorted) set. Two snapshots with the
 * same fingerprint name the same candidate, byte for byte. Read-only; never
 * writes anything.
 */
export function snapshotCandidate(root) {
  const paths = candidatePaths(root);
  const tracked = new Set(paths);
  const untrackedOnly = new Set();
  const u = git(["ls-files", "-o", "--exclude-standard", "-z"], root);
  if (u.ok)
    for (const p of u.stdout.split("\0"))
      if (p !== "") {
        untrackedOnly.add(p);
        tracked.delete(p);
      }
  const digests = new Map();
  for (const p of paths) {
    let digest = DELETED_DIGEST;
    try {
      digest = createHash("sha256")
        .update(readFileSync(join(root, p)))
        .digest("hex");
    } catch {
      // absent / unreadable → the deletion `git add -A` would stage
    }
    digests.set(p, digest);
  }
  const fingerprint = createHash("sha256")
    .update(paths.map((p) => `${p}\0${digests.get(p)}`).join("\n"))
    .digest("hex");
  return {
    paths,
    fingerprint,
    count: paths.length,
    untracked: [...untrackedOnly].sort(),
    trackedChanged: [...tracked].sort(),
    digests,
  };
}

/**
 * Human-facing status of one candidate path (derived from the canonical
 * sources, never from porcelain directory collapsing).
 */
export function candidateStatus(path, snapshot) {
  const digest = snapshot.digests.get(path);
  if (digest === DELETED_DIGEST) return "deleted";
  return snapshot.untracked.includes(path) ? "new" : "modified";
}

/**
 * Byte-wise diff between two candidate snapshots: which paths a later
 * snapshot added, removed, or changed relative to an earlier one. Used by the
 * non-mutation witness (a gate that drifts the candidate) and by ship's
 * release-mutation seam (the staged release must be the reviewed candidate
 * plus exactly the version-bump delta).
 */
export function compareCandidates(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const p of after.paths) {
    if (!before.paths.includes(p)) added.push(p);
    else if (before.digests.get(p) !== after.digests.get(p)) changed.push(p);
  }
  for (const p of before.paths) if (!after.paths.includes(p)) removed.push(p);
  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

/**
 * Verify the release stage is EXACTLY the reviewed candidate plus the expected
 * version-bump delta, and nothing else. Called by ship after `git add -A`,
 * before the release commit — the single place the "exact, inspected
 * candidate" invariant is enforced on the mutating side of the seam.
 *
 * `reviewed`    — the candidate snapshot that passed the canonical gate
 * `staged`      — the staged path list after `git add -A` (git diff --cached)
 * `pkgBefore`   — package.json bytes as the gate reviewed them
 * `expectedVer` — the target version ship wrote
 */
export function verifyReleaseStage(
  root,
  reviewed,
  staged,
  pkgBefore,
  expectedVer,
) {
  const problems = [];
  const stagedSet = [...staged].sort();
  const expected = [...new Set([...reviewed.paths, "package.json"])].sort();
  const stagedCsv = stagedSet.join(",");
  const expectedCsv = expected.join(",");
  if (stagedCsv !== expectedCsv) {
    const unexpected = stagedSet.filter((p) => !expected.includes(p));
    const missing = expected.filter((p) => !stagedSet.includes(p));
    problems.push(
      `staged release is not exactly the reviewed candidate + version bump` +
        (unexpected.length
          ? ` — unexpected staged path(s): ${unexpected.join(", ")}`
          : "") +
        (missing.length
          ? ` — expected path(s) not staged: ${missing.join(", ")}`
          : ""),
    );
  }
  // After the bump the working-tree candidate may differ from the reviewed
  // candidate ONLY in package.json, and only in its version field. package.json
  // may be an addition (when it was not itself part of the reviewed candidate)
  // or a modification — both are the version-bump delta.
  const after = snapshotCandidate(root);
  const drift = compareCandidates(reviewed, after);
  const tolerated = new Set(["package.json"]);
  for (const p of [...drift.added, ...drift.changed])
    if (!tolerated.has(p))
      problems.push(
        `candidate path changed outside the version bump: ${p} (added/modified after the gate)`,
      );
  if (drift.removed.length > 0)
    problems.push(
      `candidate path(s) removed after the gate: ${drift.removed.join(", ")}`,
    );
  // package.json: only the version field may differ, and it must be the target.
  let pkgAfter = null;
  try {
    pkgAfter = readFileSync(join(root, "package.json"), "utf8");
  } catch {
    problems.push("package.json is unreadable after the version bump");
  }
  if (pkgAfter !== null) {
    let beforeJson = null;
    let afterJson = null;
    try {
      beforeJson = JSON.parse(pkgBefore);
      afterJson = JSON.parse(pkgAfter);
    } catch {
      problems.push("package.json is not valid JSON after the version bump");
    }
    if (beforeJson && afterJson) {
      const keys = new Set([
        ...Object.keys(beforeJson),
        ...Object.keys(afterJson),
      ]);
      for (const k of keys)
        if (
          k !== "version" &&
          JSON.stringify(beforeJson[k]) !== JSON.stringify(afterJson[k])
        )
          problems.push(
            `package.json field "${k}" changed — only "version" may`,
          );
      if (afterJson.version !== expectedVer)
        problems.push(
          `package.json version is ${JSON.stringify(afterJson.version)}, expected ${expectedVer}`,
        );
    }
  }
  return { ok: problems.length === 0, problems };
}

export function readPackageVersion(root) {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export function latestTag(root) {
  const r = git(["describe", "--tags", "--abbrev=0"], root);
  return r.ok ? r.stdout : null;
}

// ── baseline facts (read-only) ────────────────────────────────────────────────
// Ranges the release would publish. Under the single-release-commit model the
// candidate is the working tree, but anything already committed locally and
// not yet on origin/main would be pushed too, so it is part of the release
// and must join the risk classification.
function rangeFiles(root, range) {
  const r = git(["diff", "--name-only", range], root);
  return r.ok ? r.stdout.split("\n").filter(Boolean) : [];
}

function rangeSubjects(root, range) {
  const r = git(["log", "--format=%s", range], root);
  return r.ok ? r.stdout.split("\n").filter(Boolean) : [];
}

const PENDING_OPERATIONS = [
  ["MERGE_HEAD", "merge"],
  ["REBASE_HEAD", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
];

/**
 * True when the repository is mid-operation, i.e. the baseline is ambiguous:
 * an unfinished merge/rebase/cherry-pick/revert/bisect leaves paths in a state
 * `git add -A` would commit without describing a coherent release.
 */
export function pendingOperation(root) {
  const gitDir = git(["rev-parse", "--absolute-git-dir"], root).stdout;
  if (!gitDir) return null;
  for (const [file, label] of PENDING_OPERATIONS)
    if (existsSync(join(gitDir, file))) return label;
  for (const dir of ["rebase-merge", "rebase-apply"])
    if (existsSync(join(gitDir, dir))) return "rebase";
  return null;
}

export function collectBaseline(root) {
  const branch = git(["branch", "--show-current"], root).stdout;
  const head = git(["rev-parse", "HEAD"], root).stdout || null;
  const version = readPackageVersion(root);
  const tag = latestTag(root);

  const originRef = "refs/remotes/origin/main";
  const hasOrigin = git(["rev-parse", "--verify", "-q", originRef], root).ok;

  // Commits that would ship alongside the candidate because they are not yet
  // on origin/main (normally empty — ship owns the one release commit).
  const unreleasedRange = hasOrigin ? `${originRef}..HEAD` : null;
  const unreleasedFiles = unreleasedRange
    ? [
        ...new Set([
          ...rangeFiles(root, `${tag}..HEAD`),
          ...rangeFiles(root, unreleasedRange),
        ]),
      ]
        .filter(Boolean)
        .sort()
    : tag
      ? rangeFiles(root, `${tag}..HEAD`)
      : [];
  const headSubjects = [
    ...new Set([
      ...(tag ? rangeSubjects(root, `${tag}..HEAD`) : []),
      ...(unreleasedRange ? rangeSubjects(root, unreleasedRange) : []),
    ]),
  ];

  // Offline origin/main check: compare against the LOCALLY-KNOWN remote ref.
  // `ship` performs the real network check (ls-remote) at publish time; the
  // pre-ship gate stays offline and secret-free.
  let originState = "unknown";
  let localAhead = 0;
  if (hasOrigin && head) {
    const behind = !git(
      ["merge-base", "--is-ancestor", originRef, "HEAD"],
      root,
    ).ok;
    if (behind) originState = "behind";
    else {
      originState = "ahead-or-equal";
      const n = git(["rev-list", "--count", `${originRef}..HEAD`], root).stdout;
      localAhead = Number(n) || 0;
    }
  }
  return {
    branch,
    head,
    version,
    tag,
    unreleasedFiles,
    headSubjects,
    originState,
    localAhead,
  };
}

// ── risk surfaces ─────────────────────────────────────────────────────────────
// HIGH surfaces have a blast radius a mechanical gate cannot certify: they
// force MANUAL_RELEASE_REVIEW_REQUIRED. ELEVATED surfaces are routed to the
// deterministic offline check suite that owns them — the operator runs those
// checks as review evidence; pre-ship does not run them on every release.

const HIGH_SURFACES = [
  {
    id: "db-schema",
    label: "DB schema / persistence contract",
    match: (p) =>
      p === "prisma/schema.prisma" ||
      p.startsWith("prisma/migrations/") ||
      p === "prisma/demo-data.ts" ||
      p === "prisma/seed.ts",
    routing:
      "A schema/migration change can desync Production. Production migrations are a SEPARATELY controlled operator action (.github/workflows/production-db-migrate.yml) — never run by pre-ship or ship. Review the migration by hand, then from desktop/CI: pnpm exec prisma migrate status.",
  },
  {
    id: "auth-security",
    label: "Auth / security boundary",
    match: (p) =>
      p.startsWith("src/features/auth/") ||
      p.startsWith("src/server/auth/") ||
      p.startsWith("src/server/security/") ||
      p.startsWith("src/server/credentials/") ||
      p === "scripts/security-check.mjs" ||
      p.startsWith(".githooks/"),
    routing:
      "The auth/security boundary changed. Re-run pnpm security and re-check the pre-commit secret guard; confirm sessions, guards, and the credential store still hold.",
  },
  {
    id: "release-tooling",
    label: "Release / deployment tooling itself",
    match: (p) =>
      p === "package.json" ||
      [
        "scripts/ship.mjs",
        "scripts/release.sh",
        "scripts/pre-ship.mjs",
        "scripts/pre-ship-lib.mjs",
        "scripts/check-pre-ship.mjs",
      ].includes(p),
    routing:
      "The release contract itself changed. Review the gate/ship change against docs/RELEASE_PROCESS.md and re-run the tooling proof: pnpm check:pre-ship.",
  },
  {
    id: "deploy-config",
    label: "Deployment / CI configuration",
    match: (p) =>
      p.startsWith(".github/workflows/") ||
      p === "vercel.json" ||
      p === "scripts/deploy.mjs" ||
      p === "scripts/pre-deploy.mjs",
    routing:
      "Deployment/CI configuration changed. Review the workflow or deploy config against VERCEL_DEPLOYMENT.md; confirm the build still deploys identically.",
  },
  {
    id: "env-config",
    label: "Environment / configuration surface",
    match: (p) => p === ".env.example" || p === "docs/ENVIRONMENT_VARIABLES.md",
    routing:
      "The environment contract changed. Keep .env.example and docs/ENVIRONMENT_VARIABLES.md in sync and re-validate the required variables: pnpm vercel:check.",
  },
];

const ELEVATED_SURFACES = [
  {
    id: "ai-prompts",
    label: "AI prompts / generated prompt artifact",
    match: (p) =>
      p.startsWith("prompts/") || p === "src/generated/ai-prompts.generated.ts",
    checks: ["pnpm check:ai-prompts"],
  },
  {
    id: "ai-provider",
    label: "AI provider routing / adapters",
    match: (p) => p.startsWith("src/server/integrations/ai/"),
    checks: [
      "pnpm check:ai-provider",
      "pnpm check:atria-retry",
      "pnpm check:response-normalizer",
    ],
  },
  {
    id: "ai-contract",
    label: "AI contract / context / disclosure",
    match: (p) =>
      p.startsWith("src/features/conversations/server/ai-contract") ||
      p.startsWith("src/features/conversations/server/ai-observability") ||
      p.startsWith("src/features/conversations/server/ai-context-builder") ||
      p.startsWith("src/features/conversations/server/ai-disclosure") ||
      p.startsWith("src/features/conversations/server/assistant-style"),
    checks: [
      "pnpm check:ai-architecture",
      "pnpm check:ai-context-builder",
      "pnpm check:ai-disclosure",
      "pnpm check:assistant-style",
    ],
  },
  {
    id: "conversation-engine",
    label: "Conversation engine",
    match: (p) => p.startsWith("src/features/conversations/"),
    checks: [
      "pnpm check:conversation-control",
      "pnpm check:conversation-handoff",
      "pnpm check:clarify",
      "pnpm check:multi-intent",
      "pnpm check:knowledge-gap",
      "pnpm check:turn-planner",
      "pnpm check:turn-evidence",
      "pnpm check:jev",
      "pnpm check:conversation-ux",
    ],
  },
  {
    id: "booking-domain",
    label: "Booking / appointments domain",
    match: (p) =>
      p.startsWith("src/features/appointments/") ||
      p === "src/features/conversations/server/booking-mapper.ts" ||
      p === "src/features/conversations/server/booking-selection.ts",
    checks: [
      "pnpm check:booking-options",
      "pnpm check:booking-confirm",
      "pnpm check:appointment-creation",
      "pnpm check:reschedule",
      "pnpm check:eligibility",
      "pnpm check:booking-ux",
    ],
  },
  {
    id: "transports",
    label: "Messaging transports (WhatsApp / Telegram)",
    match: (p) =>
      p.startsWith("src/server/transport/") ||
      p.startsWith("src/server/integrations/whatsapp/") ||
      p.startsWith("src/server/integrations/telegram/") ||
      p.startsWith("src/features/whatsapp-") ||
      p.startsWith("src/features/telegram-"),
    checks: [
      "pnpm check:whatsapp-transport",
      "pnpm check:whatsapp-inbound",
      "pnpm check:meta-whatsapp",
      "pnpm check:telegram",
    ],
  },
  {
    id: "copy-lab",
    label: "Copy Lab / conversation copy",
    match: (p) =>
      p.startsWith("src/features/conversation-copy/") ||
      p.startsWith("src/features/platform/"),
    checks: ["pnpm check:copy-lab"],
  },
];

/**
 * Classify the changed files. A file may match at most one ELEVATED surface
 * (first match wins, most specific first) and independently any HIGH surface.
 */
export function classifyRisk(changedFiles) {
  const high = [];
  const elevated = [];
  for (const surface of HIGH_SURFACES) {
    const files = changedFiles.filter(surface.match);
    if (files.length > 0) high.push({ ...surface, files });
  }
  const claimed = new Set();
  for (const surface of ELEVATED_SURFACES) {
    const files = changedFiles.filter(
      (p) => surface.match(p) && !claimed.has(p),
    );
    if (files.length > 0) {
      files.forEach((p) => claimed.add(p));
      elevated.push({ ...surface, files });
    }
  }
  return { high, elevated };
}

// ── bounded SemVer recommendation (human remains the authority) ──────────────
const RELEASE_COMMIT =
  /^(feat|fix|chore|docs|refactor|perf|style|test|build|ci|ops)(\([^)]*\))?:\s*release\s+v/i;

export function recommendBump(subjects) {
  const work = subjects.filter((s) => !RELEASE_COMMIT.test(s));
  if (work.some((s) => /^feat(\([^)]*\))?:/i.test(s))) return "MINOR";
  if (
    work.some((s) =>
      /^(fix|perf|refactor|docs|chore|ops|style|test|build|ci)(\([^)]*\))?:/i.test(
        s,
      ),
    )
  )
    return "PATCH";
  return "MANUAL_DECISION";
}

// ── the canonical gate set ────────────────────────────────────────────────────
// Ordered cheapest-first so a cheap failure stops the run before the slow
// build. `pnpm check:ai-prompts` deliberately runs BEFORE `pnpm verify`:
// verify's build step regenerates the prompt artifact, which would mask a
// stale committed artifact; the --check drift guard must see the tree as-is.

export const CANONICAL_GATES = [
  {
    id: "git-state",
    label: "git state",
    kind: "read",
    desc: "branch=main, unambiguous baseline, exact non-empty release candidate",
    run(root, ctx) {
      if (!git(["rev-parse", "--is-inside-work-tree"], root).ok)
        return {
          pass: false,
          detail: "not inside a git repository",
          fix: "run pre-ship from the FlowPilot repository",
        };
      const branch = git(["branch", "--show-current"], root).stdout;
      if (branch !== "main")
        return {
          pass: false,
          detail: `not on main (currently: ${branch || "detached HEAD"})`,
          fix: "releases happen from main: git switch main",
        };
      const unmerged = git(["ls-files", "-u"], root).stdout;
      if (unmerged)
        return {
          pass: false,
          detail: `${unmerged.split("\n").filter(Boolean).length} unmerged path(s) — the baseline is ambiguous`,
          fix: "resolve the conflict(s) (git status shows them), then re-run: pnpm pre-ship",
        };
      const pending = pendingOperation(root);
      if (pending)
        return {
          pass: false,
          detail: `a ${pending} is in progress — the baseline is ambiguous`,
          fix: `finish or abort the ${pending} (git status tells you how), then re-run: pnpm pre-ship`,
        };
      // Discover and fingerprint the exact candidate ship would commit. This
      // snapshot is the non-mutation witness's "before", and it is what ship
      // must still see immediately before its first release mutation.
      ctx.candidateBefore = snapshotCandidate(root);
      if (ctx.candidateBefore.count === 0)
        return {
          pass: false,
          detail:
            "no release candidate — the working tree is identical to HEAD, so there is nothing for ship to commit",
          fix: "finish the intended change first (the release commit is created by pnpm ship, not by pre-ship), then re-run: pnpm pre-ship",
        };
      if (ctx.baseline?.originState === "behind")
        return {
          pass: false,
          detail:
            "local origin/main has commits that are not in HEAD — the push would be rejected",
          fix: "git pull --rebase origin main, resolve, then re-run: pnpm pre-ship (never force-push)",
        };
      return {
        pass: true,
        detail:
          ctx.baseline?.originState === "ahead-or-equal"
            ? `on main, ${ctx.candidateBefore.count} candidate path(s), local origin/main is an ancestor of HEAD`
            : `on main, ${ctx.candidateBefore.count} candidate path(s) (local origin/main unknown — offline)`,
      };
    },
  },
  {
    id: "git-diff-check",
    label: "git diff --check",
    kind: "read",
    desc: "no conflict markers / whitespace errors",
    run(root) {
      for (const args of [
        ["diff", "--check"],
        ["diff", "--cached", "--check"],
      ]) {
        const r = git(args, root);
        if (!r.ok)
          return {
            pass: false,
            detail: `git ${args.join(" ")} found problems`,
            fix: r.stdout || r.stderr || "fix the whitespace/conflict markers",
          };
      }
      return { pass: true, detail: "no conflict markers / whitespace errors" };
    },
  },
  {
    id: "security",
    label: "security",
    kind: "quality",
    desc: "pnpm security — no secrets in committable files",
    cmd: ["pnpm", ["security"]],
    fix: "resolve the findings above (move secrets to .env.local), then re-run: pnpm pre-ship",
  },
  {
    id: "ai-prompts",
    label: "ai-prompts",
    kind: "quality",
    desc: "pnpm check:ai-prompts — committed prompt artifact fresh + prompt contract",
    cmd: ["pnpm", ["check:ai-prompts"]],
    fix: "if the artifact is stale: pnpm generate:ai-prompts and commit it; otherwise fix the contract findings, then re-run: pnpm pre-ship",
  },
  {
    id: "verify",
    label: "verify",
    kind: "quality",
    desc: "pnpm verify — lint + typecheck + format + build",
    cmd: ["pnpm", ["verify"]],
    fix: "fix the failing step above, then re-run: pnpm pre-ship",
  },
  {
    id: "candidate-stable",
    label: "non-mutation",
    kind: "read",
    desc: "release candidate unchanged after the gates",
    run(root, ctx) {
      const before = ctx.candidateBefore;
      if (!before)
        return {
          pass: false,
          detail: "the candidate was never discovered — git-state did not run",
          fix: "this should be impossible; re-run: pnpm pre-ship",
        };
      const after = snapshotCandidate(root);
      if (after.fingerprint === before.fingerprint)
        return {
          pass: true,
          detail: `candidate fingerprint stable (${before.count} path(s))`,
        };
      const drift = compareCandidates(before, after);
      const evidence = [
        drift.added.length ? `+${drift.added.join(", ")}` : null,
        drift.removed.length ? `-${drift.removed.join(", ")}` : null,
        drift.changed.length ? `~${drift.changed.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join(" ");
      return {
        pass: false,
        detail: `a gate changed the release candidate (${evidence}) — the gate must be non-mutating`,
        fix: "restore the candidate (git checkout -- . / remove the stray file), file a bug against the gate, and re-run: pnpm pre-ship — do not ship a candidate the gate itself edited",
      };
    },
  },
];

export const DECISIONS = {
  GREEN: "PRE_SHIP_GREEN",
  BLOCKED: "PRE_SHIP_BLOCKED",
  MANUAL: "MANUAL_RELEASE_REVIEW_REQUIRED",
};

/**
 * Run a gate list. Stops at the first failure (fail closed) and marks the
 * remaining gates SKIPPED. `gates` is injectable so the repository-owned
 * regression proof can exercise the real engine with fixture runners.
 */
export function runGates(root, gates = CANONICAL_GATES, baseline = null) {
  const ctx = { candidateBefore: null, baseline };
  const results = [];
  let blocked = false;
  for (const gate of gates) {
    if (blocked) {
      results.push({
        id: gate.id,
        label: gate.label,
        desc: gate.desc,
        status: "SKIPPED",
      });
      continue;
    }
    const t0 = Date.now();
    let pass = false;
    let detail = "";
    let output = "";
    if (gate.run) {
      const r = gate.run(root, ctx);
      pass = Boolean(r.pass);
      detail = r.detail ?? "";
      if (!pass && r.fix) output = r.fix;
    } else if (gate.cmd) {
      const r = spawnSync(gate.cmd[0], gate.cmd[1], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      pass = r.status === 0;
      detail = pass ? "passed" : `FAILED (exit ${r.status ?? 1})`;
      output = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    } else {
      results.push({
        id: gate.id,
        label: gate.label,
        desc: gate.desc,
        status: "SKIPPED",
      });
      continue;
    }
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({
      id: gate.id,
      label: gate.label,
      desc: gate.desc,
      status: pass ? "PASS" : "FAIL",
      seconds,
      detail,
      output: pass ? "" : output,
    });
    if (!pass) blocked = true;
  }
  return { results, blocked, candidateBefore: ctx.candidateBefore };
}

/**
 * The canonical pre-ship gate. Read-only + offline; returns a report the CLI
 * renders (text or JSON) and ship interprets before any release mutation.
 * `report.candidate` is the exact, fingerprinted release candidate the gates
 * certified — ship must release that candidate and no other.
 */
export function runPreShipGate(root, gates = CANONICAL_GATES) {
  const baseline = collectBaseline(root);
  const { results, blocked, candidateBefore } = runGates(root, gates, baseline);
  // If git-state never discovered a candidate (e.g. a blocked/short-circuited
  // run), still report the live candidate so the operator sees what ship would
  // commit — but the gate result already says not to ship.
  const candidate = candidateBefore ?? snapshotCandidate(root);
  // Risk surfaces cover the candidate AND anything already committed but not
  // yet on origin/main, since the release push would carry both.
  const risk = classifyRisk([
    ...new Set([...candidate.paths, ...baseline.unreleasedFiles]),
  ]);
  const recommendedBump =
    baseline.headSubjects.length > 0
      ? recommendBump(baseline.headSubjects)
      : candidate.count > 0
        ? "PATCH"
        : "MANUAL_DECISION";

  let decision = DECISIONS.GREEN;
  if (blocked) decision = DECISIONS.BLOCKED;
  else if (risk.high.length > 0) decision = DECISIONS.MANUAL;

  const nextAction = nextActionFor(decision, recommendedBump, risk);
  return {
    baseline,
    candidate,
    gates: results,
    risk,
    decision,
    recommendedBump,
    nextAction,
  };
}

export function nextActionFor(decision, bump, risk) {
  if (decision === DECISIONS.BLOCKED)
    return "Fix the failing gate above, then re-run: pnpm pre-ship";
  if (decision === DECISIONS.MANUAL) {
    const routed = risk.elevated
      .flatMap((s) => s.checks)
      .slice(0, 6)
      .map((c) => `  ${c}`);
    return [
      "High-risk surface(s) changed — review them by hand:",
      ...risk.high.map((s) => `  • ${s.label}: ${s.routing}`),
      ...(routed.length
        ? ["Then run the routed offline checks as review evidence:", ...routed]
        : []),
      `After review, ship with explicit acknowledgement: pnpm ship ${bump === "MINOR" ? "minor" : "patch"} --ack-manual-review`,
    ].join("\n");
  }
  if (bump === "MINOR") return "pnpm ship minor";
  if (bump === "PATCH") return "pnpm ship patch";
  return "pnpm ship patch | minor   (no conventional feat/fix commit found — choose the bump yourself)";
}
