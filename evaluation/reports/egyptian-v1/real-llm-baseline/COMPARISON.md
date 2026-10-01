# FlowPilot AI — Deterministic (EVAL-04) vs Real-LLM (EVAL-04B) Comparison

> The SAME `egyptian-v1` dataset (hash `8be16297ae4717bab5da4f3c94de1887`) and
> the SAME EVAL-03 scoring engine (`eval-scoring@1`) score two subjects:
>
> - **CURRENT DETERMINISTIC PATH** — `deterministic-classifier (offline)`
>   (EVAL-04, run `99058ea52788db88`, `../baseline/`).
> - **CURRENT REAL LLM PATH** — `codecraft/deepseek-v4-flash-0731` via the live
>   policy-backed provider (EVAL-04B, run `ddf469a396342a0f`, this directory).
>
> This is **not** a provider/model "winner" comparison. It identifies system
> behavior differences between the two current execution paths. Both are scored
> over the identical **1,893** AI-owned cases (40 seam-owned excluded); the
> comparison is computed only over shared caseIds.

## Verdict distribution

| verdict | deterministic | real-LLM | delta |
| --- | --- | --- | --- |
| PASS | 41.8% (792/1893) | 39.6% (750/1893) | −2.2pp |
| LIMITATION | 12.8% (243/1893) | 25.1% (475/1893) | +12.3pp |
| FAIL | 45.3% (858/1893) | 35.3% (668/1893) | **−10.0pp** |

Case-level verdict shift (shared cases): **436 improved, 367 regressed.** The
real LLM converts many deterministic FAILs into PASS/LIMITATION (net FAIL −190),
while a smaller set regresses (mostly handoff-recall losses, below).

## Metric-by-metric (positive delta = real-LLM better)

| metric | deterministic (n/d) | real-LLM (n/d) | delta | interpretation |
| --- | --- | --- | --- | --- |
| intent accuracy (strict) | 60.9% (1153/1893) | 59.4% (1125/1893) | −1.5pp | ~parity; real-LLM shifts some exact-intent cases into architectural LIMITATION |
| intent accuracy (lim-adj) | 80.6% (1526/1893) | 88.1% (1667/1893) | **+7.4pp** | fewer hard intent errors once architectural limits are credited |
| action accuracy (strict) | 66.9% (1266/1893) | 62.3% (1180/1893) | −4.5pp | real-LLM sometimes picks a defensible-but-non-gold action |
| action accuracy (lim-adj) | 84.7% (1604/1893) | 88.5% (1675/1893) | +3.8pp | fewer outright wrong actions |
| handoff precision | 28.7% (213/743) | 40.0% (199/497) | **+11.4pp** | far fewer needless escalations diluting precision |
| handoff recall | 97.7% (213/218) | 91.3% (199/218) | −6.4pp | real-LLM misses a few genuinely-required handoffs |
| unnecessary handoff rate | 85.6% (530/619) | 48.1% (298/619) | **−37.5pp** | the largest single behavior change |
| missed handoff rate | 2.3% (5/218) | 8.7% (19/218) | −6.4pp | the cost of continuing more turns |
| entity extraction | 70.8% (225/318) | 84.0% (267/318) | **+13.2pp** | real-LLM extracts service/date/time better |
| multi-intent success | 47.6% (190/399) | 56.9% (227/399) | +9.3pp | better secondary-intent retention |
| ambiguity handling | 66.3% (132/199) | 72.9% (145/199) | +6.5pp | slightly better, still handoff-capped |
| clarification accuracy | 57.0% (57/100) | 54.0% (54/100) | −3.0pp | ~parity; no CLARIFY action in either |
| knowledge requirement | 80.1% (301/376) | 93.1% (350/376) | **+13.0pp** | better use of exposed knowledge |
| conversation-state | 78.4% (450/574) | 92.3% (530/574) | **+13.9pp** | much better multi-turn tracking |
| booking-state | 35.5% (244/687) | 48.0% (330/687) | **+12.5pp** | better journey progression |
| safety violation (reported) | 2.8% (6/216) | 10.6% (23/216) | −7.9pp | **artifact** — genuine rate is 2.8% (6/216), identical (see BASELINE.md §M) |
| safety violation (genuine) | 2.8% (6/216) | 2.8% (6/216) | 0.0pp | parity |
| provider failure | 0.0% (0/1893) | 0.1% (1/1893) | −0.1pp | one reproducible TIMEOUT |
| malformed output | 0.0% (0/1893) | 0.0% (0/1893) | 0.0pp | parity |
| deterministic bypass correctness | 24.5% (23/94) | 24.5% (23/94) | 0.0pp | identical (bypass runs first in both paths) |

## Handoff outcome channels

| channel | deterministic | real-LLM |
| --- | --- | --- |
| TRUE_HUMAN_REQUIRED | 1067 | 1027 |
| UNNECESSARY_HUMAN_HANDOFF | 530 | 298 |
| NO_HANDOFF | 101 | 374 |
| AMBIGUITY | 75 | 75 |
| KNOWLEDGE_GAP | 120 | 118 |
| PROVIDER_FAILURE | 0 | 1 |

The defining difference: **`NO_HANDOFF` 101 → 374** and
**`UNNECESSARY_HUMAN_HANDOFF` 530 → 298**. The real LLM keeps ~3.7× more turns in
self-service, at the cost of a modest drop in `TRUE_HUMAN_REQUIRED` (1067→1027)
that shows up as the +6.4pp missed-handoff regression.

## Bottom line

The current real-LLM path is **not uniformly better or worse** than the
deterministic path. It substantially reduces unnecessary handoffs and improves
knowledge use, state tracking, extraction, and multi-intent handling; it slightly
reduces handoff recall (a few genuinely-required escalations are now missed) and
strict action/intent accuracy. Both paths hit the same *architectural* ceilings
(no CLARIFY action; `SERVICE_DISCOVERY` is a future-only intent; the booking-verb
handoff reflex; unexposed knowledge), which is why LIMITATION rises rather than
PASS for many recovered cases. Those ceilings — not the model — are the primary
targets for the next architectural slice, to be designed only after reviewing
both baselines.
