/**
 * 演示用「干净代码」——作为对照组。
 *
 * 这个文件刻意写成规范风格：参数校验完整、异常有上下文、
 * 类型明确、边界处理显式。静态分析引擎对它应当零命中（除规则明确允许的项）。
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带指数退避的重试执行器。 */
export async function withRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts 必须是 >= 1 的整数，实际收到 ${String(maxAttempts)}`);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;

      const waitMs = Math.min(baseDelayMs * 2 ** (attempt - 1), MAX_DELAY_MS);
      options.onRetry?.(attempt, waitMs, error instanceof Error ? error.message : String(error));
      await delay(waitMs);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`重试 ${maxAttempts} 次后仍然失败：${reason}`, { cause: lastError });
}

/** 安全地解析 JSON：失败时返回明确的空值，而不是抛错或返回 undefined。 */
export function parseJsonSafe<T>(text: string, fallback: T): T {
  if (typeof text !== 'string' || text.trim() === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** 把任意输入归一为非负整数，越界时收敛到边界值。 */
export function toBoundedInt(input: unknown, min: number, max: number, fallback: number): number {
  const value = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(value)) return fallback;
  const truncated = Math.trunc(value);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}
