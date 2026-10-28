"use client";

import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/app-config";

import { DownloadIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "flowpilot-install-dismissed-at";
const DISMISS_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 7; // one week

/**
 * Non-intrusive install banner driven by `beforeinstallprompt`.
 * Respects a dismissal cooldown stored in localStorage.
 */
export function InstallPrompt() {
  const [promptEvent, setPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      const dismissedAt = Number(
        window.localStorage.getItem(DISMISS_KEY) ?? "0",
      );
      if (Date.now() - dismissedAt < DISMISS_COOLDOWN_MS) return;

      setPromptEvent(event as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const dismiss = useCallback(() => {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setPromptEvent(null);
  }, []);

  const install = useCallback(async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    await promptEvent.userChoice;
    setPromptEvent(null);
  }, [promptEvent]);

  if (!promptEvent) return null;

  return (
    <aside
      aria-label="تثبيت التطبيق"
      className="bg-card fixed inset-x-4 bottom-20 z-[var(--z-banner)] flex items-center gap-3 rounded-xl border p-3 shadow-lg md:bottom-6 md:inset-x-auto md:end-6 md:max-w-sm"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">ثبّت {APP_NAME} على جهازك</p>
        <p className="text-muted-foreground truncate text-xs">
          وصول أسرع وتجربة أفضل.
        </p>
      </div>
      <Button size="sm" onClick={install}>
        <DownloadIcon aria-hidden className="size-4" />
        تثبيت
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="إغلاق"
        onClick={dismiss}
      >
        <XIcon aria-hidden className="size-4" />
      </Button>
    </aside>
  );
}
