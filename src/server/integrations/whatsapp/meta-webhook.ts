import { createHmac, timingSafeEqual } from "node:crypto";

import {
  TransportError,
  normalizeInboundTransportMessage,
  type NormalizedInboundTransportMessage,
} from "@/server/transport/whatsapp-transport";

// ─── Webhook verification (GET) ────────────────────────────────────────────

/**
 * Meta webhook verification handshake (GET).
 *
 * Meta sends:  GET ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
 * We respond:  200 <challenge>  when mode=subscribe and token matches.
 * Otherwise:   403.
 *
 * Spec: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export type VerifyParams = {
  mode: string | null;
  token: string | null;
  challenge: string | null;
};

export function verifyMetaWebhookChallenge(
  params: VerifyParams,
  expectedVerifyToken: string | undefined,
): { ok: true; challenge: string } | { ok: false; status: number } {
  if (!expectedVerifyToken) return { ok: false, status: 403 };
  if (params.mode !== "subscribe") return { ok: false, status: 403 };
  if (params.token !== expectedVerifyToken) return { ok: false, status: 403 };
  if (!params.challenge) return { ok: false, status: 400 };
  return { ok: true, challenge: params.challenge };
}

// ─── Signature validation (POST) ───────────────────────────────────────────

/**
 * Validates the `X-Hub-Signature-256` header against the raw request body
 * using HMAC-SHA256 with the Meta App Secret.
 *
 * When no app secret is configured (local/dev), validation is skipped
 * and the call succeeds — the inbound tenancy + idempotency boundaries
 * still protect the Core. In production the secret MUST be set.
 *
 * Header: `sha256=<hex>`
 * Computed: `sha256=` + hex(HMAC-SHA256(rawBody, appSecret))
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret) return true;
  if (!signatureHeader) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const providedHex = signatureHeader.slice(prefix.length);
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  if (provided.length !== 32) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// ─── Meta inbound payload → normalized messages ────────────────────────────

/**
 * Minimal Meta webhook payload shape we care about.
 * We intentionally parse only the fields required by the transport contract;
 * everything else is ignored.
 */
type MetaTextMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string };
  audio?: { id?: string; mime_type?: string };
  video?: { id?: string; mime_type?: string };
  document?: { id?: string; mime_type?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
};

type MetaWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      field?: string;
      value?: {
        messaging_product?: string;
        metadata?: {
          display_phone_number?: string;
          phone_number_id?: string;
        };
        contacts?: Array<{ wa_id?: string }>;
        messages?: MetaTextMessage[];
        statuses?: unknown[];
      };
    }>;
  }>;
};

export type ParsedMetaInbound = {
  messages: NormalizedInboundTransportMessage[];
  rawMessageCount: number;
  statusCount: number;
};

/**
 * Parse a Meta webhook JSON body into zero or more normalized inbound
 * messages. Non-text messages are mapped to the normalized MEDIA/UNSUPPORTED
 * kinds so the caller can route them correctly. Status callbacks are
 * counted and ignored (no side effect).
 *
 * Throws TransportError(MALFORMED_PROVIDER_PAYLOAD) on a structurally
 * invalid payload, or UnsupportedType via the normalized kind.
 */
export function parseMetaWebhookPayload(raw: unknown): ParsedMetaInbound {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TransportError(
      "MALFORMED_PROVIDER_PAYLOAD",
      "حمولة مزود واتساب غير صالحة",
    );
  }
  const payload = raw as MetaWebhookPayload;
  if (payload.object !== "whatsapp_business_account") {
    throw new TransportError(
      "MALFORMED_PROVIDER_PAYLOAD",
      "كائن حمولة واتساب غير متوقع",
    );
  }
  if (!Array.isArray(payload.entry)) {
    throw new TransportError(
      "MALFORMED_PROVIDER_PAYLOAD",
      "بنية الإدخال في حمولة واتساب غير صالحة",
    );
  }

  const messages: NormalizedInboundTransportMessage[] = [];
  let rawMessageCount = 0;
  let statusCount = 0;

  for (const entry of payload.entry) {
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      const value = change?.value;
      if (!value) continue;
      if (Array.isArray(value.statuses)) statusCount += value.statuses.length;
      const metaMessages = value.messages;
      if (!Array.isArray(metaMessages)) continue;
      const recipientNumber = value.metadata?.display_phone_number ?? "";
      // The STABLE receiving identity (Meta phone_number_id) — the
      // display number is only a label and may not match its stored
      // format. Kept as a normalized lookup key for connection
      // resolution; never trusted as tenant identity by itself.
      const recipientProviderId = value.metadata?.phone_number_id ?? "";
      for (const meta of metaMessages) {
        rawMessageCount += 1;
        if (!meta.from || !meta.id || !meta.timestamp || !meta.type) {
          throw new TransportError(
            "MALFORMED_PROVIDER_PAYLOAD",
            "حقول الرسالة الواردة ناقصة",
          );
        }
        const providerTimestampMs = Number(meta.timestamp) * 1000;
        if (!Number.isFinite(providerTimestampMs)) {
          throw new TransportError(
            "MALFORMED_PROVIDER_PAYLOAD",
            "زمن الرسالة غير صالح",
          );
        }
        const isoTimestamp = new Date(providerTimestampMs).toISOString();

        const kind =
          meta.type === "text" || meta.type === "interactive"
            ? "TEXT"
            : meta.type === "image" ||
                meta.type === "audio" ||
                meta.type === "video" ||
                meta.type === "document" ||
                meta.type === "sticker"
              ? "MEDIA"
              : "UNSUPPORTED";

        const normalizedInput: Record<string, unknown> = {
          externalMessageId: meta.id,
          senderExternalId: meta.from,
          recipientExternalId: recipientNumber || meta.from,
          timestamp: isoTimestamp,
          kind,
        };
        if (recipientProviderId) {
          normalizedInput.recipientProviderId = recipientProviderId;
        }
        if (kind === "TEXT") {
          const body =
            meta.type === "interactive"
              ? meta.interactive?.button_reply?.title ||
                meta.interactive?.button_reply?.id ||
                meta.interactive?.list_reply?.title ||
                meta.interactive?.list_reply?.id
              : meta.text?.body;
          if (!body || typeof body !== "string" || !body.trim()) {
            throw new TransportError(
              "MALFORMED_PROVIDER_PAYLOAD",
              "نص الرسالة النصية مفقود",
            );
          }
          normalizedInput.text = body;
        } else if (kind === "MEDIA") {
          const locator =
            meta.image?.id ??
            meta.audio?.id ??
            meta.video?.id ??
            meta.document?.id ??
            meta.id;
          const mime =
            meta.image?.mime_type ??
            meta.audio?.mime_type ??
            meta.video?.mime_type ??
            meta.document?.mime_type ??
            "application/octet-stream";
          normalizedInput.media = {
            mimeType: mime,
            externalReference: locator,
          };
        }

        const result = normalizeInboundTransportMessage(normalizedInput);
        if (!result.ok) throw result.error;
        messages.push(result.message);
      }
    }
  }

  return { messages, rawMessageCount, statusCount };
}
