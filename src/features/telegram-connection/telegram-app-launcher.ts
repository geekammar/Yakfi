/**
 * Client-side Telegram Android app launcher (DECISIONS #72 — the Android
 * app-selection compatibility fix).
 *
 * WHY THIS EXISTS: live Telegram onboarding proved that on an affected
 * Android device the OS/app-link default-handler routes HTTPS `t.me` links
 * to **Telegram X** (`org.thunderdog.challegram`), and the FlowPilot
 * provisioning flow only completes in the **standard Telegram** app
 * (`org.telegram.messenger`). The provisioning deep link is correct; the
 * only problem is WHICH Android client receives it. So this module lets the
 * client explicitly target a specific Telegram package via an Android
 * `intent://` URL, with the standard Telegram app as the primary choice and
 * the original HTTPS URL always preserved as the fallback.
 *
 * HARD BOUNDARIES (all enforced by construction here):
 * - This is a CLIENT launch/compatibility helper ONLY. It performs NO
 *   provisioning, mints NO token, touches NO server contract, and adds NO
 *   route. `beginTelegramProvisioningAction()` still owns the lifecycle and
 *   still returns the SAME `authorizationUrl`.
 * - The opaque single-use start token is NEVER inspected, parsed, or
 *   modified — the original HTTPS `authorizationUrl` is reused verbatim as
 *   the intent's data authority and byte-for-byte as its
 *   `browser_fallback_url`.
 * - Nothing here logs, persists, or copies the URL/token into any new
 *   state field beyond the `authorizationUrl` the server already returned.
 * - These are PURE functions (no `window`, no `navigator`, no I/O), so the
 *   platform decision is testable and the intent strings are assertable
 *   offline. The component supplies `navigator.userAgent`.
 */

/** The official Telegram Android package. FlowPilot's provisioning flow
 *  is verified against this client — it is the PRIMARY/default choice. */
export const STANDARD_TELEGRAM_PACKAGE = "org.telegram.messenger";

/** The Telegram X Android package. Offered as an explicit optional choice,
 *  NEVER selected automatically (it is the client the flow fails on). */
export const TELEGRAM_X_PACKAGE = "org.thunderdog.challegram";

/**
 * True only for an Android user agent. Pure (the caller passes
 * `navigator.userAgent`) so the platform gate is assertable offline and no
 * package chooser is ever shown on desktop/web/iOS.
 */
export function isAndroidUserAgent(
  userAgent: string | null | undefined,
): boolean {
  if (!userAgent) return false;
  return /android/i.test(userAgent);
}

/**
 * Build an Android `intent://` URL that hands the EXISTING HTTPS
 * authorization URL to a specific Telegram package, with the original HTTPS
 * URL preserved byte-for-byte as `S.browser_fallback_url`.
 *
 * The intent reuses the HTTPS URL's own host/path/query as the intent data
 * (with `scheme=https`), so the opaque `?start=<token>` payload rides
 * through unchanged — this function never reads or rewrites the token; it
 * only swaps the URI scheme prefix and appends the standard `#Intent;…;end`
 * fragment. If an intent cannot resolve on the device, Android itself opens
 * the `browser_fallback_url` (the identical original HTTPS link).
 *
 * Example (standard Telegram):
 *   intent://t.me/Manager?start=OPAQUE#Intent;scheme=https;
 *     package=org.telegram.messenger;
 *     S.browser_fallback_url=<encoded original https url>;end
 */
export function buildTelegramAndroidIntentUrl(
  authorizationUrl: string,
  androidPackage: string,
): string {
  // Swap ONLY the scheme prefix for the intent data (host/path/query — and
  // therefore the opaque token — are untouched). If the input is not an
  // https URL, leave it as-is: we never fabricate a destination.
  const intentData = authorizationUrl.replace(/^https:\/\//i, "");
  // The full original HTTPS URL is preserved verbatim as the fallback.
  const fallback = encodeURIComponent(authorizationUrl);
  return (
    `intent://${intentData}#Intent;scheme=https;` +
    `package=${androidPackage};` +
    `S.browser_fallback_url=${fallback};end`
  );
}

/**
 * The three explicit launch targets for the Android chooser, in the
 * approved order: standard Telegram first (primary/default), Telegram X
 * second (explicit optional), the plain HTTPS link last (universal
 * fallback). The `authorizationUrl` is the SAME server-returned value in
 * every target — the chooser only decides which client receives it.
 */
export type TelegramLaunchTarget = {
  packageName: string | null; // null → the plain HTTPS fallback
  url: string; // an intent:// URL, or the original https URL for the fallback
};

export function buildAndroidTelegramLaunchTargets(authorizationUrl: string): {
  standard: TelegramLaunchTarget;
  telegramX: TelegramLaunchTarget;
  fallback: TelegramLaunchTarget;
} {
  return {
    standard: {
      packageName: STANDARD_TELEGRAM_PACKAGE,
      url: buildTelegramAndroidIntentUrl(
        authorizationUrl,
        STANDARD_TELEGRAM_PACKAGE,
      ),
    },
    telegramX: {
      packageName: TELEGRAM_X_PACKAGE,
      url: buildTelegramAndroidIntentUrl(authorizationUrl, TELEGRAM_X_PACKAGE),
    },
    fallback: {
      packageName: null,
      // The original HTTPS URL, byte-for-byte — no transformation at all.
      url: authorizationUrl,
    },
  };
}
