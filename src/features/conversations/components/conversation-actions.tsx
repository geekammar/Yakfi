"use client";

import type { ConversationDetailData } from "@/features/conversations/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  BotIcon,
  CalendarDaysIcon,
  CheckIcon,
  MessageCircleIcon,
  MoreHorizontalIcon,
  UserRoundIcon,
  UsersRoundIcon,
} from "lucide-react";
import Link from "next/link";
import * as React from "react";

export type ConversationActionsProps = {
  data: Pick<
    ConversationDetailData,
    "id" | "status" | "assignedUser" | "customer"
  >;
  isPending: boolean;
  handleTransition: (
    transition: "TAKE_OVER" | "RETURN_TO_AI" | "MARK_BOOKED" | "HANDOFF",
  ) => void;
  mobileTab?: "messages" | "context";
  setMobileTab?: React.Dispatch<React.SetStateAction<"messages" | "context">>;
  className?: string;
};

/**
 * Shared Conversation Actions (Responsive UI Repair).
 * Single shared action component for both mobile and desktop views,
 * preventing diverging action logic or hidden controls.
 *
 * Exposes:
 * - Direct primary action (TAKE_OVER / RETURN_TO_AI)
 * - Direct booking shortcut
 * - Mobile customer details toggle («التفاصيل»)
 * - Accessible «المزيد» menu for secondary actions (MARK_BOOKED, HANDOFF)
 */
export function ConversationActions({
  data,
  isPending,
  handleTransition,
  mobileTab,
  setMobileTab,
  className = "flex flex-wrap items-center gap-1 sm:gap-1.5",
}: ConversationActionsProps) {
  const isTakeOver =
    data.status === "AI_ACTIVE" ||
    (data.status === "NEED_HUMAN" && !data.assignedUser);

  const hasSecondaryActions = data.status !== "BOOKED";

  return (
    <div className={className}>
      {/* 1. Primary Transition Action: TAKE_OVER or RETURN_TO_AI */}
      {isTakeOver ? (
        <Button
          type="button"
          size="sm"
          className="min-h-11 md:min-h-8 px-1.5 sm:px-2.5 gap-1 sm:gap-1.5 text-xs sm:text-sm"
          onClick={() => handleTransition("TAKE_OVER")}
          disabled={isPending}
          aria-label="تولّي المحادثة"
        >
          <UserRoundIcon className="size-4" aria-hidden />
          <span className="hidden sm:inline">تولّي المحادثة</span>
          <span className="sm:hidden">تولّي</span>
        </Button>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 md:min-h-8 px-1.5 sm:px-2.5 gap-1 sm:gap-1.5 text-xs sm:text-sm"
          onClick={() => handleTransition("RETURN_TO_AI")}
          disabled={isPending}
          aria-label="إعادة للمساعد"
        >
          <BotIcon className="size-4" aria-hidden />
          <span className="hidden sm:inline">إعادة للمساعد</span>
          <span className="sm:hidden">إعادة</span>
        </Button>
      )}

      {/* 2. Booking Action Shortcut */}
      <Button
        asChild
        variant="outline"
        size="sm"
        className="min-h-11 md:min-h-8 px-1.5 sm:px-2.5 gap-1 sm:gap-1.5 text-xs sm:text-sm"
      >
        <Link
          href={`/appointments/new?customerId=${data.customer.id}`}
          aria-label="حجز موعد"
        >
          <CalendarDaysIcon aria-hidden className="size-4" />
          <span className="hidden sm:inline">حجز موعد</span>
          <span className="sm:hidden">حجز</span>
        </Link>
      </Button>

      {/* 3. Mobile Details Toggle («التفاصيل») */}
      {setMobileTab ? (
        <Button
          type="button"
          variant={mobileTab === "context" ? "secondary" : "outline"}
          size="sm"
          className="min-h-11 md:min-h-8 px-1.5 sm:px-2.5 lg:hidden gap-1 sm:gap-1.5 text-xs sm:text-sm"
          onClick={() =>
            setMobileTab((current) =>
              current === "messages" ? "context" : "messages",
            )
          }
          aria-label={
            mobileTab === "context"
              ? "العودة إلى المحادثة"
              : "عرض تفاصيل العميل والمواعيد"
          }
        >
          {mobileTab === "context" ? (
            <>
              <MessageCircleIcon aria-hidden className="size-4" />
              <span className="text-xs">المحادثة</span>
            </>
          ) : (
            <>
              <UserRoundIcon aria-hidden className="size-4" />
              <span className="text-xs">التفاصيل</span>
            </>
          )}
        </Button>
      ) : null}

      {/* 4. Secondary Actions Menu («المزيد») */}
      {hasSecondaryActions ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8 px-1.5 sm:px-2.5 gap-1 text-xs"
              aria-label="المزيد من الإجراءات"
              disabled={isPending}
            >
              <MoreHorizontalIcon className="size-4" aria-hidden />
              <span className="hidden sm:inline text-xs">المزيد</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {data.status !== "BOOKED" ? (
              <DropdownMenuItem
                onClick={() => handleTransition("MARK_BOOKED")}
                disabled={isPending}
                className="gap-2 cursor-pointer"
              >
                <CheckIcon className="size-4 text-success" aria-hidden />
                <span>تحديد كمحجوز</span>
              </DropdownMenuItem>
            ) : null}
            {data.status === "AI_ACTIVE" ? (
              <DropdownMenuItem
                onClick={() => handleTransition("HANDOFF")}
                disabled={isPending}
                className="gap-2 cursor-pointer"
              >
                <UsersRoundIcon className="size-4 text-primary" aria-hidden />
                <span>تحويل للفريق</span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
