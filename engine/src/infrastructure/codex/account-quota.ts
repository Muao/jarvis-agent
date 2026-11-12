import { CodexQuotaWindowSchema, type CodexQuotaWindow } from '@jarvis/shared';
import { connectCodexAppServer } from './app-server-connection.js';
import { encodeCodexMessage } from './app-server-protocol.js';

interface RateLimitWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RateLimits {
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
}

export function codexAccountQuota(
  binary: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  let cached: { expires: number; result: Promise<CodexQuotaWindow[]> } | undefined;
  return () => {
    const now = Date.now();
    if (cached && cached.expires > now) return cached.result;
    const result = readQuota(binary, options).catch(() => []);
    cached = { expires: now + 60_000, result };
    return result;
  };
}

async function readQuota(
  binary: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CodexQuotaWindow[]> {
  const { process, lines } = await connectCodexAppServer(binary, {
    ...options,
    signal: AbortSignal.timeout(8000),
  });
  try {
    process.stdin.write(encodeCodexMessage({ id: 2, method: 'account/rateLimits/read' }));
    for await (const line of lines) {
      const response = JSON.parse(line) as {
        id?: number;
        result?: { rateLimits?: RateLimits; rateLimitsByLimitId?: { codex?: RateLimits } };
      } | null;
      if (response?.id !== 2) continue;
      const limits = response.result?.rateLimitsByLimitId?.codex ?? response.result?.rateLimits;
      return [limits?.primary, limits?.secondary].flatMap((window) => {
        if (!window) return [];
        const seconds = window.resetsAt;
        const reset = typeof seconds === 'number' ? new Date(seconds * 1000) : null;
        const parsed = CodexQuotaWindowSchema.safeParse({
          usedPercent: window.usedPercent,
          windowMinutes: window.windowDurationMins ?? null,
          resetsAt: reset && Number.isFinite(reset.getTime()) ? reset.toISOString() : null,
        });
        return parsed.success ? [parsed.data] : [];
      });
    }
    return [];
  } finally {
    process.stdin.end();
  }
}
