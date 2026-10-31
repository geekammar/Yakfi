import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@/lib/auth";

import SignInPage, { getSignInDestination } from "@/app/(auth)/sign-in/page";

const { mockGetSession, mockRedirect } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}));

vi.mock("@/server/auth/guards", () => ({
  getSession: () => mockGetSession(),
  isPlatformOperator: (user: { accountType?: string | null }) =>
    user?.accountType === "PLATFORM",
}));

vi.mock("@/features/auth/components/login-form", () => ({
  LoginForm: () => <div data-testid="login-form">Mock LoginForm</div>,
}));

describe("SignInPage Boundary & Decision Routing", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockRedirect.mockReset();
  });

  const baseSession: Session = {
    session: {
      id: "sess_123",
      createdAt: new Date(),
      updatedAt: new Date(),
      userId: "user_123",
      expiresAt: new Date(Date.now() + 86400000),
      token: "tok_123",
    },
    user: {
      id: "user_123",
      name: "Test User",
      email: "test@flowpilot.app",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      role: "ADMIN",
      isActive: true,
      accountType: "BUSINESS",
      businessId: "biz_123",
    },
  };

  it("renders the sign-in form without redirect when session is null (invalid/expired/revoked cookie)", async () => {
    mockGetSession.mockResolvedValue(null);

    const jsx = await SignInPage({});

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(jsx).not.toBeNull();
  });

  it("redirects inactive/disabled users to /access-denied", async () => {
    const inactiveSession: Session = {
      ...baseSession,
      user: { ...baseSession.user, isActive: false },
    };
    mockGetSession.mockResolvedValue(inactiveSession);

    await expect(SignInPage({})).rejects.toThrow("NEXT_REDIRECT:/access-denied");
  });

  it("redirects Platform Operators to /platform control surface", async () => {
    const platformSession: Session = {
      ...baseSession,
      user: { ...baseSession.user, accountType: "PLATFORM" },
    };
    mockGetSession.mockResolvedValue(platformSession);

    await expect(SignInPage({})).rejects.toThrow("NEXT_REDIRECT:/platform");
  });

  it("redirects authenticated business users to '/' by default when no redirect param is given", async () => {
    mockGetSession.mockResolvedValue(baseSession);

    await expect(SignInPage({})).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("honors safe internal redirect destinations", async () => {
    mockGetSession.mockResolvedValue(baseSession);

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ redirect: "/admin/team" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/admin/team");
  });

  it("sanitizes control-character open redirects to '/'", async () => {
    mockGetSession.mockResolvedValue(baseSession);

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ redirect: "/\t/evil.example" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/");

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ redirect: "/\n/evil.example" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("sanitizes protocol-relative and backslash destinations to '/'", async () => {
    mockGetSession.mockResolvedValue(baseSession);

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ redirect: "//evil.example" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/");

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ redirect: "/\\evil.example" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("normalizes dot segments and prevents self-redirect to auth screens", async () => {
    mockGetSession.mockResolvedValue(baseSession);

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ redirect: "/admin/../sign-in" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/");

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ redirect: "/sign-in?query=nested" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/");

    await expect(
      SignInPage({
        searchParams: Promise.resolve({ redirect: "/sign-up" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("safely handles non-string or array search parameters", async () => {
    mockGetSession.mockResolvedValue(baseSession);

    await expect(
      SignInPage({
        searchParams: Promise.resolve({
          redirect: ["/admin/team", "/staff"],
        }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("getSignInDestination returns null for null session", async () => {
    const dest = await getSignInDestination(null);
    expect(dest).toBeNull();
  });
});
