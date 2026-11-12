# ISS-018 — Existing Bot Acceptance

Reviewed on 12 November 2026 Cairo. This is the active procedure for PR #79. Historical Telegram onboarding notes retain their original dates and evidence.

## Candidate and identities

- Candidate SHA `bae04fcdd45374b043ec22fc5149de743a2a0ada`.
- Branch `fix/safe-telegram-staff-reply-delivery`; Vercel project `flowpilot-prod`.
- Business `f5314115-ae8c-46ea-9d7e-080ef5e7366d`.
- Customer connection `1d2cdf87-2bee-4f26-aad5-5ab9efd1c716`; bot `@Drafnanafnanbot`.
- Test Neon branch `br-plain-smoke-a5k0bivr` in project `mute-smoke-35342256`. Verify the actual endpoint before writes.
- Main reference `8d12aa2a72169bb2563e624e89045858d090e8f3`. Existing migration evidence confirms the candidate migration on test and absent from main at the prior check.

The owner confirmed these environments and identities are for testing and authorized the existing customer bot's Preview switch. The Manager token is not consumed by existing customer delivery. Provisioning and a new Manager are not prerequisites.

## Current blocker and key recovery

CREDENTIAL_MASTER_KEY is absent from Preview metadata. The owner believes its original value is saved on the VPS. In a fresh AGY session, inspect only the project environment, local configuration and known project environment files. Do not print values, file contents, tokens, shell history or raw environment output. Report candidate file paths and validation outcomes only.

Read candidate keys programmatically with shell tracing disabled. Check encoding using the existing credential-store logic and prove a match by resolving only the intended tenant's credential. Never rotate the key or rewrite ciphertext to make a candidate pass. If no key matches, stop recovery and report the precise missing source.

Set the matching existing value as Sensitive only for the named Preview branch, preserving Production and other branches. Use secure stdin or an authenticated API body from memory, never a command-line secret argument or committed file. Remove only task-created temporary secret files.

GitHub Secrets metadata does not expose plaintext. A new workflow_dispatch file must exist on the default branch to be manually triggered; this does not prohibit dispatching an existing eligible workflow with a feature-branch ref. A secret-injected transfer requires a reviewed, actually dispatchable workflow and working Vercel authentication. Local recovery is the preferred route while the owner believes the original key is available.

## Preview verification and switch

Redeploy the reviewed SHA with the branch settings. Verify the deployment SHA, effective DB, candidate migration, auth origin and actual test admin access. Resolve the stored credentials and verify the bot through getMe. Never infer readiness from CONNECTED alone or from the health endpoint's host-name heuristic.

Use the reviewed `pnpm telegram:repair-webhook --switch` tool. Specify exact business/connection IDs, actual current provider URL and intended destination. Default dry run must pass before --apply. Preserve pending updates and verify subscriptions and destination DB secret persistence. Treat partial failure or network uncertainty as unresolved until reconciled. An ordinary repair --expected-url operation cannot change a different current URL.

Record the provider URL before mutation, actual destination, target DB identity, tool SHA and redacted outcome. Leave the Manager webhook unchanged unless a separate provisioning task needs it.

## Restoration

A reverse switch must use the database of the destination being restored and that database's matching credential key. Returning the provider URL to main while writing a new secret hash only to the Preview/test DB leaves main unable to authenticate. Verify the original main connection, current provider URL and destination before a reverse dry run and apply. Preserve audit data. Do not claim that swapping URL strings alone completes restoration.

## Muse acceptance

Start a new Muse session after the configuration gates are proven. Use the designated test Telegram account to send /start, confirm authenticated inbound and the authoritative route, then send one unique staff reply through Preview. Observe the exact reply once on the customer account. Provider acceptance and customer observation are separate evidence. Recheck is read-only and must not resend.

Preserve historical row 249. Append at the next unused execution row; do not assume row 250 is still free. Record exact SHA, deployment URL, test identities, timestamps and evidence. Do not infer wire-call counts from a black-box observation.

## Release

Owner alone merges. Recheck main, SemVer and CI. Apply the reviewed additive production migration through the authorized workflow before merge because main auto-deploys. Application rollback preserves the route and submission tables. The acceptance setup does not authorize a merge or production migration.
