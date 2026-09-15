import type {
  MessageTransport,
  OutboundMessage,
  TransportSendResult,
} from "@/server/transport/whatsapp-transport";

/**
 * Outbound message transport seam (PROMPT-19; contracts PROMPT-CORE-03A).
 *
 * The canonical provider-neutral transport contracts live in
 * `@/server/transport/whatsapp-transport` — the replaceable boundary the
 * future Meta adapter (PROMPT-CORE-03B) implements. This file re-exports
 * them for the conversations feature and keeps the feature-local offline
 * adapter: a deterministic dev/test transport that logs the message. It
 * is NOT a live WhatsApp integration and never claims to deliver
 * anything; a real provider adapter is a future operator decision (see
 * DECISIONS.md). The interface stays deliberately tiny: one send, one
 * typed result.
 */

export type {
  MessageTransport,
  OutboundMessage,
  TransportSendResult,
} from "@/server/transport/whatsapp-transport";

/**
 * Offline transport (dev/test). Warns about each outbound message (nothing
 * is really delivered to WhatsApp in offline mode) and reports success —
 * honest for local verification, never a live WhatsApp send.
 */
export const offlineMessageTransport: MessageTransport = {
  providerName: "offline",
  async send(message: OutboundMessage): Promise<TransportSendResult> {
    console.warn(
      `[offline-transport] NOT delivered to WhatsApp → ${message.to} (conversation ${message.conversationId}, business ${message.businessName}): ${message.content}`,
    );
    return { provider: "offline", delivered: true };
  },
};
