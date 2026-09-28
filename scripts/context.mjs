#!/usr/bin/env node
// FlowPilot — Context Architecture V1 resolver (DECISIONS #75).
//
//   pnpm context <context-name>            print the starting context
//   pnpm context <context-name> --verbose  also list first-hop imports
//   pnpm context <context-name> --stats    also print file count + text size
//
// This utility is READ-ONLY. It never executes application code, never calls
// external services, never reads secrets, never mutates the repo, and never
// dumps the whole source tree. It only prints a task's STARTING context from
// docs/CONTEXT_MAP.md so a fresh session begins in the right place.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  REPO_ROOT,
  allPaths,
  findContext,
  parseContextMap,
} from "./context-map.lib.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const name = positional[0];
const verbose = flags.has("--verbose");
const wantStats = flags.has("--stats");

function fail(msg) {
  process.stderr.write(`\n${msg}\n`);
  process.exitCode = 1;
}

async function listAvailable() {
  const { contexts } = await parseContextMap();
  return contexts.map((c) => c.name);
}

function printList(label, paths) {
  console.log(`\n${label}:`);
  if (paths.length === 0) {
    console.log("  (none)");
    return;
  }
  for (const p of paths) {
    const mark = existsSync(resolve(REPO_ROOT, p)) ? " " : " [MISSING]";
    console.log(`  - ${p}${mark}`);
  }
}

// Best-effort, one-hop import discovery for --verbose. Regex only — no TS
// compilation, no module execution. Resolves "@/x" -> "src/x" and relative
// imports; reports the specifier raw when it cannot be resolved to a file.
const IMPORT_RE =
  /(?:import|export)\b[^"']*?(?:from\s*)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
const EXTENSIONS = ["", ".ts", ".tsx", ".mjs", ".js", ".json"];

function resolveInternal(specifier, fromRelPath) {
  let baseRel;
  if (specifier.startsWith("@/")) {
    baseRel = `src/${specifier.slice(2)}`;
  } else if (specifier.startsWith(".")) {
    const fromDir = fromRelPath.split("/").slice(0, -1).join("/");
    baseRel = resolve("/" + fromDir, specifier).slice(1);
  } else {
    return null; // external package — outside this repo
  }
  for (const ext of EXTENSIONS) {
    if (existsSync(resolve(REPO_ROOT, baseRel + ext))) return baseRel + ext;
  }
  for (const idx of ["/index.ts", "/index.tsx", "/index.mjs", "/index.js"]) {
    if (existsSync(resolve(REPO_ROOT, baseRel + idx))) return baseRel + idx;
  }
  return baseRel; // resolved shape but file not found — still report it
}

async function discoverImports(codePaths) {
  const found = new Map(); // resolvedRel -> Set(importedBy)
  for (const rel of codePaths) {
    const abs = resolve(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    let src;
    try {
      src = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec) continue;
      const resolved = resolveInternal(spec, rel);
      if (!resolved) continue; // skip external packages
      if (codePaths.includes(resolved)) continue; // already a mapped file
      if (!found.has(resolved)) found.set(resolved, new Set());
      found.get(resolved).add(rel);
    }
  }
  return [...found.entries()]
    .map(([path, by]) => ({ path, by: [...by] }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function approxTextSize(paths) {
  let files = 0;
  let bytes = 0;
  for (const rel of paths) {
    const abs = resolve(REPO_ROOT, rel);
    try {
      const s = await stat(abs);
      if (s.isFile()) {
        files += 1;
        bytes += s.size;
      }
    } catch {
      /* missing files are reported elsewhere */
    }
  }
  return { files, bytes };
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function main() {
  if (!name) {
    const available = await listAvailable();
    fail(
      [
        "Usage: pnpm context <context-name> [--verbose] [--stats]",
        "",
        "Available contexts:",
        ...available.map((n) => `  - ${n}`),
      ].join("\n"),
    );
    return;
  }

  const entry = await findContext(name);
  if (!entry) {
    const available = await listAvailable();
    fail(
      [
        `Unknown context: "${name}"`,
        "",
        "Available contexts:",
        ...available.map((n) => `  - ${n}`),
        "",
        "See docs/CONTEXT_MAP.md.",
      ].join("\n"),
    );
    return;
  }

  console.log(`\nContext: ${entry.name}`);
  printList("Docs", entry.docs);
  printList("Code", entry.code);
  printList("Tests", entry.tests);

  if (wantStats) {
    const { files, bytes } = await approxTextSize(allPaths(entry));
    console.log("\nStats (diagnostic only — NOT a token budget):");
    console.log(`  files: ${files}`);
    console.log(`  approx text size: ${humanBytes(bytes)} (${bytes} bytes)`);
  }

  if (verbose) {
    const imports = await discoverImports(entry.code);
    console.log("\nDirect first-hop imports discovered from mapped code:");
    if (imports.length === 0) {
      console.log("  (none resolved to in-repo files)");
    } else {
      for (const { path, by } of imports) {
        const mark = existsSync(resolve(REPO_ROOT, path)) ? "" : " [MISSING]";
        console.log(`  - ${path}${mark}  (from ${by.join(", ")})`);
      }
    }
    console.log(
      "\n  Note: best-effort regex discovery, one hop only. Follow only the",
    );
    console.log("  imports the task actually touches. The code is the truth.");
  }

  console.log(
    "\nNote: this is the STARTING context. Expand outward only when a real",
  );
  console.log(
    "dependency in these files requires it (see docs/CONTEXT_MAP.md).\n",
  );
}

main().catch((err) => {
  fail(String(err?.message ?? err));
});
