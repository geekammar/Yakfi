import { BottomNav } from "@/components/shared/layout/bottom-nav";
import { SidebarNav } from "@/components/shared/layout/sidebar-nav";
import { YakfiBrandText } from "@/components/shared/yakfi-brand-text";
import { YakfiSymbol } from "@/components/shared/yakfi-symbol";
import type { NavItem } from "@/lib/app-config";
import { cn } from "@/lib/utils";

import Link from "next/link";

/**
 * The canonical home of the current area — the first navigation item
 * (الرئيسية / مهامي / لوحة الإدارة / نظرة عامة). Reusing the existing
 * navigation model means the brand never adds a competing home route,
 * and each area's brand stays inside its own surface (the (app) `/`
 * entry also redirects STAFF to their own workspace).
 */
function areaHomeHref(navItems: NavItem[]): string {
  return navItems[0]?.href ?? "/";
}

/**
 * Responsive application shell.
 *
 * Desktop (md+): fixed sidebar on the inline-start side — the right
 * edge in RTL — with a scrollable content area and sticky header.
 * Mobile: sticky top header + bottom navigation bar, no sidebar.
 */
export function AppShell({
  navItems,
  children,
  header,
  className,
}: {
  navItems: NavItem[];
  children: React.ReactNode;
  /** Optional extra content rendered at the end of the top header. */
  header?: React.ReactNode;
  className?: string;
}) {
  const homeHref = areaHomeHref(navItems);

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar — appears on the right in RTL */}
      <aside className="bg-sidebar sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-e md:flex">
        <div className="flex h-14 items-center px-6">
          <Link
            href={homeHref}
            className="flex items-center gap-2 text-sm font-semibold tracking-tight transition-colors hover:text-primary"
          >
            <YakfiSymbol className="size-6 shrink-0" aria-hidden="true" />
            <YakfiBrandText />
          </Link>
        </div>
        <SidebarNav items={navItems} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar / desktop page toolbar */}
        <header className="sticky top-0 z-[var(--z-header)] border-b bg-background/90 backdrop-blur-md">
          <div className="flex h-14 items-center justify-between gap-3 px-4 sm:px-6">
            <Link
              href={homeHref}
              className="flex items-center gap-2 text-sm font-semibold tracking-tight transition-colors hover:text-primary md:hidden"
            >
              <YakfiSymbol className="size-6 shrink-0" aria-hidden="true" />
              <YakfiBrandText />
            </Link>
            <div className="ms-auto flex items-center gap-2">{header}</div>
          </div>
        </header>

        <main
          id="main-content"
          className={cn(
            "mx-auto w-full max-w-6xl flex-1 px-4 pt-6 pb-24 sm:px-6 md:pb-10 scroll-mt-14",
            className,
          )}
        >
          {children}
        </main>
      </div>

      {/* Mobile bottom navigation */}
      <BottomNav items={navItems} />
    </div>
  );
}
