/**
 * Normalized onboarding failure diagnostics
 * (WHATSAPP-ONBOARDING-01 §8; DECISIONS #47 error-taxonomy convention).
 *
 * ONLY the last failure is persisted, and only in this normalized
 * shape. The mapping lives in the FEATURE (not in the provider
 * adapter): the adapter reports a provider-neutral
 * `AuthorizationErrorCode`, and this module owns the onboarding
 * failure taxonomy (category + stable internal code + safe summary +
 * retryable). Nothing provider-specific (Graph payload, HTTP status,
 * raw error text, authorization code, token) is ever persisted.
 */

import type { WhatsAppOnboardingFailureCategory } from "@/lib/validation";
import type { AuthorizationErrorCode } from "@/server/transport/whatsapp-transport";

export type OnboardingFailureDescriptor = {
  category: WhatsAppOnboardingFailureCategory;
  /** Stable internal code — safe to persist and to display. */
  reasonCode: string;
  /** Safe Arabic summary — customer-appropriate, no provider text. */
  reasonSummary: string;
  retryable: boolean;
  /**
   * `ACTION_REQUIRED` keeps the lifecycle open (the business has
   * something to do); `FAILED` closes the attempt (relaunch needed).
   */
  terminalState: "ACTION_REQUIRED" | "FAILED";
};

const FAILURE_BY_AUTHORIZATION_CODE: Record<
  AuthorizationErrorCode,
  OnboardingFailureDescriptor
> = {
  AUTHORIZATION_DECLINED: {
    category: "AUTHORIZATION",
    reasonCode: "AUTHORIZATION_DECLINED",
    reasonSummary: "تم رفض تفويض واتساب — تحقق من حسابك ثم أعد المحاولة.",
    retryable: false,
    terminalState: "FAILED",
  },
  AUTHORIZATION_EXPIRED: {
    category: "AUTHORIZATION",
    reasonCode: "AUTHORIZATION_EXPIRED",
    reasonSummary: "انتهت صلاحية طلب الربط — ابدأ الربط مرة أخرى.",
    retryable: true,
    terminalState: "FAILED",
  },
  INVALID_AUTHORIZATION_CODE: {
    category: "AUTHORIZATION",
    reasonCode: "INVALID_AUTHORIZATION_CODE",
    reasonSummary: "رمز التفويض غير صالح أو مستخدم — أعد المحاولة.",
    retryable: true,
    terminalState: "FAILED",
  },
  PROVISIONING_INCOMPLETE: {
    category: "PROVIDER_REVIEW",
    reasonCode: "PROVIDER_REVIEW_PENDING",
    reasonSummary:
      "يحتاج رقم واتساب إلى إجراء من جهة المزوّد (مراجعة أو توثيق) قبل التشغيل.",
    retryable: false,
    terminalState: "ACTION_REQUIRED",
  },
  PROVIDER_UNREACHABLE: {
    category: "PROVISIONING",
    reasonCode: "PROVIDER_UNREACHABLE",
    reasonSummary: "تعذر الوصول إلى خدمة واتساب — أعد المحاولة لاحقاً.",
    retryable: true,
    terminalState: "FAILED",
  },
  PROVIDER_PAYLOAD_INVALID: {
    category: "CONFIGURATION",
    reasonCode: "PROVIDER_RESPONSE_UNUSABLE",
    reasonSummary: "تعذرت قراءة استجابة واتساب — أبلغ المشغّل إن تكررت.",
    retryable: false,
    terminalState: "FAILED",
  },
};

/** The descriptor for a provider-reported authorization failure. */
export function describeAuthorizationFailure(
  code: AuthorizationErrorCode,
): OnboardingFailureDescriptor {
  return FAILURE_BY_AUTHORIZATION_CODE[code];
}

export const DUPLICATE_EXTERNAL_ID_FAILURE: OnboardingFailureDescriptor = {
  category: "CONFIGURATION",
  reasonCode: "DUPLICATE_EXTERNAL_ID",
  reasonSummary:
    "هذا الرقم مسجّل لمنشأة أخرى — أزِل ربطه منها أولاً ثم أعد المحاولة.",
  retryable: false,
  terminalState: "FAILED",
};

export const VERIFICATION_REQUIRED_FAILURE: OnboardingFailureDescriptor = {
  category: "VERIFICATION",
  reasonCode: "VERIFICATION_REQUIRED",
  reasonSummary: "اكتملت هوية المزوّد — تحقق من الاتصال لتشغيله.",
  retryable: false,
  terminalState: "ACTION_REQUIRED",
};

export const ONBOARDING_GATE_FAILURE: OnboardingFailureDescriptor = {
  category: "VERIFICATION",
  reasonCode: "OPERATIONAL_GATE_NOT_MET",
  reasonSummary:
    "تعذر اعتماد الجاهزية — يجب أن يكون الاتصال موصولاً ومُتحققاً منه.",
  retryable: false,
  terminalState: "ACTION_REQUIRED",
};

export const PERSISTENCE_FAILURE: OnboardingFailureDescriptor = {
  category: "CONFIGURATION",
  reasonCode: "PERSISTENCE_FAILED",
  reasonSummary: "تعذر حفظ بيانات الربط الآن — أعد المحاولة لاحقاً.",
  retryable: true,
  terminalState: "FAILED",
};
