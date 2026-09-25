# FlowPilot — Release Process

> How FlowPilot gets from working tree to a tagged GitHub release. First
> release: **v0.1.0 — Initial Pilot-Ready Core**. Automated by
> `scripts/release.sh` (`pnpm release`). Per-feature releases (v0.2.0+):
> see "Per-Feature Releases" below.

## Golden Rules

1. **Never release broken code** — all three gates must pass.
2. **Never release secrets** — security scan + pre-commit hook.
3. Releases are **tags on `main`** (annotated, `vMAJOR.MINOR.PATCH`).
4. The GitHub repository stays **private** during the discovery stage.

## Lightweight Operator Ship (`pnpm ship`)

The routine path after a finished prompt. The AI session ends with a green
`pnpm verify` and stops; the human operator then ships with one local
command:

```bash
pnpm ship patch              # 0.14.0 → 0.14.1  (commit: fix: release v0.14.1)
pnpm ship minor              # 0.14.0 → 0.15.0  (commit: feat: release v0.15.0)
pnpm ship --version 0.14.0   # explicit target (must be > current)
```

`scripts/ship.mjs` (dependency-free Node) performs: safety validation →
version bump → one conventional commit (pre-commit secret hook stays
active) → annotated tag `vX.Y.Z` (always exactly matching package.json) →
push `main` + tag → published GitHub Release. It does **not** re-run the
full build gate — the prompt's `pnpm verify` is the gate — and never
deploys or touches the database. Production must be promoted separately:
for the CLI-linked `flowpilot-prod` project, run `pnpm deploy:production`
after ship and confirm `/api/health` reports the new version (see
`VERCEL_DEPLOYMENT.md` Section 4).

Safety: `main`-branch only; refuses existing tags (local + origin), major
bumps, and non-fast-forward pushes; no force flags anywhere; failures
print exact recovery commands. Tag/release titles are derived from
`BUILD_STATE.md` — no invented work.

**`pnpm ship` vs `pnpm release`**: ship = lightweight routine operator
shipping after a verified prompt; release = the full gated path below
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

- `v0.x.x` — Spec A pilot iterations (current line: **v0.29.0**)
- Bump MINOR when a roadmap milestone completes (e.g., Spec A exit criteria
  met → `v1.0.0`); PATCH for fixes within a milestone.
- No semver ceremony while pre-1.0 — the tag notes carry the narrative.

## Rollback / Recovery

| Situation                      | Recovery                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Tag pushed but release wrong   | `gh release delete <tag> && git push origin :refs/tags/<tag>` then redo                         |
| Repo created but push rejected | Fix locally, `git push -u origin main` again (script is re-runnable)                            |
| Secret leaked in a commit      | Rotate the secret FIRST, then `git rm --cached <file>` + history rewrite with operator approval |
| Everything wrong               | Delete the repo (`gh repo delete --yes`) — it is private and re-creatable                       |

## See Also

`GITHUB_WORKFLOW.md` (how we use GitHub day-to-day) · `BUILD_STATE.md`
(current state).
