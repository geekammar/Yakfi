/**
 * Telegram connection application logic (DECISIONS #66 — slice TELEGRAM 03).
 *
 * The customer-facing managed-bot provisioning surface, mirroring the
 * WhatsApp onboarding service's shape (DECISIONS #47): a state derivation
 * the UI can trust + use cases that never accept a Business from the
 * client.
 *
 *   LAUNCH      Business Admin (ADMIN, own Business) → a single-use
 *               provisioning attempt is persisted server-side (the opaque
 *               `startToken` is the ONLY thing the deep link carries), the
 *               Manager Bot webhook is ensured, and the deep link is
 *               returned. No token, no technical identifier, no webhook
 *               setting crosses to the browser.
 *   STATUS      the ONE UI state machine, derived server-side from the
 *               connection row + the latest attempt (the honest polling
 *               surface — the browser never interprets provider state).
 *   DISCONNECT  `deleteWebhook` → DISCONNECTED + inactive → the runtime
 *               credential reference is removed (a stale secret is never
 *               left behind; reconnect mints a fresh one).
 *
 * Architecture invariants:
 * - The Business is ALWAYS server-derived from the authenticated actor.
 * - ADMIN-only.
 * - `onboardingState` is NEVER consumed by the transport runtime, the
 *   conversation engine, booking, or AI.
 * - Secrets never cross this service: the bot token is obtained and stored
 *   by the adapter boundary only, as an opaque `fp:<id>` RUNTIME reference.
 */

import type { RuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import {
  getManagerBotToken,
  type TelegramApiDeps,
} from "@/server/integrations/telegram/telegram-client";
import {
  buildManagedBotDeepLink,
  disconnectManagedBotConnection,
  ensureManagerWebhook,
  mintTelegramStartToken,
  type TelegramProvisioningDeps,
} from "@/server/integrations/telegram/telegram-provisioning";
import type {
  BusinessRepository,
  TelegramConnectionRepository,
} from "@/server/repositories";
import {
  TELEGRAM_PROVISIONING_EXPIRY_MINUTES,
  type TelegramProvisioningLedgerRepository,
  type TelegramProvisioningRecord,
} from "@/server/repositories/telegram-provisioning-ledger.repository";
import type { TelegramConnection } from "@/types/domain";

import type {
  BeginTelegramProvisioningResult,
  TelegramConnectionReadResult,
  TelegramConnectionView,
  TelegramDisconnectionResult,
} from "../types";

export type TelegramConnectionActor = {
  userId: string;
  role: "ADMIN" | "STAFF";
  businessId: string | null;
};

/**
 * The feature's dependency surface: the adapter boundary's needs PLUS the
 * use cases' own reads. Every one is an existing app boundary; none is a
 * Telegram HTTP concern. `managerBotUsername` is the manager bot's PUBLIC
 * @username (the token stays in env).
 */
export type TelegramConnectionServiceDeps = Omit<
  TelegramProvisioningDeps,
  "api" | "ledgerRepository" | "connectionRepository" | "credentialStore"
> & {
  api: TelegramApiDeps;
  ledgerRepository: Pick<
    TelegramProvisioningLedgerRepository,
    | "create"
    | "findActiveByBusiness"
    | "findActiveByCreator"
    | "findLatestByBusiness"
    | "bindCreator"
    | "consume"
    | "recordConnectionId"
    | "recordOutcome"
  >;
  connectionRepository: Pick<
    TelegramConnectionRepository,
    | "findPrimaryByBusiness"
    | "findByExternalId"
    | "findByIdWithinBusiness"
    | "create"
    | "update"
    | "disconnect"
    | "markOnboardingReady"
  >;
  credentialStore: Pick<RuntimeCredentialStore, "store" | "delete">;
  businessRepository: Pick<BusinessRepository, "findById">;
  /** The Manager Bot's @username — a non-secret operator config value. */
  managerBotUsername: string | null;
};

const FORBIDDEN_MESSAGE = "إعداد تيليجرام متاح للمدير فقط";
const NO_BUSINESS_MESSAGE = "أكمل إعداد المنشأة أولاً";
const LAUNCH_FAILED_MESSAGE = "تعذر بدء ربط تيليجرام الآن — حاول مرة أخرى";
const MANAGER_MISSING_MESSAGE =
  "بوت الإدارة غير مُهيأ بعد — سيقوم المشغّل بإعداده";
const DISCONNECT_FAILED_MESSAGE = "تعذر فصل تيليجرام الآن — حاول مرة أخرى";

type Scope = { ok: true; businessId: string } | { ok: false; message: string };

function resolveScope(actor: TelegramConnectionActor): Scope {
  if (actor.role !== "ADMIN") return { ok: false, message: FORBIDDEN_MESSAGE };
  if (!actor.businessId) return { ok: false, message: NO_BUSINESS_MESSAGE };
  return { ok: true, businessId: actor.businessId };
}

// ─── The UI state machine (pure; assertable offline) ────────────────────────

/**
 * The safe Arabic label for a terminal attempt outcome (DECISIONS #66).
 * Every code maps to a customer-appropriate summary + a retryable flag; a
 * raw provider response never reaches the UI. Codes that need an operator
 * (the manager bot, the credential master key) are NOT customer-retryable
 * — the label says so honestly.
 */
export const PROVISIONING_OUTCOME_LABELS: Record<
  string,
  { summary: string; retryable: boolean }
> = {
  PROVISIONED: { summary: "اكتمل التفعيل بنجاح.", retryable: false },
  BOT_ATTACHED_TO_ANOTHER_BUSINESS: {
    summary: "هذا البوت مُفعّل لمنشأة أخرى — أنشئ بوتاً جديداً.",
    retryable: true,
  },
  BOT_ALREADY_PROVISIONED: {
    summary: "هذا البوت مُفعّل بالفعل لهذه المنشأة.",
    retryable: false,
  },
  NO_IN_FLIGHT_ATTEMPT: {
    summary: "تعذرت مطابقة محاولة التفعيل — ابدأ المحاولة من جديد.",
    retryable: true,
  },
  CREATOR_MISMATCH: {
    summary: "حساب تيليجرام الذي أنشأ البوت لا يطابق صاحب الرابط.",
    retryable: true,
  },
  ATTEMPT_EXPIRED: {
    summary: "انتهت صلاحية محاولة التفعيل — ابدأ محاولة جديدة.",
    retryable: true,
  },
  MANAGER_BOT_NOT_CONFIGURED: {
    summary: "بوت الإدارة غير مُهيأ بعد من المشغّل.",
    retryable: false,
  },
  PROVIDER_UNREACHABLE: {
    summary: "تعذر الوصول إلى خدمة تيليجرام حالياً — حاول مرة أخرى.",
    retryable: true,
  },
  CREDENTIAL_STORE_UNAVAILABLE: {
    summary: "مخزن بيانات الاعتماد غير مُهيأ بعد من المشغّل.",
    retryable: false,
  },
  PROVISIONING_FAILED: {
    summary: "تعذّر إكمال التفعيل — ابدأ محاولة جديدة.",
    retryable: true,
  },
};

function isOperationallyConnected(connection: TelegramConnection): boolean {
  return connection.isActive && connection.status === "CONNECTED";
}

/**
 * Derive the ONE UI state + the safe view from the connection row and the
 * latest provisioning attempt (DECISIONS #66). Pure: no side effects, no
 * I/O — the polling action calls it and the harness asserts it.
 *
 * Resolution order (the honest precedence):
 * 1. A CONNECTED + active connection → CONNECTED (the bot is live).
 * 2. An IN-FLIGHT attempt → PROVISIONING, even when a DISCONNECTED
 *    connection exists (the Admin re-launched; the reconnect is underway —
 *    the live attempt is the truth, never a stale disconnected row).
 * 3. A DISCONNECTED connection → DISCONNECTED (reconnect = a fresh flow).
 * 4. A TERMINATED attempt without a connection → ACTION_REQUIRED (the
 *    typed failure summary + a fresh-attempt CTA — never a spinner).
 * 5. An ABANDONED attempt (expired, never confirmed) → ACTION_REQUIRED.
 * 6. Nothing → EMPTY.
 */
export function resolveTelegramConnectionView(
  connection: TelegramConnection | null,
  latestAttempt: TelegramProvisioningRecord | null,
): TelegramConnectionView {
  if (connection && isOperationallyConnected(connection)) {
    return {
      connectionId: connection.id,
      uiState: "CONNECTED",
      botUsername: connection.botUsername ?? null,
      botDisplayName: connection.displayName ?? null,
      summary: "بوت تيليجرام متصل وجاهز لاستقبال رسائل عملائك.",
      operationallyConnected: true,
      lastOutcomeCode: null,
      stateChangedAt: connection.updatedAt.toISOString(),
    };
  }

  const now = Date.now();
  const inFlight = Boolean(
    latestAttempt &&
    !latestAttempt.consumedAt &&
    latestAttempt.expiresAt.getTime() > now,
  );
  if (inFlight) {
    return {
      connectionId: connection?.id ?? "",
      uiState: "PROVISIONING",
      botUsername: connection?.botUsername ?? null,
      botDisplayName: connection?.displayName ?? null,
      summary:
        "في انتظار تأكيدك داخل تيليجرام — اضغط زر إنشاء البوت في رسالة بوت الإدارة.",
      operationallyConnected: false,
      lastOutcomeCode: null,
      stateChangedAt: latestAttempt!.createdAt.toISOString(),
    };
  }

  if (connection) {
    return {
      connectionId: connection.id,
      uiState: "DISCONNECTED",
      botUsername: connection.botUsername ?? null,
      botDisplayName: connection.displayName ?? null,
      summary:
        "البوت غير موصول — ابدأ تفعيلاً جديداً لاستئناف استقبال رسائل العملاء.",
      operationallyConnected: false,
      lastOutcomeCode: null,
      stateChangedAt: connection.updatedAt.toISOString(),
    };
  }

  if (latestAttempt) {
    const terminated = Boolean(latestAttempt.consumedAt);
    const outcome = terminated
      ? (PROVISIONING_OUTCOME_LABELS[latestAttempt.outcomeCode ?? ""] ??
        PROVISIONING_OUTCOME_LABELS.PROVISIONING_FAILED!)
      : {
          summary: "انتهت صلاحية المحاولة — ابدأ تفعيلاً جديداً.",
          retryable: true,
        };
    return {
      connectionId: "",
      uiState: "ACTION_REQUIRED",
      botUsername: null,
      botDisplayName: null,
      summary: outcome.summary,
      operationallyConnected: false,
      lastOutcomeCode: terminated
        ? (latestAttempt.outcomeCode ?? "PROVISIONING_FAILED")
        : "ATTEMPT_EXPIRED",
      stateChangedAt: (
        latestAttempt.consumedAt ?? latestAttempt.expiresAt
      ).toISOString(),
    };
  }

  return {
    connectionId: "",
    uiState: "EMPTY",
    botUsername: null,
    botDisplayName: null,
    summary: null,
    operationallyConnected: false,
    lastOutcomeCode: null,
    stateChangedAt: null,
  };
}

// ─── Read (the polling surface) ─────────────────────────────────────────────

/** The actor's Business Telegram connection state (ADMIN only, own Business). */
export async function getTelegramConnectionStatus(
  deps: TelegramConnectionServiceDeps,
  actor: TelegramConnectionActor,
): Promise<TelegramConnectionReadResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const connection = await deps.connectionRepository.findPrimaryByBusiness(
    scope.businessId,
  );
  const latestAttempt = await deps.ledgerRepository.findLatestByBusiness(
    scope.businessId,
  );
  return {
    success: true,
    view: resolveTelegramConnectionView(connection, latestAttempt),
  };
}

// ─── Launch (the single-use provisioning attempt) ───────────────────────────

/**
 * Launch a managed-bot provisioning attempt for the actor's own Business
 * (ADMIN only). Mints the opaque single-use start token, persists the
 * ledger row (the deep link's ONLY authority), ensures the Manager Bot's
 * webhook is wired (no manual operator webhook configuration), and returns
 * the deep link + the attempt's expiry. Nothing secret crosses.
 *
 * Idempotent re-launch: an unconsumed, unexpired attempt is RESUMED — the
 * same token, the same ledger row, the same deep link (abandonment then
 * re-launch picks up where it left off instead of orphaning attempts).
 */
export async function beginTelegramProvisioning(
  deps: TelegramConnectionServiceDeps,
  actor: TelegramConnectionActor,
): Promise<BeginTelegramProvisioningResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  if (!deps.managerBotUsername) {
    return { success: false, message: MANAGER_MISSING_MESSAGE };
  }

  // The manager bot webhook is ensured FIRST — the deep link is useless
  // until Telegram is delivering the `/start` + `managed_bot` updates here.
  const ensured = await ensureManagerWebhook(deps);
  if (!ensured.ok) {
    return {
      success: false,
      message:
        ensured.code === "MANAGER_BOT_NOT_CONFIGURED"
          ? MANAGER_MISSING_MESSAGE
          : LAUNCH_FAILED_MESSAGE,
    };
  }

  // Resume an in-flight attempt; otherwise mint a fresh single-use one.
  const existing = await deps.ledgerRepository.findActiveByBusiness(
    scope.businessId,
    deps.now(),
  );
  const now = deps.now();
  const startToken = existing?.startToken ?? mintTelegramStartToken();
  const expiresAt =
    existing?.expiresAt ??
    new Date(now.getTime() + TELEGRAM_PROVISIONING_EXPIRY_MINUTES * 60_000);

  if (!existing) {
    try {
      await deps.ledgerRepository.create({
        businessId: scope.businessId,
        startToken,
        expiresAt,
      });
    } catch {
      return { success: false, message: LAUNCH_FAILED_MESSAGE };
    }
  }

  return {
    success: true,
    launched: true,
    authorizationUrl: buildManagedBotDeepLink(
      deps.managerBotUsername,
      startToken,
    ),
    expiresAt: expiresAt.toISOString(),
  };
}

// ─── Disconnect (the supported lifecycle) ───────────────────────────────────

/**
 * Disconnect the actor's connected managed bot (ADMIN only, own Business):
 * `deleteWebhook` at Telegram → the connection row is DISCONNECTED +
 * inactive → the runtime credential reference is removed. A cleanup
 * failure at Telegram or the credential store is reported as a non-fatal
 * warning (the local disconnect is authoritative).
 */
export async function disconnectTelegramConnection(
  deps: TelegramConnectionServiceDeps,
  actor: TelegramConnectionActor,
): Promise<TelegramDisconnectionResult> {
  const scope = resolveScope(actor);
  if (!scope.ok) return { success: false, message: scope.message };

  const connection = await deps.connectionRepository.findPrimaryByBusiness(
    scope.businessId,
  );
  if (!connection) {
    return {
      success: false,
      message: "لا يوجد اتصال تيليجرام لفصله — ابدأ تفعيلاً جديداً.",
    };
  }

  const result = await disconnectManagedBotConnection(deps, {
    connectionId: connection.id,
    businessId: scope.businessId,
  });
  if (!result.ok) {
    return {
      success: false,
      message: result.message ?? DISCONNECT_FAILED_MESSAGE,
    };
  }
  return { success: true, cleanupWarning: result.cleanupWarning ?? null };
}

// ─── The manager bot username (non-secret operator config) ──────────────────

/**
 * The Manager Bot's @username — a NON-SECRET operator value (the public
 * half of the manager bot; the token stays in env). Read from the env so
 * the deep link is built without a DB lookup and without ever touching the
 * token.
 */
export function resolveManagerBotUsername(
  getEnvVar: (name: string) => string | undefined,
): string | null {
  return getEnvVar("TELEGRAM_MANAGER_BOT_USERNAME") ?? null;
}

/** Is the manager bot configured at all? (The token is the prerequisite.) */
export function isManagerBotConfigured(
  getEnvVar: (name: string) => string | undefined,
): boolean {
  return Boolean(getManagerBotToken(getEnvVar));
}
