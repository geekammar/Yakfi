"use server";

import {
  createService,
  defaultServiceServiceDeps,
  removeService,
  setServiceActive,
  updateService,
  type ServiceActor,
} from "@/features/services/server/service-service";
import type { ServiceActionResult } from "@/features/services/types";
import { requireUser } from "@/server/auth/guards";
import { userRepository } from "@/server/repositories";

import { revalidatePath } from "next/cache";

/**
 * Builds the authorization context from the authenticated session +
 * the database-backed user record. The Business is ALWAYS derived
 * server-side — a client-provided businessId can never override it.
 */
async function currentActor(): Promise<ServiceActor> {
  const session = await requireUser();
  const user = await userRepository.findById(session.user.id);
  return {
    userId: session.user.id,
    // No user record (deleted mid-session) → least privilege: STAFF
    // with no Business can never manage services.
    role: user?.role ?? "STAFF",
    businessId: user?.businessId ?? null,
  };
}

function revalidateServices() {
  revalidatePath("/services");
  // The create-appointment service options read active services.
  revalidatePath("/appointments/new");
}

export async function createServiceAction(
  input: unknown,
): Promise<ServiceActionResult> {
  const result = await createService(
    defaultServiceServiceDeps,
    await currentActor(),
    input,
  );
  if (result.success) revalidateServices();
  return result;
}

export async function updateServiceAction(
  input: unknown,
): Promise<ServiceActionResult> {
  const result = await updateService(
    defaultServiceServiceDeps,
    await currentActor(),
    input,
  );
  if (result.success) revalidateServices();
  return result;
}

export async function setServiceActiveAction(
  input: unknown,
): Promise<ServiceActionResult> {
  const result = await setServiceActive(
    defaultServiceServiceDeps,
    await currentActor(),
    input,
  );
  if (result.success) revalidateServices();
  return result;
}

export async function removeServiceAction(
  input: unknown,
): Promise<ServiceActionResult> {
  const result = await removeService(
    defaultServiceServiceDeps,
    await currentActor(),
    input,
  );
  if (result.success) revalidateServices();
  return result;
}
