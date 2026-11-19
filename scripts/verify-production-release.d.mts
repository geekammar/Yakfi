export const ALLOWED_DEPLOYMENT_TARGETS: readonly ["render", "vercel"];

export type ReleaseTargetInput = {
  deploymentTarget?: string;
  productionBaseUrl?: string;
  expectedCommitSha?: string;
  checkedOutCommitSha?: string;
  expectedVersion?: string;
};

export type ValidatedReleaseTarget =
  | {
      ok: true;
      deploymentTarget: "render" | "vercel";
      origin: string;
      healthUrl: string;
      expectedCommitSha: string;
      expectedVersion: string;
    }
  | {
      ok: false;
      code: string;
    };

export function validateReleaseTargetInputs(
  input: ReleaseTargetInput,
): ValidatedReleaseTarget;

export function evaluateLiveHealthResponse(params: {
  httpStatus: number;
  body: Record<string, unknown> | null;
  expectedVersion: string;
  expectedCommitSha: string;
}):
  | {
      ok: true;
      version: string;
      commitSha: string;
      database: string;
    }
  | {
      ok: false;
      code: string;
    };

export function pollProductionReleaseReadiness(
  input: ReleaseTargetInput,
  deps?: {
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
    maxAttempts?: number;
    pollIntervalMs?: number;
    timeoutMs?: number;
  },
): Promise<
  | {
      ok: true;
      deploymentTarget: "render" | "vercel";
      origin: string;
      healthUrl: string;
      version: string;
      commitSha: string;
    }
  | {
      ok: false;
      code: string;
    }
>;
