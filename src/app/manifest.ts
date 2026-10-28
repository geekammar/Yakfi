import {
  APP_DESCRIPTION,
  APP_NAME,
  HTML_DIR,
  HTML_LANG,
} from "@/lib/app-config";

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: `${APP_NAME} — إدارة المحادثات والمواعيد`,
    short_name: APP_NAME,
    description: APP_DESCRIPTION,
    lang: HTML_LANG,
    dir: HTML_DIR,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#F4F7FB",
    theme_color: "#173B63",
    categories: ["business", "productivity"],
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "المواعيد",
        url: "/appointments",
      },
      {
        name: "المحادثات",
        url: "/conversations",
      },
    ],
  };
}
