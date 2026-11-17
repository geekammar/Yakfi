// Isolated CI test preload (`NODE_OPTIONS="--import ./scripts/render-test-fetch-preload.mjs"`).
// Used ONLY by `scripts/check-render-runtime-db.ts` when spawning a local
// `next start` child process so outbound calls to `api.telegram.org` and
// `openrouter.ai` route to the local loopback mock server with zero external
// network traffic, zero real Telegram sends, and zero paid AI calls.

const mockOrigin = process.env.FLOWPILOT_CI_MOCK_PROVIDER_ORIGIN?.trim();

if (mockOrigin) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    try {
      const parsed = new URL(rawUrl);
      if (
        parsed.hostname === "api.telegram.org" ||
        parsed.hostname === "openrouter.ai"
      ) {
        const target = new URL(
          `/__mock_${parsed.hostname}${parsed.pathname}${parsed.search}`,
          mockOrigin,
        );
        return originalFetch(target, init);
      }
    } catch {
      // Pass through non-URL inputs unchanged
    }

    return originalFetch(input, init);
  };
}
