import { URL } from "node:url";
import pg from "pg";

async function main() {
  const rawUrl = process.env.DATABASE_URL;
  const secretPresent = Boolean(rawUrl && rawUrl.trim().length > 0);

  if (!secretPresent) {
    console.log("SECRET_PRESENT=false");
    console.log("DIRECT_ENDPOINT=false");
    console.log("EXPECTED_ENDPOINT_MATCH=false");
    console.log("EXPECTED_DATABASE_MATCH=false");
    console.log("SELECT_1_SUCCESS=false");
    process.exit(0);
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

  let select1Success = false;
  let errorCode = null;

  const client = new pg.Client({
    connectionString: rawUrl,
    ssl: { rejectUnauthorized: true },
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    const res = await client.query("SELECT 1 AS ok");
    select1Success = Boolean(
      res.rows && res.rows[0] && (res.rows[0].ok === 1 || res.rows[0].ok === "1"),
    );
  } catch (err) {
    select1Success = false;
    errorCode = err?.code || "CONNECT_ERROR";
  } finally {
    await client.end().catch(() => {});
  }

  console.log(`SELECT_1_SUCCESS=${select1Success}`);
  if (errorCode) {
    console.log(`ERROR_CODE=${errorCode}`);
  }

  // Append safe summary to GITHUB_STEP_SUMMARY if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import("node:fs/promises");
    const summary = [
      "### Production DB Connection Preflight (Read-Only)",
      "",
      `| Check | Result |`,
      `| :--- | :--- |`,
      `| Secret Present | \`${secretPresent}\` |`,
      `| Direct Endpoint (no -pooler) | \`${isDirect}\` |`,
      `| Expected Endpoint Match | \`${expectedEndpointMatch}\` |`,
      `| Expected Database Match | \`${expectedDbMatch}\` |`,
      `| SELECT 1 Query Success | \`${select1Success}\` |`,
      errorCode ? `| Error Code | \`${errorCode}\` |` : "",
      "",
    ]
      .filter(Boolean)
      .join("\n");
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }
}

main().catch((err) => {
  console.error("Fatal preflight failure:", err?.code || "UNKNOWN");
  process.exit(1);
});
