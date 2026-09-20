// Type-only: erased at runtime so no DB client is loaded before the
// placeholder env is set in main().
import type { RuntimeCredentialRepository } from "../src/server/repositories";

/**
 * FlowPilot — RUNTIME CREDENTIAL BACKEND check
 * (WHATSAPP-ONBOARDING-01; DECISIONS #49).
 *
 * Verifies the server-side RUNTIME credential store that serves the
 * `fp:<id>` reference grammar — no real database, no network, and NO
 * real credentials (the secrets here are synthetic strings):
 *
 *   1. crypto round-trip: AES-256-GCM encrypt → decrypt returns the
 *      exact input; a unique IV per write; a tampered blob, a truncated
 *      blob, an unknown version, and a wrong master key all fail CLOSED
 *      (never a wrong plaintext)
 *   2. master key resolution: hex/base64 32-byte keys accepted; a
 *      missing key is UNAVAILABLE and a malformed key is INVALID — and
 *      neither error ever echoes the configured value
 *   3. no plaintext leakage: the stored record carries ONLY ciphertext
 *      + safe metadata; the secret never appears in the record, in a
 *      thrown/serialized error, or in a resolver result other than the
 *      single server-side `value` field
 *   4. store contract: store → resolve round-trip; an unknown reference
 *      and an invalid reference shape are refused distinctly; a missing
 *      master key makes the store UNAVAILABLE (fail closed); delete
 *      removes the credential
 *   5. tenant isolation + lifecycle: the stored row is Business-owned;
 *      the opaque reference is the ONLY key (never a phone number,
 *      business name, email, or provider id)
 *   6. boundary: the composite `CredentialsResolver` routes ENV (the
 *      UNCHANGED existing behavior) and RUNTIME through their backends;
 *      `store` returns an opaque `fp:<id>` reference and never the
 *      secret; ENV store/delete is an honest UNSUPPORTED_KIND
 *   7. reference hygiene: a minted `fp:<id>` contains no token text and
 *      passes the reference grammar
 *
 * Run: pnpm check:credentials-runtime
 */

export {};

type Check = { label: string; pass: boolean };

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";
const STORED_VALUE = "synthetic-access-token-not-a-real-secret";

async function main(): Promise<void> {
  // Placeholder env so the imported modules boot without a real database
  // (the same convention as the other offline check scripts — no DB, no
  // network, no real credentials are used anywhere here).
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  const checks: Check[] = [];
  const crypto = await import("node:crypto");
  const credentialCrypto =
    await import("../src/server/credentials/credential-crypto");
  const storeModule =
    await import("../src/server/credentials/runtime-credential-store");
  const credentialsModule =
    await import("../src/server/credentials/credentials-resolver");
  const validation = await import("../src/lib/validation/whatsapp-connection");

  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // Fixture master keys (synthetic; 32 random bytes).
  const keyBytesA = crypto.randomBytes(32);
  const keyBytesB = crypto.randomBytes(32);
  const masterKeyA = keyBytesA.toString("hex");
  const masterKeyABase64 = keyBytesA.toString("base64");
  const malformedKey = "not-a-valid-master-key";

  // ── in-memory repository (no DB) ───────────────────────────────────
  type Row = {
    id: string;
    credentialsRef: string;
    businessId: string;
    cipherBlob: string;
    algorithm: string;
    keyVersion: number;
    createdAt: Date;
    updatedAt: Date;
  };
  const rows = new Map<string, Row>();
  const fakeRepository: RuntimeCredentialRepository = {
    async create(params) {
      if (rows.has(params.credentialsRef)) return null;
      const now = new Date();
      const row: Row = {
        id: `row-${rows.size + 1}`,
        ...params,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(params.credentialsRef, row);
      return row;
    },
    async findByReference(credentialsRef: string) {
      return rows.get(credentialsRef) ?? null;
    },
    async deleteByReference(credentialsRef: string) {
      if (!rows.has(credentialsRef)) return false;
      rows.delete(credentialsRef);
      return true;
    },
  };

  function makeStore(masterKey: string | null | undefined) {
    return new storeModule.PostgresRuntimeCredentialStore({
      repository: fakeRepository,
      masterKey,
    });
  }

  // ── 1. crypto round-trip ───────────────────────────────────────────
  {
    const blob = credentialCrypto.encryptCredential(keyBytesA, STORED_VALUE);
    const roundTrip = credentialCrypto.decryptCredential(keyBytesA, blob);
    check(
      "التشفير رحلة ذهاب وإياب: فك التشفير يُرجع النص الأصلي تماماً",
      roundTrip === STORED_VALUE,
    );

    check(
      "النص المشفر مُسنَد بإصدار (v1:) ولا يحتوي على السر",
      blob.startsWith(`${credentialCrypto.CREDENTIAL_CIPHER_VERSION}:`) &&
        !blob.includes(STORED_VALUE),
    );

    // Unique IV per write: the same plaintext must never encrypt to the
    // same blob twice.
    const blob2 = credentialCrypto.encryptCredential(keyBytesA, STORED_VALUE);
    check(
      "IV فريد لكل تشفير: نفس النص لا يُنتج نفس الحزمة مرتين",
      blob !== blob2,
    );

    // Tampered ciphertext fails closed (auth tag mismatch).
    const tampered = blob.slice(0, -4) + "AAAA";
    let tamperedFailed = false;
    try {
      credentialCrypto.decryptCredential(keyBytesA, tampered);
    } catch (error) {
      tamperedFailed = error instanceof credentialCrypto.CredentialCryptoError;
    }
    check("حزمة مُعبّث بها → فشل مصدّق (لا يُرجع نصاً خاطئاً)", tamperedFailed);

    // Truncated blob fails closed.
    let truncatedFailed = false;
    try {
      credentialCrypto.decryptCredential(keyBytesA, "v1:" + "aGVsbG8");
    } catch (error) {
      truncatedFailed = error instanceof credentialCrypto.CredentialCryptoError;
    }
    check("حزمة مقصوصة → فشل مصدّق", truncatedFailed);

    // Unknown version fails closed.
    let versionFailed = false;
    try {
      credentialCrypto.decryptCredential(keyBytesA, "v9:" + blob.split(":")[1]);
    } catch (error) {
      versionFailed = error instanceof credentialCrypto.CredentialCryptoError;
    }
    check("إصدار غير مدعوم → فشل مصدّق", versionFailed);

    // Wrong master key fails closed (never a wrong plaintext).
    let wrongKeyFailed = false;
    try {
      credentialCrypto.decryptCredential(keyBytesB, blob);
    } catch (error) {
      wrongKeyFailed = error instanceof credentialCrypto.CredentialCryptoError;
    }
    check(
      "مفتاح رئيسي خاطئ → فشل مصدّق (لا يُرجع نصاً خاطئاً)",
      wrongKeyFailed,
    );

    // Error messages never carry the secret.
    let leakedInError = false;
    try {
      credentialCrypto.decryptCredential(keyBytesB, blob);
    } catch (error) {
      const text =
        error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error ?? "");
      leakedInError = text.includes(STORED_VALUE);
      if (!leakedInError) {
        leakedInError = JSON.stringify(error ?? "").includes(STORED_VALUE);
      }
    }
    check("رسائل الأخطاء لا تحمل السر مطلقاً", !leakedInError);

    // Empty plaintext is refused (never an empty credential stored).
    let emptyRefused = false;
    try {
      credentialCrypto.encryptCredential(keyBytesA, "");
    } catch (error) {
      emptyRefused = error instanceof credentialCrypto.CredentialCryptoError;
    }
    check("بيانات اعتماد فارغة → رفض (لا يُخزّن سر فارغ)", emptyRefused);
  }

  // ── 2. master key resolution ──────────────────────────────────────
  {
    const hexOk = credentialCrypto.resolveMasterKey(masterKeyA);
    const base64Ok = credentialCrypto.resolveMasterKey(masterKeyABase64);
    const missing = credentialCrypto.resolveMasterKey(undefined);
    const missingEmpty = credentialCrypto.resolveMasterKey("");
    const invalid = credentialCrypto.resolveMasterKey(malformedKey);
    check(
      "المفتاح الرئيسي: hex و base64 (32 بايت) مقبولان ويتطابقان",
      hexOk.ok && base64Ok.ok && Buffer.compare(hexOk.key, base64Ok.key) === 0,
    );
    check(
      "المفتاح الرئيسي المفقود/الفارغ → MASTER_KEY_UNAVAILABLE",
      !missing.ok &&
        missing.code === "MASTER_KEY_UNAVAILABLE" &&
        !missingEmpty.ok &&
        missingEmpty.code === "MASTER_KEY_UNAVAILABLE",
    );
    check(
      "المفتاح الرئيسي غير الصالح → MASTER_KEY_INVALID",
      !invalid.ok && invalid.code === "MASTER_KEY_INVALID",
    );
    // The error must never echo the configured value.
    check(
      "خطأ المفتاح لا يُذيب القيمة المُهيأة (لا تظهر في الرسالة)",
      !invalid.ok && !invalid.message.includes(malformedKey),
    );
  }

  // ── 3 + 4 + 5. store contract, leakage, tenant lifecycle ─────────
  {
    const store = makeStore(masterKeyA);
    const reference = credentialsModule.mintRuntimeCredentialReference();

    const stored = await store.store({
      businessId: BUSINESS_A,
      reference,
      secret: STORED_VALUE,
    });
    check(
      "store → مرجع معتم (`fp:<id>`) ولا يُرجع السر",
      stored.ok && stored.reference === reference,
    );

    // The stored ROW contains only ciphertext + safe metadata.
    const row = rows.get(reference);
    check(
      "السجل المخزّن يحمل نصاً مشفّراً وبيانات وصفية آمنة فقط (لا plaintext)",
      Boolean(row) &&
        !JSON.stringify(row).includes(STORED_VALUE) &&
        typeof row!.cipherBlob === "string" &&
        row!.cipherBlob.startsWith(
          `${credentialCrypto.CREDENTIAL_CIPHER_VERSION}:`,
        ) &&
        row!.algorithm === "AES-256-GCM" &&
        row!.keyVersion === 1,
    );

    // The reference is the store key and carries no secret.
    check(
      "المرجع هو مفتاح المخزن ولا يحتوي على السر",
      rows.has(reference) && !reference.includes(STORED_VALUE),
    );

    // Tenant binding: the row is Business-owned.
    check(
      "السجل مملوك للمنشأة (businessId) لعزل المستأجر",
      row?.businessId === BUSINESS_A,
    );

    // Resolve returns the exact secret at the boundary.
    const resolved = await store.resolve(reference);
    check(
      "resolve → القيمة الصحيحة عند الحد (يطابق السر المُخزّن)",
      resolved.ok && resolved.value === STORED_VALUE,
    );

    // Unknown reference → unavailable (never a value).
    const unknown = await store.resolve("fp:unknown-but-well-formed-ref");
    check(
      "مرجع غير معروف → CREDENTIAL_UNAVAILABLE (لا قيمة)",
      !unknown.ok &&
        unknown.code === "CREDENTIAL_UNAVAILABLE" &&
        !("value" in unknown),
    );

    // Invalid reference shape → invalid (not "unavailable").
    const invalidRef = await store.resolve("WHATSAPP_NOT_AN_FP_REF");
    check(
      "مرجع بصيغة غير صالحة → INVALID_REFERENCE",
      !invalidRef.ok && invalidRef.code === "INVALID_REFERENCE",
    );

    // No master key → store unavailable (fail closed), no value.
    const coldStore = makeStore(undefined);
    const coldStoreResult = await coldStore.store({
      businessId: BUSINESS_A,
      reference: credentialsModule.mintRuntimeCredentialReference(),
      secret: STORED_VALUE,
    });
    const coldResolve = await coldStore.resolve(reference);
    check(
      "بدون مفتاح رئيسي → التخزين والقراءة مرفوضان (STORE_UNAVAILABLE)",
      !coldStoreResult.ok &&
        coldStoreResult.code === "STORE_UNAVAILABLE" &&
        !coldResolve.ok &&
        coldResolve.code === "STORE_UNAVAILABLE",
    );

    // Malformed master key → also unavailable, value never echoed.
    const badKeyStore = makeStore(malformedKey);
    const badKeyResolve = await badKeyStore.resolve(reference);
    check(
      "مفتاح رئيسي تالف → STORE_UNAVAILABLE بلا تسريب",
      !badKeyResolve.ok &&
        badKeyResolve.code === "STORE_UNAVAILABLE" &&
        !badKeyResolve.message.includes(malformedKey),
    );

    // Delete then resolve → unavailable. Deletion needs no key.
    const deleted = await store.delete(reference);
    const afterDelete = await store.resolve(reference);
    check(
      "delete → يزيل السر، والقراءة بعدها CREDENTIAL_UNAVAILABLE",
      deleted.ok &&
        !afterDelete.ok &&
        afterDelete.code === "CREDENTIAL_UNAVAILABLE",
    );

    // Deleting a missing reference is reported, not faked.
    const deleteMissing = await store.delete("fp:another-well-formed-ref");
    check(
      "حذف مرجع غير موجود → فشل صادق (لا نجاح كاذب)",
      !deleteMissing.ok && deleteMissing.code === "CREDENTIAL_UNAVAILABLE",
    );
  }

  // ── 6. boundary: ENV unchanged, RUNTIME routed, store via resolver ──
  {
    const envResolver = new credentialsModule.EnvCredentialsResolver({
      getEnvVar: (name) =>
        name === "WHATSAPP_META_TOKEN_BUSINESS_A" ? STORED_VALUE : undefined,
    });
    const envOk = await envResolver.resolve("WHATSAPP_META_TOKEN_BUSINESS_A");
    const envUnset = await envResolver.resolve("WHATSAPP_META_TOKEN_UNSET");
    check(
      "ENV: المتغيّر المُهيأ يُحلّ (kind=ENV) — والمفقود UNRESOLVED_REFERENCE",
      envOk.ok &&
        envOk.kind === "ENV" &&
        envOk.value === STORED_VALUE &&
        !envUnset.ok &&
        envUnset.code === "UNRESOLVED_REFERENCE",
    );

    // ENV cannot store/delete (operator owns env vars).
    const envStore = await envResolver.store({
      businessId: BUSINESS_A,
      reference: credentialsModule.mintRuntimeCredentialReference(),
      secret: STORED_VALUE,
    });
    const envDelete = await envResolver.delete(
      "WHATSAPP_META_TOKEN_BUSINESS_A",
    );
    check(
      "ENV: التخزين/الحذف UNSUPPORTED_KIND بصدق (لا نجاح كاذب)",
      !envStore.ok &&
        envStore.code === "UNSUPPORTED_KIND" &&
        !envDelete.ok &&
        envDelete.code === "UNSUPPORTED_KIND",
    );

    // Composite resolver: fresh store rows for this section.
    const localRows = new Map<string, Row>();
    const localRepository = {
      async create(params: Row) {
        if (localRows.has(params.credentialsRef)) return null;
        const row = { ...params };
        localRows.set(params.credentialsRef, row);
        return row;
      },
      async findByReference(ref: string) {
        return localRows.get(ref) ?? null;
      },
      async deleteByReference(ref: string) {
        if (!localRows.has(ref)) return false;
        localRows.delete(ref);
        return true;
      },
    };
    const runtimeResolver = new credentialsModule.RuntimeCredentialsResolver(
      new storeModule.PostgresRuntimeCredentialStore({
        repository: localRepository as never,
        masterKey: masterKeyA,
      }),
    );
    const composite = new credentialsModule.DefaultCredentialsResolver({
      envResolver,
      runtimeResolver,
    });

    // ENV through the composite = exactly the EnvCredentialsResolver.
    const compositeEnv = await composite.resolve(
      "WHATSAPP_META_TOKEN_BUSINESS_A",
    );
    check(
      "المركّب: مسار ENV دون تغيير (نفس قيمة EnvCredentialsResolver)",
      compositeEnv.ok &&
        compositeEnv.kind === "ENV" &&
        compositeEnv.value === STORED_VALUE,
    );

    // storeRuntimeCredential-style flow: secret in, opaque ref out.
    const ref = credentialsModule.mintRuntimeCredentialReference();
    const storedViaBoundary = await composite.store({
      businessId: BUSINESS_B,
      reference: ref,
      secret: STORED_VALUE,
    });
    check(
      "الحد: store يُرجع مرجعاً معتم فقط — السر لا يعود أبداً",
      storedViaBoundary.ok &&
        storedViaBoundary.reference === ref &&
        !("secret" in storedViaBoundary) &&
        JSON.stringify(storedViaBoundary).includes(STORED_VALUE) === false,
    );

    // RUNTIME through the composite resolves the stored secret.
    const compositeRuntime = await composite.resolve(ref);
    check(
      "المركّب: مرجع RUNTIME يُحلّ من المخزن (kind=RUNTIME، القيمة الصحيحة)",
      compositeRuntime.ok &&
        compositeRuntime.kind === "RUNTIME" &&
        compositeRuntime.value === STORED_VALUE,
    );

    // Cross-grammar honesty: an ENV-shaped ref through the RUNTIME leg is
    // refused as UNSUPPORTED (never silently read as an env var).
    const runtimeLegOnly = await runtimeResolver.resolve(
      "WHATSAPP_META_TOKEN_BUSINESS_A",
    );
    check(
      "ساق RUNTIME: مرجع ENV → UNSUPPORTED_KIND (لا قراءة عابرة لبيئة)",
      !runtimeLegOnly.ok && runtimeLegOnly.code === "UNSUPPORTED_KIND",
    );

    // delete through the boundary.
    const deletedViaBoundary = await composite.delete(ref);
    const afterBoundaryDelete = await composite.resolve(ref);
    check(
      "الحد: delete ثم resolve → UNRESOLVED_REFERENCE",
      deletedViaBoundary.ok &&
        !afterBoundaryDelete.ok &&
        afterBoundaryDelete.code === "UNRESOLVED_REFERENCE",
    );
  }

  // ── 7. reference hygiene ──────────────────────────────────────────
  {
    const ref = credentialsModule.mintRuntimeCredentialReference();
    const grammarOk =
      validation.credentialRuntimeReferenceSchema.safeParse(ref);
    const prefixOk = ref.startsWith(
      credentialsModule.CREDENTIAL_RUNTIME_REFERENCE_PREFIX,
    );
    check(
      "المرجع المُسكوك: يطابق قواعد `fp:<id>` ويحمل البادئة الصحيحة",
      grammarOk.success && prefixOk,
    );
    check(
      "المرجع المُسكوك: لا يحتوي على نص السر/الرمز",
      !ref.includes(STORED_VALUE) && !ref.includes("token"),
    );
    // Uniqueness/entropy across many mints.
    const many = new Set(
      Array.from({ length: 64 }, () =>
        credentialsModule.mintRuntimeCredentialReference(),
      ),
    );
    check("المراجع المُسكوكة فريدة (إنتروبيا كافية)", many.size === 64);

    // The store key is derived from the reference ONLY — never from a
    // phone number, business name, email, or provider-owned id. This is a
    // structural check: the reference is generated before any provider
    // data exists.
    const phone = "+201064549970";
    const waba = "1286861067846638";
    const ref2 = credentialsModule.mintRuntimeCredentialReference();
    check(
      "مفتاح المخزن مُشتق من المرجع فقط (لا هاتف/اسم/بريد/WABA/phone_number_id)",
      !ref2.includes(phone.replace("+", "")) &&
        !ref2.includes(waba) &&
        validation.credentialRuntimeReferenceSchema.safeParse(ref2).success,
    );
  }

  // ── capability descriptor (safe, loggable) ────────────────────────
  {
    const capable = storeModule.describeRuntimeStoreCapability({
      repository: fakeRepository,
      masterKey: masterKeyA,
    });
    const incapable = storeModule.describeRuntimeStoreCapability({
      repository: fakeRepository,
      masterKey: undefined,
    });
    check(
      "وصف قدرة المخزن: متاح بمفتاح، غير متاح بدونه — ولا يُذيب القيمة",
      capable.available &&
        !incapable.available &&
        capable.algorithm === "AES-256-GCM" &&
        !JSON.stringify(capable).includes(masterKeyA),
    );
  }

  // ── report ────────────────────────────────────────────────────────
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
    `\nاختبارات مخزن بيانات الاعتماد وقت التشغيل صحيحة: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}\n${error.stack}`);
  process.exit(1);
});
