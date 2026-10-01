# FlowPilot AI — Evaluation Run

> run `ddf469a396342a0f` · dataset `egyptian-v1` · target `real-llm-flowpilot` · mode `DATASET`
> evaluator `eval-runner@1` · scoring `eval-scoring@1` · executed 2026-09-29T20:23:10.824Z
> subject: `CURRENT_SYSTEM` · codecraft/deepseek-v4-flash-0731

> This is measurement infrastructure output. It is NOT a production baseline claim — the dedicated baseline analysis is a separate slice.

## 1. Verdicts

measure                 | value
----------------------- | -----
total cases             | 27
total turns             | 33
scored cases (AI-owned) | 27
PASS                    | 6
LIMITATION              | 8
FAIL                    | 13
SEAM_OWNED (excluded)   | 0

## 2. Metrics (value + numerator/denominator)

metric                           | value (n/d)
-------------------------------- | -------------
intent accuracy                  | 48.1% (13/27)
intent accuracy (limitation-adj) | 88.9% (24/27)
action accuracy                  | 48.1% (13/27)
handoff precision                | 42.9% (6/14)
handoff recall                   | 100.0% (6/6)
unnecessary handoff rate         | 44.4% (8/18)
missed handoff rate              | 0.0% (0/6)
entity extraction accuracy       | 0.0% (0/0)
multi-intent success rate        | 0.0% (0/6)
ambiguity handling accuracy      | 0.0% (0/3)
clarification accuracy           | 0.0% (0/3)
knowledge requirement accuracy   | 33.3% (1/3)
conversation-state accuracy      | 100.0% (6/6)
booking-state accuracy           | 66.7% (6/9)
safety violation rate            | 0.0% (0/3)
provider failure rate            | 3.7% (1/27)
malformed output rate            | 0.0% (0/27)
deterministic bypass correctness | 0.0% (0/0)

## 3. Handoff outcome channels (kept separate)

channel                   | count
------------------------- | -----
NO_HANDOFF                | 10
PROVIDER_FAILURE          | 1
TRUE_HUMAN_REQUIRED       | 8
UNNECESSARY_HUMAN_HANDOFF | 8

## 4. Failure-category aggregation

failure category        | count | sample case ids
----------------------- | ----- | ---------------------------------------------------------------------------------------------------------
INTENT_MISCLASSIFIED    | 3     | ho-sensitive-medical::u0, ho-sensitive-medical::u0_missing_hamza, ho-sensitive-medical::u0_repeat_letters
ACTION_WRONG            | 0     |
HANDOFF_MISSED          | 0     |
HANDOFF_UNNECESSARY     | 8     | st-service-discovery::u1, mi-booking-plus-discovery::u0, mi-booking-plus-discovery::u0_missing_hamza
EXTRACTION_MISSED       | 0     |
EXTRACTION_HALLUCINATED | 0     |
KNOWLEDGE_NOT_USED      | 0     |
KNOWLEDGE_FABRICATED    | 2     | st-service-discovery::u0, st-service-discovery::u0_drop_punctuation
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
BOOKING_JOURNEY       | 9     | 6    | 0
UNNECESSARY_HANDOFF   | 9     | 3    | 6
LEGITIMATE_HANDOFF    | 6     | 3    | 0
KNOWLEDGE_NOT_EXPOSED | 3     | 3    | 0
MULTI_INTENT          | 3     | 3    | 0
AMBIGUOUS_CLARIFIABLE | 3     | 3    | 0
PARTIAL_INFORMATION   | 3     | 3    | 0
HANDOFF_SENSITIVE     | 3     | 3    | 0
SENSITIVE             | 3     | 3    | 0
SERVICE_NAME_ARABIZI  | 3     | 1    | 2
ARABIZI               | 3     | 1    | 2
LANGUAGE_VARIATION    | 3     | 1    | 2
KNOWLEDGE_EXACT       | 6     | 0    | 6
TOPIC_SWITCH          | 3     | 0    | 3
HANDOFF_EXPLICIT      | 3     | 0    | 0
NORMAL                | 3     | 0    | 0

### 5b. By language register

facet               | cases | FAIL | LIMITATION
------------------- | ----- | ---- | ----------
EGYPTIAN_COLLOQUIAL | 24    | 12   | 6
ARABIZI             | 3     | 1    | 2

### 5c. By rarity

facet  | cases | FAIL | LIMITATION
------ | ----- | ---- | ----------
COMMON | 24    | 12   | 6
RARE   | 3     | 1    | 2

### 5d. MISSED handoffs (a human was required, none routed)

_None._

### 5e. UNNECESSARY handoffs (system escalated a resolvable turn)

- **st-service-discovery::u1** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/reply/handoff`
- **mi-booking-plus-discovery::u0** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff`
- **mi-booking-plus-discovery::u0_missing_hamza** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff`
- **mi-booking-plus-discovery::u0_drop_punctuation** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff`
- **am-bare-booking-clarifiable::u0** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff`
- **am-bare-booking-clarifiable::u0_missing_hamza** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff`
- **am-bare-booking-clarifiable::u0_repeat_letters** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff`
- **lg-arabizi-service-name::u1** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AVAILABILITY/booking_handoff/handoff`

## 6. Per-case results (first 50; full set in the JSON)

- **st-service-discovery::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **FAIL** (KNOWLEDGE_FABRICATED)
- **st-service-discovery::u0_drop_punctuation** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **FAIL** (KNOWLEDGE_FABRICATED)
- **st-service-discovery::u1** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/reply/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **mi-booking-plus-discovery::u0** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **mi-booking-plus-discovery::u0_missing_hamza** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **mi-booking-plus-discovery::u0_drop_punctuation** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **kn-service-catalog::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **kn-service-catalog::u0_missing_hamza** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **kn-service-catalog::u0_drop_punctuation** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **am-bare-booking-clarifiable::u0** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **am-bare-booking-clarifiable::u0_missing_hamza** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **am-bare-booking-clarifiable::u0_repeat_letters** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `BOOKING/booking_handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **ho-unnecessary-discovery-mid-flow::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **ho-unnecessary-discovery-mid-flow::u0_missing_hamza** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **ho-unnecessary-discovery-mid-flow::u0_drop_punctuation** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **ho-customer-requested-human::u0** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `HUMAN_REQUEST/handoff/handoff` · **PASS**
- **ho-customer-requested-human::u0_missing_hamza** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `HUMAN_REQUEST/handoff/handoff` · **PASS**
- **ho-customer-requested-human::u1** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `HUMAN_REQUEST/handoff/handoff` · **PASS**
- **ho-sensitive-medical::u0** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (INTENT_MISCLASSIFIED)
- **ho-sensitive-medical::u0_missing_hamza** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `BOOKING/booking_handoff/handoff` · **FAIL** (INTENT_MISCLASSIFIED)
- **ho-sensitive-medical::u0_repeat_letters** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `BOOKING/booking_handoff/handoff` · **FAIL** (INTENT_MISCLASSIFIED)
- **lg-arabizi-service-name::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **lg-arabizi-service-name::u0_drop_punctuation** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **lg-arabizi-service-name::u1** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AVAILABILITY/booking_handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **jt-goal-stated::u0** — expected `BOOKING/booking_handoff/ACCEPTABLE_EITHER` · actual `BOOKING/booking_handoff/handoff` · **PASS**
- **jt-goal-stated::u0_missing_hamza** — expected `BOOKING/booking_handoff/ACCEPTABLE_EITHER` · actual `BOOKING/booking_handoff/handoff` · **PASS**
- **jt-goal-stated::u0_repeat_letters** — expected `BOOKING/booking_handoff/ACCEPTABLE_EITHER` · actual `BOOKING/booking_handoff/handoff` · **PASS**

## 7. Traceability

Every number derives from `caseResults[]` in `evaluation-run.json`. Each record carries `caseId`, `scenarioId`, the expected snapshot, the actual outcome, the verdict, and the failure category. Filter the JSON by any field to reproduce a metric exactly. `manifest.json` pins the dataset hash + evaluator/scoring versions for replay.
