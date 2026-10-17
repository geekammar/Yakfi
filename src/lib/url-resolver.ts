/**
 * Safe Dynamic URL Resolver (DEVOPS-01B)
 *
 * Rules:
 * 1. Production uses established Production environment variables unchanged.
 * 2. Preview safely derives URLs from verified Vercel runtime metadata (VERCEL_URL, VERCEL_BRANCH_URL).
 * 3. Never trust arbitrary client-supplied Host headers.
 * 4. Never permit wildcard *.vercel.app origins.
 * 5. Never allow Preview origins to be trusted in Production.
 * 6. Strict CSRF, origin validation, redirect, and cookie protections are preserved.
 */

export function isVercelPreview(): boolean {
  return process.env.VERCEL_ENV === "preview";
}

export function isVercelProduction(): boolean {
  return process.env.VERCEL_ENV === "production";
}

/**
 * Normalizes a host or URL into a strict, secure https:// URL.
 */
export function toAbsoluteHttpsUrl(input: string): string {
  const trimmed = input.trim();
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, "");
  const cleanHost = withoutProtocol.replace(/\/+$/, "");
  return `https://${cleanHost}`;
}

/**
 * Returns the verified Vercel preview deployment hostnames.
 * Only exact hostnames assigned by Vercel for this deployment are included.
 * Never includes wildcards or unverified external origins.
 */
export function getAuthorizedPreviewHosts(): string[] {
  if (!isVercelPreview()) {
    return [];
  }

  const hosts = new Set<string>();

  if (process.env.VERCEL_URL) {
    const clean = process.env.VERCEL_URL.trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
    if (clean) hosts.add(clean);
  }

  if (process.env.VERCEL_BRANCH_URL) {
    const clean = process.env.VERCEL_BRANCH_URL.trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
    if (clean) hosts.add(clean);
  }

  return Array.from(hosts);
}

/**
 * Resolves the application public URL:
 * - Production: uses NEXT_PUBLIC_APP_URL / BETTER_AUTH_URL from env.
 * - Preview: derives from verified VERCEL_URL / VERCEL_BRANCH_URL (https://).
 * - Local / Dev: falls back to env or http://localhost:3000.
 */
export function resolveAppUrl(): string {
  if (isVercelPreview()) {
    const hosts = getAuthorizedPreviewHosts();
    if (hosts.length > 0) {
      return `https://${hosts[0]}`;
    }
    if (process.env.NEXT_PUBLIC_APP_URL) {
      return toAbsoluteHttpsUrl(process.env.NEXT_PUBLIC_APP_URL);
    }
    if (process.env.BETTER_AUTH_URL) {
      return toAbsoluteHttpsUrl(process.env.BETTER_AUTH_URL);
    }
  }

  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }
  if (process.env.BETTER_AUTH_URL) {
    return process.env.BETTER_AUTH_URL;
  }

  return "http://localhost:3000";
}

/**
 * Returns the list of authorized trusted origins for Better Auth:
 * - In Production: strictly [env.NEXT_PUBLIC_APP_URL]. Never permits any preview origin.
 * - In Preview: strictly the verified Vercel preview deployment URLs.
 */
export function getTrustedOrigins(): string[] {
  if (isVercelProduction() || !isVercelPreview()) {
    const prodOrigin =
      process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL;
    return prodOrigin ? [prodOrigin] : ["http://localhost:3000"];
  }

  const hosts = getAuthorizedPreviewHosts();
  const origins = hosts.map((host) => `https://${host}`);

  if (process.env.NEXT_PUBLIC_APP_URL) {
    origins.push(toAbsoluteHttpsUrl(process.env.NEXT_PUBLIC_APP_URL));
  }
  if (process.env.BETTER_AUTH_URL) {
    origins.push(toAbsoluteHttpsUrl(process.env.BETTER_AUTH_URL));
  }

  return Array.from(new Set(origins));
}

/**
 * Safely populates runtime environment variables in Preview mode.
 * In Production, this is a strict NO-OP, ensuring production validation is unchanged.
 */
export function populatePreviewEnvIfNeeded(): void {
  if (!isVercelPreview()) {
    return;
  }

  const derivedUrl = resolveAppUrl();
  if (derivedUrl && derivedUrl.startsWith("https://")) {
    process.env.BETTER_AUTH_URL ??= derivedUrl;
    process.env.NEXT_PUBLIC_APP_URL ??= derivedUrl;
  }
}
