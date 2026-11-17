import { populatePreviewEnvIfNeeded } from "./src/lib/url-resolver";
import type { NextConfig } from "next";

populatePreviewEnvIfNeeded();

const NO_CACHE_REVALIDATE_HEADERS = [
  {
    key: "Cache-Control",
    value: "public, max-age=0, must-revalidate",
  },
];

export const PLATFORM_NEUTRAL_PWA_HEADERS = [
  {
    source: "/sw.js",
    headers: NO_CACHE_REVALIDATE_HEADERS,
  },
  {
    source: "/offline.html",
    headers: NO_CACHE_REVALIDATE_HEADERS,
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return PLATFORM_NEUTRAL_PWA_HEADERS;
  },
};

export default nextConfig;
