import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
import type { ConversationDetailData } from "@/features/conversations/types";
import { AppShell } from "@/components/shared/layout/app-shell";
import { APP_NAV_ITEMS } from "@/lib/app-config";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "QA — ترويسة المحادثة المتجاوبة",
};

const LONG_ARABIC_NAME = "عبدالرحمن بن محمد آل الشيخ مبارك الصالح";
const TEST_PHONE = "+966501234567";
const CURRENT_USER_ID = "user-current-123";

const TEAM_MEMBERS = [
  { id: CURRENT_USER_ID, name: "أحمد المشرف", image: null },
  { id: "user-other-456", name: "سارة المديرة", image: null },
];

const FIXTURE_MESSAGES = [
  {
    id: "m01",
    senderType: "CUSTOMER" as const,
    content:
      "السلام عليكم ورحمة الله وبركاته، أود الاستفسار عن المواعيد المتاحة هذا الأسبوع.",
    createdAt: "2026-10-28T10:00:00Z",
  },
  {
    id: "m02",
    senderType: "AI" as const,
    content:
      "وعليكم السلام ورحمة الله وبركاته! أهلاً بك يا أستاذ عبدالرحمن في عيادتنا. يسعدنا خدمتك.",
    createdAt: "2026-10-28T10:00:30Z",
  },
  {
    id: "m03",
    senderType: "AI" as const,
    content:
      "لدينا مواعيد شاغرة يوم الأربعاء الساعة 10:00 صباحاً والخميس الساعة 02:00 ظهراً.",
    createdAt: "2026-10-28T10:01:00Z",
  },
  {
    id: "m04",
    senderType: "CUSTOMER" as const,
    content: "هل يمكنني التحدث مع أحد الموظفين بخصوص التغطية التأمينية؟",
    createdAt: "2026-10-28T10:02:00Z",
  },
  {
    id: "m05",
    senderType: "AI" as const,
    content:
      "بالتأكيد، أقوم الآن بتحويل المحادثة لأحد مسؤولي خدمة العملاء لمساعدتك.",
    createdAt: "2026-10-28T10:02:15Z",
  },
  {
    id: "m06",
    senderType: "STAFF" as const,
    content:
      "أهلاً بك يا أستاذ عبدالرحمن، معك أحمد من خدمة العملاء. نغطي كافة شركات التأمين المعتمدة.",
    createdAt: "2026-10-28T10:05:00Z",
  },
  {
    id: "m07",
    senderType: "CUSTOMER" as const,
    content: "ممتاز، هل يشمل ذلك تأمين بوبا الفئة الذهبية؟",
    createdAt: "2026-10-28T10:06:00Z",
  },
  {
    id: "m08",
    senderType: "STAFF" as const,
    content:
      "نعم يشمل شبكة بوبا الذهبية بنسبة تغطية كاملة وفق جدول المنافع الخاص ببطاقتك.",
    createdAt: "2026-10-28T10:07:00Z",
  },
  {
    id: "m09",
    senderType: "CUSTOMER" as const,
    content: "رائع جداً، ما هي الفحوصات المتضمنة في الكشف الأولي؟",
    createdAt: "2026-10-28T10:08:00Z",
  },
  {
    id: "m10",
    senderType: "STAFF" as const,
    content:
      "الفحص الأولي يتضمن الاستشارة العامة، قياس المؤشرات الحيوية، وتخطيط المتابعة العلاجية.",
    createdAt: "2026-10-28T10:09:00Z",
  },
  {
    id: "m11",
    senderType: "CUSTOMER" as const,
    content: "أود حجز موعد يوم الخميس إن أمكن.",
    createdAt: "2026-10-28T10:10:00Z",
  },
  {
    id: "m12",
    senderType: "STAFF" as const,
    content:
      "تم تسجيل رغبتك وسنقوم بتأكيد الموعد المناسب لك فور مراجعة جدول الطبيب المختص.",
    createdAt: "2026-10-28T10:11:00Z",
  },
  {
    id: "m13",
    senderType: "CUSTOMER" as const,
    content: "شكراً جزيلاً لتعاونكم وسرعة استجابتكم.",
    createdAt: "2026-10-28T10:12:00Z",
  },
  {
    id: "m14",
    senderType: "STAFF" as const,
    content: "على الرحب والسعة، نحن في خدمتكم دائماً ونسعد بتواصلكم في أي وقت.",
    createdAt: "2026-10-28T10:13:00Z",
  },
  {
    id: "m15",
    senderType: "CUSTOMER" as const,
    content: "سأكون متواجداً في الموعد المحدد بإذن الله تعالى.",
    createdAt: "2026-10-28T10:14:00Z",
  },
];

function buildFixture(fixtureKey: string): ConversationDetailData {
  const base: ConversationDetailData = {
    id: "conv-qa-fixture-01",
    status: "NEED_HUMAN",
    aiSummary:
      "العميل يرغب في استفسار حول التغطية التأمينية وتأكيد موعد الكشف الأولي.",
    attentionReason: "AI_HANDOFF",
    attentionCause: "CUSTOMER_REQUEST",
    customer: {
      id: "cust-long-name-01",
      name: LONG_ARABIC_NAME,
      phone: TEST_PHONE,
      notes: "عميل دائم ومهم",
    },
    assignedUser: null,
    currentUserId: CURRENT_USER_ID,
    messages: FIXTURE_MESSAGES,
    appointments: [
      {
        id: "app-01",
        date: "2026-10-30",
        startTime: "2026-10-30T10:00:00Z",
        status: "CONFIRMED",
        notes: "موعد استشارة ومتابعة",
        service: {
          id: "srv-01",
          name: "استشارة عامة",
          duration: 30,
          price: 150,
        },
      },
    ],
    team: TEAM_MEMBERS,
  };

  switch (fixtureKey) {
    case "ai_active":
      return {
        ...base,
        status: "AI_ACTIVE",
        attentionReason: null,
        attentionCause: null,
        assignedUser: null,
      };

    case "assigned_me":
      return {
        ...base,
        status: "NEED_HUMAN",
        attentionReason: null,
        attentionCause: null,
        assignedUser: TEAM_MEMBERS[0], // current operator
      };

    case "assigned_other":
      return {
        ...base,
        status: "NEED_HUMAN",
        attentionReason: null,
        attentionCause: null,
        assignedUser: TEAM_MEMBERS[1], // another operator
      };

    case "booked":
      return {
        ...base,
        status: "BOOKED",
        attentionReason: null,
        attentionCause: null,
        assignedUser: null,
      };

    case "need_human_unassigned":
    default:
      return {
        ...base,
        status: "NEED_HUMAN",
        attentionReason: "AI_HANDOFF",
        attentionCause: "CUSTOMER_REQUEST",
        assignedUser: null,
      };
  }
}

async function handleQaTransition(payload: {
  id: string;
  transition: "TAKE_OVER" | "RETURN_TO_AI" | "MARK_BOOKED" | "HANDOFF";
}) {
  "use server";
  return { success: true, message: undefined };
}

export default async function QaConversationHeaderPage({
  searchParams,
}: {
  searchParams: Promise<{ fixture?: string }>;
}) {
  const { fixture = "need_human_unassigned" } = await searchParams;
  const data = buildFixture(fixture);

  return (
    <AppShell navItems={APP_NAV_ITEMS}>
      <ConversationDetail data={data} onTransition={handleQaTransition} />
    </AppShell>
  );
}
