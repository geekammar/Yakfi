"use client";

import { clearConversationStorage } from "@/features/conversations/lib/storage";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";

import { ChevronDownIcon, LoaderCircleIcon, LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "مدير",
  STAFF: "موظف",
};

/** Header session widget: skeleton while loading, menu with sign-out. */
export function UserMenu() {
  const router = useRouter();
  const { data: session, isPending, refetch } = authClient.useSession();

  if (isPending) {
    return (
      <div
        role="status"
        aria-label="جارٍ تحميل الجلسة"
        className="flex items-center gap-2"
      >
        <span className="bg-muted size-8 animate-pulse rounded-full" />
        <LoaderCircleIcon
          aria-hidden
          className="text-muted-foreground size-4"
        />
      </div>
    );
  }

  const user = session?.user;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2"
          aria-label="قائمة الحساب"
        >
          <Avatar className="size-8">
            <AvatarFallback className="text-xs">
              {user?.name?.trim().charAt(0) ?? "؟"}
            </AvatarFallback>
          </Avatar>
          <ChevronDownIcon aria-hidden className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {user ? (
          <>
            <DropdownMenuLabel className="space-y-0.5">
              <p className="text-sm font-medium">{user.name}</p>
              <p
                dir="ltr"
                className="text-muted-foreground truncate text-start text-xs"
              >
                {user.email}
              </p>
              {user.role ? (
                <p className="text-muted-foreground text-xs">
                  {ROLE_LABELS[user.role] ?? user.role}
                </p>
              ) : null}{" "}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          onClick={async () => {
            clearConversationStorage();
            await authClient.signOut();
            refetch();
            router.replace("/sign-in");
            router.refresh();
          }}
        >
          <LogOutIcon aria-hidden className="size-4" />
          تسجيل الخروج
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
