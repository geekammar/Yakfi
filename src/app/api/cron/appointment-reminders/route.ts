import { timingSafeEqual } from "node:crypto";

import {
  defaultAppointmentReminderServiceDeps,
  processDueReminders,
} from "@/features/appointments/server/appointment-reminder.service";

import { NextResponse, type NextRequest } from "next/server";

/**
 * Validates request authentication against CRON_SECRET using timing-safe comparison.
 */
function verifyCronSecret(request: NextRequest): boolean {
  const configuredSecret = process.env.CRON_SECRET;

  // In production, an unset secret fails closed
  if (!configuredSecret) {
    return process.env.NODE_ENV !== "production";
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const customHeader = request.headers.get("x-cron-secret") ?? "";

  let candidate = "";
  if (authHeader.startsWith("Bearer ")) {
    candidate = authHeader.slice(7).trim();
  } else if (customHeader) {
    candidate = customHeader.trim();
  }

  if (!candidate || candidate.length !== configuredSecret.length) {
    return false;
  }

  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(configuredSecret, "utf8");
  return timingSafeEqual(a, b);
}

async function handleCron(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processDueReminders(
      defaultAppointmentReminderServiceDeps,
    );
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  return handleCron(request);
}

export async function POST(request: NextRequest) {
  return handleCron(request);
}
