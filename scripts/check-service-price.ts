/**
 * FlowPilot — SERVICE PRICE check (PROMPT-AI-ARCH-13 — Slice 6).
 *
 * Offline, in-memory verification (no DB, no network, no LLM, no secrets) of
 * the Service pricing foundation + task-gated price exposure + the
 * missing-price disclosure behavior:
 *
 *   STORAGE / VALIDATION
 *     - price is OPTIONAL (a service with no price is valid);
 *     - duration stays REQUIRED (price never makes a service bookable);
 *     - FIXED / RANGE / STARTING_FROM / CONDITIONAL validate; invalid combos
 *       are rejected; normalization zeroes stale columns;
 *     - the deterministic formatter renders each shape, and NEVER a number
 *       for CONDITIONAL (no fabricated amount).
 *   KNOWLEDGE VISIBILITY (real context builder)
 *     - price is CONDITIONAL and exposed ONLY on a price-relevant turn;
 *     - price is NOT exposed on a booking-only turn (not globally exposed);
 *     - a missing price is never fabricated into context.
 *   DISCLOSURE (real gate)
 *     - a price question (FAQ reply) is backed by the task-gated service-price
 *       channel even with an EMPTY FAQ store;
 *     - a price question with NO stored price is refused (→ human), never
 *       invented;
 *     - price present but NOT task-relevant is not disclosable;
 *     - the existing FAQ-store backing is unchanged (additive).
 *   ARCHITECTURE GUARDS
 *     - price is a SERVICE_CATALOG fact, never duplicated into the FAQ store;
 *     - no billing / entitlement / plan vocabulary in the price module.
 *
 * Run: pnpm check:service-price
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  buildAiContext,
  type BuildAiContextInput,
} from "../src/features/conversations/server/ai-context-builder";
import type { AiResponse } from "../src/features/conversations/server/ai-contract";
import { enforceDisclosure } from "../src/features/conversations/server/ai-disclosure";
import { classifyServiceField } from "../src/lib/ai-knowledge-visibility";
import {
  formatServicePrice,
  hasServicePrice,
  toServicePriceColumns,
} from "../src/lib/service-price";
import { serviceValidation } from "../src/lib/validation";

export {};

type Check = { label: string; pass: boolean };
const checks: Check[] = [];
function check(label: string, pass: boolean): void {
  checks.push({ label, pass });
}

const TENANT = "biz-aaaaaaaaaaaaaaaaaaaa";
const UUID = "11111111-1111-4111-8111-111111111111";

type Sources = BuildAiContextInput["sources"];

type PriceCols = {
  priceType?: string | null;
  priceAmount?: number | null;
  priceMaxAmount?: number | null;
  priceCurrency?: string | null;
  priceNote?: string | null;
};

function sources(message: string, price: PriceCols, faqs: unknown[]): Sources {
  return {
    business: {
      businessId: TENANT,
      name: "عيادة الأمل",
      faqs,
    },
    services: [
      {
        id: "svc-1",
        businessId: TENANT,
        name: "تنظيف الأسنان",
        durationMinutes: 30,
        ...price,
      },
    ],
    conversation: { status: "AI_ACTIVE", recentMessages: [] },
    message,
  };
}

function faqReply(): AiResponse {
  return {
    intent: "FAQ",
    action: "reply",
    content: "سعر التنظيف ٣٠٠ جنيه.",
    extraction: {
      service: null,
      provider: null,
      date: null,
      timePreference: null,
    },
    handoffReason: null,
    summary: null,
  };
}

const PRICE_Q = "التنظيف بكام؟";
const BOOKING_ONLY = "عايز أحجز بكرة";
const FIXED: PriceCols = {
  priceType: "FIXED",
  priceAmount: 300,
  priceCurrency: "EGP",
};

function main(): void {
  // ── STORAGE / VALIDATION ─────────────────────────────────────────────────

  const base = { businessId: UUID, name: "تنظيف", durationMinutes: 30 };

  check(
    "التخزين: خدمة بدون سعر صالحة (السعر اختياري)",
    serviceValidation.create.safeParse(base).success,
  );

  check(
    "التخزين: المدة مطلوبة للحجز (خدمة بلا مدة مرفوضة)",
    !serviceValidation.create.safeParse({ businessId: UUID, name: "تنظيف" })
      .success,
  );

  check(
    "التخزين: السعر الثابت يتحقق (مبلغ + عملة)",
    serviceValidation.create.safeParse({
      ...base,
      priceType: "FIXED",
      priceAmount: 300,
      priceCurrency: "EGP",
    }).success,
  );

  check(
    "التخزين: السعر الثابت بدون مبلغ مرفوض",
    !serviceValidation.create.safeParse({
      ...base,
      priceType: "FIXED",
      priceCurrency: "EGP",
    }).success,
  );

  check(
    "التخزين: السعر الثابت بدون عملة مرفوض",
    !serviceValidation.create.safeParse({
      ...base,
      priceType: "FIXED",
      priceAmount: 300,
    }).success,
  );

  check(
    "التخزين: النطاق يتحقق (من/إلى + عملة)",
    serviceValidation.create.safeParse({
      ...base,
      priceType: "RANGE",
      priceAmount: 300,
      priceMaxAmount: 500,
      priceCurrency: "EGP",
    }).success,
  );

  check(
    "التخزين: نطاق بحد أعلى أقل من الأدنى مرفوض",
    !serviceValidation.create.safeParse({
      ...base,
      priceType: "RANGE",
      priceAmount: 500,
      priceMaxAmount: 300,
      priceCurrency: "EGP",
    }).success,
  );

  check(
    "التخزين: يبدأ من يتحقق",
    serviceValidation.create.safeParse({
      ...base,
      priceType: "STARTING_FROM",
      priceAmount: 300,
      priceCurrency: "EGP",
    }).success,
  );

  check(
    "التخزين: حسب الحالة يتحقق (ملاحظة، بلا مبلغ)",
    serviceValidation.create.safeParse({
      ...base,
      priceType: "CONDITIONAL",
      priceNote: "حسب الحالة",
    }).success,
  );

  check(
    "التخزين: حسب الحالة مع مبلغ مرفوض",
    !serviceValidation.create.safeParse({
      ...base,
      priceType: "CONDITIONAL",
      priceAmount: 300,
      priceCurrency: "EGP",
    }).success,
  );

  check(
    "التخزين: مبلغ بدون نوع سعر مرفوض",
    !serviceValidation.create.safeParse({
      ...base,
      priceAmount: 300,
      priceCurrency: "EGP",
    }).success,
  );

  // Normalization: clearing / dropping stale columns.
  const clearedCols = toServicePriceColumns({ priceType: null });
  check(
    "التطبيع: نوع فارغ يصفّر كل أعمدة السعر",
    clearedCols.priceType === null &&
      clearedCols.priceAmount === null &&
      clearedCols.priceMaxAmount === null &&
      clearedCols.priceCurrency === null &&
      clearedCols.priceNote === null,
  );
  const fixedCols = toServicePriceColumns({
    priceType: "FIXED",
    priceAmount: 300,
    priceMaxAmount: 999,
    priceCurrency: "EGP",
  });
  check(
    "التطبيع: السعر الثابت يُسقط الحد الأعلى الدخيل",
    fixedCols.priceMaxAmount === null && fixedCols.priceAmount === 300,
  );

  // Formatter.
  check(
    "الصياغة: ثابت = «300 جنيه»",
    formatServicePrice({
      priceType: "FIXED",
      priceAmount: 300,
      priceMaxAmount: null,
      priceCurrency: "EGP",
      priceNote: null,
    }) === "300 جنيه",
  );
  check(
    "الصياغة: نطاق = «من 300 إلى 500 جنيه»",
    formatServicePrice({
      priceType: "RANGE",
      priceAmount: 300,
      priceMaxAmount: 500,
      priceCurrency: "EGP",
      priceNote: null,
    }) === "من 300 إلى 500 جنيه",
  );
  check(
    "الصياغة: يبدأ من = «يبدأ من 300 جنيه»",
    formatServicePrice({
      priceType: "STARTING_FROM",
      priceAmount: 300,
      priceMaxAmount: null,
      priceCurrency: "EGP",
      priceNote: null,
    }) === "يبدأ من 300 جنيه",
  );
  const conditional = formatServicePrice({
    priceType: "CONDITIONAL",
    priceAmount: null,
    priceMaxAmount: null,
    priceCurrency: null,
    priceNote: "حسب الحالة",
  });
  check(
    "الصياغة: حسب الحالة = الملاحظة النصية ولا رقم مُختلق",
    conditional === "حسب الحالة" && !/\d/.test(conditional ?? ""),
  );
  check(
    "الصياغة: بلا سعر = null (لا اختراع)",
    formatServicePrice({
      priceType: null,
      priceAmount: null,
      priceMaxAmount: null,
      priceCurrency: null,
      priceNote: null,
    }) === null &&
      !hasServicePrice({
        priceType: null,
        priceAmount: null,
        priceMaxAmount: null,
        priceCurrency: null,
        priceNote: null,
      }),
  );

  // ── KNOWLEDGE VISIBILITY (real context builder) ──────────────────────────

  const priceTurn = buildAiContext({
    scope: { businessId: TENANT },
    sources: sources(PRICE_Q, FIXED, []),
  });
  const priceService = priceTurn.request.services[0];
  check(
    "الظهور: السعر يظهر في طلب الذكاء عند السؤال عن السعر",
    priceService?.price === "300 جنيه",
  );
  const priceFamily = priceTurn.facts.find((f) => f.key === "service.price");
  check(
    "الظهور: عائلة service.price مُدرجة وقابلة للإفصاح عند الصلة",
    Boolean(priceFamily?.included && priceFamily?.disclosable),
  );

  const bookingTurn = buildAiContext({
    scope: { businessId: TENANT },
    sources: sources(BOOKING_ONLY, FIXED, []),
  });
  check(
    "الظهور: السعر لا يظهر في طلب حجز فقط (غير معروض دائماً)",
    bookingTurn.request.services[0]?.price === undefined,
  );
  const bookingPriceFamily = bookingTurn.facts.find(
    (f) => f.key === "service.price",
  );
  check(
    "الظهور: عائلة service.price غير مُدرجة في طلب الحجز فقط",
    bookingPriceFamily != null && bookingPriceFamily.included === false,
  );

  const missingPriceTurn = buildAiContext({
    scope: { businessId: TENANT },
    sources: sources(PRICE_Q, { priceType: null }, []),
  });
  check(
    "الظهور: السعر المفقود لا يُختلق في السياق",
    missingPriceTurn.request.services[0]?.price === undefined,
  );

  // ── DISCLOSURE (real gate) ───────────────────────────────────────────────

  const priceDisclosure = enforceDisclosure({
    response: faqReply(),
    context: { request: priceTurn.request, facts: priceTurn.facts },
  });
  check(
    "الإفصاح: سؤال السعر + سعر مُخزّن = مُفصح (مدعوم بقناة الخدمة، مخزن أسئلة فارغ)",
    priceDisclosure.kind === "disclosed",
  );

  const missingDisclosure = enforceDisclosure({
    response: faqReply(),
    context: {
      request: missingPriceTurn.request,
      facts: missingPriceTurn.facts,
    },
  });
  check(
    "الإفصاح: سؤال السعر + لا سعر = تحويل لبشري (لا اختراع)",
    missingDisclosure.kind === "requires-human",
  );

  const notRelevantDisclosure = enforceDisclosure({
    response: faqReply(),
    context: { request: bookingTurn.request, facts: bookingTurn.facts },
  });
  check(
    "الإفصاح: سعر موجود لكن غير مطلوب هذا الدور = غير قابل للإفصاح",
    notRelevantDisclosure.kind === "requires-human",
  );

  // Existing FAQ-store backing stays unchanged (additive): a FAQ reply backed
  // by a real FAQ entry is still disclosed, independent of price.
  const faqOnlyTurn = buildAiContext({
    scope: { businessId: TENANT },
    sources: sources("ما هي مواعيد العمل؟", { priceType: null }, [
      { question: "ما هي مواعيد العمل؟", answer: "من السبت للخميس." },
    ]),
  });
  const faqOnlyDisclosure = enforceDisclosure({
    response: {
      ...faqReply(),
      content: "نعمل من السبت إلى الخميس.",
    },
    context: { request: faqOnlyTurn.request, facts: faqOnlyTurn.facts },
  });
  check(
    "الإفصاح: دعم مخزن الأسئلة القائم لم يتغير (إضافي فقط)",
    faqOnlyDisclosure.kind === "disclosed",
  );

  // ── ARCHITECTURE GUARDS ──────────────────────────────────────────────────

  check(
    "الحارس: السعر مصنّف CONDITIONAL على كتالوج الخدمات",
    classifyServiceField("price") === "CONDITIONAL",
  );

  // Price lives on the Service catalog, NEVER duplicated into the FAQ store.
  const faqSuggestionsPath = path.join(
    process.cwd(),
    "src/features/knowledge/suggestions/faq-suggestions.ts",
  );
  if (fs.existsSync(faqSuggestionsPath)) {
    const faqSrc = fs.readFileSync(faqSuggestionsPath, "utf8");
    check(
      "الحارس: مولّد الأسئلة لا يكتب السعر إلى مخزن الأسئلة",
      !/priceType|priceAmount|service-price/.test(faqSrc),
    );
  } else {
    check(
      "الحارس: مولّد الأسئلة لا يكتب السعر (الملف غير موجود — متجاوز)",
      true,
    );
  }

  // No billing / entitlement / plan vocabulary in the price module's CODE
  // (the doc comment legitimately names them to say the module does NOT do
  // them — strip comments before scanning).
  const priceModule = fs
    .readFileSync(path.join(process.cwd(), "src/lib/service-price.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  check(
    "الحارس: كود وحدة السعر خالٍ من الفوترة/الاشتراكات/الاستحقاقات",
    !/\b(billing|invoice|subscription|entitlement|coupon|discount)\b/i.test(
      priceModule,
    ),
  );

  // ── Report ─────────────────────────────────────────────────────────────
  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nأساس تسعير الخدمات صحيح: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main();
