/**
 * App-wide configuration. Arabic-first, RTL by default.
 * Keep this file tiny — feature-specific config lives in features.
 */

import type { UserRole } from "@/types/domain";

export const APP_NAME = "يكفي";
export const APP_NAME_LATIN = "yakfi";
export const APP_DESCRIPTION = "إدارة المحادثات وحجز المواعيد ومتابعتها.";

export const HTML_LANG = "ar";
export const HTML_DIR = "rtl" as const;

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /**
   * Optional business-role restriction. Layouts filter out items the
   * current user's role may not see — UI visibility only, never an
   * authorization boundary (server guards stay authoritative).
   */
  roles?: UserRole[];
  /**
   * PROMPT-B04 — the count of UNACKNOWLEDGED operator attentions (unresolved
   * handoffs nobody has opened yet) rendered as a badge. Attached
   * server-side by the layouts from the session's Business (never client
   * input); consumers treat it as display-only.
   */
  attentionCount?: number;
};

/** Main authenticated app navigation (generic — no vertical terminology). */
export const APP_NAV_ITEMS: NavItem[] = [
  { href: "/", label: "الرئيسية", icon: "home", roles: ["ADMIN"] },
  { href: "/staff", label: "مهامي", icon: "clipboard", roles: ["STAFF"] },
  { href: "/appointments", label: "المواعيد", icon: "calendar" },
  { href: "/conversations", label: "المحادثات", icon: "message" },
  { href: "/customers", label: "العملاء", icon: "users" },
  { href: "/services", label: "الخدمات", icon: "layers", roles: ["ADMIN"] },
  { href: "/settings", label: "الإعدادات", icon: "settings", roles: ["ADMIN"] },
];

/** Admin area navigation. */
export const ADMIN_NAV_ITEMS: NavItem[] = [
  { href: "/admin", label: "لوحة الإدارة", icon: "shield" },
  { href: "/admin/team", label: "إدارة الفريق ومقدمي الخدمة", icon: "users" },
];

/** Staff area navigation — the workspace plus the shared operational screens. */
export const STAFF_NAV_ITEMS: NavItem[] = [
  { href: "/staff", label: "مهامي", icon: "clipboard" },
  { href: "/conversations", label: "المحادثات", icon: "message" },
  { href: "/appointments", label: "المواعيد", icon: "calendar" },
];

/**
 * Platform Control Plane navigation (PROMPT-OPS-05) — the Platform
 * Operator's own surface, separate from every Business area. Guarded
 * by `requirePlatformOperator`; intentionally small.
 */
export const PLATFORM_NAV_ITEMS: NavItem[] = [
  { href: "/platform", label: "نظرة عامة", icon: "home" },
  { href: "/platform/businesses", label: "المنشآت", icon: "building" },
  { href: "/platform/invitations", label: "دعوات الملاك", icon: "mail" },
  { href: "/platform/ai-policy", label: "سياسة الذكاء", icon: "settings" },
  {
    href: "/platform/conversation-lab",
    label: "مختبر النصوص",
    icon: "type",
  },
];
