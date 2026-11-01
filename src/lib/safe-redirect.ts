/**
 * Shared safe redirect helper for authentication transitions (ISS-017).
 *
 * Guarantees destinations are strictly same-origin internal paths.
 * Usable across both client components (LoginForm) and server components (SignInPage).
 *
 * Invariants:
 * - Rejects non-string inputs (arrays, numbers, null, undefined, objects)
 * - Rejects ASCII control characters (0x00-0x1F, 0x7F) including tabs and newlines
 * - Rejects backslashes (\) to prevent parser differential attacks
 * - Parses against a hardcoded, controlled trusted origin (never user-supplied)
 * - Verifies the parsed URL origin strictly matches the trusted origin
 * - Normalizes dot segments (e.g. /admin/../sign-in -> /sign-in)
 * - Normalizes paths before checking and preventing self-redirects back to auth screens
 * - Preserves legitimate internal paths, query parameters, and hashes
 * - Falls back to "/" for any rejected or malformed input
 */

const TRUSTED_ORIGIN = "http://flowpilot.internal";

export function resolveSafeRedirect(raw: unknown): string {
  if (typeof raw !== "string") {
    return "/";
  }

  const trimmed = raw.trim();
  if (!trimmed || !trimmed.startsWith("/")) {
    return "/";
  }

  // Reject ASCII control characters (0x00-0x1F, 0x7F) and backslashes
  // to avoid URL parser stripping or folding ambiguities (e.g. WHATWG URL tab/newline stripping).
  if (/[\u0000-\u001F\u007F\\]/.test(trimmed)) {
    return "/";
  }

  try {
    const url = new URL(trimmed, TRUSTED_ORIGIN);

    // Origin must strictly match our controlled trusted origin
    if (url.origin !== TRUSTED_ORIGIN) {
      return "/";
    }

    // Must start with single slash and not double slash
    if (!url.pathname.startsWith("/") || url.pathname.startsWith("//")) {
      return "/";
    }

    // Normalize path to detect auth screens (strip trailing slash if length > 1)
    const normalizedPath =
      url.pathname.length > 1 && url.pathname.endsWith("/")
        ? url.pathname.slice(0, -1)
        : url.pathname;

    if (normalizedPath === "/sign-in" || normalizedPath === "/sign-up") {
      return "/";
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
