#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
import "./setup-test-env";

/**
 * Yakfi — Real Node (`next start`) + Disposable PostgreSQL Hosting Verification.
 *
 * Boots a real `next start --hostname 0.0.0.0 --port <port>` server in two
 * controlled phases against disposable PostgreSQL and loopback provider mocks:
 * 1. Unreachable DB phase:
 *    - `/api/health/live` returns HTTP 200 with zero DB dependency and exact
 *      `RENDER_GIT_COMMIT`.
 *    - `/api/health` returns HTTP 503 (`deploymentReady: false`,
 *      `database: "unreachable"`), never falsely reporting ready.
 * 2. Connected Render-like runtime phase:
 *    - `/sw.js` and `/offline.html` serve platform-neutral `Cache-Control:
 *      public, max-age=0, must-revalidate` from `next.config.ts`.
 *    - `/api/health` returns HTTP 200 with exact `RENDER_GIT_COMMIT` and passes
 *      `pollProductionReleaseReadiness`.
 *    - `RENDER=true` blocks `/qa/conversation-header` even when
 *      `FLOWPILOT_ENABLE_QA_HARNESS=true`.
 *    - Better Auth rejects untrusted `Origin` (403) and issues `__Secure-`
 *      `Secure; HttpOnly; SameSite=Lax` cookies for exact configured HTTPS
 *      `BETTER_AUTH_URL` / `NEXT_PUBLIC_APP_URL` without fake `VERCEL_ENV`.
 *    - `POST /api/telegram/webhook` flushes HTTP 200 immediately and executes
 *      actual `next/server` `after()` work on Node: controlled OpenRouter call,
 *      DB message persistence, `fp:<id>` decryption, and controlled Telegram
 *      `sendMessage` delivery (zero real Telegram sends, zero paid AI calls).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { auth } from "@/lib/auth";
import { PostgresRuntimeCredentialStore } from "@/server/credentials/runtime-credential-store";
import { db } from "@/server/db";
import { hashTelegramWebhookSecret } from "@/server/integrations/telegram/telegram-webhook";
import { runtimeCredentialRepository } from "@/server/repositories";

import pkg from "../package.json";
import { pollProductionReleaseReadiness } from "./verify-production-release.mjs";

type CheckItem = { label: string; pass: boolean; details?: unknown };
const checks: CheckItem[] = [];

function check(label: string, pass: boolean, details?: unknown): void {
  checks.push({ label, pass, details });
  if (pass) {
    console.log(`✔ ${label}`);
  } else {
    console.error(`✘ ${label}`);
    if (details !== undefined) {
      console.error("  details:", JSON.stringify(details, null, 2));
    }
  }
}

function isLocalDisposableDb(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname;
    const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
    return (
      loopback.has(host) ||
      host.endsWith(".local") ||
      host.endsWith(".localhost") ||
      host === ""
    );
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolvePort(port);
      });
    });
    srv.on("error", reject);
  });
}

async function waitForLiveness(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs = 25_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health/live`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (res.status === 200) {
        return;
      }
    } catch {
      // Server still booting
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health/live`);
}

async function stopChildProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 5_000;
  while (child.exitCode === null && Date.now() < deadline) {
    await sleep(100);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

function startNextServer(params: {
  port: number;
  envOverrides: Record<string, string>;
}): ChildProcess {
  const nextBin = resolve(process.cwd(), "node_modules/next/dist/bin/next");
  const child = spawn(
    process.execPath,
    [nextBin, "start", "--hostname", "0.0.0.0", "--port", String(params.port)],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        VERCEL_ENV: "",
        VERCEL_URL: "",
        VERCEL_BRANCH_URL: "",
        VERCEL_GIT_COMMIT_SHA: "",
        ...params.envOverrides,
      },
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text && process.env.DEBUG_RENDER_RUNTIME_TEST === "1") {
      console.error("[next-stderr]", text);
    }
  });
  return child;
}

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!isLocalDisposableDb(dbUrl)) {
    console.error(
      "Refusing to run check-render-runtime-db against a non-local DATABASE_URL.",
    );
    process.exit(1);
  }

  if (!existsSync(resolve(process.cwd(), ".next/BUILD_ID"))) {
    console.error(
      "Missing .next/BUILD_ID — run pnpm build before check:render-runtime-db.",
    );
    process.exit(1);
  }

  // ─── Phase 1: Unreachable DB Readiness Failure vs Lightweight Liveness ────
  const closedDbPort = await allocateFreePort();
  const portA = await allocateFreePort();
  const shaA = "e".repeat(40);
  const authSecretPlaceholder = `placeholder-${randomBytes(24).toString("hex")}`;
  let serverA: ChildProcess | null = null;

  try {
    serverA = startNextServer({
      port: portA,
      envOverrides: {
        DATABASE_URL: `postgresql://user:pass@127.0.0.1:${closedDbPort}/flowpilot_unreachable?connect_timeout=1`,
        BETTER_AUTH_SECRET: authSecretPlaceholder,
        BETTER_AUTH_URL: "https://yakfi-render-check.onrender.com",
        NEXT_PUBLIC_APP_URL: "https://yakfi-render-check.onrender.com",
        RENDER: "true",
        RENDER_GIT_COMMIT: shaA,
      },
    });
    const baseA = `http://127.0.0.1:${portA}`;
    await waitForLiveness(baseA, serverA);

    const liveRes = await fetch(`${baseA}/api/health/live`);
    const liveBody = (await liveRes.json()) as Record<string, unknown>;

    const readyRes = await fetch(`${baseA}/api/health`);
    const readyBody = (await readyRes.json()) as Record<string, unknown>;

    check(
      "DB1. /api/health/live returns HTTP 200 with RENDER_GIT_COMMIT while DB is unreachable",
      liveRes.status === 200 &&
        liveRes.headers.get("cache-control") === "no-store" &&
        liveBody.status === "ok" &&
        liveBody.live === true &&
        liveBody.commitSha === shaA,
      { status: liveRes.status, liveBody },
    );

    check(
      "DB2. /api/health returns HTTP 503 (never 200) when DB is unreachable",
      readyRes.status === 503 &&
        readyRes.headers.get("cache-control") === "no-store" &&
        readyBody.status === "degraded" &&
        readyBody.deploymentReady === false &&
        readyBody.database === "unreachable" &&
        readyBody.commitSha === shaA,
      { status: readyRes.status, readyBody },
    );
  } finally {
    await stopChildProcess(serverA);
  }

  // ─── Phase 2: Connected Render Runtime, Headers, Auth & Real after() ──────
  const openRouterHits: Array<{ at: number; path: string }> = [];
  const telegramHits: Array<{
    at: number;
    path: string;
    body: Record<string, unknown>;
  }> = [];

  const mockServer: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const urlPath = req.url ?? "";

      if (urlPath.startsWith("/__mock_openrouter.ai/")) {
        // Intentional 120ms delay proves `after()` finishes strictly AFTER the
        // webhook HTTP 200 response has already returned to the caller.
        setTimeout(() => {
          openRouterHits.push({ at: Date.now(), path: urlPath });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl-render-after-test",
              model: "deepseek/deepseek-v4.1-flash",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: JSON.stringify({
                      intent: "HUMAN_REQUEST",
                      action: "handoff",
                      content: "تم تحويل المحادثة لفريق العمل للمتابعة.",
                      extraction: {
                        service: null,
                        provider: null,
                        date: null,
                        timePreference: null,
                        temporalRequest: null,
                        exactTime: null,
                      },
                      handoffReason: "HUMAN_REQUEST",
                      summary: null,
                    }),
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 95,
                completion_tokens: 24,
                total_tokens: 119,
              },
            }),
          );
        }, 120);
        return;
      }

      if (urlPath.startsWith("/__mock_api.telegram.org/")) {
        let parsedBody: Record<string, unknown> = {};
        try {
          parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          parsedBody = {};
        }
        telegramHits.push({ at: Date.now(), path: urlPath, body: parsedBody });
        res.writeHead(200, { "Content-Type": "application/json" });
        if (urlPath.endsWith("/sendMessage")) {
          res.end(
            JSON.stringify({
              ok: true,
              result: {
                message_id: 90123,
                date: Math.floor(Date.now() / 1000),
                chat: { id: parsedBody.chat_id ?? 777001, type: "private" },
                text: String(parsedBody.text ?? ""),
              },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    mockServer.listen(0, "127.0.0.1", () => resolveListen());
    mockServer.on("error", rejectListen);
  });
  const mockPort = (mockServer.address() as AddressInfo).port;
  const mockOrigin = `http://127.0.0.1:${mockPort}`;

  const priorPolicy = await db.platformAiPolicy.findUnique({
    where: { id: "singleton" },
  });
  let createdBusinessId: string | null = null;
  let createdUserId: string | null = null;
  let serverB: ChildProcess | null = null;

  const testMasterKeyHex = randomBytes(32).toString("hex");
  const syntheticBotCred = `999111222:placeholder_${randomBytes(12).toString("hex")}`;
  const webhookHeaderVal = `whsec_placeholder_${randomBytes(16).toString("hex")}`;
  const webhookSecretDigest = hashTelegramWebhookSecret(webhookHeaderVal);
  const credentialRef = `fp:render-test-${randomUUID()}`;
  const renderOrigin = "https://yakfi-render-check.onrender.com";
  const shaB = "f".repeat(40);
  const testEmail = `render.migration.${Date.now()}@flowpilot.test`;
  const userPassPlaceholder = "ExampleRenderPass@1234";

  try {
    await db.platformAiPolicy.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        primaryProvider: "openrouter",
        primaryModel: "deepseek/deepseek-v4.1-flash",
        fallbackEnabled: false,
        primarySecretRef: "OPENROUTER_API_KEY",
      },
      update: {
        primaryProvider: "openrouter",
        primaryModel: "deepseek/deepseek-v4.1-flash",
        fallbackEnabled: false,
        primarySecretRef: "OPENROUTER_API_KEY",
        openRouterProviderOnly: null,
      },
    });

    const business = await db.business.create({
      data: {
        name: "عيادة اختبار ريندر",
        whatsappNumber: `+96659${String(Date.now()).slice(-7)}`,
        timezone: "Asia/Riyadh",
        onboardingCompletedAt: new Date(),
      },
    });
    createdBusinessId = business.id;

    const defaultBranch = await db.branch.create({
      data: {
        businessId: business.id,
        name: "الفرع الرئيسي",
      },
    });
    await db.business.update({
      where: { id: business.id },
      data: { defaultBranchId: defaultBranch.id },
    });

    const credStore = new PostgresRuntimeCredentialStore({
      repository: runtimeCredentialRepository,
      masterKey: testMasterKeyHex,
    });
    const storedCred = await credStore.store({
      businessId: business.id,
      reference: credentialRef,
      secret: syntheticBotCred,
    });
    if (!storedCred.ok) {
      throw new Error(
        `Failed to store synthetic runtime credential: ${storedCred.code}`,
      );
    }

    await db.telegramConnection.create({
      data: {
        businessId: business.id,
        branchId: defaultBranch.id,
        displayName: "Render Test Bot",
        botExternalId: `999${String(Date.now()).slice(-6)}`,
        botUsername: "RenderMigrationCheckBot",
        provider: "telegram_managed",
        status: "CONNECTED",
        isActive: true,
        credentialsRef: credentialRef,
        credentialKind: "RUNTIME",
        webhookSecretHash: webhookSecretDigest,
      },
    });

    await (auth.api.signUpEmail as any)({
      body: {
        email: testEmail,
        password: userPassPlaceholder,
        name: "Render Check Admin",
      },
    });
    const updatedUser = await db.user.update({
      where: { email: testEmail },
      data: {
        isActive: true,
        businessId: business.id,
        role: "ADMIN",
        accountType: "BUSINESS",
      },
    });
    createdUserId = updatedUser.id;

    const portB = await allocateFreePort();
    const preloadPath = resolve(
      process.cwd(),
      "scripts/render-test-fetch-preload.mjs",
    );
    const preloadUrl = pathToFileURL(preloadPath).href;
    const inheritedNodeOptions = process.env.NODE_OPTIONS?.trim();
    const childNodeOptions = inheritedNodeOptions
      ? `${inheritedNodeOptions} --import ${preloadUrl}`
      : `--import ${preloadUrl}`;
    serverB = startNextServer({
      port: portB,
      envOverrides: {
        DATABASE_URL: dbUrl!,
        BETTER_AUTH_SECRET: authSecretPlaceholder,
        BETTER_AUTH_URL: renderOrigin,
        NEXT_PUBLIC_APP_URL: renderOrigin,
        CREDENTIAL_MASTER_KEY: testMasterKeyHex,
        OPENROUTER_API_KEY: "placeholder-openrouter-ci-key",
        RENDER: "true",
        RENDER_GIT_COMMIT: shaB,
        FLOWPILOT_ENABLE_QA_HARNESS: "true",
        FLOWPILOT_CI_MOCK_PROVIDER_ORIGIN: mockOrigin,
        NODE_OPTIONS: childNodeOptions,
      },
    });

    const baseB = `http://127.0.0.1:${portB}`;
    await waitForLiveness(baseB, serverB);

    // 1. Platform-neutral Cache-Control headers on /sw.js and /offline.html
    const swRes = await fetch(`${baseB}/sw.js`);
    const offlineRes = await fetch(`${baseB}/offline.html`);
    check(
      "DB3. Live Next server returns Cache-Control: public, max-age=0, must-revalidate for /sw.js & /offline.html",
      swRes.status === 200 &&
        swRes.headers.get("cache-control") ===
          "public, max-age=0, must-revalidate" &&
        offlineRes.status === 200 &&
        offlineRes.headers.get("cache-control") ===
          "public, max-age=0, must-revalidate",
      {
        swCache: swRes.headers.get("cache-control"),
        offlineCache: offlineRes.headers.get("cache-control"),
      },
    );

    // 2. Ready /api/health + exact SHA release verifier
    const readyBRes = await fetch(`${baseB}/api/health`);
    const readyBBody = (await readyBRes.json()) as Record<string, unknown>;
    const releasePass = await pollProductionReleaseReadiness(
      {
        deploymentTarget: "render",
        productionBaseUrl: renderOrigin,
        expectedCommitSha: shaB,
        checkedOutCommitSha: shaB,
        expectedVersion: pkg.version,
      },
      {
        maxAttempts: 1,
        log: () => {},
        fetchImpl: async () => fetch(`${baseB}/api/health`),
      },
    );
    const releaseWrongSha = await pollProductionReleaseReadiness(
      {
        deploymentTarget: "render",
        productionBaseUrl: renderOrigin,
        expectedCommitSha: "9".repeat(40),
        checkedOutCommitSha: "9".repeat(40),
        expectedVersion: pkg.version,
      },
      {
        maxAttempts: 1,
        log: () => {},
        fetchImpl: async () => fetch(`${baseB}/api/health`),
      },
    );

    check(
      "DB4. Connected /api/health returns HTTP 200 + exact RENDER_GIT_COMMIT and satisfies release verifier",
      readyBRes.status === 200 &&
        readyBBody.deploymentReady === true &&
        readyBBody.database === "connected" &&
        readyBBody.commitSha === shaB &&
        releasePass.ok === true &&
        releaseWrongSha.ok === false &&
        releaseWrongSha.code === "LIVE_COMMIT_SHA_MISMATCH",
      { readyBBody, releasePass, releaseWrongSha },
    );

    // 3. QA harness blocked on Render production runtime
    const qaRes = await fetch(`${baseB}/qa/conversation-header`, {
      redirect: "manual",
    });
    check(
      "DB5. QA fixture route is blocked on Render production (redirected to /sign-in)",
      qaRes.status === 307 &&
        (qaRes.headers.get("location") ?? "").includes("/sign-in"),
      { status: qaRes.status, location: qaRes.headers.get("location") },
    );

    // 4. Better Auth exact Origin check & Secure cookie flags
    const untrustedSignIn = await fetch(`${baseB}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted-attacker.onrender.com",
      },
      body: JSON.stringify({
        email: testEmail,
        password: userPassPlaceholder,
      }),
    });

    const trustedSignIn = await fetch(`${baseB}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: renderOrigin,
        "X-Forwarded-Proto": "https",
        "X-Forwarded-Host": "yakfi-render-check.onrender.com",
      },
      body: JSON.stringify({
        email: testEmail,
        password: userPassPlaceholder,
      }),
    });
    const setCookieHeader = trustedSignIn.headers.get("set-cookie") ?? "";

    check(
      "DB6. Better Auth rejects untrusted Origin (403) and issues Secure HttpOnly cookie for exact Render HTTPS origin",
      untrustedSignIn.status === 403 &&
        (untrustedSignIn.headers.get("set-cookie") ?? "") === "" &&
        trustedSignIn.status === 200 &&
        setCookieHeader.includes("__Secure-") &&
        setCookieHeader.toLowerCase().includes("secure") &&
        setCookieHeader.toLowerCase().includes("httponly"),
      {
        untrustedStatus: untrustedSignIn.status,
        trustedStatus: trustedSignIn.status,
        hasSecurePrefix: setCookieHeader.includes("__Secure-"),
      },
    );

    // 5. Real `next/server` `after()` execution on Telegram webhook
    const customerChatId = 88442211;
    const webhookRes = await fetch(`${baseB}/api/telegram/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": webhookHeaderVal,
      },
      body: JSON.stringify({
        update_id: 710001,
        message: {
          message_id: 501,
          date: Math.floor(Date.now() / 1000),
          chat: { id: customerChatId, type: "private", first_name: "سارة" },
          from: { id: customerChatId, is_bot: false, first_name: "سارة" },
          text: "أريد التحدث مع موظف الاستقبال من فضلكم",
        },
      }),
    });
    const responseFlushedAt = Date.now();
    const webhookBody = (await webhookRes.json()) as Record<string, unknown>;

    // Wait for `after()` background work to finish OpenRouter + DB + Telegram sendMessage
    const afterDeadline = Date.now() + 8_000;
    while (telegramHits.length === 0 && Date.now() < afterDeadline) {
      await sleep(100);
    }

    const conversations = await db.conversation.findMany({
      where: { businessId: business.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    const persistedConv = conversations[0];
    const sendHit = telegramHits.find((h) => h.path.endsWith("/sendMessage"));
    const openRouterHit = openRouterHits[0];

    check(
      "DB7. Real next/server after() flushes HTTP 200 first, then runs controlled AI + DB + Telegram sendMessage",
      webhookRes.status === 200 &&
        webhookBody.success === true &&
        webhookBody.received === 1 &&
        openRouterHits.length === 1 &&
        Boolean(openRouterHit && openRouterHit.at >= responseFlushedAt) &&
        Boolean(sendHit) &&
        String(sendHit?.body.chat_id) === String(customerChatId) &&
        typeof sendHit?.body.text === "string" &&
        sendHit.body.text.length > 0 &&
        persistedConv?.status === "NEED_HUMAN" &&
        (persistedConv?.messages.length ?? 0) >= 2,
      {
        webhookStatus: webhookRes.status,
        webhookSuccess: webhookBody.success,
        openRouterCount: openRouterHits.length,
        afterFlushedDeltaMs: openRouterHit
          ? openRouterHit.at - responseFlushedAt
          : null,
        telegramHitCount: telegramHits.length,
        conversationStatus: persistedConv?.status,
        persistedMessages: persistedConv?.messages.length,
      },
    );
  } finally {
    await stopChildProcess(serverB);
    await new Promise<void>((r) => mockServer.close(() => r()));

    if (createdUserId) {
      await db.session
        .deleteMany({ where: { userId: createdUserId } })
        .catch(() => {});
      await db.account
        .deleteMany({ where: { userId: createdUserId } })
        .catch(() => {});
      await db.user
        .deleteMany({ where: { id: createdUserId } })
        .catch(() => {});
    }
    if (createdBusinessId) {
      await db.conversationDeliveryRoute
        .deleteMany({ where: { businessId: createdBusinessId } })
        .catch(() => {});
      await db.inboundMessageDedupe
        .deleteMany({ where: { businessId: createdBusinessId } })
        .catch(() => {});
      await db.message
        .deleteMany({
          where: { conversation: { businessId: createdBusinessId } },
        })
        .catch(() => {});
      await db.conversation
        .deleteMany({ where: { businessId: createdBusinessId } })
        .catch(() => {});
      await db.customer
        .deleteMany({ where: { businessId: createdBusinessId } })
        .catch(() => {});
      await db.telegramConnection
        .deleteMany({ where: { businessId: createdBusinessId } })
        .catch(() => {});
      await db.business
        .updateMany({
          where: { id: createdBusinessId },
          data: { defaultBranchId: null },
        })
        .catch(() => {});
      await db.branch
        .deleteMany({ where: { businessId: createdBusinessId } })
        .catch(() => {});
      await db.business
        .deleteMany({ where: { id: createdBusinessId } })
        .catch(() => {});
    }
    if (priorPolicy) {
      await db.platformAiPolicy
        .update({
          where: { id: "singleton" },
          data: {
            primaryProvider: priorPolicy.primaryProvider,
            primaryModel: priorPolicy.primaryModel,
            secondaryProvider: priorPolicy.secondaryProvider,
            secondaryModel: priorPolicy.secondaryModel,
            fallbackEnabled: priorPolicy.fallbackEnabled,
            primarySecretRef: priorPolicy.primarySecretRef,
            secondarySecretRef: priorPolicy.secondarySecretRef,
            openRouterProviderOnly: priorPolicy.openRouterProviderOnly,
          },
        })
        .catch(() => {});
    } else {
      await db.platformAiPolicy
        .deleteMany({ where: { id: "singleton" } })
        .catch(() => {});
    }
    await db.$disconnect().catch(() => {});
  }

  const failed = checks.filter((c) => !c.pass).length;
  if (failed > 0) {
    console.error(
      `\nFailed ${failed} of ${checks.length} real-Node Render runtime checks.`,
    );
    process.exit(1);
  }
  console.log(
    `\nAll ${checks.length}/${checks.length} real-Node Render runtime + disposable DB checks PASSED.`,
  );
}

main().catch((err: unknown) => {
  console.error("Unexpected error in check-render-runtime-db:", err);
  process.exit(1);
});
