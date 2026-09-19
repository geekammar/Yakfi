# Feature: whatsapp-connection

Business WhatsApp Connection Onboarding (Business Admin → connect /
configure → verify → activate). The settings surface that turns the
proven WhatsApp booking core into a repeatable per-Business pilot
onboarding path (DECISIONS #31, #42).

## Isolation rules

- Everything feature-specific lives in this folder: components, schemas,
  server actions, and the workflow.
- This feature may import from `@/components/ui`, `@/components/shared`,
  `@/lib/*`, `@/server/repositories`, `@/server/transport` (contracts
  only), `@/types`, and its own files — never from another feature
  folder.
- Cross-feature composition happens at the route layer (`src/app`), not
  here.
- No Meta import crosses into this feature EXCEPT the server-action
  wiring (`createDefaultMetaConnectionVerifier`), exactly like the Meta
  transport is wired at the Meta route. The service is provider-neutral:
  it talks to the `ConnectionVerifier` port only.

## Structure

- `schemas/whatsapp-connection-schema.ts` — form-level Zod input
  (displayName, phoneNumber, `externalId`, `credentialsRef`). The client
  NEVER sends `businessId`, `status`, or `isActive`; Zod strips every
  unknown key. `credentialsRef` MUST look like an environment-variable
  NAME (uppercase + digits + underscore) — a pasted raw access token is
  rejected by the pattern.
- `server/whatsapp-connection-service.ts` — the workflow with the
  authorization rules inside: ADMIN-only, the target Business is always
  the actor's own (derived from the trusted session → user record).
  Reuses the EXISTING status model (PENDING / CONNECTED / DISCONNECTED
  - isActive) — no parallel connection-state system. Duplicate
    `externalId` protection is service-layer (DECISIONS #23 check-then-
    create convention — no schema constraint): a provider connection
    identity belongs to one Business only.
- `actions/whatsapp-connection-actions.ts` — thin `"use server"`
  wrappers: build the actor from the authenticated session + DB user,
  run the workflow, revalidate `/settings/whatsapp`, `/settings`,
  `/conversations`.
- `components/whatsapp-connection-screen.tsx` — the setup screen: clear
  lifecycle states (not connected / configured / verified /
  disconnected), non-secret identifiers only (provider, display number,
  MASKED `phone_number_id`, status, last change time), and the
  verification/disconnect/reactivate actions.

## Identity rule

`externalId` — the Meta `phone_number_id` — is the AUTHORITATIVE
provider connection identity (inbound resolution via
`resolveInboundConnection` + `findByExternalId`; outbound Graph URL).
`phoneNumber` (the display number) is a label only and may be formatted
differently by the provider than the stored mapping — this is exactly
the production bug DECISIONS #46 fixed.

## Credentials rule

Never persist raw access tokens. `credentialsRef` is an
environment-variable NAME (e.g. `WHATSAPP_META_ACCESS_TOKEN`, or a
per-connection name such as `WHATSAPP_META_TOKEN_BUSINESS_A`). The
Meta verifier resolves the value at verification time; the value never
crosses the verifier port, the service, the view, or the logs.

## Verification

`verifyConnection` is READ-ONLY: it calls the provider verifier which
performs a single `GET /{apiVersion}/{phone_number_id}` — NO
customer-facing WhatsApp message is ever sent. Outcomes are normalized
to: reachable (→ CONNECTED), invalid credentials, invalid connection,
or unreachable. `updatedAt` on the connection row records the last
verification time; `status` records the last verification outcome — no
new schema fields.

## TEST → REAL replacement

The current Meta TEST connection stays usable (its row +
`credentialsRef` + env fallbacks are untouched). Replacing it with a
real Business connection is configuration/data only:

1. The Business Admin saves the real connection here (phone number +
   real `phone_number_id` + a `credentialsRef` name).
2. The operator stores that Business's permanent access token in the
   deployment environment under the same `credentialsRef` name.
3. The Business Admin verifies; on success the connection is CONNECTED
   and immediately resolvable inbound/outbound by `externalId`.

No code change and no booking/conversation-engine change is required —
the engine resolves the tenant from `externalId` → connection → Business
server-side, so the booking path is connection-agnostic.

## Out of scope (documented follow-ups)

- Meta Embedded Signup (the official in-app onboarding flow) is NOT
  implemented: it requires external Meta dashboard/application
  configuration (a Meta App review state, redirect URIs, and a
  server-side code-exchange step) that cannot be safely completed from
  code alone. The application-side contract is the `ConnectionVerifier`
  port + this settings surface; operator prerequisites are documented in
  the UI and `docs/ENVIRONMENT_VARIABLES.md`. Nothing is faked.
- Multiple connections per Business: the model allows it
  (`listByBusiness`), the pilot model is one (DECISIONS #31); the UI
  surfaces the primary connection.
- Branch-scoped connections: `branchId` defaults to null
  (Business-shared / Default Branch); a branch picker is a follow-up
  once a multi-branch Business exists.

## Related surfaces

- `/settings` links here (a URL link, not a feature import), exactly
  like `/settings/knowledge`.
- The Meta verifier lives at `src/server/integrations/whatsapp/meta-verify.ts`;
  the provider-neutral port (`ConnectionVerifier`,
  `ConnectionVerificationResult`) lives in
  `src/server/transport/whatsapp-transport.ts`.
- Proven by `pnpm check:whatsapp-onboarding`.
