/**
 * FlowPilot — AI POLICY INVARIANTS check (PROMPT-OPS-05).
 *
 * Verifies the Platform AI policy invariants with in-memory
 * repositories (no DB, no network):
 *   1. exactly one effective primary policy (singleton row);
 *   2. optional secondary/fallback — deterministic resolution;
 *   3. invalid provider identifiers rejected;
 *   4. invalid model configuration rejected;
 *   5. writes are Platform-only (Business actor refused at the service);
 *   9. secrets never returned — only env-var reference names;
 *  10. provider selection remains deterministic (no randomness).
 *
 * Run: pnpm check:policy
 *
 * Dummy env vars satisfy the fail-fast env validation of the imported
 * modules — no real connection is ever made (fake deps only).
 */

export {};

type Check = { label: string; pass: boolean };

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const { updateAiPolicy, getAiPolicy, toEffectivePolicy } =
    await import("../src/features/platform/server/ai-policy-service");
  const { updateAiPolicyDtoSchema } =
    await import("../src/lib/validation/platform");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── In-memory repository (the singleton + update) ────────────────────────
  const BUSINESS_ADMIN = { userId: "biz-1", accountType: "BUSINESS" };

  const policyRow = {
    id: "singleton",
    primaryProvider: "openrouter",
    primaryModel: "openrouter/auto",
    secondaryProvider: "agentrouter" as string | null,
    secondaryModel: "auto" as string | null,
    fallbackEnabled: true,
    primarySecretRef: "OPENROUTER_API_KEY",
    secondarySecretRef: "AGENTROUTER_API_KEY",
    updatedById: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const fakeDeps = {
    getOrCreate: async () => ({ ...policyRow }),
    update: async (data: Record<string, unknown>) => {
      policyRow.primaryProvider = data.primaryProvider as string;
      policyRow.primaryModel = data.primaryModel as string;
      policyRow.secondaryProvider = data.secondaryProvider as string | null;
      policyRow.secondaryModel = data.secondaryModel as string | null;
      policyRow.fallbackEnabled = data.fallbackEnabled as boolean;
      policyRow.updatedAt = new Date();
      return { ...policyRow };
    },
  };

  // 1. Exactly one effective primary policy (deterministic read).
  const read = await getAiPolicy(fakeDeps);
  check(
    "قراءة السياسة تعيد مزوداً أساسياً واحداً",
    read.success === true && Boolean(read.data.effective.primaryProvider),
  );
  check(
    "المزود الأساسي ضمن القائمة المعتمدة",
    read.success === true &&
      ["openrouter", "agentrouter"].includes(
        read.data.effective.primaryProvider,
      ),
  );

  // 2. Secondary/fallback resolved deterministically when enabled.
  check(
    "الاحتياطي يُحل حتمياً عند التفعيل",
    read.success === true &&
      read.data.effective.secondary?.provider === "agentrouter",
  );

  // 5/6/7. Writes are Platform-only — a BUSINESS actor is refused.
  const forbidden = await updateAiPolicy(
    BUSINESS_ADMIN,
    {
      primaryProvider: "openrouter",
      primaryModel: "x",
      secondaryProvider: null,
      secondaryModel: null,
      fallbackEnabled: false,
    },
    fakeDeps,
  );
  check(
    "مدير منشأة (BUSINESS) مرفوض من تعديل السياسة",
    forbidden.success === false && forbidden.error.code === "FORBIDDEN",
  );

  // 3. Invalid provider identifiers rejected.
  const badProvider = updateAiPolicyDtoSchema.safeParse({
    primaryProvider: "not-a-provider",
    primaryModel: "m",
    secondaryProvider: null,
    secondaryModel: null,
    fallbackEnabled: false,
  });
  check("معرّف مزود غير صالح مرفوض", badProvider.success === false);

  const badSecondaryProvider = updateAiPolicyDtoSchema.safeParse({
    primaryProvider: "openrouter",
    primaryModel: "m",
    secondaryProvider: "unknown-llm",
    secondaryModel: "m",
    fallbackEnabled: true,
  });
  check("مزود احتياطي غير صالح مرفوض", badSecondaryProvider.success === false);

  // 4. Invalid model configuration rejected (empty model / fallback
  //    without a secondary / secondary without a model).
  const emptyModel = updateAiPolicyDtoSchema.safeParse({
    primaryProvider: "openrouter",
    primaryModel: "   ",
    secondaryProvider: null,
    secondaryModel: null,
    fallbackEnabled: false,
  });
  check("نموذج أساسي فارغ مرفوض", emptyModel.success === false);

  const fallbackWithoutSecondary = updateAiPolicyDtoSchema.safeParse({
    primaryProvider: "openrouter",
    primaryModel: "m",
    secondaryProvider: null,
    secondaryModel: null,
    fallbackEnabled: true,
  });
  check(
    "تفعيل الاحتياطي بدون مزود احتياطي مرفوض",
    fallbackWithoutSecondary.success === false,
  );

  const secondaryWithoutModel = updateAiPolicyDtoSchema.safeParse({
    primaryProvider: "openrouter",
    primaryModel: "m",
    secondaryProvider: "agentrouter",
    secondaryModel: null,
    fallbackEnabled: true,
  });
  check(
    "مزود احتياطي بدون نموذج مرفوض",
    secondaryWithoutModel.success === false,
  );

  // 2b. Fallback disabled → the effective secondary is deterministically
  //     absent; re-enabling restores it (runtime change, no randomness).
  const disabledRow = { ...policyRow, fallbackEnabled: false };
  check(
    "تعطيل الاحتياطي يُلغي المزود الاحتياطي الفعّال حتمياً",
    toEffectivePolicy(disabledRow)?.secondary === null,
  );
  check(
    "إعادة تفعيل الاحتياطي تعيد الحل الحتمي نفسه",
    toEffectivePolicy({ ...disabledRow, fallbackEnabled: true })?.secondary
      ?.provider === "agentrouter",
  );

  // 10. Deterministic: repeated resolution is identical.
  const a = toEffectivePolicy(policyRow);
  const b = toEffectivePolicy(policyRow);
  check(
    "الحل حتمي (لا عشوائية) — نتائج متطابقة",
    JSON.stringify(a) === JSON.stringify(b),
  );

  // 9. Secrets never returned: the policy view carries env-var reference
  //    NAMES only — no key-shaped values anywhere in the result.
  const viewJson = read.success ? JSON.stringify(read.data) : "";
  check(
    "لا قيم مفاتيح في نتيجة السياسة (أسماء مراجع فقط)",
    !/sk-[A-Za-z0-9]{20,}/.test(viewJson) &&
      viewJson.includes("OPENROUTER_API_KEY"),
  );

  let failed = 0;
  for (const { label, pass } of checks) {
    if (pass) console.log(`✔ ${label}`);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.error(`\nفشل ${failed} من ${checks.length} فحص.`);
    process.exit(1);
  }
  console.log(
    `\nثوابت سياسة الذكاء صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  process.exit(1);
});
