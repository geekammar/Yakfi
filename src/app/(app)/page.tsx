import { Dashboard } from "@/features/dashboard/components/dashboard";
import {
  getAiReadinessInput,
  getDashboardData,
} from "@/features/dashboard/server/dashboard-query";
import { computeAiReadiness } from "@/lib/ai-readiness";
import { requireUser } from "@/server/auth/guards";
import { businessRepository } from "@/server/repositories";

import { redirect } from "next/navigation";

export default async function HomePage() {
  const session = await requireUser();
  if (session.user.role === "STAFF") redirect("/staff");
  if (!session.user.businessId) redirect("/onboarding");

  const business = await businessRepository.findById(session.user.businessId);
  if (!business || !business.onboardingCompletedAt) redirect("/onboarding");

  const [data, readinessInput] = await Promise.all([
    getDashboardData(business.id, business.timezone),
    getAiReadinessInput(business),
  ]);

  return (
    <Dashboard
      businessName={business.name}
      whatsappNumber={business.whatsappNumber}
      timeZone={business.timezone}
      readiness={computeAiReadiness(readinessInput)}
      data={data}
    />
  );
}
