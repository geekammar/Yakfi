"use client";

import { searchCustomersAction } from "@/features/customers/actions/customer-actions";
import { CustomerFormDialog } from "@/features/customers/components/customer-form-dialog";
import { deriveCustomerFormDefaults } from "@/features/customers/customer-form-defaults";
import type { CustomerListItem } from "@/features/customers/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { SearchInput } from "@/components/shared/search-input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { CUSTOMER_NOUNS, SEARCH_RESULT_NOUNS, arabicCount } from "@/lib/arabic";

import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  CalendarDaysIcon,
  MessageCircleIcon,
  PlusIcon,
  SearchIcon,
  UsersRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

function initials(name: string) {
  return name.trim().slice(0, 2);
}

/** Short Arabic date — time when the activity happened today. */
function formatActivity(date: string) {
  const value = new Date(date);
  const today = new Intl.DateTimeFormat("en-CA").format(new Date());
  const activityDay = new Intl.DateTimeFormat("en-CA").format(value);
  if (today === activityDay) {
    return new Intl.DateTimeFormat("ar-EG", {
      hour: "numeric",
      minute: "2-digit",
    }).format(value);
  }
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "short",
  }).format(value);
}

/**
 * Customers directory (PROMPT-15): who the customers are and the last
 * interaction with each. Server-backed search by name or phone
 * (debounced, tenant-scoped action), one primary action (إضافة عميل),
 * and honest empty/loading/error states. Not a CRM — identity,
 * contact, and history only.
 */
export function CustomersDirectory({
  initialCustomers,
}: {
  /** Most recent customers, preloaded by the page (empty query). */
  initialCustomers: CustomerListItem[];
}) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query);
  const [createOpen, setCreateOpen] = useState(false);
  const [dialogSession, setDialogSession] = useState(0);
  const queryClient = useQueryClient();

  const search = useQuery({
    queryKey: ["customers-directory", debouncedQuery],
    queryFn: () => searchCustomersAction({ query: debouncedQuery }),
    placeholderData: keepPreviousData,
    initialData:
      debouncedQuery === ""
        ? { success: true, customers: initialCustomers }
        : undefined,
  });

  function openCreate() {
    setDialogSession((count) => count + 1);
    setCreateOpen(true);
  }

  /** A server-confirmed creation refreshes the list and returns to the
   * most-recent view, where the new customer appears first. */
  function handleCreated() {
    setQuery("");
    void queryClient.invalidateQueries({
      queryKey: ["customers-directory"],
    });
  }

  const results =
    search.data && search.data.success ? search.data.customers : null;
  const searchError =
    search.data && !search.data.success ? search.data.message : null;
  const error = searchError ?? (search.error ? "تعذر البحث الآن" : null);

  return (
    <div className="animate-fade-in-up space-y-6">
      <PageHeader
        title="العملاء"
        description="عملاؤك وما آخر تعامل مع كل منهم — المحادثة الأخيرة والموعد الأخير."
        actions={
          <Button onClick={openCreate}>
            <PlusIcon />
            إضافة عميل
          </Button>
        }
      />

      <SearchInput
        value={query}
        onValueChange={setQuery}
        placeholder="ابحث بالاسم أو رقم الهاتف"
        className="max-w-full"
      />

      {error ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm">
          <p role="alert">{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void search.refetch()}
          >
            إعادة المحاولة
          </Button>
        </div>
      ) : null}

      {search.isPending ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-xl" />
          ))}
        </div>
      ) : results ? (
        results.length === 0 ? (
          query.trim() === "" ? (
            <EmptyState
              className="bg-card min-h-72"
              icon={UsersRoundIcon}
              title="لا يوجد عملاء بعد"
              description="يُضاف العملاء تلقائياً من محادثات واتساب، أو أضف عميلاً يدوياً لتحجز له موعداً."
              action={
                <Button size="sm" onClick={openCreate}>
                  <PlusIcon aria-hidden className="size-4" />
                  إضافة عميل
                </Button>
              }
            />
          ) : (
            <EmptyState
              className="bg-card min-h-64"
              icon={SearchIcon}
              title="لا توجد نتائج مطابقة"
              description="جرّب البحث بجزء من الاسم أو برقم الهاتف، أو أضفه كعميل جديد."
              action={
                <Button variant="outline" size="sm" onClick={openCreate}>
                  <PlusIcon aria-hidden className="size-4" />
                  إضافة عميل جديد
                </Button>
              }
            />
          )
        ) : (
          <>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {query.trim() === ""
                ? arabicCount(results.length, CUSTOMER_NOUNS)
                : arabicCount(results.length, SEARCH_RESULT_NOUNS)}
            </p>
            <div className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
              {results.map((customer) => (
                <Link
                  key={customer.id}
                  href={`/customers/${customer.id}`}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/60 focus-visible:bg-muted/60"
                >
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
                    {initials(customer.name)}
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-medium">{customer.name}</p>
                    <p className="text-xs text-muted-foreground" dir="ltr">
                      <span className="tabular-nums">{customer.phone}</span>
                    </p>
                    {customer.lastConversationAt ||
                    customer.lastAppointmentAt ? (
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        {customer.lastConversationAt ? (
                          <span className="inline-flex items-center gap-1">
                            <MessageCircleIcon
                              aria-hidden
                              className="size-3 shrink-0"
                            />
                            آخر محادثة{" "}
                            <time
                              dateTime={customer.lastConversationAt}
                              className="tabular-nums"
                            >
                              {formatActivity(customer.lastConversationAt)}
                            </time>
                          </span>
                        ) : null}
                        {customer.lastAppointmentAt ? (
                          <span className="inline-flex items-center gap-1">
                            <CalendarDaysIcon
                              aria-hidden
                              className="size-3 shrink-0"
                            />
                            آخر موعد{" "}
                            <time
                              dateTime={customer.lastAppointmentAt}
                              className="tabular-nums"
                            >
                              {formatActivity(customer.lastAppointmentAt)}
                            </time>
                          </span>
                        ) : null}
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        لا توجد تعاملات بعد
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </>
        )
      ) : null}

      {/* key → the dialog remounts on every open, so it always starts
       * from the current prefill: the name/phone the operator ALREADY
       * typed into the search box are carried into the create form
       * (re-validated on submit — invalid candidates are dropped, never
       * fabricated), so a no-results search becomes one tap to add. */}
      <CustomerFormDialog
        key={dialogSession}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
        prefill={deriveCustomerFormDefaults(query)}
      />
    </div>
  );
}
