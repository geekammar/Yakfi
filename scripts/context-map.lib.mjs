// FlowPilot — Context Architecture V1 shared parser (DECISIONS #75).
//
// Parses docs/CONTEXT_MAP.md into an in-memory list of contexts. This is the
// ONE place that understands the map format so `context.mjs` and
// `context-check.mjs` never drift. It is read-only: it never executes app
// code, never touches the network, never reads secrets.
//
// Map format (see docs/CONTEXT_MAP.md):
//   ## Contexts
//   ### <context-name>
//   <optional description lines>
//   Docs:
//   - <path>
//   Code:
//   - <path>
//   Tests:
//   - <path>
// The "## Contexts" section ends at the next level-2 (`## `) heading.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
export const MAP_PATH = resolve(REPO_ROOT, "docs/CONTEXT_MAP.md");

const SECTION_KEYS = {
  "docs:": "docs",
  "code:": "code",
  "tests:": "tests",
};

/**
 * @typedef {Object} ContextEntry
 * @property {string} name
 * @property {string[]} docs
 * @property {string[]} code
 * @property {string[]} tests
 * @property {number} line  1-based line number of the `### name` heading
 */

/**
 * Parse the context map file into { contexts, duplicates }.
 * @param {string} [mapPath]
 * @returns {Promise<{ contexts: ContextEntry[], duplicates: string[] }>}
 */
export async function parseContextMap(mapPath = MAP_PATH) {
  let raw;
  try {
    raw = await readFile(mapPath, "utf8");
  } catch {
    throw new Error(`Context map not found at ${mapPath}`);
  }

  const lines = raw.split("\n");
  const contexts = [];
  const seen = new Set();
  const duplicates = [];

  let inContextsSection = false;
  let current = null;
  let currentList = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Enter / leave the "## Contexts" section.
    if (trimmed.startsWith("## ")) {
      inContextsSection = trimmed.toLowerCase() === "## contexts";
      current = null;
      currentList = null;
      continue;
    }
    if (!inContextsSection) continue;

    // A new context heading.
    if (trimmed.startsWith("### ")) {
      const name = trimmed.slice(4).trim();
      current = { name, docs: [], code: [], tests: [], line: i + 1 };
      currentList = null;
      contexts.push(current);
      if (seen.has(name)) duplicates.push(name);
      else seen.add(name);
      continue;
    }
    if (!current) continue;

    // A subsection label (Docs:/Code:/Tests:).
    const key = SECTION_KEYS[trimmed.toLowerCase()];
    if (key) {
      currentList = current[key];
      continue;
    }

    // A bullet path within the active subsection.
    if (currentList && trimmed.startsWith("- ")) {
      currentList.push(trimmed.slice(2).trim());
    }
  }

  return { contexts, duplicates };
}

/** @returns {Promise<ContextEntry|null>} */
export async function findContext(name, mapPath = MAP_PATH) {
  const { contexts } = await parseContextMap(mapPath);
  return contexts.find((c) => c.name === name) ?? null;
}

export function allPaths(entry) {
  return [...entry.docs, ...entry.code, ...entry.tests];
}
