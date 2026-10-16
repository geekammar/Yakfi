# FlowPilot — Release Process

> How FlowPilot gets from working tree to a tagged GitHub release. First
> release: **v0.1.0 — Initial Pilot-Ready Core**. Automated by
> `scripts/release.sh` (`pnpm release`). Per-feature releases (v0.2.0+):
> see "Per-Feature Releases" below.

## Golden Rules

1. **Never release broken code** — the canonical pre-ship gate must pass.
2. **Never release secrets** — security scan + pre-commit hook.
3. Releases are **tags on `main`** (annotated, `vMAJOR.MINOR.PATCH`).
4. The GitHub repository stays **private** during the discovery stage.
5. **The repository owns the release gate.** Release safety never depends on
   remembering an external prompt — `pnpm pre-ship` is the one canonical
   checkpoint, and `pnpm ship` enforces it before touching anything.
6. **Ship owns the release commit.** The invariant is an _exact, inspected,
   stable release candidate_ — NOT a clean working tree. A finished
   implementation lives in the working tree; `pnpm pre-ship` certifies that
   candidate and `pnpm ship` commits it. Nobody commits the implementation by
   hand before shipping.

## The routine flow

```
implementation
  → working-tree release candidate
  → pnpm pre-ship                      (repository-owned gate + report)
  → human reviews the evidence and chooses PATCH / MINOR / no ship
  → pnpm ship patch | minor [--ack-manual-review]
  → one release commit + annotated tag + GitHub main + Release
  → Vercel promotion (separate operator action)
  → post-ship verification (GET /api/health)
```

`pnpm pre-ship` does not ship. `pnpm ship` does not deploy or migrate. A
Production migration is always a separately controlled operator action.

## The Release Candidate

The **release candidate** is the exact set of non-ignored changes that
`pnpm ship` will commit with its single release commit. It is discovered from
two git primitives, so nothing can escape inspection:

- `git diff HEAD --name-only` — tracked changes versus HEAD: unstaged
  modifications, staged modifications, staged additions, and deletions;
- `git ls-files -o --exclude-standard` — new untracked files that are not
  gitignored.

That set is _identical_ to what `git add -A` stages (proven by
`pnpm check:pre-ship` R2d). `git status --porcelain` is deliberately **not**
the source of truth: it collapses an untracked directory to a single `?? dir/`
line, which would hide the individual files ship would commit.

Files git ignores (`.next/`, `*.tsbuildinfo`, `next-env.d.ts`, `.env*`,
`node_modules`, …) are **never** part of the candidate, so building the
project during the gate cannot create candidate drift.

`pnpm pre-ship` lists every candidate path (with a `new` / `modified` /
`deleted` status) and prints a sha256 **fingerprint** of the whole candidate.
`pnpm ship` re-computes that fingerprint immediately before its first release
mutation and requires it to match the one the gate certified.

### Required baseline state (fail-closed)

| State                                                        | Result                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| branch is `main`                                             | required; anything else (incl. detached HEAD) is rejected |
| a non-empty release candidate                                | a tree identical to HEAD means "nothing to release"       |
| no unmerged paths (`git ls-files -u`)                        | a conflict makes the baseline ambiguous                   |
| no unfinished merge / rebase / cherry-pick / revert / bisect | the baseline is ambiguous                                 |
| local `origin/main` is an ancestor of HEAD                   | otherwise the push would be rejected (never force-push)   |

### Allowed versus forbidden working-tree state

- **Allowed (and normal):** modified tracked files, staged changes, new
  untracked non-ignored files, deletions. That is the candidate. This is why
  a dirty tree is **not** a pre-ship failure.
- **Forbidden:** anything in the table above; a candidate containing a secret
  (the security gate scans the whole candidate, untracked files included);
  a candidate that changes while the gates are running (the non-mutation
  witness fails closed).
- **Surfaced, not forbidden:** local commits that are not yet on `origin/main`.
  They would ship with the release, so they are added to the risk surfaces and
  reported, and the operator is told how many there are.

### Untracked files

An untracked non-ignored file is a first-class candidate path: it is listed in
the report, it is inside the fingerprint, the secret scanner reads it, and
`pnpm ship` verifies the staged release contains exactly the reviewed set —
so no untracked file can be swept into `git add -A` unseen. An _ignored_
untracked file (a build artifact, `.env.local`) is outside the candidate and
never committed.

## Canonical Pre-Ship Gate (`pnpm pre-ship`)

The ONE repository-owned pre-release checkpoint. It composes existing
canonical commands — it reimplements none of them:

| #   | Gate            | Command                 | Why it belongs in EVERY release                                                                                                                                       |
| --- | --------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | git state       | (internal)              | Branch is `main`; the baseline is unambiguous; the candidate is non-empty and exactly enumerated; local `origin/main` is not ahead.                                   |
| 2   | whitespace      | `git diff --check`      | Conflict markers / whitespace errors must never land in a release commit.                                                                                             |
| 3   | secrets         | `pnpm security`         | Never release a secret. Scans the whole candidate — tracked **and untracked** files. Offline; no Production credentials required.                                     |
| 4   | prompt contract | `pnpm check:ai-prompts` | The committed generated prompt artifact must match the `prompts/` sources. Runs **before** verify because `next build` regenerates the artifact and would mask drift. |
| 5   | quality         | `pnpm verify`           | lint + typecheck + format + build. Never release broken code.                                                                                                         |
| 6   | non-mutation    | (internal)              | Re-fingerprints the candidate after the gates and requires it to be byte-identical — a gate that mutates the candidate fails closed.                                  |

The gate is strictly **non-mutating and offline**: no `git add/commit/push/tag`,
no GitHub Release, no deploy, no Vercel, no migration, no `db push`/`db seed`,
no DB write, no provider call, no eval/probe run, no customer action, and no
Production secrets. It only reads repository state and runs sanctioned offline
quality checks. It never bumps `package.json` and never invokes `pnpm ship`;
the human operator remains the SemVer authority.

**Risk-surface detection.** The gate inspects the candidate plus any committed
work not yet on `origin/main`, and classifies high-blast-radius surfaces. If a
change is high-risk — DB schema/migration, auth/security boundary,
release/deployment tooling, deploy/CI configuration, or the environment
contract — the machine cannot certify it and the decision is
`MANUAL_RELEASE_REVIEW_REQUIRED`; `pnpm ship` then requires an explicit
`--ack-manual-review`. Elevated surfaces (AI prompts/provider, conversation
engine, booking domain, transports, Copy Lab) are routed to the offline
`check:*` suite that owns them as review evidence; they are not run on every
release because they are surface-specific, not release-wide.

**Report.** `pnpm pre-ship` prints a stable, phone-friendly summary (branch,
HEAD, version, latest tag, local commits ahead, the full release candidate
inventory with its fingerprint, risk surfaces, gate results, decision,
recommended bump, next human action). `pnpm pre-ship --json` emits the same
shape machine-readable for later GitHub Actions reuse. Exit codes:
`0 = PRE_SHIP_GREEN`, `1 = PRE_SHIP_BLOCKED`,
`2 = MANUAL_RELEASE_REVIEW_REQUIRED`.

**Regression proof.** `pnpm check:pre-ship` (scripts/check-pre-ship.mjs) proves
the contract non-vacuously against throwaway fixture repositories, driving the
real gate engine, the real `pre-ship` and `ship` CLIs, and the real secret
scanner: R1–R12 cover a modified tracked candidate, untracked files that cannot
escape inspection, a failing gate blocking ship before any mutation, a mutating
gate failing closed, the HIGH-risk manual-review path with and without the
acknowledgement, ambiguous baselines failing closed, the real OPS-REL-01
candidate reaching the correct decision, the release-mutation seam exactness, a
secret in an untracked file blocked without printing its value, and the real
working tree remaining untouched.

## MANUAL_RELEASE_REVIEW_REQUIRED

The machine found a high-blast-radius surface it cannot mechanically certify:
DB schema/migration, the auth/security boundary, release/deployment tooling,
deploy/CI configuration, or the environment contract. A human must review that
surface (the report prints where to look and which offline `check:*` commands
are the evidence), then ship with the acknowledgement.

`--ack-manual-review` means exactly one thing: **a human reviewed the high-risk
surface named in the report.** It does NOT mean "skip the gate". If any
mandatory gate fails, the decision stays `PRE_SHIP_BLOCKED` and ship exits
before its first mutation regardless of the flag — the acknowledgement is never
a bypass. It also never licenses a different tree: ship re-checks the candidate
fingerprint, so the release is the candidate the human actually reviewed.

## Lightweight Operator Ship (`pnpm ship`)

The routine path after a finished prompt. The AI session ends with a reviewed
`pnpm pre-ship` report and stops; the human operator chooses the bump and ships
with one local command:

```bash
pnpm ship patch               # 0.14.0 → 0.14.1  (commit: fix: release v0.14.1)
pnpm ship minor               # 0.14.0 → 0.15.0  (commit: feat: release v0.15.0)
pnpm ship --version 0.14.0    # explicit target (must be > current)
pnpm ship patch --ack-manual-review   # after a human reviewed a
                                       # MANUAL_RELEASE_REVIEW_REQUIRED diff
```

`scripts/ship.mjs` (dependency-free Node) performs, in order:

1. **discover the exact release candidate** and fingerprint it;
2. **the canonical pre-ship gate** — the same one `pnpm pre-ship` runs, from
   `scripts/pre-ship-lib.mjs`, never a second copy of the logic;
3. **re-prove the candidate** matches the fingerprint the gate certified;
4. risk classification — require `--ack-manual-review` when the decision is
   `MANUAL_RELEASE_REVIEW_REQUIRED`;
5. publish-context validation (tag free locally and on `origin`, `origin/main`
   is an ancestor of HEAD, `gh` authenticated);
6. version bump → `git add -A` → **verify the staged release is exactly the
   reviewed candidate plus the version-bump delta, and nothing else**;
7. one conventional release commit (pre-commit secret hook stays active) →
   annotated tag `vX.Y.Z` (always exactly matching package.json) → push
   `main` + tag → published GitHub Release.

If the gate blocks, or if the stage is not exactly the reviewed candidate,
ship exits **before changing package.json or any git state**. Ship never
deploys and never touches the database. Production must be promoted
separately: for the CLI-linked `flowpilot-prod` project, run
`pnpm deploy:production` after ship and confirm `/api/health` reports the new
version (see `VERCEL_DEPLOYMENT.md` Section 4).

Safety: `main`-branch only; refuses an empty candidate, an ambiguous baseline,
existing tags (local + origin), major bumps, and non-fast-forward pushes; no
force flags anywhere; failures print exact recovery commands. Tag/release
titles are derived from `BUILD_STATE.md` — no invented work.

**`pnpm ship` vs `pnpm release`**: ship = lightweight routine operator shipping
gated by the canonical pre-ship gate; release = the full gated path below
(gh auth → doctor → verify → security), unchanged, for recovery or
high-confidence releases. Both produce the same artifact shape (annotated
`vX.Y.Z` tag on `main` + GitHub Release), so they never contradict.

## One-Command Release

```bash
pnpm release                    # repo "flowpilot", tag v0.1.0
bash scripts/release.sh [repo] [tag] [notes-file]
```

The script is safe to re-run (idempotent commit/tag/remote/release steps) and
stops at the FIRST failed gate without touching GitHub.

## Prerequisites (once per machine)

```bash
gh auth login     # GitHub.com → HTTPS → "Login with a web browser"
```

and a working environment (`pnpm run doctor` → READY), which mainly means a
real `DATABASE_URL` in `.env.local`.

## Gates (in order)

| #   | Gate    | Command           | Blocks when…                                       |
| --- | ------- | ----------------- | -------------------------------------------------- |
| 0   | gh auth | `gh auth status`  | not logged into GitHub                             |
| 1   | health  | `pnpm run doctor` | any blocking issue (env, DB connection, toolchain) |
| 2   | quality | `pnpm verify`     | lint / typecheck / format / build fails            |
| 3   | secrets | `pnpm security`   | any secret finding in committable files            |

## What the script does after the gates

1. Verifies branch is `main`
2. `git add -A` (pre-commit hook re-scans staged content)
3. Commit `feat: initial pilot-ready release` (skipped if nothing staged)
4. Annotated tag (default `v0.1.0`)
5. Creates private repo `flowpilot` + `origin` remote (if missing):
   `gh repo create flowpilot --private --source=. --remote=origin`
6. `git push -u origin main` + `git push origin <tag>`
7. `gh release create <tag> --verify-tag --title "FlowPilot <tag>" --notes …`

## Per-Feature Releases (v0.2.0+)

`scripts/release.sh` accepts an optional third argument — a notes file —
added in PROMPT-03 as the smallest extension supporting per-feature
SemVer releases (gates and v0.1.0 defaults are unchanged):

```bash
# notes file: first line = release subject, remaining lines = notes body
bash scripts/release.sh flowpilot v0.2.0 release-notes.md
```

- Composed annotated-tag message and GitHub Release title:
  `FlowPilot <tag> — <subject>` (e.g.
  `FlowPilot v0.2.0 — Invitation Creation Foundation`).
- The notes body becomes the GitHub Release notes.
- The script's release commit step stays a no-op when the tree is
  already committed (the normal case: each feature prompt lands its own
  atomic commit first; only stray changes would be swept into the
  hardcoded initial-release commit message).
- Version choice: inspect existing tags first (`git tag`), then bump
  MINOR for a new feature / PATCH for a fix (pre-1.0).

## Manual Equivalent (for reference)

```bash
gh auth status                      # must be logged in
pnpm run doctor && pnpm verify && pnpm security
git switch main && git add -A && git commit -m "feat: initial pilot-ready release"
git tag -a v0.1.0 -m "FlowPilot v0.1.0 — Initial Pilot-Ready Core"
gh repo create flowpilot --private --source=. --remote=origin \
  --description "WhatsApp Appointment Conversion System — book more, chase less."
git push -u origin main && git push origin v0.1.0
gh release create v0.1.0 --verify-tag --title "FlowPilot v0.1.0" \
  --notes "Initial Pilot-Ready Core — see docs/BUILD_STATE.md"
```

## Versioning

- `v0.x.x` — Spec A pilot iterations (current line: **v0.46.1**)
- Bump MINOR when a roadmap milestone completes (e.g., Spec A exit criteria
  met → `v1.0.0`); PATCH for fixes within a milestone.
- No semver ceremony while pre-1.0 — the tag notes carry the narrative.

## Rollback / Recovery

| Situation                        | Recovery / Limitations                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Tag pushed but release wrong     | `gh release delete <tag> && git push origin :refs/tags/<tag>` then redo                                 |
| Defective commit pushed to main  | Revert with `git revert <commit>` and push forward to `main`; never force-push                          |
| Vercel deployment broken         | Instant rollback in Vercel project dashboard to previous stable deployment                              |
| Production DB migration rollback | Prisma has no automated down-migrations; apply forward-fix migrations or restore backup in Neon console |
| Repo created but push rejected   | Fix locally, `git push -u origin main` again (script is re-runnable)                                    |
| Secret leaked in a commit        | Rotate the secret FIRST, then `git rm --cached <file>` + history rewrite with operator approval         |
| Catastrophic failure             | Re-clone from remote or restore from backup; repo is private and re-creatable                           |

## See Also

`GITHUB_WORKFLOW.md` (how we use GitHub day-to-day) · `BUILD_STATE.md`
(current state).
