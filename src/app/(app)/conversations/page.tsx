import { InboxList } from "@/features/conversations/components/inbox-list";
import { getConversationInbox } from "@/features/conversations/server/conversation-queries";
import { PageHeader } from "@/components/shared/page-header";
import { requireUser } from "@/server/auth/guards";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "المحادثات",
};

export default async function ConversationsPage() {
  const session = await requireUser();
  if (!session.user.businessId) redirect("/onboarding");

  const { items, team } = await getConversationInbox(session.user.businessId);

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="صندوق المحادثات"
        description="تابع محادثات العملاء وساعدهم في الوقت المناسب."
      />
      <InboxList
        conversations={items}
        team={team}
        businessId={session.user.businessId}
        currentUserId={session.user.id}
      />
    </div>
  );
}
