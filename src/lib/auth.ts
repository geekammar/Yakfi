import { env } from "@/lib/env";
import {
  getAuthorizedPreviewHosts,
  getTrustedOrigins,
  isVercelPreview,
  resolveAppUrl,
} from "@/lib/url-resolver";
import { db } from "@/server/db";

import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";

export const auth = betterAuth({
  appName: "FlowPilot",
  baseURL: isVercelPreview()
    ? {
        allowedHosts: getAuthorizedPreviewHosts(),
        fallback: resolveAppUrl(),
        protocol: "https",
      }
    : env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: getTrustedOrigins(),
  database: prismaAdapter(db, {
    provider: "postgresql",
    // User + credential-account writes (e.g. signUpEmail) run in ONE
    // Prisma transaction — the public adapter option of the installed
    // version. Cross-boundary activation consistency is completed by
    // the invitation activation workflow's idempotent resume design.
    transaction: true,
  }),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    // FlowPilot domain fields living on the shared users table.
    // input:false → managed server-side (onboarding/admin), never by clients.
    additionalFields: {
      businessId: { type: "string", required: false, input: false },
      role: {
        type: "string",
        required: false,
        input: false,
        defaultValue: "STAFF",
      },
      isActive: {
        type: "boolean",
        required: false,
        input: false,
        defaultValue: true,
      },
      // Account scope (DECISIONS #22, PROMPT-ARCH-02): explicit
      // PLATFORM/BUSINESS marker. input:false — a client can never set
      // or escalate it; every invitation-first flow creates BUSINESS
      // accounts only. Platform access is NEVER inferred from
      // businessId = null (see server/auth/guards.ts).
      accountType: {
        type: "string",
        required: false,
        input: false,
        defaultValue: "BUSINESS",
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
