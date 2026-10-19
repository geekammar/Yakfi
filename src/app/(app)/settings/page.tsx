import { SettingsScreen } from "@/features/settings/components/settings-screen";
import {
  defaultSettingsServiceDeps,
  getBusinessSettings,
  type SettingsActor,
} from "@/features/settings/server/settings-service";
import type { BusinessSettingsView } from "@/features/settings/types";
import { requireRole } from "@/server/auth/guards";
import { serviceRepository } from "@/server/repositories";

import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "الإعدادات",
};

/**
 * Business Settings — ADMIN-only (STAFF is redirected to access-denied).
 * The Business is derived from the authenticated session; the service
 * layer enforces the role + tenant scoping server-side on every read
 * and write.
 */
export default async function SettingsPage() {
  const session = await requireRole("ADMIN");
  if (!session.user.businessId) redirect("/onboarding");

  const actor: SettingsActor = {
    userId: session.user.id,
    role: "ADMIN", // asserted by the guard above
    businessId: session.user.businessId,
  };

  const [result, services] = await Promise.all([
    getBusinessSettings(defaultSettingsServiceDeps, actor),
    serviceRepository.listByBusiness(session.user.businessId),
  ]);
  // The page guard + layout redirect make this unreachable in practice;
  // honest fallback instead of rendering an empty form.
  if (!("name" in result)) redirect("/onboarding");

  const settings: BusinessSettingsView = result;
  return (
    <SettingsScreen
      initialSettings={settings}
      services={services.map((s) => ({
        id: s.id,
        name: s.name,
        isActive: s.isActive,
      }))}
    />
  );
}
