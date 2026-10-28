import { resolveStatus, type StatusTone, type StatusValue } from "@/lib/status";
import { cn } from "@/lib/utils";

const toneStyles: Record<StatusTone, string> = {
  success:
    "border-success/20 bg-success/10 text-success dark:border-success/30 dark:bg-success/15",
  warning:
    "border-warning/25 bg-warning/10 text-warning-foreground dark:border-warning/30 dark:bg-warning/15 dark:text-warning",
  error:
    "border-error/20 bg-error/10 text-error dark:border-error/30 dark:bg-error/15",
  info: "border-info/20 bg-info/10 text-info dark:border-info/30 dark:bg-info/15",
  neutral: "border-border bg-muted text-muted-foreground",
};

export function StatusBadge({
  status,
  withIcon = true,
  className,
  children,
  ...props
}: {
  status: StatusValue | string;
  withIcon?: boolean;
  className?: string;
  children?: React.ReactNode;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const definition = resolveStatus(status);
  const Icon = definition.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        toneStyles[definition.tone],
        className,
      )}
      {...props}
    >
      {withIcon && <Icon aria-hidden className="size-3" />}
      {children ?? definition.labelAr}
    </span>
  );
}
