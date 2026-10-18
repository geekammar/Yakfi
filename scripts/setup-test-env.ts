// FlowPilot test environment bootstrap for offline scripts
process.env.DATABASE_URL ??=
  "postgresql://user:password@localhost:5432/placeholder";
process.env.BETTER_AUTH_SECRET ??= "0".repeat(32);
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
process.env.CRON_SECRET ??= "test-cron-secret";
