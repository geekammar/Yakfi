"use client";

/**
 * Founder Conversation Lab — REGISTRY BROWSER (UX-LAB-01D-1).
 *
 * The read-only mobile-first surface over the canonical COPY_REGISTRY: search,
 * a classification filter, and category-grouped cards that open one entry in a
 * detail drawer.
 *
 * The registry is passed IN from the server page (which imports COPY_REGISTRY
 * directly) — this component holds NO duplicate entry list. Filtering and
 * grouping go through the pure projections in `copy-lab-logic`, which always
 * return NEW structures and never mutate the registry.
 *
 * Read-only slice: there are deliberately no edit / publish / reset / restore
 * controls anywhere in this tree. UX-LAB-01D-2 will add the override state and
 * those actions without redesigning this browser — the cards stay the entry
 * points, and the detail drawer already renders from the same entry shape.
 */
import type { CopyRegistryEntry } from "@/features/conversation-copy/types";
import { CopyLabDetail } from "@/features/platform/components/copy-lab-detail";
import {
  PLATFORM_OVERRIDE_SCOPE_NOTE,
  buildClassificationChips,
  filterCopyEntries,
  getCopyRuntimeCoverage,
  getCopyRuntimeRelevance,
  groupCopyEntriesByCategory,
  isOperationalRuntimeRelevance,
  type CopyClassificationFilter,
  type CopyRuntimeScopeFilter,
} from "@/features/platform/components/copy-lab-logic";
import { EmptyState } from "@/components/shared/empty-state";
import { SearchInput } from "@/components/shared/search-input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { ChevronLeftIcon, LockIcon, RadioIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

export function CopyLabBrowser({
  entries,
}: {
  entries: readonly CopyRegistryEntry[];
}) {
  const [search, setSearch] = useState("");
  const [classification, setClassification] =
    useState<CopyClassificationFilter>("ALL");
  const [scope, setScope] = useState<CopyRuntimeScopeFilter>("OPERATIONAL");
  const [openKey, setOpenKey] = useState<string | null>(null);

  // Pure projections over the registry — new arrays, registry untouched.
  // The DEFAULT scope is the current operational view; legacy/fallback,
  // unused, and unresolved entries are inspectable only through "ALL".
  const filtered = useMemo(
    () => filterCopyEntries(entries, { search, classification, scope }),
    [entries, search, classification, scope],
  );
  const operationalCount = useMemo(
    () =>
      entries.filter((entry) =>
        isOperationalRuntimeRelevance(getCopyRuntimeRelevance(entry.key)),
      ).length,
    [entries],
  );
  const groups = useMemo(
    () => groupCopyEntriesByCategory(filtered),
    [filtered],
  );
  const chips = useMemo(() => buildClassificationChips(entries), [entries]);
  const openEntry = useMemo(
    () =>
      openKey === null
        ? null
        : (entries.find((e) => e.key === openKey) ?? null),
    [entries, openKey],
  );
  const scopeOptions: ReadonlyArray<{
    value: CopyRuntimeScopeFilter;
    label: string;
    count: number;
  }> = [
    { value: "OPERATIONAL", label: "التشغيلي الحالي", count: operationalCount },
    { value: "ALL", label: "كل السجل", count: entries.length },
  ];
  const scopeTotal =
    scope === "OPERATIONAL" ? operationalCount : entries.length;
  const scopeLabel = scope === "OPERATIONAL" ? "العرض التشغيلي" : "كل السجل";

  return (
    <div className="space-y-4">
      {/* ── Responsibilities + runtime alignment notice ──── */}
      <div className="space-y-2 rounded-xl border border-muted bg-muted/20 p-3.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <RadioIcon aria-hidden className="size-3.5 text-primary" />
          <span>التفسير والقرار والصياغة مسؤوليات منفصلة</span>
        </div>
        <p className="leading-relaxed">
          النموذج يفسّر معنى رسالة العميل، والخدمات النطاقية تقرر وتنفّذ
          (الحجز والتوافر والصلاحيات)، أما نصوص المختبر فهي صياغة حتمية أو
          عرض بيانات مرجعية — وليست تفسيراً للنية ولا قائمة كلمات مفتاحية.
        </p>
        <p className="leading-relaxed">
          <span className="font-medium text-foreground">حالة الربط:</span>{" "}
          مفتاح واحد فقط (
          <span dir="ltr" className="font-mono font-semibold text-foreground">
            welcome.intro
          </span>
          ) يُقرأ تجاوزه وقت التشغيل، وذلك في مسار /start لمحادثة جديدة أو
          خاملة فقط. بقية المفاتيح لا يقرأ المحرك تجاوزاتها؛ بعضها نص تشغيلي
          حالي يُنتج من الكود، وبعضها مسار احتياطي قديم أو رمز غير مستخدم.
        </p>
        <p className="leading-relaxed">
          العرض الافتراضي يعرض النصوص التشغيلية الحالية وعروض البيانات
          المرجعية فقط. المسارات القديمة وغير المستخدمة وغير المحسومة تبقى
          قابلة للفحص عبر «كل السجل»، ولا يعني إظهارها وجود خطة لربطها لاحقاً.
        </p>
        <p className="leading-relaxed">{PLATFORM_OVERRIDE_SCOPE_NOTE}</p>
      </div>
      {/* ── Controls (mobile-first, no page-level horizontal scroll) ──── */}
      <div className="space-y-3">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder="ابحث بالاسم أو المفتاح أو النص…"
          className="max-w-full"
        />
        <div
          role="group"
          aria-label="نطاق العرض حسب الصلة بالتشغيل"
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {scopeOptions.map((option) => {
            const active = scope === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setScope(option.value)}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-primary border-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    active
                      ? "text-primary-foreground/80"
                      : "text-muted-foreground/70",
                  )}
                >
                  {option.count}
                </span>
              </button>
            );
          })}
        </div>
        <div
          role="group"
          aria-label="تصفية حسب التصنيف"
          className="flex gap-2 overflow-x-auto pb-1"
        >
          {chips.map((chip) => {
            const active = classification === chip.value;
            return (
              <button
                key={chip.value}
                type="button"
                onClick={() => setClassification(chip.value)}
                aria-pressed={active}
                className={cn(
                  "inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-primary border-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {chip.label}
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    active
                      ? "text-primary-foreground/80"
                      : "text-muted-foreground/70",
                  )}
                >
                  {chip.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        {filtered.length} من {scopeTotal} نص في {scopeLabel}
      </p>

      {groups.length === 0 ? (
        <EmptyState
          className="bg-card min-h-64"
          icon={SearchIcon}
          title="لا توجد نتائج"
          description={
            scope === "OPERATIONAL"
              ? "جرّب كلمة بحث أخرى، غيّر التصنيف، أو افتح «كل السجل» لفحص المسارات القديمة وغير المستخدمة."
              : "جرّب كلمة بحث أخرى أو غيّر التصنيف المحدد."
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section key={group.category} className="space-y-2">
              <h2 className="text-muted-foreground flex items-center gap-2 text-xs font-semibold">
                {group.label}
                <span className="tabular-nums">{group.items.length}</span>
              </h2>
              <ul className="space-y-2">
                {group.items.map((entry) => (
                  <CopyEntryCard
                    key={entry.key}
                    entry={entry}
                    onOpen={() => setOpenKey(entry.key)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {openEntry ? (
        <CopyLabDetail
          key={openEntry.key}
          entry={openEntry}
          open={openKey === openEntry.key}
          onOpenChange={(open) => {
            if (!open) setOpenKey(null);
          }}
        />
      ) : null}
    </div>
  );
}

function CopyEntryCard({
  entry,
  onOpen,
}: {
  entry: CopyRegistryEntry;
  onOpen: () => void;
}) {
  const isProtected = entry.classification === "PROTECTED_COPY";
  const isTemplate = entry.classification === "EDITABLE_TEMPLATE";
  const coverage = getCopyRuntimeCoverage(entry.key, entry.classification);

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        // ≥44px touch target; full-width tap area on mobile.
        className="bg-card flex w-full min-h-14 items-center gap-3 rounded-xl border p-3.5 text-start transition-colors hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {entry.humanLabel}
            </span>
            {isTemplate ? (
              <Badge variant="secondary" className="shrink-0 text-xs">
                قالب
              </Badge>
            ) : null}
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 text-xs font-normal",
                coverage.relevance === "CURRENT_OPERATIONAL_TEMPLATE" &&
                  "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
                coverage.relevance === "AUTHORITATIVE_DATA_PRESENTATION" &&
                  "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
                coverage.relevance === "LEGACY_ONLY_PATH" &&
                  "border-warning/40 bg-warning/10 text-warning-foreground",
                coverage.relevance === "UNUSED_CODE" &&
                  "text-muted-foreground border-dashed",
                coverage.relevance === "UNRESOLVED" &&
                  "border-destructive/30 text-destructive",
              )}
            >
              {coverage.relevanceLabel}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 text-xs font-normal",
                coverage.overrideConnection === "CONNECTED"
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "text-muted-foreground border-dashed",
              )}
            >
              {coverage.overrideConnectionLabel}
            </Badge>
          </span>
          <span
            dir="ltr"
            className="text-muted-foreground block truncate text-start font-mono text-xs"
          >
            {entry.key}
          </span>
          <span
            dir="auto"
            className="text-muted-foreground line-clamp-2 block text-xs leading-relaxed"
          >
            {entry.defaultText}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {isProtected ? (
            <Badge
              variant="outline"
              className="shrink-0 border-warning/40 bg-warning/10 text-warning-foreground"
            >
              <LockIcon aria-hidden className="size-3" />
              محمي
            </Badge>
          ) : null}
          <ChevronLeftIcon
            aria-hidden
            className="text-muted-foreground size-4 shrink-0"
          />
        </span>
      </button>
    </li>
  );
}
