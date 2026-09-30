/**
 * HTTP 传输层。
 *
 * 只有一件事：把「一次可能失败的 HTTP JSON 请求」变成「带超时、带指数退避重试、
 * 带 429 感知的成功或明确失败」。
 *
 * 不依赖 axios / node-fetch，使用 Node 18+ 内置 fetch 与 AbortController。
 */

import { PlayfulError, normalizeError } from '../core/errors';
import { createLogger } from '../core/logger';

const log = createLogger('http');

export class HttpError extends PlayfulError {
  readonly status: number;
  readonly bodyText: string;
  constructor(status: number, bodyText: string, retryable: boolean, hint?: string) {
    super('LLM_HTTP_ERROR', `HTTP ${status}：${shorten(bodyText)}`, { retryable, hint });
    this.name = 'HttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

function shorten(s: string, max = 600): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export interface HttpJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  /** 重试前回调，便于把「正在重试」推给 UI */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

/** 合并「用户中断」与「超时」两个信号。 */
function mergeSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
    timedOut: () => timedOut,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PlayfulError('ABORTED', '操作被中断'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new PlayfulError('ABORTED', '操作被中断'));
      },
      { once: true },
    );
  });
}

/** 从 429 响应头里读出建议等待时间（秒 → 毫秒）。 */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 30_000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
  return undefined;
}

/**
 * 发起 JSON 请求并在可重试错误上自动退避重试。
 * 全部尝试失败后抛出最后一个 PlayfulError。
 */
export async function httpJson<T = unknown>(url: string, opts: HttpJsonOptions): Promise<T> {
  const attempts = Math.max(1, opts.retries);
  let lastError: PlayfulError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const merged = mergeSignals(opts.timeoutMs, opts.signal);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(opts.headers ?? {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: merged.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        const wait = retryAfterMs(res);
        const hint =
          res.status === 401 || res.status === 403
            ? 'API Key 无效或无权限，请检查 PC_API_KEY / DEEPSEEK_API_KEY 等环境变量'
            : res.status === 404
              ? '接口或模型不存在，请检查 PC_BASE_URL 与 PC_MODEL'
              : res.status === 400
                ? '请求被服务端拒绝，常见原因：模型不支持 function calling、参数越界'
                : res.status === 429
                  ? '触发限流，已自动退避重试；若持续失败请降低并发或升级配额'
                  : undefined;
        const err = new HttpError(res.status, text, retryable, hint);
        lastError = err;

        if (!retryable || attempt === attempts) throw err;

        const delay = wait ?? Math.min(500 * 2 ** (attempt - 1), 8_000);
        log.warn(`HTTP ${res.status}，第 ${attempt}/${attempts} 次尝试失败，${delay}ms 后重试`);
        opts.onRetry?.(attempt, delay, `HTTP ${res.status}`);
        await sleep(delay, opts.signal);
        continue;
      }

      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        throw new PlayfulError('LLM_PROTOCOL_ERROR', `服务端返回的不是合法 JSON：${shorten(text, 200)}`, {
          cause: e,
        });
      }
    } catch (e) {
      const err = normalizeError(e);

      if (err.code === 'ABORTED') {
        // 区分「用户主动取消」与「超时被动取消」
        throw merged.timedOut()
          ? new PlayfulError('LLM_TIMEOUT', `请求超过 ${opts.timeoutMs}ms 未完成`, {
              retryable: true,
              hint: '可调大 PC_REQUEST_TIMEOUT_MS，或换用更快的模型',
            })
          : err;
      }

      if (!err.retryable || attempt === attempts) throw err;

      lastError = err;
      const delay = Math.min(500 * 2 ** (attempt - 1), 8_000);
      log.warn(`网络异常（${err.message}），第 ${attempt}/${attempts} 次尝试失败，${delay}ms 后重试`);
      opts.onRetry?.(attempt, delay, err.message);
      await sleep(delay, opts.signal);
    } finally {
      merged.cleanup();
    }
  }

  throw lastError ?? new PlayfulError('UNKNOWN', '请求失败且无可用错误信息');
}
