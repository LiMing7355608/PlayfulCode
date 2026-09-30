/**
 * 命令行参数解析。
 *
 * 支持 `--key=value`、`--key value`、`-k value`、布尔开关 `--verbose`，
 * 以及 `--` 之后的自由参数（用于 run_code 的 argv 透传）。
 */

import fs from 'node:fs';

export interface ParsedArgs {
  command: string;
  /** 位置参数 */
  positional: string[];
  /** 选项表（短横线已剥离，统一小写） */
  flags: Record<string, string | boolean>;
  /** `--` 之后的原始参数 */
  passthrough: string[];
}

const BOOLEAN_FLAGS = new Set([
  'verbose',
  'v',
  'help',
  'h',
  'version',
  'V',
  'no-color',
  'json',
  'fix-preview',
  'no-approval',
  'dry-run',
  'stream',
  'rules',
  'list-rules',
  'tools',
  'offline',
  'demo',
]);

export function parseArgv(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { command: '', positional: [], flags: {} as Record<string, string | boolean>, passthrough: [] };

  let i = 0;
  // 第一个非选项参数即命令名
  while (i < argv.length && argv[i]?.startsWith('-')) {
    i = consume(argv, i, result);
  }
  if (i < argv.length) {
    result.command = argv[i] ?? '';
    i += 1;
  }

  while (i < argv.length) {
    const cur = argv[i];
    if (cur === '--') {
      result.passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (cur && cur.startsWith('-')) {
      i = consume(argv, i, result);
      continue;
    }
    result.positional.push(cur ?? '');
    i += 1;
  }

  return result;
}

function consume(argv: string[], i: number, out: ParsedArgs): number {
  const raw = argv[i] ?? '';
  const stripped = raw.replace(/^--?/, '');

  // 支持 `--key=value`
  if (stripped.includes('=')) {
    const eq = stripped.indexOf('=');
    const key = normalizeKey(stripped.slice(0, eq));
    out.flags[key] = stripped.slice(eq + 1);
    return i + 1;
  }

  const key = normalizeKey(stripped);
  const next = argv[i + 1];

  if (BOOLEAN_FLAGS.has(stripped) || BOOLEAN_FLAGS.has(key)) {
    // 允许 --verbose=false / --verbose true 两种显式写法
    if (next === 'true' || next === 'false') {
      out.flags[key] = next === 'true';
      return i + 2;
    }
    out.flags[key] = true;
    return i + 1;
  }

  if (next !== undefined && !next.startsWith('--')) {
    out.flags[key] = next;
    return i + 2;
  }

  out.flags[key] = true;
  return i + 1;
}

function normalizeKey(key: string): string {
  const map: Record<string, string> = { v: 'verbose', h: 'help', V: 'version' };
  return map[key] ?? key;
}

export function flagString(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(flags: Record<string, string | boolean>, key: string): boolean {
  const v = flags[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
  return false;
}

export function flagNumber(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flags[key];
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 解析 `tool` 子命令的参数。
 *
 * 支持三种写法（都是为了绕开 shell 的引号地狱）：
 *   1. 标准 JSON： {"path":"src/app.ts","maxLines":50}
 *   2. 从文件读取：@args.json
 *   3. 键值简写：  path=src/app.ts maxLines=50 ok=true
 */
export function parseToolArgs(raw: string, keyValues: string[]): { args: Record<string, unknown>; error?: string } {
  const text = (raw ?? '').trim();

  if (text.startsWith('@')) {
    const file = text.slice(1).trim();
    try {
      // 剥离 UTF-8 BOM —— Windows 上（PowerShell Out-File 等）导出的 JSON 常带 BOM
      const content = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      const parsed: unknown = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown> };
      return { args: {}, error: `参数文件内容必须是 JSON 对象：${file}` };
    } catch (e) {
      return { args: {}, error: `读取参数文件失败：${(e as Error).message}` };
    }
  }

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { args: parsed as Record<string, unknown> };
      return { args: {}, error: '参数必须是 JSON 对象' };
    } catch (e) {
      return { args: {}, error: `参数不是合法 JSON：${(e as Error).message}` };
    }
  }

  // 键值简写模式：path=src/app.ts maxLines=50 tags=a,b
  const args: Record<string, unknown> = {};
  const pairs = [...(text ? [text] : []), ...keyValues];
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return { args: {}, error: `无法解析参数片段 "${pair}"，请使用 key=value 或 JSON` };
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (value === 'true') args[key] = true;
    else if (value === 'false') args[key] = false;
    else if (/^-?\d+$/.test(value)) args[key] = Number(value);
    else args[key] = value;
  }
  return { args };
}
