# FlowPilot — Demo Guide

> Everything you need to run a great demo: logins, the demo business, what to
> click, and how to reset. Sales talking track: `DEMO_SCRIPT.md`.
> Demo data lives in `prisma/demo-data.ts` (pure, deterministic, editable).

## Demo Login

| Role              | Email                 | Password     | Who they are                                 |
| ----------------- | --------------------- | ------------ | -------------------------------------------- |
| Admin (owner)     | `admin@flowpilot.app` | `Admin@1234` | د. سارة محمود الشريف — طبيبة الأسنان المالكة |
| Staff (reception) | `staff@flowpilot.app` | `Staff@1234` | نورهان السيد — موظفة الاستقبال               |

> ⚠️ Demo credentials only — never on a production database. The seeded
> business is wiped and recreated on every seed run.

## Setup (2 minutes)

```bash
pnpm db:seed        # idempotent — wipes only the demo business, reseeds
pnpm dev            # then open http://localhost:3000/sign-in
```

Automatic option — add `DEMO_MODE="true"` to `.env.local` and always start
with `bash scripts/dev.sh` (or `dev.ps1` / `dev-termux.sh`): the demo data
re-seeds itself on every launch (best effort, never blocks the server).
Deploying a demo for a prospect? The same `DEMO_MODE=true` makes every
`pnpm deploy` re-seed first, so the deployed URL is demo-ready — see
`docs/CLIENT_DEMO.md` for the shareable demo package.

## The Demo Business: عيادة الابتسامة

Egyptian dental clinic in **كفر الشيخ** — matches the real target market.

| Item          | Value                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| WhatsApp      | +20 100 555 1234                                                              |
| Hours         | الأحد–الخميس ١٠ ص–٩ م · الجمعة ٤ م–٩ م · السبت ١٠ ص–٦ م                       |
| Timezone      | Africa/Cairo (dashboard "today" follows it)                                   |
| Services (6)  | كشف وتشخيص · تنظيف أسنان · حشو تجميلي · علاج عصب · تبييض بالليزر · تاج زيركون |
| FAQs (5)      | أسعار الكشف · التأمين · أسنان الأطفال · العنوان · التقسيط                     |
| Customers     | 36 عميلًا بأسماء مصرية وأرقام +20 حقيقية الشكل                                |
| Conversations | 22 محادثة واتساب مصرية اللهجة (73 رسالة)                                      |
| Appointments  | 37 موعدًا: ١٤ مكتمل · ١١ مؤكد · ٩ معلق · ٢ ملغى · ١ لم يحضر                   |

### What the dashboard shows right after login

- **محادثات اليوم:** ~١١ (رسائل حديثة بتاريخ اليوم)
- **تحتاج تدخلاً:** ٥ محادثات NEED_HUMAN (منها ٢ غير مسندة)
- **مواعيد معلقة اليوم:** ١ · **مؤكدة اليوم:** ٣
- **جدول اليوم:** ٤ مواعيد (تنظيف ١٠ ص · كشف ١١:٣٠ ص · كشف ٥:٣٠ م · كشف عاجل ٨ م)
- **أحدث المحادثات:** آخر ٥ محادثات بالحالة والوقت

## Sample Scenarios (what to open)

1. **مساعد ذكي بيرد بنفسه** → المحادثات → افتح محادثة **فاطمة السيد متولي**
   (AI_ACTIVE): سألت عن سعر التبييض والمساعد رد فورًا من أسئلة العيادة
   الشائعة — بدون تدخل أحد.
2. **تسليم بشري** → المحادثات → محادثة **نورهان خالد فؤاد** (NEED_HUMAN،
   غير مسندة): طلب تأجيل موعد الغد؛ المساعد جمع التفاصيل وحوّل للفريق —
   اضغط "تكفّل بالمحادثة" واكتب ردًا بنفسك لتظهر الرسالة كموظف.
3. **حالة طارئة** → محادثة **عمر أشرف الشافعي**: وجع ضروس حاد؛ المساعد حجز
   كشفًا عاجلًا ٨ م ونورهان أكدت — لاحظ الموعد ظهر في جدول اليوم تلقائيًا.
4. **شكوى تم احتواؤها** → محادثة **إسلام رمضان**: تأخير في الانتظار؛
   الاعتذار + خصم ١٠٠ ج من موظفة الاستقبال (دليل على أن العميل مسموع).
5. **حجز اكتمل من أول رسالة** → محادثة **أحمد محمود** (BOOKED): من "عايز
   أحجز تنظيف" إلى موعد مؤكد غدًا ٧:٣٠ م بدون أي رد بشري.
6. **أجندة اليوم** → المواعيد: ٤ مواعيد، فعّل "تأكيد" على الموعد المعلق،
   أو افتح الموعد العاجل وشوف تفاصيله.
7. **حساب الموظفة** (اختياري): سجّل خروج ثم دخول بـ `staff@flowpilot.app`
   لعرض تجربة الاستقبال — نفس الصندوق مع صلاحيات الموظف.

## Recommended Walkthrough (2 minutes)

1. `/sign-in` → ادخل بـ admin → (١٠ ثوانٍ)
2. الداشبورد: اقرأ الأرقام الأربعة بصوت عالٍ — "٥ محادثات محتاجة تدخلك
   النهاردة" هي الجملة اللي بتبيع المنتج.
3. افتح أحدث محادثة NEED_HUMAN (نورهان) → اعرض ملخص المساعد → تكفّل
   بالمحادثة ورد.
4. المواعيد → جدول اليوم → أكد الموعد المعلق بضغطة.
5. ارجع للداشبورد — الرقم اتحدّث.

## Resetting the Demo

```bash
pnpm db:seed        # wipe + reseed the demo business (everything else untouched)
```

Re-runs are always safe: only rows of the demo business are deleted, and all
IDs/phones are deterministic, so the demo state is identical every time.

## Notes & Limits

- The dataset is dental **because the demo business is** — the product UI copy
  stays vertical-agnostic (a salon demo would seed its own dataset).
- WhatsApp transport is provider-neutral by construction; the **Meta Cloud
  API adapter is the implemented, production-live provider** (DECISIONS
  #42/#46). In THIS demo environment outbound delivery depends on the demo
  project's `WHATSAPP_META_*` env configuration — while those are unset the
  seam stays offline and outbound replies persist as STAFF messages in the
  database; the inbound webhook is provider-neutral and token-gated.
- The Customers directory (`/customers` + `/customers/[id]`) is implemented
  (PROMPT-15); customer profiles are also reachable from conversation detail
  pages.
