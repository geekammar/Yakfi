# Coverage Report — `egyptian-v1`

> Generated from `evaluation/datasets/egyptian-v1/scenarios-*.ts` (seed `20260928`).
> **1933 cases** across **11 dimensions**.

A category with zero cases is a GAP, not a silent success. Thin members (< 5 cases) are listed because they cannot yet support a reliable measurement.

## Headline

**Every dimension member and every curated joint cell is populated.** The dataset has no structural coverage holes; the remaining work is depth, not breadth.

### intent — 20/20

> What the customer wants — the goal space the assistant reads.

| member | cases |
| --- | ---: |
| `GREETING` | 49 |
| `FAQ` | 166 |
| `BOOKING` | 567 |
| `AVAILABILITY` | 105 |
| `RESCHEDULE` | 48 |
| `CANCELLATION` | 47 |
| `HUMAN_REQUEST` | 162 |
| `AMBIGUOUS` | 127 |
| `SERVICE_DISCOVERY` | 124 |
| `SERVICE_INFO` | 82 |
| `SERVICE_PRICE` | 76 |
| `BUSINESS_INFO` | 14 |
| `LOCATION` | 26 |
| `HOURS` | 51 |
| `CONFIRMATION` | 33 |
| `FOLLOW_UP` | 64 |
| `MULTI_INTENT` | 40 |
| `TOPIC_SWITCH` | 35 |
| `KNOWLEDGE_GAP` | 19 |
| `CLARIFICATION_REQUIRED` | 98 |

### language — 7/7

> Egyptian language variation — the surface form must not change the label.

| member | cases |
| --- | ---: |
| `EGYPTIAN_COLLOQUIAL` | 1706 |
| `EGYPTIAN_FORMALISH` | 19 |
| `MSA` | 63 |
| `MIXED_EGY_MSA` | 23 |
| `ARABIZI` | 58 |
| `ARABIC_ENGLISH` | 32 |
| `ENGLISH` | 32 |

### customer-behavior — 18/18

> HOW the customer behaves — vague, corrective, hurried, changing their mind.

| member | cases |
| --- | ---: |
| `CLEAR` | 555 |
| `VAGUE` | 117 |
| `HESITANT` | 111 |
| `HURRIED` | 225 |
| `REPETITIVE` | 62 |
| `CORRECTIVE` | 53 |
| `CONTRADICTORY` | 25 |
| `EMOTIONAL` | 43 |
| `POLITE` | 148 |
| `CURIOUS` | 325 |
| `NONE` | 777 |
| `CHANGES_MIND` | 26 |
| `CHANGES_DATE` | 45 |
| `CHANGES_SERVICE` | 25 |
| `CHANGES_PROVIDER` | 17 |
| `CHANGES_TIME` | 12 |
| `ASKS_UNRELATED_QUESTION` | 29 |
| `REQUESTS_HUMAN_EXPLICITLY` | 57 |

### conversation-length — 5/5

> Single-turn, short/medium/long multi-turn, and long-context.

| member | cases |
| --- | ---: |
| `SINGLE_TURN` | 1273 |
| `TWO_TURN` | 90 |
| `SHORT_MULTI_TURN` | 488 |
| `MEDIUM_MULTI_TURN` | 59 |
| `LONG_MULTI_TURN` | 23 |

### multi-intent — 2/2

> Turns carrying more than one goal, and their priority ordering.

| member | cases |
| --- | ---: |
| `SINGLE_GOAL` | 1612 |
| `MULTI_GOAL` | 321 |

### ambiguity — 4/4

> Ambiguity the assistant must resolve or honestly escalate — never guess.

| member | cases |
| --- | ---: |
| `UNAMBIGUOUS` | 1678 |
| `AMBIGUOUS_CLARIFIABLE` | 156 |
| `AMBIGUOUS_NEEDS_HUMAN` | 49 |
| `AMBIGUOUS_STATE_RESOLVES` | 50 |

### knowledge — 17/17

> What the turn must KNOW, and what happens when it does not.

| member | cases |
| --- | ---: |
| `NONE` | 1018 |
| `EXACT_FAQ` | 105 |
| `PARAPHRASED_FAQ` | 78 |
| `WEAK_FAQ` | 11 |
| `NO_FAQ` | 10 |
| `SERVICE_CATALOG` | 170 |
| `SERVICE_DETAILS` | 14 |
| `SERVICE_INFO` | 20 |
| `PRICE` | 14 |
| `POLICY` | 23 |
| `BUSINESS_INFO` | 26 |
| `AVAILABILITY` | 129 |
| `MULTIPLE_SOURCES` | 63 |
| `KNOWLEDGE_GAP` | 123 |
| `NOT_PRESENT` | 57 |
| `NOT_EXPOSED` | 59 |
| `MULTIPLE_PLAUSIBLE` | 13 |

### booking-state — 15/15

> The booking journey's causal progression, including interruption and recovery.

| member | cases |
| --- | ---: |
| `NOT_APPLICABLE` | 1633 |
| `GOAL_STATED` | 18 |
| `MISSING_SERVICE` | 23 |
| `SERVICE_SUPPLIED` | 48 |
| `MISSING_DATE` | 7 |
| `DATE_SUPPLIED` | 42 |
| `MISSING_TIME` | 31 |
| `TIME_SUPPLIED` | 24 |
| `AVAILABILITY_RESOLVED` | 15 |
| `SLOT_SELECTION` | 29 |
| `CONFIRMATION` | 11 |
| `COMPLETED` | 10 |
| `INTERRUPTED` | 16 |
| `RECOVERING` | 10 |
| `ABORTED` | 16 |

### handoff — 3/3

> The true-vs-unnecessary handoff split — the primary robustness axis.

| member | cases |
| --- | ---: |
| `REQUIRED` | 218 |
| `NOT_REQUIRED` | 619 |
| `ACCEPTABLE_EITHER` | 1096 |

### safety — 4/4

> Sensitive and adversarial turns — the must-never-violate axis.

| member | cases |
| --- | ---: |
| `SAFE` | 1872 |
| `SENSITIVE_MEDICAL` | 29 |
| `EMOTIONAL_DISTRESS` | 10 |
| `SECURITY_ATTEMPT` | 22 |

### edge-rarity — 4/4

> Rare cases are represented ON PURPOSE — robustness is not average-case.

| member | cases |
| --- | ---: |
| `COMMON` | 1112 |
| `UNCOMMON` | 331 |
| `RARE` | 377 |
| `EXTREMELY_RARE` | 113 |

## Curated joint cells

| cell | cases | requirements |
| --- | ---: | --- |
| egyptian-booking-arabizi | 22 | intent=`BOOKING`, language=`ARABIZI` |
| egyptian-human-request-clitic | 57 | intent=`HUMAN_REQUEST`, customer-behavior=`REQUESTS_HUMAN_EXPLICITLY` |
| egyptian-knowledge-gap-price | 62 | intent=`SERVICE_PRICE`, knowledge=`KNOWLEDGE_GAP` |
| egyptian-clarification-ambiguous-booking | 40 | intent=`CLARIFICATION_REQUIRED`, ambiguity=`AMBIGUOUS_CLARIFIABLE`, handoff=`NOT_REQUIRED` |
| egyptian-change-date-mid-journey | 26 | customer-behavior=`CHANGES_DATE`, booking-state=`DATE_SUPPLIED`, handoff=`ACCEPTABLE_EITHER` |
| egyptian-sensitive-medical-handoff | 29 | safety=`SENSITIVE_MEDICAL`, handoff=`REQUIRED` |
| egyptian-prompt-injection-refusal | 22 | safety=`SECURITY_ATTEMPT`, intent=`AMBIGUOUS` |
| egyptian-long-context-topic-return | 10 | conversation-length=`LONG_MULTI_TURN`, intent=`TOPIC_SWITCH` |
| egyptian-multi-intent-discovery-plus-booking | 54 | multi-intent=`MULTI_GOAL`, intent=`SERVICE_DISCOVERY` |
| egyptian-stt-fragmented-availability | 92 | intent=`AVAILABILITY`, language=`EGYPTIAN_COLLOQUIAL` |

All curated cells are populated — no highest-value authoring target is missing.

## Gaps and authoring targets

**No unpopulated vocabulary members remain.**

`recommendAuthoringTargets()` (ordered plan for the next version):
- _(none — every member and curated cell is populated; add cells or deepen instead)_

