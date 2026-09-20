import type { CredentialKind } from "@/lib/validation";
import type {
  AuthorizationExchangeParams,
  AuthorizationLaunchParams,
  AuthorizationLaunchResult,
  AuthorizationProvenance,
  AuthorizationResult,
  ConnectionAuthorizer,
} from "@/server/transport/whatsapp-transport";

/**
 * Deterministic connection authorizer — the provider-neutral stand-in
 * for the future Meta Embedded Signup adapter (WHATSAPP-ONBOARDING-01).
 *
 * It is NOT a Meta integration: there is no SDK, no HTTP, no OAuth, no
 * token, and no provider call of any kind. It exists so the onboarding
 * lifecycle, the authorization ledger, and the callback contract are
 * real, testable, and tenant-safe BEFORE the operator-owned Meta App
 * Dashboard configuration lands (DECISIONS #47 — that configuration is
 * the gate for the real adapter; it is deliberately not faked here).
 *
 * Determinism contract:
 * - `launchAuthorization` returns a callback URL that already carries
 *   the opaque `stateRef` and a fixed authorization code, so the whole
 *   round-trip is reproducible offline (the browser simply returns to
 *   the app's own callback route).
 * - `exchangeCallback` derives the SAME provider identity for the SAME
 *   `stateRef`, so a resumed/replayed attempt resolves identically.
 * - The simulated credential is an ENV-var NAME the operator must
 *   populate (the existing reference grammar); nothing is ever stored.
 */
const DETERMINISTIC_AUTHORIZATION_CODE = "fp-deterministic-authorization-code";
const DETERMINISTIC_PROVIDER_NAME = "meta-whatsapp";

/** The simulated provider outcomes the offline harness needs. */
export type DeterministicAuthorizerOutcome =
  "success" | "action_required" | "unreachable" | "declined";

export type DeterministicAuthorizerOptions = {
  outcome?: DeterministicAuthorizerOutcome;
  /** Which credential reference grammar the simulated exchange returns. */
  credentialKind?: CredentialKind;
  /**
   * Force the provider identity the simulated exchange reports (instead
   * of the stateRef-derived one). Harness-only: it simulates a provider
   * reporting an identity that ANOTHER Business already owns, so the
   * duplicate-identity guard is exercisable deterministically.
   */
  externalId?: string;
  /** Opaque state-reference source (default: `crypto.randomUUID`). */
  generateStateRef?: () => string;
};

/** Deterministic numeric digits from a seed (a stable provider identity). */
function deterministicDigits(seed: string, length: number): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 1_000_000_007;
  }
  let digits = "";
  let value = hash;
  while (digits.length < length) {
    digits += String(value % 10);
    value = Math.floor(value / 10) + 7;
  }
  return digits.slice(0, length);
}

/** Opaque, unguessable, single-use state reference. */
function defaultStateRef(): string {
  return crypto.randomUUID();
}

export function createDeterministicConnectionAuthorizer(
  options: DeterministicAuthorizerOptions = {},
): ConnectionAuthorizer {
  const outcome = options.outcome ?? "success";
  const credentialKind = options.credentialKind ?? "ENV";
  const generateStateRef = options.generateStateRef ?? defaultStateRef;
  return {
    providerName: DETERMINISTIC_PROVIDER_NAME,
    async launchAuthorization(
      params: AuthorizationLaunchParams,
    ): Promise<AuthorizationLaunchResult> {
      const stateRef = params.existingStateRef ?? generateStateRef();
      const url = new URL(params.redirectUri);
      url.searchParams.set("state", stateRef);
      url.searchParams.set("code", DETERMINISTIC_AUTHORIZATION_CODE);
      return { authorizationUrl: url.toString(), stateRef };
    },

    async exchangeCallback(
      params: AuthorizationExchangeParams,
    ): Promise<AuthorizationResult> {
      if (params.code !== DETERMINISTIC_AUTHORIZATION_CODE) {
        return {
          ok: false,
          code: "INVALID_AUTHORIZATION_CODE",
          message: "رمز تفويض غير صالح",
        };
      }
      if (outcome === "declined") {
        return {
          ok: false,
          code: "AUTHORIZATION_DECLINED",
          message: "تم رفض التفويض",
        };
      }
      if (outcome === "unreachable") {
        return {
          ok: false,
          code: "PROVIDER_UNREACHABLE",
          message: "تعذر الوصول إلى المزوّد",
        };
      }
      if (outcome === "action_required") {
        return {
          ok: false,
          code: "PROVISIONING_INCOMPLETE",
          message: "يحتاج الرقم إلى مراجعة من المزوّد",
        };
      }

      const seed = params.stateRef;
      const externalId =
        options.externalId ?? `1${deterministicDigits(seed, 15)}`;
      const provenance: AuthorizationProvenance = {
        meta_business_id: `1${deterministicDigits(`mbi-${seed}`, 15)}`,
        waba_id: `1${deterministicDigits(`waba-${seed}`, 15)}`,
        meta_review_status: "approved",
      };
      return {
        ok: true,
        externalId,
        // ENV grammar: the NAME the operator must populate. A RUNTIME
        // handle exercises the `fp:` grammar (backend deferred).
        credentialsRef:
          credentialKind === "RUNTIME"
            ? `fp:${deterministicDigits(seed, 24)}`
            : `WHATSAPP_META_TOKEN_${deterministicDigits(seed, 6)}`,
        credentialKind,
        displayPhoneNumber: `+20100${deterministicDigits(seed, 7)}`,
        verifiedName: "FlowPilot Business",
        provenance,
      };
    },
  };
}

/**
 * The wired stand-in until the Meta Embedded Signup adapter lands. It
 * simulates a successful authorization and never touches a network.
 */
export const deterministicConnectionAuthorizer: ConnectionAuthorizer =
  createDeterministicConnectionAuthorizer();
