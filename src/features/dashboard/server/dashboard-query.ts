import type { AiReadinessInput } from "@/lib/ai-readiness";
import {
  appointmentRepository,
  conversationRepository,
  serviceRepository,
} from "@/server/repositories";
import type { Business } from "@/types/domain";

function dateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function timezoneOffset(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, Number(part.value)]),
  );
  const asUtc = Date.UTC(
    values.year ?? 0,
    (values.month ?? 1) - 1,
    values.day ?? 1,
    values.hour ?? 0,
    values.minute ?? 0,
    values.second ?? 0,
  );
  return asUtc - date.getTime();
}

function zonedMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
) {
  const utcGuess = Date.UTC(year, month - 1, day);
  const firstPass = new Date(
    utcGuess - timezoneOffset(new Date(utcGuess), timeZone),
  );
  return new Date(utcGuess - timezoneOffset(firstPass, timeZone));
}

function todayInTimezone(timeZone: string) {
  const now = new Date();
  const parts = dateParts(now, timeZone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const dayStartUtc = zonedMidnightUtc(year, month, day, timeZone);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const dayEndUtc = zonedMidnightUtc(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    timeZone,
  );

  return { date, dayStartUtc, dayEndUtc };
}

export async function getDashboardData(businessId: string, timeZone: string) {
  const today = todayInTimezone(timeZone);
  const [appointments, conversations] = await Promise.all([
    appointmentRepository.getDashboardSummary(businessId, today.date),
    conversationRepository.getDashboardSummary(
      businessId,
      today.dayStartUtc,
      today.dayEndUtc,
    ),
  ]);

  return { appointments, conversations };
}

/**
 * Assemble the AI-readiness input (PROMPT-AI-OPS-21) from the already-loaded
 * Business record + the active service catalog. One extra repository read;
 * the readiness computation itself is a separate pure module. Only the
 * fields the readiness aid tracks are projected out — nothing else is
 * carried to the UI.
 */
export async function getAiReadinessInput(
  business: Business,
): Promise<AiReadinessInput> {
  const services = await serviceRepository.listByBusiness(business.id, {
    includeInactive: false,
  });
  return {
    about: business.about,
    address: business.address,
    workingHours: business.workingHours,
    faqs: business.faqs,
    services: services.map((service) => ({
      isActive: service.isActive,
      description: service.description,
      priceType: service.priceType,
    })),
  };
}
