import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
import { getConversationDetail } from "@/features/conversations/server/conversation-queries";
import { requireUser } from "@/server/auth/guards";

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "تفاصيل المحادثة",
};

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireUser();
  if (!session.user.businessId) redirect("/onboarding");
  const { id } = await params;
  const data = await getConversationDetail(
    session.user.businessId,
    id,
    session.user.id,
  );
  if (!data) notFound();

  return <ConversationDetail key={data.id} data={data} />;
}
