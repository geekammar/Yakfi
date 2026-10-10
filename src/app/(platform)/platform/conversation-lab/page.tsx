import { COPY_REGISTRY } from "@/features/conversation-copy";
import { CopyLabBrowser } from "@/features/platform/components/copy-lab-browser";
import { PageHeader } from "@/components/shared/page-header";
import { requirePlatformOperator } from "@/server/auth/guards";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "المنصة — مختبر النصوص",
};

/**
 * Founder Conversation Lab (UX-LAB-01D-1 browser; UX-LAB-01D-2 management
 * surface) — the registry browser plus the platform-wide published-override
 * management UI. PLATFORM Operator only: the (platform) layout guard is
 * authoritative and this page re-guards for defense in depth, so no
 * business/tenant actor can reach it.
 *
 * The browser surface is derived from COPY_REGISTRY DIRECTLY — the registry
 * is the code source of truth and this page passes it through untouched. The
 * per-entry detail drawer reads the EFFECTIVE state (code default vs a
 * published platform override) through the platform-authorized server
 * boundary and, for EDITABLE_COPY / EDITABLE_TEMPLATE only, edits / publishes
 * / resets / restores overrides via the UX-LAB-01C service.
 *
 * Isolation (critical): the Lab manages STORED overrides only. Nothing on this
 * page wires override resolution into any production customer reply path —
 * that belongs to UX-LAB-01E — and no reply path imports this page or its
 * components.
 */
export default async function ConversationLabPage() {
  await requirePlatformOperator();

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="مختبر نصوص المحادثة"
        description="تصفّح نصوص المحادثة، عاّنها محلياً، وانشر تعديلاتك على مستوى المنصة — لا يُرسل أي شيء للعملاء."
      />
      <CopyLabBrowser entries={COPY_REGISTRY} />
    </div>
  );
}
