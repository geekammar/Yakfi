/**
 * FlowPilot — AI prompt generator (PROMPT-OPS-AI-PROMPT-WORKSPACE-ARCHITECTURE-01).
 *
 * Deterministic build-time generator:
 *
 *   the prompts/ tree (.prompt files)  →  src/generated/ai-prompts.generated.ts
 *
 * The generated artifact is the ONLY prompt body the runtime reads. The
 * application NEVER touches the filesystem at runtime (Vercel/serverless),
 * and Git stays the version history for prompt content.
 *
 * Modes:
 *   pnpm generate:ai-prompts          write the artifact
 *   pnpm generate:ai-prompts --check  fail when the committed artifact is stale
 *
 * Determinism contract: output is a pure function of the .prompt files.
 * Entries are sorted by prompt id; bodies are compiled by
 * {@link compilePromptBody} and serialized with JSON.stringify.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const PROMPTS_DIR = join(ROOT, "prompts");
const OUT_PATH = join(ROOT, "src/generated/ai-prompts.generated.ts");

/**
 * Compile a `.prompt` file into the exact string sent to the LLM.
 *
 * Rule (intentionally minimal): drop blank lines and `#`-prefixed comment
 * lines, trim each surviving line, join with a single space. This makes a
 * human-readable multi-line file byte-identical to the legacy
 * `[...lines].join(" ")` constants it replaces.
 *
 * One comment line is meaningful: `# prompt id: <id>` declares the stable
 * prompt id (see {@link parsePromptId}); every other comment is human note.
 */
export function compilePromptBody(raw: string): string {
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join(" ");
}

/** Extract the `# prompt id:` declaration from a `.prompt` file header. */
export function parsePromptId(raw: string): string | null {
  for (const line of raw.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) continue;
    const match = /^#\s*prompt\s+id\s*:\s*(\S+)\s*$/i.exec(trimmed);
    if (match) return match[1]!;
  }
  return null;
}

export type CompiledPrompt = {
  readonly id: string;
  readonly sourcePath: string;
  readonly body: string;
  readonly sha256: string;
};

function listPromptFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (name.endsWith(".prompt")) out.push(abs);
    }
  };
  walk(PROMPTS_DIR);
  return out.sort();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function compileAll(): CompiledPrompt[] {
  const files = listPromptFiles();
  if (files.length === 0) {
    throw new Error("no .prompt files found under prompts/");
  }
  const compiled = files.map((abs) => {
    const raw = readFileSync(abs, "utf8");
    const id = parsePromptId(raw);
    if (!id) {
      throw new Error(
        `missing "# prompt id:" declaration in ${relative(ROOT, abs)}`,
      );
    }
    const body = compilePromptBody(raw);
    return {
      id,
      sourcePath: relative(ROOT, abs).split(sep).join("/"),
      body,
      sha256: sha256(body),
    };
  });
  // Deterministic output: sort by id.
  return compiled.sort((a, b) => a.id.localeCompare(b.id));
}

const HEADER = `/**
 * GENERATED ARTIFACT — DO NOT EDIT BY HAND.
 *
 * Source of truth: the prompts/ tree (.prompt files)
 * Generator:       scripts/generate-ai-prompts.ts  (pnpm generate:ai-prompts)
 * Runtime loader:  src/server/integrations/ai/prompt-registry.ts
 *
 * This file is committed so that Git is the version history for prompt
 * content and so the prompt drift guard can prove the runtime artifact
 * matches the source prompt files. It is regenerated on every build.
 */

export type GeneratedPrompt = {
  readonly id: string;
  readonly sourcePath: string;
  readonly body: string;
  readonly sha256: string;
};

export const AI_PROMPTS_GENERATED: readonly GeneratedPrompt[] = `;

function render(compiled: CompiledPrompt[]): string {
  const body = JSON.stringify(compiled, null, 2);
  return `${HEADER}${body} as const;
`;
}

function readArtifactBody(): string | null {
  try {
    const raw = readFileSync(OUT_PATH, "utf8");
    // Anchor past the type annotation (its `[]` would false-match),
    // then take the array literal that ends the file.
    const marker = "AI_PROMPTS_GENERATED: readonly GeneratedPrompt[] = ";
    const start = raw.indexOf(marker);
    if (start === -1) return null;
    const jsonStart = raw.indexOf("[", start + marker.length);
    const jsonEnd = raw.lastIndexOf("]") + 1;
    if (jsonStart === -1 || jsonEnd === 0) return null;
    return raw.slice(jsonStart, jsonEnd);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const checkOnly = process.argv.slice(2).includes("--check");
  const compiled = compileAll();

  const ids = compiled.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    console.error(`✘ duplicate prompt ids: ${[...new Set(dupes)].join(", ")}`);
    process.exit(1);
  }

  if (checkOnly) {
    const onDisk = readArtifactBody();
    const expected = JSON.stringify(compiled, null, 2);
    if (onDisk !== expected) {
      console.error(
        "✘ generated prompt artifact is stale — run `pnpm generate:ai-prompts` and commit it.",
      );
      console.error(
        "  (source prompt files changed without regenerating the runtime artifact)",
      );
      process.exit(1);
    }
    console.log(
      `✔ prompt artifact fresh — ${compiled.length} prompt(s), byte-identical to source.`,
    );
    return;
  }

  writeFileSync(OUT_PATH, render(compiled));
  console.log(
    `✔ generated ${compiled.length} prompt(s) → ${relative(ROOT, OUT_PATH)}`,
  );
  for (const c of compiled) {
    console.log(
      `  ${c.id}  (${c.body.length} chars, sha256 ${c.sha256.slice(0, 12)})`,
    );
  }
}

main().catch((error: Error) => {
  console.error(`✘ generate:ai-prompts failed: ${error.message}`);
  process.exit(1);
});
