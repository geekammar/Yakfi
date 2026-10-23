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

/**
 * Build a channel-neutral choice presentation from any valid BookingOffer snapshot.
 */
export function buildChannelChoices(
  offer: BookingOffer,
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
      rows.push([
        {
          id: "other_date",
          label: "✏️ تاريخ آخر",
          role: "action",
        },
      ]);
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
      const slotRow: ChannelChoiceItem[] = offer.options
        .slice(0, 3)
        .map((option) => {
          const time = option.startAt.slice(11, 16);
          const provider = option.displayName ? ` (${option.displayName})` : "";
          return {
            id: String(option.index),
            label: `${option.index}️⃣ ${time}${provider}`,
            value: option.startAt,
            role: "option" as const,
          };
        });
      return {
        offerToken: offer.token,
        offerId: offer.id,
        offerKind: offer.kind,
        groups: [
          slotRow,
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
