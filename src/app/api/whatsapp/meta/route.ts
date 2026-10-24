import {
  defaultConversationEngineDeps,
  receiveInboundMessage,
} from "@/features/conversations/server/conversation-engine";
import { env } from "@/lib/env";
import { createDefaultMetaWhatsAppTransport } from "@/server/integrations/whatsapp/meta-client";
import {
  parseMetaWebhookPayload,
  verifyMetaSignature,
  verifyMetaWebhookChallenge,
} from "@/server/integrations/whatsapp/meta-webhook";
import {
  branchRepository,
  businessRepository,
  whatsAppConnectionRepository,
} from "@/server/repositories";
import {
  TransportError,
  resolveInboundConnection,
  toEngineInboundMessage,
} from "@/server/transport/whatsapp-transport";

import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

/**
 * The provider adapter owns its outbound transport: the Meta route
 * supplies the Meta-backed `MessageTransport` (live Graph send) to the
 * canonical engine. The engine's own default stays offline, so no
 * non-Meta entry point gains a live WhatsApp sender.
 */
const metaEngineDeps = {
  ...defaultConversationEngineDeps,
  transport: createDefaultMetaWhatsAppTransport(),
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = verifyMetaWebhookChallenge(
    {
      mode: url.searchParams.get("hub.mode"),
      token: url.searchParams.get("hub.verify_token"),
      challenge: url.searchParams.get("hub.challenge"),
    },
    env.WHATSAPP_META_VERIFY_TOKEN,
  );
  if (!result.ok) {
    return new Response(null, { status: result.status });
  }
  return new Response(result.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export type MetaPostConfig = {
  appSecret?: string;
  resolutionDeps?: {
    businessRepository: typeof businessRepository;
    whatsappConnectionRepository: typeof whatsAppConnectionRepository;
    branchRepository: typeof branchRepository;
  };
  engineDeps?: Parameters<typeof receiveInboundMessage>[0];
  revalidateFn?: (path: string) => void;
};

export async function handleMetaPost(
  request: Request,
  config?: MetaPostConfig,
): Promise<Response> {
  const appSecret = config?.appSecret ?? env.WHATSAPP_META_APP_SECRET;
  if (!appSecret) {
    return Response.json(
      {
        success: false,
        error: { code: "UNAUTHENTICATED", message: "توقيع الويبهوك غير صالح" },
      },
      { status: 403 },
    );
  }

  const rawBody = await request.text();
  const signatureHeader =
    request.headers.get("x-hub-signature-256") ??
    request.headers.get("X-Hub-Signature-256");

  if (!verifyMetaSignature(rawBody, signatureHeader, appSecret)) {
    return Response.json(
      {
        success: false,
        error: { code: "UNAUTHENTICATED", message: "توقيع الويبهوك غير صالح" },
      },
      { status: 403 },
    );
  }

  let json: unknown;
  try {
    json = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return Response.json(
      {
        success: false,
        error: { code: "VALIDATION", message: "حمولة مزود واتساب غير صالحة" },
      },
      { status: 400 },
    );
  }

  let parsed: ReturnType<typeof parseMetaWebhookPayload>;
  try {
    parsed = parseMetaWebhookPayload(json);
  } catch (error) {
    if (error instanceof TransportError) {
      return Response.json(
        {
          success: false,
          error: { code: error.code, message: error.message },
        },
        { status: 400 },
      );
    }
    return Response.json(
      {
        success: false,
        error: { code: "VALIDATION", message: "حمولة مزود واتساب غير صالحة" },
      },
      { status: 400 },
    );
  }

  if (parsed.messages.length === 0) {
    return Response.json({
      success: true,
      received: 0,
      statuses: parsed.statusCount,
    });
  }

  const resolutionDeps = config?.resolutionDeps ?? {
    businessRepository,
    whatsappConnectionRepository: whatsAppConnectionRepository,
    branchRepository,
  };

  const results: Array<{
    externalId: string;
    ok: boolean;
    duplicate?: boolean;
    code?: string;
  }> = [];

  for (const message of parsed.messages) {
    const resolution = await resolveInboundConnection(
      resolutionDeps,
      message.recipientExternalId,
      message.recipientProviderId,
    );

    if (!resolution.ok) {
      results.push({
        externalId: message.externalMessageId,
        ok: false,
        code: resolution.code,
      });
      continue;
    }

    let engineInput: ReturnType<typeof toEngineInboundMessage>;
    try {
      engineInput = toEngineInboundMessage({
        ...message,
        connectionId: resolution.connectionId,
        businessId: resolution.businessId,
        branchId: resolution.branchId,
      });
    } catch (error) {
      if (
        error instanceof TransportError &&
        error.code === "UNSUPPORTED_MESSAGE_TYPE"
      ) {
        results.push({
          externalId: message.externalMessageId,
          ok: true,
          code: "UNSUPPORTED_MESSAGE_TYPE",
        });
        continue;
      }
      results.push({
        externalId: message.externalMessageId,
        ok: false,
        code: error instanceof TransportError ? error.code : "VALIDATION",
      });
      continue;
    }

    const engineResult = await receiveInboundMessage(
      config?.engineDeps ?? metaEngineDeps,
      engineInput,
      {
        businessId: resolution.businessId,
        branchId: resolution.branchId,
        connectionId: resolution.connectionId,
      },
    );

    if (engineResult.ok) {
      if (engineResult.duplicate) {
        results.push({
          externalId: message.externalMessageId,
          ok: true,
          duplicate: true,
        });
      } else {
        results.push({
          externalId: message.externalMessageId,
          ok: true,
          duplicate: false,
        });
      }
    } else {
      results.push({
        externalId: message.externalMessageId,
        ok: false,
        code: engineResult.code,
      });
    }
  }

  const revalidate = config?.revalidateFn ?? revalidatePath;
  try {
    revalidate("/conversations");
    revalidate("/");
    revalidate("/staff");
  } catch {
    // Next.js revalidatePath may throw in standalone test harness environments
  }

  const hasFailure = results.some((r) => !r.ok);
  return Response.json({
    success: !hasFailure,
    received: parsed.messages.length,
    statuses: parsed.statusCount,
    results,
  });
}

export async function POST(request: Request) {
  return handleMetaPost(request);
}
