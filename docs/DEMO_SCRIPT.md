# FlowPilot — 5-Minute Demo Script

> A timed sales walkthrough for prospects (dental/beauty/service business
> owners). Setup instructions and clickable scenarios: `DEMO_GUIDE.md`.
> Golden rule: demo the outcome (booked appointments, calm owner), not the tech.

## Before You Start (checklist)

- [ ] `pnpm db:seed` run ≤ 1 hour ago (fresh "today" activity)
- [ ] Logged in once as admin to warm the session; browser at the dashboard
- [ ] Tab order ready: dashboard · conversations · appointments
- [ ] Mobile? Do it on the prospect's phone — the PWA installs in 30 seconds

## The Flow

### 0:00–0:30 — The Hook (dashboard)

Open the dashboard. Say:

> "دي لوحة يومك في عيادتك. عندك ٥ محادثات محتاجة قرار منك، ٤ مواعيد
> النهاردة، وموعد عاجل الساعة ٨. كله من غير ما تفتح واتساب ولا تشيك
> على مكان."

Point at the four stat cards — don't explain features yet.

### 0:30–1:30 — The AI Works (conversations)

Open **المحادثات** → the AI_ACTIVE thread (فاطمة — سعر التبييض).

> "الرسايل بتيجي على واتساب، والمساعد الذكي بيرد فورًا — من أسئلة
> منشأتك الشائعة اللي انت حاطها. العميلة سألت عن السعر، أخدت رد
> مظبوط، ومحدش اتصل بيك."

Scroll one more AI_ACTIVE thread fast (working hours / location question) to
show it's not a one-off.

### 1:30–2:45 — The Human Handoff (NEED_HUMAN)

Open the unassigned **NEED_HUMAN** thread (نورهان — تأجيل موعد).

> "المساعد مش بيتصرف لوحده في الحساس. هنا العميلة عايزة تأجل — المساعد
> جمع كل التفاصيل ووقف: محتاج قرار منك. اضغط 'تكفّل بالمحادثة'."

Take over, type a short reply (e.g. "أهلًا نورهان، متاح الخميس ١١ الصبح
يناسبك؟"), send.

> "الردود بتطلع باسم موظفك، والمحادثة بترجع للفريق — انت اللي بتقرر،
> هو اللي بيقف على الفلتر."

Show the emergency thread (عمر — وجع ضروس) in 10 seconds: "حالة عاجلة؟
المساعد حجز أقرب معاد ونبّه الاستقبال — والعميل مش مستني رد."

### 2:45–3:30 — Appointments (agenda)

Open **المواعيد**.

> "جدول اليوم: ٤ مواعيد، منهم واحد معلق. تأكيده ضغطة واحدة."

Press تأكيد on the pending appointment (optimistic update lands instantly).
Open the urgent 8pm appointment to show customer + service + notes.

### 3:30–4:15 — Back to the Dashboard (the payoff)

Return to the dashboard.

> "من غير فلوبايلت: كانت ٥ محادثات محتاجاك — دلوقتي ٤. الموعد اللي
> كان معلق بقى مؤكد. ده شغل ٣ دقايق من موبايلك."

### 4:15–5:00 — Staff & Close

Optional if time: show the staff login exists (one sentence — "موظفة
الاستقبال ليها نفس الشاشة بصلاحياتها") — don't switch accounts live.

Close with the value line:

> "الفكرة ببساطة: كل رسالة واتساب بتتحول لحجز مؤكد، واللي محتاجك بيوصللك
> فورًا — انت بتحوّل رسايل ضايعة لمواعيد محترمة، وبتربح الوقت اللي
> كنت بتصرّفه في الرد يدوي."

## Objection Cheat Sheet

| Objection (AR)                   | Answer                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| "الـ AI هيتكلم غلط باسمي"        | الحساس بيتحوّل ليك تلقائيًا (NEED_HUMAN) — انت بتاع القرار، وهو بيسهّل عليك فقط.     |
| "أنا مش بعرف أستخدم برامج"       | البرنامج عربي وموبايل أولًا — شفت الرحلة دي كلها في ٥ دقايق من غير تدريب.            |
| "عميلي بيفضل الكلام معايا"       | وهو هيتكلم معاك — المساعد بيسأل ويحجز ويعمل ملخص، وأي حاجة فوق كده بتوصلك فورًا.     |
| "عندي مواعيد كتير وبتلغبط"       | الأجندة بتاعتي بتأكيد بضغطة + كشف التعارض — محدش بيحجز موعد فوق موعد.                |
| "هل ده هينفع لصالون/عيادة/مركز؟" | نفس المحرك بيتفعّل لأي نشاط مواعيد — البيانات اللي شفتها عيادة أسنان لكن النظام عام. |

## Things NOT to Do

- Don't open settings/team/knowledge screens unless asked — demo the outcome
  (conversations → appointments), not the admin surfaces.
- Don't type long replies; every second of typing is silence.
- Don't apologize for AI messages — they're the product. If asked "هو ده
  رد آلي؟" — answer proudly: "أيوه، ورد مظبوط من معلومات منشأتها."

## After the Demo

1. Ask: "لو عندك رقم واتساب خاص بالشغل، نقدر نفعّل النظام عليه خلال يوم."
2. Log the pilot conversation (this is Spec B evidence — don't build for it).
