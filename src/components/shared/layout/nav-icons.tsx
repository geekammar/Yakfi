import type { NavItem } from "@/lib/app-config";

import {
  Building2,
  CalendarDays,
  ClipboardList,
  House,
  Layers,
  Mail,
  MessageCircle,
  SettingsIcon,
  Shield,
  Type,
  Users,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  home: House,
  building: Building2,
  calendar: CalendarDays,
  message: MessageCircle,
  users: Users,
  shield: Shield,
  clipboard: ClipboardList,
  layers: Layers,
  settings: SettingsIcon,
  mail: Mail,
  type: Type,
};

export function getNavIcon(iconName: string): LucideIcon {
  return ICONS[iconName] ?? House;
}

export type { NavItem };
