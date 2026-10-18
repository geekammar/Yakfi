# Appointment Reminders Activation Guide (BOOK-REM-01)

> **Important Operational Notice**  
> `Reminder delivery is intentionally disabled during Discovery.`  
> The architecture and settings UX are built and validated in code, but no background worker, external scheduler, or automated dispatch is active. Reminders are disabled by default at the server level.

---

## 1. Required Operator Approval

Activation of appointment reminders in production requires explicit, written authorization from the Platform Owner / Lead Operator. Automatic messaging incurs customer communication impact and third-party API usage (Meta Cloud API). Reminders must remain dormant until all operational prerequisites are formally signed off.

---

## 2. Supported Scheduler Choice

The application is hosted on Vercel Hobby plan, which **does not support hourly crons**. Do not add hourly cron expressions to `vercel.json`.

Supported production scheduler options:

1. **GitHub Actions Scheduled Workflow**: (e.g., hourly cron workflow invoking `/api/cron/appointment-reminders` with `CRON_SECRET`).
2. **Dedicated External HTTP Scheduler**: (e.g., Cron-Job.org, Upstash QStash, or Cloudflare Worker Cron) dispatching authenticated HTTP `POST` requests to `/api/cron/appointment-reminders`.
3. **Vercel Pro Upgrade**: If upgraded to Vercel Pro, a native cron entry in `vercel.json` can be configured.

---

## 3. Required Environment Variables

To activate reminder dispatch on the server, the following environment variables must be configured in Vercel Production Environment:

| Variable                        | Required Value / Description       | Purpose                                                                           |
| :------------------------------ | :--------------------------------- | :-------------------------------------------------------------------------------- |
| `APPOINTMENT_REMINDERS_ENABLED` | `"true"`                           | Centralized server-side gate. If absent, `"false"`, or invalid, the system halts. |
| `CRON_SECRET`                   | Strong random secret (>= 32 chars) | Timing-safe secret for authenticating the scheduler trigger.                      |
| `WHATSAPP_ACCESS_TOKEN`         | System User Access Token           | Meta Cloud API Bearer Token for outbound template messaging.                      |
| `WHATSAPP_PHONE_NUMBER_ID`      | Production Phone Number ID         | Meta Business Phone ID for outbound messaging.                                    |
| `TELEGRAM_BOT_TOKEN`            | Production Bot Token (Optional)    | Outbound Telegram delivery for Telegram-connected customers.                      |

---

## 4. Required Channel Credentials

For each business:

1. **WhatsApp**: The business must have an active, connected WhatsApp connection (`WhatsAppConnection` status = `CONNECTED` and `isActive = true`).
2. **Telegram**: If reaching customers via Telegram, an active bot connection (`TelegramConnection` status = `CONNECTED` and `isActive = true`) must be configured.

---

## 5. WhatsApp Template Approval

Meta requires pre-approved message templates for outbound notifications outside the 24-hour customer service window.

- **Template Name**: `appointment_reminder`
- **Category**: `UTILITY`
- **Language**: `ar` (Arabic)
- **Parameters**:
  - `{{1}}`: Business Name (`اسم المنشأة`)
  - `{{2}}`: Appointment Date (`تاريخ الموعد`)
  - `{{3}}`: Appointment Start Time (`وقت الموعد`)
  - `{{4}}`: Service Name (`اسم الخدمة`)
- **Status in Meta Business Manager**: Must be `APPROVED` before production delivery.

---

## 6. Customer Messaging Eligibility and Consent

- Reminders must ONLY be dispatched for appointments in `CONFIRMED` status.
- Reminders must NOT be sent for `CANCELLED`, `COMPLETED`, or `NO_SHOW` appointments.
- Customers must provide explicit opt-in / booking consent during appointment booking.
- Late bookings created within the lead-time window (e.g. booked 2 hours before start when lead-time is 24 hours) are automatically suppressed to avoid sending stale or redundant immediate messages.

---

## 7. Safe Deployment Procedure

1. Verify the code is deployed and healthy at `/api/health`.
2. Verify database migration `20261018180000_appointment_reminders` is applied to production via the approved operator workflow (`production-db-migrate.yml`).
3. Set `CRON_SECRET` in production secrets.
4. Set `APPOINTMENT_REMINDERS_ENABLED="true"` in Vercel Production environment.
5. Trigger redeployment of production or restart serverless instances so environment changes take effect.
6. Verify `/api/cron/appointment-reminders` returns `success: true` with authenticated `CRON_SECRET`.

---

## 8. Database Migration Prerequisites

Before setting `APPOINTMENT_REMINDERS_ENABLED="true"`, ensure:

- Migration `20261018180000_appointment_reminders` has executed successfully.
- `businesses.reminder_enabled`, `businesses.reminder_lead_hours`, and `businesses.reminder_template_id` exist.
- `appointment_reminders` table and indexes exist.
- Partial unique index `appointment_reminders_active_appointment_idx` is active to enforce at most one active reminder per appointment.

---

## 9. Idempotency and Delivery Monitoring

- Reminders use atomic row claiming (`SKIP LOCKED`) to guarantee that concurrent workers or overlapping cron runs cannot claim the same reminder record.
- Maximum delivery attempts: 3.
- Transient errors (`TRANSIENT_TRANSPORT_FAILURE`) are marked `FAILED_RETRYABLE`.
- Permanent errors (`INVALID_RECIPIENT`, `UNSUPPORTED_TEMPLATE`, `BLOCKED_USER`) are marked `FAILED_PERMANENT` immediately.
- Monitor execution through:
  - Vercel Function logs: `/api/cron/appointment-reminders`.
  - Database status breakdown:
    ```sql
    SELECT status, COUNT(*) FROM appointment_reminders GROUP BY status;
    ```

---

## 10. Sandbox Testing Before Real Sends

Before enabling real customer messaging:

1. Connect a dedicated Meta Sandbox / Test WhatsApp number.
2. Create test appointments in an isolated test business.
3. Trigger the reminder processor manually:
   ```bash
   curl -X POST https://flowpilot-prod.vercel.app/api/cron/appointment-reminders \
     -H "Authorization: Bearer <CRON_SECRET>"
   ```
4. Verify template reception on test mobile device.
5. Verify delivery receipts and status update from `CLAIMED` to `SENT`.

---

## 11. Rollback / Emergency Disable Procedure

If message errors or unwanted dispatches occur:

1. **Immediate Server-Level Killswitch**: Set `APPOINTMENT_REMINDERS_ENABLED="false"` or delete the variable from Vercel environment.
   - All reminder processing, creation, and dispatch immediately halts on the server.
2. **Scheduler Pause**: Disable the scheduled trigger (GitHub Actions / External scheduler).
3. **Database Safeguard**:
   ```sql
   UPDATE appointment_reminders
   SET status = 'CANCELLED', last_error = 'EMERGENCY_KILLSWITCH'
   WHERE status IN ('PENDING', 'CLAIMED', 'FAILED_RETRYABLE');
   ```
