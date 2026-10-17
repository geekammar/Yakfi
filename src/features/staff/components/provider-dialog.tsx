"use client";

import {
  createProviderAction,
  updateProviderAction,
} from "@/features/staff/actions/team-actions";
import type { ProviderItem, TeamMemberItem } from "@/features/staff/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  AlertCircleIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Loader2Icon,
  ShieldAlertIcon,
  SparklesIcon,
  UserCheckIcon,
} from "lucide-react";
import { useState } from "react";

export function ProviderDialog({
  open,
  onOpenChange,
  mode,
  provider,
  services,
  branches,
  members,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  provider?: ProviderItem | null;
  services: Array<{ id: string; name: string }>;
  branches: Array<{ id: string; name: string }>;
  members: TeamMemberItem[];
  onSaved: (provider: ProviderItem) => void;
}) {
  const [name, setName] = useState(
    mode === "edit" && provider ? provider.name : "",
  );
  const [displayName, setDisplayName] = useState(
    mode === "edit" && provider ? (provider.displayName ?? "") : "",
  );
  const [isActive, setIsActive] = useState(
    mode === "edit" && provider ? provider.isActive : true,
  );
  const [branchId, setBranchId] = useState<string>(
    mode === "edit" && provider
      ? (provider.branchId ?? "")
      : branches.length === 1 && branches[0]
        ? branches[0].id
        : "",
  );
  const [userId, setUserId] = useState<string>(
    mode === "edit" && provider ? (provider.userId ?? "") : "",
  );
  const [excludedServiceIds, setExcludedServiceIds] = useState<string[]>(
    mode === "edit" && provider ? (provider.excludedServiceIds ?? []) : [],
  );
  const [showExclusions, setShowExclusions] = useState(
    mode === "edit" && provider
      ? (provider.excludedServiceIds ?? []).length > 0
      : false,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleServiceExclusion(serviceId: string) {
    setExcludedServiceIds((current) =>
      current.includes(serviceId)
        ? current.filter((id) => id !== serviceId)
        : [...current, serviceId],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("يرجى إدخال اسم مقدم الخدمة");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      if (mode === "create") {
        const result = await createProviderAction({
          name: trimmedName,
          displayName: displayName.trim() || undefined,
          isActive,
          branchId: branchId || undefined,
          userId: userId || undefined,
          excludedServiceIds,
        });

        if (result.success) {
          onSaved(result.provider);
          onOpenChange(false);
        } else {
          setError(result.message);
        }
      } else if (mode === "edit" && provider) {
        const result = await updateProviderAction({
          providerId: provider.id,
          name: trimmedName,
          displayName: displayName.trim() || null,
          isActive,
          branchId: branchId || null,
          excludedServiceIds,
        });

        if (result.success) {
          onSaved(result.provider);
          onOpenChange(false);
        } else {
          setError(result.message);
        }
      }
    } catch {
      setError("حدث خطأ أثناء حفظ مقدم الخدمة. حاول مرة أخرى.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheckIcon className="size-5 text-primary" />
            {mode === "create"
              ? "إضافة مقدم خدمة جديد"
              : "تعديل بيانات مقدم الخدمة"}
          </DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "يمكن إضافة مقدم الخدمة بشكل مستقل دون الحاجة لحساب بريد إلكتروني أو كلمة مرور."
              : "تحديث تفاصيل مقدم الخدمة والأهلية للخدمات."}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" />
            <p>{error}</p>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="provider-name-input">
              اسم مقدم الخدمة <span className="text-destructive">*</span>
            </Label>
            <Input
              id="provider-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: د. أحمد خالد أو سارة المنصور"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="provider-display-input">
              اسم العرض أمام العملاء (اختياري)
            </Label>
            <Input
              id="provider-display-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="مثال: د. أحمد"
            />
            <p className="text-xs text-muted-foreground">
              الاسم الذي سيظهر للعميل في محادثات الواتساب وتفاصيل الحجز.
            </p>
          </div>

          <div className="flex items-center space-x-2 space-x-reverse rounded-lg border p-3">
            <Checkbox
              id="provider-active-toggle"
              checked={isActive}
              onCheckedChange={(checked) => setIsActive(checked === true)}
            />
            <div className="space-y-0.5">
              <Label
                htmlFor="provider-active-toggle"
                className="cursor-pointer font-medium"
              >
                تفعيل استقبال المواعيد
              </Label>
              <p className="text-xs text-muted-foreground">
                عند إلغاء التفعيل، لن يظهر مقدم الخدمة في المواعيد الجديدة.
              </p>
            </div>
          </div>

          {branches.length > 1 ? (
            <div className="space-y-2">
              <Label htmlFor="provider-branch-select">الفرع المخصص</Label>
              <select
                id="provider-branch-select"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="">جميع الفروع (أو الفرع الافتراضي)</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {mode === "create" && members.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="provider-user-select">
                ربط بحساب موظف من المنشأة (اختياري)
              </Label>
              <select
                id="provider-user-select"
                value={userId}
                onChange={(e) => {
                  const val = e.target.value;
                  setUserId(val);
                  if (val && !name) {
                    const found = members.find((m) => m.id === val);
                    if (found) setName(found.name);
                  }
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <option value="">مقدم خدمة مستقل (بدون حساب تسجيل دخول)</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.email})
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                يمكن لمقدم الخدمة تقديم الخدمات دون امتلاك حساب دخول للمنصة.
              </p>
            </div>
          ) : null}

          {/* Service coverage policy (Decision B: Default ALL_SERVICES with explicit exclusions) */}
          <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-start gap-2">
              <SparklesIcon className="size-4 shrink-0 text-primary mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">سياسة الخدمات التلقائية</p>
                <p className="text-xs text-muted-foreground">
                  مقدم الخدمة مؤهل تلقائياً لجميع الخدمات الحالية وأي خدمات
                  جديدة تُضاف لاحقاً.
                </p>
              </div>
            </div>

            {services.length > 0 ? (
              <div className="border-t pt-2">
                <button
                  type="button"
                  onClick={() => setShowExclusions((prev) => !prev)}
                  className="flex w-full items-center justify-between text-xs font-medium text-primary hover:underline"
                >
                  <span className="flex items-center gap-1.5">
                    <ShieldAlertIcon className="size-3.5" />
                    استثناء خدمات معينة ({excludedServiceIds.length} مستثناة)
                  </span>
                  {showExclusions ? (
                    <ChevronUpIcon className="size-4" />
                  ) : (
                    <ChevronDownIcon className="size-4" />
                  )}
                </button>

                {showExclusions ? (
                  <div className="mt-3 space-y-2 border-t pt-2">
                    <p className="text-xs text-muted-foreground">
                      حدد الخدمات التي <strong>لا يقدمها</strong> هذا الشخص:
                    </p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 max-h-48 overflow-y-auto">
                      {services.map((s) => {
                        const isExcluded = excludedServiceIds.includes(s.id);
                        return (
                          <label
                            key={s.id}
                            className={`flex items-center gap-2 rounded-md border p-2 text-xs cursor-pointer transition-colors ${
                              isExcluded
                                ? "border-destructive/40 bg-destructive/5 text-destructive"
                                : "hover:bg-muted"
                            }`}
                          >
                            <Checkbox
                              checked={isExcluded}
                              onCheckedChange={() =>
                                toggleServiceExclusion(s.id)
                              }
                            />
                            <span className="truncate">{s.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              إلغاء
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? (
                <>
                  <Loader2Icon className="size-4 animate-spin" />
                  جاري الحفظ...
                </>
              ) : mode === "create" ? (
                "إضافة مقدم الخدمة"
              ) : (
                "حفظ التعديلات"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
