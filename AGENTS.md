<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# FlowPilot Agent Guidelines & Execution Rules

> Authoritative project rules: [docs/AGENT_RULES.md](file:///root/projects/flowpilot/docs/AGENT_RULES.md).
> Follow context tiers and lightweight development practices.

## Mandatory Development & Verification Rules (DEVOPS-01E)

1. **Lightweight Local Verification**:
   - Use `pnpm verify:local` (or `pnpm verify:fast`) during local iteration.
   - **Do NOT** execute `pnpm build` or full `pnpm verify` locally after edits on the VPS. Full production compilation is delegated to GitHub Actions CI and Vercel.
2. **Resource-Safe Execution**:
   - Never run multiple heavy processes (build, typecheck, lint, or test suites) concurrently on the VPS.
   - VPS has 0B Swap; monitor available memory with `free -h` and active processes with `ps aux --sort=-%mem | head -n 10`.
   - Distinguish slow progress from freezes by observing CPU execution time progression (`ps -o pid,stat,time,%cpu,comm -p <PID>`).
3. **CI-First PR Verification**:
   - Verify targeted domain suites (`pnpm check:<module>`) and lightweight local checks (`pnpm verify:local`) before committing.
   - Ensure SemVer is incremented (`pnpm check:version`).
   - Push to feature branch and open a PR.
   - Full quality gating (`pnpm verify`, Next.js build, and Playwright UX QA) is owned by GitHub Actions (`pr-validation.yml`).
   - Do not claim a feature or PR is complete until GitHub Actions CI checks pass.
4. **Database Safety**:
   - Never execute production database migrations automatically from local development.
   - Production migrations are operator-authorized and triggered via `.github/workflows/production-db-migrate.yml`.
