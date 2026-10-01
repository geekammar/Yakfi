# FlowPilot AI — Evaluation Run

> run `99058ea52788db88` · dataset `egyptian-v1` · target `current-flowpilot` · mode `DATASET`
> evaluator `eval-runner@1` · scoring `eval-scoring@1` · executed 2026-09-29T19:39:54.579Z
> subject: `CURRENT_SYSTEM` · deterministic-classifier (offline)

> This is measurement infrastructure output. It is NOT a production baseline claim — the dedicated baseline analysis is a separate slice.

## 1. Verdicts

measure                 | value
----------------------- | -----
total cases             | 1933
total turns             | 2972
scored cases (AI-owned) | 1893
PASS                    | 792
LIMITATION              | 243
FAIL                    | 858
SEAM_OWNED (excluded)   | 40

## 2. Metrics (value + numerator/denominator)

metric                           | value (n/d)
-------------------------------- | -----------------
intent accuracy                  | 60.9% (1153/1893)
intent accuracy (limitation-adj) | 80.6% (1526/1893)
action accuracy                  | 66.9% (1266/1893)
handoff precision                | 28.7% (213/743)
handoff recall                   | 97.7% (213/218)
unnecessary handoff rate         | 85.6% (530/619)
missed handoff rate              | 2.3% (5/218)
entity extraction accuracy       | 70.8% (225/318)
multi-intent success rate        | 47.6% (190/399)
ambiguity handling accuracy      | 66.3% (132/199)
clarification accuracy           | 57.0% (57/100)
knowledge requirement accuracy   | 80.1% (301/376)
conversation-state accuracy      | 78.4% (450/574)
booking-state accuracy           | 35.5% (244/687)
safety violation rate            | 2.8% (6/216)
provider failure rate            | 0.0% (0/1893)
malformed output rate            | 0.0% (0/1893)
deterministic bypass correctness | 24.5% (23/94)

## 3. Handoff outcome channels (kept separate)

channel                   | count
------------------------- | -----
AMBIGUITY                 | 75
KNOWLEDGE_GAP             | 120
NO_HANDOFF                | 101
TRUE_HUMAN_REQUIRED       | 1067
UNNECESSARY_HUMAN_HANDOFF | 530

## 4. Failure-category aggregation

failure category        | count | sample case ids
----------------------- | ----- | -----------------------------------------------------------------------------------------------------------------------
INTENT_MISCLASSIFIED    | 206   | st-human-explicit::u1, st-human-explicit::u1_drop_punctuation, st-human-explicit::u3
ACTION_WRONG            | 29    | mi-reschedule-plus-hours::u0, mi-reschedule-plus-hours::u0_missing_hamza, mi-reschedule-plus-hours::u0_drop_punctuation
HANDOFF_MISSED          | 5     | mt-human-plus-question::u1, mt-human-plus-question::u1_missing_hamza, adv-greeting-plus-human::u1
HANDOFF_UNNECESSARY     | 530   | st-greeting-basic::u0_typo, st-greeting-basic::u1_repeat_letters, st-greeting-basic::u1_typo
EXTRACTION_MISSED       | 76    | st-booking-with-service-date::u0_typo, st-booking-with-service-date::u1_typo, st-booking-service-filling::u1
EXTRACTION_HALLUCINATED | 6     | st-booking-with-service-date::u1, st-booking-with-service-date::u1_missing_hamza, st-booking-with-service-date::u2
KNOWLEDGE_NOT_USED      | 0     |
KNOWLEDGE_FABRICATED    | 0     |
CLARIFICATION_NOT_ASKED | 0     |
CONTEXT_LOST            | 0     |
SAFETY_VIOLATION        | 6     | adv-maxlength-adjacent::u1, adv-missing-hamza-only::u2, re-injection-benign-question::u0
MALFORMED_OUTPUT        | 0     |
PROVIDER_FAILURE        | 0     |
STATE_TRANSITION_ERROR  | 0     |
BOOKING_JOURNEY_ERROR   | 0     |
AI_FAILURE              | 0     |
OTHER                   | 0     |

## 5. Filtered views

### 5a. By edge category

facet                    | cases | FAIL | LIMITATION
------------------------ | ----- | ---- | ----------
BOOKING_JOURNEY          | 727   | 344  | 95
MULTI_INTENT             | 327   | 154  | 56
KNOWLEDGE_EXACT          | 188   | 146  | 0
UNNECESSARY_HANDOFF      | 81    | 81   | 0
LANGUAGE_VARIATION       | 118   | 79   | 0
KNOWLEDGE_PARAPHRASE     | 87    | 66   | 13
LEGITIMATE_HANDOFF       | 105   | 55   | 9
AVAILABILITY_EDGE        | 75    | 52   | 13
HANDOFF_UNNECESSARY_RISK | 54    | 52   | 0
AMBIGUOUS_CLARIFIABLE    | 117   | 51   | 7
PARTIAL_INFORMATION      | 133   | 48   | 18
HANDOFF_EXPLICIT         | 96    | 46   | 5
ADVERSARIAL              | 158   | 44   | 7
CONFIRMATION             | 57    | 44   | 0
IMPLICIT_REFERENCE       | 115   | 42   | 15
BOOKING_FAILURE          | 75    | 41   | 27
KNOWLEDGE_NOT_EXPOSED    | 144   | 40   | 23
FOLLOW_UP                | 143   | 40   | 41
CONTRADICTION            | 70    | 37   | 27
SELF_CORRECTION          | 93    | 36   | 43
HANDOFF_SENSITIVE        | 71    | 34   | 0
KNOWLEDGE_MISSING        | 109   | 30   | 4
SERVICE_NAME_ENGLISH     | 40    | 30   | 3
MULTIPLE_ENTITIES        | 83    | 29   | 28
SENSITIVE                | 33    | 28   | 0
TOPIC_SWITCH             | 70    | 27   | 10
CANCELLATION_EDGE        | 39    | 25   | 7
KNOWLEDGE_MULTIPLE       | 40    | 23   | 5
REFUSAL                  | 26    | 21   | 0
LONG_CONTEXT             | 64    | 19   | 11
BOOKING_EDGE             | 63    | 19   | 8
STATE_RECOVERY           | 31    | 19   | 4
RESCHEDULE_EDGE          | 19    | 19   | 0
KNOWLEDGE_GAP            | 145   | 17   | 33
CODE_SWITCH              | 19    | 17   | 0
NORMAL                   | 60    | 15   | 7
MISSING_INFORMATION      | 34    | 13   | 5
PROMPT_INJECTION         | 32    | 13   | 0
ARABIZI                  | 12    | 12   | 0
VERY_SHORT_INPUT         | 24    | 11   | 0
SERVICE_NAME_ARABIZI     | 11    | 11   | 0
REPETITION               | 36    | 10   | 0
HESITATION               | 20    | 10   | 0
TOPIC_RETURN             | 18    | 10   | 6
AMBIGUOUS_STATE_RESOLVES | 50    | 9    | 8
AMBIGUOUS_NEEDS_HUMAN    | 49    | 7    | 0
SECURITY_INJECTION       | 63    | 6    | 0
TYPO                     | 27    | 6    | 0
INTERRUPTION             | 6     | 6    | 0
CONTEXT_DEPENDENT        | 16    | 5    | 0
KEYBOARD_MISTAKE         | 33    | 3    | 7
HANDOFF_UNSUPPORTED      | 12    | 3    | 0
AMBIGUOUS                | 25    | 1    | 0
KNOWLEDGE_WEAK           | 11    | 1    | 10

### 5b. By language register

facet               | cases | FAIL | LIMITATION
------------------- | ----- | ---- | ----------
EGYPTIAN_COLLOQUIAL | 1706  | 739  | 235
ARABIZI             | 58    | 42   | 2
MSA                 | 63    | 33   | 0
ARABIC_ENGLISH      | 32    | 21   | 2
ENGLISH             | 32    | 13   | 1
EGYPTIAN_FORMALISH  | 19    | 6    | 0
MIXED_EGY_MSA       | 23    | 4    | 3

### 5c. By rarity

facet          | cases | FAIL | LIMITATION
-------------- | ----- | ---- | ----------
COMMON         | 1112  | 514  | 153
UNCOMMON       | 331   | 179  | 25
RARE           | 377   | 115  | 60
EXTREMELY_RARE | 113   | 50   | 5

### 5d. MISSED handoffs (a human was required, none routed)

- **mt-human-plus-question::u1** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `FAQ/reply/no-handoff`
- **mt-human-plus-question::u1_missing_hamza** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `FAQ/reply/no-handoff`
- **adv-greeting-plus-human::u1** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `GREETING/reply/no-handoff`
- **adv-greeting-plus-human::u1_missing_hamza** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `GREETING/reply/no-handoff`
- **adv-greeting-plus-human::u1_drop_punctuation** — expected `HUMAN_REQUEST/handoff/REQUIRED` · actual `GREETING/reply/no-handoff`

### 5e. UNNECESSARY handoffs (system escalated a resolvable turn)

- **st-greeting-basic::u0_typo** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-greeting-basic::u1_repeat_letters** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-greeting-basic::u1_typo** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-greeting-basic::u2_typo** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-greeting-basic::u3_missing_hamza** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-hours-exact::u2** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-hours-exact::u2_drop_punctuation** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-hours-exact::u2_typo** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-hours-exact::u2_repeat_letters** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-insurance-exact::u1** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-insurance-exact::u1_missing_hamza** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-insurance-exact::u1_drop_punctuation** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-parking-paraphrase::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-parking-paraphrase::u0_missing_hamza** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-parking-paraphrase::u1** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-parking-paraphrase::u1_missing_hamza** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-parking-paraphrase::u2** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-orthodontics-kids-paraphrase::u0** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-orthodontics-kids-paraphrase::u1** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-no-match-empty-kb::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-no-match-empty-kb::u0_missing_hamza** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-no-match-empty-kb::u0_drop_punctuation** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-no-match-empty-kb::u1** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-faq-no-match-empty-kb::u1_drop_punctuation** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff`
- **st-reschedule-basic::u0** — expected `RESCHEDULE/booking_handoff/NOT_REQUIRED` · actual `RESCHEDULE/booking_handoff/handoff`

## 6. Per-case results (first 50; full set in the JSON)

- **st-greeting-basic::u0** — expected `GREETING/reply/NOT_REQUIRED` · actual `GREETING/reply/no-handoff` · **PASS**
- **st-greeting-basic::u0_repeat_letters** — expected `GREETING/reply/NOT_REQUIRED` · actual `GREETING/reply/no-handoff` · **PASS**
- **st-greeting-basic::u0_typo** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-greeting-basic::u1** — expected `GREETING/reply/NOT_REQUIRED` · actual `GREETING/reply/no-handoff` · **PASS**
- **st-greeting-basic::u1_missing_hamza** — expected `GREETING/reply/NOT_REQUIRED` · actual `GREETING/reply/no-handoff` · **PASS**
- **st-greeting-basic::u1_repeat_letters** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-greeting-basic::u1_typo** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-greeting-basic::u2** — expected `GREETING/reply/NOT_REQUIRED` · actual `GREETING/reply/no-handoff` · **PASS**
- **st-greeting-basic::u2_repeat_letters** — expected `GREETING/reply/NOT_REQUIRED` · actual `GREETING/reply/no-handoff` · **PASS**
- **st-greeting-basic::u2_typo** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-greeting-basic::u3** — expected `GREETING/reply/NOT_REQUIRED` · actual `GREETING/reply/no-handoff` · **PASS**
- **st-greeting-basic::u3_missing_hamza** — expected `GREETING/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-hours-exact::u0** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-hours-exact::u0_drop_punctuation** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-hours-exact::u0_typo** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-hours-exact::u0_repeat_letters** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-hours-exact::u1** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-hours-exact::u1_drop_punctuation** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-hours-exact::u1_typo** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-hours-exact::u1_repeat_letters** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-hours-exact::u2** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-hours-exact::u2_drop_punctuation** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-hours-exact::u2_typo** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-hours-exact::u2_repeat_letters** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-insurance-exact::u0** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-insurance-exact::u0_missing_hamza** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-insurance-exact::u0_drop_punctuation** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-insurance-exact::u1** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-insurance-exact::u1_missing_hamza** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-insurance-exact::u1_drop_punctuation** — expected `FAQ/reply/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-insurance-exact::u2** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-insurance-exact::u2_missing_hamza** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-insurance-exact::u2_drop_punctuation** — expected `FAQ/reply/NOT_REQUIRED` · actual `FAQ/reply/no-handoff` · **PASS**
- **st-faq-parking-paraphrase::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-parking-paraphrase::u0_missing_hamza** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-parking-paraphrase::u1** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-parking-paraphrase::u1_missing_hamza** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-parking-paraphrase::u2** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-orthodontics-kids-paraphrase::u0** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-orthodontics-kids-paraphrase::u1** — expected `BOOKING/booking_handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-no-match-empty-kb::u0** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-no-match-empty-kb::u0_missing_hamza** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-no-match-empty-kb::u0_drop_punctuation** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-no-match-empty-kb::u1** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-faq-no-match-empty-kb::u1_drop_punctuation** — expected `AMBIGUOUS/handoff/NOT_REQUIRED` · actual `AMBIGUOUS/handoff/handoff` · **FAIL** (HANDOFF_UNNECESSARY)
- **st-booking-basic::u0** — expected `BOOKING/booking_handoff/ACCEPTABLE_EITHER` · actual `BOOKING/booking_handoff/handoff` · **PASS**
- **st-booking-basic::u0_missing_hamza** — expected `BOOKING/booking_handoff/ACCEPTABLE_EITHER` · actual `BOOKING/booking_handoff/handoff` · **PASS**
- **st-booking-basic::u0_typo** — expected `BOOKING/booking_handoff/ACCEPTABLE_EITHER` · actual `BOOKING/booking_handoff/handoff` · **PASS**
- **st-booking-basic::u0_arabizi** — expected `BOOKING/booking_handoff/ACCEPTABLE_EITHER` · actual `AMBIGUOUS/handoff/handoff` · **LIMITATION** (INTENT_MISCLASSIFIED)
- **st-booking-basic::u1** — expected `BOOKING/booking_handoff/ACCEPTABLE_EITHER` · actual `BOOKING/booking_handoff/handoff` · **PASS**

## 7. Traceability

Every number derives from `caseResults[]` in `evaluation-run.json`. Each record carries `caseId`, `scenarioId`, the expected snapshot, the actual outcome, the verdict, and the failure category. Filter the JSON by any field to reproduce a metric exactly. `manifest.json` pins the dataset hash + evaluator/scoring versions for replay.
