import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { getSession, isPlatformOperator } from "@/server/auth/guards";

import { UserRoundPlusIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "إنشاء حساب",
};

export default async function SignUpPage() {
  const session = await getSession();

  if (session) {
    if (!session.user.isActive) {
      redirect("/access-denied");
    }
    if (isPlatformOperator(session.user)) {
      redirect("/platform");
    }
    redirect("/");
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">إنشاء حساب</h1>
        <p className="text-muted-foreground text-sm">
          ابدأ في دقائق. لا حاجة لبطاقة بنكية.
        </p>
      </div>
      <EmptyState
        className="border-dashed"
        icon={UserRoundPlusIcon}
        title="نموذج التسجيل قيد الإعداد"
        description="سيتوفر إنشاء الحساب ذاتياً قريباً. لحين ذلك، تُنشئ الحسابات من داخل المنشأة عبر إدارة الفريق."
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/sign-in">العودة إلى تسجيل الدخول</Link>
          </Button>
        }
      />
    </div>
  );
}
