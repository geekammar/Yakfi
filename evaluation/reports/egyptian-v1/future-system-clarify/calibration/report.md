# FlowPilot AI — Evaluation Run

> run `7e2b10ac75f9db78` · dataset `egyptian-v1` · target `future-system-flowpilot` · mode `DATASET`
> evaluator `eval-runner@1` · scoring `eval-scoring@1` · executed 2026-10-01T14:44:47.279Z
> subject: `FUTURE_SYSTEM` · atria/Atria-Dawn-Preview

> This is measurement infrastructure output. It is NOT a production baseline claim — the dedicated baseline analysis is a separate slice.

## 1. Verdicts

measure                 | value
----------------------- | -----
total cases             | 2
total turns             | 2
scored cases (AI-owned) | 2
PASS                    | 0
LIMITATION              | 0
FAIL                    | 2
SEAM_OWNED (excluded)   | 0

## 2. Metrics (value + numerator/denominator)

metric                           | value (n/d)
-------------------------------- | ------------
intent accuracy                  | 50.0% (1/2)
intent accuracy (limitation-adj) | 100.0% (2/2)
action accuracy                  | 0.0% (0/2)
handoff precision                | 0.0% (0/0)
handoff recall                   | 0.0% (0/0)
unnecessary handoff rate         | 0.0% (0/2)
missed handoff rate              | 0.0% (0/0)
entity extraction accuracy       | 0.0% (0/0)
multi-intent success rate        | 0.0% (0/1)
ambiguity handling accuracy      | 100.0% (1/1)
clarification accuracy           | 0.0% (0/1)
knowledge requirement accuracy   | 0.0% (0/1)
conversation-state accuracy      | 100.0% (1/1)
booking-state accuracy           | 100.0% (1/1)
safety violation rate            | 0.0% (0/0)
provider failure rate            | 0.0% (0/2)
malformed output rate            | 0.0% (0/2)
deterministic bypass correctness | 0.0% (0/0)

## 3. Handoff outcome channels (kept separate)

channel    | count
---------- | -----
NO_HANDOFF | 2

## 4. Failure-category aggregation

failure category        | count | sample case ids
----------------------- | ----- | -------------------------------
INTENT_MISCLASSIFIED    | 0     |
ACTION_WRONG            | 1     | am-bare-booking-clarifiable::u0
HANDOFF_MISSED          | 0     |
HANDOFF_UNNECESSARY     | 0     |
EXTRACTION_MISSED       | 0     |
EXTRACTION_HALLUCINATED | 0     |
KNOWLEDGE_NOT_USED      | 0     |
KNOWLEDGE_FABRICATED    | 1     | st-service-discovery::u0
CLARIFICATION_NOT_ASKED | 0     |
CONTEXT_LOST            | 0     |
SAFETY_VIOLATION        | 0     |
MALFORMED_OUTPUT        | 0     |
PROVIDER_FAILURE        | 0     |
STATE_TRANSITION_ERROR  | 0     |
BOOKING_JOURNEY_ERROR   | 0     |
AI_FAILURE              | 0     |
OTHER                   | 0     |

## 5. Filtered views

### 5a. By edge category

facet                 | cases | FAIL | LIMITATION
--------------------- | ----- | ---- | ----------
KNOWLEDGE_NOT_EXPOSED | 1     | 1    | 0
AMBIGUOUS_CLARIFIABLE | 1     | 1    | 0
BOOKING_JOURNEY       | 1     | 1    | 0
PARTIAL_INFORMATION   | 1     | 1    | 0

### 5b. By language register

facet               | cases | FAIL | LIMITATION
------------------- | ----- | ---- | ----------
EGYPTIAN_COLLOQUIAL | 2     | 2    | 0

### 5c. By rarity

facet  | cases | FAIL | LIMITATION
------ | ----- | ---- | ----------
COMMON | 2     | 2    | 0

### 5d. MISSED handoffs (a human was required, none routed)

_None._

### 5e. UNNECESSARY handoffs (system escalated a resolvable turn)

_None._

## 6. Per-case results (first 50; full set in the JSON)

- **st-service-discovery::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **FAIL** (KNOWLEDGE_FABRICATED)
- **am-bare-booking-clarifiable::u0** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/reply/no-handoff` · **FAIL** (ACTION_WRONG)

## 7. Traceability

Every number derives from `caseResults[]` in `evaluation-run.json`. Each record carries `caseId`, `scenarioId`, the expected snapshot, the actual outcome, the verdict, and the failure category. Filter the JSON by any field to reproduce a metric exactly. `manifest.json` pins the dataset hash + evaluator/scoring versions for replay.
