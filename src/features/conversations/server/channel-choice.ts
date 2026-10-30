/**
 * Channel-neutral choice presentation contract (CONV-CORE-CHOICE-01).
 *
 * Defines the channel-agnostic presentation contract representing what the
 * customer may choose from a persisted offer.
 *
 * Invariants:
 * - Pure data structures: zero Telegram inline_keyboard, zero WhatsApp interactive JSON.
 * - Bound to a persisted BookingOffer snapshot (token, id, kind).
 * - Stable choice IDs (never resolved from visible button labels or unscoped indices).
 * - Compact grouping (rows of options and navigation actions).
 */
import type { BookingOffer } from "./booking-offer";
import {
  areSlotsSingleProvider,
  formatSlotChoiceLabel,
  type AppointmentTimeDisplayPreference,
} from "./presentation-formatters";

export type ChannelChoiceItem = {
  /** Stable action or index key within the offer (e.g. "1", "book", "more"). */
  readonly id: string;
  /** Customer-visible choice label (e.g. "حجز موعد", "أوقات أخرى", "كشف أسنان"). */
  readonly label: string;
  /** Optional underlying domain value (e.g. serviceId, providerId, ISO date, startAt). */
  readonly value?: string | null;
  /** Semantic role: option selection vs secondary navigation/action. */
  readonly role?: "option" | "action";
};

export type ChannelChoicePresentation = {
  /** The persisted offer token (e.g. "offer000"). */
  readonly offerToken: string;
  /** Persisted offer id. */
  readonly offerId: string;
  /** Kind of offer. */
  readonly offerKind: BookingOffer["kind"];
  /** Grid/row layout of choices. */
  readonly groups: ReadonlyArray<ReadonlyArray<ChannelChoiceItem>>;
};

// ─── Offer-Bound Choice Token Codec ─────────────────────────────────────────

export type OfferCallback = {
  readonly token: string;
  readonly action:
    | { kind: "index"; index: number }
    | { kind: "more" | "date" }
    | { kind: "action"; name: string };
};

/**
 * Format a channel-neutral callback identifier for an offer action: `fp:<token>:<action>`.
 * Action is a stable id (1-based index or action key). Compact (<= 64 bytes).
 */
export function offerCallbackData(
  offer: Pick<BookingOffer, "token">,
  action: number | string,
): string {
  return `fp:${offer.token}:${action}`;
}

/**
 * Parse an offer-bound callback token (`fp:<token>:<action>`); null otherwise.
 */
export function parseOfferCallback(text: string): OfferCallback | null {
  const match = text.trim().match(/^fp:([a-z0-9]{6,12}):([a-z0-9_]+)$/);
  if (!match || !match[1] || !match[2]) return null;
  const token = match[1];
  const raw = match[2];
  if (raw === "more" || raw === "date") {
    return { token, action: { kind: raw } };
  }
  if (/^[1-9]\d?$/.test(raw)) {
    return { token, action: { kind: "index", index: Number(raw) } };
  }
  return { token, action: { kind: "action", name: raw } };
}

/**
 * Build a channel-neutral choice presentation from any valid BookingOffer snapshot.
 */
export function buildChannelChoices(
  offer: BookingOffer,
  options?: {
    timeDisplayPreference?: AppointmentTimeDisplayPreference;
  },
): ChannelChoicePresentation {
  switch (offer.kind) {
    case "WELCOME":
      return {
        offerToken: offer.token,
        offerId: offer.id,
        offerKind: offer.kind,
        groups: [
          [{ id: "book", label: "حجز موعد", role: "action" }],
          [{ id: "inquire", label: "استفسار عن خدمة", role: "action" }],
        ],
      };

    case "RESUME":
      return {
        offerToken: offer.token,
        offerId: offer.id,
        offerKind: offer.kind,
        groups: [
          [{ id: "continue", label: "متابعة الطلب", role: "action" }],
          [{ id: "new_request", label: "طلب جديد", role: "action" }],
        ],
      };

    case "SERVICE":
      return {
        offerToken: offer.token,
        offerId: offer.id,
        offerKind: offer.kind,
        groups: offer.options.slice(0, 5).map((option) => [
          {
            id: String(option.index),
            label: `${option.index}️⃣ ${option.name}`,
            value: option.serviceId,
            role: "option" as const,
          },
        ]),
      };

    case "SERVICE_DETAIL":
      return {
        offerToken: offer.token,
        offerId: offer.id,
        offerKind: offer.kind,
        groups: [
          [
            {
              id: "book_service",
              label: "حجز هذه الخدمة",
              value: offer.serviceId,
              role: "action",
            },
          ],
          [
            {
              id: "other_services",
              label: "خدمة أخرى",
              role: "action",
            },
            {
              id: "menu",
              label: "القائمة الرئيسية",
              role: "action",
            },
          ],
        ],
      };

    case "DATE": {
      const rows: Array<Array<ChannelChoiceItem>> = offer.options
        .slice(0, 4)
        .map((option) => [
          {
            id: String(option.index),
            label: `📅 ${option.label}`,
            value: option.date,
            role: "option" as const,
          },
        ]);
      const actionRow: ChannelChoiceItem[] = [];
      if (offer.hasMore) {
        actionRow.push({
          id: "more_dates",
          label: "➡️ مواعيد أخرى",
          role: "action",
        });
      }
      actionRow.push({
        id: "other_date",
        label: offer.range ? "✏️ فترة أخرى" : "✏️ تاريخ آخر",
        role: "action",
      });
      rows.push(actionRow);
      return {
        offerToken: offer.token,
        offerId: offer.id,
        offerKind: offer.kind,
        groups: rows,
      };
    }

    case "PROVIDER":
      return {
        offerToken: offer.token,
        offerId: offer.id,
        offerKind: offer.kind,
        groups: offer.options.map((option) => [
          {
            id: String(option.index),
            label:
              option.providerId === null
                ? "👥 أي مقدم خدمة متاح"
                : `👤 ${option.name}`,
            value: option.providerId,
            role: "option" as const,
          },
        ]),
      };

    case "SLOT": {
      const isSingleProvider = areSlotsSingleProvider(offer.options);
      const pref =
        options?.timeDisplayPreference ??
        offer.timeDisplayPreference ??
        "START_ONLY";
      const slotItems: ChannelChoiceItem[] = offer.options
        .slice(0, 4)
        .map((option) => ({
          id: String(option.index),
          label: formatSlotChoiceLabel(option, isSingleProvider, pref),
          value: option.startAt,
          role: "option" as const,
        }));

      const slotRows: ChannelChoiceItem[][] = [];
      for (let i = 0; i < slotItems.length; i += 2) {
        slotRows.push(slotItems.slice(i, i + 2));
      }

      return {
        offerToken: offer.token,
        offerId: offer.id,
        offerKind: offer.kind,
        groups: [
          ...slotRows,
          [
            {
              id: "more",
              label: "🔄 أوقات أخرى",
              role: "action",
            },
            {
              id: "date",
              label: "📅 يوم آخر",
              role: "action",
            },
          ],
        ],
      };
    }
  }
}
