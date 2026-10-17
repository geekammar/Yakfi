"use client";

import {
  listAssignableUsersAction,
  setupServiceProviderAction,
} from "@/features/appointments/actions/provider-eligibility-actions";
import { Button } from "@/components/ui/button";
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

import { AlertCircleIcon, Loader2Icon, UserPlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export function ProviderSetupDialog({
  open,
  onOpenChange,
  serviceId,
  serviceName,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceId: string;
  serviceName: string;
  onSuccess: (providerId: string) => void;
}) {
  const [users, setUsers] = useState<
    Array<{ id: string; name: string; email: string }>
  >([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [displayName, setDisplayName] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setError(null);
    }
    onOpenChange(nextOpen);
  }

  useEffect(() => {
    if (!open) return;
    let isMounted = true;
    void Promise.resolve().then(async () => {
      if (!isMounted) return;
      setIsLoading(true);
      const res = await listAssignableUsersAction();
      if (!isMounted) return;
      setIsLoading(false);
      if (res.success) {
        setUsers(res.users);
        if (res.users.length > 0 && res.users[0]) {
          setSelectedUserId(res.users[0].id);
          setDisplayName(res.users[0].name);
        }
      } else {
        setError(res.message);
      }
    });
    return () => {
      isMounted = false;
    };
  }, [open]);

  function handleUserChange(userId: string) {
    setSelectedUserId(userId);
    const chosen = users.find((u) => u.id === userId);
    if (chosen) {
      setDisplayName(chosen.name);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedUserId) {
      setError("يرجى اختيار عضو من الفريق");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await setupServiceProviderAction({
        userId: selectedUserId,
        displayName: displayName.trim() || undefined,
        serviceId,
      });
      if (res.success) {
        onSuccess(res.providerId);
        handleOpenChange(false);
      } else {
        setError(res.message);
      }
    } catch {
      setError("تعذر إعداد مقدم الخدمة الآن. حاول مرة أخرى.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlusIcon className="size-5 text-primary" />
            إعداد مقدم خدمة
          </DialogTitle>
          <DialogDescription>
            اربط عضواً من الفريق بخدمة &laquo;{serviceName}&raquo; لبدء استقبال
            المواعيد.
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircleIcon className="size-4 shrink-0" />
            <p>{error}</p>
          </div>
        ) : null}

        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" />
            <span className="mr-2">جاري تحميل أعضاء الفريق...</span>
          </div>
        ) : users.length === 0 ? (
          <div className="space-y-4 py-4 text-center">
            <p className="text-sm text-muted-foreground">
              لا يوجد أعضاء في الفريق حالياً. يمكنك دعوة عضو جديد لإعداده كمقدم
              خدمة.
            </p>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/team">الانتقال لإدارة الفريق</Link>
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="provider-user-select">عضو الفريق</Label>
              <select
                id="provider-user-select"
                value={selectedUserId}
                onChange={(e) => handleUserChange(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="provider-display-name">
                اسم العرض أمام العملاء (اختياري)
              </Label>
              <Input
                id="provider-display-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="مثال: د. سارة"
              />
              <p className="text-xs text-muted-foreground">
                الاسم الذي سيظهر للعميل في تفاصيل الحجز وتأكيد الموعد.
              </p>
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
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
                ) : (
                  "حفظ وتفعيل الحجز"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
