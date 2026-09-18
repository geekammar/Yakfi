/**
 * AgentRouter normalization POLICY — intentionally EMPTY
 * (PROMPT-OPS-AI-JSON-NORMALIZATION-ENGINE-09).
 *
 * AgentRouter behaviour is deliberately UNCHANGED (see
 * `docs/ai/AGENTROUTER_KNOWN_ISSUE.md` — remediation is out of scope here).
 * This policy declares zero rules, so the core never activates it and
 * AgentRouter content stays held to the strict parser + `aiResponseSchema`
 * alone — byte-for-byte the pre-engine behaviour.
 */
import type { NormalizerPolicy } from "../types";

export const AGENTROUTER_NORMALIZATION_POLICY: NormalizerPolicy = {
  provider: "agentrouter",
  rules: [],
};
