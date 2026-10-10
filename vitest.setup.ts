/**
 * FlowPilot — Vitest setup (UX-LAB-01D-P1 / B2).
 *
 * jsdom is intentionally minimal, so this fills in only the handful of browser
 * APIs the mounted component tree actually touches (Radix dialog focus +
 * media queries, element scrolling for focus management). No behaviour is
 * faked beyond the DOM surface itself — the component under test runs its
 * real code.
 */

/**
 * React 19 requires this flag for `act()` to actually flush effects/state in
 * a test environment; without it every act() call warns and no-ops.
 */
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** A no-op DOM API stub for jsdom. */
function notImplemented() {}

if (typeof window !== "undefined") {
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: notImplemented,
      removeEventListener: notImplemented,
      addListener: notImplemented,
      removeListener: notImplemented,
      dispatchEvent: () => false,
    });
  }

  if (typeof window.ResizeObserver !== "function") {
    class ResizeObserverStub {
      observe = notImplemented;
      unobserve = notImplemented;
      disconnect = notImplemented;
      takeRecords = () => [];
    }
    window.ResizeObserver =
      ResizeObserverStub as unknown as typeof ResizeObserver;
  }

  if (typeof window.IntersectionObserver !== "function") {
    class IntersectionObserverStub {
      observe = notImplemented;
      unobserve = notImplemented;
      disconnect = notImplemented;
      takeRecords = () => [];
      root = null;
      rootMargin = "";
      thresholds = [];
    }
    window.IntersectionObserver =
      IntersectionObserverStub as unknown as typeof IntersectionObserver;
  }

  if (typeof HTMLElement !== "undefined") {
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = notImplemented;
    }
    // Vaul's drag path captures the pointer on the drawer surface; jsdom has no
    // pointer-capture implementation, so without these the drag machinery
    // throws before it can engage (and a drag-competition test would pass
    // vacuously).
    if (typeof HTMLElement.prototype.setPointerCapture !== "function") {
      HTMLElement.prototype.setPointerCapture = notImplemented;
    }
    if (typeof HTMLElement.prototype.releasePointerCapture !== "function") {
      HTMLElement.prototype.releasePointerCapture = notImplemented;
    }
    if (typeof HTMLElement.prototype.hasPointerCapture !== "function") {
      HTMLElement.prototype.hasPointerCapture = () => false;
    }
  }

  // Radix focus management scrolls the active element into view; jsdom leaves
  // these as no-ops by default.
  if (typeof window.scrollTo !== "function") {
    window.scrollTo = notImplemented;
  }
}
