/**
 * FlowPilot — InstallPrompt Unit & Route Suppression Tests (PWA-UI-01)
 *
 * Verifies that the install banner:
 * 1. Appears when `beforeinstallprompt` fires on allowed Home / Settings routes.
 * 2. Is completely suppressed on conversation detail and booking task routes.
 * 3. Honors dismissal cooldown in localStorage.
 */
import {
  DISMISS_COOLDOWN_MS,
  DISMISS_KEY,
  InstallPrompt,
} from "@/components/shared/pwa/install-prompt";

import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

describe("InstallPrompt route suppression & dismissal", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.removeChild(container);
    window.localStorage.clear();
  });

  function fireBeforeInstallPrompt() {
    const event = new Event("beforeinstallprompt", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "prompt", {
      value: vi.fn().mockResolvedValue(undefined),
    });
    Object.defineProperty(event, "userChoice", {
      value: Promise.resolve({ outcome: "accepted" }),
    });
    window.dispatchEvent(event);
  }

  it("appears on allowed Home route (/) when beforeinstallprompt fires", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<InstallPrompt forcedPathname="/" />);
    });

    expect(
      container.querySelector('aside[aria-label="تثبيت التطبيق"]'),
    ).toBeNull();

    await act(async () => {
      fireBeforeInstallPrompt();
    });

    const banner = container.querySelector('aside[aria-label="تثبيت التطبيق"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("ثبّت يكفي على جهازك");
  });

  it("appears on allowed Settings route (/settings) when beforeinstallprompt fires", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<InstallPrompt forcedPathname="/settings" />);
    });

    await act(async () => {
      fireBeforeInstallPrompt();
    });

    const banner = container.querySelector('aside[aria-label="تثبيت التطبيق"]');
    expect(banner).not.toBeNull();
  });

  it("is completely suppressed on conversation detail route (/conversations/123)", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <InstallPrompt forcedPathname="/conversations/conv-test-123" />,
      );
    });

    await act(async () => {
      fireBeforeInstallPrompt();
    });

    const banner = container.querySelector('aside[aria-label="تثبيت التطبيق"]');
    expect(banner).toBeNull();
  });

  it("is completely suppressed on booking task routes (/appointments/new and /appointments/123)", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<InstallPrompt forcedPathname="/appointments/new" />);
    });

    await act(async () => {
      fireBeforeInstallPrompt();
    });

    expect(
      container.querySelector('aside[aria-label="تثبيت التطبيق"]'),
    ).toBeNull();

    // Booking detail route
    await act(async () => {
      root.render(<InstallPrompt forcedPathname="/appointments/apt-456" />);
    });

    await act(async () => {
      fireBeforeInstallPrompt();
    });

    expect(
      container.querySelector('aside[aria-label="تثبيت التطبيق"]'),
    ).toBeNull();
  });

  it("honors dismissal and does not reappear during cooldown", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<InstallPrompt forcedPathname="/" />);
    });

    await act(async () => {
      fireBeforeInstallPrompt();
    });

    const dismissBtn = container.querySelector('button[aria-label="إغلاق"]');
    expect(dismissBtn).not.toBeNull();

    await act(async () => {
      dismissBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Banner removed
    expect(
      container.querySelector('aside[aria-label="تثبيت التطبيق"]'),
    ).toBeNull();

    // Timestamp recorded in localStorage
    const dismissedAt = Number(window.localStorage.getItem(DISMISS_KEY) ?? "0");
    expect(dismissedAt).toBeGreaterThan(0);

    // Subsequent beforeinstallprompt within cooldown does not show banner
    await act(async () => {
      fireBeforeInstallPrompt();
    });
    expect(
      container.querySelector('aside[aria-label="تثبيت التطبيق"]'),
    ).toBeNull();

    // After cooldown expires, new beforeinstallprompt shows banner
    window.localStorage.setItem(
      DISMISS_KEY,
      String(Date.now() - DISMISS_COOLDOWN_MS - 1000),
    );
    await act(async () => {
      fireBeforeInstallPrompt();
    });
    expect(
      container.querySelector('aside[aria-label="تثبيت التطبيق"]'),
    ).not.toBeNull();
  });
});
