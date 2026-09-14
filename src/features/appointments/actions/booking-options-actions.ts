"use server";

import {
  defaultBookingOptionsServiceDeps,
  resolveBookingOptions,
  type BookingOptionsActor,
} from "@/features/appointments/server/booking-options-service";
import type { BookingOptionsResult } from "@/features/appointments/types";
import { requireUser } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

/**
 * Booking Options read action (PROMPT-CORE-02) — the integration hook
 * for the future Conversation/WhatsApp layer. Thin wrapper only: the
 * actor's Business is ALWAYS derived server-side from the persisted
 * user (a client-provided businessId can never override it), and all
 * rules live in the booking options resolver (read-only; the booking
 * write stays a separate, later command).
 */
export async function resolveBookingOptionsAction(
  input: unknown,
): Promise<BookingOptionsResult> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  // No user record (deleted mid-session) → least privilege: no
  // Business can never read options.
  const actor: BookingOptionsActor = {
    userId: session.user.id,
    businessId: user?.businessId ?? null,
  };
  return resolveBookingOptions(defaultBookingOptionsServiceDeps, actor, input);
}
