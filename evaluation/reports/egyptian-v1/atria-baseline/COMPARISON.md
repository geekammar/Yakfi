# FlowPilot AI — Atria (EVAL-04C) vs CodeCraft/DeepSeek (EVAL-04B) vs Deterministic (EVAL-04)

> The SAME `egyptian-v1` dataset (hash `8be16297ae4717bab5da4f3d94de1887`) and
> the SAME EVAL-03 scoring engine (`eval-scoring@1`) score three subjects:
>
> - **DETERMINISTIC** — `deterministic-classifier (offline)` (EVAL-04,
>   run `99058ea52788db88`, `../baseline/`).
> - **CODECRAFT / DEEPSEEK** — `codecraft/deepseek-v4-flash-0731` via the live
>   policy-backed provider (EVAL-04B, run `ddf469a396342a0f`,
>   `../real-llm-baseline/`).
> - **ATRIA** — `atria/Atria-Dawn-Preview` via the same provider seam, selected
>   by an evaluation-only override (EVAL-04C, run `749af9925213cec5`,
>   this directory).
>
> This is **not** a provider ranking and declares no winner. It is a behavioral
> and diagnostic comparison. All three are scored over the identical **1,893**
> AI-owned cases (40 seam-owned excluded).

## Verdict distribution

| verdict | deterministic | CodeCraft | Atria | Atria Δ vs CC | Atria Δ vs det |
| --- | --- | --- | --- | --- | --- |
| PASS | 41.8% (792/1893) | 39.6% (750/1893) | 40.7% (770/1893) | +1.1pp | −1.1pp |
| LIMITATION | 12.8% (243/1893) | 25.1% (475/1893) | 25.3% (479/1893) | +0.2pp | +12.5pp |
| FAIL | 45.3% (858/1893) | 35.3% (668/1893) | 34.0% (644/1893) | −1.3pp | −11.3pp |

**Both LLMs convert deterministic FAILs into LIMITATION/PASS** (Atria net FAIL
−214, CodeCraft −190), while Atria and CodeCraft are within ~1pp of each other
on every verdict class.

Case-level verdict shifts (shared cases):
- Atria vs deterministic: **451 improved, 354 regressed.**
- Atria vs CodeCraft: **99 improved, 75 regressed.**
- Atria and CodeCraft reach the **same verdict on 1719/1893 (90.8%)** cases
  (680 both PASS, 601 both FAIL).

## Metric-by-metric (all three subjects)

| metric | Atria (n/d) | CodeCraft (n/d) | deterministic (n/d) | Atria Δ CC | Atria Δ det |
| --- | --- | --- | --- | --- | --- |
| intent accuracy | 58.4% (1106/1893) | 59.4% (1125/1893) | 60.9% (1153/1893) | −1.0pp | −2.5pp |
| intent accuracy (lim-adj) | 87.7% (1661/1893) | 88.1% (1667/1893) | 80.6% (1526/1893) | −0.3pp | **+7.1pp** |
| action accuracy | 62.8% (1188/1893) | 62.3% (1180/1893) | 66.9% (1266/1893) | +0.4pp | −4.1pp |
| action accuracy (lim-adj) | 88.4% (1673/1893) | 88.5% (1675/1893) | 84.7% (1604/1893) | −0.1pp | **+3.6pp** |
| handoff precision | 41.2% (197/478) | 40.0% (199/497) | 28.7% (213/743) | +1.2pp | **+12.5pp** |
| handoff recall | 90.4% (197/218) | 91.3% (199/218) | 97.7% (213/218) | −0.9pp | −7.3pp |
| unnecessary handoff rate | 45.4% (281/619) | 48.1% (298/619) | 85.6% (530/619) | **−2.7pp** | **−40.2pp** |
| missed handoff rate | 9.6% (21/218) | 8.7% (19/218) | 2.3% (5/218) | +0.9pp | +7.3pp |
| entity extraction | 84.9% (270/318) | 84.0% (267/318) | 70.8% (225/318) | +0.9pp | **+14.2pp** |
| multi-intent success | 56.6% (226/399) | 56.9% (227/399) | 47.6% (190/399) | −0.3pp | **+9.0pp** |
| ambiguity handling | 69.8% (139/199) | 72.9% (145/199) | 66.3% (132/199) | −3.0pp | +3.5pp |
| clarification accuracy | 54.0% (54/100) | 54.0% (54/100) | 57.0% (57/100) | +0.0pp | −3.0pp |
| knowledge requirement | 91.2% (343/376) | 93.1% (350/376) | 80.1% (301/376) | −1.9pp | **+11.2pp** |
| conversation-state | 92.5% (531/574) | 92.3% (530/574) | 78.4% (450/574) | +0.2pp | **+14.1pp** |
| booking-state | 48.9% (336/687) | 48.0% (330/687) | 35.5% (244/687) | +0.9pp | **+13.4pp** |
| safety violation rate | 13.0% (28/216) | 10.6% (23/216) | 2.8% (6/216) | +2.3pp | +10.2pp |
| provider failure rate | 0.0% (0/1893) | 0.1% (1/1893) | 0.0% (0/1893) | −0.1pp | +0.0pp |
| malformed output rate | 0.0% (0/1893) | 0.0% (0/1893) | 0.0% (0/1893) | +0.0pp | +0.0pp |
| deterministic bypass correctness | 24.5% (23/94) | 24.5% (23/94) | 24.5% (23/94) | +0.0pp | +0.0pp |

## Where Atria and CodeCraft behave similarly

- **18 of 19 metrics are within ±3pp.** The exception is none: the widest gap is
  ambiguity handling at −3.0pp.
- **90.8% identical verdicts**; balanced case-level redistribution
  (99 improved / 75 regressed).
- **Identical failure taxonomy.** Every Atria FAIL category exists in the
  CodeCraft run at a comparable rate:
  HANDOFF_UNNECESSARY 281/298 · INTENT_MISCLASSIFIED 161/160 · ACTION_WRONG
  92/111 · EXTRACTION_HALLUCINATED 40/39 · SAFETY_VIOLATION 28/23 ·
  KNOWLEDGE_FABRICATED 24/19 · HANDOFF_MISSED 14/13 · EXTRACTION_MISSED 4/5.
- **Identical direction vs deterministic.** Both gain on the same axes
  (state, extraction, knowledge, multi-intent, limitation-adjusted accuracy) and
  both lose on the same axes (strict intent/action accuracy, handoff recall).

**Interpretation (diagnostic, not conclusive):** the shared failure surface is
consistent with the shared 8-intent contract, handoff policy and prompt framing
rather than with either model.

## Where Atria differs materially

1. **Less unnecessary handoff overall** (45.4% vs 48.1%) and markedly less on
   the service-discovery family (37.1% vs 53.2%). Atria answers pure service
   discovery (`st-service-discovery` 0/8 handoff, `kn-service-catalog` 0/20)
   where CodeCraft still hands off (2/8, 2/20).
2. **The canonical SERVICE_DISCOVERY + BOOKING utterance behaves the same in
   both** ("عايز احجز ايه الخدمات اللي موجوده عندكم؟", 20 cases): Atria hands
   off 14, CodeCraft 17, deterministic 20. The difference between the LLMs here
   is small; the difference between LLM and deterministic is large.
3. **Slightly more knowledge fabrication** (24 vs 19 cases), concentrated in
   catalog discovery where Atria invents entries not in the exposed context.
4. **Slightly more reported safety violations** (28 vs 23), of which 21 are
   scorer artifacts and **7 are genuine** (3.2% of applicable cases).

## Where deterministic and LLM paths differ

- The deterministic path is the **most handoff-happy** (unnecessary handoff
  85.6% vs 45.4%/48.1%) and the **best at required-handoff recognition**
  (missedHandoffRate 2.3% vs 9.6%/8.7%).
- Both LLMs beat it on every semantic/state axis (state +14pp, extraction
  +14pp, booking-state +13pp, knowledge +11pp, multi-intent +9pp) and on
  limitation-adjusted accuracy (+7pp).
- The deterministic path's strict intent/action accuracy is nominally higher
  (+2.5/+4.1pp vs Atria), but its correct answers are disproportionately
  LIMITATION-class (LIMITATION 12.8% vs 25.1%/25.3%).

## Whether failure patterns persist across models

**Yes — all of them.** Every failure category and every top failing scenario in
the Atria run has a counterpart in the CodeCraft run at a similar rate. The
largest single confusion, `AMBIGUOUS → FAQ` (300 cases in Atria), is present in
the CodeCraft run as well. **No Atria failure pattern is unique to Atria**, and
no CodeCraft-specific failure appears that Atria avoids wholesale.

## Latency (provider-attempt observations)

| measure | Atria | CodeCraft |
| --- | --- | --- |
| evaluated LLM turns | 1864 | (see EVAL-04B analysis) |
| model latency p50 | 30,648 ms | — |
| p90 / p95 / p99 | 76,627 / 83,790 / 88,647 ms | — |
| turns with retry | 298 (16.0%) | — |
| avg physical attempts | 1.16 | — |
| final provider failures | 0 | 1 |

Atria-Dawn-Preview is substantially slower than the CodeCraft model. At the
production 16 s per-attempt cap the majority of turns under load exceed the
budget (calibration: 48/62 turns TIMEOUT). The measurement used an eval-only
45 s override through the existing `AiFactoryEnvDeps.timeoutMs` probe seam; the
production cap is unchanged. **This is a provider-selection-relevant finding,
not a model-quality finding.**

## Reproducibility

| field | value |
| --- | --- |
| dataset | `egyptian-v1`, hash `8be16297ae4717bab5da4f3d94de1887` |
| Atria provider / model | `atria` / `Atria-Dawn-Preview` |
| target id | `real-llm-flowpilot` (provider-override) |
| evaluator / scoring | `eval-runner@1` / `eval-scoring@1` |
| run id | `749af9925213cec5` (content hash; excludes wall-clock) |
| filter | `{}` (full DATASET mode) |
| retry config | bounded maxAttempts=2, no cross-provider fallback |
| per-attempt timeout | 45000 ms (eval-only override) |
| executed at | 2026-10-01T01:14:53.750Z |

No secrets or chain-of-thought are recorded anywhere in these artifacts
(`check:eval-runner` R16/R17: 0 matches; content bounded ≤400 chars).
