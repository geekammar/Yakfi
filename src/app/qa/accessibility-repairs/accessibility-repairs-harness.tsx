"use client";

import { AppointmentAgenda } from "@/features/appointments/components/appointment-agenda";
import type { AppointmentAgendaItem } from "@/features/appointments/types";
import { CustomersDirectory } from "@/features/customers/components/customers-directory";
import type { CustomerListItem } from "@/features/customers/types";
import { WorkingHoursForm } from "@/features/onboarding/components/working-hours-form";
import type { WorkingHoursStepInput } from "@/features/onboarding/schemas/onboarding-schema";
import { TeamScreen } from "@/features/staff/components/team-screen";
import type { TeamMemberItem } from "@/features/staff/types";
import { StatusBadge } from "@/components/shared/status-badge";
import { YakfiBrandText } from "@/components/shared/yakfi-brand-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

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

const FIXTURE_CUSTOMERS: CustomerListItem[] = [
  {
    id: "cust-qa-1",
    name: "سارة عبد الله أحمد",
    phone: "+201012345678",
    lastConversationAt: "2026-10-28T14:30:00.000Z",
    lastAppointmentAt: "2026-10-29T10:00:00.000Z",
  },
];

export function AccessibilityRepairsHarness() {
  const [activeTab, setActiveTab] = useState<
    | "dialogs"
    | "working-hours"
    | "team"
    | "appointments"
    | "wave-b"
    | "interactions"
  >("dialogs");

  const [customerDirectoryMode, setCustomerDirectoryMode] = useState<
    "populated" | "empty"
  >("populated");

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
          <Button
            variant={activeTab === "wave-b" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("wave-b")}
            data-testid="tab-wave-b"
          >
            5. Yakfi Wave B
          </Button>
          <Button
            variant={activeTab === "interactions" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("interactions")}
            data-testid="tab-interactions"
          >
            6. Readable Interactions
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
                      className="flex items-center gap-2 text-base min-w-0"
                    >
                      <SparklesIcon
                        data-testid="dialog-rtl-icon"
                        className="size-5 text-primary shrink-0"
                      />
                      <span className="truncate min-w-0">
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

          {/* ─── Real CustomersDirectory → CustomerFormDialog Composition ─── */}
          <div
            className="border-t pt-6 space-y-4"
            data-testid="section-customers-composition"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold">
                  تركيبة دليل العملاء الحقيقية (CustomersDirectory →
                  CustomerFormDialog)
                </h2>
                <p className="text-xs text-muted-foreground">
                  التحقق من استعادة التركيز لعنصر الفتح الحقيقي (الزر الرئيسي
                  وحالات الدليل الفارغ).
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant={
                    customerDirectoryMode === "populated"
                      ? "default"
                      : "outline"
                  }
                  size="sm"
                  onClick={() => setCustomerDirectoryMode("populated")}
                  data-testid="toggle-customers-populated"
                >
                  قائمة تحتوي عملاء
                </Button>
                <Button
                  variant={
                    customerDirectoryMode === "empty" ? "default" : "outline"
                  }
                  size="sm"
                  onClick={() => setCustomerDirectoryMode("empty")}
                  data-testid="toggle-customers-empty"
                >
                  حالة فارغة
                </Button>
              </div>
            </div>
            <CustomersDirectory
              key={customerDirectoryMode}
              queryKeyPrefix={`qa-customers-${customerDirectoryMode}`}
              initialCustomers={
                customerDirectoryMode === "populated" ? FIXTURE_CUSTOMERS : []
              }
            />
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
            workingHours={INITIAL_WORKING_HOURS.workingHours}
            slotDurationMinutes={30}
          />
        </div>
      )}

      {/* ─── 5. Yakfi Wave B Tokens & Real Components Section ─── */}
      {activeTab === "wave-b" && (
        <div className="space-y-6" data-testid="section-wave-b">
          <div
            className="bg-card shadow-sm rounded-xl border p-6 space-y-6"
            data-testid="wave-b-card"
          >
            <div className="space-y-2">
              <h2
                className="text-xl font-bold tracking-tight text-foreground"
                data-testid="wave-b-heading"
              >
                هوية يكفي ورموز التصميم المرئي
              </h2>
              <p className="text-muted-foreground text-sm">
                مكونات حقيقية لاختبار الخطوط، الألوان، التباين، والحالات
                التفاعلية.
              </p>
            </div>

            {/* Real YakfiBrandText instances (Arabic & English) */}
            <div className="flex flex-wrap items-center gap-6 p-4 rounded-lg border bg-background">
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground block">
                  العلامة بالعربية:
                </span>
                <div data-testid="qa-brand-text-ar">
                  <YakfiBrandText lang="ar" className="text-2xl" />
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground block">
                  العلامة بالإنجليزية:
                </span>
                <div data-testid="qa-brand-text-en">
                  <YakfiBrandText lang="en" className="text-2xl" />
                </div>
              </div>
            </div>

            {/* Real Warning StatusBadge on Card Surface */}
            <div
              className="p-4 rounded-lg border bg-card"
              data-testid="qa-status-badge-container"
            >
              <span className="text-xs text-muted-foreground block mb-2">
                شارة الحالة التحذيرية:
              </span>
              <StatusBadge status="warning" data-testid="qa-warning-badge" />
            </div>

            {/* Real Shared Controls for Interactive States */}
            <div className="space-y-4 p-4 rounded-lg border bg-background">
              <h3 className="text-sm font-semibold text-foreground">
                الحالات التفاعلية للتحكم المشترك
              </h3>
              <div className="flex flex-wrap items-center gap-4">
                <Button type="button" data-testid="qa-interactive-button">
                  زر تفاعلي أساسي
                </Button>
                <Button type="button" disabled data-testid="qa-disabled-button">
                  زر معطل
                </Button>
              </div>

              <form
                onSubmit={(e) => e.preventDefault()}
                className="space-y-3 max-w-sm"
              >
                <div>
                  <label
                    htmlFor="qa-interactive-input"
                    className="text-xs text-muted-foreground block mb-1"
                  >
                    حقل إدخال تفاعلي:
                  </label>
                  <Input
                    id="qa-interactive-input"
                    data-testid="qa-interactive-input"
                    placeholder="اكتب هنا..."
                  />
                </div>
                <div>
                  <label
                    htmlFor="qa-invalid-input"
                    className="text-xs text-muted-foreground block mb-1"
                  >
                    حقل إدخال به خطأ:
                  </label>
                  <Input
                    id="qa-invalid-input"
                    data-testid="qa-invalid-input"
                    aria-invalid="true"
                    placeholder="قيمة غير صالحة"
                    defaultValue="قيمة خاطئة"
                  />
                  <p
                    className="text-xs text-destructive mt-1"
                    data-testid="qa-input-error-msg"
                  >
                    يرجى إدخال قيمة صحيحة
                  </p>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* ─── 6. Readable Interactions Section ─── */}
      {activeTab === "interactions" && (
        <div className="space-y-6" data-testid="section-interactions" dir="rtl">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              سجل تفاعلات الأزرار القابلة للقراءة (Interaction History)
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              عرض الاختيارات المؤكدة كنصوص واضحة وإخفاء رمز البروتوكول داخل
              تفاصيل قابلة للطي.
            </p>
          </div>

          <div className="space-y-4 max-w-md p-4 rounded-xl border bg-card/50">
            {/* 1. Confirmed button selection */}
            <div
              className="rounded-e-xl rounded-es-xl bg-card p-3.5 shadow-xs border"
              data-testid="qa-interaction-item-confirmed"
            >
              <div className="flex items-center gap-2 text-[11px] opacity-70 mb-1">
                <span>العميل</span>
                <time dateTime="2026-10-30T10:00:00.000Z">10:00 ص</time>
              </div>
              <div
                className="space-y-1.5"
                data-testid="qa-interaction-display-box"
              >
                <p
                  className="whitespace-pre-wrap text-sm font-medium leading-7 text-foreground"
                  data-testid="qa-interaction-display-text"
                >
                  اختيار موعد: 10:00 ص
                </p>
                <details
                  className="text-[11px] opacity-75 cursor-pointer"
                  data-testid="qa-interaction-details"
                >
                  <summary
                    className="hover:underline select-none"
                    data-testid="qa-interaction-summary"
                    tabIndex={0}
                  >
                    عرض التفاصيل التقنية
                  </summary>
                  <span
                    className="mt-1 block font-mono text-[10px] break-all rounded bg-muted/60 p-1.5 text-muted-foreground"
                    data-testid="qa-interaction-raw-token"
                  >
                    fp:tok123:1
                  </span>
                </details>
              </div>
            </div>

            {/* 2. Historical fallback message without snapshot */}
            <div
              className="rounded-e-xl rounded-es-xl bg-card p-3.5 shadow-xs border"
              data-testid="qa-interaction-item-historical"
            >
              <div className="flex items-center gap-2 text-[11px] opacity-70 mb-1">
                <span>العميل</span>
                <time dateTime="2026-10-28T09:00:00.000Z">09:00 ص</time>
              </div>
              <div className="space-y-1.5">
                <p
                  className="whitespace-pre-wrap text-sm font-medium leading-7 text-muted-foreground"
                  data-testid="qa-interaction-historical-text"
                >
                  محتوى تقني محفوظ؛ تفاصيل الاختيار غير متاحة
                </p>
                <details
                  className="text-[11px] opacity-75 cursor-pointer"
                  data-testid="qa-interaction-historical-details"
                >
                  <summary
                    className="hover:underline select-none"
                    data-testid="qa-interaction-historical-summary"
                    tabIndex={0}
                  >
                    عرض التفاصيل التقنية
                  </summary>
                  <span
                    className="mt-1 block font-mono text-[10px] break-all rounded bg-muted/60 p-1.5 text-muted-foreground"
                    data-testid="qa-interaction-historical-raw-token"
                  >
                    fp:de392742:3
                  </span>
                </details>
              </div>
            </div>

            {/* 3. Plain ordinary customer text */}
            <div
              className="rounded-e-xl rounded-es-xl bg-card p-3.5 shadow-xs border"
              data-testid="qa-plain-message-item"
            >
              <div className="flex items-center gap-2 text-[11px] opacity-70 mb-1">
                <span>العميل</span>
                <time dateTime="2026-10-30T10:05:00.000Z">10:05 ص</time>
              </div>
              <p
                className="whitespace-pre-wrap text-sm leading-7 text-foreground"
                data-testid="qa-plain-message-text"
              >
                السلام عليكم، أريد الاستفسار عن كشف الأسنان
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
