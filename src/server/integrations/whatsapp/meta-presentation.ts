/**
 * Meta WhatsApp Cloud API — Interactive Presentation Renderer (CONV-UX-01).
 *
 * Implements authoritative rendering of ChannelChoicePresentation into
 * official Meta WhatsApp interactive message payloads.
 *
 * Official Meta Documentation References:
 * - Interactive Reply Buttons:
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
 * - Interactive List Messages:
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages
 *
 * Invariants:
 * - Preserves exact offer-bound callback IDs: `fp:<offerToken>:<action>`.
 * - Does not silently drop or discard choices.
 * - Enforces verified Meta payload limits:
 *   - Reply button count: <= 3
 *   - Reply button title: <= 20 chars
 *   - Reply button ID: <= 256 chars
 *   - List total rows: <= 10
 *   - List button text: <= 20 chars
 *   - List section title: <= 24 chars
 *   - List row title: <= 24 chars
 *   - List row description: <= 72 chars
 *   - List row ID: <= 200 chars
 *   - Body text: <= 1024 chars
 * - Fails safely on unpresentable layouts (never generates invalid vendor payloads).
 */

import {
  offerCallbackData,
  type ChannelChoiceItem,
  type ChannelChoicePresentation,
} from "@/features/conversations/server/channel-choice";
import { TransportError } from "@/server/transport/whatsapp-transport";

/**
 * Official Meta Cloud API Interactive Constraints.
 * Cites:
 * - https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
 * - https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages
 */
export const META_INTERACTIVE_LIMITS = {
  BODY_MAX_LENGTH: 1024,
  REPLY_BUTTON_MAX_COUNT: 3,
  REPLY_BUTTON_TITLE_MAX_LENGTH: 20,
  REPLY_BUTTON_ID_MAX_LENGTH: 256,
  LIST_MAX_TOTAL_ROWS: 10,
  LIST_BUTTON_TEXT_MAX_LENGTH: 20,
  LIST_SECTION_TITLE_MAX_LENGTH: 24,
  LIST_ROW_TITLE_MAX_LENGTH: 24,
  LIST_ROW_DESCRIPTION_MAX_LENGTH: 72,
  LIST_ROW_ID_MAX_LENGTH: 200,
} as const;

/**
 * Safely slice string by Unicode code points / graphemes without splitting surrogates.
 */
export function safeTruncateGraphemes(text: string, maxLength: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= maxLength) return text.trim();
  return chars.slice(0, maxLength).join("");
}

export type MetaInteractiveReplyButtonPayload = {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: {
    type: "button";
    body: { text: string };
    action: {
      buttons: Array<{
        type: "reply";
        reply: {
          id: string;
          title: string;
        };
      }>;
    };
  };
};

export type MetaInteractiveListPayload = {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: {
    type: "list";
    body: { text: string };
    action: {
      button: string;
      sections: Array<{
        title?: string;
        rows: Array<{
          id: string;
          title: string;
          description?: string;
        }>;
      }>;
    };
  };
};

export type MetaInteractivePayload =
  | MetaInteractiveReplyButtonPayload
  | MetaInteractiveListPayload;

/**
 * Build an offer-bound Meta interactive payload from a ChannelChoicePresentation.
 *
 * Selects Reply Buttons for small presentations (<= 3 buttons, short titles).
 * Selects List Message for presentations with > 3 items or longer labels (up to 10 rows).
 *
 * Throws TransportError(MALFORMED_PROVIDER_PAYLOAD) if presentation cannot fit
 * within Meta limits.
 */
export function renderMetaInteractivePayload(
  to: string,
  content: string,
  presentation: ChannelChoicePresentation,
): MetaInteractivePayload {
  const allItems: ChannelChoiceItem[] = presentation.groups.flat();

  if (allItems.length === 0) {
    throw new TransportError(
      "MALFORMED_PROVIDER_PAYLOAD",
      "لا توجد خيارات متاحة للعرض في رسالة واتساب التفاعلية",
    );
  }

  const bodyText = safeTruncateGraphemes(
    content || "يرجى الاختيار من الخيارات التالية:",
    META_INTERACTIVE_LIMITS.BODY_MAX_LENGTH,
  );

  // Check if eligible for Reply Buttons:
  // <= 3 total choices AND all choice labels fit within the 20-character limit
  const canUseButtons =
    allItems.length <= META_INTERACTIVE_LIMITS.REPLY_BUTTON_MAX_COUNT &&
    allItems.every(
      (item) =>
        Array.from(item.label.trim()).length <=
        META_INTERACTIVE_LIMITS.REPLY_BUTTON_TITLE_MAX_LENGTH,
    );

  if (canUseButtons) {
    const buttons = allItems.map((item) => {
      const id = offerCallbackData(
        { token: presentation.offerToken },
        item.id,
      );
      if (
        Array.from(id).length >
        META_INTERACTIVE_LIMITS.REPLY_BUTTON_ID_MAX_LENGTH
      ) {
        throw new TransportError(
          "MALFORMED_PROVIDER_PAYLOAD",
          `معرّف الخيار يتجاوز الحد الأقصى لأزرار واتساب (${META_INTERACTIVE_LIMITS.REPLY_BUTTON_ID_MAX_LENGTH})`,
        );
      }
      return {
        type: "reply" as const,
        reply: {
          id,
          title: safeTruncateGraphemes(
            item.label,
            META_INTERACTIVE_LIMITS.REPLY_BUTTON_TITLE_MAX_LENGTH,
          ),
        },
      };
    });

    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons },
      },
    };
  }

  // Otherwise, render as List Message
  if (allItems.length > META_INTERACTIVE_LIMITS.LIST_MAX_TOTAL_ROWS) {
    throw new TransportError(
      "MALFORMED_PROVIDER_PAYLOAD",
      `عدد الخيارات المعروضة (${allItems.length}) يتجاوز الحد الأقصى لقوائم واتساب (${META_INTERACTIVE_LIMITS.LIST_MAX_TOTAL_ROWS})`,
    );
  }

  const optionItems = allItems.filter((item) => item.role !== "action");
  const actionItems = allItems.filter((item) => item.role === "action");

  function mapToRow(item: ChannelChoiceItem) {
    const id = offerCallbackData({ token: presentation.offerToken }, item.id);
    if (Array.from(id).length > META_INTERACTIVE_LIMITS.LIST_ROW_ID_MAX_LENGTH) {
      throw new TransportError(
        "MALFORMED_PROVIDER_PAYLOAD",
        `معرّف الخيار يتجاوز الحد الأقصى لقوائم واتساب (${META_INTERACTIVE_LIMITS.LIST_ROW_ID_MAX_LENGTH})`,
      );
    }

    const labelChars = Array.from(item.label.trim());
    let title: string;
    let description: string | undefined;

    if (labelChars.length <= META_INTERACTIVE_LIMITS.LIST_ROW_TITLE_MAX_LENGTH) {
      title = item.label.trim();
    } else {
      title = safeTruncateGraphemes(
        item.label,
        META_INTERACTIVE_LIMITS.LIST_ROW_TITLE_MAX_LENGTH,
      );
      description = safeTruncateGraphemes(
        item.label,
        META_INTERACTIVE_LIMITS.LIST_ROW_DESCRIPTION_MAX_LENGTH,
      );
    }

    return {
      id,
      title,
      ...(description ? { description } : {}),
    };
  }

  const sections: Array<{
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }> = [];

  if (optionItems.length > 0 && actionItems.length > 0) {
    const optionSectionTitle =
      presentation.offerKind === "SLOT"
        ? "المواعيد المتاحة"
        : presentation.offerKind === "DATE"
          ? "التواريخ المتاحة"
          : presentation.offerKind === "PROVIDER"
            ? "مقدمو الخدمة"
            : "الخيارات المتاحة";

    sections.push({
      title: safeTruncateGraphemes(
        optionSectionTitle,
        META_INTERACTIVE_LIMITS.LIST_SECTION_TITLE_MAX_LENGTH,
      ),
      rows: optionItems.map(mapToRow),
    });

    sections.push({
      title: safeTruncateGraphemes(
        "خيارات أخرى",
        META_INTERACTIVE_LIMITS.LIST_SECTION_TITLE_MAX_LENGTH,
      ),
      rows: actionItems.map(mapToRow),
    });
  } else {
    const singleSectionTitle =
      presentation.offerKind === "SERVICE"
        ? "قائمة الخدمات"
        : presentation.offerKind === "DATE"
          ? "التواريخ المتاحة"
          : presentation.offerKind === "SLOT"
            ? "المواعيد المتاحة"
            : "الخيارات المتاحة";

    sections.push({
      title: safeTruncateGraphemes(
        singleSectionTitle,
        META_INTERACTIVE_LIMITS.LIST_SECTION_TITLE_MAX_LENGTH,
      ),
      rows: allItems.map(mapToRow),
    });
  }

  const listButtonLabel = safeTruncateGraphemes(
    "عرض الخيارات",
    META_INTERACTIVE_LIMITS.LIST_BUTTON_TEXT_MAX_LENGTH,
  );

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: listButtonLabel,
        sections,
      },
    },
  };
}
