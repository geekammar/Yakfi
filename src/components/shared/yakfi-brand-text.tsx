import { APP_NAME, APP_NAME_LATIN } from "@/lib/app-config";
import { cn } from "@/lib/utils";

import type { HTMLAttributes } from "react";

export interface YakfiBrandTextProps extends HTMLAttributes<HTMLSpanElement> {
  lang?: "ar" | "en";
}

/**
 * Renders the Yakfi brand wordmark with approved Wave B typography:
 * - Arabic "يكفي" with Readex Pro 600
 * - Latin "yakfi" with Manrope 600
 * Preserves semantic non-brand text across the app.
 */
export function YakfiBrandText({
  lang = "ar",
  className,
  children,
  ...props
}: YakfiBrandTextProps) {
  const isLatin = lang === "en";
  const defaultText = isLatin ? APP_NAME_LATIN : APP_NAME;
  const fontClass = isLatin ? "font-brand-latin" : "font-brand-arabic";

  return (
    <span
      data-testid="yakfi-brand-text"
      data-brand-lang={lang}
      className={cn(fontClass, "font-semibold tracking-tight", className)}
      {...props}
    >
      {children ?? defaultText}
    </span>
  );
}
