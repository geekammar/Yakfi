# FlowPilot AI — Baseline Findings (egyptian-v1)

> Evidence report for the CURRENT production AI, recorded by the
> `PROMPT-AI-EVAL-FOUNDATION-01` slice. Dataset: `egyptian-v1`
> (945 cases / 171 scenarios). Subject: the deterministic classifier
> (`conversation-ai.ts`) + the customer disclosure gate (`ai-disclosure`),
> replayed offline through the exact engine turn chain. Regenerate with
> `pnpm eval:baseline`.
>
> **This is EVIDENCE ONLY.** No production behavior was changed, no fix is
> implemented, and no recommendation below has been built (see the hard stop
> in the slice brief).

## Headline metrics

| metric                                | value | reading                                                     |
| ------------------------------------- | ----- | ----------------------------------------------------------- |
| intent accuracy (strict)              | 69.0% | one case in three misclassifies relative to the gold label  |
| intent accuracy (limitation-adjusted) | 89.3% | most of the gap is architectural, not a classifier bug      |
| action accuracy (limitation-adjusted) | 91.1% |                                                             |
| handoff recall                        | 91.9% | **strong** — a required handoff is almost always fired      |
| handoff precision                     | 21.2% | **weak** — it escalates far more than truly needed          |
| unnecessary handoff rate              | 74.4% | of the turns where no human was needed, most were escalated |
| missed handoff rate                   | 8.1%  | small in rate, but each is high severity (see F1)           |
| entity extraction accuracy            | 93.3% | **strong** — verbatim service matching is reliable          |
| FAQ answer correctness                | 50.9% | half of answerable knowledge questions are not answered     |
| multi-intent success rate             | 63.0% | secondary intents are routinely lost                        |
| conversation continuity accuracy      | 51.7% | memory-dependent turns fail about half the time             |
| safety violation rate                 | 0.0%  | **strong** — no injection case was honoured or leaked       |
| malformed output rate                 | 0.0%  | **strong** — the contract is never violated                 |

Handoff truth split: TRUE human required **57**, missed **5**, unnecessary
**212**, acceptable-by-design (booking routed to staff) **587**, correct
no-handoff **73**. Verdicts across 934 AI-scored cases: PASS **644**,
LIMITATION **190**, FAIL **100** (11 further cases are owned by the
deterministic booking-selection seam and excluded).

## Top 10 failure categories (evidence, with traceable case ids)

1. **F1 — Egyptian clitic attachment swallows an explicit human request**
   (highest severity). `stripAffixes` only strips `ال`/`وال`, so `بموظف`
   never matches the `موظف` keyword. Because `isPureGreeting` runs _before_
   the HUMAN_REQUEST branch, a greeting + human request is answered as a
   **GREETING reply with no handoff** — the thread stays AI_ACTIVE.
   `adv-greeting-plus-human::u1`, `::u1_missing_hamza`, `::u1_drop_punctuation`.
   A related variant (`وصلني بحد`) misses the human phrase table entirely and
   answers a FAQ instead: `mt-human-plus-question::u1*`. All 5 recorded
   MISSED handoffs come from this single root cause.

2. **F2 — Paraphrased knowledge falls below the token-overlap threshold.**
   `faqMatchScore` requires ≥2 shared distinctive tokens, but Egyptian
   paraphrases rarely share surface tokens with the stored question
   ("بتفتحوا الساعة كام؟" vs stored "ما هي ساعات العمل؟" → 0 shared).
   `ex-faq-insurance-paraphrase*` (9), `ex-faq-hours-paraphrase-1*` (7),
   `st-faq-parking-paraphrase*`, `st-faq-orthodontics-kids-paraphrase*`.

3. **F3 — Noise sensitivity: single-character typos destroy intent.**
   Authored meaning is preserved but the keyword is destroyed:
   "اللسام عليكم" / "أهلللاً" / "صبحا الخير" → AMBIGUOUS instead of GREETING.
   `st-greeting-basic::u0_typo`, `ex-greeting-variants*` (10 total). The
   normalizer repairs hamza/tatweel but not transposition or letter loss.

4. **F4 — No conversation state: partial answers and implicit references.**
   A bare "الخميس" after "أنهي يوم يناسبك؟" cannot be bound to the booking,
   so it falls through to AMBIGUOUS. Same for "تمام" after a numbered offer,
   "نفس المعاد", "اللي قولتلي عليه", and "لا" after an offer.
   `mt-partial-date-only*`, `mt-booking-post-offer-tamam*`,
   `mt-implicit-same-slot*`, `mt-implicit-mentioned*`, `mt-no-after-offer*`.
   This is the single largest LIMITATION bucket (conversation continuity
   accuracy 51.7%).

5. **F5 — Multi-intent collapse to the highest-priority single intent.**
   "عايز أحجز، بالمناسبة بتفتحوا الساعة كام؟" keeps BOOKING and silently
   drops the hours question; "عايز موظف بس الأول قولي هل عندكم تقويم؟"
   keeps HUMAN_REQUEST and drops the service question. The contract carries
   one `intent` per turn, so the secondary ask is unreachable.
   `mt-multi-question-one-turn*`, `mt-topic-switch-booking-to-hours*`,
   `mt-booking-plus-unrelated*`, `mt-human-plus-question*`.

6. **F6 — Knowledge exists but is not exposed (unnecessary handoff).**
   Service discovery ("بتعملوا ايه من الخدمات؟") and service info could be
   answered from the catalog already in context, but no intent represents
   them and `about`/`description` sit outside the context budget.
   `st-service-discovery*` (27 unnecessary), `ex-service-discovery-variants*`,
   `st-business-info*`, `ex-service-info-variants*`.

7. **F7 — Clarifiable ambiguity is escalated instead of clarified.**
   "التنظيف", "أي وقت", "مش عارف" are answerable with one clarifying
   question; the architecture can only hand off. "معاد تاني" additionally
   risks a false RESCHEDULE read. `st-ambiguous-oneword*`,
   `mt-any-time*`, `st-ambiguous-idk*`.

8. **F8 — Register gaps: Arabizi and English are unreachable.**
   Latin-script Egyptian ("3ayez a7gez maw3ed") and English booking requests
   never match the Arabic keyword tables — always AMBIGUOUS.
   `st-arabizi-booking*`, `lb-availability-arabizi*`, `st-booking-english*`,
   `lb-english-faq*`. (Note: the outcome is still SAFE — a handoff — it is a
   coverage gap, not a safety gap.)

9. **F9 — Social protocols escalate unnecessarily.** "شكراً", "الحمد لله",
   and a question-marked greeting ("السلام عليكم؟") fall to AMBIGUOUS /
   NO_KNOWLEDGE handoffs even though they carry no request.
   `adv-thanks-only*`, `adv-hamd-only*`, `ex-greeting-question-risk*`,
   `mt-bot-identity-question*` (the identity question "إنت إنسان ولا
   روبوت؟" hits the `إنسان` human keyword and escalates — 4 cases).

10. **F10 — Status / follow-up intents are unrepresented.** Booking-status
    asks, recap requests, reminder preferences, and waitlist requests have no
    intent and no knowledge channel.
    `ex-booking-status-ask*`, `mt-recap-request*`, `mt-reminder-preference*`,
    `mt-waitlist-earliest*`.

## Strongest current behaviours (keep these)

- **Safety boundary holds**: 0 safety violations across 41 injection cases;
  no system-instruction, hidden-prompt, credential, or impersonation request
  was honoured, and no structured payload pre-authored the response.
- **Contract integrity**: 0 malformed outputs; `parseAiResponse` never
  rejects the deterministic path; unknown keys are stripped by construction.
- **Required-handoff recall 91.9%**: sensitive/high-risk language and
  explicit human requests reach staff almost always (the only hole is F1).
- **Entity extraction 93.3%**: verbatim Arabic service matching is reliable,
  including across hamza/normalization variants.
- **Determinism**: the whole baseline is byte-reproducible (`check:eval` D4).

## Architectural limitations (LIMITATION verdicts, 190 cases)

The contract, not the classifier, is the binding constraint here — these are
the cases the current design cannot represent even in principle:

| semantic intent                                   | limitation cases | what is missing                                                                       |
| ------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| BOOKING                                           | 82               | booking is routed to staff; no slot-aware self-serve, no Arabizi/typo keywords        |
| AVAILABILITY                                      | 28               | availability handoff is the only outcome; no domain-slot answer path from the AI turn |
| FOLLOW_UP                                         | 22               | no status / recap / reminder intents                                                  |
| MULTI_INTENT                                      | 22               | one `intent` per response; secondary intents unrepresentable                          |
| HOURS                                             | 8                | no semantic FAQ matching (token overlap only)                                         |
| TOPIC_SWITCH                                      | 7                | no conversation-state to suspend/resume                                               |
| SERVICE_DISCOVERY                                 | 6                | catalog not answerable (outside context budget)                                       |
| FAQ                                               | 5                | paraphrase matching                                                                   |
| CANCELLATION                                      | 5                | no clarification for abandon-vs-keep-pending                                          |
| SERVICE_INFO / AMBIGUOUS / CLARIFICATION_REQUIRED | 5                | no service-detail channel; no clarification action                                    |

## Cases that demonstrate architectural limits (J)

- `st-service-discovery::u0` — catalog in context, no listing intent.
- `st-service-price::u0` — no price knowledge channel exists.
- `mt-booking-post-offer-tamam::u0` — "تمام" after an offer; no selection
  state (the deterministic seam only parses index/time/provider text).
- `mt-implicit-same-slot::u0` — "نفس المعاد"; reference needs held state.
- `mt-multi-question-one-turn::u0` — two intents, one response field.
- `st-ambiguous-oneword::u0` — clarifiable, but no clarification action exists.
- `st-business-info::u0` — `about` is PUBLIC but outside the context budget.
- `mt-recap-request::u0` — conversation summary needs held state.
- `st-arabizi-booking::u0` / `st-booking-english::u0` — Latin script unreachable.
- `mt-long-drift::u0` — 12-message context with a late constraint addition.

## Recommended NEXT architectural work (evidence-derived, NOT implemented)

Ordered strictly by the evidence above:

1. **Close F1 first (safety):** teach the tokenizer to strip Egyptian clitics
   (`بـ`/`كـ`/`لـ`), and move the explicit-human-request check ahead of the
   pure-greeting check. It removes 100% of the recorded MISSED handoffs.
2. **Conversation state (JEV-aligned):** hold entities + the last offer
   across turns to bind "تمام" / "لا" / "نفس المعاد" / partial answers.
   Addresses F4 and most of F5 and F7.
3. **Clarification action:** add a `clarify` action so ambiguity becomes a
   question instead of an escalation (F7), cutting the unnecessary-handoff
   rate substantially (212 cases today).
4. **Semantic knowledge matching:** replace token-overlap scoring with
   embedding/normalized-semantic matching, and expose service discovery /
   service info / business info (F2, F6, F10).
5. **Multi-intent support:** carry secondary intents so an accompanying
   question is answered rather than swallowed (F5).
6. **Noise-robust normalization:** keyboard-level repair (transposition,
   letter loss) on keyword tables (F3).
7. **Register coverage:** Arabizi + English recognition for booking/FAQ (F8).
8. **Social protocols:** treat thanks/acknowledgment and identity questions
   as knowledge-free replies (F9).

None of the above is built by this slice; each is backed by case ids above.
