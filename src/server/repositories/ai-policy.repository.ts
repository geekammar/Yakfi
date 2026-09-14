import type { PlatformAiPolicy } from "@/generated/prisma/client";

import type { UpdateAiPolicyDto } from "@/lib/validation";
import { updateAiPolicyDtoSchema } from "@/lib/validation";
import { db } from "@/server/db";

/**
 * PlatformAiPolicy — ONE platform-scoped configuration row
 * (PROMPT-OPS-05). Runtime-readable (no deployment for policy
 * changes); carries provider/model identity + fallback policy +
 * secret REFERENCE names only — never API keys (keys are
 * environment-backed secrets).
 *
 * The singleton is structurally enforced by the fixed 'singleton'
 * primary key — a second insert fails on the PK conflict, so there is
 * always exactly ONE effective policy row. `getOrCreate` upserts the
 * initial operator-approved policy when the row is absent (e.g. a
 * database provisioned outside the migration chain).
 */

/** The initial operator-approved policy (PROMPT-OPS-05). */
export const INITIAL_AI_POLICY: UpdateAiPolicyDto & {
  primarySecretRef: string;
  secondarySecretRef: string;
} = {
  primaryProvider: "openrouter",
  primaryModel: "openrouter/auto",
  secondaryProvider: "agentrouter",
  secondaryModel: "auto",
  fallbackEnabled: true,
  primarySecretRef: "OPENROUTER_API_KEY",
  secondarySecretRef: "AGENTROUTER_API_KEY",
};

export class AiPolicyRepository {
  /** The singleton row — created with the initial policy if absent. */
  async getOrCreate(): Promise<PlatformAiPolicy> {
    return db.platformAiPolicy.upsert({
      where: { id: "singleton" },
      update: {},
      create: {
        id: "singleton",
        ...INITIAL_AI_POLICY,
      },
    });
  }

  /** Re-validates the stored configuration before any caller trusts it. */
  async update(data: UpdateAiPolicyDto): Promise<PlatformAiPolicy> {
    const parsed = updateAiPolicyDtoSchema.parse(data);
    return db.platformAiPolicy.update({
      where: { id: "singleton" },
      data: parsed,
    });
  }
}
