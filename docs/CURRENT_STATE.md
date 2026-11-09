# Yakfi — Current State

> Tier 0 orientation. Verified on 9 November 2026 at 19:11 Cairo. Refresh volatile facts before executing work. See `AGENT_RULES.md`, `DECISIONS_INDEX.md`, and the relevant technical docs. Use `BUILD_STATE.md` for implementation history and candidate evidence.

## Verified release and acceptance

- [Main](https://github.com/geekammar/Yakfi/commit/8d12aa2a72169bb2563e624e89045858d090e8f3) and [Production health](https://flowpilot-prod.vercel.app/api/health) matched `8d12aa2a72169bb2563e624e89045858d090e8f3` and `0.79.7`. Database connected and deploymentReady=true at the check.
- PRs #73–76 were merged. [PR #77](https://github.com/geekammar/Yakfi/pull/77) was open on `42f58dd02130543664f3feb886a0aa17316ef5eb` (candidate `0.79.8`). Reviewer verified the inactive-only lookup result, the off-page active regression, [CI](https://github.com/geekammar/Yakfi/actions/runs/42522320282), and matching Preview metadata. CI recorded 23 settings tests passed and Playwright 183 passed / 12 skipped. Preview DB isolation and Step B live acceptance remain pending. Keep P2 separate from high-impact QA.
- ISS-017 clean and valid-session paths passed live. Invalid-cookie recovery remains blocked on Muse browser capability. BK-41 execution R2-BK-41-A1 (row 248) verified save, replacement and explicit clear. The named inactive-service behavior still needs exact-release acceptance.
- Spec A is in pre-pilot acceptance. Booking, staff console and channel adapters are built. A successful live business pilot is the exit gate.

## Execution order

1. High-impact acceptance. Reconcile existing BK-03/33/34 evidence after #69. Retest only gaps. UI-29 / ISS-018 is the next P1: execution R3-UI-29-A1 (row 249) reproduced staff-reply non-delivery on 0.79.7. Source review confirmed `sendStaffReply` persists the staff message and returns success without calling outbound transport. The read-only audit is complete. The reviewer scoped the next candidate to safe Telegram staff reply delivery: authenticated route provenance, fail closed on ambiguous records, durable pre-dispatch claim, typed outcomes, and draft preservation. The proposed send-before-save design was not approved. [PR #79](https://github.com/geekammar/Yakfi/pull/79) implements the Telegram candidate at `38513e4`; Production is unchanged. Reviewer HOLD at `e6a3364e`: read-only status lookup, missing/stale claim handling, and the different-text two-reload draft regression passed CI. Dismiss still deletes the unresolved attempt key while its draft can remain; a new send can overwrite the single recovery slot. Bind cleanup to the draft identity and use a conditional assignment update. Then review exact HEAD and isolated Preview prerequisites before Muse. After delivery verification, proceed to TG-22 / ISS-012 (truthful unknown-information response and handoff).
2. UX Conversation Lab. Authorized Platform Operator acceptance and isolated verification of the existing `welcome.intro` runtime path. Scope any new wiring separately.
3. Cost & Price. Confirm the frozen design and implement the smallest cost-evidence persistence slice before forming pilot price hypotheses.
4. Real-business pilot and Spec A exit. Spec B evidence and Spec C vertical selection follow. Defer low-impact P2/P3 polish until after Lab and Cost & Price. PR #77 is a tracked P2 candidate.

## Implementation constraints

- One ConversationEngine and one server-authoritative Booking Core. Keep tenant scope, server validation, and channel adapters separate from domain execution.
- Free-text intent, handoff, sensitivity, and knowledge selection use structured semantic decisions. Do not use keyword lists, dictionaries, regex, substring, or token overlap for intent. Formal channel commands, callback IDs, dates, and permissions use deterministic validation. Egyptian Arabic is the current acceptance scope.
- AGY/OpenCode implements and provides technical evidence. Muse records black-box outcomes. The reviewer maintains the verified checkpoint and canonical documentation. The owner approves decisions and merges.

[Recovery folder](https://drive.google.com/drive/folders/1limgPzcq_CykylK4kaC0OwzgxGGr3jWo) · [Shared QA](https://docs.google.com/spreadsheets/d/1ywijLhpIrr3BCkMHil2voeiZoW4LiLc8Sd-4oB0qvDU/edit) · [Trello](https://trello.com/b/IgK6SV7K/yakfi)