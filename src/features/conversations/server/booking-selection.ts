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
import { normalizeArabicText } from "@/features/conversations/server/conversation-ai";

/** One option exactly as presented in the canonical offer message. */
export type OfferedBookingOption = {
  index: number;
  displayName: string;
  startTime: string;
  endTime: string;
};

export type BookingSelection =
  | { kind: "index"; index: number }
  | { kind: "time"; time: string }
  | { kind: "provider"; providerText: string };

export type BookingSelectionContext = {
  serviceName: string;
  date: string;
  /** Options parsed from the canonical offer message (may be empty). */
  options: OfferedBookingOption[];
};

/** Arabic and Eastern Arabic indic digits → ascii. */
function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

const OFFER_HEADER =
  /تتوفر المواعيد التالية لخدمة\s*"([^"]+)"\s*يوم\s*(\d{4}-\d{2}-\d{2})/;
const OFFER_LINE =
  /^(\d+)[.)]\s*(.+?)\s*—\s*(\d{1,2}:\d{2})\s*إلى\s*(\d{1,2}:\d{2})\s*$/;

/**
 * Extract the last canonical booking-options offer from recent history.
 * Returns null when no offer is present (the message is not a selection
 * context and must flow through the normal AI turn).
 */
export function extractLastBookingOffer(
  recentChronological: ReadonlyArray<{ senderType: string; content: string }>,
): BookingSelectionContext | null {
  for (let i = recentChronological.length - 1; i >= 0; i -= 1) {
    const msg = recentChronological[i];
    if (!msg || msg.senderType !== "AI") continue;
    const header = msg.content.match(OFFER_HEADER);
    if (!header || !header[1] || !header[2]) continue;
    const options: OfferedBookingOption[] = [];
    for (const line of msg.content.split("\n")) {
      const parsed = line.trim().match(OFFER_LINE);
      if (!parsed || !parsed[1] || !parsed[2] || !parsed[3] || !parsed[4]) {
        continue;
      }
      options.push({
        index: Number(parsed[1]),
        displayName: parsed[2].trim(),
        startTime: parsed[3].padStart(5, "0"),
        endTime: parsed[4].padStart(5, "0"),
      });
    }
    return { serviceName: header[1], date: header[2], options };
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

  const digitsNormalized = normalizeDigits(trimmed);

  // Index: only when the whole (punctuation-stripped) text is a single
  // digit — the engine re-validates it against the OFFERED option list
  // (out-of-range → clarification, never a fabricated selection).
  const strippedForIndex = digitsNormalized
    .replace(/[\s.\-—–_()\[\]{}،,.:!؟?]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (/^[1-9]$/.test(strippedForIndex)) {
    return { kind: "index", index: Number(strippedForIndex) };
  }
  // "الخيار 1" / "رقم 2" / "اختيار 3" — only on short index phrases.
  if (strippedForIndex.length <= 12) {
    const m = strippedForIndex.match(/(?:^|\s)([1-9])(?:\s|$)/);
    if (m && m[1] && strippedForIndex.split(" ").length <= 3) {
      const withoutDigit = strippedForIndex.replace(m[1], "").trim();
      if (
        withoutDigit.length === 0 ||
        /^(الخيار|خيار|رقم|اختيار|اختار|الاختيار)$/.test(
          normalizeArabicText(withoutDigit),
        )
      ) {
        return { kind: "index", index: Number(m[1]) };
      }
    }
  }

  // Time: HH:mm (colon may be Arabic or space, digits may be indic).
  const timeNorm = digitsNormalized
    .replace(/[٫꞉:：]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
  const timeMatch = timeNorm.match(/([01]?\d|2[0-3])\s*:\s*([0-5]\d)/);
  if (timeMatch && timeMatch[1] && timeMatch[2]) {
    const hh = timeMatch[1].padStart(2, "0");
    const mm = timeMatch[2];
    const time = `${hh}:${mm}`;
    // Only treat as time selection when the message is essentially the
    // time ("10:00", "الساعة 10:00") — not a long sentence.
    const timeRemoved = timeNorm.replace(timeMatch[0], "").trim();
    const timeRemovedNorm = normalizeArabicText(timeRemoved);
    if (
      timeRemoved.length <= 10 &&
      (timeRemoved.length === 0 ||
        timeRemovedNorm.length === 0 ||
        /^(الساعه|ساعه|تمام|تماما)$/.test(timeRemovedNorm))
    ) {
      return { kind: "time", time };
    }
    if (strippedForIndex === time || timeNorm === time) {
      return { kind: "time", time };
    }
  }
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(digitsNormalized.trim())) {
    return { kind: "time", time: digitsNormalized.trim() };
  }

  // Provider-name candidate: any short name-like text. The engine
  // verifies it against the fresh eligible set AND requires the tokens
  // to be a subset of a real provider name before treating it as a
  // selection — otherwise the message falls through to the AI turn.
  const norm = normalizeArabicText(trimmed);
  if (norm.length >= 2 && norm.length <= 60 && trimmed.length <= 60) {
    const tokens = norm.split(" ").filter(Boolean);
    if (
      tokens.length <= 4 &&
      !/[؟?]/.test(trimmed) &&
      !trimmed.includes("حجز")
    ) {
      return { kind: "provider", providerText: trimmed };
    }
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
  recentChronological: ReadonlyArray<{ senderType: string; content: string }>,
): { context: BookingSelectionContext; selection: BookingSelection } | null {
  const context = extractLastBookingOffer(recentChronological);
  if (!context) return null;
  const selection = parseBookingSelection(customerText);
  if (!selection) return null;
  return { context, selection };
}
