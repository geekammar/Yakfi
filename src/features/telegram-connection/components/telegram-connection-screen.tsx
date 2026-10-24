"use client";

import {
  beginTelegramProvisioningAction,
  checkTelegramConnectionAction,
  disconnectTelegramConnectionAction,
  getTelegramConnectionStatusAction,
  repairTelegramConnectionAction,
} from "@/features/telegram-connection/actions/telegram-connection-actions";
import {
  buildAndroidTelegramLaunchTargets,
  isAndroidUserAgent,
} from "@/features/telegram-connection/telegram-app-launcher";
import type {
  TelegramConnectionDiagnosticView,
  TelegramConnectionUiState,
  TelegramConnectionView,
} from "@/features/telegram-connection/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import {
  ActivityIcon,
  CheckCircleIcon,
  LinkIcon,
  LoaderCircleIcon,
  SendIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, useTransition } from "react";

/**
 * Telegram connection settings screen (DECISIONS #66 — slice TELEGRAM 03).
 *
 * The customer NEVER sees a bot token, NEVER visits BotFather, and NEVER
 * configures a webhook: the ONE customer action is confirming the bot's
 * creation inside Telegram's own UI (the deep link carries ONLY an opaque
 * single-use token).
 *
 * The screen renders the ONE server-derived UI state machine (no browser
 * interpretation of provider state) and polls the FlowPilot-owned
 * provisioning state while an attempt is in flight — the same honest
 * state-machine pattern the WhatsApp onboarding uses. Every state has an
 * action or an honest terminal label; no permanent spinner.
 *
 * Secret-free by construction: only the bot's @username, its display
 * name, the state, and the safe Arabic failure summary are ever rendered.
 */

/** Polling cadence while an attempt awaits the Admin's Telegram-side
 *  confirmation (the state flips server-side; the poll only observes). */
const POLL_INTERVAL_MS = 4000;
/** A safety bound so a forgotten tab stops polling (the attempt's own
 *  15-minute expiry flips the state to ACTION_REQUIRED well before this). */
const POLL_MAX_ATTEMPTS = 300;

const STATE_LABELS: Record<TelegramConnectionUiState, string> = {
  EMPTY: "غير متصل",
  PROVISIONING: "جاري الربط",
  CONNECTED: "متصل",
  ACTION_REQUIRED: "يحتاج إجراء",
  DISCONNECTED: "غير موصول",
};

const STATE_DESCRIPTIONS: Record<TelegramConnectionUiState, string> = {
  EMPTY:
    "اربط بوت تيليجرام الخاص بمنشأتك لاستقبال رسائل العملاء والرد عليهم تلقائياً. لا تحتاج إلى نسخ أي رمز أو زيارة BotFather.",
  PROVISIONING:
    "في انتظار تأكيدك داخل تيليجرام — اضغط زر «إنشاء البوت» في رسالة بوت الإدارة، ونعود من هنا تلقائياً.",
  CONNECTED:
    "بوت تيليجرام متصل وجاهز لاستقبال رسائل عملائك والرد عليها تلقائياً.",
  ACTION_REQUIRED:
    "تعذّر إكمال ربط تيليجرام في المحاولة الأخيرة — يمكنك بدء محاولة جديدة.",
  DISCONNECTED:
    "البوت غير موصول حالياً — ابدأ تفعيلاً جديداً لاستئناف الرسائل.",
};

export function TelegramConnectionScreen({
  initialView,
}: {
  initialView: TelegramConnectionView;
}) {
  const [view, setView] = useState<TelegramConnectionView>(initialView);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] =
    useState<TelegramConnectionDiagnosticView | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  // On Android, a successful launch opens an in-app chooser instead of
  // navigating unconditionally (DECISIONS #72/#74): the OS default handler
  // may route the HTTPS t.me link to Telegram X, but the flow only completes
  // in standard Telegram, so the Admin explicitly opens the standard client
  // (Telegram X is no longer offered). This holds ONLY the server-returned
  // authorizationUrl — no token, nothing new.
  const [androidLaunchUrl, setAndroidLaunchUrl] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    const result = await getTelegramConnectionStatusAction();
    if (result.success) setView(result.view);
    return result;
  }, []);

  // Poll the FlowPilot-owned provisioning state while an attempt is in
  // flight — the browser cannot observe Telegram's internal state, so it
  // observes OUR state machine instead (honest, bounded, never a spinner
  // without an end).
  useEffect(() => {
    if (view.uiState !== "PROVISIONING") return;
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts += 1;
      if (attempts > POLL_MAX_ATTEMPTS) {
        clearInterval(interval);
        return;
      }
      const result = await getTelegramConnectionStatusAction();
      if (result.success) {
        setView(result.view);
        if (result.view.uiState !== "PROVISIONING") {
          clearInterval(interval);
        }
      }
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [view.uiState]);

  const launch = () => {
    setError(null);
    setNotice(null);
    setAndroidLaunchUrl(null);
    startTransition(async () => {
      const result = await beginTelegramProvisioningAction();
      if (!result.success) {
        setError(result.message);
        return;
      }
      if (!result.launched) {
        // Already connected — the server state is authoritative again.
        await refresh();
        return;
      }
      // A Telegram-owned URL: its ONLY payload is the opaque single-use
      // token — no business id, no secret. The server contract is
      // unchanged; the client only decides HOW to open it.
      const isAndroid =
        typeof navigator !== "undefined" &&
        isAndroidUserAgent(navigator.userAgent);
      if (isAndroid) {
        // ON ANDROID: do NOT navigate here. Show the in-app chooser so the
        // Admin explicitly opens standard Telegram (`org.telegram.messenger`
        // — the only targeted client; Telegram X is not offered). The actual
        // app launch happens from a real <a href="intent://…"> user gesture
        // (DECISIONS #72/#74) — never from this async callback, a timer, or
        // an effect.
        setAndroidLaunchUrl(result.authorizationUrl);
        return;
      }
      // NON-ANDROID (desktop/web/iOS): preserve the current behavior —
      // open the original HTTPS URL directly.
      window.location.href = result.authorizationUrl;
    });
  };

  const disconnect = () => {
    setError(null);
    setNotice(null);
    setAndroidLaunchUrl(null);
    startTransition(async () => {
      const result = await disconnectTelegramConnectionAction();
      if (!result.success) {
        setError(result.message);
        return;
      }
      if (result.cleanupWarning) setNotice(result.cleanupWarning);
      await refresh();
    });
  };

  const handleCheck = async () => {
    if (isChecking || isRepairing || isPending) return;
    setIsChecking(true);
    setError(null);
    setNotice(null);
    try {
      const res = await checkTelegramConnectionAction();
      if (res.success) {
        setDiagnostic(res.diagnostic);
        if (res.diagnostic.status === "ALREADY_CORRECT") {
          setNotice(res.diagnostic.safeSummary);
        }
      } else {
        setError(res.message);
      }
    } catch {
      setError("تعذر إكمال فحص الاتصال حالياً");
    } finally {
      setIsChecking(false);
    }
  };

  const handleRepair = async () => {
    if (isChecking || isRepairing || isPending) return;
    setIsRepairing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await repairTelegramConnectionAction();
      if (res.success) {
        setNotice(res.message);
        if (diagnostic) {
          setDiagnostic({
            ...diagnostic,
            status: "ALREADY_CORRECT",
            hasCallbackSubscription: true,
            allowedUpdates: res.allowedUpdates,
            safeSummary:
              "الاتصال سليم واشتراك استقبال الأزرار مفعل ومطابق للمواصفات.",
          });
        }
        await refresh();
      } else {
        setError(res.message);
      }
    } catch {
      setError("تعذر إكمال عملية الإصلاح حالياً");
    } finally {
      setIsRepairing(false);
    }
  };

  const canLaunch =
    view.uiState === "EMPTY" ||
    view.uiState === "ACTION_REQUIRED" ||
    view.uiState === "DISCONNECTED";
  const launchLabel =
    view.uiState === "ACTION_REQUIRED"
      ? "أعد المحاولة"
      : view.uiState === "DISCONNECTED"
        ? "أعد ربط تيليجرام"
        : "اربط تيليجرام";

  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs sm:p-6">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={
            view.uiState === "CONNECTED"
              ? "text-success shrink-0"
              : view.uiState === "ACTION_REQUIRED"
                ? "text-warning shrink-0"
                : "text-muted-foreground shrink-0"
          }
        >
          {view.uiState === "CONNECTED" ? (
            <CheckCircleIcon className="size-5" />
          ) : view.uiState === "PROVISIONING" ? (
            <LoaderCircleIcon className="size-5 animate-spin" />
          ) : (
            <SendIcon className="size-5" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-base font-semibold tracking-tight">
            تيليجرام — {STATE_LABELS[view.uiState]}
          </h2>
          <p className="text-muted-foreground text-sm leading-6">
            {STATE_DESCRIPTIONS[view.uiState]}
          </p>
          {view.botDisplayName ? (
            <p className="text-foreground text-sm font-medium leading-6">
              {view.botDisplayName}
            </p>
          ) : null}
          {view.botUsername ? (
            <p className="text-muted-foreground font-mono text-xs" dir="ltr">
              @{view.botUsername.replace(/^@/, "")}
            </p>
          ) : null}
          {view.summary && view.uiState === "ACTION_REQUIRED" ? (
            <p className="text-warning text-xs leading-5">{view.summary}</p>
          ) : null}
        </div>
      </div>

      {view.uiState === "PROVISIONING" ? (
        <p
          role="status"
          className="text-muted-foreground mt-4 flex items-center gap-2 border-t pt-4 text-xs leading-5"
        >
          <LinkIcon aria-hidden className="size-4 shrink-0" />
          يُرجى إبقاء هذه الصفحة مفتوحة — سنتحقق من اكتمال التفعيل كل بضع ثوان.
        </p>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:flex-wrap">
        {canLaunch ? (
          <Button
            type="button"
            onClick={launch}
            disabled={isPending}
            className="min-h-11 sm:min-h-9"
          >
            {isPending ? (
              <LoaderCircleIcon aria-hidden className="animate-spin" />
            ) : (
              <SendIcon aria-hidden />
            )}
            {launchLabel}
          </Button>
        ) : null}
        {view.uiState === "PROVISIONING" ? (
          // The PENDING affordance (DECISIONS #67): the provisioning
          // session EXISTS server-side, so the redirect/open action stays
          // available while the attempt is in flight. Re-launching RESUMES
          // the same single-use attempt (the same token + the same deep
          // link), so an Admin who lost the Telegram tab or whose redirect
          // was blocked can re-open it without starting over.
          <Button
            type="button"
            variant="secondary"
            onClick={launch}
            disabled={isPending}
            className="min-h-11 sm:min-h-9"
          >
            {isPending ? (
              <LoaderCircleIcon aria-hidden className="animate-spin" />
            ) : (
              <LinkIcon aria-hidden />
            )}
            افتح رابط تيليجرام
          </Button>
        ) : null}
        {view.uiState === "CONNECTED" ? (
          <>
            <Button
              type="button"
              variant="outline"
              onClick={handleCheck}
              disabled={isPending || isChecking || isRepairing}
              className="min-h-11 sm:min-h-9"
            >
              {isChecking ? (
                <LoaderCircleIcon aria-hidden className="animate-spin" />
              ) : (
                <ActivityIcon aria-hidden />
              )}
              فحص الاتصال
            </Button>
            {diagnostic?.status === "REPAIR_REQUIRED" ? (
              <Button
                type="button"
                variant="default"
                onClick={handleRepair}
                disabled={isPending || isChecking || isRepairing}
                className="min-h-11 sm:min-h-9"
              >
                {isRepairing ? (
                  <LoaderCircleIcon aria-hidden className="animate-spin" />
                ) : (
                  <WrenchIcon aria-hidden />
                )}
                إصلاح استقبال الأزرار
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              onClick={disconnect}
              disabled={isPending || isChecking || isRepairing}
              className="min-h-11 sm:min-h-9"
            >
              {isPending ? (
                <LoaderCircleIcon aria-hidden className="animate-spin" />
              ) : null}
              فصل تيليجرام
            </Button>
          </>
        ) : null}
      </div>

      {diagnostic ? (
        <div className="bg-muted/40 mt-4 space-y-3 rounded-lg border p-4 text-sm">
          <div className="flex items-center gap-2">
            {diagnostic.status === "ALREADY_CORRECT" ? (
              <CheckCircleIcon className="text-success size-5 shrink-0" />
            ) : (
              <TriangleAlertIcon className="text-warning size-5 shrink-0" />
            )}
            <h3 className="font-semibold">
              {diagnostic.status === "ALREADY_CORRECT"
                ? "نتيجة الفحص: الاتصال واستقبال الأزرار سليم"
                : "نتيجة الفحص: استقبال الأزرار غير مفعل"}
            </h3>
          </div>
          <p className="text-muted-foreground text-xs leading-5">
            {diagnostic.safeSummary}
          </p>
          <div className="text-muted-foreground grid grid-cols-1 gap-2 pt-1 font-mono text-xs sm:grid-cols-2">
            <div>
              <span className="font-sans font-medium text-foreground">
                معرّف البوت:{" "}
              </span>
              <span dir="ltr">{diagnostic.botExternalId}</span>
              {diagnostic.botUsername
                ? ` (@${diagnostic.botUsername.replace(/^@/, "")})`
                : ""}
            </div>
            <div>
              <span className="font-sans font-medium text-foreground">
                اشتراك الأزرار:{" "}
              </span>
              <span
                className={
                  diagnostic.hasCallbackSubscription
                    ? "text-success font-sans font-medium"
                    : "text-warning font-sans font-medium"
                }
              >
                {diagnostic.hasCallbackSubscription
                  ? "مفعل (callback_query)"
                  : "غير مفعل"}
              </span>
            </div>
            <div className="col-span-full">
              <span className="font-sans font-medium text-foreground">
                رابط الويبهوك:{" "}
              </span>
              <span dir="ltr" className="break-all">
                {diagnostic.webhookUrl}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      {androidLaunchUrl ? (
        <AndroidTelegramChooser url={androidLaunchUrl} />
      ) : null}

      {notice ? (
        <Alert className="mt-4">
          {view.uiState === "CONNECTED" ? (
            <CheckCircleIcon aria-hidden className="text-success size-4" />
          ) : (
            <TriangleAlertIcon aria-hidden className="size-4" />
          )}
          <AlertTitle>
            {view.uiState === "CONNECTED"
              ? "معلومات الاتصال"
              : "تم الفصل مع تحذير"}
          </AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive" className="mt-4">
          <TriangleAlertIcon aria-hidden className="size-4" />
          <AlertTitle>تعذر إكمال الإجراء</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

/**
 * The Android Telegram app chooser (DECISIONS #72/#74). Shown ONLY on
 * Android, ONLY after a successful launch. Each option is a REAL
 * user-gesture anchor (`<a href="intent://…">` / the plain HTTPS link) —
 * the external app is NEVER opened from a timer, an effect, or an async
 * callback, so the browser treats the tap as a legitimate user-initiated
 * navigation.
 *
 * The launcher targets ONLY standard Telegram (`org.telegram.messenger`);
 * the plain HTTPS link is the universal fallback and is the SAME
 * server-returned authorizationUrl, byte-for-byte. Telegram X is
 * intentionally NOT offered (DECISIONS #74) — it does not complete the
 * managed-bot creation flow on the affected Android setup.
 */
function AndroidTelegramChooser({ url }: { url: string }) {
  const targets = buildAndroidTelegramLaunchTargets(url);
  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold tracking-tight">
          افتح تيليجرام لإكمال الإنشاء
        </h3>
        <p className="text-muted-foreground text-xs leading-5">
          لإكمال إنشاء البوت، افتح تطبيق تيليجرام الرسمي. إن لم يفتح تلقائياً،
          استخدم الرابط العادي بالأسفل.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Button asChild className="min-h-11 sm:min-h-9">
          <a href={targets.standard.url}>
            <SendIcon aria-hidden />
            فتح في Telegram
          </a>
        </Button>
        <Button asChild variant="ghost" className="min-h-11 sm:min-h-9">
          <a href={targets.fallback.url}>
            <LinkIcon aria-hidden />
            فتح الرابط العادي
          </a>
        </Button>
      </div>
    </div>
  );
}
