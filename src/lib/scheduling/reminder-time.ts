/**
 * Appointment Reminders pure time and template formatting utilities (BOOK-REM-01).
 *
 * Implements deterministic calculation of reminder due timestamps against the
 * business's authoritative timezone, late booking detection, and bounded
 * template content rendering using approved variables.
 */

export const WHATSAPP_REMINDER_TEMPLATE_NAME = "appointment_reminder";
export const WHATSAPP_REMINDER_TEMPLATE_LANG = "ar";

/**
 * Calculates timezone offset in milliseconds for a specific UTC timestamp
 * in the given IANA timezone.
 */
export function timezoneOffsetMs(date: Date, timeZone: string): number {
  try {
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
  } catch {
    return 0;
  }
}

/**
 * Converts wall-clock date and time in a business timezone to UTC Date.
 */
export function zonedTimestampUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = new Date(
    utcGuess - timezoneOffsetMs(new Date(utcGuess), timeZone),
  );
  return new Date(utcGuess - timezoneOffsetMs(firstPass, timeZone));
}

/**
 * Parse appointment start wall-clock datetime in the business timezone.
 */
export function parseAppointmentStartUtc(params: {
  date: string;
  startTime: string;
  timezone: string;
}): Date {
  const [year, month, day] = params.date.split("-").map(Number);
  const [hour, minute] = params.startTime.split(":").map(Number);
  return zonedTimestampUtc(
    year ?? 2026,
    month ?? 1,
    day ?? 1,
    hour ?? 0,
    minute ?? 0,
    params.timezone || "Asia/Riyadh",
  );
}

/**
 * Calculates the exact UTC timestamp when a reminder should be dispatched.
 *
 * reminderDueTime = appointmentStartTime (in timezone) - (leadHours * 3600s)
 */
export function calculateReminderDueTime(params: {
  date: string;
  startTime: string;
  leadHours: number;
  timezone: string;
}): Date {
  const appointmentStart = parseAppointmentStartUtc(params);
  const leadMs = Math.max(1, params.leadHours) * 60 * 60 * 1000;
  return new Date(appointmentStart.getTime() - leadMs);
}

/**
 * Determines whether an appointment was created too late for the configured lead time.
 * (e.g. Appointment starts in 2 hours, but business reminder lead time is 24 hours).
 */
export function isLateBooking(params: {
  date: string;
  startTime: string;
  leadHours: number;
  timezone: string;
  now?: Date;
}): boolean {
  const dueTime = calculateReminderDueTime(params);
  const current = params.now ?? new Date();
  return current.getTime() >= dueTime.getTime();
}

/**
 * Formats appointment date in Arabic using the business timezone or UTC date parts.
 * e.g. "الأحد، 25 أكتوبر 2026"
 */
export function formatReminderDate(date: string): string {
  try {
    return new Intl.DateTimeFormat("ar-EG", {
      timeZone: "UTC",
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(`${date}T00:00:00.000Z`));
  } catch {
    return date;
  }
}

/**
 * Formats appointment time in Arabic.
 * e.g. "2:30 م" or "10:00 ص"
 */
export function formatReminderTime(time: string): string {
  try {
    const [h, m] = time.split(":").map(Number);
    const d = new Date(Date.UTC(1970, 0, 1, h ?? 0, m ?? 0));
    return new Intl.DateTimeFormat("ar-EG", {
      timeZone: "UTC",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);
  } catch {
    return time;
  }
}

/**
 * Extracts the 4 approved parameters for the WhatsApp/Telegram reminder templates.
 */
export function getReminderTemplateParams(params: {
  businessName: string;
  date: string;
  startTime: string;
  serviceName: string;
}): string[] {
  return [
    params.businessName.trim(),
    formatReminderDate(params.date),
    formatReminderTime(params.startTime),
    params.serviceName.trim(),
  ];
}

/**
 * Renders the customer-facing reminder message text.
 */
export function renderReminderContent(params: {
  templateId?: string;
  businessName: string;
  date: string;
  startTime: string;
  serviceName: string;
}): string {
  const [bName, dateStr, timeStr, sName] = getReminderTemplateParams(params);

  if (params.templateId === "compact") {
    return `تذكير بموعدك: لدى ${bName} يوم ${dateStr} الساعة ${timeStr} لخدمة ${sName}. نرجو الحضور قبل الموعد بـ 10 دقائق.`;
  }

  // Default: "standard"
  return `مرحباً بك! نود تذكيرك بموعدك لدى ${bName} يوم ${dateStr} الساعة ${timeStr} (خدمة: ${sName}). يسعدنا حضورك في الموعد المحدد.`;
}
