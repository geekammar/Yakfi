# FLOWPILOT — CONV-PLAY-02B Rollback Runbook

**Phase:** CONV-PLAY-02B  
**Repository:** `geekammar/flowpilot`  
**Date:** 2026-10-19

---

## 1. Rollback Overview & Safety Guarantees

- **Zero Schema Migrations:** CONV-PLAY-02B introduced zero modifications to `prisma/schema.prisma` and generated zero database migrations. Consequently, **no database rollback, schema downgrade, or data restoration is required**.
- **Feature Flag Containment:** The experimental JEV semantic understanding engine is governed by the environment variable `FLOWPILOT_JEV_SEMANTIC_ENABLED`. It defaults to `false` (disabled) in Production.
- **Playground Isolation:** The Developer Conversation Playground (`src/features/conversations/playground/`) is fully decoupled from the core application and customer-facing routes.

---

## 2. Immediate Triage & Mitigation (No Git Revert Required)

If any unexpected behavior occurs in Production following deployment:

1. **Verify Runtime Flag:**
   Ensure `FLOWPILOT_JEV_SEMANTIC_ENABLED` is absent or set to `false` in Vercel environment variables.
   When `FLOWPILOT_JEV_SEMANTIC_ENABLED=false`, FlowPilot strictly executes `createConservativeJevStrategy()`, routing every turn directly to deterministic bypass (`bypassDeterministicAi`).

2. **Verify Booking Core Health:**
   Run the deterministic booking validation suite:
   ```bash
   pnpm tsx scripts/check-booking-confirm.ts
   ```

---

## 3. Full Git Revert Procedure

If a full code rollback to the previous merge SHA (`18fbeef9f65942370e1ccdff9702e49cbd145819`, PR #12) is requested by an operator:

```bash
# 1. Fetch latest remote state
git fetch origin main

# 2. Revert the merge commit or feature commit
git revert -m 1 <MERGE_COMMIT_SHA> --no-edit

# 3. Verify lightweight local gates
pnpm verify:local

# 4. Push revert commit to main
git push origin main
```

---

## 4. Post-Rollback Validation Checklist

After triggering a rollback:

- [ ] Production health endpoint `GET /api/health` returns `status: "ok"`.
- [ ] Database connectivity verified (`database: "connected"`).
- [ ] Inbound WhatsApp message receives deterministic response.
- [ ] Booking creation and conflict check functioning normally.
