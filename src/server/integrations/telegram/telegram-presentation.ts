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
  DateOffer,
  ProviderOffer,
  ServiceDetailOffer,
  ServiceOffer,
  SlotOffer,
  WelcomeOffer,
} from "@/features/conversations/server/booking-offer";
import {
  buildChannelChoices,
  offerCallbackData,
  parseOfferCallback,
  type ChannelChoicePresentation,
  type OfferCallback,
} from "@/features/conversations/server/channel-choice";

export { offerCallbackData, parseOfferCallback, type OfferCallback };

export type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

export type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

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
