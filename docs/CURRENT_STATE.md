# Yakfi — Current State

> Reviewed on 12 November 2026 Cairo. Refresh remote and runtime facts before execution. Use AGENT_RULES.md and DECISIONS_INDEX.md for rules, BUILD_STATE.md for implementation history, and ISS-018_ACCEPTANCE.md for the active acceptance procedure.

## Release and acceptance

- Deployed main reference is `8d12aa2a72169bb2563e624e89045858d090e8f3`, version 0.79.7. PR #79 remains open. Current Preview metadata matches candidate `bae04fcdd45374b043ec22fc5149de743a2a0ada`, version 0.79.8.
- PR #79 implements Telegram staff delivery, authenticated route authority, durable attempt claiming, read-only status lookup, draft ownership protection, authoritative assignment, and the reviewed explicit operator `--switch` tool. CI run 43247833509 passed with 141 Telegram checks, 48 reply checks, 45 component tests, 14 disposable PostgreSQL scenarios, and Playwright 183 passed / 12 skipped.
- CREDENTIAL_MASTER_KEY was configured in Vercel Preview metadata (scoped to branch `fix/safe-telegram-staff-reply-delivery` as Secret) and the preview was redeployed (`dpl_48Hc8d79vCE2wgXUf7Yu85HZekvP`, deployment READY at `https://flowpilot-prod-git-fix-safe-telegram-staff-reply-36d980-ammarj1.vercel.app`). Test admin sign-in via `/api/auth/sign-in/email` is verified functional (HTTP 200, session issued, user `6c8fa983-b255-4e40-9146-fa62d0c4c260` in business `f5314115-ae8c-46ea-9d7e-080ef5e7366d`).
- The remaining blocker is credential decryption for the existing customer bot `@Drafnanafnanbot`: server action `checkTelegramConnectionAction` on Preview invokes `defaultCredentialsResolver.resolve(connection.credentialsRef)` and fails closed with `code: "CREDENTIALS_UNAVAILABLE"` (`"بيانات الاعتماد غير متاحة"`). Candidate keys from GitHub Secrets and `.env.local` both fail GCM tag validation or reference lookup in test DB `br-plain-smoke-a5k0bivr`. Because decryption cannot be established from the stored package and key rotation is unauthorized, provider `getMe` verification and live `--switch --apply` remain held. Historical Executions row 249 remains preserved. See `docs/ISS-018_ACCEPTANCE.md` for exact restoration commands and Muse acceptance handoff.
- AGY reports healthy Preview and successful test admin sign-in. Reviewer verified deployment metadata, source and CI, but did not independently repeat sign-in or a customer delivery. Muse acceptance is pending. Historical Executions row 249 remains the original UI-29 / ISS-018 FAIL; append a new execution at the next free row.
- PR #77 is a separate P2 candidate at `42f58dd02130543664f3feb886a0aa17316ef5eb`. BK-41 A/C/D and part of B have prior evidence; exact inactive-service Step B acceptance remains pending. Both #77 and #79 propose 0.79.8, so recheck main and SemVer when ordering merges.
- ISS-017 clean and valid-session paths passed live. Invalid-cookie testing was tool-blocked. Booking BK-03/33/34 have prior post-#69 results to reconcile. TG-22 / ISS-012 is deployed through #74 with live acceptance pending.

## Execution order

1. Recover the original key on the owner's VPS in a fresh AGY session. Follow ISS-018_ACCEPTANCE.md to configure Preview, verify credentials, dry-run and apply the authorized customer bot switch. Then a fresh Muse session verifies inbound /start and one staff reply arriving once.
2. After acceptance and owner approval, execute the exact reviewed production migration before merging because main auto-deploys. Preserve route and submission tables during application rollback. Complete high-impact TG-22 and booking evidence gaps.
3. UX Conversation Lab acceptance with an authorized Platform Operator and isolated welcome.intro verification.
4. Cost & Price. Review the frozen design and implement the smallest cost-evidence persistence slice.
5. Real-business pilot and Spec A exit. Spec B evidence and Spec C vertical selection follow. Defer P2/P3 polish until after Lab and Cost & Price.

## Binding constraints

One ConversationEngine and server-authoritative Booking Core. Egyptian Arabic free text uses structured semantic decisions. No keyword lists, dictionaries, regex, substring or token-overlap intent heuristics. Formal commands, IDs, dates and permissions may use deterministic validation.

AGY implements and supplies technical evidence. Muse records black-box outcomes. The reviewer maintains checkpoints and recommends acceptance. The owner approves decisions and merges.

[PR #79](https://github.com/geekammar/Yakfi/pull/79) · [QA register](https://docs.google.com/spreadsheets/d/1ywijLhpIrr3BCkMHil2voeiZoW4LiLc8Sd-4oB0qvDU/edit) · [Recovery folder](https://drive.google.com/drive/folders/1limgPzcq_CykylK4kaC0OwzgxGGr3jWo)
