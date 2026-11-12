# ISS-018 — Existing Bot Acceptance

Reviewed on 12 November 2026 Cairo. Active procedure and verification status for PR #79 (`fix/safe-telegram-staff-reply-delivery`). Historical Telegram onboarding notes retain their original dates and evidence.

## Candidate and identities

- Candidate SHA: `bae04fcdd45374b043ec22fc5149de743a2a0ada` (verified exact match with PR #79 current HEAD).
- Branch: `fix/safe-telegram-staff-reply-delivery`; Vercel project `flowpilot-prod`.
- Business ID: `f5314115-ae8c-46ea-9d7e-080ef5e7366d`.
- Customer connection ID: `1d2cdf87-2bee-4f26-aad5-5ab9efd1c716`; bot `@Drafnanafnanbot`.
- Test Neon branch: `br-plain-smoke-a5k0bivr` in project `mute-smoke-35342256` (`ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech`). Verified connected and non-production (`isProductionDb: false`).
- Main reference: `8d12aa2a72169bb2563e624e89045858d090e8f3` (v0.79.7).
- Owner authorization: Confirmed prelaunch test assets. Authorized customer bot `@Drafnanafnanbot` Preview switch. Manager Bot remains unchanged; no new Manager needed.

## Verification Status & Gate Results

| Gate | Status | Verified Reality & Evidence |
| :--- | :---: | :--- |
| **1. PR #79 Candidate SHA** | **PASS** | Current HEAD is `bae04fcdd45374b043ec22fc5149de743a2a0ada`. Matches last reviewed SHA exactly; zero unreviewed commits. |
| **2. Vercel Preview Metadata** | **PASS** | `CREDENTIAL_MASTER_KEY` verified present in project `flowpilot-prod`, sensitive (`Secret`), scoped specifically to `Preview` and branch `fix/safe-telegram-staff-reply-delivery`. |
| **3. Deployment & Origins** | **PASS** | Cloud redeployment `dpl_48Hc8d79vCE2wgXUf7Yu85HZekvP` (and `dpl_CTuTuZQq7fGEMXRrovcfG8q7gfKX`) verified `● Ready`. Deployed SHA: `bae04fcdd45374b043ec22fc5149de743a2a0ada`. Connected DB: `ep-little-mouse-a5nh644n-pooler.us-east-2.aws.neon.tech`. Effective origin: `https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app` matches webhook destination `/api/telegram/webhook`. |
| **4. Admin Access** | **PASS** | Normal sign-in via `POST /api/auth/sign-in/email` with `preview.admin@flowpilot.app` returns HTTP 200, valid session cookie, user `6c8fa983-b255-4e40-9146-fa62d0c4c260` (`ADMIN`), business `f5314115-ae8c-46ea-9d7e-080ef5e7366d`. Navigation to `/admin`, `/conversations`, and `/settings/telegram` returns HTTP 200. |
| **5. Credential Resolution & Bot Identity** | **BLOCKED** | On `/settings/telegram`, connection `1d2cdf87-2bee-4f26-aad5-5ab9efd1c716` is rendered as connected with bot `@Drafnanafnanbot`. Server action `checkTelegramConnectionAction` calls `defaultCredentialsResolver.resolve(connection.credentialsRef)`. Master key is decoded to 32 bytes, but stored package resolution returns `{ success: false, code: "CREDENTIALS_UNAVAILABLE", message: "بيانات الاعتماد غير متاحة" }`. Both transferred GitHub secret and local `.env.local` candidate keys fail GCM tag validation or reference lookup in test DB. Decryption and `getMe` verification blocked without rotating encryption key. |
| **6. Webhook Switch & Ingress** | **HELD** | Switch tool verified offline (141 checks). Dry run and live apply held pending unblocking of Gate 5 bot token resolution. |

## Webhook Switch and Restoration Procedure

### Planned Webhook Switch (Dry Run)
```bash
pnpm telegram:repair-webhook \
  --switch \
  --business-id f5314115-ae8c-46ea-9d7e-080ef5e7366d \
  --connection-id 1d2cdf87-2bee-4f26-aad5-5ab9efd1c716 \
  --expected-current-url https://flowpilot-prod.vercel.app/api/telegram/webhook \
  --destination-url https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app/api/telegram/webhook
```

### Planned Webhook Switch (Apply)
```bash
pnpm telegram:repair-webhook \
  --switch \
  --business-id f5314115-ae8c-46ea-9d7e-080ef5e7366d \
  --connection-id 1d2cdf87-2bee-4f26-aad5-5ab9efd1c716 \
  --expected-current-url https://flowpilot-prod.vercel.app/api/telegram/webhook \
  --destination-url https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app/api/telegram/webhook \
  --apply
```

### Accurate Restoration Command (Return to Production)
> [!IMPORTANT]
> Restoration must use the database and credential key belonging to the restoration destination (Production), not blindly reusing the Preview configuration.
```bash
pnpm telegram:repair-webhook \
  --switch \
  --business-id f5314115-ae8c-46ea-9d7e-080ef5e7366d \
  --connection-id 1d2cdf87-2bee-4f26-aad5-5ab9efd1c716 \
  --expected-current-url https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app/api/telegram/webhook \
  --destination-url https://flowpilot-prod.vercel.app/api/telegram/webhook \
  --apply
```

## Muse Acceptance Handoff

Start a new Muse session once Gate 5 credential resolution is unblocked.
- **Exact Preview Base URL:** `https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app`
- **Deployed Commit SHA:** `bae04fcdd45374b043ec22fc5149de743a2a0ada`
- **Customer Bot:** `@Drafnanafnanbot`
- **Test Tenant / Business ID:** `f5314115-ae8c-46ea-9d7e-080ef5e7366d` (`عيادة الدكتورة أفنان للأسنان`)
- **Connection ID:** `1d2cdf87-2bee-4f26-aad5-5ab9efd1c716`
- **Admin User:** `6c8fa983-b255-4e40-9146-fa62d0c4c260` (`preview.admin@flowpilot.app`)
- **Acceptance Journey to Execute:**
  1. Customer sends `/start` to `@Drafnanafnanbot`.
  2. Conversation appears in Preview `/conversations`.
  3. Staff sends a unique reply through Preview conversation UI.
  4. Customer receives the exact reply once in Telegram chat.
  5. UI state, draft retention, and assignment behavior are checked.
- **QA Register:** Preserve historical QA row 249 (`R3-UI-29-A1`). Append new execution at next unused row. Do not mark Muse acceptance PASS until live delivery is observed.

## Release Constraints

- Merging requires owner authorization alone.
- Do NOT merge PR #79 or PR #80.
- Production migration must be applied via `.github/workflows/production-db-migrate.yml` before merge.
