import { createHash, randomUUID } from "node:crypto";

import { invalidateConversationOffer } from "@/features/conversations/server/conversation-state-store";
import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import { db } from "@/server/db";
import {
  resolveTelegramBotToken,
  telegramSendMessage,
  type TelegramApiDeps,
} from "@/server/integrations/telegram/telegram-client";
import {
  defaultTelegramTransportDeps,
  resolveTelegramConnectionForSend,
} from "@/server/integrations/telegram/telegram-transport";
import {
  conversationStateRepository,
  telegramConnectionRepository,
  type TelegramConnectionRepository,
} from "@/server/repositories";
import type { StaffReplySubmission } from "@/types/domain";

/**
 * ISS-018: Safe Telegram Staff Reply Delivery
 *
 * Implements server-authoritative route verification, durable submission
 * claiming before network dispatch, and truthful typed outcomes:
 *  - unroutable
 *  - in-progress
 *  - accepted
 *  - definite_rejection
 *  - unknown
 */

export type RouteResolutionResult =
  | {
      routable: true;
      route: {
        channel: "telegram";
        connectionId: string;
        botExternalId: string;
        recipientExternalId: string;
        credentialsRef: string;
      };
    }
  | {
      routable: false;
      outcome: "unroutable";
      code: string;
      reason: string;
    };

export type StaffReplyDeliveryDeps = {
  api?: TelegramApiDeps;
  connectionRepository?: Pick<
    TelegramConnectionRepository,
    "findByIdWithinBusiness"
  >;
  credentialsResolver?: CredentialsResolver;
  now?: () => Date;
  onBeforeResultWrite?: () => Promise<void> | void;
};

export type SubmitStaffReplyParams = {
  businessId: string;
  conversationId: string;
  staffUserId: string;
  content: string;
  clientSubmissionId?: string;
  deps?: StaffReplyDeliveryDeps;
};

export type SubmitStaffReplyResult =
  | {
      ok: true;
      outcome: "accepted";
      messageId: string;
    }
  | {
      ok: false;
      outcome: "unroutable" | "in-progress" | "definite_rejection" | "unknown";
      code?: string;
      message: string;
    };

function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Step 1: Establish route authority before wiring dispatch.
 * Checks ConversationDeliveryRoute and cross-validates against InboundMessageDedupe
 * to detect foreign/inactive connections, missing routes, or conflicting bots/channels.
 */
export async function resolveConversationRoute(
  conversationId: string,
  businessId: string,
  deps: Pick<
    StaffReplyDeliveryDeps,
    "connectionRepository" | "credentialsResolver"
  > = {},
): Promise<RouteResolutionResult> {
  // 1. Look up the bound route for this thread
  const route = await db.conversationDeliveryRoute.findUnique({
    where: { conversationId },
  });

  if (!route || route.businessId !== businessId) {
    return {
      routable: false,
      outcome: "unroutable",
      code: "MISSING_ROUTE",
      reason: "لا يمكن تحديد مسار الإرسال المعتمد لهذه المحادثة",
    };
  }

  if (route.channel !== "telegram") {
    return {
      routable: false,
      outcome: "unroutable",
      code: "UNSUPPORTED_CHANNEL",
      reason: "قناة الإرسال غير مدعومة",
    };
  }

  // 2. Cross-check InboundMessageDedupe to ensure no conflicting ingress
  // (e.g. from WhatsApp wamid or another Telegram bot on the same thread)
  const conflictingDedupe = await db.inboundMessageDedupe.findFirst({
    where: {
      businessId,
      conversationId,
      customerMessageId: { not: null },
      NOT: {
        externalKey: {
          startsWith: `tg:${route.botExternalId}:`,
        },
      },
    },
  });

  if (conflictingDedupe) {
    return {
      routable: false,
      outcome: "unroutable",
      code: "CONFLICTING_ROUTE",
      reason: "تعارض في أدلة مسار الإرسال لهذه المحادثة",
    };
  }

  // 3. Tenant-scoped Telegram connection validation
  const connRepo = deps.connectionRepository ?? telegramConnectionRepository;
  const connectionResolution = await resolveTelegramConnectionForSend(
    { connectionRepository: connRepo },
    { connectionId: route.connectionId, businessId },
  );

  if (!connectionResolution.ok) {
    return {
      routable: false,
      outcome: "unroutable",
      code: connectionResolution.code,
      reason: connectionResolution.message,
    };
  }

  const connection = await connRepo.findByIdWithinBusiness(
    route.connectionId,
    businessId,
  );
  if (!connection || connection.botExternalId !== route.botExternalId) {
    return {
      routable: false,
      outcome: "unroutable",
      code: "BOT_MISMATCH",
      reason: "معرّف البوت غير مطابق للاتصال المعتمد",
    };
  }

  return {
    routable: true,
    route: {
      channel: "telegram",
      connectionId: route.connectionId,
      botExternalId: route.botExternalId,
      recipientExternalId: route.recipientExternalId,
      credentialsRef: connectionResolution.credentialsRef,
    },
  };
}

export type SubmissionClaimResult =
  | {
      claimed: true;
      submission: StaffReplySubmission;
    }
  | {
      claimed: false;
      outcome: "in-progress" | "accepted" | "definite_rejection" | "unknown";
      code?: string;
      message: string;
      messageId?: string;
    };

/**
 * Step 2: Durably claim submission before calling provider.
 * Binds key to payload and business/thread. Deduplicates concurrent / replayed attempts.
 */
export async function claimStaffReplySubmission(params: {
  businessId: string;
  conversationId: string;
  submissionKey: string;
  payloadHash: string;
  content: string;
}): Promise<SubmissionClaimResult> {
  try {
    const submission = await db.staffReplySubmission.create({
      data: {
        businessId: params.businessId,
        conversationId: params.conversationId,
        submissionKey: params.submissionKey,
        payloadHash: params.payloadHash,
        content: params.content,
        status: "CLAIMED",
        provider: "telegram",
      },
    });
    return { claimed: true, submission };
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      const existing = await db.staffReplySubmission.findUnique({
        where: {
          businessId_conversationId_submissionKey: {
            businessId: params.businessId,
            conversationId: params.conversationId,
            submissionKey: params.submissionKey,
          },
        },
      });

      if (!existing) {
        throw error;
      }

      // Check payload binding: same key with different payload must definitely reject
      if (existing.payloadHash !== params.payloadHash) {
        return {
          claimed: false,
          outcome: "definite_rejection",
          code: "PAYLOAD_MISMATCH",
          message: "معرّف الإرسال مستخدم مسبقاً بنص مختلف",
        };
      }

      // Replayed or concurrent submission: return existing outcome with 0 network calls
      if (existing.status === "CLAIMED") {
        return {
          claimed: false,
          outcome: "in-progress",
          code: "IN_PROGRESS",
          message: "الطلب قيد المعالجة حالياً",
        };
      }

      if (existing.status === "ACCEPTED") {
        return {
          claimed: false,
          outcome: "accepted",
          messageId: existing.providerMessageId ?? "",
          message: "تم إرسال الرد بنجاح",
        };
      }

      if (existing.status === "REJECTED") {
        return {
          claimed: false,
          outcome: "definite_rejection",
          code: existing.errorCode ?? "REJECTED",
          message: existing.errorMessage ?? "تم رفض الإرسال من مزود الخدمة",
        };
      }

      // UNCONFIRMED
      return {
        claimed: false,
        outcome: "unknown",
        code: existing.errorCode ?? "UNCONFIRMED",
        message: existing.errorMessage ?? "تعذر تأكيد تسليم الرد سابقاً",
      };
    }
    throw error;
  }
}

/**
 * Main staff reply submission coordinator.
 * Server-authoritative route check -> durable claim -> provider call -> truthful outcome persistence.
 */
export async function submitStaffReply(
  params: SubmitStaffReplyParams,
): Promise<SubmitStaffReplyResult> {
  const text = params.content.trim();
  if (!text) {
    return {
      ok: false,
      outcome: "definite_rejection",
      code: "EMPTY_CONTENT",
      message: "اكتب رسالة أولاً",
    };
  }

  const deps = params.deps ?? {};
  const api = deps.api ?? defaultTelegramTransportDeps.api;
  const credentialsResolver =
    deps.credentialsResolver ?? defaultCredentialsResolver;
  const connectionRepo =
    deps.connectionRepository ?? telegramConnectionRepository;

  // 1. Establish route authority before wiring dispatch
  const routeResolution = await resolveConversationRoute(
    params.conversationId,
    params.businessId,
    { connectionRepository: connectionRepo, credentialsResolver },
  );

  if (!routeResolution.routable) {
    return {
      ok: false,
      outcome: "unroutable",
      code: routeResolution.code,
      message: routeResolution.reason,
    };
  }

  const route = routeResolution.route;

  // 2. Durably claim the submission before calling the provider
  const submissionKey =
    params.clientSubmissionId && params.clientSubmissionId.trim().length > 0
      ? params.clientSubmissionId.trim()
      : randomUUID();

  const payloadHash = createHash("sha256").update(text).digest("hex");

  const claimResult = await claimStaffReplySubmission({
    businessId: params.businessId,
    conversationId: params.conversationId,
    submissionKey,
    payloadHash,
    content: text,
  });

  if (!claimResult.claimed) {
    if (claimResult.outcome === "accepted") {
      return {
        ok: true,
        outcome: "accepted",
        messageId: claimResult.messageId ?? "",
      };
    }
    return {
      ok: false,
      outcome: claimResult.outcome,
      code: claimResult.code,
      message: claimResult.message,
    };
  }

  const submission = claimResult.submission;

  // 3. Resolve bot credentials
  const tokenResolution = await resolveTelegramBotToken(
    { credentialsResolver },
    route.credentialsRef,
  );

  if (!tokenResolution.ok) {
    await db.staffReplySubmission.update({
      where: { id: submission.id },
      data: {
        status: "UNCONFIRMED",
        errorCode: tokenResolution.error.code,
        errorMessage: tokenResolution.error.message,
      },
    });
    return {
      ok: false,
      outcome: "unknown",
      code: tokenResolution.error.code,
      message: tokenResolution.error.message,
    };
  }

  // 4. Dispatch to provider (physical wire call: 1 attempt)
  let sendResult;
  try {
    sendResult = await telegramSendMessage(api, tokenResolution.token, {
      chatId: route.recipientExternalId,
      text,
    });
  } catch {
    // Network / unhandled client failure before or during transmission.
    // Safe typed error: never leak raw transport/network/credential details.
    const safeErrorMsg = "تعذر تأكيد تسليم الرد بسبب انقطاع الاتصال بمزود الخدمة";
    await db.staffReplySubmission.update({
      where: { id: submission.id },
      data: {
        status: "UNCONFIRMED",
        errorCode: "TRANSIENT_TRANSPORT_FAILURE",
        errorMessage: safeErrorMsg,
      },
    });
    return {
      ok: false,
      outcome: "unknown",
      code: "TRANSIENT_TRANSPORT_FAILURE",
      message: safeErrorMsg,
    };
  }

  // 5. Handle provider outcome
  if (!sendResult.ok) {
    // Definite permanent rejections: 400 Bad Request, 403 Forbidden, 404 Not Found, etc.
    const isDefiniteRejection =
      sendResult.error.code === "PERMANENT_TRANSPORT_FAILURE" ||
      sendResult.error.code === "UNAUTHORIZED_CREDENTIALS";

    if (isDefiniteRejection) {
      await db.staffReplySubmission.update({
        where: { id: submission.id },
        data: {
          status: "REJECTED",
          completedAt: new Date(),
          errorCode: sendResult.error.code,
          errorMessage: sendResult.error.message,
        },
      });
      return {
        ok: false,
        outcome: "definite_rejection",
        code: sendResult.error.code,
        message: sendResult.error.message,
      };
    }

    // 5xx, timeout, or rate-limited: provider may have received it before connection drop.
    // Must leave UNCONFIRMED and DO NOT auto-resend.
    await db.staffReplySubmission.update({
      where: { id: submission.id },
      data: {
        status: "UNCONFIRMED",
        completedAt: new Date(),
        errorCode: sendResult.error.code,
        errorMessage: sendResult.error.message,
      },
    });
    return {
      ok: false,
      outcome: "unknown",
      code: sendResult.error.code,
      message: sendResult.error.message,
    };
  }

  // Provider accepted!
  // Test hook for simulating result write failure
  if (deps.onBeforeResultWrite) {
    try {
      await deps.onBeforeResultWrite();
    } catch {
      await db.staffReplySubmission.update({
        where: { id: submission.id },
        data: {
          status: "UNCONFIRMED",
          completedAt: new Date(),
          providerMessageId: String(sendResult.result.message_id),
          errorCode: "RESULT_WRITE_FAILURE",
          errorMessage: "تعذر حفظ نتيجة الإرسال في قاعدة البيانات",
        },
      });
      return {
        ok: false,
        outcome: "unknown",
        code: "RESULT_WRITE_FAILURE",
        message: "تعذر تأكيد حفظ نتيجة الإرسال",
      };
    }
  }

  // 6. Persist accepted outcome + message row in the same transaction
  try {
    const providerMessageId = String(sendResult.result.message_id);

    await db.$transaction(async (tx) => {
      // 1. Create STAFF message in conversation
      const message = await tx.message.create({
        data: {
          conversationId: params.conversationId,
          senderType: "STAFF",
          content: text,
        },
      });

      // 2. Update conversation: preserve assigned user if already owned
      const conv = await tx.conversation.findUnique({
        where: { id: params.conversationId },
        select: { assignedUserId: true },
      });

      await tx.conversation.update({
        where: { id: params.conversationId },
        data: {
          lastMessageAt: message.createdAt,
          status: "NEED_HUMAN",
          ...(conv?.assignedUserId
            ? {}
            : { assignedUserId: params.staffUserId }),
        },
      });

      // 3. Mark submission ACCEPTED
      await tx.staffReplySubmission.update({
        where: { id: submission.id },
        data: {
          status: "ACCEPTED",
          completedAt: new Date(),
          providerMessageId,
          staffMessageId: message.id,
        },
      });
    });

    // Best-effort assistant offer invalidation
    await invalidateConversationOffer(conversationStateRepository, {
      businessId: params.businessId,
      conversationId: params.conversationId,
    });

    return {
      ok: true,
      outcome: "accepted",
      messageId: providerMessageId,
    };
  } catch {
    // Acceptance followed by result write failure!
    // Leave outcome UNCONFIRMED, never auto-resend.
    try {
      await db.staffReplySubmission.update({
        where: { id: submission.id },
        data: {
          status: "UNCONFIRMED",
          completedAt: new Date(),
          providerMessageId: String(sendResult.result.message_id),
          errorCode: "RESULT_WRITE_FAILURE",
          errorMessage: "تعذر حفظ نتيجة الإرسال في قاعدة البيانات",
        },
      });
    } catch {
      // Submission remains in DB
    }

    return {
      ok: false,
      outcome: "unknown",
      code: "RESULT_WRITE_FAILURE",
      message: "تعذر تأكيد حفظ نتيجة الإرسال",
    };
  }
}
