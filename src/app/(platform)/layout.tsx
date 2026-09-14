import { UserMenu } from "@/features/auth/components/user-menu";
import { AppShell } from "@/components/shared/layout/app-shell";
import { PLATFORM_NAV_ITEMS } from "@/lib/app-config";
import { requirePlatformOperator } from "@/server/auth/guards";

/**
 * Platform Control Plane layout (PROMPT-OPS-05) — PLATFORM Operator
 * only. Business ADMIN/STAFF are refused (the server guards are
 * authoritative); every Business area refuses the operator in return.
 */
export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePlatformOperator();

  return (
    <AppShell navItems={PLATFORM_NAV_ITEMS} header={<UserMenu />}>
      {children}
    </AppShell>
  );
}
