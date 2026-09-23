import { UserMenu } from "@/features/auth/components/user-menu";
import {
  defaultAttentionDeps,
  getOpenAttentionCount,
  withAttentionCount,
} from "@/features/conversations/server/operator-attention";
import { AppShell } from "@/components/shared/layout/app-shell";
import { STAFF_NAV_ITEMS } from "@/lib/app-config";
import { requireRole } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireRole("STAFF");

  // PROMPT-B04 — the live count of UNACKNOWLEDGED handoffs on the staff
  // workspace destination. Tenant scope is the session's Business, derived
  // server-side (never client input).
  const operator = await userRepository.findById(session.user.id);
  const attentionCount = operator?.businessId
    ? await getOpenAttentionCount(defaultAttentionDeps, operator.businessId)
    : 0;

  return (
    <AppShell
      navItems={withAttentionCount(STAFF_NAV_ITEMS, attentionCount)}
      header={<UserMenu />}
    >
      {children}
    </AppShell>
  );
}
