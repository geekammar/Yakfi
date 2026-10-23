/**
 * Telegram Presentation Boundary (CONV-CORE-CHOICE-01).
 *
 * Owns rendering channel-neutral choices into Telegram inline keyboards
 * and parsing Telegram callback queries.
 *
 * Keeps Telegram-specific inline_keyboard markup and callback_data format
 * strictly at the channel boundary. Domain offer and conversation engine
 * do not import or build Telegram API payload structures.
 */
import type {
  BookingOffer,
  DateOffer,
  ProviderOffer,
  ServiceDetailOffer,
  ServiceOffer,
  SlotOffer,
  WelcomeOffer,
} from "@/features/conversations/server/booking-offer";
import {
  buildChannelChoices,
  type ChannelChoicePresentation,
} from "@/features/conversations/server/channel-choice";

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

/**
 * Format callback data for a Telegram button: `fp:<token>:<action>`.
 * Action is a stable id (1-based index or action key). <= 64 bytes.
 */
export function offerCallbackData(
  offer: Pick<BookingOffer, "token">,
  action: number | string,
): string {
  return `fp:${offer.token}:${action}`;
}

export type OfferCallback = {
  readonly token: string;
  readonly action:
    | { kind: "index"; index: number }
    | { kind: "more" | "date" }
    | { kind: "action"; name: string };
};

/**
 * Parse an offer-bound callback (`fp:<token>:<action>`); null otherwise.
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
 * Render a ChannelChoicePresentation into a Telegram InlineKeyboardMarkup.
 */
export function renderTelegramInlineKeyboard(
  presentation: ChannelChoicePresentation,
): TelegramInlineKeyboardMarkup {
  return {
    inline_keyboard: presentation.groups.map((row) =>
      row.map((item) => {
        let text = item.label;
        if (presentation.offerKind === "WELCOME") {
          if (item.id === "book" && !text.includes("📅")) {
            text = `📅 ${text}`;
          } else if (item.id === "inquire" && !text.includes("ℹ️")) {
            text = `ℹ️ ${text}`;
          }
        }
        return {
          text,
          callback_data: offerCallbackData(
            { token: presentation.offerToken },
            item.id,
          ),
        };
      }),
    ),
  };
}

// ─── Direct Offer Keyboards (for backward compatibility / tests) ───────────

export function welcomeOfferKeyboard(
  offer: WelcomeOffer,
): TelegramInlineKeyboardMarkup {
  return renderTelegramInlineKeyboard(buildChannelChoices(offer));
}

export function serviceOfferKeyboard(
  offer: ServiceOffer,
): TelegramInlineKeyboardMarkup {
  return renderTelegramInlineKeyboard(buildChannelChoices(offer));
}

export function serviceDetailKeyboard(
  offer: ServiceDetailOffer,
): TelegramInlineKeyboardMarkup {
  return renderTelegramInlineKeyboard(buildChannelChoices(offer));
}

export function dateOfferKeyboard(
  offer: DateOffer,
): TelegramInlineKeyboardMarkup {
  return renderTelegramInlineKeyboard(buildChannelChoices(offer));
}

export function providerOfferKeyboard(
  offer: ProviderOffer,
): TelegramInlineKeyboardMarkup {
  return renderTelegramInlineKeyboard(buildChannelChoices(offer));
}

export function slotOfferKeyboard(
  offer: SlotOffer,
): TelegramInlineKeyboardMarkup {
  return renderTelegramInlineKeyboard(buildChannelChoices(offer));
}
