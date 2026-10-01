# FlowPilot AI — Current-AI Baseline Report

> Dataset: `egyptian-v1` · generated 2026-09-28T20:34:07.702Z
> Subject: current FlowPilot AI (deterministic classifier + disclosure gate), offline replay

## 1. Dataset size

measure | value
cases | 934
scenarios | 169
LONG_MULTI_TURN | 13
MEDIUM_MULTI_TURN | 7
SHORT_MULTI_TURN | 187
SINGLE_TURN | 637
TWO_TURN | 90
BASELINE_COMPATIBLE cases | 614
FUTURE_ARCHITECTURE cases | 320

## 2. Baseline metrics

metric | value
intent accuracy (strict) | 69.0%
intent accuracy (limitation-adjusted) | 89.3%
action accuracy (strict) | 75.2%
action accuracy (limitation-adjusted) | 92.1%
handoff precision | 21.2%
handoff recall | 91.9%
unnecessary handoff rate | 74.4%
missed handoff rate | 8.1%
entity extraction accuracy | 93.3%
FAQ answer correctness | 50.9%
multi-intent success rate | 63.0%
ambiguity handled acceptably | 88.1%
conversation continuity accuracy | 51.7%
safety violation rate | 0.0%
malformed output rate | 0.0%
deterministic bypass correctness | 66.2%
engine-seam-owned turns (excluded) | 11

Handoff truth split — TRUE human required: **57**, missed: **5**, unnecessary: **212**, acceptable-by-design (booking routed to staff): **587**, correctly no handoff: **73**. Verdicts — PASS **644**, LIMITATION **190**, FAIL **100**.

## 3. Top failure categories (edge category)

edge category | cases | FAIL | LIMITATION
BOOKING_JOURNEY | 273 | 24 | 63
KNOWLEDGE_PARAPHRASE | 66 | 19 | 10
KNOWLEDGE_EXACT | 53 | 17 | 0
NORMAL | 48 | 14 | 7
HANDOFF_EXPLICIT | 49 | 14 | 5
ADVERSARIAL | 106 | 10 | 7
MULTI_INTENT | 121 | 9 | 32
CONFIRMATION | 17 | 9 | 0
FOLLOW_UP | 93 | 4 | 42
HANDOFF_UNNECESSARY_RISK | 36 | 3 | 0
SECURITY_INJECTION | 41 | 3 | 0
KNOWLEDGE_MULTIPLE | 7 | 2 | 0

## 4. Top unnecessary-handoff categories

semantic intent | unnecessary handoffs | sample case ids
FAQ | 43 | st-faq-insurance-exact::u1, st-faq-insurance-exact::u1_missing_hamza, st-faq-insurance-exact::u1_drop_punctuation
SERVICE_DISCOVERY | 27 | st-service-discovery::u0, st-service-discovery::u0_drop_punctuation, st-service-discovery::u1
RESCHEDULE | 18 | st-reschedule-basic::u0, st-reschedule-basic::u0_missing_hamza, st-reschedule-basic::u0_typo
GREETING | 17 | st-greeting-basic::u0_typo, st-greeting-basic::u1_repeat_letters, st-greeting-basic::u1_typo
HOURS | 16 | st-faq-hours-exact::u2, st-faq-hours-exact::u2_drop_punctuation, st-faq-hours-exact::u2_typo
SERVICE_PRICE | 14 | st-service-price::u0, st-service-price::u0_missing_hamza, st-service-price::u0_drop_punctuation
LOCATION | 14 | st-location::u0, st-location::u0_drop_punctuation, st-location::u1
CANCELLATION | 13 | st-cancellation-basic::u0, st-cancellation-basic::u0_missing_hamza, st-cancellation-basic::u1
SERVICE_INFO | 12 | st-faq-orthodontics-kids-paraphrase::u0, st-faq-orthodontics-kids-paraphrase::u1, st-faq-no-match-empty-kb::u0
FOLLOW_UP | 12 | mt-repeat-faq::u0, mt-recap-request::u0, mt-recap-request::u1
TOPIC_SWITCH | 10 | mt-topic-switch-booking-to-hours::u0, mt-topic-switch-booking-to-hours::u0_drop_punctuation, mt-topic-switch-booking-to-hours::u2
HUMAN_REQUEST | 7 | lb-human-msa::u0, lb-human-msa::u0_missing_hamza, lb-human-msa::u1
AMBIGUOUS | 4 | st-ambiguous-idk::u0, st-ambiguous-idk::u1, st-ambiguous-idk::u1_missing_hamza
BUSINESS_INFO | 3 | st-business-info::u0, st-business-info::u1, st-business-info::u2
KNOWLEDGE_GAP | 2 | ex-faq-sparse-tenant::u0, ex-faq-sparse-tenant::u1

### 4b. MISSED handoffs — a human was required and the AI did not hand off

caseId | message | expected | actual
mt-human-plus-question::u1 | وصلني بحد — وبعدين عايز أعرف ساعات ا | HUMAN_REQUEST/HUMAN_REQUEST | FAQ/-
mt-human-plus-question::u1_missing_hamza | وصلني بحد — وبعدين عايز اعرف ساعات ا | HUMAN_REQUEST/HUMAN_REQUEST | FAQ/-
adv-greeting-plus-human::u1 | أهلاً، وصلني بموظف لو سمحت | HUMAN_REQUEST/HUMAN_REQUEST | GREETING/-
adv-greeting-plus-human::u1_missing_hamza | اهلاً، وصلني بموظف لو سمحت | HUMAN_REQUEST/HUMAN_REQUEST | GREETING/-
adv-greeting-plus-human::u1_drop_punctuation | أهلاً وصلني بموظف لو سمحت | HUMAN_REQUEST/HUMAN_REQUEST | GREETING/-

These are the highest-severity findings in the baseline: the customer asked for a human (or a sensitive turn needed staff) and the thread stayed AI_ACTIVE with a self-authored reply.

## 5. Knowledge-gap categories

knowledge requirement | cases | not self-answered | sample case ids
NONE | 730 | 693 | st-greeting-basic::u0_typo, st-greeting-basic::u1_repeat_letters, st-greeting-basic::u1_typo
PARAPHRASED_FAQ | 66 | 57 | st-faq-parking-paraphrase::u0, st-faq-parking-paraphrase::u0_missing_hamza, st-faq-parking-paraphrase::u1
NOT_PRESENT | 35 | 35 | st-faq-no-match-empty-kb::u0, st-faq-no-match-empty-kb::u0_missing_hamza, st-faq-no-match-empty-kb::u0_drop_punctuation
NOT_EXPOSED | 27 | 27 | st-service-discovery::u0, st-service-discovery::u0_drop_punctuation, st-service-discovery::u1
EXACT_FAQ | 53 | 20 | st-faq-hours-exact::u2, st-faq-hours-exact::u2_drop_punctuation, st-faq-hours-exact::u2_typo
PRICE | 14 | 14 | st-service-price::u0, st-service-price::u0_missing_hamza, st-service-price::u0_drop_punctuation
SERVICE_INFO | 8 | 8 | ex-service-info-variants::u0, ex-service-info-variants::u0_drop_punctuation, ex-service-info-variants::u1
BUSINESS_INFO | 3 | 3 | st-business-info::u0, st-business-info::u1, st-business-info::u2
MULTIPLE_PLAUSIBLE | 7 | 2 | ex-faq-multiple-plausible::u1, ex-faq-multiple-plausible::u1_drop_punctuation
WEAK_FAQ | 2 | 1 | st-faq-weak-hours::u1

### 5b. Self-answer rate by semantic intent

semantic intent | cases | self-answered | acceptable handoff | unnecessary
BOOKING | 260 | 5 | 255 | 0
FAQ | 79 | 30 | 6 | 43
HUMAN_REQUEST | 71 | 5 | 59 | 7
AMBIGUOUS | 70 | 1 | 65 | 4
AVAILABILITY | 60 | 0 | 60 | 0
FOLLOW_UP | 56 | 3 | 41 | 12
CLARIFICATION_REQUIRED | 44 | 1 | 43 | 0
MULTI_INTENT | 40 | 0 | 40 | 0
GREETING | 39 | 22 | 0 | 17
HOURS | 33 | 9 | 8 | 16
SERVICE_DISCOVERY | 33 | 0 | 6 | 27
SERVICE_INFO | 32 | 6 | 14 | 12
RESCHEDULE | 29 | 0 | 11 | 18
CANCELLATION | 22 | 0 | 9 | 13
KNOWLEDGE_GAP | 19 | 0 | 17 | 2
TOPIC_SWITCH | 16 | 3 | 3 | 10
SERVICE_PRICE | 14 | 0 | 0 | 14
LOCATION | 14 | 0 | 0 | 14
CONFIRMATION | 11 | 0 | 11 | 0
BUSINESS_INFO | 3 | 0 | 0 | 3

## 6. Architectural limitations by semantic intent

semantic intent | limitation cases | sample case ids
BOOKING | 82 | st-booking-basic::u0_arabizi, st-booking-basic::u1_arabizi, st-booking-service-filling::u1_typo
AVAILABILITY | 28 | st-availability-basic::u2, st-availability-basic::u2_drop_punctuation, st-availability-basic::u2_repeat_letters
FOLLOW_UP | 22 | ex-booking-status-ask::u0, ex-booking-status-ask::u1, ex-booking-status-ask::u1_missing_hamza
MULTI_INTENT | 22 | mt-multi-question-one-turn::u1, mt-multi-question-one-turn::u1_missing_hamza, mt-multi-question-one-turn::u3
HOURS | 8 | st-faq-weak-hours::u0, ex-faq-hours-paraphrase-2::u0, ex-faq-hours-paraphrase-2::u1
TOPIC_SWITCH | 7 | mt-topic-switch-booking-to-hours::u1, mt-topic-switch-booking-to-hours::u1_missing_hamza, mt-topic-switch-booking-to-hours::u1_drop_punctuation
SERVICE_DISCOVERY | 6 | st-service-discovery::u2, st-service-discovery::u2_drop_punctuation, mt-second-service::u1
FAQ | 5 | lb-faq-mixed::u0, lb-faq-mixed::u1, lb-faq-mixed::u1_missing_hamza
CANCELLATION | 5 | mt-booking-change-mind::u0, mt-booking-change-mind::u0_missing_hamza, mt-booking-change-mind::u1
SERVICE_INFO | 2 | st-faq-orthodontics-kids-paraphrase::u0, st-faq-orthodontics-kids-paraphrase::u1
AMBIGUOUS | 2 | st-very-short::u2, st-very-short::u3
CLARIFICATION_REQUIRED | 1 | st-ambiguous-oneword::u3

## 7. Language / register robustness

language register | cases | FAIL | LIMITATION
EGYPTIAN_COLLOQUIAL | 830 | 85 | 182
MSA | 53 | 10 | 0
EGYPTIAN_FORMALISH | 9 | 3 | 0
MIXED_EGY_MSA | 14 | 1 | 3
ARABIC_ENGLISH | 6 | 1 | 2
ARABIZI | 16 | 0 | 2
ENGLISH | 17 | 0 | 1

## 8. Traceability

Every metric above is computed from the per-case records in the sibling `.json` report (`caseResults[]`): each record carries `caseId`, `scenarioId`, the evaluated message, the expected vs actual outcome, and the verdicts. Filter `caseResults` by any field to reproduce a number exactly. Turns owned by the deterministic booking-selection seam (`intentVerdict === "SEAM_OWNED"`) are recorded but excluded from AI metrics — the engine resolves them before any assistant call.
