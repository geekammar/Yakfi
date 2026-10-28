import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
import { InboxList } from "@/features/conversations/components/inbox-list";
import type {
  ConversationDetailData,
  InboxConversation,
} from "@/features/conversations/types";
import { AppShell } from "@/components/shared/layout/app-shell";
import { InstallPrompt } from "@/components/shared/pwa/install-prompt";
import { APP_NAV_ITEMS } from "@/lib/app-config";
import { isQaHarnessAllowed } from "@/lib/qa-harness";

import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

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
    attentionCause: "CUSTOMER_REQUESTED_HUMAN",
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
          name: "استشارة عامة",
          durationMinutes: 30,
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
        assignedUser: TEAM_MEMBERS[0] ?? null, // current operator
      };

    case "assigned_other":
      return {
        ...base,
        status: "NEED_HUMAN",
        attentionReason: null,
        attentionCause: null,
        assignedUser: TEAM_MEMBERS[1] ?? null, // another operator
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
        attentionCause: "CUSTOMER_REQUESTED_HUMAN",
        assignedUser: null,
      };
  }
}

const INBOX_FIXTURES: InboxConversation[] = Array.from(
  { length: 30 },
  (_, index) => {
    const num = index + 1;
    const isSarah = num % 3 === 0;
    const isAhmed = num % 3 === 1;
    const status =
      num % 4 === 0
        ? "BOOKED"
        : num % 4 === 1
          ? "NEED_HUMAN"
          : "AI_ACTIVE";
    return {
      id: `conv-qa-${num}`,
      status,
      customer: {
        id: `cust-${num}`,
        name: isSarah
          ? `سارة ${num} — استفسار متابعة`
          : isAhmed
            ? `أحمد ${num} — حجز موعد عيادة`
            : `عميل تجريبي ${num} — استشارة عامة`,
        phone: `+96650111${String(num).padStart(4, "0")}`,
      },
      assignedUser: isAhmed ? TEAM_MEMBERS[0] : isSarah ? TEAM_MEMBERS[1] : null,
      lastMessage: {
        content:
          num === 1
            ? "السلام عليكم، أحتاج مساعدة بخصوص التأمين"
            : num === 2
              ? "هل العيادة مفتوحة اليوم؟"
              : `رسالة تجريبية من العميل رقم ${num}`,
        senderType: num % 2 === 0 ? "CUSTOMER" : "STAFF",
        createdAt: new Date(Date.now() - num * 3600000).toISOString(),
      },
      lastActivityAt: new Date(Date.now() - num * 3600000).toISOString(),
      hasAttention: status === "NEED_HUMAN",
    };
  },
);

async function handleQaTransition(_payload: {
  id: string;
  transition: "TAKE_OVER" | "RETURN_TO_AI" | "MARK_BOOKED" | "HANDOFF";
}) {
  "use server";
  if (!isQaHarnessAllowed()) {
    throw new Error("QA harness is disabled in this environment.");
  }
  return { success: true, message: undefined };
}

export default async function QaConversationHeaderPage({
  searchParams,
}: {
  searchParams: Promise<{
    fixture?: string;
    view?: string;
    installRoute?: string;
    id?: string;
  }>;
}) {
  if (!isQaHarnessAllowed()) {
    notFound();
  }

  const {
    fixture = "need_human_unassigned",
    view = "conversation",
    installRoute,
    id,
  } = await searchParams;
  const data = buildFixture(fixture);
  if (id) {
    data.id = id;
  }

  return (
    <AppShell navItems={APP_NAV_ITEMS}>
      {view === "inbox" ? (
        <div className="space-y-4">
          <h1 className="text-xl font-bold">صندوق المحادثات (QA)</h1>
          <InboxList
            conversations={INBOX_FIXTURES}
            team={TEAM_MEMBERS}
            businessId="biz-qa"
            currentUserId={CURRENT_USER_ID}
            conversationHrefPrefix="/qa/conversation-header?view=conversation"
          />
        </div>
      ) : (
        <ConversationDetail
          data={data}
          businessId="biz-qa"
          backHref="/qa/conversation-header?view=inbox"
          onTransition={handleQaTransition}
        />
      )}
      <InstallPrompt forcedPathname={installRoute} />
    </AppShell>
  );
}
