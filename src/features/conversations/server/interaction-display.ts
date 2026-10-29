/**
 * Readable Interaction History (Yakfi).
 *
 * Resolves human-readable interaction snapshots for customer button callbacks
 * without changing booking authority, protocol tokens, or engine transitions.
 *
 * Invariants:
 * - Pure data transformation; zero AI model invocations; zero external side effects.
 * - Confirmed button tap snapshot is frozen at receipt time so subsequent catalog/offer
 *   mutations never alter historical conversation readability.
 * - Genuine transport interactions (Telegram callback_query, WhatsApp interactive)
 *   are strictly distinguished from ordinary customer text. A text prefix like `fp:...`
 *   typed by a user is never inferred as a genuine callback.
 * - Stale/unresolvable/malformed interactions use neutral, truthful Arabic wording.
 *   Never displays "تم الحجز" merely because an appointment slot was clicked.
 * - Historical messages without verified choice snapshot fall back to neutral text:
 *   "محتوى تقني محفوظ؛ تفاصيل الاختيار غير متاحة" with raw protocol text accessible.
 */
import type { InboundTransportOrigin } from "@/server/transport/whatsapp-transport";

import type { BookingOffer } from "./booking-offer";
import { isOfferLive } from "./booking-offer";
import { parseOfferCallback, type OfferCallback } from "./channel-choice";
import {
  areSlotsSingleProvider,
  formatArabicTime12h,
} from "./presentation-formatters";

export const HISTORICAL_PROTOCOL_FALLBACK_TEXT =
  "محتوى تقني محفوظ؛ تفاصيل الاختيار غير متاحة";

export type InteractionStatus =
  "VALIDATED" | "STALE" | "MALFORMED" | "UNKNOWN_TOKEN" | "INVALID_ACTION";

export type MessageProvenanceMetadata = {
  v: 1;
  provenance: "TEXT" | "CALLBACK" | "INTERACTIVE";
  status?: InteractionStatus;
  offerToken?: string;
  offerKind?: BookingOffer["kind"];
  action?: string | number;
  displayText?: string;
  snapshot?: Record<string, unknown>;
  rawText?: string;
  reason?: string;
};

export type InteractionSnapshotMetadata = MessageProvenanceMetadata;

export type InteractionResolutionResult = {
  isInteraction: boolean;
  displayText: string | null;
  metadata: MessageProvenanceMetadata | null;
};

/**
 * Genuine transport interaction check:
 * Verified at transport boundary (Telegram callback_query or Meta interactive reply).
 * Ordinary user text is never inferred as an interaction regardless of prefix.
 */
export function isTransportInteraction(
  transportOrigin?: InboundTransportOrigin,
): boolean {
  return transportOrigin === "CALLBACK" || transportOrigin === "INTERACTIVE";
}

/**
 * Recognized offer protocol format (`fp:<token>:<action>`).
 */
export function isOfferProtocolText(text: string): boolean {
  return parseOfferCallback(text) !== null;
}

/**
 * Resolves choice label and snapshot against an offer proven to match the callback token.
 */
export function resolveOfferInteractionDisplay(
  offer: BookingOffer,
  callback: OfferCallback,
  now: Date,
): {
  displayText: string;
  snapshot: Record<string, unknown>;
  status: "VALIDATED" | "STALE" | "INVALID_ACTION";
} {
  const live = isOfferLive(offer, now);
  if (!live) {
    return {
      displayText: "خيار تفاعلي منتهي الصلاحية",
      snapshot: {
        offerToken: offer.token,
        offerKind: offer.kind,
        reason: offer.status === "ACTIVE" ? "EXPIRED" : offer.status,
      },
      status: "STALE",
    };
  }

  switch (offer.kind) {
    case "WELCOME": {
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "book") ||
        (callback.action.kind === "index" && callback.action.index === 1)
      ) {
        return {
          displayText: "حجز موعد",
          snapshot: { action: "book", label: "حجز موعد" },
          status: "VALIDATED",
        };
      }
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "inquire") ||
        (callback.action.kind === "index" && callback.action.index === 2)
      ) {
        return {
          displayText: "استفسار عن خدمة",
          snapshot: { action: "inquire", label: "استفسار عن خدمة" },
          status: "VALIDATED",
        };
      }
      return {
        displayText: "خيار تفاعلي غير متاح",
        snapshot: { offerToken: offer.token },
        status: "INVALID_ACTION",
      };
    }

    case "RESUME": {
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "continue") ||
        (callback.action.kind === "index" && callback.action.index === 1)
      ) {
        return {
          displayText: "متابعة الطلب",
          snapshot: { action: "continue", label: "متابعة الطلب" },
          status: "VALIDATED",
        };
      }
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "new_request") ||
        (callback.action.kind === "index" && callback.action.index === 2)
      ) {
        return {
          displayText: "طلب جديد",
          snapshot: { action: "new_request", label: "طلب جديد" },
          status: "VALIDATED",
        };
      }
      return {
        displayText: "خيار تفاعلي غير متاح",
        snapshot: { offerToken: offer.token },
        status: "INVALID_ACTION",
      };
    }

    case "SERVICE": {
      if (callback.action.kind === "index") {
        const actionIndex = callback.action.index;
        const option = offer.options.find((o) => o.index === actionIndex);
        if (option) {
          return {
            displayText: `اختيار خدمة: ${option.name}`,
            snapshot: {
              index: option.index,
              serviceId: option.serviceId,
              name: option.name,
            },
            status: "VALIDATED",
          };
        }
      }
      return {
        displayText: "خيار تفاعلي غير متاح",
        snapshot: { offerToken: offer.token },
        status: "INVALID_ACTION",
      };
    }

    case "SERVICE_DETAIL": {
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "book_service") ||
        (callback.action.kind === "index" && callback.action.index === 1)
      ) {
        return {
          displayText: `حجز موعد: ${offer.serviceName}`,
          snapshot: {
            action: "book_service",
            serviceId: offer.serviceId,
            serviceName: offer.serviceName,
          },
          status: "VALIDATED",
        };
      }
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "other_services") ||
        (callback.action.kind === "index" && callback.action.index === 2)
      ) {
        return {
          displayText: "خدمة أخرى",
          snapshot: { action: "other_services" },
          status: "VALIDATED",
        };
      }
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "menu") ||
        (callback.action.kind === "index" && callback.action.index === 3)
      ) {
        return {
          displayText: "القائمة الرئيسية",
          snapshot: { action: "menu" },
          status: "VALIDATED",
        };
      }
      return {
        displayText: "خيار تفاعلي غير متاح",
        snapshot: { offerToken: offer.token },
        status: "INVALID_ACTION",
      };
    }

    case "DATE": {
      if (
        callback.action.kind === "action" &&
        callback.action.name === "more_dates"
      ) {
        return {
          displayText: "طلب مواعيد أخرى",
          snapshot: { action: "more_dates" },
          status: "VALIDATED",
        };
      }
      if (
        callback.action.kind === "action" &&
        callback.action.name === "other_date"
      ) {
        const label = offer.range ? "طلب فترة أخرى" : "طلب تاريخ آخر";
        return {
          displayText: label,
          snapshot: { action: "other_date", range: Boolean(offer.range) },
          status: "VALIDATED",
        };
      }
      if (callback.action.kind === "index") {
        const actionIndex = callback.action.index;
        const option = offer.options.find((o) => o.index === actionIndex);
        if (option) {
          return {
            displayText: `اختيار تاريخ: ${option.label}`,
            snapshot: {
              index: option.index,
              date: option.date,
              label: option.label,
            },
            status: "VALIDATED",
          };
        }
      }
      return {
        displayText: "خيار تفاعلي غير متاح",
        snapshot: { offerToken: offer.token },
        status: "INVALID_ACTION",
      };
    }

    case "PROVIDER": {
      if (callback.action.kind === "index") {
        const actionIndex = callback.action.index;
        const option = offer.options.find((o) => o.index === actionIndex);
        if (option) {
          const label =
            option.providerId === null ? "أي مقدم خدمة متاح" : option.name;
          return {
            displayText: `اختيار مقدم الخدمة: ${label}`,
            snapshot: {
              index: option.index,
              providerId: option.providerId,
              name: option.name,
            },
            status: "VALIDATED",
          };
        }
      }
      return {
        displayText: "خيار تفاعلي غير متاح",
        snapshot: { offerToken: offer.token },
        status: "INVALID_ACTION",
      };
    }

    case "SLOT": {
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "more") ||
        callback.action.kind === "more"
      ) {
        return {
          displayText: "طلب أوقات أخرى",
          snapshot: { action: "more" },
          status: "VALIDATED",
        };
      }
      if (
        (callback.action.kind === "action" &&
          callback.action.name === "date") ||
        callback.action.kind === "date"
      ) {
        return {
          displayText: "طلب يوم آخر",
          snapshot: { action: "date" },
          status: "VALIDATED",
        };
      }
      if (callback.action.kind === "index") {
        const actionIndex = callback.action.index;
        const option = offer.options.find((o) => o.index === actionIndex);
        if (option) {
          const time = formatArabicTime12h(option.startAt);
          const isSingle = areSlotsSingleProvider(offer.options);
          const suffix =
            !isSingle && option.displayName ? ` (${option.displayName})` : "";
          return {
            displayText: `اختيار موعد: ${time}${suffix}`,
            snapshot: {
              index: option.index,
              providerId: option.providerId,
              displayName: option.displayName,
              startAt: option.startAt,
              endAt: option.endAt,
            },
            status: "VALIDATED",
          };
        }
      }
      return {
        displayText: "خيار تفاعلي غير متاح",
        snapshot: { offerToken: offer.token },
        status: "INVALID_ACTION",
      };
    }
  }
}

/**
 * Main resolution entry point:
 * Given inbound parameters and current conversation offer, evaluates genuine
 * interaction provenance and computes human-readable display snapshot.
 */
export function resolveInteractionDisplay(params: {
  rawText: string;
  transportOrigin?: InboundTransportOrigin;
  currentOffer: BookingOffer | null;
  now: Date;
}): InteractionResolutionResult {
  // Preserve known TEXT provenance through persistence and read models.
  // When an inbound message is known to be ordinary customer text (typed),
  // persist a small typed/versioned provenance record.
  if (params.transportOrigin === "TEXT") {
    return {
      isInteraction: false,
      displayText: null,
      metadata: {
        v: 1,
        provenance: "TEXT",
      },
    };
  }

  const isInteraction = isTransportInteraction(params.transportOrigin);
  if (!isInteraction) {
    return {
      isInteraction: false,
      displayText: null,
      metadata: null,
    };
  }

  const callback = parseOfferCallback(params.rawText);
  if (!callback) {
    return {
      isInteraction: true,
      displayText: "خيار تفاعلي غير صالح",
      metadata: {
        v: 1,
        provenance: params.transportOrigin!,
        status: "MALFORMED",
        rawText: params.rawText,
      },
    };
  }

  if (!params.currentOffer || params.currentOffer.token !== callback.token) {
    return {
      isInteraction: true,
      displayText: "خيار تفاعلي منتهي الصلاحية أو غير متاح",
      metadata: {
        v: 1,
        provenance: params.transportOrigin!,
        status: "UNKNOWN_TOKEN",
        offerToken: callback.token,
      },
    };
  }

  const result = resolveOfferInteractionDisplay(
    params.currentOffer,
    callback,
    params.now,
  );

  const actionValue =
    callback.action.kind === "index"
      ? callback.action.index
      : callback.action.kind === "action"
        ? callback.action.name
        : callback.action.kind;

  return {
    isInteraction: true,
    displayText: result.displayText,
    metadata: {
      v: 1,
      provenance: params.transportOrigin!,
      status: result.status,
      offerToken: params.currentOffer.token,
      offerKind: params.currentOffer.kind,
      action: actionValue,
      displayText: result.displayText,
      snapshot: result.snapshot,
    },
  };
}

/**
 * Resolves customer message display content for presentation in queries & UI:
 * - If displayText exists (new interactions), returns it.
 * - If metadata indicates known ordinary customer TEXT (provenance === "TEXT"),
 *   returns null to preserve original verbatim text display (even if the customer typed
 *   an exact `fp:...` shaped protocol token).
 * - If provenance/snapshot evidence is absent (null/undefined metadata, e.g. historical rows)
 *   and customer message matches exact protocol format `fp:<token>:<action>`,
 *   returns neutral fallback:
 *   "محتوى تقني محفوظ؛ تفاصيل الاختيار غير متاحة"
 * - Ordinary prose and malformed/lookalike strings return null (rendered directly).
 */
export function resolveDisplayForMessage(message: {
  senderType: string;
  content: string;
  displayText?: string | null;
  metadata?: unknown;
}): string | null {
  if (message.displayText && message.displayText.trim().length > 0) {
    return message.displayText.trim();
  }

  if (message.metadata && typeof message.metadata === "object") {
    const meta = message.metadata as Record<string, unknown>;
    if (meta.provenance === "TEXT") {
      return null;
    }
  }

  if (
    message.metadata == null &&
    message.senderType === "CUSTOMER" &&
    isOfferProtocolText(message.content)
  ) {
    return HISTORICAL_PROTOCOL_FALLBACK_TEXT;
  }

  return null;
}
