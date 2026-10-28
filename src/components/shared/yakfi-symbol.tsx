import type { SVGProps } from "react";

export interface YakfiSymbolProps extends SVGProps<SVGSVGElement> {
  variant?: "color" | "white" | "monochrome";
}

/**
 * Approved Yakfi (يكفي) brand symbol.
 * Converging geometric Y stem with a sky-blue accent dot.
 * Canonical geometry: viewBox 0 0 100 100.
 */
export function YakfiSymbol({
  variant = "color",
  className,
  ...props
}: YakfiSymbolProps) {
  const strokeColor =
    variant === "white"
      ? "#FFFFFF"
      : variant === "monochrome"
        ? "currentColor"
        : "#173B63";

  const dotColor = variant === "monochrome" ? "currentColor" : "#64B9CD";

  return (
    <svg
      data-testid="yakfi-symbol"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      {...props}
    >
      <path
        d="M 20 18 L 50 48 L 80 18 M 50 48 V 82"
        stroke={strokeColor}
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="80" cy="18" r="6.8" fill={dotColor} />
    </svg>
  );
}
