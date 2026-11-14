"use server";

import {
  assignConversationSchema,
  checkReplyStatusSchema,
  replySchema,
  summarySchema,
  transitionConversationSchema,
} from "@/features/conversations/schemas/conversation-schema";
import { invalidateConversationOffer } from "@/features/conversations/server/conversation-state-store";
import {
  lookupStaffReplyStatus,
  submitStaffReply,
} from "@/features/conversations/server/staff-reply-delivery";
import type {
  ConversationActionResult,
  StaffReplyActionResult,
  StaffReplyStatusActionResult,
} from "@/features/conversations/types";
import { requireUser } from "@/server/auth/guards";
import {
  conversationRepository,
  conversationStateRepository,
  operatorAttentionRepository,
  userRepository,
} from "@/server/repositories";

import { revalidatePath } from "next/cache";

async function actionContext(conversationId: string) {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  if (!user?.businessId) return null;
  const businessId = user.businessId;
  const conversation = await conversationRepository.findById(conversationId);
  if (!conversation || conversation.businessId !== businessId) return null;
  // `businessId` is narrowed to string here so callers (and the operator-
  // attention seam) get a non-nullable tenant scope — still always the
  // session's Business, never client input.
  return { user, conversation, businessId };
}

function failure(message: string): ConversationActionResult {
  return { success: false, message };
}

/**
 * CONV-CORE-01 — a human now owns the thread: the assistant's current booking
 * offer stops being selectable (best-effort; never fails the staff action).
 */
async function invalidateAssistantOffer(businessId: string, id: string) {
  await invalidateConversationOffer(conversationStateRepository, {
    businessId,
    conversationId: id,
  });
}

function refreshConversation(id: string) {
  revalidatePath("/conversations");
  revalidatePath(`/conversations/${id}`);
  revalidatePath("/");
  revalidatePath("/staff");
}

export async function assignConversation(
  input: unknown,
): Promise<ConversationActionResult> {
  const parsed = assignConversationSchema.safeParse(input);
  if (!parsed.success) return failure("تعذر تعيين المحادثة");
  const context = await actionContext(parsed.data.id);
  if (!context) return failure("المحادثة غير موجودة");

  if (parsed.data.assignedUserId) {
    const assignee = await userRepository.findById(parsed.data.assignedUserId);
    if (
      !assignee?.isActive ||
      assignee.businessId !== context.user.businessId
    ) {
      return failure("عضو الفريق غير متاح");
    }
  }

  try {
    await conversationRepository.updateWorkflow(parsed.data.id, {
      assignedUserId: parsed.data.assignedUserId,
      ...(parsed.data.assignedUserId ? { status: "NEED_HUMAN" } : {}),
    });
    if (parsed.data.assignedUserId) {
      await invalidateAssistantOffer(context.businessId, parsed.data.id);
    }
    refreshConversation(parsed.data.id);
    return { success: true };
  } catch {
    return failure("تعذر تعيين المحادثة الآن");
  }
}

export async function transitionConversation(
  input: unknown,
): Promise<ConversationActionResult> {
  const parsed = transitionConversationSchema.safeParse(input);
  if (!parsed.success) return failure("الإجراء غير صالح");
  const context = await actionContext(parsed.data.id);
  if (!context) return failure("المحادثة غير موجودة");

  const transitions = {
    TAKE_OVER: {
      status: "NEED_HUMAN" as const,
      assignedUserId: context.user.id,
    },
    RETURN_TO_AI: {
      status: "AI_ACTIVE" as const,
      assignedUserId: null,
    },
    MARK_BOOKED: { status: "BOOKED" as const },
    HANDOFF: { status: "NEED_HUMAN" as const, assignedUserId: null },
  };

  try {
    await conversationRepository.updateWorkflow(
      parsed.data.id,
      transitions[parsed.data.transition],
    );
    if (parsed.data.transition !== "RETURN_TO_AI") {
      await invalidateAssistantOffer(context.businessId, parsed.data.id);
    }

    // PROMPT-B04 — keep the operator-attention marker consistent with the
    // (server-authorized) lifecycle transition. The handoff itself is the
    // conversation status; attention is only the notification layer:
    //  - TAKE_OVER / RETURN_TO_AI / MARK_BOOKED: the operator acted, so the
    //    NEW/unread alert is acknowledged (the thread may stay NEED_HUMAN
    //    until the operator returns it to the assistant — that is unchanged).
    //  - HANDOFF: an operator routed the thread to the team, so the alert is
    //    (re)opened for everybody else — idempotent, one row per thread.
    if (parsed.data.transition === "HANDOFF") {
      await operatorAttentionRepository.open({
        businessId: context.businessId,
        conversationId: parsed.data.id,
        reason: "DEFERRED_TO_STAFF",
      });
    } else {
      await operatorAttentionRepository.resolve({
        conversationId: parsed.data.id,
        resolvedById: context.user.id,
      });
    }

    refreshConversation(parsed.data.id);
    return { success: true };
  } catch {
    return failure("تعذر تحديث حالة المحادثة");
  }
}

export async function sendStaffReply(
  input: unknown,
): Promise<StaffReplyActionResult> {
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      outcome: "definite_rejection",
      message: parsed.error.issues[0]?.message ?? "الرسالة غير صالحة",
    };
  }
  const context = await actionContext(parsed.data.id);
  if (!context) {
    return {
      success: false,
      outcome: "unroutable",
      message: "المحادثة غير موجودة",
    };
  }

  const result = await submitStaffReply({
    businessId: context.businessId,
    conversationId: parsed.data.id,
    staffUserId: context.user.id,
    content: parsed.data.content,
    clientSubmissionId: parsed.data.clientSubmissionId,
  });

  if (result.ok) {
    refreshConversation(parsed.data.id);
    return {
      success: true,
      outcome: "accepted",
      messageId: result.messageId,
      assignedUser: result.assignedUser ?? null,
    };
  }

  return {
    success: false,
    outcome: result.outcome,
    code: result.code,
    message: result.message,
  };
}

export async function checkStaffReplyStatus(
  input: unknown,
): Promise<StaffReplyStatusActionResult> {
  const parsed = checkReplyStatusSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      status: "unknown",
      code: "INVALID_INPUT",
      message: parsed.error.issues[0]?.message ?? "بيانات الاستعلام غير صالحة",
    };
  }

  const context = await actionContext(parsed.data.id);
  if (!context) {
    return {
      success: false,
      status: "unknown",
      code: "NOT_FOUND",
      message: "المحادثة غير موجودة",
    };
  }

  const result = await lookupStaffReplyStatus({
    businessId: context.businessId,
    conversationId: parsed.data.id,
    clientSubmissionId: parsed.data.clientSubmissionId,
  });

  if (result.status === "accepted") {
    refreshConversation(parsed.data.id);
    return {
      success: true,
      status: "accepted",
      messageId: result.messageId,
      message: result.message,
    };
  }

  return {
    success: false,
    status: result.status,
    code: result.code,
    message: result.message,
  };
}

export async function updateAiSummary(
  input: unknown,
): Promise<ConversationActionResult> {
  const parsed = summarySchema.safeParse(input);
  if (!parsed.success) {
    return failure(parsed.error.issues[0]?.message ?? "الملخص غير صالح");
  }
  const context = await actionContext(parsed.data.id);
  if (!context) return failure("المحادثة غير موجودة");

  try {
    await conversationRepository.update(parsed.data.id, {
      aiSummary: parsed.data.aiSummary || null,
    });
    refreshConversation(parsed.data.id);
    return { success: true };
  } catch {
    return failure("تعذر حفظ الملخص الآن");
  }
}
