/**
 * Deterministic booking selection parser (PROMPT-AI-03B).
 *
 * Parses a customer's selection of an already-presented booking option
 * (the canonical `formatBookingOptionsMessage` offer). No LLM, no
 * provider/tenant fabrication — pure deterministic text parsing.
 *
 * Supported forms (Arabic-normalized):
 * - offered option index: "1" / "2" / "3" (Arabic-indic ١٢٣, optional
 *   punctuation/"الخيار"/"رقم" prefixes)
 * - HH:mm where uniquely resolvable: "10:00", "١٠:٠٠", "الساعة 10:00"
 * - provider-name candidate where safely resolvable (verified by the
 *   engine against the fresh CORE-01 eligible set)
 *
 * The parser NEVER fabricates ids: it only extracts an index/time/name
 * candidate; the engine re-resolves Business/Branch/Service/Provider
 * server-side and re-validates against fresh CORE-01 + CORE-02 results.
 */
import type {
  BookingOffer,
  SlotOffer,
} from "@/features/conversations/server/booking-offer";
import { isOfferLive } from "@/features/conversations/server/booking-offer";
import { parseOfferCallback } from "@/features/conversations/server/channel-choice";
import type { CanonicalTimePreference } from "@/lib/validation";

/** One option exactly as presented in the canonical offer message. */
export type OfferedBookingOption = {
  index: number;
  displayName: string;
  startTime: string;
  endTime?: string;
  /** CONV-CORE-01 — the real provider id (typed offers only). */
  providerId?: string;
};

export type ChronologicalMessage = {
  senderType: string;
  content: string;
  createdAt?: Date | string | null;
  sentAt?: Date | string | null;
};

export type BookingSelection =
  | { kind: "index"; index: number }
  | { kind: "time"; time: string }
  | { kind: "provider"; providerText: string }
  | { kind: "more_times" }
  | { kind: "change_date" };

export type BookingSelectionContext = {
  serviceName: string;
  date: string;
  /** Options parsed from the canonical offer message (may be empty). */
  options: OfferedBookingOption[];
  followUpRequestId?: string | null;
  /**
   * CONV-CORE-01 — present ONLY for a typed offer: the exact service/provider
   * ids the offer was resolved for, and how many fresh options were already
   * shown (for "more times"). Absent ⇒ legacy text-recovered offer.
   */
  serviceId?: string;
  providerId?: string | null;
  timePreference?: CanonicalTimePreference | null;
  shownCount?: number;
  range?: { startDate: string; endDate: string } | null;
};

/** Arabic and Eastern Arabic indic digits → ascii. */
function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

export const OFFER_HEADER_PHRASE = "تتوفر المواعيد التالية لخدمة";
const OFFER_HEADER =
  /^(?:تتوفر المواعيد التالية ل(?:خدمة|متابعة)|إليك أوقات(?:اً|ا)? أخرى متاحة ل(?:خدمة|متابعة))\s*"([^"]+)"(?:\s*مع\s*([^"\n:]+?))?\s*يوم\s*([^\n:]+):?/m;
const OFFER_LINE =
  /^(\d+)[.)]\s*(?:(.+?)\s*—\s*)?(\d{1,2}:\d{2}(?:\s*[صم])?)(?:\s*إلى\s*(\d{1,2}:\d{2}(?:\s*[صم])?))?\s*$/;
const FOLLOW_UP_TAG = /\[متابعة:\s*([^\]]+)\]/;

const ARABIC_MONTH_LOOKUP: Record<string, number> = {
  يناير: 1,
  فبراير: 2,
  مارس: 3,
  أبريل: 4,
  ابريل: 4,
  مايو: 5,
  يونيو: 6,
  يوليو: 7,
  أغسطس: 8,
  اغسطس: 8,
  سبتمبر: 9,
  أكتوبر: 10,
  اكتوبر: 10,
  نوفمبر: 11,
  ديسمبر: 12,
};

export const ARABIC_WEEKDAY_LOOKUP: Record<string, number> = {
  الأحد: 0,
  الاحد: 0,
  الإثنين: 1,
  الاثنين: 1,
  الثلاثاء: 2,
  الأربعاء: 3,
  الاربعاء: 3,
  الخميس: 4,
  الجمعة: 5,
  الجمعه: 5,
  السبت: 6,
};

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

export function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    return false;
  }
  return true;
}

export type ParseOfferDateOptions = {
  provenanceDate?: string | Date | null;
  timezone?: string | null;
};

function getZonedProvenance(
  provenance: Date | string,
  timeZone: string = "Africa/Cairo",
): { year: number; month: number; day: number } | null {
  const d = typeof provenance === "string" ? new Date(provenance) : provenance;
  if (Number.isNaN(d.getTime())) return null;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "Africa/Cairo",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    const parts = formatter.formatToParts(d);
    let year = 0;
    let month = 0;
    let day = 0;
    for (const p of parts) {
      if (p.type === "year") year = parseInt(p.value, 10);
      if (p.type === "month") month = parseInt(p.value, 10);
      if (p.type === "day") day = parseInt(p.value, 10);
    }
    if (year && month && day) {
      return { year, month, day };
    }
  } catch {
    // If timezone is invalid, return null
  }
  return null;
}

/**
 * Strict 24-hour time normalizer.
 * Validates 0..23 for 24h, 1..12 for 12h with ص/م, 0..59 for minutes.
 * Returns null on any invalid or out-of-range value.
 */
export function normalizeTimeTo24h(timeStr: string): string | null {
  const trimmed = normalizeDigits(timeStr.trim());
  const match = /^(\d{1,2}):(\d{2})(?:\s*([صم]))?$/.exec(trimmed);
  if (!match || !match[1] || !match[2]) return null;
  let h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const period = match[3];

  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  if (m < 0 || m > 59) return null;

  if (period) {
    if (h < 1 || h > 12) return null;
    if (period === "م" && h < 12) h += 12;
    if (period === "ص" && h === 12) h = 0;
  } else {
    if (h < 0 || h > 23) return null;
  }

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Deterministically parse an offer date string from header text.
 *
 * Supported formats:
 * - ISO format: "2026-11-01"
 * - Arabic calendar format emitted by formatArabicDate:
 *   e.g. "الأحد، 1 نوفمبر 2026", "الأحد، 1 نوفمبر", "اليوم الأحد، 25 أكتوبر", "غدًا الإثنين، 26 أكتوبر"
 *
 * Strict validation:
 * - Real Gregorian calendar dates only (rejects Feb 31, Apr 31, Feb 29 on non-leap years).
 * - Weekday consistency: if an Arabic weekday is present, the date must fall on that exact weekday.
 * - Yearless labels FAIL CLOSED to null unless anchored by deterministic message provenance.
 * - Timezone-aware provenance resolution (default: Africa/Cairo).
 */
export function parseOfferDate(
  rawDate: string,
  provenanceOrOptions?: string | Date | null | ParseOfferDateOptions,
): string | null {
  const normalized = normalizeDigits(rawDate.trim());

  // Weekday consistency check (if a weekday is named in the text)
  const weekdayMatch =
    /(?:^|\s|[،,])(الأحد|الاحد|الإثنين|الاثنين|الثلاثاء|الأربعاء|الاربعاء|الخميس|الجمعة|الجمعه|السبت)(?:[،,\s]|$)/.exec(
      normalized,
    );
  const expectedWeekday = weekdayMatch?.[1]
    ? ARABIC_WEEKDAY_LOOKUP[weekdayMatch[1]]
    : undefined;

  // 1. Direct ISO date format: YYYY-MM-DD
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10);
    const d = parseInt(isoMatch[3], 10);
    if (!isValidCalendarDate(y, m, d)) return null;

    if (expectedWeekday !== undefined) {
      const actualWeekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (actualWeekday !== expectedWeekday) return null;
    }

    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // 2. Arabic calendar date: "[اليوم/غدًا] [السبت/الأحد...] [،] <day> <month_name> [<year>]"
  const arabicMatch =
    /(\d{1,2})\s*(?:من\s*)?(يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)(?:\s*(\d{4}))?/.exec(
      normalized,
    );

  if (arabicMatch && arabicMatch[1] && arabicMatch[2]) {
    const d = parseInt(arabicMatch[1], 10);
    const m = ARABIC_MONTH_LOOKUP[arabicMatch[2]];
    if (!m) return null;

    let y: number;
    if (arabicMatch[3]) {
      // Explicit 4-digit year in label
      y = parseInt(arabicMatch[3], 10);
    } else {
      // Yearless label: MUST have deterministic provenance to resolve exact date.
      const provOption =
        provenanceOrOptions &&
        typeof provenanceOrOptions === "object" &&
        !(provenanceOrOptions instanceof Date)
          ? provenanceOrOptions.provenanceDate
          : provenanceOrOptions;
      const tz =
        provenanceOrOptions &&
        typeof provenanceOrOptions === "object" &&
        !(provenanceOrOptions instanceof Date)
          ? (provenanceOrOptions.timezone ?? "Africa/Cairo")
          : "Africa/Cairo";

      if (!provOption) {
        // Missing provenance: fail closed safely without guessing
        return null;
      }

      const zonedProv = getZonedProvenance(provOption, tz);
      if (!zonedProv) return null;

      // Determine candidate year relative to zoned provenance
      if (m >= zonedProv.month) {
        y = zonedProv.year;
      } else if (zonedProv.month >= 10 && m <= 3) {
        // Year boundary rollover (e.g. Dec/Nov offer for Jan/Feb)
        y = zonedProv.year + 1;
      } else {
        // Historical date in the past without valid rollover: fail closed
        return null;
      }

      // Verify that (y, m, d) is within a valid forward booking window relative to provenance date
      const provUtc = Date.UTC(
        zonedProv.year,
        zonedProv.month - 1,
        zonedProv.day,
      );
      const candUtc = Date.UTC(y, m - 1, d);
      const diffDays = Math.round((candUtc - provUtc) / 86400000);
      if (diffDays < 0 || diffDays > 120) {
        return null;
      }
    }

    if (!isValidCalendarDate(y, m, d)) return null;

    if (expectedWeekday !== undefined) {
      const actualWeekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      if (actualWeekday !== expectedWeekday) return null;
    }

    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  return null;
}

/**
 * Extract the last canonical booking-options offer from recent history.
 * Returns null when no offer is present (the message is not a selection
 * context and must flow through the normal AI turn).
 */
export function extractLastBookingOffer(
  recentChronological: ReadonlyArray<ChronologicalMessage>,
  options?: ParseOfferDateOptions,
): BookingSelectionContext | null {
  for (let i = recentChronological.length - 1; i >= 0; i -= 1) {
    const msg = recentChronological[i];
    if (!msg || msg.senderType !== "AI") continue;
    // If the assistant already confirmed a booking in a later turn,
    // any older booking slot offer is fulfilled and expired.
    if (
      msg.content.includes("تم تأكيد") ||
      msg.content.includes("تم استلام طلب")
    ) {
      return null;
    }
    const header = msg.content.match(OFFER_HEADER);
    if (!header) continue;

    // The newest recognized offer must bound recovery. If it cannot be
    // recovered safely, return null; do not fall back to an older offer.
    if (!header[1] || !header[3]) return null;

    const msgProvenance =
      msg.sentAt ?? msg.createdAt ?? options?.provenanceDate;
    const resolvedDate = parseOfferDate(header[3], {
      provenanceDate: msgProvenance,
      timezone: options?.timezone ?? "Africa/Cairo",
    });
    if (!resolvedDate) return null;

    const headerProviderName = header[2] ? header[2].trim() : undefined;
    const followUpMatch = msg.content.match(FOLLOW_UP_TAG);
    const followUpRequestId = followUpMatch ? followUpMatch[1]?.trim() : null;
    const slotOptions: OfferedBookingOption[] = [];
    for (const line of msg.content.split("\n")) {
      const parsed = line.trim().match(OFFER_LINE);
      if (!parsed || !parsed[1] || !parsed[3]) {
        continue;
      }
      const rawStart = parsed[3];
      const startNorm = normalizeTimeTo24h(rawStart);
      if (!startNorm) continue;

      const rawEnd = parsed[4];
      let endNorm: string | undefined;
      if (rawEnd) {
        const parsedEnd = normalizeTimeTo24h(rawEnd);
        if (!parsedEnd) continue;
        endNorm = parsedEnd;
      }

      slotOptions.push({
        index: Number(parsed[1]),
        displayName: (parsed[2] ?? headerProviderName ?? "").trim(),
        startTime: startNorm,
        ...(endNorm ? { endTime: endNorm } : {}),
      });
    }
    if (slotOptions.length === 0) return null;
    return {
      serviceName: header[1],
      date: resolvedDate,
      options: slotOptions,
      ...(followUpRequestId ? { followUpRequestId } : {}),
    };
  }
  return null;
}

/**
 * Deterministic parse of the customer's raw text into a selection intent.
 * Returns null when the text is not recognizable as a selection (the
 * caller falls back to the normal AI turn).
 *
 * Order: index → time → provider-name candidate.
 */

export function parseBookingSelection(
  rawText: string,
): BookingSelection | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0 || trimmed.length > 120) return null;

  // Direct protocol navigation callback tokens
  if (trimmed === "more_times" || trimmed === "more times") {
    return { kind: "more_times" };
  }
  if (trimmed === "change_date" || trimmed === "change date") {
    return { kind: "change_date" };
  }

  // Structured callback/button prefix e.g. "opt_1", "slot_2", "choice:3"
  const prefixMatch = trimmed.match(/^(?:opt|slot|choice)[_:\s-]*([1-9]\d?)$/i);
  if (prefixMatch && prefixMatch[1]) {
    return { kind: "index", index: Number(prefixMatch[1]) };
  }

  const digitsNormalized = normalizeDigits(trimmed);

  // Index: genuine full-message numeric selection ONLY.
  // Strips optional wrapping punctuation / whitespace (e.g. "2", "٢", " 2 ", "٢.", "(1)", "[3]").
  // Free-form sentences with surrounding words or mixed content return null to reach semantic routing.
  const stripped = digitsNormalized
    .replace(/^[\s.\-—–_()\[\]{}،,.:!؟?]+|[\s.\-—–_()\[\]{}،,.:!؟?]+$/g, "")
    .trim();
  if (/^[1-9]\d?$/.test(stripped)) {
    return { kind: "index", index: Number(stripped) };
  }

  // Time: HH:mm where uniquely resolvable as the full message ("10:00", "١٠:٠٠")
  const timeNorm = digitsNormalized
    .replace(/[٫꞉:：]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
  const timeMatch = timeNorm.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (timeMatch && timeMatch[1] && timeMatch[2]) {
    const hh = timeMatch[1].padStart(2, "0");
    const mm = timeMatch[2];
    return { kind: "time", time: `${hh}:${mm}` };
  }

  return null;
}

/**
 * High-level helper: given customer text and recent history, determine
 * whether the message is a booking selection. Returns null when there is
 * no live offer context or the text is not a selection.
 */
export function tryParseBookingSelection(
  customerText: string,
  recentChronological: ReadonlyArray<ChronologicalMessage>,
  options?: ParseOfferDateOptions,
): { context: BookingSelectionContext; selection: BookingSelection } | null {
  const context = extractLastBookingOffer(recentChronological, options);
  if (!context) return null;
  const selection = parseBookingSelection(customerText);
  if (!selection) return null;
  return { context, selection };
}

// ─── Typed offer replies (CONV-CORE-01) ─────────────────────────────────────

/** The selection context a typed slot offer implies (ids, not names). */
export function selectionContextFromSlotOffer(
  offer: SlotOffer,
): BookingSelectionContext {
  return {
    serviceName: offer.serviceName,
    date: offer.date,
    options: offer.options.map((option) => ({
      index: option.index,
      displayName: option.displayName,
      startTime: option.startAt.slice(11, 16),
      endTime: option.endAt.slice(11, 16),
      providerId: option.providerId,
    })),
    followUpRequestId: offer.followUpRequestId,
    serviceId: offer.serviceId,
    providerId: offer.providerId,
    timePreference: offer.timePreference ?? null,
    shownCount: offer.shownCount,
    range: offer.range ?? null,
  };
}

/**
 * How the customer's raw turn relates to the CURRENT typed offer. This is a
 * MECHANICAL interpretation (index / time / callback token) — never intent
 * classification — and it reads ONLY the typed snapshot, never message copy.
 */
export type OfferReply =
  /** Not a reply to an offer — the normal AI turn owns it. */
  | { kind: "none" }
  /** A selection-shaped reply to an offer that is no longer selectable. */
  | {
      kind: "stale";
      reason: "EXPIRED" | "CLOSED" | "UNKNOWN_TOKEN";
      offer?: BookingOffer | null;
    }
  /** A slot-offer selection (re-verified against fresh CORE-02 by the engine). */
  | {
      kind: "slot";
      context: BookingSelectionContext;
      selection: BookingSelection;
    }
  /** A service-list selection resolved to the offered service id (for booking). */
  | { kind: "service"; serviceId: string; serviceName: string }
  /** A service-list selection resolved to the offered service id (for inquiry). */
  | { kind: "service_inquiry"; serviceId: string; serviceName: string }
  /** An index outside the offered service list. */
  | { kind: "service_invalid_index"; max: number }
  /** Welcome menu action (book or inquire). */
  | { kind: "welcome_action"; action: "book" | "inquire" }
  /** Resume menu action (continue previous request or start new request). */
  | { kind: "resume_action"; action: "continue" | "new_request" }
  /** Service detail action (book_service, other_services, menu). */
  | {
      kind: "service_detail_action";
      action: "book_service" | "other_services" | "menu";
      serviceId: string;
      serviceName: string;
    }
  /** A date selection from offered dates. */
  | {
      kind: "date";
      date: string;
      label: string;
      serviceId: string;
      serviceName: string;
      providerId: string | null;
      timePreference?: CanonicalTimePreference | null;
      range?: { startDate: string; endDate: string } | null;
    }
  /** Customer requested more dates within the requested range. */
  | {
      kind: "date_more";
      serviceId: string;
      serviceName: string;
      providerId: string | null;
      timePreference?: CanonicalTimePreference | null;
      offer: Extract<BookingOffer, { kind: "DATE" }>;
    }
  /** Customer requested to type another date or range. */
  | {
      kind: "date_other";
      serviceId: string;
      serviceName: string;
      providerId: string | null;
      timePreference?: CanonicalTimePreference | null;
    }
  /** An index outside the offered date list. */
  | { kind: "date_invalid_index"; max: number }
  /** A provider selection. */
  | {
      kind: "provider";
      providerId: string | null;
      providerName: string;
      serviceId: string;
      serviceName: string;
      date: string | null;
    }
  /** An index outside the offered provider list. */
  | { kind: "provider_invalid_index"; max: number };

function serviceIndexFromText(text: string): number | null {
  const trimmed = text.trim();
  const prefixed = trimmed.match(/^(?:service|serv)[_:]([1-9]\d?)$/i);
  if (prefixed?.[1]) return Number(prefixed[1]);
  const selection = parseBookingSelection(trimmed);
  return selection?.kind === "index" ? selection.index : null;
}

/** Legacy positional callbacks (`opt_N`, `service_N`, `more_times`, …). */
function isLegacyCallback(text: string): boolean {
  return /^(?:opt|slot|choice|service|serv)[_:][1-9]\d?$|^(?:more_times|change_date)$/i.test(
    text.trim(),
  );
}

/**
 * Interpret the customer's turn against the current typed offer.
 *
 * - `fp:<token>:<action>` callbacks bind to ONE offer: a token that is not the
 *   live offer's token is STALE (never re-applied to a newer list).
 * - Legacy positional callbacks / bare indices apply only to a LIVE offer.
 * - Free text that is not selection-shaped returns `none` (the AI decides).
 */
export function interpretOfferReply(
  rawText: string,
  offer: BookingOffer | null,
  now: Date,
): OfferReply {
  const live = isOfferLive(offer, now);
  if (rawText.startsWith("fp:")) {
    const callback = parseOfferCallback(rawText);
    if (!callback) {
      return { kind: "stale", reason: "UNKNOWN_TOKEN" };
    }
    if (!offer || callback.token !== offer.token) {
      return { kind: "stale", reason: "UNKNOWN_TOKEN" };
    }
    if (!live) {
      return {
        kind: "stale",
        reason: offer.status === "ACTIVE" ? "EXPIRED" : "CLOSED",
        offer,
      };
    }

    if (offer.kind === "WELCOME") {
      if (callback.action.kind === "action") {
        if (callback.action.name === "book") {
          return { kind: "welcome_action", action: "book" };
        }
        if (callback.action.name === "inquire") {
          return { kind: "welcome_action", action: "inquire" };
        }
        return { kind: "stale", reason: "UNKNOWN_TOKEN" };
      }
      if (callback.action.kind === "index") {
        if (callback.action.index === 1) {
          return { kind: "welcome_action", action: "book" };
        }
        if (callback.action.index === 2) {
          return { kind: "welcome_action", action: "inquire" };
        }
        return { kind: "stale", reason: "UNKNOWN_TOKEN" };
      }
      return { kind: "stale", reason: "UNKNOWN_TOKEN" };
    }

    if (offer.kind === "RESUME") {
      if (callback.action.kind === "action") {
        if (callback.action.name === "continue") {
          return { kind: "resume_action", action: "continue" };
        }
        if (callback.action.name === "new_request") {
          return { kind: "resume_action", action: "new_request" };
        }
        return { kind: "stale", reason: "UNKNOWN_TOKEN" };
      }
      if (callback.action.kind === "index") {
        if (callback.action.index === 1) {
          return { kind: "resume_action", action: "continue" };
        }
        if (callback.action.index === 2) {
          return { kind: "resume_action", action: "new_request" };
        }
        return { kind: "stale", reason: "UNKNOWN_TOKEN" };
      }
      return { kind: "stale", reason: "UNKNOWN_TOKEN" };
    }

    if (offer.kind === "SERVICE") {
      if (callback.action.kind !== "index") {
        return { kind: "stale", reason: "UNKNOWN_TOKEN" };
      }
      return serviceChoice(offer, callback.action.index);
    }

    if (offer.kind === "SERVICE_DETAIL") {
      if (callback.action.kind === "action") {
        if (
          callback.action.name === "book_service" ||
          callback.action.name === "other_services" ||
          callback.action.name === "menu"
        ) {
          return {
            kind: "service_detail_action",
            action: callback.action.name,
            serviceId: offer.serviceId,
            serviceName: offer.serviceName,
          };
        }
        return { kind: "stale", reason: "UNKNOWN_TOKEN" };
      }
      if (callback.action.kind === "index") {
        const action =
          callback.action.index === 1
            ? "book_service"
            : callback.action.index === 2
              ? "other_services"
              : callback.action.index === 3
                ? "menu"
                : null;
        if (action) {
          return {
            kind: "service_detail_action",
            action,
            serviceId: offer.serviceId,
            serviceName: offer.serviceName,
          };
        }
        return { kind: "stale", reason: "UNKNOWN_TOKEN" };
      }
      return { kind: "stale", reason: "UNKNOWN_TOKEN" };
    }

    if (offer.kind === "DATE") {
      if (
        callback.action.kind === "action" &&
        callback.action.name === "other_date"
      ) {
        return {
          kind: "date_other",
          serviceId: offer.serviceId,
          serviceName: offer.serviceName,
          providerId: offer.providerId,
          timePreference: offer.timePreference ?? null,
        };
      }
      if (
        callback.action.kind === "action" &&
        callback.action.name === "more_dates"
      ) {
        return {
          kind: "date_more",
          serviceId: offer.serviceId,
          serviceName: offer.serviceName,
          providerId: offer.providerId,
          timePreference: offer.timePreference ?? null,
          offer,
        };
      }
      if (callback.action.kind === "index") {
        const actionIndex = callback.action.index;
        const option = offer.options.find((o) => o.index === actionIndex);
        if (!option) {
          return { kind: "date_invalid_index", max: offer.options.length };
        }
        return {
          kind: "date",
          date: option.date,
          label: option.label,
          serviceId: offer.serviceId,
          serviceName: offer.serviceName,
          providerId: offer.providerId,
          timePreference: offer.timePreference ?? null,
          range: offer.range ?? null,
        };
      }
      return { kind: "stale", reason: "UNKNOWN_TOKEN" };
    }

    if (offer.kind === "PROVIDER") {
      if (callback.action.kind === "index") {
        const actionIndex = callback.action.index;
        const option = offer.options.find((o) => o.index === actionIndex);
        if (!option) {
          return { kind: "provider_invalid_index", max: offer.options.length };
        }
        return {
          kind: "provider",
          providerId: option.providerId,
          providerName: option.name,
          serviceId: offer.serviceId,
          serviceName: offer.serviceName,
          date: offer.date,
        };
      }
      return { kind: "stale", reason: "UNKNOWN_TOKEN" };
    }

    if (offer.kind === "SLOT") {
      if (callback.action.kind === "index") {
        const selection: BookingSelection = {
          kind: "index",
          index: callback.action.index,
        };
        return {
          kind: "slot",
          context: selectionContextFromSlotOffer(offer),
          selection,
        };
      }
      if (callback.action.kind === "more") {
        return {
          kind: "slot",
          context: selectionContextFromSlotOffer(offer),
          selection: { kind: "more_times" },
        };
      }
      if (callback.action.kind === "date") {
        return {
          kind: "slot",
          context: selectionContextFromSlotOffer(offer),
          selection: { kind: "change_date" },
        };
      }
      return { kind: "stale", reason: "UNKNOWN_TOKEN" };
    }

    return { kind: "stale", reason: "UNKNOWN_TOKEN" };
  }

  if (!offer) return { kind: "none" };

  if (!live) {
    // Only a clearly selection-shaped turn is answered as stale; anything
    // else is a fresh request the AI should handle normally.
    const selectionShaped =
      isLegacyCallback(rawText) ||
      parseBookingSelection(rawText)?.kind === "index";
    if (!selectionShaped) return { kind: "none" };
    return {
      kind: "stale",
      reason: offer.status === "ACTIVE" ? "EXPIRED" : "CLOSED",
      offer,
    };
  }

  const trimmedText = rawText.trim();

  if (offer.kind === "WELCOME") {
    const sel = parseBookingSelection(trimmedText);
    if (sel?.kind === "index") {
      if (sel.index === 1) return { kind: "welcome_action", action: "book" };
      if (sel.index === 2) return { kind: "welcome_action", action: "inquire" };
    }
    return { kind: "none" };
  }

  if (offer.kind === "RESUME") {
    const sel = parseBookingSelection(trimmedText);
    if (sel?.kind === "index") {
      if (sel.index === 1) return { kind: "resume_action", action: "continue" };
      if (sel.index === 2)
        return { kind: "resume_action", action: "new_request" };
    }
    return { kind: "none" };
  }

  if (offer.kind === "SERVICE") {
    const index = serviceIndexFromText(trimmedText);
    if (index === null) return { kind: "none" };
    return serviceChoice(offer, index);
  }

  if (offer.kind === "SERVICE_DETAIL") {
    const sel = parseBookingSelection(trimmedText);
    if (sel?.kind === "index") {
      if (sel.index === 1) {
        return {
          kind: "service_detail_action",
          action: "book_service",
          serviceId: offer.serviceId,
          serviceName: offer.serviceName,
        };
      }
      if (sel.index === 2) {
        return {
          kind: "service_detail_action",
          action: "other_services",
          serviceId: offer.serviceId,
          serviceName: offer.serviceName,
        };
      }
      if (sel.index === 3) {
        return {
          kind: "service_detail_action",
          action: "menu",
          serviceId: offer.serviceId,
          serviceName: offer.serviceName,
        };
      }
    }
    return { kind: "none" };
  }

  if (offer.kind === "DATE") {
    if (
      offer.hasMore &&
      /^(المزيد|مواعيد أخرى|المزيد من الأيام|more)$/i.test(trimmedText)
    ) {
      return {
        kind: "date_more",
        serviceId: offer.serviceId,
        serviceName: offer.serviceName,
        providerId: offer.providerId,
        timePreference: offer.timePreference ?? null,
        offer,
      };
    }
    if (/^(تاريخ آخر|فترة أخرى|يوم آخر)$/.test(trimmedText)) {
      return {
        kind: "date_other",
        serviceId: offer.serviceId,
        serviceName: offer.serviceName,
        providerId: offer.providerId,
        timePreference: offer.timePreference ?? null,
      };
    }
    const sel = parseBookingSelection(trimmedText);
    if (sel?.kind === "index") {
      let option = offer.options.find((o) => o.index === sel.index);
      if (!option && offer.pageOffset && offer.pageOffset > 0) {
        const relativeIndex = (offer.pageOffset ?? 0) + sel.index;
        option = offer.options.find((o) => o.index === relativeIndex);
      }
      if (!option) {
        return { kind: "date_invalid_index", max: offer.options.length };
      }
      return {
        kind: "date",
        date: option.date,
        label: option.label,
        serviceId: offer.serviceId,
        serviceName: offer.serviceName,
        providerId: offer.providerId,
        timePreference: offer.timePreference ?? null,
        range: offer.range ?? null,
      };
    }
    return { kind: "none" };
  }

  if (offer.kind === "PROVIDER") {
    const sel = parseBookingSelection(trimmedText);
    if (sel?.kind === "index") {
      const option = offer.options.find((o) => o.index === sel.index);
      if (!option) {
        return { kind: "provider_invalid_index", max: offer.options.length };
      }
      return {
        kind: "provider",
        providerId: option.providerId,
        providerName: option.name,
        serviceId: offer.serviceId,
        serviceName: offer.serviceName,
        date: offer.date,
      };
    }
    return { kind: "none" };
  }

  const selection = parseBookingSelection(trimmedText);
  if (!selection) return { kind: "none" };
  return {
    kind: "slot",
    context: selectionContextFromSlotOffer(offer),
    selection,
  };
}

function serviceChoice(
  offer: Extract<BookingOffer, { kind: "SERVICE" }>,
  index: number,
): OfferReply {
  const option = offer.options.find((o) => o.index === index);
  if (!option) {
    return { kind: "service_invalid_index", max: offer.options.length };
  }
  if (offer.purpose === "INQUIRY") {
    return {
      kind: "service_inquiry",
      serviceId: option.serviceId,
      serviceName: option.name,
    };
  }
  return {
    kind: "service",
    serviceId: option.serviceId,
    serviceName: option.name,
  };
}
