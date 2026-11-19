"use client";

/**
 * Founder Conversation Lab — ENTRY DETAIL (UX-LAB-01D-1 read-only browser;
 * UX-LAB-01D-2 management surface).
 *
 * A bottom-sheet (mobile) / side drawer (desktop) detail view for ONE
 * registry entry. Product-first, it shows:
 *
 *   1. the EFFECTIVE copy text and its SOURCE — the code default, or a
 *      published PLATFORM override (the UX-LAB-01C hierarchy, read through
 *      the platform-authorized server boundary);
 *   2. a fully local DETERMINISTIC PREVIEW of the candidate the founder is
 *      editing, rendered through the canonical render contract only;
 *   3. for EDITABLE_COPY / EDITABLE_TEMPLATE only: an editor, a PUBLISH
 *      action, a RESET-to-code-default action, the bounded HISTORY, and a
 *      RESTORE action.
 *
 * PROTECTED_COPY stays exactly as read-only as before: it renders the same
 * metadata + preview and carries NO editor and no publish / reset / restore
 * control (the mutation surface is one conditional branch, gated on
 * `canEditCopy`, that is never rendered for a protected key — and the server
 * boundary re-validates + re-authorizes regardless).
 *
 * Boundary discipline: this component NEVER imports the persistence layer or
 * the repository. It calls the platform server actions, which alone are
 * allowed to reach the UX-LAB-01C override service. The preview stays pure —
 * no DB, no provider, no network, no customer send.
 */
import {
  renderCopyText,
  validateCopyCandidate,
} from "@/features/conversation-copy";
import type { CopyRenderFailureCode } from "@/features/conversation-copy/render";
import type {
  CopyRegistryEntry,
  PlaceholderName,
} from "@/features/conversation-copy/types";
import type { CopyValidationFailure } from "@/features/conversation-copy/validation";
import {
  getCopyLabEntryStateAction,
  publishCopyOverrideAction,
  resetCopyOverrideAction,
  restoreCopyOverrideAction,
} from "@/features/platform/actions/copy-lab-actions";
import type {
  CopyLabEntryState,
  GetCopyLabEntryStateResult,
} from "@/features/platform/actions/copy-lab-actions";
import {
  COPY_CLASSIFICATION_HINTS,
  COPY_VALIDATION_FAILURE_GUIDANCE,
  EFFECTIVE_SOURCE_LABELS,
  PLATFORM_OVERRIDE_SCOPE_NOTE,
  collectPreviewValues,
  demoPlaceholderValues,
  getCopyRuntimeCoverage,
  getMutationFeedbackText,
  mapEffectiveCopyState,
  mapHistoryItems,
  overrideErrorGuidance,
  type EffectiveCopySource,
  type EffectiveCopyState,
  type HistoryItemView,
  type MutationKind,
} from "@/features/platform/components/copy-lab-logic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import {
  CircleAlertIcon,
  HistoryIcon,
  LockIcon,
  RadioIcon,
  RotateCcwIcon,
  SparklesIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

/** Arabic surfaces for the renderer's typed failure codes. */
const RENDER_FAILURE_LABELS: Readonly<Record<CopyRenderFailureCode, string>> = {
  UNKNOWN_COPY_KEY: "هذا المفتاح غير موجود في سجل النصوص.",
  MISSING_PLACEHOLDER_VALUE:
    "قيمة حقل مطلوبة ناقصة — أكمل الحقول المطلوبة لمعاينة النص.",
  UNRESOLVED_PLACEHOLDER: "تعذّر تعيين أحد الحقول في النص.",
  MALFORMED_PLACEHOLDER: "القالب المُدخل غير سليم البنية.",
};

const PROTECTED_BADGE = "محمي — للقراءة فقط";
const MAX_COPY_LENGTH = 400;

/**
 * The service error shape the actions return, mirrored structurally so this
 * component stays free of any persistence-layer import (the actions hand the
 * real typed errors in; `tsc` keeps the shapes in sync).
 */
type ServiceError = {
  readonly code: string;
  readonly message: string;
  readonly validationFailure?: {
    readonly code: string;
    readonly message: string;
  };
};
type ActionResult = { success: true } | { success: false; error: ServiceError };

/** A typed service failure mapped to product guidance, keeping the stable code. */
type MutationError = {
  readonly guidance: string;
  readonly code: string;
  readonly validationGuidance: string | null;
};

function toMutationError(error: ServiceError): MutationError {
  const validationCode = error.validationFailure?.code;
  return {
    guidance: overrideErrorGuidance(error),
    code: error.code,
    validationGuidance:
      validationCode !== undefined
        ? (COPY_VALIDATION_FAILURE_GUIDANCE[
            validationCode as keyof typeof COPY_VALIDATION_FAILURE_GUIDANCE
          ] ??
          error.validationFailure?.message ??
          null)
        : null,
  };
}

export function CopyLabDetail({
  entry,
  open,
  onOpenChange,
}: {
  entry: CopyRegistryEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const isTemplate = entry.placeholders.length > 0;
  const isProtected = entry.classification === "PROTECTED_COPY";

  // Seeded once per entry (the browser remounts this component per key).
  const [rawValues, setRawValues] = useState<Record<string, string>>(() =>
    demoPlaceholderValues(entry),
  );
  const [draft, setDraft] = useState<string>("");
  const [effective, setEffective] = useState<EffectiveCopyState | null>(null);
  const [history, setHistory] = useState<HistoryItemView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Starts true: the browser mounts this drawer already-open, so the loading
  // state covers the very first effective-state read.
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<MutationKind | null>(null);
  const [error, setError] = useState<MutationError | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly kind: MutationKind;
    readonly readbackSuccess: boolean;
    readonly message: string;
  } | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const applyResult = useCallback(
    (result: GetCopyLabEntryStateResult) => {
      if (!result.success) {
        // The boundary refused the actor (typed FORBIDDEN) — the drawer keeps
        // the safe registry default and explains the state instead of crashing.
        setLoadFailed(true);
        setEffective(null);
        setHistory(null);
        return;
      }
      setLoadFailed(false);
      const state: CopyLabEntryState = result.data;
      const mapped = mapEffectiveCopyState(
        entry,
        state.resolution,
        state.published,
      );
      setEffective(mapped);
      setHistory(
        state.history.success
          ? mapHistoryItems(state.history.data.items)
          : null,
      );
      // Initialize the editor from the effective/published state. The registry
      // is never mutated — this is local draft state seeded from what is stored.
      setDraft(mapped.editorSeed);
    },
    [entry],
  );

  // Post-mutation refresh (an event-handler path, so setState is fine here).
  const refresh = useCallback(async (): Promise<{
    ok: boolean;
    source?: EffectiveCopySource;
  }> => {
    setLoading(true);
    setError(null);
    try {
      const result = await getCopyLabEntryStateAction(entry.key);
      if (result.success) {
        applyResult(result);
        return {
          ok: true,
          source: result.data.resolution.ok
            ? result.data.resolution.source
            : undefined,
        };
      }
      // A post-mutation readback failure must not destroy the editor state or
      // the local draft. Keep the last good effective state and surface the
      // failure through the mutation feedback instead.
      setLoadFailed(true);
      return { ok: false };
    } catch {
      // Never let a thrown boundary call crash the drawer, and never discard
      // edits the founder already typed because a readback failed.
      setLoadFailed(true);
      return { ok: false };
    } finally {
      setLoading(false);
    }
  }, [entry, applyResult]);

  // The open-effect fetches asynchronously: the await comes first and every
  // setState lands in the async continuation, never synchronously in the
  // effect body (the browser mounts this drawer already-open, so this runs
  // once per opened key).
  //
  // B1 (UX-LAB-01D-P1): `loading` starts true and ONLY this effect can settle
  // it on first open — `refresh()` runs after mutations only. The read must
  // end `loading` in BOTH the success and the failure path (guarded by
  // `active`, so a drawer that closed mid-read never writes stale state),
  // otherwise the drawer stays stuck on the loading branch and neither the
  // effective state nor the editor ever renders.
  useEffect(() => {
    if (!open) return;
    let active = true;
    void (async () => {
      try {
        const result = await getCopyLabEntryStateAction(entry.key);
        if (active) {
          applyResult(result);
          setFeedback(null);
          setError(null);
          setConfirmingReset(false);
        }
      } catch {
        if (active) {
          setLoadFailed(true);
          setEffective(null);
          setHistory(null);
          setFeedback(null);
          setError(null);
          setConfirmingReset(false);
        }
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, entry.key, applyResult]);

  // values omits empty inputs so a cleared required placeholder is ABSENT and
  // renderCopyText reports it as a typed MISSING_PLACEHOLDER_VALUE.
  const values = useMemo(
    () => collectPreviewValues(entry, rawValues),
    [entry, rawValues],
  );
  // The candidate preview goes through the canonical render contract — the
  // SAME pure function the registry-default render uses, applied to the draft.
  const preview = useMemo(
    () => renderCopyText(entry.key, draft, values),
    [entry.key, draft, values],
  );

  // Reuse the CANONICAL candidate validator for immediate feedback. Publishing
  // is disabled while invalid, and the server boundary still validates again.
  const validation = useMemo(
    () => validateCopyCandidate(entry.key, draft),
    [entry.key, draft],
  );
  const validationFailure = validation.ok ? null : validation;

  const editable = effective?.editable ?? !isProtected;
  // Dirty means "the local draft differs from the LOADED EFFECTIVE text",
  // never "differs from the code default". When a valid published override is
  // loaded, an untouched editor is clean even though it differs from the code
  // default; after a failed readback the last loaded effective text remains the
  // honest comparison baseline.
  const hasUnappliedChanges = effective !== null && draft !== effective.text;
  const unchanged = effective !== null && !hasUnappliedChanges;
  const persistenceDown = effective !== null && !effective.persistenceAvailable;
  const canMutate = editable && effective !== null && !persistenceDown;
  const canPublish =
    canMutate && hasUnappliedChanges && validation.ok && pending === null;

  function requestClose(): void {
    if (hasUnappliedChanges) {
      setConfirmingDiscard(true);
      setFeedback(null);
      setError(null);
      return;
    }
    setConfirmingDiscard(false);
    setFeedback(null);
    setError(null);
    setConfirmingReset(false);
    onOpenChange(false);
  }

  function discardAndClose(): void {
    setConfirmingDiscard(false);
    setFeedback(null);
    setError(null);
    setConfirmingReset(false);
    onOpenChange(false);
  }

  async function run(
    kind: MutationKind,
    action: () => Promise<ActionResult>,
  ): Promise<void> {
    setPending(kind);
    setError(null);
    setFeedback(null);
    let result: ActionResult;
    try {
      // The action returns the service's typed envelope; a non-success is a
      // real validation/persistence failure and is surfaced, never hidden.
      result = await action();
    } catch {
      result = {
        success: false,
        error: {
          code: "PERSISTENCE_FAILED",
          message: "تعذر إكمال العملية الآن",
        },
      };
    }
    if (result.success) {
      setConfirmingReset(false);
      const refreshResult = await refresh();
      setPending(null);
      if (refreshResult.ok) {
        setFeedback({
          kind,
          readbackSuccess: true,
          message: getMutationFeedbackText({
            kind,
            key: entry.key,
            readbackSuccess: true,
            source: refreshResult.source,
          }),
        });
      } else {
        setFeedback({
          kind,
          readbackSuccess: false,
          message: getMutationFeedbackText({
            kind,
            key: entry.key,
            readbackSuccess: false,
          }),
        });
      }
      return;
    }
    setPending(null);
    setError(toMutationError(result.error));
  }

  return (
    // B3 (UX-LAB-01D-P1): `handleOnly` restricts Vaul's drag to the explicit
    // handle. Without it the whole drawer surface — including the footer's
    // Close / Publish buttons — competes for the touch gesture: Vaul calls
    // `setPointerCapture` on every pointerdown over the content, so a bottom
    // button tap with any vertical movement becomes a drawer drag, the drawer
    // steals the gesture, and the button's click never fires. Footer buttons
    // stay plain tappable controls; body scrolling and swipe-to-close (via the
    // handle) keep working. Scoped to the Lab only.
    <Drawer
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          // Swipe/overlay/Escape go through here. Never discard local edits
          // silently: ask first when the draft differs from the loaded
          // effective text.
          if (hasUnappliedChanges) {
            setConfirmingDiscard(true);
            setFeedback(null);
            setError(null);
            return;
          }
          setFeedback(null);
          setError(null);
          setConfirmingReset(false);
          setConfirmingDiscard(false);
        }
        onOpenChange(nextOpen);
      }}
      handleOnly
    >
      <DrawerContent className="max-h-[88vh]" handle>
        <DrawerHeader className="text-start">
          <div className="flex items-start justify-between gap-3">
            <DrawerTitle className="text-base leading-snug pe-1">
              {entry.humanLabel}
            </DrawerTitle>
            <ClassificationBadge classification={entry.classification} />
          </div>
          <DrawerDescription dir="ltr" className="text-start font-mono text-xs">
            {entry.key}
          </DrawerDescription>
        </DrawerHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-4 pb-2">
          {isProtected ? (
            <ProtectedNotice entry={entry} />
          ) : (
            <p className="text-muted-foreground text-sm leading-relaxed">
              {COPY_CLASSIFICATION_HINTS[entry.classification]}
            </p>
          )}

          {loading ? (
            <LoadingState />
          ) : effective === null ? (
            <LoadFailedNotice />
          ) : (
            <>
              {/* ── EFFECTIVE STATE (product-first) ───────────────────── */}
              <EffectiveStateBlock entry={entry} state={effective} />

              {loadFailed ? <ReadbackFailedNotice /> : null}

              {canMutate ? (
                <CopyEditor
                  entry={entry}
                  draft={draft}
                  onDraftChange={(value) => {
                    setDraft(value);
                    setFeedback(null);
                    setError(null);
                    setConfirmingDiscard(false);
                  }}
                  characters={[...draft].length}
                  validationFailure={validationFailure}
                  hasUnappliedChanges={hasUnappliedChanges}
                />
              ) : null}
            </>
          )}

          {/* ── PREVIEW (primary; deterministic + fully local) ────────── */}
          <section className="space-y-3">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <SparklesIcon aria-hidden className="size-4" />
              المعاينة
              <span className="text-muted-foreground text-xs font-normal">
                — محلية، لا تُرسل
              </span>
            </h3>

            {isTemplate ? (
              <PlaceholderInputs
                entry={entry}
                rawValues={rawValues}
                onValueChange={(name, value) =>
                  setRawValues((prev) => ({ ...prev, [name]: value }))
                }
              />
            ) : null}

            {preview.ok ? (
              <PreviewBubble text={preview.text} />
            ) : (
              <PreviewFailure
                code={preview.code}
                message={preview.message}
                placeholders={preview.placeholders}
              />
            )}
          </section>

          {/* ── HISTORY (editable keys only; bounded, newest-first) ───── */}
          {canMutate ? (
            <HistorySection
              items={history}
              disabled={pending !== null}
              onRestore={(historyId) =>
                run("restore", () => restoreCopyOverrideAction({ historyId }))
              }
            />
          ) : null}

          {/* ── TECHNICAL DETAILS (secondary) ──────────────────────────── */}
          <TechnicalDetails entry={entry} />
        </div>

        <DrawerFooter className="space-y-2">
          {error ? <MutationErrorAlert error={error} /> : null}
          {feedback !== null ? (
            <p
              className={cn(
                "text-xs font-medium leading-relaxed",
                feedback.readbackSuccess
                  ? "text-emerald-600 dark:text-emerald-500"
                  : "text-amber-600 dark:text-amber-500",
              )}
            >
              {feedback.message}
            </p>
          ) : null}

          {canMutate && effective !== null ? (
            <div className="space-y-2">
              <Button
                type="button"
                className="h-11 w-full"
                disabled={!canPublish}
                onClick={() =>
                  run("publish", () =>
                    publishCopyOverrideAction({ key: entry.key, text: draft }),
                  )
                }
              >
                {pending === "publish" ? (
                  <span className="animate-pulse">جارٍ النشر…</span>
                ) : (
                  <>
                    <UploadIcon aria-hidden className="size-4" />
                    نشر النص
                  </>
                )}
              </Button>
              {validationFailure ? (
                <p className="text-destructive text-center text-xs">
                  {COPY_VALIDATION_FAILURE_GUIDANCE[validationFailure.code]}
                </p>
              ) : unchanged ? (
                <p className="text-muted-foreground text-center text-xs">
                  النص الحالي مطابق للنص الفعلي — لا يوجد تغيير للنشر.
                </p>
              ) : null}

              {effective.publishedText !== null ? (
                confirmingReset ? (
                  <div className="space-y-2 rounded-xl border border-warning/30 bg-warning/5 p-2.5">
                    <p className="text-sm font-medium">
                      تأكيد إعادة التعيين في المخزن؟
                    </p>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      يُحذف التجاوز من مخزن المنصة ويعود النص المعتمد إلى
                      الافتراضي في الكود.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        className="h-11 flex-1"
                        disabled={pending !== null}
                        onClick={() =>
                          run("reset", () =>
                            resetCopyOverrideAction({ key: entry.key }),
                          )
                        }
                      >
                        {pending === "reset" ? (
                          <span className="animate-pulse">جارٍ…</span>
                        ) : (
                          <>
                            <RotateCcwIcon aria-hidden className="size-4" />
                            تأكيد الحذف
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 flex-1"
                        disabled={pending !== null}
                        onClick={() => setConfirmingReset(false)}
                      >
                        إلغاء
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11 w-full"
                    disabled={pending !== null}
                    onClick={() => {
                      setFeedback(null);
                      setConfirmingReset(true);
                    }}
                  >
                    <RotateCcwIcon aria-hidden className="size-4" />
                    إعادة التعيين للنص الافتراضي
                  </Button>
                )
              ) : null}
            </div>
          ) : null}

          {confirmingDiscard ? (
            <div
              role="alert"
              className="space-y-2 rounded-xl border border-warning/30 bg-warning/5 p-3 text-start"
            >
              <p className="text-sm font-medium">
                لديك تعديلات محلية غير مطبقة
              </p>
              <p className="text-muted-foreground text-xs leading-relaxed">
                إغلاق النافذة سيتجاهل التعديلات المحلية غير المطبقة على الحالة
                المعروضة، ولا يحذف ما نُشر بنجاح في المخزن. هل تريد المتابعة؟
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  className="h-11 flex-1"
                  onClick={discardAndClose}
                >
                  تجاهل وإغلاق
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 flex-1"
                  onClick={() => setConfirmingDiscard(false)}
                >
                  البقاء
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full"
              onClick={requestClose}
            >
              <XIcon aria-hidden className="size-4" />
              إغلاق
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** A lightweight placeholder while the effective state is being read. */
function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="space-y-2 rounded-xl border bg-muted/30 p-3.5"
    >
      <div className="bg-muted h-3 w-1/3 animate-pulse rounded" />
      <div className="bg-muted h-12 w-full animate-pulse rounded" />
      <p className="text-muted-foreground text-xs">يُقرأ النص من المخزن…</p>
    </div>
  );
}

/** A failed post-mutation readback: keep the last good effective state. */
function ReadbackFailedNotice() {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/5 p-3.5"
    >
      <CircleAlertIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-warning-foreground"
      />
      <div className="space-y-1 text-sm">
        <p className="font-medium text-warning-foreground">
          تعذّر تحديث الحالة بعد آخر عملية
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          تُعرض آخر حالة مقروءة، وتبقى تعديلاتك المحلية كما هي. أعد فتح النص
          لاحقاً للتحقق من الحالة المخزنة.
        </p>
      </div>
    </div>
  );
}

/** The boundary refused the actor: keep the safe default and say so. */
function LoadFailedNotice() {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/5 p-3.5"
    >
      <CircleAlertIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-warning-foreground"
      />
      <div className="space-y-1 text-sm">
        <p className="font-medium text-warning-foreground">
          تعذّر قراءة حالة النص
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          النص الافتراضي للكود يبقى قابلاً للاستخدام والمعاينة. تحقق من صلاحية
          مشغل المنصة وحاول إعادة الفتح.
        </p>
      </div>
    </div>
  );
}

/**
 * Relevance and override connection are TWO separate facts. This block renders
 * them as two independent sections so an operational key is never mislabeled
 * "unconnected" (the wording IS produced) and an override is never implied to
 * affect a path that does not read it.
 */
function RuntimeCoverageBlock({ entry }: { entry: CopyRegistryEntry }) {
  const coverage = getCopyRuntimeCoverage(entry.key, entry.classification);
  const operational =
    coverage.relevance === "CURRENT_OPERATIONAL_TEMPLATE" ||
    coverage.relevance === "AUTHORITATIVE_DATA_PRESENTATION";

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "space-y-1.5 rounded-xl border p-3 text-start",
          operational
            ? "border-sky-500/30 bg-sky-500/5"
            : "border-muted bg-muted/20",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs font-semibold",
              operational
                ? "text-sky-700 dark:text-sky-300"
                : "text-muted-foreground",
            )}
          >
            <RadioIcon aria-hidden className="size-3.5" />
            صلة النص بالمسار التشغيلي الحالي
          </span>
          <Badge
            variant="outline"
            className={cn(
              "text-xs font-normal",
              operational
                ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                : "text-muted-foreground border-dashed",
            )}
          >
            {coverage.relevanceLabel}
          </Badge>
        </div>
        <p className="text-xs leading-relaxed text-foreground">
          {coverage.relevanceSummary}
        </p>
        {coverage.runtimeNote ? (
          <p className="rounded-lg bg-background/60 p-2 text-muted-foreground text-xs leading-relaxed">
            {coverage.runtimeNote}
          </p>
        ) : null}
      </div>

      <div
        className={cn(
          "space-y-1.5 rounded-xl border p-3 text-start",
          coverage.overrideConnection === "CONNECTED"
            ? "border-emerald-500/30 bg-emerald-500/5"
            : "border-muted bg-muted/20",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 text-xs font-semibold",
              coverage.overrideConnection === "CONNECTED"
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground",
            )}
          >
            ربط تجاوز المختبر بالمحرك
          </span>
          <Badge
            variant="outline"
            className={cn(
              "text-xs font-normal",
              coverage.overrideConnection === "CONNECTED"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "text-muted-foreground border-dashed",
            )}
          >
            {coverage.overrideConnectionLabel}
          </Badge>
        </div>
        <p className="text-xs leading-relaxed text-foreground">
          {coverage.overrideConnectionSummary}
        </p>
      </div>
    </div>
  );
}

/** The effective text + source, the code default, and the published override. */
function EffectiveStateBlock({
  entry,
  state,
}: {
  entry: CopyRegistryEntry;
  state: EffectiveCopyState;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">النص الفعلي في المخزن</h3>
        <span className="text-muted-foreground text-xs">
          دقة الحالة المخزنة
        </span>
      </div>

      <RuntimeCoverageBlock entry={entry} />

      <p className="text-muted-foreground text-xs leading-relaxed">
        {PLATFORM_OVERRIDE_SCOPE_NOTE}
      </p>

      {!state.persistenceAvailable ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/5 p-3.5"
        >
          <CircleAlertIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warning-foreground"
          />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-warning-foreground">
              مخزن النصوص غير متاح
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              يظهر النص الافتراضي للكود، وتبقى المعاينة صحيحة. إجراءات النشر
              وإعادة التعيين معطّلة حتى يعود الاتصال، ولن تُفقد أي تغييرات
              محفوظة في الكود.
            </p>
          </div>
        </div>
      ) : null}

      {state.storedOverrideInvalid ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/5 p-3.5"
        >
          <CircleAlertIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-warning-foreground"
          />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-warning-foreground">
              تجاوزٌ منشور يتجاهله النظام
            </p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              يوجد تجاوز مخزن لكنه لم يعد يستوفي عقد التحقق الحالي، فهو يُتجاهل
              والنص الافتراضي للكود هو الفعلي. عدّله ثم انشره لإصلاحه.
            </p>
            {state.storedOverrideFailureCode ? (
              <p
                dir="ltr"
                className="text-start font-mono text-xs text-muted-foreground"
              >
                {state.storedOverrideFailureCode}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="space-y-2 rounded-xl border bg-muted/30 p-3.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-xs">المصدر</span>
          <SourceBadge source={state.source} />
        </div>
        <p
          dir="auto"
          className="whitespace-pre-wrap text-start text-sm leading-relaxed text-foreground"
        >
          {state.text}
        </p>
      </div>

      <dl className="space-y-2.5 text-sm">
        <div className="flex gap-3">
          <dt className="text-muted-foreground shrink-0 text-xs">
            النص الافتراضي (الكود)
          </dt>
          <dd
            dir="auto"
            className="min-w-0 flex-1 whitespace-pre-wrap text-start text-xs leading-relaxed"
          >
            {state.codeDefault}
          </dd>
        </div>
        {state.publishedText !== null ? (
          <div className="flex gap-3">
            <dt className="text-muted-foreground shrink-0 text-xs">
              التجاوز المنشور
            </dt>
            <dd
              dir="auto"
              className="min-w-0 flex-1 space-y-1 whitespace-pre-wrap text-start text-xs leading-relaxed"
            >
              <span>{state.publishedText}</span>
              {state.publishedActorId ? (
                <span
                  dir="ltr"
                  className="block font-mono text-muted-foreground"
                >
                  {state.publishedActorId}
                </span>
              ) : null}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

function SourceBadge({ source }: { source: EffectiveCopyState["source"] }) {
  if (source === "PLATFORM_OVERRIDE") {
    return (
      <Badge variant="secondary" className="shrink-0">
        {EFFECTIVE_SOURCE_LABELS.PLATFORM_OVERRIDE}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0">
      {EFFECTIVE_SOURCE_LABELS.CODE_DEFAULT}
    </Badge>
  );
}

/** The founder's editor — a draft, never a mutation of the registry. */
function CopyEditor({
  entry,
  draft,
  onDraftChange,
  characters,
  validationFailure,
  hasUnappliedChanges,
}: {
  entry: CopyRegistryEntry;
  draft: string;
  onDraftChange: (value: string) => void;
  characters: number;
  validationFailure: CopyValidationFailure | null;
  hasUnappliedChanges: boolean;
}) {
  const inputId = `copy-lab-editor-${entry.key}`;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={inputId} className="text-sm font-semibold">
          التعديل
        </Label>
        <span
          className={cn(
            "text-xs tabular-nums",
            characters > MAX_COPY_LENGTH
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {characters}/{MAX_COPY_LENGTH}
        </span>
      </div>
      <Textarea
        id={inputId}
        dir="auto"
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        aria-invalid={validationFailure !== null}
        aria-describedby={`${inputId}-hint ${inputId}-dirty`}
      />
      <p id={`${inputId}-dirty`} className="text-xs">
        {hasUnappliedChanges ? (
          <span className="text-amber-600 dark:text-amber-500">
            تعديلات محلية غير مطبقة على النص الفعلي.
          </span>
        ) : (
          <span className="text-muted-foreground">
            النص مطابق للنص الفعلي المحمّل.
          </span>
        )}
      </p>
      {validationFailure ? (
        <p role="alert" className="text-destructive text-xs leading-relaxed">
          {COPY_VALIDATION_FAILURE_GUIDANCE[validationFailure.code]}
        </p>
      ) : null}
      <p id={`${inputId}-hint`} className="text-muted-foreground text-xs">
        {entry.placeholders.length > 0
          ? "احتفظ بالحقول بين الأقواس كما هي — التحقق قبل النشر يرفض الحذف."
          : "نص حر بدون حقول ديناميكية."}
      </p>
    </section>
  );
}

/** The bounded, newest-first history with a per-row restore action. */
function HistorySection({
  items,
  disabled,
  onRestore,
}: {
  items: HistoryItemView[] | null;
  disabled: boolean;
  onRestore: (historyId: string) => void;
}) {
  return (
    <section className="space-y-3 border-t pt-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        <HistoryIcon aria-hidden className="size-4" />
        سجل التعديلات
      </h3>
      {items === null ? (
        <p className="text-muted-foreground text-xs">
          تعذّر قراءة السجل — حاول إعادة فتح النص.
        </p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          لا يوجد سجل بعد لهذا النص.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="space-y-1.5 rounded-xl border bg-card p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <Badge variant="outline" className="shrink-0">
                  {item.actionLabel}
                </Badge>
                <time
                  dateTime={item.createdAt}
                  className="text-muted-foreground text-xs tabular-nums"
                >
                  {item.createdAtLabel}
                </time>
              </div>
              <HistoryText label="قبل" text={item.previousText} />
              <HistoryText label="بعد" text={item.resultText} />
              {item.actorId ? (
                <p
                  dir="ltr"
                  className="text-start font-mono text-xs text-muted-foreground"
                >
                  {item.actorId}
                </p>
              ) : null}
              {item.restorable ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 w-full"
                  disabled={disabled}
                  onClick={() => onRestore(item.id)}
                >
                  استرجاع هذه القيمة
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryText({ label, text }: { label: string; text: string | null }) {
  return (
    <p
      dir="auto"
      className="text-start text-xs leading-relaxed text-muted-foreground"
    >
      <span className="font-medium text-foreground">{label}: </span>
      {text ?? "—"}
    </p>
  );
}

/** A typed service failure: product guidance first, the stable code for debugging. */
function MutationErrorAlert({ error }: { error: MutationError }) {
  return (
    <div
      role="alert"
      className="space-y-1.5 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-start"
    >
      <p className="text-sm font-medium text-destructive">{error.guidance}</p>
      {error.validationGuidance ? (
        <p className="text-xs leading-relaxed text-destructive/90">
          {error.validationGuidance}
        </p>
      ) : null}
      <p
        dir="ltr"
        className="text-start font-mono text-xs text-muted-foreground"
      >
        {error.code}
      </p>
    </div>
  );
}

/** The rendered customer text in a chat-bubble block, RTL-aware. */
function PreviewBubble({ text }: { text: string }) {
  return (
    <div className="rounded-2xl rounded-ss-md bg-primary/10 p-3.5">
      <p
        dir="auto"
        className="whitespace-pre-wrap text-start text-sm leading-relaxed text-foreground"
      >
        {text}
      </p>
    </div>
  );
}

/** A clean, typed renderer failure — never a fabricated value. */
function PreviewFailure({
  code,
  message,
  placeholders,
}: {
  code: CopyRenderFailureCode;
  message: string;
  placeholders?: readonly string[];
}) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-xl border border-warning/30 bg-warning/10 p-3.5"
    >
      <div className="flex items-center gap-2">
        <CircleAlertIcon
          aria-hidden
          className="size-4 shrink-0 text-warning-foreground"
        />
        <p className="text-sm font-medium text-warning-foreground">
          {RENDER_FAILURE_LABELS[code] ?? message}
        </p>
      </div>
      {placeholders && placeholders.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {placeholders.map((name) => (
            <li key={name}>
              <Badge variant="outline" className="font-mono">
                {`{${name}}`}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <p
        dir="ltr"
        className="text-start font-mono text-xs text-muted-foreground"
      >
        {code} — {message}
      </p>
    </div>
  );
}

/** Lightweight, accessible inputs for exactly the placeholders declared. */
function PlaceholderInputs({
  entry,
  rawValues,
  onValueChange,
}: {
  entry: CopyRegistryEntry;
  rawValues: Record<string, string>;
  onValueChange: (name: PlaceholderName, value: string) => void;
}) {
  return (
    <div className="space-y-3">
      {entry.placeholders.map((name) => {
        const required = entry.requiredPlaceholders.includes(name);
        const inputId = `copy-lab-ph-${entry.key}-${name}`;
        return (
          <div key={name} className="space-y-1.5">
            <Label htmlFor={inputId} className="gap-1.5">
              <span dir="ltr" className="font-mono text-xs">
                {`{${name}}`}
              </span>
              {required ? (
                <span className="text-destructive" aria-hidden>
                  *
                </span>
              ) : null}
              <span className="text-muted-foreground text-xs font-normal">
                {required ? "مطلوب" : "اختياري"}
              </span>
            </Label>
            <Input
              id={inputId}
              type="text"
              dir="auto"
              // 44px touch target on mobile (mobile-first).
              className="h-11"
              value={rawValues[name] ?? ""}
              onChange={(event) => onValueChange(name, event.target.value)}
              aria-describedby={`${inputId}-hint`}
            />
            <p id={`${inputId}-hint`} className="text-muted-foreground text-xs">
              {required
                ? "الحقل مطلوب — إفراغه يوقف المعاينة."
                : "الحقل اختياري — يُترك فارغاً إن لم يلزم."}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** Protected copy: metadata + read-only preview, never edit controls. */
function ProtectedNotice({ entry }: { entry: CopyRegistryEntry }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/5 p-3.5">
      <LockIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-warning-foreground"
      />
      <div className="space-y-1 text-sm">
        <p className="font-medium text-warning-foreground">
          نص محمي — غير قابل للتعديل
        </p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          {COPY_CLASSIFICATION_HINTS[entry.classification]}
        </p>
      </div>
    </div>
  );
}

/** Technical metadata — present but never dominant in the product UX. */
function TechnicalDetails({ entry }: { entry: CopyRegistryEntry }) {
  return (
    <section className="space-y-3 border-t pt-4">
      <h3 className="text-sm font-semibold">التفاصيل التقنية</h3>
      <dl className="space-y-2.5 text-sm">
        <DetailRow label="التصنيف">
          <span>{entry.classification}</span>
        </DetailRow>
        <DetailRow label="الفئة">{entry.category}</DetailRow>
        <DetailRow label="النص الافتراضي (الكود)">
          <span
            dir="auto"
            className="whitespace-pre-wrap text-start leading-relaxed"
          >
            {entry.defaultText}
          </span>
        </DetailRow>
        {entry.placeholders.length > 0 ? (
          <DetailRow label="الحقول المُصرَّح بها">
            <TokenList tokens={entry.placeholders} />
          </DetailRow>
        ) : null}
        {entry.requiredPlaceholders.length > 0 ? (
          <DetailRow label="الحقول المطلوبة">
            <TokenList tokens={entry.requiredPlaceholders} />
          </DetailRow>
        ) : null}
        {(entry.markers ?? []).length > 0 ? (
          <DetailRow label="العبارات المحمية" stacked>
            <MarkerList entry={entry} />
          </DetailRow>
        ) : null}
        <DetailRow label="مصدر الكود" stacked>
          <span
            dir="ltr"
            className="text-start font-mono text-xs leading-relaxed"
          >
            {entry.source.file}
            <span className="text-muted-foreground">
              {" "}
              · {entry.source.symbol}
            </span>
          </span>
        </DetailRow>
      </dl>
    </section>
  );
}

function DetailRow({
  label,
  children,
  stacked = false,
}: {
  label: string;
  children: React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-3",
        stacked ? "flex-col" : "flex-row items-baseline justify-between gap-2",
      )}
    >
      <dt className="text-muted-foreground shrink-0 text-xs">{label}</dt>
      <dd className="min-w-0 flex-1 text-start text-xs">{children}</dd>
    </div>
  );
}

function TokenList({ tokens }: { tokens: readonly PlaceholderName[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {tokens.map((name) => (
        <li key={name}>
          <Badge variant="secondary" className="font-mono">
            {`{${name}}`}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function MarkerList({ entry }: { entry: CopyRegistryEntry }) {
  return (
    <ul className="space-y-2">
      {(entry.markers ?? []).map((marker) => (
        <li
          key={marker.id}
          className="space-y-1 rounded-lg border border-warning/25 bg-warning/5 p-2.5"
        >
          {marker.carriedByPlaceholder ? (
            <p className="text-xs leading-relaxed">
              تُحمَل العبارة عبر الحقل{" "}
              <span dir="ltr" className="font-mono">
                {`{${marker.carriedByPlaceholder}}`}
              </span>{" "}
              {marker.sourceKey ? (
                <>
                  (
                  <span dir="ltr" className="font-mono">
                    {marker.sourceKey}
                  </span>
                  )
                </>
              ) : null}
            </p>
          ) : (
            <p
              dir="auto"
              className="rounded bg-warning/15 px-1.5 py-0.5 text-start leading-relaxed"
            >
              {marker.substring}
            </p>
          )}
          <p className="text-muted-foreground text-xs leading-relaxed">
            {marker.reason}
          </p>
        </li>
      ))}
    </ul>
  );
}

function ClassificationBadge({
  classification,
}: {
  classification: CopyRegistryEntry["classification"];
}) {
  if (classification === "PROTECTED_COPY") {
    return (
      <Badge
        variant="outline"
        className="shrink-0 border-warning/40 bg-warning/10 text-warning-foreground"
      >
        <LockIcon aria-hidden className="size-3" />
        {PROTECTED_BADGE}
      </Badge>
    );
  }
  if (classification === "EDITABLE_TEMPLATE") {
    return (
      <Badge variant="secondary" className="shrink-0">
        قالب
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="shrink-0">
      نص
    </Badge>
  );
}
