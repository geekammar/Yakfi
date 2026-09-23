"use client";

import { getNavIcon } from "@/components/shared/layout/nav-icons";
import type { NavItem } from "@/lib/app-config";
import { cn } from "@/lib/utils";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function BottomNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="التنقل الرئيسي"
      className="fixed inset-x-0 bottom-0 z-[var(--z-bottom-nav)] border-t bg-background/90 backdrop-blur-md md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <ul className="grid auto-cols-fr grid-flow-col">
        {items.map((item) => {
          const Icon = getNavIcon(item.icon);
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const count = item.attentionCount ?? 0;

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                aria-label={
                  count > 0
                    ? `${item.label} — ${count} تحتاج انتباهك`
                    : undefined
                }
                className={cn(
                  "relative flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium transition-colors duration-[var(--duration-fast)]",
                  active
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon
                  aria-hidden
                  className={cn("size-5", active && "stroke-[2.25]")}
                />
                {item.label}
                {count > 0 ? (
                  <span
                    aria-hidden
                    className="bg-destructive text-destructive-foreground absolute top-1.5 end-[calc(50%-1.4rem)] flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums"
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
