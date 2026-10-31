import { URL } from "node:url";
import pg from "pg";

const CANDIDATE_MIGRATIONS = [
  "0_init",
  "20260826120000_onboarding_fields",
  "20260902120000_invitation_model",
  "20260903120000_invitation_activation",
  "20260903130000_business_vertical",
  "20260903140000_business_confirmation_mode",
  "20260910120000_architecture_hardening_foundation",
  "20260913120000_invitation_updated_at_default",
  "20260913150000_account_issuer",
  "20260913170000_platform_control_plane",
  "20260919120000_whatsapp_onboarding_lifecycle",
  "20260920140745_runtime_credentials",
  "20260923120000_operator_attention",
  "20260926120000_telegram_connection",
  "20260927120000_telegram_provisioning_outcome",
  "20261002120000_service_price",
  "20261002130000_operator_attention_cause",
  "20261002140000_knowledge_gap",
  "20261003150000_business_address",
  "20261004120000_business_assistant_style",
  "20261004130000_ai_policy_openrouter_provider_only",
  "20261009120000_platform_copy_overrides",
  "20261017120000_independent_provider_identity",
  "20261018140000_follow_up_requests",
  "20261018180000_appointment_reminders",
  "20261019120000_default_service_and_performed_correction",
  "20261019180000_conversation_state_records",
  "20261029193000_readable_interaction_history",
  "20261030180000_business_appointment_time_display",
];

async function writeSummary({
  connectionChecks,
  migrationChecks,
  catalogChecks,
  dataChecks,
  errorCode,
  overallStatus,
}) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  try {
    const fs = await import("node:fs/promises");
    const lines = [
      "## Production Database Inspection (Read-Only)",
      "",
      "### Connection Verification",
      "| Check | Result |",
      "| :--- | :--- |",
      `| Secret Present | \`${connectionChecks.secretPresent}\` |`,
      `| Direct Endpoint (no -pooler) | \`${connectionChecks.isDirect}\` |`,
      `| Expected Endpoint Match | \`${connectionChecks.expectedEndpointMatch}\` |`,
      `| Expected Database Match | \`${connectionChecks.expectedDbMatch}\` |`,
      `| Connection & Query Success | \`${connectionChecks.select1Success}\` |`,
      errorCode ? `| Error Code | \`${errorCode}\` |` : "",
      `| **Preflight Status** | **\`${overallStatus}\`** |`,
      "",
    ].filter(Boolean);

    if (migrationChecks) {
      lines.push(
        "### Migrations Summary",
        "| Metric | Value |",
        "| :--- | :--- |",
        `| Applied Migrations Count | \`${migrationChecks.appliedCount}\` |`,
        `| Unresolved Migrations Count | \`${migrationChecks.unresolvedCount}\` |`,
        `| Rolled-back Migrations Count | \`${migrationChecks.rolledBackCount}\` |`,
        `| Pending vs Candidate (29 total) | \`${migrationChecks.pendingCandidateMigrations.length}\` |`,
        `| Pending Migrations | \`${migrationChecks.pendingCandidateMigrations.join(", ") || "None"}\` |`,
        "",
      );
    }

    if (catalogChecks) {
      lines.push(
        "### Target Column Inspection (`businesses.appointment_time_display`)",
        "| Property | Value |",
        "| :--- | :--- |",
        `| Column Exists | \`${catalogChecks.columnExists}\` |`,
        `| Data Type | \`${catalogChecks.dataType || "N/A"}\` |`,
        `| Is Nullable | \`${catalogChecks.isNullable || "N/A"}\` |`,
        `| Column Default | \`${catalogChecks.columnDefault || "N/A"}\` |`,
        "",
      );
    }

    if (dataChecks) {
      lines.push(
        "### Column Values Integrity",
        "| Check | Value |",
        "| :--- | :--- |",
        `| Total Businesses | \`${dataChecks.totalCount}\` |`,
        `| NULL Value Count | \`${dataChecks.nullCount}\` |`,
        `| Invalid Value Count | \`${dataChecks.invalidCount}\` |`,
        `| Value Breakdown | \`${JSON.stringify(dataChecks.breakdown)}\` |`,
        "",
      );
    }

    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
  } catch {
    // Non-fatal if writing step summary fails
  }
}

async function main() {
  const rawUrl = process.env.DATABASE_URL;
  const secretPresent = Boolean(rawUrl && rawUrl.trim().length > 0);

  if (!secretPresent) {
    console.log("SECRET_PRESENT=false");
    console.log("DIRECT_ENDPOINT=false");
    console.log("EXPECTED_ENDPOINT_MATCH=false");
    console.log("EXPECTED_DATABASE_MATCH=false");
    console.log("SELECT_1_SUCCESS=false");
    console.log("CONNECTION_PREFLIGHT=BLOCKED");

    await writeSummary({
      connectionChecks: {
        secretPresent: false,
        isDirect: false,
        expectedEndpointMatch: false,
        expectedDbMatch: false,
        select1Success: false,
      },
      errorCode: "MISSING_SECRET",
      overallStatus: "BLOCKED",
    });

    process.exit(1);
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.log("SECRET_PRESENT=true");
    console.log("DIRECT_ENDPOINT=false");
    console.log("EXPECTED_ENDPOINT_MATCH=false");
    console.log("EXPECTED_DATABASE_MATCH=false");
    console.log("SELECT_1_SUCCESS=false");
    console.log("CONNECTION_PREFLIGHT=BLOCKED");

    await writeSummary({
      connectionChecks: {
        secretPresent: true,
        isDirect: false,
        expectedEndpointMatch: false,
        expectedDbMatch: false,
        select1Success: false,
      },
      errorCode: "INVALID_URL",
      overallStatus: "BLOCKED",
    });

    process.exit(1);
  }

  const hostname = parsed.hostname || "";
  const pathname = (parsed.pathname || "").replace(/^\//, "");

  const isDirect = !hostname.includes("-pooler");
  const expectedHost = "ep-tiny-grass-a5e63jev.us-east-2.aws.neon.tech";
  const expectedDb = "neondb";

  const expectedEndpointMatch = hostname === expectedHost;
  const expectedDbMatch = pathname === expectedDb;

  console.log(`SECRET_PRESENT=${secretPresent}`);
  console.log(`DIRECT_ENDPOINT=${isDirect}`);
  console.log(`EXPECTED_ENDPOINT_MATCH=${expectedEndpointMatch}`);
  console.log(`EXPECTED_DATABASE_MATCH=${expectedDbMatch}`);

  if (!isDirect || !expectedEndpointMatch || !expectedDbMatch) {
    console.log("SELECT_1_SUCCESS=false");
    console.log("CONNECTION_PREFLIGHT=BLOCKED");
    await writeSummary({
      connectionChecks: {
        secretPresent,
        isDirect,
        expectedEndpointMatch,
        expectedDbMatch,
        select1Success: false,
      },
      errorCode: "ENDPOINT_OR_DB_MISMATCH",
      overallStatus: "BLOCKED",
    });
    process.exit(1);
  }

  let select1Success = false;
  let errorCode = null;

  // Strict certificate verification enabled via rejectUnauthorized: true
  const client = new pg.Client({
    connectionString: rawUrl,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
  });

  let migrationChecks = null;
  let catalogChecks = null;
  let dataChecks = null;

  try {
    await client.connect();
    const res = await client.query("SELECT 1 AS ok");
    select1Success = Boolean(
      res.rows && res.rows[0] && (res.rows[0].ok === 1 || res.rows[0].ok === "1"),
    );
    console.log(`SELECT_1_SUCCESS=${select1Success}`);

    // Inspect _prisma_migrations
    const migRes = await client.query(
      `SELECT id, migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
       FROM public._prisma_migrations
       ORDER BY started_at ASC;`
    );

    const rows = migRes.rows || [];
    const appliedRows = rows.filter(
      (r) => r.finished_at !== null && r.rolled_back_at === null
    );
    const unresolvedRows = rows.filter(
      (r) => r.finished_at === null && r.rolled_back_at === null
    );
    const rolledBackRows = rows.filter((r) => r.rolled_back_at !== null);

    const appliedNames = new Set(appliedRows.map((r) => r.migration_name));
    const pendingCandidateMigrations = CANDIDATE_MIGRATIONS.filter(
      (m) => !appliedNames.has(m)
    );

    migrationChecks = {
      appliedCount: appliedRows.length,
      unresolvedCount: unresolvedRows.length,
      rolledBackCount: rolledBackRows.length,
      appliedNames: Array.from(appliedNames),
      unresolvedRows: unresolvedRows.map((r) => ({
        id: r.id,
        name: r.migration_name,
      })),
      pendingCandidateMigrations,
    };

    console.log(`APPLIED_MIGRATIONS_COUNT=${appliedRows.length}`);
    console.log(`UNRESOLVED_MIGRATIONS_COUNT=${unresolvedRows.length}`);
    console.log(`ROLLED_BACK_MIGRATIONS_COUNT=${rolledBackRows.length}`);
    console.log(
      `PENDING_CANDIDATE_MIGRATIONS_COUNT=${pendingCandidateMigrations.length}`
    );
    console.log(
      `PENDING_CANDIDATE_MIGRATIONS=${JSON.stringify(pendingCandidateMigrations)}`
    );

    // Inspect businesses.appointment_time_display column
    const colRes = await client.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'businesses'
         AND column_name = 'appointment_time_display';`
    );

    if (colRes.rows && colRes.rows.length > 0) {
      const col = colRes.rows[0];
      catalogChecks = {
        columnExists: true,
        dataType: col.data_type,
        isNullable: col.is_nullable,
        columnDefault: col.column_default,
      };

      console.log("TARGET_COLUMN_EXISTS=true");
      console.log(`TARGET_COLUMN_DATA_TYPE=${col.data_type}`);
      console.log(`TARGET_COLUMN_IS_NULLABLE=${col.is_nullable}`);
      console.log(`TARGET_COLUMN_DEFAULT=${col.column_default}`);

      // Inspect column value integrity
      const countRes = await client.query(
        `SELECT
           COUNT(*) AS total_count,
           SUM(CASE WHEN appointment_time_display IS NULL THEN 1 ELSE 0 END) AS null_count,
           SUM(CASE WHEN appointment_time_display NOT IN ('START_ONLY', 'FULL_RANGE') THEN 1 ELSE 0 END) AS invalid_count
         FROM public.businesses;`
      );

      const distRes = await client.query(
        `SELECT appointment_time_display, COUNT(*) AS cnt
         FROM public.businesses
         GROUP BY appointment_time_display;`
      );

      const breakdown = {};
      for (const row of distRes.rows || []) {
        breakdown[row.appointment_time_display] = Number(row.cnt);
      }

      const totalCount = Number(countRes.rows[0]?.total_count || 0);
      const nullCount = Number(countRes.rows[0]?.null_count || 0);
      const invalidCount = Number(countRes.rows[0]?.invalid_count || 0);

      dataChecks = {
        totalCount,
        nullCount,
        invalidCount,
        breakdown,
      };

      console.log(`VALUES_TOTAL_COUNT=${totalCount}`);
      console.log(`VALUES_NULL_COUNT=${nullCount}`);
      console.log(`VALUES_INVALID_COUNT=${invalidCount}`);
      console.log(`VALUES_BREAKDOWN=${JSON.stringify(breakdown)}`);
    } else {
      catalogChecks = {
        columnExists: false,
        dataType: null,
        isNullable: null,
        columnDefault: null,
      };
      console.log("TARGET_COLUMN_EXISTS=false");
    }

    // Print specific authorized migration record if applied
    const authMig = rows.find(
      (r) => r.migration_name === "20261030180000_business_appointment_time_display"
    );
    if (authMig) {
      console.log(
        `AUTH_MIGRATION_RECORD=${JSON.stringify({
          migration_name: authMig.migration_name,
          finished_at: authMig.finished_at,
          rolled_back_at: authMig.rolled_back_at,
          checksum: authMig.checksum,
          applied_steps_count: authMig.applied_steps_count,
        })}`
      );
    } else {
      console.log("AUTH_MIGRATION_RECORD=NOT_APPLIED");
    }
  } catch (err) {
    select1Success = false;
    errorCode = err?.code || "QUERY_ERROR";
    console.error("DB inspection query failed:", err?.message || err);
  } finally {
    await client.end().catch(() => {});
  }

  const allReady =
    secretPresent &&
    isDirect &&
    expectedEndpointMatch &&
    expectedDbMatch &&
    select1Success;

  console.log(`CONNECTION_PREFLIGHT=${allReady ? "READY" : "BLOCKED"}`);

  await writeSummary({
    connectionChecks: {
      secretPresent,
      isDirect,
      expectedEndpointMatch,
      expectedDbMatch,
      select1Success,
    },
    migrationChecks,
    catalogChecks,
    dataChecks,
    errorCode,
    overallStatus: allReady ? "READY" : "BLOCKED",
  });

  if (!allReady) {
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("Fatal preflight failure code:", err?.code || "FATAL_ERROR");
  process.exit(1);
});
