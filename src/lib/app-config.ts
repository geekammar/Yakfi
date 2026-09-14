/**
 * App-wide configuration. Arabic-first, RTL by default.
 * Keep this file tiny — feature-specific config lives in features.
 */

import type { UserRole } from "@/types/domain";

export const APP_NAME = "FlowPilot";
export const APP_DESCRIPTION =
  "نظام تحويل المواعيد عبر واتساب. حجز أكثر، متابعة أقل.";

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
  { href: "/admin/team", label: "الفريق", icon: "users" },
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
  { href: "/platform/invitations", label: "دعوات الملاك", icon: "mail" },
  { href: "/platform/ai-policy", label: "سياسة الذكاء", icon: "settings" },
];
