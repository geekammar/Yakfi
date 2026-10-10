"use server";

/**
 * Founder Conversation Lab — SERVER BOUNDARY (UX-LAB-01D-2).
 *
 * The one platform-authorized seam between the Lab UI and the existing
 * UX-LAB-01C override service. Every read and mutation the Lab can perform
 * comes through here, and through nowhere else.
 *
 * Flow (binding for this slice):
 *
 *     Lab UI  →  this boundary (PLATFORM authorization)  →  override service
 *              →  repository  →  development database
 *
 * Rules this boundary keeps:
 *  - AUTHORIZATION: every action derives the actor from the authenticated
 *    PLATFORM session + the persisted user record (never a client input), and
 *    the override service re-checks `accountType === "PLATFORM"` itself, so
 *    client-side hiding is never the authorization. A BUSINESS actor can
 *    never reach these results.
 *  - DELEGATION, not reimplementation: validation is the service's job — this
 *    module calls `savePublishedOverride` / `resetPublishedOverride` /
 *    `restoreOverride` / the history + resolution primitives and passes their
 *    TYPED results straight back. It never imports Prisma, the repository, or
 *    `db`, and never calls `validateCopyCandidate` itself (no second rule set
 *    that could drift).
 *  - NO OPTIMISM: a persistence failure is returned as a typed failure, so
 *    the UI can only report success after the service actually persisted.
 *  - ISOLATION: nothing here touches any production customer reply path
 *    (UX-LAB-01E owns runtime wiring; the Lab manages STORED overrides only).
 */
import {
  getPublishedOverride,
  listOverrideHistory,
  resetPublishedOverride,
  resolveStoredCopy,
  restoreOverride,
  savePublishedOverride,
} from "@/features/conversation-copy/override-service";
import type {
  CopyOverrideServiceResult,
  CopyResolutionResult,
  GetOverrideSuccess,
  ListOverrideHistorySuccess,
  ResetOverrideSuccess,
  RestoreOverrideSuccess,
  SaveOverrideSuccess,
} from "@/features/conversation-copy/override-types";
import { requirePlatformOperator } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

import { revalidatePath } from "next/cache";

/** The Lab route this boundary refreshes after a successful mutation. */
const LAB_PATH = "/platform/conversation-lab";

/**
 * The effective state for ONE Lab entry: the resolution (code default vs a
 * valid platform override, with the typed fallback reason), the published row
 * as stored, and the bounded newest-first history. Each piece carries its own
 * typed result so a partial persistence failure degrades instead of crashing
 * the drawer.
 */
export type CopyLabEntryState = {
  readonly resolution: CopyResolutionResult;
  readonly published: CopyOverrideServiceResult<GetOverrideSuccess>;
  readonly history: CopyOverrideServiceResult<ListOverrideHistorySuccess>;
};

export type GetCopyLabEntryStateResult =
  CopyOverrideServiceResult<CopyLabEntryState>;

/**
 * The bound history window the Lab requests (the service bounds it itself;
 * this is the lightweight rollback view, not a full timeline).
 */
const HISTORY_LIMIT = 25;

/**
 * Server-side authorization context derived from the authenticated Platform
 * Operator session + the database-backed user record (mirrors the platform
 * control-plane convention). The account type is ALWAYS the persisted one — a
 * client can never choose it, and a stale session cannot grant platform
 * privileges. `requirePlatformOperator` redirects non-platform actors away
 * before this returns; a session whose user vanished from the store yields
 * the typed FORBIDDEN result.
 */
async function currentActor(): Promise<{
  userId: string;
  accountType: string;
} | null> {
  const session = await requirePlatformOperator();
  const user = await userRepository.findById(session.user.id);
  if (!user) return null;
  return { userId: user.id, accountType: user.accountType };
}

function forbidden(): {
  success: false;
  error: { code: "FORBIDDEN"; message: string };
} {
  return {
    success: false,
    error: {
      code: "FORBIDDEN",
      message: "هذه الصلاحية متاحة لمشغل المنصة فقط",
    },
  };
}

/**
 * READ — the effective copy state for one key: what is in effect now, what is
 * stored, and the bounded history. Platform Operator only. Never throws: a
 * persistence failure degrades each piece to its typed result (resolution
 * falls back to the code default) and the drawer still renders.
 */
export async function getCopyLabEntryStateAction(
  key: string,
): Promise<GetCopyLabEntryStateResult> {
  const actor = await currentActor();
  if (!actor) return forbidden();

  // Each read is independent on purpose: one failing piece (e.g. the history
  // read) must not lose the resolution the drawer primarily shows.
  const [resolution, published, history] = await Promise.all([
    resolveStoredCopy(key),
    getPublishedOverride(key),
    listOverrideHistory(actor, key, HISTORY_LIMIT),
  ]);
  return { success: true, data: { resolution, published, history } };
}

/**
 * PUBLISH — validate then persist a founder-edited override for one key.
 * Platform Operator only. Validation + persistence are the service's; this
 * boundary only authorizes, delegates, refreshes the Lab route, and returns
 * the typed result (a validation or persistence failure is NOT hidden).
 */
export async function publishCopyOverrideAction(input: {
  key: string;
  text: string;
}): Promise<CopyOverrideServiceResult<SaveOverrideSuccess>> {
  const actor = await currentActor();
  if (!actor) return forbidden();

  const result = await savePublishedOverride(actor, input.key, input.text);
  if (result.success) revalidatePath(LAB_PATH);
  return result;
}

/**
 * RESET — remove the published override for one key so the code default is in
 * effect again (a row removal, never a copy of the default into the store).
 * Platform Operator only. Idempotent per the service contract: resetting a
 * key with no override still succeeds.
 */
export async function resetCopyOverrideAction(input: {
  key: string;
}): Promise<CopyOverrideServiceResult<ResetOverrideSuccess>> {
  const actor = await currentActor();
  if (!actor) return forbidden();

  const result = await resetPublishedOverride(actor, input.key);
  if (result.success) revalidatePath(LAB_PATH);
  return result;
}

/**
 * RESTORE — re-publish the value a historical row recorded, re-validated
 * against TODAY'S contract by the service (a stale value that would now be
 * rejected is refused, and PROTECTED_COPY is never mutated). Platform
 * Operator only.
 */
export async function restoreCopyOverrideAction(input: {
  historyId: string;
}): Promise<CopyOverrideServiceResult<RestoreOverrideSuccess>> {
  const actor = await currentActor();
  if (!actor) return forbidden();

  const result = await restoreOverride(actor, input.historyId);
  if (result.success) revalidatePath(LAB_PATH);
  return result;
}
