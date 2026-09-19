/**
 * FlowPilot — Prompt Registry & Loader (PROMPT-OPS-AI-PROMPT-WORKSPACE-ARCHITECTURE-01).
 *
 * The registry is the ONLY place that maps a stable prompt ID to its source
 * file and variable contract. It holds NO prompt bodies — bodies live in
 * the `prompts/` tree, reach the runtime through the generated artifact,
 * and are read from it here.
 *
 *   prompts/ tree (.prompt)  →  generator  →  src/generated/ai-prompts.generated.ts
 *                                                        ↓
 *   PROMPT_REGISTRY  →  getPromptBody(id)  →  buildPromptMessages / adapter
 *
 * The runtime never touches the filesystem for prompts (Vercel/serverless);
 * a missing or stale generated artifact is a build-time failure, never a
 * silent runtime fallback.
 */
import { AI_PROMPTS_GENERATED } from "@/generated/ai-prompts.generated";

export type PromptRegistryEntry = {
  /** Stable prompt ID. Never rename, never reuse — bump a new id instead. */
  readonly id: string;
  /** Source file, repo-relative, always under `/prompts`. */
  readonly sourcePath: string;
  /**
   * Variable contract: the `{{name}}` placeholders the builder must resolve.
   * Empty when the prompt body is static — the registry asserts this matches
   * the actual body so an undocumented placeholder cannot slip in.
   */
  readonly variables: readonly string[];
  /** Runtime consumer, for the catalog and the drift guard. */
  readonly consumer: string;
};

export const PROMPT_REGISTRY: readonly PromptRegistryEntry[] = [
  {
    id: "system.booking-assistant",
    sourcePath: "prompts/system/booking-assistant.prompt",
    variables: [],
    consumer:
      "buildPromptMessages() in src/server/integrations/ai/prompt.ts (every provider adapter)",
  },
  {
    id: "providers.atria.json-output",
    sourcePath: "prompts/providers/atria-json-output.prompt",
    variables: [],
    consumer:
      "createAtriaAdapter() in src/server/integrations/ai/atria.ts (atria only)",
  },
];

const entriesById = new Map(PROMPT_REGISTRY.map((entry) => [entry.id, entry]));
const generatedById = new Map(
  AI_PROMPTS_GENERATED.map((entry) => [entry.id, entry]),
);

export function getPromptEntry(id: string): PromptRegistryEntry {
  const entry = entriesById.get(id);
  if (!entry) {
    throw new Error(
      `unknown prompt id "${id}" — add it to PROMPT_REGISTRY in prompt-registry.ts`,
    );
  }
  return entry;
}

/**
 * Load one compiled prompt body from the generated artifact.
 *
 * Throws (never returns a fallback string) so a broken build fails loudly
 * instead of silently sending a wrong or empty instruction to the LLM.
 */
export function getPromptBody(id: string): string {
  getPromptEntry(id);
  const generated = generatedById.get(id);
  if (!generated) {
    throw new Error(
      `prompt "${id}" is registered but not generated — run \`pnpm generate:ai-prompts\``,
    );
  }
  return generated.body;
}

/** All registered ids, sorted — used by the drift guard. */
export function listPromptIds(): readonly string[] {
  return [...entriesById.keys()].sort();
}
