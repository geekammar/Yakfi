"use client";

import { ConversationStatusBadge } from "@/features/conversations/components/conversation-status";
import type {
  InboxConversation,
  InboxUser,
} from "@/features/conversations/types";
import { EmptyState } from "@/components/shared/empty-state";
import { SearchInput } from "@/components/shared/search-input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CONVERSATION_NOUNS, arabicCount } from "@/lib/arabic";

import {
  InboxIcon,
  MessageCircleIcon,
  SearchIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  clearStoredInboxScroll,
  clearStoredInboxState,
  getStoredInboxScroll,
  getStoredInboxState,
  setStoredInboxScroll,
  setStoredInboxState,
} from "@/features/conversations/lib/storage";

/**
 * PROMPT-B04 — the unacknowledged-attention dot: a thread carrying an
 * UNACKNOWLEDGED handoff gets a visible marker so it stands out from
 * ordinary threads. Operator-only; no AI internals are exposed. The
 * state is never conveyed by color/shape alone: a visually-hidden label
 * carries the same meaning to assistive technology.
 */
function AttentionDot() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      <span
        aria-hidden
        className="bg-destructive inline-block size-2 rounded-full"
      />
      <span className="sr-only">تحتاج انتباهك</span>
    </span>
  );
}

const STATUS_FILTERS = [
  { value: "ALL", label: "كل الحالات" },
  { value: "NEED_HUMAN", label: "تحتاج تدخلاً" },
  { value: "AI_ACTIVE", label: "المساعد نشط" },
  { value: "BOOKED", label: "محجوز" },
  { value: "INCOMPLETE", label: "غير مكتملة" },
] as const;

function formatActivity(date: string) {
  const today = new Intl.DateTimeFormat("en-CA").format(new Date());
  const activityDay = new Intl.DateTimeFormat("en-CA").format(new Date(date));
  if (today === activityDay) {
    return new Intl.DateTimeFormat("ar-EG", {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(date));
  }
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "short",
  }).format(new Date(date));
}

function initials(name: string) {
  return name.trim().slice(0, 2);
}

export function InboxList({
  conversations,
  team,
  businessId = "default_biz",
  currentUserId = "default_user",
  conversationHrefPrefix = "/conversations",
}: {
  conversations: InboxConversation[];
  team: InboxUser[];
  businessId?: string;
  currentUserId?: string;
  conversationHrefPrefix?: string;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] =
    useState<(typeof STATUS_FILTERS)[number]["value"]>("ALL");
  const [assignee, setAssignee] = useState("ALL");
  const [isRestored, setIsRestored] = useState(false);
  const isInitialMount = useRef(true);
  const restoredScrollTargetRef = useRef<number | null>(null);

  // Restore inbox search, filters, and scroll position across Back/Forward navigation
  useEffect(() => {
    const savedState = getStoredInboxState(businessId, currentUserId);
    const savedScroll = getStoredInboxScroll(businessId, currentUserId);
    if (savedScroll && savedScroll > 0) {
      restoredScrollTargetRef.current = savedScroll;
    }
    if (savedState) {
      queueMicrotask(() => {
        if (typeof savedState.search === "string") setSearch(savedState.search);
        if (
          typeof savedState.status === "string" &&
          STATUS_FILTERS.some((f) => f.value === savedState.status)
        ) {
          setStatus(
            savedState.status as (typeof STATUS_FILTERS)[number]["value"],
          );
        }
        if (typeof savedState.assignee === "string") {
          setAssignee(savedState.assignee);
        }
        setIsRestored(true);
      });
    } else {
      setIsRestored(true);
    }
  }, [businessId, currentUserId]);

  // Sync active filters to scoped storage for Back restoration
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    setStoredInboxState(businessId, currentUserId, {
      search,
      status,
      assignee,
    });
  }, [search, status, assignee, businessId, currentUserId]);

  const deferredSearch = useDeferredValue(search.trim().toLocaleLowerCase());
  const hasActiveFilters =
    Boolean(search) || status !== "ALL" || assignee !== "ALL";
  const filtered = useMemo(() => {
    return conversations.filter((conversation) => {
      const searchable = [
        conversation.customer.name,
        conversation.customer.phone,
        conversation.lastMessage?.content ?? "",
      ]
        .join(" ")
        .toLocaleLowerCase();
      const matchesSearch =
        !deferredSearch || searchable.includes(deferredSearch);
      const matchesStatus = status === "ALL" || conversation.status === status;
      const matchesAssignee =
        assignee === "ALL" ||
        (assignee === "UNASSIGNED"
          ? !conversation.assignedUser
          : conversation.assignedUser?.id === assignee);
      return matchesSearch && matchesStatus && matchesAssignee;
    });
  }, [assignee, conversations, deferredSearch, status]);

  // Restore scroll position once the filtered list is rendered and ready
  useEffect(() => {
    if (!isRestored) return;
    const target = restoredScrollTargetRef.current;
    if (target !== null && target > 0) {
      const maxScroll =
        document.documentElement.scrollHeight - window.innerHeight;
      if (
        maxScroll >= target ||
        document.documentElement.scrollHeight > window.innerHeight
      ) {
        window.scrollTo({ top: target, behavior: "instant" });
        if (
          Math.abs(
            (window.scrollY || document.documentElement.scrollTop) - target,
          ) <= 5
        ) {
          restoredScrollTargetRef.current = null;
        }
      }
    }
  }, [filtered, isRestored]);

  function clearFilters() {
    setSearch("");
    setStatus("ALL");
    setAssignee("ALL");
    clearStoredInboxState(businessId, currentUserId);
    clearStoredInboxScroll(businessId, currentUserId);
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_160px_160px]">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="ابحث باسم العميل أو الرسالة"
          className="col-span-2 max-w-none sm:col-span-1"
        />
        <Select
          value={status}
          onValueChange={(value) => setStatus(value as typeof status)}
        >
          <SelectTrigger className="w-full" aria-label="تصفية حسب الحالة">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger className="w-full" aria-label="تصفية حسب المعين">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">كل الفريق</SelectItem>
            <SelectItem value="UNASSIGNED">غير معينة</SelectItem>
            {team.map((user) => (
              <SelectItem key={user.id} value={user.id}>
                {user.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span aria-live="polite">
          {arabicCount(filtered.length, CONVERSATION_NOUNS)}
        </span>
        {hasActiveFilters ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={clearFilters}
          >
            مسح الفلاتر
          </Button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          className="bg-card min-h-64"
          icon={conversations.length === 0 ? InboxIcon : SearchIcon}
          title={
            conversations.length === 0
              ? "صندوق المحادثات فارغ"
              : "لا توجد محادثات مطابقة"
          }
          description={
            conversations.length === 0
              ? "ستظهر هنا محادثات العملاء فور وصولها."
              : "جرّب تغيير كلمات البحث أو الفلاتر للوصول إلى محادثة أخرى."
          }
          action={
            conversations.length > 0 && hasActiveFilters ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                مسح الفلاتر
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
          {filtered.map((conversation) => (
            <Link
              key={conversation.id}
              href={
                conversationHrefPrefix.includes("?")
                  ? `${conversationHrefPrefix}&id=${conversation.id}`
                  : `${conversationHrefPrefix}/${conversation.id}`
              }
              scroll={false}
              onClick={() => {
                setStoredInboxScroll(
                  businessId,
                  currentUserId,
                  window.scrollY || document.documentElement.scrollTop,
                );
              }}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
            >
              <div className="flex size-10 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
                {initials(conversation.customer.name)}
              </div>
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  {conversation.hasAttention ? <AttentionDot /> : null}
                  <p className="truncate font-medium">
                    {conversation.customer.name}
                  </p>
                  {conversation.assignedUser ? (
                    <UserRoundIcon
                      aria-label={`معينة إلى ${conversation.assignedUser.name}`}
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : null}
                </div>
                <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                  <MessageCircleIcon aria-hidden className="size-3 shrink-0" />
                  <span className="truncate">
                    {conversation.lastMessage?.content ?? "لا توجد رسائل"}
                  </span>
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {conversation.assignedUser
                    ? `معينة إلى ${conversation.assignedUser.name}`
                    : "غير معينة"}
                </p>
              </div>
              <div className="flex min-w-0 flex-col items-end gap-1.5">
                <time
                  dateTime={conversation.lastActivityAt}
                  className="text-[11px] text-muted-foreground tabular-nums"
                >
                  {formatActivity(conversation.lastActivityAt)}
                </time>
                <ConversationStatusBadge status={conversation.status} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
