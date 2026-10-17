import { populatePreviewEnvIfNeeded } from "./src/lib/url-resolver";
import type { NextConfig } from "next";

populatePreviewEnvIfNeeded();

const nextConfig: NextConfig = {/* config options here */};

export default nextConfig;
