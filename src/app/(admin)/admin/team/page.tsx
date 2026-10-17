import { StaffInviteDialog } from "@/features/invitations/components/staff-invite-dialog";
import { listInvitations } from "@/features/invitations/server/invitation-service";
import { TeamScreen } from "@/features/staff/components/team-screen";
import {
  defaultTeamServiceDeps,
  listProviders,
  listTeam,
  type TeamActor,
} from "@/features/staff/server/team-service";
import type { TeamInvitationItem } from "@/features/staff/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { requireRole } from "@/server/auth/guards";
import { branchRepository, serviceRepository } from "@/server/repositories";

import { CircleAlertIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "إدارة الفريق ومقدمي الخدمة",
};

/**
 * Team and provider management (STAFF-PROVIDER-01) — ADMIN-only.
 * The route composes:
 * 1. Staff directory & invitations
 * 2. Independent service provider management
 */
export default async function TeamPage() {
  const session = await requireRole("ADMIN");
  if (!session.user.businessId) redirect("/onboarding");
  const businessId: string = session.user.businessId;

  const actor: TeamActor = {
    userId: session.user.id,
    role: "ADMIN",
    businessId,
  };

  const [memberResult, invitationResult, providerResult, services, branches] =
    await Promise.all([
      listTeam(defaultTeamServiceDeps, actor),
      listInvitations({ businessId }),
      listProviders(defaultTeamServiceDeps, actor),
      serviceRepository.listByBusiness(businessId, {
        includeInactive: false,
      }),
      branchRepository.listByBusiness(businessId),
    ]);

  if (
    !memberResult.success ||
    !invitationResult.success ||
    !providerResult.success
  ) {
    // Honest failure state — never an empty list pretending success.
    return (
      <div className="animate-fade-in-up space-y-6">
        <PageHeader
          title="إدارة الفريق ومقدمي الخدمة"
          description="فريق منشأتك ومقدمو الخدمات وإعداداتهم."
        />

        <EmptyState
          className="bg-card min-h-72"
          icon={CircleAlertIcon}
          title="تعذر تحميل الفريق"
          description="حدث خطأ أثناء تحميل بيانات الفريق. حاول مرة أخرى."
          action={
            <Link
              href="/admin/team"
              prefetch={false}
              className="text-primary text-sm underline-offset-4 hover:underline"
            >
              إعادة المحاولة
            </Link>
          }
        />
      </div>
    );
  }

  // Only operationally relevant invitation states are displayed:
  // PENDING (waiting for the invitee) and ACCEPTED (interrupted
  // activation). Activated invitees appear as team members; revoked
  // and expired invitations are inert.
  const invitations: TeamInvitationItem[] = invitationResult.data.items.flatMap(
    (invitation) =>
      invitation.status === "PENDING" || invitation.status === "ACCEPTED"
        ? [
            {
              id: invitation.id,
              email: invitation.email,
              role: invitation.role,
              status: invitation.status,
              createdAt: invitation.createdAt.toISOString(),
              expiresAt: invitation.expiresAt.toISOString(),
            },
          ]
        : [],
  );

  return (
    <TeamScreen
      members={memberResult.members}
      invitations={invitations}
      providers={providerResult.providers}
      services={services.map((s) => ({ id: s.id, name: s.name }))}
      branches={branches.map((b) => ({ id: b.id, name: b.name }))}
      currentUserId={session.user.id}
      InviteDialog={StaffInviteDialog}
    />
  );
}
