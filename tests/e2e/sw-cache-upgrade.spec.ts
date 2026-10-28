import { expect, test } from "@playwright/test";

test.describe("Service Worker & Asset Cache Lifecycle QA", () => {
  test("v2-to-v3 asset-cache upgrade, stale eviction, and offline navigation fallback", async ({
    page,
    context,
  }, testInfo) => {
    // Run once in the isolated desktop-1280 CI profile
    test.skip(
      testInfo.project.name !== "desktop-1280",
      "Scenario runs once in isolated desktop-1280 profile",
    );

    // 1. Navigate to a known origin route so we have a valid secure origin context
    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });

    // 2. Establish a stale old icon in the legacy v2 cache (flowpilot-static-v2)
    const staleLegacySvg = `<svg id="legacy-v2-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="#999999"/></svg>`;

    await page.evaluate(async (staleSvg) => {
      // Unregister any active service worker first
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }
      // Clear all existing caches
      const cacheKeys = await caches.keys();
      for (const key of cacheKeys) {
        await caches.delete(key);
      }

      // Seed the legacy v2 cache with a known stale legacy icon
      const v2Cache = await caches.open("flowpilot-static-v2");
      await v2Cache.put(
        "/icon.svg",
        new Response(staleSvg, {
          status: 200,
          headers: { "Content-Type": "image/svg+xml" },
        }),
      );
    }, staleLegacySvg);

    // Verify stale legacy asset is confirmed inside flowpilot-static-v2
    const staleVerification = await page.evaluate(async () => {
      const v2 = await caches.open("flowpilot-static-v2");
      const match = await v2.match("/icon.svg");
      return match ? await match.text() : null;
    });
    expect(staleVerification).toContain("legacy-v2-icon");

    // 3. Exercise actual new service worker (/sw.js) installation and activation
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.register("/sw.js");
      await new Promise<void>((resolve) => {
        const worker = reg.installing || reg.waiting || reg.active;
        if (!worker) return resolve();
        if (worker.state === "activated") return resolve();
        worker.addEventListener("statechange", () => {
          if (worker.state === "activated") resolve();
        });
      });
      await navigator.serviceWorker.ready;
    });

    // Wait until the new v3 cache has been created by sw precache/activation
    await page.waitForFunction(async () => {
      const keys = await caches.keys();
      return keys.includes("flowpilot-static-v3");
    });

    // 4. Verify old-cache eviction and new icon in flowpilot-static-v3
    const cacheStatus = await page.evaluate(async () => {
      const keys = await caches.keys();
      const hasV2 = keys.includes("flowpilot-static-v2");
      const hasV3 = keys.includes("flowpilot-static-v3");
      let iconBody = "";
      if (hasV3) {
        const v3 = await caches.open("flowpilot-static-v3");
        const iconRes = await v3.match("/icon.svg");
        if (iconRes) iconBody = await iconRes.text();
      }
      return { keys, hasV2, hasV3, iconBody };
    });

    expect(cacheStatus.hasV2, "flowpilot-static-v2 must be evicted").toBe(
      false,
    );
    expect(cacheStatus.hasV3, "flowpilot-static-v3 must exist").toBe(true);
    expect(cacheStatus.iconBody).not.toContain("legacy-v2-icon");
    // Verify approved Yakfi brand colors in the new icon
    expect(cacheStatus.iconBody).toContain("#173B63"); // Deep navy
    expect(cacheStatus.iconBody).toContain("#64B9CD"); // Sky blue

    // 5. Verify same-path icon request returns the new asset
    const fetchResult = await page.evaluate(async () => {
      const res = await fetch("/icon.svg");
      return {
        status: res.status,
        text: await res.text(),
      };
    });
    expect(fetchResult.status).toBe(200);
    expect(fetchResult.text).not.toContain("legacy-v2-icon");
    expect(fetchResult.text).toContain("#173B63");

    // 6. Verify API caching exclusion (API traffic must never be cached)
    const apiCacheCheck = await page.evaluate(async () => {
      await fetch("/api/health");
      const v3 = await caches.open("flowpilot-static-v3");
      const match = await v3.match("/api/health");
      return match !== undefined;
    });
    expect(apiCacheCheck, "API requests must not be cached by SW").toBe(false);

    // 7. Verify offline navigation fallback still works
    await context.setOffline(true);
    try {
      await page.goto("/offline-recovery-probe-route", {
        waitUntil: "domcontentloaded",
      });
      await expect(page).toHaveTitle(/غير متصل.*يكفي/);
      await expect(page.locator("h1")).toContainText(/لا يوجد اتصال بالإنترنت/);
    } finally {
      await context.setOffline(false);
    }
  });

  test("Web App Manifest & rendered brand icons contract", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-1280",
      "Scenario runs once in isolated desktop-1280 profile",
    );

    const manifestRes = await page.request.get("/manifest.webmanifest");
    expect(manifestRes.status()).toBe(200);
    const manifest = await manifestRes.json();
    expect(manifest.name).toBe("يكفي — إدارة المحادثات والمواعيد");
    expect(manifest.short_name).toBe("يكفي");
    expect(manifest.theme_color).toBe("#173B63");
    expect(manifest.background_color).toBe("#F4F7FB");
    expect(manifest.icons).toHaveLength(3);

    for (const icon of manifest.icons) {
      const res = await page.request.get(icon.src);
      expect(res.status(), `Icon ${icon.src} must exist and return 200`).toBe(
        200,
      );
    }

    // Also verify root icon.svg returns 200
    const svgRes = await page.request.get("/icon.svg");
    expect(svgRes.status(), "Root icon.svg must return 200").toBe(200);
  });
});
