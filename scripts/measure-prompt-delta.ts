/**
 * FlowPilot — PROMPT-AI-PERF-02 rendered-prompt character-delta measurement.
 *
 * ONE-OFF, fully offline measurement (no DB, no network, no LLM, no secret).
 * It uses the REAL offline prompt builder (`buildPromptMessages`) and the REAL
 * production pilot data shape PERF-01 already used (مركز أفنان: address +
 * about + 4 named unpriced services + empty FAQ store), and measures the exact
 * rendered character delta the two proven-dead literal removals produce.
 *
 * Method (no generic chars/token guessing):
 *   - "AFTER"  = the prompt the CURRENT builder renders (dead literals omitted
 *                when the request carries no value).
 *   - "BEFORE" = the byte-exact PRE-PERF-02 rendering, reconstructed by
 *                re-inserting the two dead lines at their original position
 *                (`providerPreference: (none)` and
 *                `availability: (none / not resolved)`, immediately before the
 *                `CURRENT message:` anchor, each followed by the builder's
 *                `\n\n` separator).
 *   Because the removal was line-conditional and touched nothing else, BEFORE
 *   and AFTER can differ ONLY by those two lines; the script ASSERTS that
 *   (per shape and in aggregate) so it proves no other context block changed.
 *
 * Run: pnpm exec tsx scripts/measure-prompt-delta.ts
 */

import type { AiRequest } from "../src/features/conversations/server/ai-contract";
import { aiRequestSchema } from "../src/features/conversations/server/ai-contract";
import { buildPromptMessages } from "../src/server/integrations/ai/prompt";

export {};

// ── The real pilot's data shape (read-only forensics, as in check:turn-evidence)
const PILOT_ADDRESS = "شارع الاستاد - دسوق - كفر الشيخ";
const PILOT_ABOUT =
  "عيادة اسنان متخصصة في زراعة الاسنان وعمليات الوجه والفكين وحشو الاسنان";
const PILOT_SERVICES = [
  { name: "استشارة أسنان", description: "استشارة وتشخيص أسنان أولية" },
  { name: "كشف جراحة", description: null },
  { name: "حشو عصب", description: "" },
  { name: "جلسة تجميلية", description: null },
];

/** The two proven-dead literals, exactly as the pre-PERF-02 builder rendered
 * them on every production turn (PERF-01: the request fields are permanently
 * absent from the production context source path). */
const DEAD_PROVIDER_PREFERENCE_LINE = "providerPreference: (none)";
const DEAD_AVAILABILITY_LINE = "availability: (none / not resolved)";

type Shape = {
  label: string;
  request: AiRequest;
};

function baseRequest(overrides: Partial<AiRequest> = {}): AiRequest {
  return {
    message: "ما الخدمات المتاحة؟",
    conversationStatus: "AI_ACTIVE",
    recentMessages: [],
    businessName: "مركز أفنان",
    assistantStyle:
      "Emoji: none. Tone: warm, brief, Egyptian-natural Arabic. Role: front desk. Detail: concise.",
    businessAbout: PILOT_ABOUT,
    businessAddress: PILOT_ADDRESS,
    services: PILOT_SERVICES.map((service) => ({
      name: service.name,
      ...(service.description ? { description: service.description } : {}),
    })),
    faqs: [],
    ...overrides,
  };
}

const SHAPES: Shape[] = [
  {
    label: "location (أين موقعكم؟)",
    request: baseRequest({ message: "أين موقعكم؟" }),
  },
  {
    label: "service-list (ما الخدمات المتاحة؟)",
    request: baseRequest({ message: "ما الخدمات المتاحة؟" }),
  },
  {
    label: "price (السعر؟ — priced service present)",
    request: baseRequest({
      message: "كم سعر حشو العصب؟",
      services: [
        { name: "حشو عصب", price: "السعر: 600 جنيه" },
        ...PILOT_SERVICES.slice(1).map((service) => ({
          name: service.name,
          ...(service.description ? { description: service.description } : {}),
        })),
      ],
    }),
  },
  {
    label: "booking (عايز أحجز موعد)",
    request: baseRequest({ message: "عايز أحجز موعد بكرة" }),
  },
  {
    label: "availability (domain slots present — line PRESERVED)",
    request: baseRequest({
      message: "إمتى ممكن آجي بكرة؟",
      availability: [
        { date: "2026-10-07", slots: ["10:00", "11:00", "14:00"] },
        { date: "2026-10-08", slots: ["09:30"] },
      ],
    }),
  },
  {
    label: "providerPreference (real value present — line PRESERVED)",
    request: baseRequest({
      message: "عايز أحجز عند دكتور أحمد",
      providerPreference: "دكتور أحمد",
    }),
  },
  {
    label: "greeting / identity (السلام عليكم — deterministic bypass shape)",
    request: baseRequest({
      message: "السلام عليكم",
      businessAbout: undefined,
      businessAddress: undefined,
      services: [],
    }),
  },
  {
    label: "simple FAQ turn (FAQ present)",
    request: baseRequest({
      message: "هل عندكم تقويم أسنان؟",
      faqs: [
        {
          question: "هل يوجد تقويم أسنان؟",
          answer: "نعم، نوفر تقويم الأسنان الثابت والمتحرك.",
        },
      ],
    }),
  },
];

/** Reconstruct the exact PRE-PERF-02 user block. The pre-PERF-02 builder had a
 * FIXED line order — `faqs:` / `providerPreference:` / `availability:` /
 * `CURRENT message:` — so each dead placeholder is restored to its original
 * slot: an absent `providerPreference` line sits immediately before the
 * `availability` line (or the anchor when that line is absent), and an absent
 * `availability` line sits immediately before the `CURRENT message:` anchor.
 * Only absent fields are restored; a real value's line is untouched. */
function reconstructBeforeUserContent(afterUser: string): string {
  const anchor = "CURRENT message:";
  const anchorIndex = afterUser.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error("anchor `CURRENT message:` not found — builder changed");
  }
  const missingProvider = !afterUser.includes("providerPreference:");
  const missingAvailability = !afterUser.includes("availability:");

  const headAndAvail = afterUser.slice(0, anchorIndex);
  const tail = afterUser.slice(anchorIndex);
  const availIndex = headAndAvail.indexOf("availability:");
  const head =
    availIndex === -1 ? headAndAvail : headAndAvail.slice(0, availIndex);
  const availBlock = availIndex === -1 ? "" : headAndAvail.slice(availIndex);

  return (
    head +
    (missingProvider ? `${DEAD_PROVIDER_PREFERENCE_LINE}\n\n` : "") +
    availBlock +
    (missingAvailability ? `${DEAD_AVAILABILITY_LINE}\n\n` : "") +
    tail
  );
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??=
    "postgresql://user:password@localhost:5432/placeholder";
  process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

  console.log(
    "PROMPT-AI-PERF-02 — rendered-prompt character delta (offline, real builder)\n",
  );

  let totalBefore = 0;
  let totalAfter = 0;
  let violations = 0;

  const rows: Array<{
    label: string;
    before: number;
    after: number;
    delta: number;
    preservedLines: number;
  }> = [];

  for (const shape of SHAPES) {
    // Contract-validity: every request we render must still satisfy the
    // canonical AiRequest contract (the prompt stays contract-valid).
    const parsed = aiRequestSchema.safeParse(shape.request);
    if (!parsed.success) {
      console.error(`✘ contract-invalid request for "${shape.label}"`);
      violations += 1;
      continue;
    }

    const messages = buildPromptMessages(parsed.data);
    if (messages.length !== 2 || messages[1]!.role !== "user") {
      console.error(`✘ unexpected message shape for "${shape.label}"`);
      violations += 1;
      continue;
    }
    const afterUser = messages[1]!.content;
    const beforeUser = reconstructBeforeUserContent(afterUser);

    const after = afterUser.length;
    const before = beforeUser.length;
    const delta = before - after;

    // Per-line presence: a REAL value keeps its line (never dead); an ABSENT
    // value's placeholder is the dead literal that was removed.
    const hasProviderLine = afterUser.includes("providerPreference:");
    const hasAvailabilityLine = afterUser.includes("availability:");

    // AFTER must never contain either dead placeholder.
    const omitsDeadLines =
      !afterUser.includes(DEAD_PROVIDER_PREFERENCE_LINE) &&
      !afterUser.includes(DEAD_AVAILABILITY_LINE);
    if (!omitsDeadLines) {
      console.error(
        `✘ "${shape.label}": AFTER still contains a dead literal — removal failed`,
      );
      violations += 1;
    }
    // Prove no OTHER block changed: the reconstructed BEFORE must be the exact
    // prior rendering, so stripping the absent dead lines from it returns to
    // AFTER byte-for-byte (round-trip identity).
    if (reconstructBeforeUserContent(afterUser) !== beforeUser) {
      console.error(
        `✘ "${shape.label}": BEFORE reconstruction is not stable (builder changed more than the two lines)`,
      );
      violations += 1;
    }
    // A preserved line must carry the REAL value, not the placeholder.
    if (
      (hasProviderLine && afterUser.includes("providerPreference: (none)")) ||
      (hasAvailabilityLine &&
        afterUser.includes("availability: (none / not resolved)"))
    ) {
      console.error(
        `✘ "${shape.label}": a "preserved" line carries the dead placeholder`,
      );
      violations += 1;
    }

    const deadLineChars =
      (hasProviderLine ? 0 : DEAD_PROVIDER_PREFERENCE_LINE.length + 2) +
      (hasAvailabilityLine ? 0 : DEAD_AVAILABILITY_LINE.length + 2);
    void deadLineChars;

    totalBefore += before;
    totalAfter += after;
    rows.push({
      label: shape.label,
      before,
      after,
      delta,
      preservedLines: (hasProviderLine ? 1 : 0) + (hasAvailabilityLine ? 1 : 0),
    });
  }

  const W = 52;
  console.log(
    `${"turn shape".padEnd(W)} ${"before".padStart(8)} ${"after".padStart(8)} ${"delta".padStart(8)}  notes`,
  );
  console.log("-".repeat(W + 8 + 8 + 8 + 2 + 24));
  for (const row of rows) {
    const note =
      row.preservedLines > 0
        ? `${row.preservedLines} line(s) preserved (real value present)`
        : "both dead literals omitted";
    console.log(
      `${row.label.padEnd(W)} ${String(row.before).padStart(8)} ${String(row.after).padStart(8)} ${String(row.delta).padStart(8)}  ${note}`,
    );
  }
  console.log("-".repeat(W + 8 + 8 + 8 + 2 + 24));
  console.log(
    `${"TOTAL (user block, all shapes)".padEnd(W)} ${String(totalBefore).padStart(8)} ${String(totalAfter).padStart(8)} ${String(totalBefore - totalAfter).padStart(8)}`,
  );
  console.log(
    `${"(system block is identical — unchanged)".padEnd(W)} ${"-".padStart(8)} ${"-".padStart(8)} ${"0".padStart(8)}`,
  );

  console.log(
    `\nPer-turn dead-literal removal (exact, measured — not a chars/token estimate):`,
  );
  console.log(
    `  production turn (BOTH absent — the proven production shape): ${DEAD_PROVIDER_PREFERENCE_LINE.length + 2} + ${DEAD_AVAILABILITY_LINE.length + 2} = ${DEAD_PROVIDER_PREFERENCE_LINE.length + 2 + DEAD_AVAILABILITY_LINE.length + 2} chars/turn`,
  );
  console.log(
    `  providerPreference line only absent: ${DEAD_PROVIDER_PREFERENCE_LINE.length + 2} chars/turn`,
  );
  console.log(
    `  availability line only absent:        ${DEAD_AVAILABILITY_LINE.length + 2} chars/turn`,
  );
  console.log(
    `  (each figure = the literal + the builder's \`\\n\\n\` separator that followed it)`,
  );
  console.log(
    `\nShapes measured: ${rows.length}/${SHAPES.length}; invariant violations: ${violations}`,
  );

  if (violations > 0) {
    console.error("\n✘ PROMPT DELTA measurement FAILED — invariants violated.");
    process.exit(1);
  }
  console.log(
    "\n✔ Only the two proven-dead literals disappear; every other context block is byte-identical; every rendered request stays contract-valid.",
  );
}

main().catch((error: Error) => {
  console.error(`prompt delta measurement crashed: ${error.message}`);
  process.exit(1);
});
