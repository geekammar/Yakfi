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
  endTime: string;
  /** CONV-CORE-01 — the real provider id (typed offers only). */
  providerId?: string;
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
};

/** Arabic and Eastern Arabic indic digits → ascii. */
function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

export const OFFER_HEADER_PHRASE = "تتوفر المواعيد التالية لخدمة";
const OFFER_HEADER =
  /تتوفر المواعيد التالية ل(?:خدمة|متابعة)\s*"([^"]+)"\s*يوم\s*(\d{4}-\d{2}-\d{2})/;
const OFFER_LINE =
  /^(\d+)[.)]\s*(.+?)\s*—\s*(\d{1,2}:\d{2})\s*إلى\s*(\d{1,2}:\d{2})\s*$/;
const FOLLOW_UP_TAG = /\[متابعة:\s*([^\]]+)\]/;

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
    // If the assistant already confirmed a booking in a later turn,
    // any older booking slot offer is fulfilled and expired.
    if (
      msg.content.includes("تم تأكيد") ||
      msg.content.includes("تم استلام طلب")
    ) {
      return null;
    }
    const header = msg.content.match(OFFER_HEADER);
    if (!header || !header[1] || !header[2]) continue;
    const followUpMatch = msg.content.match(FOLLOW_UP_TAG);
    const followUpRequestId = followUpMatch ? followUpMatch[1]?.trim() : null;
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
    return {
      serviceName: header[1],
      date: header[2],
      options,
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
  recentChronological: ReadonlyArray<{ senderType: string; content: string }>,
): { context: BookingSelectionContext; selection: BookingSelection } | null {
  const context = extractLastBookingOffer(recentChronological);
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
  | { kind: "stale"; reason: "EXPIRED" | "CLOSED" | "UNKNOWN_TOKEN" }
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
    }
  /** Customer requested to type another date. */
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
    const sel = parseBookingSelection(trimmedText);
    if (sel?.kind === "index") {
      const option = offer.options.find((o) => o.index === sel.index);
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
