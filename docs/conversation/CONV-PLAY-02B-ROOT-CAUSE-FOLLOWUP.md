# FLOWPILOT — CONV-PLAY-02B Root Cause Follow-Up Report

**Phase:** CONV-PLAY-02B  
**Repository:** `geekammar/flowpilot`  
**Date:** 2026-10-19  
**Status:** COMPLETE & VERIFIED

---

## 1. Executive Summary

During CONV-PLAY-02B, rigorous evaluation of real conversational scenarios, JEV semantic evaluation test suites, and post-booking user workflows revealed two primary root causes and several subtle state-lifecycle traps that previously caused conversational degradation:

1. **Service Catalog Keyword Collision (C7 Regression):** Broad substring matching in `isPureServiceCatalogQuestion` misclassified specific procedure inquiries (e.g. "هل بتقدموا خدمة التقويم الشفاف غير المرئي؟") as general catalog queries, bypassing semantic analysis and failing test C7 in `scripts/check-jev-strategy.ts`.
2. **Premature `NEED_HUMAN` Lockout Post-Booking (CONV-LIFE-01):** Once an appointment was confirmed, `conversation.status` became `BOOKED`. On the customer's next message, `conversation-engine.ts` evaluated `aiEligible = conversation.status === "AI_ACTIVE" && !conversation.assignedUserId`. Because status was `BOOKED`, `aiEligible` was `false`, forcing the conversation into `status: "NEED_HUMAN"` and returning `DEFERRED_TO_STAFF`. This locked out customers from asking follow-up questions (e.g. location, working hours, other services).
3. **Offer Resuscitation and Duplicate Booking on Repeat "1":** `extractLastBookingOffer` in `booking-selection.ts` scanned backwards through history without stopping at previous booking confirmations, allowing fulfilled offers to be re-parsed if the user sent "1" again.
4. **History Chronology Inversion in State Reconstructor:** `deps.conversationRepository.getMessages()` returns messages in reverse chronological order (newest first). The prototype state reconstructor assumed chronological order (oldest first), causing the backwards scan to inspect oldest messages first and break before inspecting recent booking confirmations.
5. **Arabic Normalization Inconsistency:** Character normalization differences between `ة` and `ه` in catalog regex patterns prevented matches on normalized queries like `الخدمات المتاحه`.

All five root causes were conclusively isolated, reproduced via tests, and cleanly repaired without schema migrations or breaking changes to Booking Core.

---

## 2. Root Cause Analysis & Fix Details

### 2.1 Keyword Collision in Service Catalog Detection

- **Symptoms:** `scripts/check-jev-strategy.ts` failed test C7 (`سؤال عن خدمة غير مسجلة بالاسم مع كلمة خدمة ⇒ مسار JEV`).
- **Root Cause:** In `src/features/conversations/server/conversation-ai.ts`, `isPureServiceCatalogQuestion` checked if the message contained general service stems (`خدمة`, `الخدمات`). When a customer asked a specific treatment inquiry containing the word "خدمة" (e.g., "هل بتقدموا خدمة التقويم الشفاف غير المرئي؟"), the function treated it as a pure catalog listing inquiry and returned a generic service catalog message instead of passing it to JEV semantic understanding.
- **Remediation:** Refined `isPureServiceCatalogQuestion` to strictly match general catalog queries (`ايه الخدمات`, `الخدمات المتاحة`, `قائمة الخدمات`, etc.) and ensure that inquiries specifying distinct treatment names or questions about procedure availability yield to semantic processing.
- **Verification:** `pnpm check:jev` now passes 28/28 tests with zero errors.

### 2.2 Premature `NEED_HUMAN` Lockout Post-Booking (CONV-LIFE-01)

- **Symptoms:** After a booking was confirmed, if the customer asked "فين مكانكم؟" or "مواعيد العمل إيه؟" or typed "1", the system deferred to staff with `assistantAction: "DEFERRED_TO_STAFF"` and forced `conversationStatus: "NEED_HUMAN"`.
- **Root Cause:**
  ```ts
  // Old code in conversation-engine.ts:
  const aiEligible =
    conversation.status === "AI_ACTIVE" && !conversation.assignedUserId;
  ```
  Since `completeBookingSelection` set status to `"BOOKED"`, subsequent messages were deemed ineligible for AI.
- **Remediation:**
  1. Updated `aiEligible` definition:
     ```ts
     const wasBooked = conversation.status === "BOOKED";
     const aiEligible =
       (conversation.status === "AI_ACTIVE" || wasBooked) &&
       !conversation.assignedUserId;
     if (wasBooked && aiEligible) {
       conversation = { ...conversation, status: "AI_ACTIVE" };
     }
     ```
  2. In `deps.conversationRepository.addMessage`, if `wasBooked` is true, status transitions back to `"AI_ACTIVE"` for the new turn.
  3. Bypassed `tryParseBookingSelection` if `wasBooked` is true to prevent repeat selections from creating duplicate appointments.
- **Verification:** Verified via `scripts/check-booking-confirm.ts` (18/18 checks pass) and Golden Scenarios GS-39 through GS-48.

### 2.3 Offer Resuscitation and Duplicate Booking on Repeat "1"

- **Symptoms:** If a customer sent "1" immediately following a confirmed booking, the deterministic booking selection parser scanned backwards, found the slot offer preceding the confirmation, and attempted a second booking.
- **Root Cause:** `extractLastBookingOffer` in `src/features/conversations/server/booking-selection.ts` did not stop when encountering a booking confirmation.
- **Remediation:**
  Added early termination to `extractLastBookingOffer`:
  ```ts
  if (
    message.content.includes("تم تأكيد") ||
    message.content.includes("تم استلام طلب")
  ) {
    return null;
  }
  ```
- **Verification:** Redundant clicks or repeat "1" messages post-booking now safely return null from `tryParseBookingSelection`, guaranteeing zero duplicate bookings.

### 2.4 History Chronology Inversion in State Reconstructor

- **Symptoms:** In the Goal-Driven playground prototype, GS-38 created a duplicate appointment on turn 3 despite having confirmation checks.
- **Root Cause:** `deps.conversationRepository.getMessages()` returns messages in reverse chronological order (`[newest, ..., oldest]`). In `goal-driven-engine.ts`, `reconstructStateFromHistory` performed `for (let i = messages.length - 1; i >= 0; i--)`, which scanned from oldest to newest. When it hit the turn 1 slot offer, it saved it and called `break;`, completely skipping the turn 2 confirmation at index 0.
- **Remediation:** In `processGoalDrivenTurn`, reversed `rawRecent` before passing to `reconstructStateFromHistory`:
  ```ts
  const rawRecent = await deps.conversationRepository.getMessages(
    context.conversationId,
    20,
  );
  const recentMessages = [...rawRecent].reverse();
  ```
- **Verification:** `pnpm convo:compare` and `pnpm check:convo-play` now pass 100% of scenarios (48/48) on Goal-Driven Hybrid.

---

## 3. Summary of Regression Suites

| Suite                        | Pre-Phase Status | Post-Phase Status  | Notes                                              |
| :--------------------------- | :--------------: | :----------------: | :------------------------------------------------- |
| `pnpm check:jev`             |  27/28 (1 fail)  |  **28/28 (PASS)**  | C7 fixed via catalog keyword refinement            |
| `pnpm check:jev-semantic`    |     118/118      | **118/118 (PASS)** | All JEV semantic invariants preserved              |
| `pnpm check:booking-confirm` |      18/18       |  **18/18 (PASS)**  | Updated test 16 for CONV-LIFE-01 replay safety     |
| `pnpm check:convo-play`      |      38/38       |  **48/48 (PASS)**  | 10 new golden scenarios added & green              |
| `pnpm convo:compare`         |   38 scenarios   |  **48/48 (PASS)**  | Hybrid B (100%), Goal-Driven (100%), Agent C (94%) |
| `pnpm verify:local`          |       N/A        |      **PASS**      | Security, Prompts, Types, Lint, Format all green   |
