import { BusinessSetupForm } from "@/features/onboarding/components/business-setup-form";
import { StepHeader } from "@/features/onboarding/components/step-header";
import { APP_NAME } from "@/lib/app-config";
import { verticalSchema } from "@/lib/validation";
import { requireUser } from "@/server/auth/guards";
import { businessRepository } from "@/server/repositories";

export default async function OnboardingBusinessPage() {
  const session = await requireUser();
  const business = session.user.businessId
    ? await businessRepository.findById(session.user.businessId)
    : null;
  const vertical = verticalSchema.safeParse(business?.vertical);

  return (
    <div className="animate-fade-in-up space-y-8">
      <StepHeader
        title="بيانات المنشأة"
        description={`مرحباً بك في ${APP_NAME}! نجهز حسابك في خطوات بسيطة — ابدأ ببيانات منشأتك الأساسية.`}
      />
      <BusinessSetupForm
        defaultValues={{
          name: business?.name ?? "",
          vertical: vertical.success ? vertical.data : undefined,
          city: business?.city ?? "",
          whatsappNumber: business?.whatsappNumber ?? "+20",
          timezone: business?.timezone ?? "Africa/Cairo",
          about: business?.about ?? "",
        }}
      />
    </div>
  );
}
