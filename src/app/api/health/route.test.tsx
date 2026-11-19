import { GET as getLiveness } from "./live/route";
import { GET } from "./route";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    user: { count: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    account: { count: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/server/db", () => ({ db }));
vi.mock("@/lib/url-resolver", () => ({ populatePreviewEnvIfNeeded: vi.fn() }));

describe("Health endpoint has no provisioning side effects", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/neondb");
    db.$queryRaw.mockResolvedValue([]);
    db.user.count.mockResolvedValue(0);
    db.account.count.mockResolvedValue(0);
    db.user.findUnique.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("reports an absent account without creating it or altering schema", async () => {
    const body = await (await GET()).json();
    expect(body.previewDiagnostics.previewTestAccountReady).toBe(false);
    expect(body.previewDiagnostics.migrationApplied).toBe(false);
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.account.create).not.toHaveBeenCalled();
  });
  it("reads actual completed migration and preexisting account readiness", async () => {
    db.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ migration_name: "test" }]);
    db.user.findUnique.mockResolvedValue({
      id: "test-admin",
      isActive: true,
      role: "ADMIN",
      accountType: "BUSINESS",
      businessId: "test-business",
    });
    db.account.count.mockResolvedValue(1);
    const body = await (await GET()).json();
    expect(body.previewDiagnostics.migrationApplied).toBe(true);
    expect(body.previewDiagnostics.previewTestAccountReady).toBe(true);
    expect(db.user.create).not.toHaveBeenCalled();
  });
  it("does not reveal raw diagnostic exceptions", async () => {
    db.user.count.mockRejectedValue(new Error("synthetic-sensitive-value"));
    const body = await (await GET()).json();
    expect(body.previewDiagnostics.error).toBe(
      "PREVIEW_DIAGNOSTICS_UNAVAILABLE",
    );
    expect(JSON.stringify(body)).not.toContain("synthetic-sensitive-value");
  });
  it("does not create an account on repeated probes", async () => {
    await GET();
    await GET();
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.account.create).not.toHaveBeenCalled();
    expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("Health readiness HTTP status, Render identity & lightweight liveness", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
    vi.stubEnv("RENDER_GIT_COMMIT", "");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/neondb");
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "placeholder-auth-secret-at-least-32-chars",
    );
    vi.stubEnv("BETTER_AUTH_URL", "https://yakfi-web.onrender.com");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://yakfi-web.onrender.com");
    db.$queryRaw.mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns HTTP 200 with RENDER_GIT_COMMIT when all env vars and DB are ready", async () => {
    const renderSha = "c".repeat(40);
    vi.stubEnv("RENDER_GIT_COMMIT", renderSha);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.deploymentReady).toBe(true);
    expect(body.database).toBe("connected");
    expect(body.commitSha).toBe(renderSha);
    expect(body.missingEnvVars).toEqual([]);
  });

  it("returns HTTP 503 when database is unreachable and never reports ready", async () => {
    db.$queryRaw.mockRejectedValue(new Error("connection refused"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.deploymentReady).toBe(false);
    expect(body.database).toBe("unreachable");
  });

  it("returns HTTP 503 when required env vars are missing", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.deploymentReady).toBe(false);
    expect(body.missingEnvVars).toContain("NEXT_PUBLIC_APP_URL");
  });

  it("serves /api/health/live with HTTP 200 and zero DB queries even when DB is down", async () => {
    const renderSha = "d".repeat(40);
    vi.stubEnv("RENDER_GIT_COMMIT", renderSha);
    db.$queryRaw.mockRejectedValue(new Error("db offline"));

    const response = await getLiveness();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.live).toBe(true);
    expect(body.commitSha).toBe(renderSha);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
