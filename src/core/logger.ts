/**
 * 极简日志器。
 *
 * - 支持 debug/info/warn/error 四级；
 * - 支持把全部日志旁路写入 trace 文件（用于事后复盘 Agent 轨迹）；
 * - 不引入 chalk：颜色用裸 ANSI 码，且自动识别非 TTY 环境降级为无色。
 */

import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const COLOR = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
} as const;

export type ColorName = keyof Omit<typeof COLOR, 'reset'>;

let currentLevel: LogLevel = 'info';
let colorEnabled = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
let traceStream: fs.WriteStream | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
}

export function paint(text: string, color: ColorName, bold = false): string {
  if (!colorEnabled) return text;
  return `${bold ? '\u001b[1m' : ''}${COLOR[color]}${text}${COLOR.reset}`;
}

/** 打开轨迹日志文件（追加模式）。目录不存在时自动创建。 */
export function openTrace(file: string): void {
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  traceStream = fs.createWriteStream(abs, { flags: 'a' });
}

export function closeTrace(): void {
  traceStream?.end();
  traceStream = null;
}

function write(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[currentLevel]) return;

  const stamp = new Date().toISOString().slice(11, 23);
  const levelTag =
    level === 'error'
      ? paint('ERROR', 'red', true)
      : level === 'warn'
        ? paint('WARN ', 'yellow', true)
        : level === 'debug'
          ? paint('DEBUG', 'dim')
          : paint('INFO ', 'green');

  const line = `${paint(stamp, 'dim')} ${levelTag} ${paint(`[${scope}]`, 'cyan')} ${msg}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);

  if (traceStream) {
    const payload = extra === undefined ? '' : ` ${safeJson(extra)}`;
    traceStream.write(`${new Date().toISOString()} ${level} [${scope}] ${msg}${payload}\n`);
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return '[unserializable]';
  }
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}
