import { UserMenu } from "@/features/auth/components/user-menu";
import {
  defaultAttentionDeps,
  getOpenAttentionCount,
  withAttentionCount,
} from "@/features/conversations/server/operator-attention";
import { AppShell } from "@/components/shared/layout/app-shell";
import { InstallPrompt } from "@/components/shared/pwa/install-prompt";
import { APP_NAV_ITEMS } from "@/lib/app-config";
import { requireUser } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireUser();
  // Role-scoped visibility for nav items that are ADMIN-only (e.g.
  // services management) — the server guards remain the authorization
  // boundary; this only keeps hidden screens out of STAFF navigation.
  const navItems = APP_NAV_ITEMS.filter(
    (item) =>
      !item.roles || item.roles.some((role) => role === session.user.role),
  );

  // PROMPT-B04 — the live count of UNACKNOWLEDGED handoffs, attached to the
  // navigation destination. Tenant scope is the session's Business (derived
  // server-side; a client can never supply it). ADMIN has no staff workspace,
  // so the badge lands on the shared inbox.
  const operator = await userRepository.findById(session.user.id);
  const attentionCount = operator?.businessId
    ? await getOpenAttentionCount(defaultAttentionDeps, operator.businessId)
    : 0;

  return (
    <AppShell
      navItems={withAttentionCount(navItems, attentionCount)}
      header={<UserMenu />}
    >
      {children}
      <InstallPrompt />
    </AppShell>
  );
}
