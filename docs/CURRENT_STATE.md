# Yakfi — Current State

> Reviewed on 12 November 2026 Cairo. Refresh remote and runtime facts before execution. Use AGENT_RULES.md and DECISIONS_INDEX.md for rules, BUILD_STATE.md for implementation history, and ISS-018_ACCEPTANCE.md for the active acceptance procedure.

## Release and acceptance

- Deployed main reference is `8d12aa2a72169bb2563e624e89045858d090e8f3`, version 0.79.7. PR #79 remains open. Current Preview metadata matches candidate `bae04fcdd45374b043ec22fc5149de743a2a0ada`, version 0.79.8. A READY deployment does not establish bot credential availability or delivery acceptance.
- PR #79 implements Telegram staff delivery, authenticated route authority, durable attempt claiming, read-only status lookup, draft ownership protection, authoritative assignment, and the reviewed explicit operator `--switch` tool. CI run 43247833509 passed with 141 Telegram checks, 48 reply checks, 45 component tests, 14 disposable PostgreSQL scenarios, and Playwright 183 passed / 12 skipped.
- The active blocker is the existing CREDENTIAL_MASTER_KEY missing from Preview. It is present as Sensitive in Production metadata. The latest setup report says GitHub transfer is blocked by missing VERCEL_TOKEN and a new workflow absent from main. The owner believes the original key may be saved on the VPS. Recover and validate the local original securely, set it only for the PR branch Preview, then redeploy.
- The owner confirmed all existing environments, accounts and bots are for testing and authorized reusing the existing customer bot and switching its webhook. A second Manager is unnecessary. Existing-bot staff delivery uses the stored credential reference without the Manager token. Test database contains the exact Afanan business and customer connection, and the candidate migration. Verify decryption, provider identity and admin access before switching.
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
