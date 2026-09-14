/**
 * FlowPilot — ONE-TIME Platform Operator bootstrap (PROMPT-OPS-05).
 *
 * Creates the FIRST Platform Operator identity on the Production DB:
 * one user with `account_type = PLATFORM` + one credential account,
 * using the exact authentication primitives of the existing bootstrap
 * tool (better-auth/crypto hashPassword + better-auth/db
 * createLocalAccountIssuer + the credential-account shape of
 * prisma/seed.ts). No new auth system, no backdoor: the Platform
 * Operator is the platform-level control authority (DECISIONS #22) —
 * separate from Business ADMIN/STAFF, never a Business role.
 *
 * Run (package.json wires .env.local > .env precedence, DECISIONS #16):
 *   pnpm bootstrap:operator --check   read-only preflight (no writes)
 *   pnpm bootstrap:operator           interactive run (TTY, no-echo)
 *
 * Safety rails:
 *   - refuses to run unless the DATABASE_URL host matches the intended
 *     Production Neon endpoint (override: BOOTSTRAP_EXPECTED_DB_HOST);
 *   - refuses to run when a Platform Operator already exists
 *     (one-time semantics: at most ONE platform operator);
 *   - refuses to run when the schema is not deployed (pnpm db:deploy);
 *   - never echoes, logs, or prints the password, hash, or tokens;
 *   - verifies the resulting rows (accountType PLATFORM, credential
 *     account shape) after the write.
 */

import { createInterface } from "node:readline/promises";

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { createLocalAccountIssuer } from "better-auth/db";

/** Documented Production Neon endpoint id (host fragment — not a secret). */
const EXPECTED_DB_HOST_FRAGMENT = "ep-tiny-grass-a5e63jev";
/** Better Auth password bounds (DECISIONS #24 mirror). */
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fail(message: string): never {
  console.error(`✘ ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`✔ ${message}`);
}

function makeDb(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    fail(
      "DATABASE_URL غير معرّف. شغّل السكربت عبر `pnpm bootstrap:operator` (يحمّل .env.local > .env).",
    );
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

function dbHost(connectionString: string): string {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return fail("DATABASE_URL غير صالح — لا يمكن تحليل المضيف.");
  }
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

type OperatorInput = { email: string; name: string; password: string };

function validateInput(input: OperatorInput): string | null {
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

async function gatherInputInteractive(): Promise<OperatorInput> {
  const email = (
    await readLine("البريد الإلكتروني لمشغل المنصة: ")
  ).toLowerCase();
  const name = await readLine("اسم مشغل المنصة: ");
  const password = await readSecret("كلمة المرور (إدخال مخفي): ");
  const confirmed = await readSecret("تأكيد كلمة المرور (إدخال مخفي): ");
  if (password !== confirmed) {
    fail("تأكيد كلمة المرور لا يطابق — أعد تشغيل السكربت.");
  }
  return { email, name, password };
}

async function gatherInputFromEnv(): Promise<OperatorInput> {
  const email = (process.env.BOOTSTRAP_OPERATOR_EMAIL ?? "")
    .trim()
    .toLowerCase();
  const name = (process.env.BOOTSTRAP_OPERATOR_NAME ?? "").trim();
  const password = process.env.BOOTSTRAP_OPERATOR_PASSWORD ?? "";
  if (!email || !name || !password) {
    fail(
      "الوضع غير التفاعلي يتطلب BOOTSTRAP_OPERATOR_EMAIL و BOOTSTRAP_OPERATOR_NAME و BOOTSTRAP_OPERATOR_PASSWORD.",
    );
  }
  return { email, name, password };
}

async function preflight() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) fail("DATABASE_URL غير معرّف.");

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

  let operatorCount: number;
  try {
    operatorCount = await prisma.user.count({
      where: { accountType: "PLATFORM" },
    });
  } catch {
    fail(
      "تعذر قراءة قاعدة البيانات — تأكد من نشر المخطط عبر `pnpm db:deploy`.",
    );
  }

  if (operatorCount !== 0) {
    fail(
      `يوجد مشغل منصة بالفعل (${operatorCount}) — هذا السكربت لمرة واحدة فقط (مشغل واحد كحد أقصى).`,
    );
  }
  ok("لا يوجد مشغل منصة حالياً (0).");

  return { prisma, host };
}

async function createOperator(
  prisma: PrismaClient,
  input: OperatorInput,
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
          role: "STAFF", // لا دور عمل لمشغل المنصة — الحماية عبر accountType
          accountType: "PLATFORM",
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
    fail("تعذر إنشاء هوية المشغل — لم يتم إنشاء أي شيء.");
  }
  ok("تم إنشاء هوية مشغل المنصة + حساب الدخول في معاملة واحدة.");
  return userId;
}

async function verifyRows(
  prisma: PrismaClient,
  userId: string,
  email: string,
): Promise<void> {
  const [operatorCount, user, accounts] = await Promise.all([
    prisma.user.count({ where: { accountType: "PLATFORM" } }),
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.account.findMany({ where: { userId } }),
  ]);

  const checks: [string, boolean][] = [
    ["مشغل منصة واحد بالضبط", operatorCount === 1],
    ["نوع الحساب PLATFORM", user?.accountType === "PLATFORM"],
    ["الحساب نشط (isActive)", user?.isActive === true],
    ["businessId فارغ (مشغل — ليس مستخدم منشأة)", user?.businessId === null],
    ["البريد مطابق", user?.email === email],
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

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const { prisma, host } = await preflight();

  if (checkOnly) {
    ok("وضع الفحص فقط — لم يتم أي تعديل.");
    await prisma.$disconnect();
    return;
  }

  const input = process.stdin.isTTY
    ? await gatherInputInteractive()
    : await gatherInputFromEnv();

  const invalid = validateInput(input);
  if (invalid) fail(`بيانات غير صالحة: ${invalid}`);

  console.log("");
  console.log("── ملخص التشغيل ───────────────────────────────");
  console.log(`قاعدة البيانات: ${host}`);
  console.log(`البريد: ${input.email}`);
  console.log("سيتم إنشاء: صف مستخدم واحد (PLATFORM) + صف حساب دخول واحد.");
  console.log("مشغل المنصة منفصل عن مستخدمي المنشآت — يدير /platform فقط.");
  console.log("───────────────────────────────────────────────");

  const confirmed =
    process.argv.includes("--yes") || process.env.BOOTSTRAP_CONFIRM === "YES";
  if (!confirmed) {
    if (!process.stdin.isTTY) {
      fail(
        "وضع غير تفاعلي: مرّر --yes أو BOOTSTRAP_CONFIRM=YES للتأكيد الصريح.",
      );
    }
    const answer = await readLine(
      "تأكيد الكتابة في قاعدة البيانات (اكتب YES): ",
    );
    if (answer !== "YES") fail("لم يتم التأكيد — لم يتم أي تعديل.");
  }

  const userId = await createOperator(prisma, input);
  await verifyRows(prisma, userId, input.email);

  await prisma.$disconnect();
  console.log("");
  ok("تم. سجّل الدخول إلى /platform بحساب مشغل المنصة.");
}

main().catch((error: Error) => {
  const code = (error as { code?: string }).code;
  if (code === "P2021") {
    fail("جدول users غير موجود — انشر المخطط عبر `pnpm db:deploy` أولاً.");
  }
  fail(`فشل غير متوقع: ${error.message}`);
});
