/* eslint-disable @typescript-eslint/consistent-type-imports */
/**
 * FlowPilot — PLATFORM OWNER INVITATION token validation check
 * (PROMPT-OPS-FIX-OWNER-INVITATION-TOKEN-VALIDATION-01).
 *
 * Deterministic, OFFLINE regression matrix (no network, no DB, no
 * secrets) for the owner activation lookup/acceptance path at
 * `src/features/platform/server/owner-invitation-service.ts`.
 *
 * Regression target — the token-only entry points
 * `getOwnerInvitationByToken({ token })` and `acceptOwnerInvitation(
 * { token })` previously validated their OBJECT input through
 * `activateOwnerInputSchema.shape.token` — a STRING schema — so every
 * `{ token }` object failed validation with INVALID_INPUT before any
 * database lookup, and the route rendered INVALID_TOKEN. They now use
 * the shared token-object schema (`acceptInvitationInputSchema`),
 * exactly like the working business/staff path.
 *
 * Proves the required invariants, one labelled group per letter:
 *   A  getOwnerInvitationByToken({ token })
 *        valid pending unexpired → successful lookup
 *        unknown token            → existing not-found behavior
 *        expired token            → existing expired behavior
 *   B  acceptOwnerInvitation({ token })
 *        valid pending  → successful one-time acceptance
 *        second attempt → existing one-time failure
 *   C  activateOwnerAccount(...) — unchanged; regression confirmation
 *        that the shared activation schema still validates its object
 *        and the activation flow still completes
 *   D  Route-level behavior: the exact lookup call the
 *      `/owner-invite/[token]` page makes must reach the activation
 *      form instead of INVALID_TOKEN
 *   R  bug regression guards: the token-only object must never be
 *      rejected as INVALID_INPUT, and the raw token is never echoed
 *
 * The service's collaborators are injectable, so the workflow logic is
 * exercised against an in-memory store that mirrors the repository's
 * conditional-guard semantics — no real invitation record is created.
 * The REAL `hashInvitationToken` is used so the token→hash lookup
 * boundary is covered end to end.
 *
 * Run: pnpm check:owner-invitation
 */
export {};

type Check = { label: string; pass: boolean };

type PlatformInvitation =
  import("../src/generated/prisma/client").PlatformInvitation;
type OwnerInvitationServiceDeps =
  import("../src/features/platform/server/owner-invitation-service").OwnerInvitationServiceDeps;
type PlatformServiceResult<T> =
  import("../src/features/platform/types").PlatformServiceResult<T>;
type PlatformErrorCode =
  import("../src/features/platform/types").PlatformErrorCode;
type PlatformInvitationView =
  import("../src/features/platform/types").PlatformInvitationView;
type User = import("../src/generated/prisma/client").User;

const EMAIL = "owner.candidate@example.com";
const BUSINESS_NAME = "منشأة التجربة";
const NAME = "مالك المنشأة";
// Offline fixture only — a synthetic activation password for the
// in-memory harness (never hashed, never sent to auth, 8..128 chars).
const PASSWORD = "example-password-42";
const USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A canonical future expiry (createdAt + INVITATION_EXPIRY_DAYS). */
function futureExpiry(): Date {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
}

/**
 * In-memory PlatformInvitation store mirroring the repository's
 * conditional guards (pending + unexpired for acceptance; accepted +
 * unactivated for activation). Only tokenHash is ever consulted.
 */
class FakeInvitations {
  private rows = new Map<string, PlatformInvitation>();

  async createIfNoOpenInvitation(
    data: Parameters<
      OwnerInvitationServiceDeps["invitations"]["createIfNoOpenInvitation"]
    >[0],
  ): Promise<PlatformInvitation | null> {
    const now = new Date();
    const open = [...this.rows.values()].find(
      (row) =>
        row.email === data.email &&
        row.acceptedAt === null &&
        row.expiresAt.getTime() > now.getTime(),
    );
    if (open) return null;
    const row: PlatformInvitation = {
      id: crypto.randomUUID(),
      email: data.email,
      businessName: data.businessName ?? null,
      tokenHash: data.tokenHash,
      expiresAt: data.expiresAt,
      acceptedAt: null,
      activatedAt: null,
      createdById: data.createdById ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(row.tokenHash, row);
    return row;
  }

  async findByTokenHash(tokenHash: string): Promise<PlatformInvitation | null> {
    return this.rows.get(tokenHash) ?? null;
  }

  async listAll(): Promise<PlatformInvitation[]> {
    return [...this.rows.values()].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async acceptPendingInvitation(
    tokenHash: string,
  ): Promise<PlatformInvitation | null> {
    const row = this.rows.get(tokenHash);
    if (!row) return null;
    if (row.acceptedAt !== null) return null;
    if (row.expiresAt.getTime() <= Date.now()) return null;
    const accepted: PlatformInvitation = {
      ...row,
      acceptedAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(tokenHash, accepted);
    return accepted;
  }

  async activateOwner(input: {
    invitationId: string;
    userId: string;
  }): Promise<
    | { status: "ACTIVATED"; invitation: PlatformInvitation; userId: string }
    | { status: "ALREADY_ACTIVATED" }
    | { status: "NOT_ACCEPTED" }
    | { status: "USER_MISSING" }
    | { status: "CONFLICT" }
    | { status: "NOT_FOUND" }
  > {
    const row = [...this.rows.values()].find(
      (r) => r.id === input.invitationId,
    );
    if (!row) return { status: "NOT_FOUND" } as const;
    if (row.activatedAt) return { status: "ALREADY_ACTIVATED" } as const;
    if (!row.acceptedAt) return { status: "NOT_ACCEPTED" } as const;
    const user = this.users.get(input.userId);
    if (!user) return { status: "USER_MISSING" } as const;
    if (user.businessId !== null) return { status: "CONFLICT" } as const;

    const activated: PlatformInvitation = {
      ...row,
      activatedAt: new Date(),
      updatedAt: new Date(),
    };
    this.rows.set(row.tokenHash, activated);
    user.role = "ADMIN";
    user.isActive = true;
    return {
      status: "ACTIVATED" as const,
      invitation: activated,
      userId: input.userId,
    };
  }

  /** Test seeding helper — NOT an exported service operation. */
  seed(row: PlatformInvitation): void {
    this.rows.set(row.tokenHash, row);
  }

  /** Exposes the persisted state for one-time assertions. */
  async readByTokenHash(tokenHash: string): Promise<PlatformInvitation | null> {
    return this.rows.get(tokenHash) ?? null;
  }

  constructor(private users: Map<string, FakeUser>) {}
}

type FakeUser = User;

function makeRow(
  overrides: Partial<PlatformInvitation> = {},
): PlatformInvitation {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    email: EMAIL,
    businessName: BUSINESS_NAME,
    tokenHash: "",
    expiresAt: futureExpiry(),
    acceptedAt: null,
    activatedAt: null,
    createdById: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function isFailure<T>(result: PlatformServiceResult<T>): result is {
  success: false;
  error: { code: PlatformErrorCode; message: string };
} {
  return !result.success;
}

async function main(): Promise<void> {
  const { hashInvitationToken, generateInvitationToken } =
    await import("../src/server/security/invitation-token");
  const {
    getOwnerInvitationByToken,
    acceptOwnerInvitation,
    activateOwnerAccount,
    derivePlatformInvitationStatus,
  } = await import("../src/features/platform/server/owner-invitation-service");
  const { activateOwnerInputSchema } =
    await import("../src/features/platform/schemas/platform-schema");

  const checks: Check[] = [];
  function check(label: string, pass: boolean): void {
    checks.push({ label, pass });
  }

  // ── Fixture: one pending, unexpired owner invitation ───────────────
  const { rawToken, tokenHash } = generateInvitationToken();
  const users = new Map<string, FakeUser>();
  const invitations = new FakeInvitations(users);
  const pending = makeRow({ tokenHash });
  invitations.seed(pending);

  const deps: OwnerInvitationServiceDeps = {
    invitations,
    users: {
      findByEmail: async (email: string) => {
        const user = [...users.values()].find((u) => u.email === email);
        return user ?? null;
      },
    },
    createIdentity: async (input) => {
      const existing = [...users.values()].find((u) => u.email === input.email);
      if (existing) return { status: "EXISTS" };
      if (input.password.length < 8) return { status: "INVALID_PASSWORD" };
      const user: FakeUser = {
        id: USER_ID,
        email: input.email,
        name: input.name,
        emailVerified: false,
        image: null,
        businessId: null,
        role: "STAFF",
        isActive: true,
        accountType: "BUSINESS",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      users.set(user.id, user);
      return { status: "CREATED", userId: user.id };
    },
  };

  // ── A: getOwnerInvitationByToken({ token }) ──────────────────────────
  {
    const result = await getOwnerInvitationByToken({ token: rawToken }, deps);

    check("A1 الدعوة الصالحة المعلّقة → نجاح البحث", result.success === true);
    check(
      "A2 البيانات المعروضة تحمل البريد واسم المنشأة (بلا رمز أو تجزئة)",
      result.success === true &&
        result.data.invitation.email === EMAIL &&
        result.data.businessName === BUSINESS_NAME &&
        !JSON.stringify(result.data).includes(rawToken) &&
        !JSON.stringify(result.data).includes(tokenHash),
    );
    check(
      "A3 الحالة المشتقّة PENDING",
      result.success === true && result.data.status === "PENDING",
    );
    // The exact shape the /owner-invite/[token] page relies on.
    const view: PlatformInvitationView | undefined = result.success
      ? result.data.invitation
      : undefined;
    check(
      "A4 العرض يتبع مخطط العرض المعتمد",
      view !== undefined &&
        typeof view.id === "string" &&
        typeof view.email === "string" &&
        view.acceptedAt === null &&
        view.activatedAt === null,
    );
  }

  {
    const unknown = generateInvitationToken().rawToken;
    const result = await getOwnerInvitationByToken({ token: unknown }, deps);
    check(
      "A5 الرمز غير المعروف → INVITATION_NOT_FOUND (السلوك الأصلي)",
      isFailure(result) && result.error.code === "INVITATION_NOT_FOUND",
    );
    // Generic message — never helps differentiate token states.
    check(
      "A6 رسالة الخطأ لا تكشف حالة الرمز",
      isFailure(result) && !result.error.message.includes(unknown),
    );
  }

  {
    const expiredToken = generateInvitationToken().rawToken;
    invitations.seed(
      makeRow({
        tokenHash: hashInvitationToken(expiredToken),
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );
    const result = await getOwnerInvitationByToken(
      { token: expiredToken },
      deps,
    );
    check(
      "A7 الرمز المنتهي → نجاح البحث مع الحالة EXPIRED",
      result.success === true && result.data.status === "EXPIRED",
    );
    check(
      "A8 تصنيف الحالة المنتهية متطابق مع derivePlatformInvitationStatus",
      result.success === true &&
        result.data.status ===
          derivePlatformInvitationStatus(makeRow({ expiresAt: new Date(0) })),
    );
  }

  {
    const result = await getOwnerInvitationByToken(
      { token: "غير صالح@$" },
      deps,
    );
    check(
      "A9 الرمز الشكلي غير صالح → INVALID_INPUT",
      isFailure(result) && result.error.code === "INVALID_INPUT",
    );
  }

  // ── B: acceptOwnerInvitation({ token }) ──────────────────────────────
  {
    const before = await invitations.readByTokenHash(tokenHash);
    const result = await acceptOwnerInvitation({ token: rawToken }, deps);
    check("B1 قبول الدعوة الصالحة → نجاح أحادي المرة", result.success === true);
    check(
      "B2 القبول سجّل acceptedAt ولم يُفعّل الحساب",
      result.success === true &&
        (await invitations.readByTokenHash(tokenHash))?.acceptedAt !== null &&
        (await invitations.readByTokenHash(tokenHash))?.activatedAt === null,
    );
    check(
      "B3 القبول لم يُعد كتابة تجزئة الرمز",
      (await invitations.readByTokenHash(tokenHash))?.tokenHash ===
        before?.tokenHash,
    );

    const second = await acceptOwnerInvitation({ token: rawToken }, deps);
    check(
      "B4 المحاولة الثانية → فشل أحادية القبول (ACCOUNT_ALREADY_ACTIVATED)",
      isFailure(second) && second.error.code === "ACCOUNT_ALREADY_ACTIVATED",
    );
  }

  {
    const unknown = generateInvitationToken().rawToken;
    const result = await acceptOwnerInvitation({ token: unknown }, deps);
    check(
      "B5 قبول رمز غير معروف → INVITATION_NOT_FOUND",
      isFailure(result) && result.error.code === "INVITATION_NOT_FOUND",
    );
  }

  // ── C: activateOwnerAccount(...) — unchanged, regression only ────────
  {
    const result = await activateOwnerAccount(
      { token: rawToken, name: NAME, password: PASSWORD },
      deps,
    );
    check(
      "C1 التفعيل الصحيح → نجاح مع ربط المستخدم",
      result.success === true &&
        result.data.userId === USER_ID &&
        result.data.identityCreated === true,
    );
    check(
      "C2 التفعيل عيّن activatedAt",
      (await invitations.readByTokenHash(tokenHash))?.activatedAt !== null,
    );
    check(
      "C3 الهوية أُنشئت مرة واحدة (بريد واحد = مستخدم واحد)",
      [...users.values()].filter((u) => u.email === EMAIL).length === 1,
    );

    const badPassword = await activateOwnerAccount(
      { token: rawToken, name: NAME, password: "short" },
      deps,
    );
    check(
      "C4 كلمة المرور القصيرة → INVALID_INPUT (السلوك الأصلي)",
      isFailure(badPassword) && badPassword.error.code === "INVALID_INPUT",
    );
  }

  // A fresh invitation where activation precedes acceptance.
  {
    const fresh = generateInvitationToken();
    invitations.seed(makeRow({ tokenHash: fresh.tokenHash }));
    const notAccepted = await activateOwnerAccount(
      { token: fresh.rawToken, name: NAME, password: PASSWORD },
      deps,
    );
    check(
      "C5 التفعيل قبل القبول → INVITATION_NOT_ACCEPTED (السلوك الأصلي)",
      isFailure(notAccepted) &&
        notAccepted.error.code === "INVITATION_NOT_ACCEPTED",
    );
  }

  // ── D: Route-level behavior for /owner-invite/<valid-token> ──────────
  {
    // The page performs exactly this call with the raw path token and
    // maps any non-PERSISTENCE_FAILED failure to INVALID_TOKEN.
    const routeToken = generateInvitationToken();
    invitations.seed(makeRow({ tokenHash: routeToken.tokenHash }));
    const result = await getOwnerInvitationByToken(
      { token: routeToken.rawToken },
      deps,
    );
    const renderedInvalidToken =
      !result.success && result.error.code !== "PERSISTENCE_FAILED";
    check(
      "D1 /owner-invite/<رمز صالح> يصل إلى نموذج التفعيل بدل INVALID_TOKEN",
      result.success === true && !renderedInvalidToken,
    );
    check(
      "D2 الحالة المعروضة للصفحة PENDING (تعرض النموذج)",
      result.success === true && result.data.status === "PENDING",
    );

    // Reproducing the page's own branch for an unknown token.
    const unknown = generateInvitationToken().rawToken;
    const unknownResult = await getOwnerInvitationByToken(
      { token: unknown },
      deps,
    );
    const unknownNotice =
      !unknownResult.success &&
      unknownResult.error.code !== "PERSISTENCE_FAILED"
        ? "INVALID_TOKEN"
        : null;
    check(
      "D3 الرمز غير المعروف يبقى INVALID_TOKEN كما كان",
      unknownNotice === "INVALID_TOKEN",
    );
  }

  // ── R: bug regression guards ──────────────────────────────────────────
  {
    // The object { token } must validate — the string-field schema bug
    // is what produced INVALID_INPUT before any DB lookup.
    const guardToken = generateInvitationToken();
    invitations.seed(makeRow({ tokenHash: guardToken.tokenHash }));
    const objectInput = await getOwnerInvitationByToken(
      { token: guardToken.rawToken },
      deps,
    );
    check(
      "R1 الإدخال الكائن { token } لم يعد مرفوضاً INVALID_INPUT",
      !isFailure(objectInput) || objectInput.error.code !== "INVALID_INPUT",
    );
    const objectAccept = await acceptOwnerInvitation(
      { token: guardToken.rawToken },
      deps,
    );
    check(
      "R2 قبول الإدخال الكائن { token } لم يعد مرفوضاً INVALID_INPUT",
      !isFailure(objectAccept) || objectAccept.error.code !== "INVALID_INPUT",
    );

    // Schema-level proof: the activation schema keeps validating its own
    // object shape (unchanged) while the token-only schema accepts the
    // token object.
    const activationParse = activateOwnerInputSchema.safeParse({
      token: guardToken.rawToken,
      name: NAME,
      password: PASSWORD,
    });
    check(
      "R3 مخطط التفعيل لا يزال يتحقق من شكل الكائن الخاص به",
      activationParse.success === true &&
        activationParse.data.token === guardToken.rawToken,
    );
    const missingPassword = activateOwnerInputSchema.safeParse({
      token: guardToken.rawToken,
      name: NAME,
    });
    check(
      "R4 مخطط التفعيل يرفض الكائن الناقص",
      missingPassword.success === false,
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
    `\nمسار دعوة المالك سليم: ${checks.length}/${checks.length} فحص ناجح.`,
  );
}

main().catch((error: Error) => {
  console.error(`فشل غير متوقع: ${error.message}`);
  if (error.stack) console.error(error.stack);
  process.exit(1);
});
