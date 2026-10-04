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
    // PROMPT-AI-OPS-28 — a pre-existing row (pin absent/NULL) is the
    // backward-compatibility baseline: it must keep resolving exactly as
    // before, with an effective pin of null.
    openRouterProviderOnly: null as string | null,
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
      policyRow.openRouterProviderOnly = data.openRouterProviderOnly as
        string | null;
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

  // ── PROMPT-AI-OPS-28 — OpenRouter provider pin: validation + persistence
  //    invariants. The pin is a ROUTING SLUG, never a secret: it is validated
  //    by the shared Zod schema, persisted as an additive nullable column,
  //    and read only when the effective provider is OpenRouter.
  {
    const base = {
      primaryProvider: "openrouter",
      primaryModel: "deepseek/deepseek-v4.1-flash",
      secondaryProvider: null,
      secondaryModel: null,
      fallbackEnabled: false,
    } as const;

    // 28a. A full endpoint slug is accepted and preserved VERBATIM — the
    //      segment after the slash is meaningful and must not be truncated.
    const pinned = updateAiPolicyDtoSchema.safeParse({
      ...base,
      openRouterProviderOnly: "decart/fp4",
    });
    check(
      "28a نقطة النهاية الكاملة `decart/fp4` تُحفظ كما هي (بلا اقتطاع)",
      pinned.success === true &&
        pinned.data.openRouterProviderOnly === "decart/fp4",
    );

    // 28b. Surrounding whitespace is trimmed.
    const padded = updateAiPolicyDtoSchema.safeParse({
      ...base,
      openRouterProviderOnly: "  decart/fp4  ",
    });
    check(
      "28b تُشذَّب المسافات المحيطة (`  decart/fp4  ` → `decart/fp4`)",
      padded.success === true &&
        padded.data.openRouterProviderOnly === "decart/fp4",
    );

    // 28c. Empty + whitespace-only normalize to null (no pin stored, no
    //      restriction ever sent).
    const empty = updateAiPolicyDtoSchema.safeParse({
      ...base,
      openRouterProviderOnly: "",
    });
    const spaces = updateAiPolicyDtoSchema.safeParse({
      ...base,
      openRouterProviderOnly: "   ",
    });
    const absent = updateAiPolicyDtoSchema.safeParse({ ...base });
    check(
      "28c الفارغ/المسافات/الغياب → null (لا تقييد)",
      empty.success === true &&
        empty.data.openRouterProviderOnly === null &&
        spaces.success === true &&
        spaces.data.openRouterProviderOnly === null &&
        absent.success === true &&
        absent.data.openRouterProviderOnly === null,
    );

    // 28d. Obviously malformed endpoints are rejected — no allowlist, shape
    //      only: a missing segment, an empty segment, extra segments, or an
    //      illegal character. (Values that are pure surrounding whitespace
    //      are trimmed to a pin of null by design — not malformed.)
    const malformed = [
      "decart",
      "/fp4",
      "decart/",
      "decart//fp4",
      "decart/fp4/extra",
      "de cart/fp4",
      "de\tcart/fp4",
      "decart/fp4;drop",
    ];
    check(
      "28d نقاط النهاية المشوّهة مرفوضة (الشكل فقط، بلا قائمة مزودات)",
      malformed.every(
        (value) =>
          updateAiPolicyDtoSchema.safeParse({
            ...base,
            openRouterProviderOnly: value,
          }).success === false,
      ),
    );

    // 28e. The pin never mutates the model id: both travel independently.
    check(
      "28e التقييد لا يغيّر معرّف النموذج (model + pin مستقلان)",
      pinned.success === true &&
        pinned.data.primaryModel === "deepseek/deepseek-v4.1-flash" &&
        pinned.data.openRouterProviderOnly === "decart/fp4",
    );

    // 28f. The pin survives effective-policy resolution; a NULL row (a
    //      policy predating the column) still resolves to null — backward
    //      compatibility.
    check(
      "28f الحل الفعّال يحمل التقييد، والصفوف القديمة (NULL) تبقى null",
      toEffectivePolicy({
        ...policyRow,
        openRouterProviderOnly: "decart/fp4",
      })?.openRouterProviderOnly === "decart/fp4" &&
        toEffectivePolicy(policyRow)?.openRouterProviderOnly === null,
    );

    // 28g. Tenant integrity: a BUSINESS actor cannot set the platform pin
    //      (the policy is a platform singleton; business users are refused
    //      outright, so one business can never touch another's routing).
    const businessPin = await updateAiPolicy(
      BUSINESS_ADMIN,
      { ...base, openRouterProviderOnly: "evil/endpoint" },
      fakeDeps,
    );
    check(
      "28g مشغل منشأة (BUSINESS) لا يستطيع تعديل تقييد OpenRouter",
      businessPin.success === false && businessPin.error.code === "FORBIDDEN",
    );

    // 28h. A PLATFORM actor can persist the pin, and only the pin column
    //      changes — the provider/model/fallback contract is untouched.
    const platformActor = { userId: "op-1", accountType: "PLATFORM" };
    const saved = await updateAiPolicy(
      platformActor,
      { ...base, openRouterProviderOnly: "decart/fp4" },
      fakeDeps,
    );
    check(
      "28h مشغل المنصة يحفظ التقييد دون لمس باقي عقد السياسة",
      saved.success === true &&
        saved.data.policy.openRouterProviderOnly === "decart/fp4" &&
        saved.data.policy.primaryProvider === "openrouter" &&
        saved.data.policy.primaryModel === "deepseek/deepseek-v4.1-flash" &&
        saved.data.policy.fallbackEnabled === false,
    );

    // 28i. The persisted pin is a plain slug in the view — never a key or a
    //      credential shape.
    const savedJson = saved.success ? JSON.stringify(saved.data.policy) : "";
    check(
      "28i التقييد slug عادي في العرض (ليس سراً أو مفتاحاً)",
      saved.success === true &&
        savedJson.includes("decart/fp4") &&
        !/sk-[A-Za-z0-9]{20,}/.test(savedJson) &&
        !/[A-Z][A-Z0-9_]{2,63}_API_KEY/.test(
          saved.data.policy.openRouterProviderOnly ?? "",
        ),
    );

    // 28j. Clearing the pin round-trips back to null.
    const cleared = await updateAiPolicy(
      platformActor,
      { ...base, openRouterProviderOnly: "   " },
      fakeDeps,
    );
    check(
      "28j تفريغ التقييد يعيده إلى null",
      cleared.success === true &&
        cleared.data.policy.openRouterProviderOnly === null,
    );
  }

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
