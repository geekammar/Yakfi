<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# FlowPilot Agent Guidelines & Execution Rules

> Authoritative project rules: [docs/AGENT_RULES.md](docs/AGENT_RULES.md).
> Follow context tiers and the VPS execution boundary.

## Mandatory Development & Verification Rules (DEVOPS-01E / VPS boundary)

1. **VPS execution boundary (all tasks)**:
   - On the VPS, use source/text inspection, editing and Git only.
   - Do NOT run package installation, code generation, app runtime or a development server, formatter, lint, typecheck, tests, builds, or database commands (migrations, push, seed, studio) on the VPS.
   - Do NOT invoke package scripts such as `pnpm verify`, `pnpm verify:local`, `pnpm verify:fast`, `pnpm check:*`, `pnpm context`, `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm build`, `pnpm db:*` or `next` on the VPS.
2. **Authorized check execution**:
   - Required checks run in existing GitHub Actions CI or an authorized isolated cloud runner.
   - Full quality gating (`pnpm verify`, Next.js build, and Playwright UX QA) is owned by GitHub Actions (`pr-validation.yml`) and Vercel.
   - Do not claim a check passed unless it actually ran in the authorized environment.
3. **CI-First PR Verification**:
   - Push the feature branch and open a PR; CI is the verification authority.
   - Do not claim a feature or PR is complete until required GitHub Actions CI checks pass.
4. **Version gate**:
   - Do not bump the application version for documentation-only changes.
   - The current mandatory `pnpm check:version` gate has no docs-only exemption; this is an unresolved release-tooling scope decision. Do not bypass, disable or falsely mark it.
5. **Database Safety**:
   - Do not execute database commands on the VPS.
   - Production migrations are operator-authorized and triggered via `.github/workflows/production-db-migrate.yml`; never automatic.
