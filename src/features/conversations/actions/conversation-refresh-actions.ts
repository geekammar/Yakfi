"use server";

import { conversationIdSchema } from "@/features/conversations/schemas/conversation-schema";
import { getConversationRefresh } from "@/features/conversations/server/conversation-queries";
import type { ConversationRefreshResult } from "@/features/conversations/types";
import { getSession, isPlatformOperator } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

/**
 * Read-only refresh for an ALREADY-OPEN conversation.
 *
 * Authorization is derived exclusively from the authenticated server session
 * (never a client-supplied business id). The tenant scope comes from the
 * persisted user, exactly like the mutating conversation actions. Cross-tenant
 * and missing conversations both return NOT_FOUND so thread existence is not
 * leaked across businesses.
 *
 * This action NEVER acknowledges operator attention, changes ownership, marks
 * messages sent, writes appointments or triggers delivery: it is the pure read
 * used by lightweight polling while the operator keeps the thread open.
 */
export async function refreshConversationDetail(
  input: unknown,
): Promise<ConversationRefreshResult> {
  const parsed = conversationIdSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      code: "INVALID_INPUT",
      message: "معرّف المحادثة غير صالح",
    };
  }

  const session = await getSession();
  if (!session) {
    return {
      success: false,
      code: "UNAUTHENTICATED",
      message: "يجب تسجيل الدخول",
    };
  }
  if (!session.user.isActive || isPlatformOperator(session.user)) {
    return {
      success: false,
      code: "FORBIDDEN",
      message: "لا تملك صلاحية الوصول",
    };
  }

  const user = await userRepository.findById(session.user.id);
  if (!user?.isActive || !user.businessId) {
    return {
      success: false,
      code: "FORBIDDEN",
      message: "لا تملك صلاحية الوصول",
    };
  }

  try {
    const data = await getConversationRefresh(user.businessId, parsed.data.id);
    if (!data) {
      return {
        success: false,
        code: "NOT_FOUND",
        message: "المحادثة غير موجودة",
      };
    }
    return { success: true, data };
  } catch {
    return {
      success: false,
      code: "UNKNOWN",
      message: "تعذر تحديث المحادثة الآن",
    };
  }
}
