"use client";

import { AppointmentAgenda } from "@/features/appointments/components/appointment-agenda";
import type { AppointmentAgendaItem } from "@/features/appointments/types";
import { WorkingHoursForm } from "@/features/onboarding/components/working-hours-form";
import type { WorkingHoursStepInput } from "@/features/onboarding/schemas/onboarding-schema";
import { TeamScreen } from "@/features/staff/components/team-screen";
import type { TeamMemberItem } from "@/features/staff/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { SparklesIcon } from "lucide-react";
import { useState } from "react";

const INITIAL_WORKING_HOURS: WorkingHoursStepInput = {
  workingHours: {
    sat: { open: "09:00", close: "17:00", closed: false },
    sun: { open: "09:00", close: "17:00", closed: false },
    mon: { open: "09:00", close: "17:00", closed: false },
    tue: { open: "09:00", close: "17:00", closed: false },
    wed: { open: "09:00", close: "17:00", closed: false },
    thu: { open: "09:00", close: "17:00", closed: false },
    fri: { open: "14:00", close: "20:00", closed: true },
  },
};

const ADMIN_MEMBER: TeamMemberItem = {
  id: "user-admin-1",
  name: "أحمد المشرف",
  email: "ahmed@example.com",
  role: "ADMIN",
  isActive: true,
};

const STAFF_MEMBER_1: TeamMemberItem = {
  id: "user-staff-1",
  name: "سارة خالد",
  email: "sara@example.com",
  role: "STAFF",
  isActive: true,
};

const STAFF_MEMBER_2: TeamMemberItem = {
  id: "user-staff-2",
  name: "محمد علي",
  email: "mohammed@example.com",
  role: "STAFF",
  isActive: false,
};

const FIXTURE_APPOINTMENTS: AppointmentAgendaItem[] = [
  {
    id: "apt-1",
    date: "2026-10-28",
    notes: null,
    customer: { id: "cust-1", name: "خالد بن فهد", phone: "+966501112233" },
    service: { id: "srv-1", name: "استشارة طبية أولية", durationMinutes: 30 },
    provider: { id: "prov-1", name: "د. عبدالكريم الصالح" },
    status: "CONFIRMED",
    startTime: "1970-01-01T10:00:00.000Z",
    endTime: "1970-01-01T10:30:00.000Z",
  },
];

export function AccessibilityRepairsHarness() {
  const [activeTab, setActiveTab] = useState<
    "dialogs" | "working-hours" | "team" | "appointments"
  >("dialogs");

  const [teamFixture, setTeamFixture] = useState<"admin" | "mixed" | "empty">(
    "admin",
  );

  const getTeamMembers = (): TeamMemberItem[] => {
    switch (teamFixture) {
      case "admin":
        return [ADMIN_MEMBER];
      case "mixed":
        return [ADMIN_MEMBER, STAFF_MEMBER_1, STAFF_MEMBER_2];
      case "empty":
        return [];
    }
  };

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-8 max-w-4xl">
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold">
          QA Harness — Accessibility & UI Repairs
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Automated verification for Dialogs, Working Hours, Team Members, and
          View Switcher.
        </p>

        {/* Tab selection for test isolation */}
        <div className="flex flex-wrap gap-2 mt-4" role="tablist">
          <Button
            variant={activeTab === "dialogs" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("dialogs")}
            data-testid="tab-dialogs"
          >
            1. Dialogs (RTL / LTR)
          </Button>
          <Button
            variant={activeTab === "working-hours" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("working-hours")}
            data-testid="tab-working-hours"
          >
            2. Working Hours
          </Button>
          <Button
            variant={activeTab === "team" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("team")}
            data-testid="tab-team"
          >
            3. Team Screen
          </Button>
          <Button
            variant={activeTab === "appointments" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("appointments")}
            data-testid="tab-appointments"
          >
            4. Appointment View Switch
          </Button>
        </div>
      </div>

      {/* ─── 1. Dialogs Section ─── */}
      {activeTab === "dialogs" && (
        <div className="space-y-6" data-testid="section-dialogs">
          <div className="flex flex-wrap gap-4">
            {/* RTL Dialog */}
            <div dir="rtl">
              <Dialog>
                <DialogTrigger asChild>
                  <Button data-testid="open-rtl-dialog">
                    فتح نافذة حوار عربية (RTL)
                  </Button>
                </DialogTrigger>
                <DialogContent
                  dir="rtl"
                  data-testid="dialog-rtl-content"
                  className="max-w-md"
                >
                  <DialogHeader data-testid="dialog-rtl-header">
                    <DialogTitle
                      data-testid="dialog-rtl-title"
                      className="flex items-center gap-2 text-base"
                    >
                      <SparklesIcon
                        data-testid="dialog-rtl-icon"
                        className="size-5 text-primary shrink-0"
                      />
                      <span className="truncate">
                        تأكيد تفاصيل الموعد والخدمات الاستشارية الطبية الشاملة
                      </span>
                    </DialogTitle>
                    <DialogDescription>
                      نافذة حوار مخصصة للتحقق من أبعاد زر الإغلاق وعدم التداخل
                      مع العناوين الطويلة.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="py-4">
                    <p className="text-sm">
                      محتوى نافذة الحوار للاختبار التفاعلي.
                    </p>
                    <input
                      type="text"
                      placeholder="حقل تركيز داخل النافذة"
                      className="mt-3 w-full border rounded p-2 text-sm"
                      data-testid="dialog-first-input"
                    />
                  </div>
                </DialogContent>
              </Dialog>
            </div>

            {/* LTR Dialog */}
            <div dir="ltr">
              <Dialog>
                <DialogTrigger asChild>
                  <Button variant="outline" data-testid="open-ltr-dialog">
                    Open LTR Dialog
                  </Button>
                </DialogTrigger>
                <DialogContent
                  dir="ltr"
                  data-testid="dialog-ltr-content"
                  className="max-w-md"
                >
                  <DialogHeader data-testid="dialog-ltr-header">
                    <DialogTitle data-testid="dialog-ltr-title">
                      Comprehensive Medical Service Confirmation Details
                    </DialogTitle>
                    <DialogDescription>
                      Verification of close button positioning on the right side
                      in LTR.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="py-4">
                    <p className="text-sm">
                      Test content for LTR verification.
                    </p>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>
      )}

      {/* ─── 2. Working Hours Section ─── */}
      {activeTab === "working-hours" && (
        <div className="space-y-4" data-testid="section-working-hours">
          <WorkingHoursForm defaultValues={INITIAL_WORKING_HOURS} />
        </div>
      )}

      {/* ─── 3. Team Screen Section ─── */}
      {activeTab === "team" && (
        <div className="space-y-6" data-testid="section-team">
          <div className="flex flex-wrap items-center gap-2 border p-3 rounded-lg bg-card">
            <span className="text-sm font-medium">اختر حالة الفريق:</span>
            <Button
              variant={teamFixture === "admin" ? "default" : "outline"}
              size="sm"
              onClick={() => setTeamFixture("admin")}
              data-testid="fixture-team-admin"
            >
              مدير فقط (Admin Only)
            </Button>
            <Button
              variant={teamFixture === "mixed" ? "default" : "outline"}
              size="sm"
              onClick={() => setTeamFixture("mixed")}
              data-testid="fixture-team-mixed"
            >
              فريق مختلط (Mixed: 1 Admin + 2 Staff)
            </Button>
            <Button
              variant={teamFixture === "empty" ? "default" : "outline"}
              size="sm"
              onClick={() => setTeamFixture("empty")}
              data-testid="fixture-team-empty"
            >
              فريق فارغ (Empty: 0 Members)
            </Button>
          </div>

          <TeamScreen
            key={teamFixture}
            members={getTeamMembers()}
            invitations={[]}
            providers={[]}
            currentUserId={ADMIN_MEMBER.id}
            InviteDialog={() => null}
          />
        </div>
      )}

      {/* ─── 4. Appointment View Switch Section ─── */}
      {activeTab === "appointments" && (
        <div className="space-y-4" data-testid="section-appointments">
          <AppointmentAgenda
            initialItems={FIXTURE_APPOINTMENTS}
            date="2026-10-28"
            today="2026-10-28"
            slotDurationMinutes={30}
          />
        </div>
      )}
    </div>
  );
}
