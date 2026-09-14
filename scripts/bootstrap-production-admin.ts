/**
 * FlowPilot — ONE-TIME Production ADMIN bootstrap (PROMPT-OPS-04).
 *
 * Creates the FIRST Better Auth identity on a DATA-EMPTY Production DB:
 * one ADMIN user (businessId null) + one credential account, using the
 * repository's existing authentication primitives only (better-auth/crypto
 * hashPassword + better-auth/db createLocalAccountIssuer + the exact
 * credential-account shape of prisma/seed.ts). No hashing format is
 * invented; no backdoor is left behind: the Business itself is created
 * in-app afterwards through the canonical onboarding wizard
 * (`saveBusinessSetup` → `businessRepository.createForUser`, which
 * attaches the ADMIN membership + Default Branch atomically).
 *
 * Run (package.json wires .env.local > .env precedence, DECISIONS #16):
 *   pnpm bootstrap:admin --check   read-only preflight (no writes)
 *   pnpm bootstrap:admin           interactive run (TTY prompts, no-echo)
 *
 * Non-TTY (operator-owned env only — never commit these):
 *   BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_NAME / BOOTSTRAP_ADMIN_PASSWORD
 *   plus explicit consent: --yes flag or BOOTSTRAP_CONFIRM=YES
 *
 * Safety rails:
 *   - refuses to run unless the DATABASE_URL host matches the intended
 *     Production Neon endpoint (override: BOOTSTRAP_EXPECTED_DB_HOST);
 *   - refuses to run unless the DB is EMPTY (0 users, 0 businesses);
 *   - refuses to run when the schema is not deployed (pnpm db:deploy);
 *   - never echoes, logs, or prints the password, hash, or cookie values;
 *   - verifies the resulting rows and (by default) performs a live
 *     sign-in verification against the Production deployment, then
 *     signs the session out (session token never printed).
 */

import { createInterface } from "node:readline/promises";

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { createLocalAccountIssuer } from "better-auth/db";

/** Documented Production Neon endpoint id (host fragment — not a secret). */
const EXPECTED_DB_HOST_FRAGMENT = "ep-tiny-grass-a5e63jev";
/** Production deployment used for the live sign-in verification. */
const DEFAULT_VERIFY_URL = "https://flowpilot-prod.vercel.app";
/** Better Auth password bounds (DECISIONS #24 mirror). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

type Args = {
  check: boolean;
  yes: boolean;
  noVerify: boolean;
  verifyUrl: string | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    check: false,
    yes: false,
    noVerify: false,
    verifyUrl: process.env.BOOTSTRAP_VERIFY_URL ?? null,
  };
  for (const raw of argv) {
    if (raw === "--check") args.check = true;
    else if (raw === "--yes") args.yes = true;
    else if (raw === "--no-verify") args.noVerify = true;
    else if (raw.startsWith("--verify-url=")) {
      args.verifyUrl = raw.slice("--verify-url=".length) || null;
    }
  }
  return args;
}

function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`✔ ${message}`);
}

function dbHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return fail("DATABASE_URL غير صالح — لا يمكن تحليل المضيف.");
  }
}

function makeDb(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail(
      "DATABASE_URL غير معرّف. شغّل السكربت عبر `pnpm bootstrap:admin` (يحمّل .env.local > .env).",
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(prompt)).trim();
  } finally {
    rl.close();
  }
}

/** No-echo secret prompt (raw mode; nothing is printed back). */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("STDIN_NOT_TTY"));
      return;
    }
    process.stdout.write(prompt);
    const chars: string[] = [];
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk: Buffer): void => {
      const input = chunk.toString("utf8");
      for (const char of input) {
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(wasRaw);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(chars.join(""));
          return;
        }
        if (char === "\u0003" || char === "\u0004") {
          process.stdout.write("\n");
          process.exit(1);
        }
        if (char === "\u007f" || char === "\b") {
          chars.pop();
          continue;
        }
        if (char >= " ") chars.push(char);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("error", (error: Error) => {
      process.stdin.setRawMode(wasRaw);
      reject(error);
    });
  });
}

type AdminInput = {
  email: string;
  name: string;
  password: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateInput(input: AdminInput): string | null {
  if (input.email.length < 3 || input.email.length > 255) {
    return "البريد الإلكتروني غير صالح";
  }
  if (!EMAIL_PATTERN.test(input.email)) {
    return "البريد الإلكتروني غير صالح";
  }
  if (input.name.length < 1 || input.name.length > 100) {
    return "الاسم مطلوب (حتى 100 حرف)";
  }
  if (
    input.password.length < PASSWORD_MIN ||
    input.password.length > PASSWORD_MAX
  ) {
    return `كلمة المرور يجب أن تكون بين ${PASSWORD_MIN} و ${PASSWORD_MAX} حرفاً`;
  }
  return null;
}

async function gatherInputInteractive(): Promise<AdminInput> {
  const email = (await readLine("البريد الإلكتروني للمدير: ")).toLowerCase();
  const name = await readLine("اسم المدير: ");
  const password = await readSecret("كلمة المرور (إدخال مخفي): ");
  const confirmed = await readSecret("تأكيد كلمة المرور (إدخال مخفي): ");
  if (password !== confirmed) {
    fail("تأكيد كلمة المرور لا يطابق — أعد تشغيل السكربت.");
  }
  return { email, name, password };
}

async function gatherInputFromEnv(): Promise<AdminInput> {
  const email = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const name = (process.env.BOOTSTRAP_ADMIN_NAME ?? "").trim();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
  if (!email || !name || !password) {
    fail(
      "الوضع غير التفاعلي يتطلب BOOTSTRAP_ADMIN_EMAIL و BOOTSTRAP_ADMIN_NAME و BOOTSTRAP_ADMIN_PASSWORD.",
    );
  }
  return { email, name, password };
}

async function preflight() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail("DATABASE_URL غير معرّف.");
  }
  const expectedHost =
    process.env.BOOTSTRAP_EXPECTED_DB_HOST ?? EXPECTED_DB_HOST_FRAGMENT;
  const host = dbHost(connectionString);
  if (!host.includes(expectedHost)) {
    fail(
      `قاعدة البيانات غير متوقعة (${host}) — المتوقع يحتوي "${expectedHost}". إيقاف للسلامة.`,
    );
  }
  ok(`قاعدة البيانات المستهدفة: ${host}`);

  const prisma = makeDb();

  let userCount: number;
  let businessCount: number;
  try {
    [userCount, businessCount] = await prisma.$transaction([
      prisma.user.count(),
      prisma.business.count(),
    ]);
  } catch {
    fail(
      "تعذر قراءة قاعدة البيانات — تأكد من نشر المخطط عبر `pnpm db:deploy`.",
    );
  }

  if (userCount !== 0 || businessCount !== 0) {
    fail(
      `قاعدة البيانات ليست فارغة (${userCount} مستخدم، ${businessCount} منشأة) — هذا السكربت للتشغيل الأول فقط.`,
    );
  }
  ok("قاعدة البيانات فارغة (0 مستخدمين، 0 منشآت).");

  return { prisma, host, userCount, businessCount };
}

async function confirmWrite(host: string, input: AdminInput): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log("");
  console.log("── ملخص التشغيل ───────────────────────────────");
  console.log(`قاعدة البيانات: ${host}`);
  console.log(`البريد: ${input.email}`);
  console.log(
    "سيتم إنشاء: صف مستخدم واحد (ADMIN/BUSINESS) + صف حساب دخول واحد.",
  );
  console.log("المنشأة نفسها تُنشأ لاحقاً من داخل التطبيق عبر Onboarding.");
  console.log("───────────────────────────────────────────────");

  if (args.yes || process.env.BOOTSTRAP_CONFIRM === "YES") return;

  if (!process.stdin.isTTY) {
    fail("وضع غير تفاعلي: مرّر --yes أو BOOTSTRAP_CONFIRM=YES للتأكيد الصريح.");
  }
  const answer = await readLine("تأكيد الكتابة في الإنتاج (اكتب YES): ");
  if (answer !== "YES") {
    fail("لم يتم التأكيد — لم يتم أي تعديل.");
  }
}

async function createAdmin(
  prisma: PrismaClient,
  input: AdminInput,
): Promise<string> {
  const userId = crypto.randomUUID();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          name: input.name,
          email: input.email,
          emailVerified: false,
          image: null,
          role: "ADMIN",
          accountType: "BUSINESS",
          isActive: true,
        },
      });
      await tx.account.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          accountId: userId,
          providerId: "credential",
          issuer: createLocalAccountIssuer("credential"),
          password: await hashPassword(input.password),
        },
      });
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002") {
      fail("البريد مستخدم بالفعل — لم يتم إنشاء أي شيء.");
    }
    fail("تعذر إنشاء الهوية — لم يتم إنشاء أي شيء.");
  }
  ok("تم إنشاء هوية المدير + حساب الدخول في معاملة واحدة.");
  return userId;
}

async function verifyRows(
  prisma: PrismaClient,
  userId: string,
  email: string,
): Promise<void> {
  const [userCount, businessCount, user, accounts] = await Promise.all([
    prisma.user.count(),
    prisma.business.count(),
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.account.findMany({ where: { userId } }),
  ]);

  const checks: [string, boolean][] = [
    ["مستخدم واحد بالضبط (لا تكرار)", userCount === 1],
    ["0 منشآت (تُنشأ من Onboarding لاحقاً)", businessCount === 0],
    ["الحساب نشط (isActive)", user?.isActive === true],
    ["الدور ADMIN", user?.role === "ADMIN"],
    ["نوع الحساب BUSINESS (ليس PLATFORM)", user?.accountType === "BUSINESS"],
    ["البريد مطابق", user?.email === email],
    ["businessId فارغ (يُربط عبر Onboarding)", user?.businessId === null],
    ["حساب دخول واحد", accounts.length === 1],
    ["providerId = credential", accounts[0]?.providerId === "credential"],
    ["accountId = معرّف المستخدم", accounts[0]?.accountId === userId],
    [
      "issuer = local:credential",
      accounts[0]?.issuer === createLocalAccountIssuer("credential"),
    ],
    ["تجزئة كلمة المرور محفوظة", Boolean(accounts[0]?.password)],
  ];

  let failed = 0;
  for (const [label, pass] of checks) {
    if (pass) ok(label);
    else {
      console.error(`✘ ${label}`);
      failed += 1;
    }
  }
  if (failed > 0) fail(`فشل ${failed} من فحوص التحقق.`);
  ok("جميع فحوص قاعدة البيانات ناجحة.");
}

type LiveCheck = { label: string; pass: boolean; detail?: string };

function cookieHeader(response: Response): string | null {
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) return null;
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

async function liveSignInVerification(
  baseUrl: string,
  input: AdminInput,
  userId: string,
): Promise<void> {
  console.log("");
  console.log(`── التحقق المباشر من تسجيل الدخول (${baseUrl}) ──`);
  const results: LiveCheck[] = [];
  const run = async (
    label: string,
    fn: () => Promise<boolean>,
  ): Promise<void> => {
    try {
      results.push({ label, pass: await fn() });
    } catch (error) {
      results.push({
        label,
        pass: false,
        detail: (error as Error).message,
      });
    }
  };

  let sessionCookie: string | null = null;

  await run("صفحة /sign-in تعمل (RTL)", async () => {
    const response = await fetch(`${baseUrl}/sign-in`, { redirect: "manual" });
    if (response.status !== 200) return false;
    const html = await response.text();
    return html.includes('dir="rtl"');
  });

  await run("الزائر غير المسجل يُحوَّل من / إلى /sign-in", async () => {
    const response = await fetch(`${baseUrl}/`, { redirect: "manual" });
    const location = response.headers.get("location") ?? "";
    return (
      response.status >= 300 &&
      response.status < 400 &&
      location.includes("/sign-in")
    );
  });

  await run("منطقة المدير محمية للزائر غير المسجل", async () => {
    const response = await fetch(`${baseUrl}/admin/team`, {
      redirect: "manual",
    });
    const location = response.headers.get("location") ?? "";
    return (
      response.status >= 300 &&
      response.status < 400 &&
      location.includes("/sign-in")
    );
  });

  await run("تسجيل الدخول يعمل (جلسة تُنشأ)", async () => {
    const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
      },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
      }),
      redirect: "manual",
    });
    sessionCookie = cookieHeader(response);
    return response.status === 200 && sessionCookie !== null;
  });

  await run("الجلسة صالحة: ADMIN / BUSINESS", async () => {
    if (!sessionCookie) return false;
    const response = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { cookie: sessionCookie },
    });
    if (response.status !== 200) return false;
    const body = (await response.json()) as {
      user?: { id?: string; role?: string; accountType?: string };
    } | null;
    return (
      body?.user?.id === userId &&
      body.user.role === "ADMIN" &&
      body.user.accountType === "BUSINESS"
    );
  });

  await run("تسجيل الدخول يُحوَّل إلى /onboarding (حالة التهيئة)", async () => {
    if (!sessionCookie) return false;
    const response = await fetch(`${baseUrl}/`, {
      headers: { cookie: sessionCookie },
      redirect: "manual",
    });
    const location = response.headers.get("location") ?? "";
    return (
      response.status >= 300 &&
      response.status < 400 &&
      location.includes("/onboarding")
    );
  });

  await run("منطقة Onboarding متاحة للمدير", async () => {
    if (!sessionCookie) return false;
    const response = await fetch(`${baseUrl}/onboarding`, {
      headers: { cookie: sessionCookie },
      redirect: "manual",
    });
    return response.status === 200;
  });

  await run("مساحة STAFF مرفوضة للمدير (access-denied)", async () => {
    if (!sessionCookie) return false;
    const response = await fetch(`${baseUrl}/staff`, {
      headers: { cookie: sessionCookie },
      redirect: "manual",
    });
    const location = response.headers.get("location") ?? "";
    return (
      response.status >= 300 &&
      response.status < 400 &&
      location.includes("/access-denied")
    );
  });

  await run("تسجيل الخروج يعمل", async () => {
    if (!sessionCookie) return false;
    const response = await fetch(`${baseUrl}/api/auth/sign-out`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: baseUrl,
        cookie: sessionCookie,
      },
      body: "{}",
      redirect: "manual",
    });
    return response.status === 200;
  });

  await run("الجلسة لاغية بعد تسجيل الخروج", async () => {
    if (!sessionCookie) return false;
    const response = await fetch(`${baseUrl}/api/auth/get-session`, {
      headers: { cookie: sessionCookie },
    });
    if (response.status === 401) return true;
    if (response.status !== 200) return false;
    const body = await response.json();
    return body === null;
  });

  let failed = 0;
  for (const result of results) {
    if (result.pass) ok(result.label);
    else {
      console.error(
        `✘ ${result.label}${result.detail ? ` — ${result.detail}` : ""}`,
      );
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(
      "⚠ فشل بعض فحوص التحقق المباشر — جرّب تسجيل الدخول يدوياً من المتصفح.",
    );
  } else {
    ok("التحقق المباشر من تسجيل الدخول ناجح بالكامل.");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { prisma, host } = await preflight();

  if (args.check) {
    ok("وضع الفحص فقط — لم يتم أي تعديل.");
    await prisma.$disconnect();
    return;
  }

  const input = process.stdin.isTTY
    ? await gatherInputInteractive()
    : await gatherInputFromEnv();

  const invalid = validateInput(input);
  if (invalid) fail(`بيانات غير صالحة: ${invalid}`);

  await confirmWrite(host, input);
  const userId = await createAdmin(prisma, input);
  await verifyRows(prisma, userId, input.email);

  if (args.noVerify) {
    console.log("");
    ok("تم تخطي التحقق المباشر — سجّل الدخول يدوياً من المتصفح.");
  } else {
    const baseUrl = (args.verifyUrl ?? DEFAULT_VERIFY_URL).replace(/\/$/, "");
    await liveSignInVerification(baseUrl, input, userId);
  }

  await prisma.$disconnect();
  console.log("");
  ok("تم. الخطوة التالية: سجّل الدخول وأكمل Onboarding لإنشاء المنشأة.");
}

main().catch((error: Error) => {
  const code = (error as { code?: string }).code;
  if (code === "P2021") {
    fail("جدول users غير موجود — انشر المخطط عبر `pnpm db:deploy` أولاً.");
  }
  fail(`فشل غير متوقع: ${error.message}`);
});
