/**
 * Service price — the ONE canonical, structured, MINIMAL representation of a
 * per-service price (PROMPT-AI-ARCH-13 — Slice 6). This is authoritative
 * DOMAIN data on the Service catalog (the business's price TO ITS CUSTOMERS),
 * NOT FlowPilot billing and NOT the FlowPilot→business SaaS price concept in
 * `ECONOMICS.md` (those stay deferred). It is deliberately NOT a pricing
 * engine: no discounts, coupons, promotions, tax, bundles, dynamic rules,
 * price history, plans, entitlements, or billing. Four shapes cover the real
 * discovery cases:
 *
 *   FIXED         → amount                       (e.g. "300 جنيه")
 *   RANGE         → amount + maxAmount            (e.g. "من 300 إلى 500 جنيه")
 *   STARTING_FROM → amount                        (e.g. "يبدأ من 300 جنيه")
 *   CONDITIONAL   → note (bounded human text)     (e.g. "حسب الحالة")
 *
 * The structured columns live on `Service` (`prisma/schema.prisma`). This
 * module owns: the stable machine-key value sets (validated by Zod unions, no
 * Prisma enum), the structural invariants, and the ONE deterministic
 * formatter that turns the stored columns into the Arabic display string the
 * AI context carries. Pure: no I/O, no LLM, no env, no Prisma. The AI never
 * receives the internal structure — only the formatted string (task-gated by
 * the context builder) — and the server-side Domain stays authoritative for
 * the actual value. A null `priceType` means NO price exists; callers must
 * NEVER invent one.
 */

import { z } from "zod";

/** The four structured price shapes. Stable machine keys (no Prisma enum). */
export const SERVICE_PRICE_TYPE_VALUES = [
  "FIXED",
  "RANGE",
  "STARTING_FROM",
  "CONDITIONAL",
] as const;

export type ServicePriceType = (typeof SERVICE_PRICE_TYPE_VALUES)[number];

/**
 * Supported price currencies — stable ISO-4217 machine keys validated by a
 * Zod union (NO Prisma enum: extending the list needs no migration, the
 * confirmationMode / vertical convention). Arabic-first markets first.
 */
export const SERVICE_PRICE_CURRENCY_VALUES = [
  "EGP",
  "SAR",
  "AED",
  "KWD",
  "QAR",
  "USD",
] as const;

export type ServicePriceCurrency =
  (typeof SERVICE_PRICE_CURRENCY_VALUES)[number];

/** Short Arabic currency labels for the customer-facing display string. */
const CURRENCY_LABEL_AR: Record<string, string> = {
  EGP: "جنيه",
  SAR: "ريال",
  AED: "درهم",
  KWD: "دينار",
  QAR: "ريال",
  USD: "دولار",
};

/** Max whole-currency-unit amount (defensive bound; not a pricing rule). */
export const SERVICE_PRICE_MAX_AMOUNT = 100_000_000;

/** Max length of the CONDITIONAL human-readable note. */
export const SERVICE_PRICE_NOTE_MAX = 160;

/**
 * The structured price COLUMNS exactly as stored on `Service` (all nullable).
 * A null `priceType` means the service has NO authoritative price.
 */
export type ServicePriceFields = {
  priceType: string | null;
  priceAmount: number | null;
  priceMaxAmount: number | null;
  priceCurrency: string | null;
  priceNote: string | null;
};

/** Does this service carry an authoritative price at all? */
export function hasServicePrice(fields: ServicePriceFields): boolean {
  return (
    typeof fields.priceType === "string" &&
    (SERVICE_PRICE_TYPE_VALUES as readonly string[]).includes(fields.priceType)
  );
}

function withCurrency(amount: number, currency: string | null): string {
  if (!currency) return `${amount}`;
  const label = CURRENCY_LABEL_AR[currency] ?? currency;
  return `${amount} ${label}`;
}

/**
 * The ONE deterministic price → display-string formatter. Returns the Arabic
 * representation the AI context carries, or `null` when there is no price (or
 * the stored columns are structurally incomplete — fail closed to "no price",
 * never a fabricated amount). Pure and total.
 */
export function formatServicePrice(fields: ServicePriceFields): string | null {
  if (!hasServicePrice(fields)) return null;
  switch (fields.priceType) {
    case "FIXED":
      return fields.priceAmount != null
        ? withCurrency(fields.priceAmount, fields.priceCurrency)
        : null;
    case "STARTING_FROM":
      return fields.priceAmount != null
        ? `يبدأ من ${withCurrency(fields.priceAmount, fields.priceCurrency)}`
        : null;
    case "RANGE":
      return fields.priceAmount != null && fields.priceMaxAmount != null
        ? `من ${fields.priceAmount} إلى ${withCurrency(
            fields.priceMaxAmount,
            fields.priceCurrency,
          )}`
        : null;
    case "CONDITIONAL": {
      const note = fields.priceNote?.trim();
      return note && note.length > 0 ? note : "حسب الحالة";
    }
    default:
      return null;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────

const priceTypeSchema = z.enum(SERVICE_PRICE_TYPE_VALUES);
const priceCurrencySchema = z.enum(SERVICE_PRICE_CURRENCY_VALUES);
const priceAmountSchema = z
  .number()
  .int("المبلغ يجب أن يكون رقماً صحيحاً")
  .positive("المبلغ يجب أن يكون أكبر من صفر")
  .max(SERVICE_PRICE_MAX_AMOUNT, "المبلغ كبير جداً");

/**
 * The optional structured price fields on a Service create/update DTO. All
 * five columns are flat + nullable so they map 1:1 to the stored row; the
 * structural invariants (which fields each `priceType` requires) are enforced
 * by `refineServicePrice`. A fully-absent price (every field null/undefined)
 * is valid — price is OPTIONAL (low-friction onboarding).
 */
export const servicePriceShape = {
  priceType: priceTypeSchema.nullish(),
  priceAmount: priceAmountSchema.nullish(),
  priceMaxAmount: priceAmountSchema.nullish(),
  priceCurrency: priceCurrencySchema.nullish(),
  priceNote: z.string().trim().max(SERVICE_PRICE_NOTE_MAX).nullish(),
} as const;

type PriceInput = {
  priceType?: ServicePriceType | null;
  priceAmount?: number | null;
  priceMaxAmount?: number | null;
  priceCurrency?: ServicePriceCurrency | null;
  priceNote?: string | null;
};

/**
 * Enforce the structural price invariants on a parsed object (shared by the
 * create and update DTOs via `superRefine`). No price at all is always valid.
 */
export function refineServicePrice(
  value: PriceInput,
  ctx: z.RefinementCtx,
): void {
  const type = value.priceType ?? null;
  const amount = value.priceAmount ?? null;
  const maxAmount = value.priceMaxAmount ?? null;
  const currency = value.priceCurrency ?? null;
  const note = value.priceNote?.trim() ? value.priceNote.trim() : null;

  // No price → every other price field must be empty too.
  if (type === null) {
    if (
      amount !== null ||
      maxAmount !== null ||
      currency !== null ||
      note !== null
    ) {
      ctx.addIssue({
        code: "custom",
        message: "حدد نوع السعر أولاً",
        path: ["priceType"],
      });
    }
    return;
  }

  const amountRequired =
    type === "FIXED" || type === "RANGE" || type === "STARTING_FROM";

  if (amountRequired) {
    if (amount === null) {
      ctx.addIssue({
        code: "custom",
        message: "أدخل مبلغ السعر",
        path: ["priceAmount"],
      });
    }
    if (currency === null) {
      ctx.addIssue({
        code: "custom",
        message: "اختر العملة",
        path: ["priceCurrency"],
      });
    }
  }

  if (type === "RANGE") {
    if (maxAmount === null) {
      ctx.addIssue({
        code: "custom",
        message: "أدخل الحد الأعلى للسعر",
        path: ["priceMaxAmount"],
      });
    } else if (amount !== null && maxAmount < amount) {
      ctx.addIssue({
        code: "custom",
        message: "الحد الأعلى يجب أن يكون أكبر من الحد الأدنى",
        path: ["priceMaxAmount"],
      });
    }
  } else if (maxAmount !== null) {
    // maxAmount only ever applies to RANGE.
    ctx.addIssue({
      code: "custom",
      message: "الحد الأعلى للسعر يُستخدم مع النطاق فقط",
      path: ["priceMaxAmount"],
    });
  }

  if (type === "CONDITIONAL") {
    if (amount !== null || maxAmount !== null || currency !== null) {
      ctx.addIssue({
        code: "custom",
        message: "السعر حسب الحالة لا يحمل مبلغاً",
        path: ["priceAmount"],
      });
    }
  }
}

/**
 * Normalize a parsed price DTO to the exact nullable column values stored on
 * `Service`. Guarantees a consistent row shape: a null `priceType` zeroes
 * every other column, and non-amount types drop stray amounts. Pure.
 */
export function toServicePriceColumns(value: PriceInput): {
  priceType: ServicePriceType | null;
  priceAmount: number | null;
  priceMaxAmount: number | null;
  priceCurrency: ServicePriceCurrency | null;
  priceNote: string | null;
} {
  const type = value.priceType ?? null;
  if (type === null) {
    return {
      priceType: null,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: null,
    };
  }
  const note = value.priceNote?.trim() ? value.priceNote.trim() : null;
  if (type === "CONDITIONAL") {
    return {
      priceType: type,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: note,
    };
  }
  return {
    priceType: type,
    priceAmount: value.priceAmount ?? null,
    priceMaxAmount: type === "RANGE" ? (value.priceMaxAmount ?? null) : null,
    priceCurrency: value.priceCurrency ?? null,
    priceNote: note,
  };
}
