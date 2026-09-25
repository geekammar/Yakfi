# FlowPilot — Prompt Evaluations (deterministic fixtures)

> Offline fixtures that guard behavior against drift from
> `src/features/conversations/server/conversation-ai.ts` (+ `ai-contract.ts`
> invariants) and from the binding policy in `docs/ai/ARCHITECTURE.md`. Prompt
> BODIES live in `/prompts/*.prompt`; this file guards BEHAVIOR, not text.
> Status: **offline** — `pnpm check:ai-prompts` proves them in-memory
> (no DB, no network, no API keys). No live LLM call; no cost.
>
> Fixture conventions:
>
> - One row ↔ one expectation against the deterministic classifier
>   (`classifyCustomerMessage` / `bypassDeterministicAi`). Real provider
>   adapters are implemented and policy-backed (DECISIONS #44; see
>   `docs/ai/PROVIDERS.md`); fixtures here remain the cheapest proof that the
>   prompt artifacts stay consistent with the typed contract without a live
>   LLM call.
> - Every prompt version (`…@v1`) has at least one fixture below; a version
>   bump requires fixture updates that keep the harness green.
> - Harness invariants beyond these rows: provider-neutrality, structured
>   prompts (id/version/purpose/input/system/output/constraints/handoff),
>   invocation boundary, and the `AMBIGUOUS`-is-safe-final-state property.

## Fixtures

| #   | Prompt                                      | Message (ar)                                                         | faqs                                                    | services                    | Expected (`intent` / `action` / `handoffReason` / `summary?` / `extraction.service?` / `content == FAQ answer?`) |
| --- | ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 01  | `booking-intent@v1`                         | `عايز أحجز موعد`                                                     | []                                                      | `[]`                        | `BOOKING` / `booking_handoff` / `null` / summary set / `service=null`                                            |
| 02  | `booking-intent@v1`                         | `عايز أحجز تنظيف أسنان يوم الخميس`                                   | []                                                      | `تنظيف أسنان (30m)`         | `BOOKING` / `booking_handoff` / `null` / summary set / `service=تنظيف أسنان`                                     |
| 03  | `faq-match@v1`                              | `ما هي ساعات العمل؟`                                                 | `[{q: ما هي ساعات العمل؟, a: من 9 صباحاً حتى 6 مساءً}]` | `[]`                        | `FAQ` / `reply` / `null` / no summary / — / `content === faqs[0].answer`                                         |
| 04  | `faq-match@v1`                              | `هل عندكم تقويم أسنان؟`                                              | `[{q: هل عندكم تقويم أسنان؟, a: نعم نوفر تقويم…}]`      | `[]`                        | `FAQ` / `reply` / `null` / no summary / — / verbatim `answer`                                                    |
| 05  | `availability-handoff@v1`                   | `إيه الأوقات المتاحة بكرة؟`                                          | []                                                      | `[]`                        | `AVAILABILITY` / `booking_handoff` / `null` / summary set                                                        |
| 06  | `availability-handoff@v1`                   | `إمتى ممكن آجي؟`                                                     | `[{q: هل يوجد حشو؟, a: نعم … }]` (no match)             | `[]`                        | `AVAILABILITY` / `booking_handoff` / — (FAQ did not match)                                                       |
| 07  | `reschedule-cancellation@v1`                | `عايز ألغي الموعد`                                                   | []                                                      | `[]`                        | `CANCELLATION` / `booking_handoff` / `null` / `summary="طلب العميل إلغاء موعده"`                                 |
| 08  | `reschedule-cancellation@v1`                | `عايز أغيّر معاد الحجز`                                              | []                                                      | `[]`                        | `RESCHEDULE` / `booking_handoff` / `null` / `summary="طلب العميل تعديل موعده"`                                   |
| 09  | `reschedule-cancellation@v1`                | `مش هقدر أحضر`                                                       | []                                                      | `[]`                        | `CANCELLATION` / `booking_handoff` (cancellation phrase outranks reschedule)                                     |
| 10  | `human-request@v1`                          | `عايز أكلم موظف حقيقي`                                               | []                                                      | `[]`                        | `HUMAN_REQUEST` / `handoff` / `HUMAN_REQUEST`                                                                    |
| 11  | `human-request@v1`                          | `عندي ألم شديد وتورم`                                                | []                                                      | `[]`                        | `AMBIGUOUS` / `handoff` / `SENSITIVE` (never triage — staff)                                                     |
| 12  | `human-request@v1`                          | `هل عندكم زراعة أسنان؟`                                              | `[]` (empty knowledge)                                  | `[]`                        | `AMBIGUOUS` / `handoff` / `NO_KNOWLEDGE` (question mark, no FAQ)                                                 |
| 13  | `human-request@v1`                          | `م`                                                                  | []                                                      | `[]`                        | `AMBIGUOUS` / `handoff` / `AMBIGUOUS` (short → bypassDeterministicAi as well)                                    |
| 14  | `booking-intent@v1` vs `faq-match@v1`       | `عايز أحجز موعد، وما هي ساعات العمل؟`                                | `[{q: ساعات العمل؟, a: … }]`                            | `[]`                        | `BOOKING` / `booking_handoff` — booking outranks FAQ (never swallow booking)                                     |
| 15  | `availability-handoff@v1` vs `faq-match@v1` | `ما هي ساعات العمل؟` (as in 03) + availability-ish `إمتى` elsewhere? | stored FAQ matches → FAQ wins; else AVAILABILITY        | harness proves the ordering |

## Detailed expectations (for the harness — kept minimal)

- **01–02 (BOOKING):** `intent=BOOKING`, `action=booking_handoff`, `handoffReason=null`, `summary` non-null, `content` is the brief Arabic booking acknowledgment. `02` additionally `extraction.service` equals the verbatim service name (normalized inclusion).
- **03–04 (FAQ):** `intent=FAQ`, `action=reply`, `handoffReason=null`, `summary=null`, `content === faqs[i].answer` exactly (verbatim), no fabricated slots or rephrasing. `extraction` empty.
- **05–06 (AVAILABILITY):** `intent=AVAILABILITY`, `action=booking_handoff`, `summary` set, `content` the brief Arabic availability acknowledgment. `06` proving FAQ priority — when no FAQ qualifies, AVAILABILITY applies.
- **07–09 (CANCELLATION/RESCHEDULE):** `07 → CANCELLATION`, `08 → RESCHEDULE`, both `booking_handoff` + the respective Arabic `summary` literal in `conversation-ai.ts`. `09` a cancellation phrase (`مش هقدر أحضر`) — cancellation branch wins.
- **10–13 (HUMAN_REQUEST / AMBIGUOUS):** typed `handoffReason` exactly as in the engine (`HUMAN_REQUEST` / `SENSITIVE` / `NO_KNOWLEDGE` / `AMBIGUOUS`). `13` must also be reproducible via `bypassDeterministicAi({ message: "م", … })`.
- **14–15 (Ordering):** prompts never swallowed — booking → FAQ → AVAILABILITY ordering is fixture-proven by the harness calling the deterministic classifier once in that order.

## Negative invariants (reuse of `docs/ai/ARCHITECTURE.md`)

- No prompt may introduce an intent outside `aiIntentValues` or a `handoffReason`
  outside `handoffReasonValues` — `parseAiResponse` rejects them.
- No fixture expects chain-of-thought — the harness asserts that any
  `reasoning`/`chainOfThought` key on a response is **stripped** by
  `parseAiResponse` and not persisted (the real provider contract).
- Unknown-key handling: knowledge never fabricates; availability never lists
  slots; booking never writes an appointment — checked statically via the
  harness's "seam" assertion over `conversation-engine.ts` import set.

## How to change fixtures

- Add rows only — never silently weaken an existing expectation. A prompt
  version bump (`…@v1 → …@v2`) **owns** its rows; the harness lists missing
  versions as a failure.
- Every fixture change requires `pnpm check:ai-prompts` to pass before merge.
  `pnpm security` must remain clean (no prompt leaked a key shape).
