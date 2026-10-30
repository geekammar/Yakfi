import type { Business } from "@/generated/prisma/client";

import { db } from "@/server/db";
import { DEFAULT_BRANCH_NAME } from "@/server/repositories/branch.repository";

/**
 * Isolated operator-controlled test business context (PROMPT-AI-JEV-03F-I).
 *
 * Deterministic identifiers reusing the established demo-dataset definitions
 * (`DEMO_IDS.business` / `demoBusiness.whatsappNumber` in `prisma/demo-data.ts`).
 * Completely isolated from real customer clinics — real customers never message
 * this number and no real outbound messages are sent.
 */
export const TEST_BUSINESS_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
export const TEST_BRANCH_ID = "33333333-3333-4333-8333-333333333333";
export const TEST_BUSINESS_PHONE = "+201005551234";

export async function ensureTestBusiness(
  prismaClient: typeof db = db,
): Promise<Business> {
  const existing = await prismaClient.business.findFirst({
    where: {
      OR: [{ id: TEST_BUSINESS_ID }, { whatsappNumber: TEST_BUSINESS_PHONE }],
      deletedAt: null,
    },
  });

  if (existing) {
    const defaultBranch = await prismaClient.branch.findFirst({
      where: { defaultForBusiness: { id: existing.id }, deletedAt: null },
    });
    if (!defaultBranch) {
      await prismaClient.$transaction(async (tx) => {
        const branch = await tx.branch.create({
          data: {
            id: TEST_BRANCH_ID,
            businessId: existing.id,
            name: DEFAULT_BRANCH_NAME,
          },
        });
        await tx.business.update({
          where: { id: existing.id },
          data: { defaultBranchId: branch.id },
        });
      });
    }
    return existing;
  }

  return prismaClient.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: {
        id: TEST_BUSINESS_ID,
        name: "عيادة الاختبار (Isolated Test Target)",
        vertical: "dental",
        city: "كفر الشيخ",
        whatsappNumber: TEST_BUSINESS_PHONE,
        timezone: "Africa/Cairo",
        slotDurationMinutes: 30,
        confirmationMode: "automatic",
        appointmentTimeDisplay: "START_ONLY",
        workingHours: {
          sun: { open: "10:00", close: "21:00", closed: false },
          mon: { open: "10:00", close: "21:00", closed: false },
          tue: { open: "10:00", close: "21:00", closed: false },
          wed: { open: "10:00", close: "21:00", closed: false },
          thu: { open: "10:00", close: "21:00", closed: false },
          fri: { open: "14:00", close: "21:00", closed: false },
          sat: { open: "10:00", close: "18:00", closed: false },
        },
        faqs: [
          {
            question: "كم سعر الكشف؟",
            answer: "الكشف والتشخيص ٣٠٠ جنيه.",
          },
          {
            question: "مواعيد العمل؟",
            answer: "نعمل يومياً من السبت إلى الخميس من ١٠ صباحاً إلى ٩ مساءً.",
          },
          {
            question: "فين العيادة بالظبط؟",
            answer: "كفر الشيخ — شارع البحر، عمارات المستشفى العام.",
          },
        ],
        onboardingCompletedAt: new Date(),
        isActive: true,
      },
    });

    const branch = await tx.branch.create({
      data: {
        id: TEST_BRANCH_ID,
        businessId: business.id,
        name: DEFAULT_BRANCH_NAME,
      },
    });

    await tx.business.update({
      where: { id: business.id },
      data: { defaultBranchId: branch.id },
    });

    return business;
  });
}
