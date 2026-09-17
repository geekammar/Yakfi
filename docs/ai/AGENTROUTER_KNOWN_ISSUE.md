# AgentRouter — Known Issue (not remediated here)

> Status: **documented only**. This record exists so the failure is not lost.
> AgentRouter remediation is explicitly **out of scope** for
> PROMPT-ARCH-AI-PROVIDER-ATRIA-07 and must be handled by a dedicated task.

## History

1. **Historical hostname problem (proven).** The originally configured endpoint
   `https://api.agentrouter.ai/v1/chat/completions` was invalid —
   `api.agentrouter.ai` did not resolve (NXDOMAIN). It could never have worked.
2. **Endpoint correction (applied, minimal).** The constant in
   `src/server/integrations/ai/agentrouter.ts` was corrected to
   `https://agentrouter.org/v1/chat/completions`. This was the only AgentRouter
   change made, and it remains in place.
3. **Current production failure.** After the endpoint correction, a real
   production WhatsApp `AI_TURN` still fails.
4. **Cause not proven.** The exact provider-side reason is currently **not
   persisted and not proven**. Investigation strongly indicates a provider-side
   rejection/failure, but the precise error (auth, model id, quota, payload
   shape) has not been captured.

## Scope guardrails (this task)

AgentRouter was intentionally **not** remediated. The following were **not** done
and must not be done outside a dedicated AgentRouter task:

- changing the endpoint again;
- changing authentication or credentials;
- changing the model (`deepseek-v4-flash`);
- debugging, retry logic, or temporary routes;
- modifying production behavior beyond the one endpoint constant above.

## Why Atria was added instead

Atria was introduced as an isolated, selectable adapter precisely so provider
choice is no longer coupled to any single vendor's health. The provider
abstraction (`docs/ai/PROVIDERS.md`) makes the primary/secondary choice a
runtime policy decision; selecting Atria as primary leaves the AgentRouter
adapter and its configuration completely untouched.

## Required next step (separate task)

A dedicated AgentRouter remediation task must, at minimum:

1. Capture and persist the exact provider-side error for a real `AI_TURN`
   (status code, provider error body) — the missing evidence.
2. From that evidence, determine whether the failure is auth, model id, quota,
   or request shape, and remediate accordingly.
3. Re-validate with a controlled provider probe before any WhatsApp E2E test.
