/**
 * The assistant's VOICE — ONE provider-neutral, channel-agnostic definition
 * (DECISIONS #62).
 *
 * Why this module exists: the operator should not have to write or edit raw
 * prompts to make the assistant behave naturally (DECISIONS #43/#48 lock
 * prompt bodies to source control — there is deliberately NO prompt editor
 * UI, and superadmin may not edit prompt definitions). Before #62 the
 * entire personality surface was a single hard-coded sentence inside
 * `prompts/system/booking-assistant.prompt`. This module is the structured
 * alternative: the voice is declared as TYPED, VALIDATED VALUES, not prose,
 * and it reaches the assistant through the shared provider-neutral context
 * — never through a per-provider prompt copy.
 *
 * What this is NOT:
 *  - It is NOT a prompt editor and never emits prompt bodies. The compiled
 *    instruction in `prompts/system/booking-assistant.prompt` stays the
 *    immutable contract; the style is carried as REQUEST CONTEXT (exactly
 *    like `businessName`, which is documented "for phrasing only").
 *  - It is NOT operator-persisted yet. There is exactly ONE resident value
 *    (`ASSISTANT_STYLE`), tuned by code review in Git — the same change
 *    path #48 mandates for prompts. Per-business persistence is a future
 *    DOMAIN decision: it needs one nullable column + a nested optional Zod
 *    object, and it must not land before pilot evidence picks a voice.
 *    No migration is added by #62.
 *
 * Invariants the style can NEVER override (DECISIONS #33/#50–#52/#61):
 *  - the disclosure gate (`enforceDisclosure`) never reads the style and
 *    never inspects reply text; a style cannot widen the closed
 *    `KNOWLEDGE_FREE_REPLY_INTENTS` list or weaken the fail-closed rules;
 *  - booking / availability authority stays with the Domain;
 *  - the structured output contract (`aiResponseSchema`) is untouched;
 *  - the assistant stays transparent about being automated when the
 *    disclosure policy requires it — the style is expressly forbidden from
 *    instructing the assistant to claim it is human;
 *  - tenant isolation, human ownership and Conversation Control are above
 *    this layer entirely.
 *
 * Provider- and channel-neutrality: this module imports no provider
 * adapter and no channel code, and names neither. It sits ABOVE the
 * provider seam (the context builder embeds the directive into
 * `AiRequest`) and BELOW the conversation engine, so swapping the selected
 * provider — or adding a future second channel — requires NO style rewrite
 * and NO duplicated prompt. (Grep this file for a vendor or channel name:
 * there is none, by construction.)
 */

import { z } from "zod";

// ─── The six candidate dimensions (typed; one resident value) ────────────────

/** Reply language. `auto` defers to the customer's message language. */
export const assistantLanguageValues = ["ar", "auto", "en"] as const;
export type AssistantLanguage = (typeof assistantLanguageValues)[number];

/**
 * Arabic register. `egyptian_msa` = clear MSA with a warm Egyptian flavor —
 * the Discovery voice for the Egyptian pilot (Egyptian greetings are already
 * covered deterministically by DECISIONS #61). `msa` = neutral MSA.
 */
export const arabicStyleValues = ["egyptian_msa", "msa"] as const;
export type ArabicStyle = (typeof arabicStyleValues)[number];

/** Conversational tone. */
export const toneValues = [
  "friendly",
  "friendly_professional",
  "professional",
  "concise",
] as const;
export type AssistantTone = (typeof toneValues)[number];

/** Reply length / detail. */
export const detailValues = ["short", "balanced", "detailed"] as const;
export type AssistantDetail = (typeof detailValues)[number];

/** Emoji usage in provider-authored replies. */
export const emojiValues = ["none", "light", "friendly"] as const;
export type AssistantEmoji = (typeof emojiValues)[number];

/** The assistant's role/persona (vertical-agnostic by DECISIONS #09). */
export const assistantRoleValues = [
  "booking_assistant",
  "receptionist",
  "customer_service",
  "sales_assistant",
] as const;
export type AssistantRole = (typeof assistantRoleValues)[number];

/**
 * The full style surface. Every dimension is a CLOSED enum: extending a
 * dimension is a reviewed change, and no style can carry free text.
 */
export const assistantStyleSchema = z.object({
  language: z.enum(assistantLanguageValues),
  arabicStyle: z.enum(arabicStyleValues),
  tone: z.enum(toneValues),
  detail: z.enum(detailValues),
  emoji: z.enum(emojiValues),
  role: z.enum(assistantRoleValues),
});

export type AssistantStyle = z.infer<typeof assistantStyleSchema>;

/**
 * The ONE resident style — the evidence-based default:
 * Arabic-first (DECISIONS #07), Egyptian-flavored MSA for the Discovery
 * pilot, friendly-yet-professional, concise (a short message channel, and
 * DECISIONS #61's deterministic voice), NO emoji (business register + the
 * disclosure boundary), and the booking-assistant role the compiled prompt
 * already declares.
 */
export const ASSISTANT_STYLE: AssistantStyle = assistantStyleSchema.parse({
  language: "ar",
  arabicStyle: "egyptian_msa",
  tone: "friendly_professional",
  detail: "short",
  emoji: "none",
  role: "booking_assistant",
});

// ─── The phrasing directive (provider-neutral request context) ───────────────

/**
 * One Arabic fragment per dimension value. Pure data — no prose generation,
 * no prompt bodies. Every fragment is Arabic-only by construction (the
 * request must never carry provider/endpoint names or machine identifiers;
 * see the context-builder substring guards).
 */
const LANGUAGE_DIRECTIVE: Record<AssistantLanguage, string> = {
  ar: "ردّك باللغة العربية",
  auto: "ردّك بنفس لغة رسالة العميل",
  en: "reply in English",
};

const ARABIC_STYLE_DIRECTIVE: Record<ArabicStyle, string> = {
  egyptian_msa: "فصحى واضحة بلمسة مصرية ودّية",
  msa: "فصحى عربية محايدة وواضحة",
};

const TONE_DIRECTIVE: Record<AssistantTone, string> = {
  friendly: "لهجة ودّية وقريبة",
  friendly_professional: "لهجة ودّية ومهنية في آن واحد",
  professional: "لهجة مهنية رسمية",
  concise: "لهجة مباشرة ومختصرة",
};

const DETAIL_DIRECTIVE: Record<AssistantDetail, string> = {
  short: "ردّ موجز في جملة أو جملتين",
  balanced: "ردّ متوازن يشرح الخطوة التالية",
  detailed: "ردّ مفصّل يغطي ما يحتاجه العميل",
};

const EMOJI_DIRECTIVE: Record<AssistantEmoji, string> = {
  none: "بدون أي رموز تعبيرية (إيموجي)",
  light: "رمز تعبيري واحد على الأكثر حين يناسب الرد",
  friendly: "رموز تعبيرية قليلة وودّية حين تناسب الرد",
};

const ROLE_DIRECTIVE: Record<AssistantRole, string> = {
  booking_assistant: "أنت مساعد الحجز والمواعيد",
  receptionist: "أنت مسؤول الاستقبال",
  customer_service: "أنت مسؤول خدمة العملاء",
  sales_assistant: "أنت مساعد المبيعات",
};

/**
 * Render the style as ONE bounded Arabic phrasing directive carried in the
 * shared provider-neutral `AiRequest` (see `ai-contract.ts` →
 * `buildPromptMessages`). It is a PHRASING hint only — it never adds
 * knowledge, slots, prices, or dates, and it can never relax disclosure or
 * safety: the gate does not read it, and the schema still strips anything
 * outside `aiResponseSchema`.
 *
 * The assistant is always told to stay transparent about being automated —
 * a style can never instruct it to impersonate a human.
 */
export function renderAssistantStyleDirective(
  style: AssistantStyle = ASSISTANT_STYLE,
): string {
  return [
    "أسلوب المساعد:",
    LANGUAGE_DIRECTIVE[style.language],
    ARABIC_STYLE_DIRECTIVE[style.arabicStyle],
    TONE_DIRECTIVE[style.tone] + "،",
    DETAIL_DIRECTIVE[style.detail] + "،",
    EMOJI_DIRECTIVE[style.emoji] + "،",
    ROLE_DIRECTIVE[style.role],
    "— لا تدّعي أنك بشري، وأنت مساعد آلي لمساعدة العميل.",
  ].join(" ");
}

/** The resident directive (rendered once; embedded by the context builder). */
export const ASSISTANT_STYLE_DIRECTIVE = renderAssistantStyleDirective();

// ─── Deterministic-voice conformance (asserted, not enforced inline) ─────────

/**
 * The deterministic replies (`conversation-ai.ts`) are the assistant's
 * DEFAULT voice and are fixed strings by design — determinism is a feature
 * (DECISIONS #61 answers greetings with ZERO provider calls). This records
 * the contract those strings must satisfy so a focused check can prove the
 * deterministic voice MATCHES the configured style. A future persisted,
 * per-business style would drive these templates through the same record;
 * that is deferred pending pilot evidence (no migration in #62).
 */
export const ASSISTANT_VOICE_CONFORMANCE = {
  /** Replies are Arabic (DECISIONS #07). */
  arabicOnly: true,
  /** No emoji in any deterministic reply (matches `ASSISTANT_STYLE.emoji`). */
  emoji: "none" as const,
  /** A deterministic reply stays concise (matches `ASSISTANT_STYLE.detail`). */
  maxLength: 200,
  /** The greeting self-identifies as an assistant — never a human. */
  greetingSelfIdentifies: true,
} as const;
