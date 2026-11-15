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
