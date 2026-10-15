/**
 * Provider-neutral inbound message webhook & minimal safe test ingress
 * (PROMPT-19; hardened for controlled operator testing in PROMPT-AI-JEV-03F-I).
 *
 * ONE canonical HTTP entry for an inbound message.
 *
 * Security & Hard Safety Rails (AI-JEV-03F-I):
 *  1. Authenticates caller via secret token header:
 *     `FLOWPILOT_TEST_INGRESS_TOKEN` or `INBOUND_WEBHOOK_TOKEN`
 *     (headers: `x-test-ingress-token`, `x-webhook-token`, or `Bearer`).
 *     Route fails closed (503 WEBHOOK_DISABLED) when no secret is configured.
 *     Fails closed (401 UNAUTHENTICATED) in constant time on token mismatch.
 *  2. HARD SAFETY BOUNDARY: Must target the designated isolated test business
 *     only (`TEST_BUSINESS_PHONE` = `+201005551234`). Any request targeting a
 *     real customer clinic is strictly rejected (403 FORBIDDEN) before touching
 *     the conversation engine or customer data.
 *  3. REAL ENGINE: Handed to the canonical Conversation Engine
 *     (`receiveInboundMessage`), which runs the full authoritative serving
 *     path and non-authoritative JEV Shadow (when enabled).
 *  4. SAFE TRANSPORT: Uses `offlineMessageTransport` — guaranteed ZERO live
 *     outbound WhatsApp or Telegram messages sent to customers.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { inboundMessageSchema } from "@/features/conversations/schemas/conversation-schema";
import {
  defaultConversationEngineDeps,
  receiveInboundMessage,
  type ConversationEngineDeps,
} from "@/features/conversations/server/conversation-engine";
import {
  TEST_BUSINESS_PHONE,
  ensureTestBusiness,
} from "@/features/conversations/server/test-business";
import { env } from "@/lib/env";

import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

/** Constant-time token comparison (hash first: equal-length buffers). */
function tokenMatches(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

function canonicalPhone(phone: string): string {
  return phone.replace(/[\s-]/g, "");
}

function isAuthorized(provided: string, expectedTokens: string[]): boolean {
  if (!provided || expectedTokens.length === 0) return false;
  return expectedTokens.some((expected) => tokenMatches(provided, expected));
}

const TOKEN_HEADER = "x-webhook-token";
const TEST_TOKEN_HEADER = "x-test-ingress-token";

export type InboundRouteDeps = {
  engineDeps: ConversationEngineDeps;
  ensureTestBusiness: () => Promise<unknown>;
  getExpectedTokens?: () => string[];
};

export const defaultInboundRouteDeps: InboundRouteDeps = {
  engineDeps: defaultConversationEngineDeps,
  ensureTestBusiness,
  getExpectedTokens: () =>
    [env.FLOWPILOT_TEST_INGRESS_TOKEN, env.INBOUND_WEBHOOK_TOKEN].filter(
      (t): t is string => Boolean(t),
    ),
};

export async function handleInboundRequest(
  request: Request,
  deps: InboundRouteDeps = defaultInboundRouteDeps,
): Promise<Response> {
  const expectedTokens =
    deps.getExpectedTokens?.() ??
    [env.FLOWPILOT_TEST_INGRESS_TOKEN, env.INBOUND_WEBHOOK_TOKEN].filter(
      (t): t is string => Boolean(t),
    );

  if (expectedTokens.length === 0) {
    return Response.json(
      {
        success: false,
        error: {
          code: "WEBHOOK_DISABLED",
          message:
            "استقبال رسائل الاختبار غير مفعّل — اضبط FLOWPILOT_TEST_INGRESS_TOKEN أولاً",
        },
      },
      { status: 503 },
    );
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : "";
  const providedToken =
    request.headers.get(TEST_TOKEN_HEADER) ??
    request.headers.get(TOKEN_HEADER) ??
    bearerToken ??
    "";

  if (!providedToken || !isAuthorized(providedToken, expectedTokens)) {
    return Response.json(
      {
        success: false,
        error: { code: "UNAUTHENTICATED", message: "رمز التحقق غير صالح" },
      },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        success: false,
        error: { code: "VALIDATION", message: "المحتوى غير صالح" },
      },
      { status: 400 },
    );
  }

  const rawPayload =
    body && typeof body === "object"
      ? {
          receivedAt: new Date().toISOString(),
          ...(body as Record<string, unknown>),
        }
      : body;

  const parsed = inboundMessageSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return Response.json(
      {
        success: false,
        error: {
          code: "VALIDATION",
          message: "بيانات الرسالة الواردة غير صالحة",
        },
      },
      { status: 400 },
    );
  }

  // Hard safety boundary: test ingress must only target the isolated test business.
  const targetPhone = canonicalPhone(parsed.data.to);
  const allowedTestPhone = canonicalPhone(TEST_BUSINESS_PHONE);
  if (targetPhone !== allowedTestPhone) {
    return Response.json(
      {
        success: false,
        error: {
          code: "FORBIDDEN",
          message:
            "منفذ الاختبار محمي ومخصص لمنشأة الاختبار فقط — لا يمكن استهداف منشأة حقيقية",
        },
      },
      { status: 403 },
    );
  }

  // Ensure isolated test business exists in DB
  try {
    await deps.ensureTestBusiness();
  } catch (err) {
    console.error("[test-ingress] Failed to ensure test business:", err);
    return Response.json(
      {
        success: false,
        error: {
          code: "PERSISTENCE_FAILED",
          message: "تعذر التحقق من منشأة الاختبار",
        },
      },
      { status: 500 },
    );
  }

  const result = await receiveInboundMessage(deps.engineDeps, parsed.data);

  if (result.ok) {
    // Expose the resulting conversation state to the existing UI (best-effort).
    try {
      revalidatePath("/conversations");
      revalidatePath(`/conversations/${result.conversationId}`);
      revalidatePath("/");
      revalidatePath("/staff");
    } catch {
      // Revalidation is best-effort (e.g. running in test context outside Next store).
    }
    return Response.json({ success: true, result });
  }

  const statusByCode = {
    VALIDATION: 400,
    BUSINESS_NOT_FOUND: 404,
    BUSINESS_INACTIVE: 403,
    PERSISTENCE_FAILED: 500,
  } as const;

  return Response.json(
    {
      success: false,
      error: { code: result.code, message: result.message },
    },
    { status: statusByCode[result.code] },
  );
}

export async function POST(request: Request) {
  return handleInboundRequest(request, defaultInboundRouteDeps);
}
