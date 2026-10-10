/**
 * Conversation Copy Registry — public surface (UX-LAB-01A, Slice 1;
 * UX-LAB-01A2 global coverage; UX-LAB-01B validation + render contracts).
 *
 * PASSIVE infrastructure: the canonical metadata + default copy for the
 * deterministic customer-facing conversation copy, plus the pure validation
 * and render contracts a future Founder Conversation Lab will build on.
 * Production runtime does NOT import this yet (the offline check guards that
 * in section I); the Lab becomes its consumer in a later slice.
 */
export {
  COPY_REGISTRY,
  COPY_REGISTRY_KEYS,
  PLACEHOLDER_SOURCE_KEY,
  countByCategory,
  countByClassification,
  getCopyEntry,
  getDefaultText,
} from "@/features/conversation-copy/registry";
export {
  PLACEHOLDER_TOKEN,
  scanPlaceholderTokens,
  substitutePlaceholders,
} from "@/features/conversation-copy/placeholders";
export {
  renderCopy,
  renderCopyText,
} from "@/features/conversation-copy/render";
export {
  MAX_COPY_LENGTH,
  validateCopyCandidate,
} from "@/features/conversation-copy/validation";
export {
  COPY_CATEGORY_VALUES,
  COPY_CLASSIFICATION_VALUES,
  PLACEHOLDER_VALUES,
} from "@/features/conversation-copy/types";
export { NOT_COPY_EXCLUSIONS } from "@/features/conversation-copy/registry";
export type {
  CanonicalCopyKey,
  CopyCategory,
  CopyClassification,
  CopyMarker,
  CopyRegistryEntry,
  CopySource,
  PlaceholderName,
} from "@/features/conversation-copy/registry";
export type {
  PlaceholderSyntaxError,
  PlaceholderToken,
} from "@/features/conversation-copy/placeholders";
export type {
  CopyRenderFailure,
  CopyRenderFailureCode,
  CopyRenderResult,
  CopyRenderSuccess,
} from "@/features/conversation-copy/render";
export type {
  CopyValidationFailure,
  CopyValidationFailureCode,
  CopyValidationResult,
  CopyValidationSuccess,
} from "@/features/conversation-copy/validation";
