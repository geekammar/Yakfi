/**
 * FlowPilot — ONE-TIME Production TEST BUSINESS bootstrap (PROMPT-AI-JEV-03F-I).
 *
 * Ensures the explicitly isolated operator test business exists in the database
 * (`TEST_BUSINESS_ID` = `f47ac10b-58cc-4372-a567-0e02b2c3d479`, phone `+201005551234`).
 * Reuses the existing demo-data definitions so no new schema or migration is needed.
 *
 * Run:
 *   pnpm bootstrap:test-business
 */

import { ensureTestBusiness } from "../src/features/conversations/server/test-business";
import { db } from "../src/server/db";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("❌ DATABASE_URL غير معرّف.");
    process.exit(1);
  }

  console.log("🔍 Checking isolated test business...");
  try {
    const business = await ensureTestBusiness(db);
    console.log("✔ Isolated test business ready:");
    console.log(`   ID:             ${business.id}`);
    console.log(`   Name:           ${business.name}`);
    console.log(`   WhatsApp phone: ${business.whatsappNumber}`);
    console.log(`   Branch pointer: ${business.defaultBranchId}`);
    console.log(`   Is active:      ${business.isActive}`);
  } catch (err) {
    console.error("❌ Failed to initialize test business:", err);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main();
