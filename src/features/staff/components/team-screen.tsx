"use client";

import {
  setProviderActiveAction,
  setTeamMemberActiveAction,
} from "@/features/staff/actions/team-actions";
import { ProviderDialog } from "@/features/staff/components/provider-dialog";
import type {
  ProviderItem,
  StaffInviteDialogComponent,
  TeamInvitationItem,
  TeamMemberItem,
} from "@/features/staff/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { StatusBadge } from "@/components/shared/status-badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MEMBER_NOUNS, PROVIDER_NOUNS, arabicCount } from "@/lib/arabic";

import {
  ChevronRightIcon,
  Edit2Icon,
  MailIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UserCheckIcon,
  UserPlusIcon,
  UserRoundPlusIcon,
  UsersRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const ROLE_LABELS: Record<TeamMemberItem["role"], string> = {
  ADMIN: "مدير",
  STAFF: "موظف",
};

function initials(name: string) {
  return name.trim().slice(0, 2);
}

function formatInvitationDate(iso: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

/**
 * Unified Team & Provider Management Screen (STAFF-PROVIDER-01).
 *
 * Provides a mobile-first, consolidated interface for:
 * 1. Independent Service Providers (creation without auth, ALL_SERVICES policy, exclusions)
 * 2. Team Members & Roles (Admin, Staff)
 * 3. Open Team Invitations
 */
export function TeamScreen({
  members: initialMembers,
  invitations: initialInvitations,
  providers: initialProviders = [],
  services = [],
  branches = [],
  currentUserId,
  InviteDialog,
}: {
  members: TeamMemberItem[];
  invitations: TeamInvitationItem[];
  providers?: ProviderItem[];
  services?: Array<{ id: string; name: string }>;
  branches?: Array<{ id: string; name: string }>;
  currentUserId: string;
  InviteDialog: StaffInviteDialogComponent;
}) {
  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [providers, setProviders] = useState(initialProviders);

  // Invitation dialog state
  const [inviteOpen, setInviteOpen] = useState(false);
  const [dialogSession, setDialogSession] = useState(0);

  // Provider dialog state
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [providerDialogMode, setProviderDialogMode] = useState<
    "create" | "edit"
  >("create");
  const [editingProvider, setEditingProvider] = useState<ProviderItem | null>(
    null,
  );

  const [error, setError] = useState<string | null>(null);
  const [pendingMemberToggleId, setPendingMemberToggleId] = useState<
    string | null
  >(null);
  const [pendingProviderToggleId, setPendingProviderToggleId] = useState<
    string | null
  >(null);

  function openInvite() {
    setError(null);
    setDialogSession((count) => count + 1);
    setInviteOpen(true);
  }

  function openCreateProvider() {
    setError(null);
    setEditingProvider(null);
    setProviderDialogMode("create");
    setProviderDialogOpen(true);
  }

  function openEditProvider(provider: ProviderItem) {
    setError(null);
    setEditingProvider(provider);
    setProviderDialogMode("edit");
    setProviderDialogOpen(true);
  }

  function handleProviderSaved(saved: ProviderItem) {
    setProviders((current) => {
      const exists = current.some((p) => p.id === saved.id);
      if (exists) {
        return current.map((p) => (p.id === saved.id ? saved : p));
      }
      return [saved, ...current];
    });
  }

  function handleInvitationCreated(invitation: TeamInvitationItem) {
    setInvitations((current) => [invitation, ...current]);
  }

  function toggleMemberActive(member: TeamMemberItem) {
    const nextActive = !member.isActive;
    setError(null);
    setPendingMemberToggleId(member.id);
    setMembers((current) =>
      current.map((item) =>
        item.id === member.id ? { ...item, isActive: nextActive } : item,
      ),
    );
    void setTeamMemberActiveAction({
      memberId: member.id,
      isActive: nextActive,
    }).then((result) => {
      setPendingMemberToggleId(null);
      if (!result.success) {
        setMembers((current) =>
          current.map((item) =>
            item.id === member.id
              ? { ...item, isActive: member.isActive }
              : item,
          ),
        );
        setError(result.message);
      }
    });
  }

  function toggleProviderActive(provider: ProviderItem) {
    const nextActive = !provider.isActive;
    setError(null);
    setPendingProviderToggleId(provider.id);
    setProviders((current) =>
      current.map((item) =>
        item.id === provider.id ? { ...item, isActive: nextActive } : item,
      ),
    );
    void setProviderActiveAction({
      providerId: provider.id,
      isActive: nextActive,
    }).then((result) => {
      setPendingProviderToggleId(null);
      if (!result.success) {
        setProviders((current) =>
          current.map((item) =>
            item.id === provider.id
              ? { ...item, isActive: provider.isActive }
              : item,
          ),
        );
        setError(result.message);
      }
    });
  }

  return (
    <div className="animate-fade-in-up space-y-8">
      <PageHeader
        title="إدارة الفريق ومقدمي الخدمة"
        description="إدارة مقدمي الخدمات والأهلية للمواعيد، وفريق عمل المنشأة ودعوات الانضمام."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/settings">
                <ChevronRightIcon className="size-4" />
                العودة للإعدادات
              </Link>
            </Button>
            <Button onClick={openCreateProvider}>
              <UserPlusIcon className="size-4" />
              إضافة مقدم خدمة
            </Button>
            <Button variant="outline" onClick={openInvite}>
              <UserRoundPlusIcon className="size-4" />
              دعوة موظف
            </Button>
          </div>
        }
      />

      {error ? (
        <div
          className="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {/* 1. Providers Section */}
      <section className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">مقدمو الخدمة</h2>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {arabicCount(providers.length, PROVIDER_NOUNS)} · مؤهلون لتنفيذ
              الخدمات واستقبال حجوزات العملاء
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={openCreateProvider}
            className="self-start sm:self-auto"
          >
            <UserPlusIcon className="size-3.5" />
            مقدم خدمة جديد
          </Button>
        </div>

        {providers.length === 0 ? (
          <EmptyState
            className="bg-card min-h-52 border"
            icon={UserCheckIcon}
            title="لم يتم إضافة مقدمي خدمة بعد"
            description="أضف مقدم خدمة لتمكين حجز المواعيد. لا يُشترط وجود حساب تسجيل دخول أو بريد إلكتروني لمقدم الخدمة."
            action={
              <Button size="sm" onClick={openCreateProvider}>
                <UserPlusIcon aria-hidden className="size-4" />
                إضافة مقدم خدمة الآن
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {providers.map((p) => {
              const hasExclusions =
                p.excludedServiceNames && p.excludedServiceNames.length > 0;
              return (
                <article
                  key={p.id}
                  className="flex flex-col justify-between rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-3">
                        <Avatar className="size-10 shrink-0">
                          <AvatarFallback className="text-sm font-semibold">
                            {initials(p.displayName || p.name)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <h3 className="truncate font-semibold text-foreground">
                              {p.name}
                            </h3>
                            {p.displayName && p.displayName !== p.name ? (
                              <span className="text-xs text-muted-foreground truncate">
                                ({p.displayName})
                              </span>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                            {p.user ? (
                              <Badge variant="secondary" className="text-xs">
                                مرتبط بـ {p.user.name}
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-xs text-muted-foreground"
                              >
                                مستقل (بدون حساب)
                              </Badge>
                            )}

                            {p.branchName ? (
                              <Badge variant="outline" className="text-xs">
                                {p.branchName}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                      </div>

                      <Badge
                        variant={p.isActive ? "default" : "secondary"}
                        className={
                          p.isActive
                            ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                            : "text-muted-foreground"
                        }
                      >
                        {p.isActive ? "نشط للحجوزات" : "متوقف مؤقتاً"}
                      </Badge>
                    </div>

                    {/* Coverage badge / summary */}
                    <div className="rounded-lg bg-muted/40 p-2 text-xs space-y-1">
                      <div className="flex items-center gap-1 font-medium">
                        {p.servicePolicy === "ALL_SERVICES" ? (
                          <>
                            <SparklesIcon className="size-3.5 text-primary shrink-0" />
                            <span>مؤهل لجميع الخدمات</span>
                          </>
                        ) : (
                          <span>
                            خدمات محددة ({p.includedServiceIds.length})
                          </span>
                        )}
                      </div>

                      {hasExclusions ? (
                        <p className="text-destructive font-normal flex items-start gap-1">
                          <ShieldCheckIcon className="size-3.5 shrink-0 mt-0.5" />
                          <span>
                            مستثنى من: {p.excludedServiceNames.join("، ")}
                          </span>
                        </p>
                      ) : p.servicePolicy === "ALL_SERVICES" ? (
                        <p className="text-muted-foreground text-[11px]">
                          يشمل تلقائياً أي خدمات جديدة تُضاف مستقبلاً.
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-3 border-t mt-3">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => openEditProvider(p)}
                    >
                      <Edit2Icon className="size-3.5" />
                      تعديل
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => toggleProviderActive(p)}
                      disabled={pendingProviderToggleId === p.id}
                    >
                      {p.isActive ? (
                        <>
                          <PauseCircleIcon className="size-3.5" />
                          إيقاف
                        </>
                      ) : (
                        <>
                          <PlayCircleIcon className="size-3.5" />
                          تنشيط
                        </>
                      )}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* 2. Team Members Section */}
      <section className="space-y-4 pt-4 border-t">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">
              أعضاء المنشأة (حسابات الدخول)
            </h2>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {arabicCount(members.length, MEMBER_NOUNS)} · يمتلكون صلاحية
              الدخول للمنصة وإدارة المحادثات
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={openInvite}
            className="self-start sm:self-auto"
          >
            <UserRoundPlusIcon className="size-3.5" />
            دعوة عضو جديد
          </Button>
        </div>

        {members.length === 0 ? (
          <EmptyState
            className="bg-card min-h-44 border"
            icon={UsersRoundIcon}
            title="لم يتم إضافة أعضاء بعد"
            description="يمكنك دعوة أعضاء الفريق عبر البريد الإلكتروني ليشاركونك إدارة المواعيد والمحادثات."
            action={
              <Button size="sm" onClick={openInvite}>
                <UserRoundPlusIcon aria-hidden className="size-4" />
                دعوة عضو
              </Button>
            }
          />
        ) : (
          <ul className="space-y-3">
            {members.map((member) => (
              <li key={member.id}>
                <article className="rounded-xl border bg-card p-4 shadow-xs transition-shadow hover:shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <Avatar className="size-10 shrink-0">
                        <AvatarFallback className="text-sm font-semibold">
                          {initials(member.name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate font-semibold">
                            {member.name}
                          </h3>
                          {member.id === currentUserId ? (
                            <Badge variant="outline">أنت</Badge>
                          ) : null}
                        </div>
                        <p
                          dir="ltr"
                          className="truncate text-start text-sm text-muted-foreground"
                        >
                          {member.email}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <Badge
                            variant={
                              member.role === "ADMIN" ? "default" : "secondary"
                            }
                          >
                            {ROLE_LABELS[member.role]}
                          </Badge>
                          <StatusBadge
                            status={
                              member.isActive
                                ? "member-active"
                                : "member-inactive"
                            }
                          />
                        </div>
                      </div>
                    </div>
                    {member.role === "STAFF" ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => toggleMemberActive(member)}
                          disabled={pendingMemberToggleId === member.id}
                        >
                          {member.isActive ? (
                            <>
                              <PauseCircleIcon className="size-3.5" />
                              إيقاف
                            </>
                          ) : (
                            <>
                              <PlayCircleIcon className="size-3.5" />
                              تنشيط
                            </>
                          )}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 3. Pending Invitations Section */}
      {invitations.length > 0 ? (
        <section className="space-y-3 pt-4 border-t">
          <h2 className="text-sm font-semibold">دعوات معلقة</h2>
          <ul className="divide-y overflow-hidden rounded-xl border bg-card shadow-xs">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex items-center gap-3 px-4 py-3.5"
              >
                <div className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-full">
                  <MailIcon aria-hidden className="size-4" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    dir="ltr"
                    className="truncate text-start text-sm font-medium"
                  >
                    {invitation.email}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {invitation.status === "PENDING"
                      ? "لم يقبل الموظف الدعوة بعد"
                      : "قبِل الموظف الدعوة ولم يُكمل التفعيل بعد"}
                    {" · "}
                    أُرسلت في {formatInvitationDate(invitation.createdAt)}
                  </p>
                </div>
                <StatusBadge
                  status={
                    invitation.status === "PENDING" ? "pending" : "incomplete"
                  }
                />
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            تنتهي صلاحية الدعوات غير المقبولة تلقائياً بعد 7 أيام من إنشائها،
            ويمكن حينها إنشاء دعوة جديدة لنفس البريد.
          </p>
        </section>
      ) : null}

      {/* Provider Add/Edit Dialog */}
      <ProviderDialog
        key={
          providerDialogOpen
            ? (editingProvider?.id ?? `create-${dialogSession}`)
            : "closed"
        }
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        mode={providerDialogMode}
        provider={editingProvider}
        services={services}
        branches={branches}
        members={members}
        onSaved={handleProviderSaved}
      />

      {/* Staff Invite Dialog */}
      <InviteDialog
        key={dialogSession}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={handleInvitationCreated}
      />
    </div>
  );
}
