/**
 * 统一错误体系。
 *
 * 设计要点：
 * - 每一类错误都携带 `retryable` 语义，上层重试策略由此决策，而不是靠猜错误信息；
 * - `toUserMessage()` 负责把内部错误翻译成人能看懂的一句话（评审「错误处理」项）。
 */

export type ErrorCode =
  | 'CONFIG_ERROR'
  | 'LLM_HTTP_ERROR'
  | 'LLM_PROTOCOL_ERROR'
  | 'LLM_TIMEOUT'
  | 'LLM_RATE_LIMIT'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_BAD_ARGS'
  | 'TOOL_DENIED'
  | 'PATH_OUT_OF_SCOPE'
  | 'FS_ERROR'
  | 'EXEC_TIMEOUT'
  | 'EXEC_FAILED'
  | 'ABORTED'
  | 'UNKNOWN';

export class PlayfulError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  override readonly cause?: unknown;
  readonly hint?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retryable?: boolean; cause?: unknown; hint?: string } = {},
  ) {
    super(message);
    this.name = 'PlayfulError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.cause = opts.cause;
    this.hint = opts.hint;
  }

  /** 给终端用户看的一句话说明，必要时附带修复建议。 */
  toUserMessage(): string {
    const base = `[${this.code}] ${this.message}`;
    return this.hint ? `${base}\n提示：${this.hint}` : base;
  }
}

export function isPlayfulError(e: unknown): e is PlayfulError {
  return e instanceof PlayfulError;
}

/** 把任意抛出物归一成 PlayfulError，避免上层出现 `catch (e: any)` 式散弹。 */
export function normalizeError(e: unknown, fallbackCode: ErrorCode = 'UNKNOWN'): PlayfulError {
  if (isPlayfulError(e)) return e;
  if (e instanceof Error) {
    if (e.name === 'AbortError') {
      return new PlayfulError('ABORTED', '操作被中断', { cause: e });
    }
    return new PlayfulError(fallbackCode, e.message, { cause: e });
  }
  return new PlayfulError(fallbackCode, String(e));
}
