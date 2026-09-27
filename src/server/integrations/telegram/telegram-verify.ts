import {
  defaultCredentialsResolver,
  type CredentialsResolver,
} from "@/server/credentials/credentials-resolver";
import {
  resolveTelegramBotToken,
  telegramGetMe,
  type TelegramApiDeps,
} from "@/server/integrations/telegram/telegram-client";
import type {
  ConnectionVerificationResult,
  ConnectionVerifier,
} from "@/server/transport/whatsapp-transport";

/**
 * Telegram — READ-ONLY connection verification (DECISIONS #63 (A)).
 *
 * Mirrors the Meta verifier's contract exactly: a single `getMe` call
 * that echoes the bot's own provider-side identity. Verification NEVER
 * sends a customer-facing message (the port has no send capability by
 * construction). The credential is resolved from the connection's
 * `credentialsRef` (`fp:<id>` RUNTIME handle) at verification time; the
 * token value never crosses this boundary, never reaches a log.
 *
 * The echoed bot `id` MUST match the stored `botExternalId` — a mismatch
 * means Telegram resolved a different bot than the one we recorded
 * (misconfiguration, an owner change, or a stale id).
 */

export type TelegramVerifyDeps = TelegramApiDeps;

/** The verifier's normalized failure categories (never an HTTP status). */
type VerifyFailureCode =
  "INVALID_CREDENTIALS" | "INVALID_CONNECTION" | "UNREACHABLE";

export async function verifyTelegramConnection(
  deps: TelegramVerifyDeps,
  params: { externalId: string; credentialsRef?: string | null },
): Promise<ConnectionVerificationResult> {
  if (!params.externalId.trim()) {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "معرّف بوت تيليجرام مفقود",
    };
  }

  const tokenResolution = await resolveTelegramBotToken(
    deps,
    params.credentialsRef,
  );
  if (!tokenResolution.ok) {
    return {
      ok: false,
      code: "INVALID_CREDENTIALS",
      message: tokenResolution.error.message,
    };
  }

  const result = await telegramGetMe(deps, tokenResolution.token);
  if (!result.ok) {
    const code: VerifyFailureCode =
      result.error.code === "UNAUTHORIZED_CREDENTIALS"
        ? "INVALID_CREDENTIALS"
        : result.error.code === "TRANSIENT_TRANSPORT_FAILURE"
          ? "UNREACHABLE"
          : "INVALID_CONNECTION";
    return {
      ok: false,
      code,
      message:
        code === "INVALID_CREDENTIALS"
          ? "بيانات اعتماد تيليجرام غير صالحة أو منتهية"
          : code === "UNREACHABLE"
            ? "خدمة تيليجرام غير متاحة حالياً"
            : "اتصال تيليجرام غير صالح",
    };
  }

  const bot = result.result;
  const verifiedExternalId = String(bot.id);
  if (verifiedExternalId !== params.externalId) {
    return {
      ok: false,
      code: "INVALID_CONNECTION",
      message: "هوية بوت تيليجرام المُعادة لا تطابق المسجّلة",
    };
  }
  return {
    ok: true,
    verifiedExternalId,
    ...(bot.username ? { verifiedName: `@${bot.username}` } : {}),
    // The bot's display name sits in the non-secret display slot (there
    // is no phone number on this channel).
    ...(bot.first_name ? { displayPhoneNumber: bot.first_name } : {}),
  };
}

export type TelegramVerifierDeps = {
  api: TelegramApiDeps;
  credentialsResolver: CredentialsResolver;
};

/**
 * The Telegram-backed verifier wired to the app's production singletons
 * — called only from a feature's server actions, so the feature itself
 * stays provider-neutral (exactly like the Meta verifier wiring).
 */
export function createTelegramConnectionVerifier(
  deps: TelegramVerifierDeps = {
    api: {
      fetchImpl: globalThis.fetch,
      apiHost: "https://api.telegram.org",
      credentialsResolver: defaultCredentialsResolver,
    },
    credentialsResolver: defaultCredentialsResolver,
  },
): ConnectionVerifier {
  return {
    providerName: "telegram-managed",
    verify: (params) => verifyTelegramConnection(deps.api, params),
  };
}
