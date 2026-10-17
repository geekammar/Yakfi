import { PageHeader } from "@/components/shared/page-header";
import { cn } from "@/lib/utils";

import { ChevronLeftIcon, UsersRoundIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "لوحة الإدارة",
};

/**
 * Admin area entry: the team management screen (PROMPT-16) lives at
 * `/admin/team`; further admin surfaces arrive with later prompts.
 */
export default function AdminPage() {
  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="لوحة الإدارة"
        description="إدارة الفريق والإعدادات العامة."
      />
      <Link
        href="/admin/team"
        className="group flex items-center gap-4 rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <div className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-full">
          <UsersRoundIcon aria-hidden className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">إدارة الفريق ومقدمي الخدمة</h2>
          <p className="text-muted-foreground mt-0.5 text-sm leading-6">
            إدارة الموظفين ومقدمي الخدمات وتحديد صلاحياتهم.
          </p>
        </div>
        <ChevronLeftIcon
          aria-hidden
          className={cn(
            "text-muted-foreground size-5 shrink-0 transition-transform",
            "group-hover:-translate-x-0.5",
          )}
        />
      </Link>
    </div>
  );
}
