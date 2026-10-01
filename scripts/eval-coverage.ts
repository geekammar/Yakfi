/**
 * FlowPilot AI Evaluation — coverage report generator (PROMPT-AI-EVAL-02).
 *
 * Runs `describeCoverage()` over a generated dataset and writes two artifacts
 * per version:
 *
 *   evaluation/reports/<version>/coverage-report.json   ← the machine profile
 *   evaluation/reports/<version>/coverage-report.md    ← the human report
 *
 * The report is required to NAME the gaps rather than silently treating an
 * empty category as success: every unpopulated vocabulary member, every empty
 * curated cell, and every thin member (< 5 cases) is listed explicitly, and
 * `recommendAuthoringTargets()` produces the ordered plan for the next
 * version.
 *
 * Pure and offline: no DB, no network, no LLM call.
 *
 * Run: pnpm eval:coverage [--dataset egyptian-v1]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AVAILABLE_DATASET_VERSIONS,
  resolveDatasetBuilder,
} from "../evaluation/datasets";
import {
  describeCoverage,
  recommendAuthoringTargets,
} from "../evaluation/schema/coverage-matrix";

const version = process.argv[2] ?? AVAILABLE_DATASET_VERSIONS[0]!;
const OUT_DIR = resolve(process.cwd(), "evaluation/reports", version);

const THIN_THRESHOLD = 5;

function main(): void {
  const dataset = resolveDatasetBuilder(version)();
  const profile = describeCoverage(dataset.cases, dataset.meta.version);
  mkdirSync(OUT_DIR, { recursive: true });

  writeFileSync(
    resolve(OUT_DIR, "coverage-report.json"),
    `${JSON.stringify(profile, null, 2)}\n`,
    "utf8",
  );

  const lines: string[] = [];
  lines.push(`# Coverage Report — \`${version}\``);
  lines.push("");
  lines.push(
    `> Generated from \`${dataset.meta.generatedFrom}\` (seed \`${dataset.meta.seed}\`).`,
  );
  lines.push(
    `> **${profile.totalCases} cases** across **${Object.keys(profile.perDimension).length} dimensions**.`,
  );
  lines.push("");
  lines.push(
    "A category with zero cases is a GAP, not a silent success. Thin members " +
      `(< ${THIN_THRESHOLD} cases) are listed because they cannot yet support a reliable measurement.`,
  );
  lines.push("");

  // ── Headline: are all dimensions fully populated? ────────────────────────
  const incomplete = Object.values(profile.perDimension).filter(
    (d) => d.populatedMembers < d.totalMembers,
  );
  lines.push("## Headline");
  lines.push("");
  if (incomplete.length === 0 && profile.emptyCuratedCells.length === 0) {
    lines.push(
      "**Every dimension member and every curated joint cell is populated.** " +
        "The dataset has no structural coverage holes; the remaining work is depth, not breadth.",
    );
  } else {
    lines.push(
      `**${incomplete.length} dimension(s) have unpopulated members and ` +
        `${profile.emptyCuratedCells.length} curated cell(s) are empty.** See the gap list below.`,
    );
  }
  lines.push("");

  // ── Per-dimension tables ──────────────────────────────────────────────────
  for (const dim of Object.values(profile.perDimension)) {
    lines.push(
      `### ${dim.dimension} — ${dim.populatedMembers}/${dim.totalMembers}`,
    );
    lines.push("");
    lines.push(`> ${dim.purpose}`);
    lines.push("");
    lines.push("| member | cases |");
    lines.push("| --- | ---: |");
    for (const m of dim.members) {
      const flag = m.populated
        ? m.count < THIN_THRESHOLD
          ? " _(thin)_"
          : ""
        : " **(GAP)**";
      lines.push(`| \`${m.member}\` | ${m.count}${flag} |`);
    }
    lines.push("");
  }

  // ── Curated joint cells ───────────────────────────────────────────────────
  lines.push("## Curated joint cells");
  lines.push("");
  lines.push("| cell | cases | requirements |");
  lines.push("| --- | ---: | --- |");
  for (const r of profile.curatedCells) {
    const req = Object.entries(r.cell.requires)
      .map(([d, m]) => `${d}=\`${m}\``)
      .join(", ");
    lines.push(
      `| ${r.populated ? r.cell.id : `**${r.cell.id} (EMPTY)**`} | ${r.count} | ${req} |`,
    );
  }
  lines.push("");
  if (profile.emptyCuratedCells.length === 0) {
    lines.push(
      "All curated cells are populated — no highest-value authoring target is missing.",
    );
  } else {
    lines.push(
      "**Empty curated cells are the highest-value authoring targets for the next version:**",
    );
    for (const cell of profile.emptyCuratedCells)
      lines.push(`- \`${cell.id}\` — ${cell.rationale}`);
  }
  lines.push("");

  // ── Gaps + targets ────────────────────────────────────────────────────────
  lines.push("## Gaps and authoring targets");
  lines.push("");
  if (profile.gaps.length === 0) {
    lines.push("**No unpopulated vocabulary members remain.**");
  } else {
    lines.push("Unpopulated vocabulary members:");
    for (const g of profile.gaps)
      lines.push(`- \`${g.dimension}:${g.member}\``);
  }
  lines.push("");
  const targets = recommendAuthoringTargets(profile, 25);
  lines.push(
    "`recommendAuthoringTargets()` (ordered plan for the next version):",
  );
  if (targets.length === 0) {
    lines.push(
      "- _(none — every member and curated cell is populated; add cells or deepen instead)_",
    );
  } else {
    for (const t of targets) lines.push(`- \`${t}\``);
  }
  lines.push("");

  writeFileSync(
    resolve(OUT_DIR, "coverage-report.md"),
    `${lines.join("\n")}\n`,
    "utf8",
  );

  // ── Console summary (the operator reads this) ────────────────────────────
  console.log(`eval:coverage → ${OUT_DIR}`);
  console.log(`  dataset      : ${version} (${profile.totalCases} cases)`);
  for (const [name, dim] of Object.entries(profile.perDimension)) {
    console.log(
      `  ${name.padEnd(20)}: ${String(dim.populatedMembers).padStart(2)}/${dim.totalMembers}` +
        (dim.populatedMembers < dim.totalMembers ? "  ← HAS GAPS" : ""),
    );
  }
  console.log(
    `  curated cells: ${profile.curatedCells.filter((c) => c.populated).length}/${profile.curatedCells.length} populated`,
  );
  console.log(`  gaps         : ${profile.gaps.length}`);
  console.log(`  targets      : ${targets.length}`);
  if (profile.gaps.length > 0) {
    console.log(
      `  missing      : ${profile.gaps.map((g) => `${g.dimension}:${g.member}`).join(", ")}`,
    );
  }
}

main();
