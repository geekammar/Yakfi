import { ActivationNotice } from "@/features/invitations/components/activation-notice";
import { OwnerActivationForm } from "@/features/platform/components/owner-activation-form";
import { getOwnerInvitationByToken } from "@/features/platform/server/owner-invitation-service";

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "تفعيل حساب المالك",
  // Invitation URLs carry the credential in the path — never indexable.
  robots: { index: false, follow: false },
};

/**
 * Public owner-activation route (PROMPT-OPS-05): the owner is not
 * authenticated — the invitation token in the path IS the credential.
 * The page performs a READ-ONLY invitation lookup (no mutation on
 * GET): acceptance + activation run atomically at submit time through
 * the server action. After activation the owner signs in and completes
 * the canonical onboarding (Business + Default Branch + ADMIN
 * ownership) — the Business is never created here as a shortcut.
 */
export default async function OwnerInviteActivationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await getOwnerInvitationByToken({ token });

  if (!result.success) {
    const transient = result.error.code === "PERSISTENCE_FAILED";
    return (
      <div className="space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            تفعيل حساب المالك
          </h1>
        </div>
        <ActivationNotice
          state={transient ? "FAILED" : "INVALID_TOKEN"}
          message={transient ? result.error.message : undefined}
        />
      </div>
    );
  }

  const { invitation, status, businessName } = result.data;

  let content: React.ReactNode;
  switch (status) {
    case "EXPIRED":
      content = <ActivationNotice state="EXPIRED" />;
      break;
    case "ACTIVATED":
      content = <ActivationNotice state="ALREADY_ACTIVATED" />;
      break;
    default:
      // PENDING or ACCEPTED (not yet activated): show the form —
      // ACCEPTED is the resume path of an interrupted activation.
      content = (
        <OwnerActivationForm
          token={token}
          email={invitation.email}
          businessName={businessName}
        />
      );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          تفعيل حساب المالك
        </h1>
        <p className="text-muted-foreground text-sm">
          أنشئ كلمة المرور الخاصة بك لتفعيل حسابك وبدء إعداد منشأتك.
        </p>
      </div>
      {content}
    </div>
  );
}
