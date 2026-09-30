/**
 * 路径安全守卫。
 *
 * 工具层唯一允许触碰文件系统的入口。所有文件操作都必须先过这里，
 * 目的是让「Agent 只能在自己被授权的目录里动手」成为结构性保证，
 * 而不是靠 Prompt 里写一句「请不要乱改文件」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlayfulError } from '../core/errors';

/** 默认跳过的目录：体积大且与代码审查无关。 */
const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'out-tsc',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  'target',
  'vendor',
  '.playfulcode',
]);

/** 默认跳过的文件：体积大或含机密。 */
const DEFAULT_IGNORE_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'composer.lock',
  'poetry.lock',
]);

const SENSITIVE_PATTERNS = [/^\.env(\..+)?$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /id_rsa/i, /credentials\.json$/i];

export function shouldIgnoreDir(name: string): boolean {
  return DEFAULT_IGNORE_DIRS.has(name);
}

export function shouldIgnoreFile(name: string): boolean {
  return DEFAULT_IGNORE_FILES.has(name);
}

export function isSensitiveFile(name: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(name));
}

/** 判断 child 是否位于 parent 之内（含自身）。 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把用户/模型给的路径解析为安全的绝对路径。
 * @throws PlayfulError PATH_OUT_OF_SCOPE 当路径越出白名单
 */
export function resolveInside(input: string, ctx: { workdir: string; roots: string[] }): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new PlayfulError('TOOL_BAD_ARGS', '路径参数为空', { hint: '请提供相对于工作区的文件路径' });
  }
  const raw = input.trim().replace(/^["']|["']$/g, '');
  const abs = path.resolve(ctx.workdir, raw);

  if (ctx.roots.length === 0) return abs;

  const allowed = ctx.roots.some((root) => isInside(path.resolve(root), abs));
  if (!allowed) {
    throw new PlayfulError('PATH_OUT_OF_SCOPE', `路径越出授权范围：${abs}`, {
      hint: `当前允许的根目录：${ctx.roots.join('，')}。可用 PC_WORKSPACE_ROOTS 调整授权范围。`,
    });
  }
  return abs;
}

/** 相对工作区的可读路径（用于渲染与去重）。 */
export function displayPath(abs: string, workdir: string): string {
  const rel = path.relative(workdir, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return abs.split(path.sep).join('/');
}

/** 统计逻辑行数（忽略文件末尾多余的空行）。 */
export function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  return lines.length;
}

/** 读取文本文件；自动识别二进制与超大文件，给出可读失败原因。 */
export function readTextFileSafe(abs: string, maxBytes = 512 * 1024): { text: string; truncated: boolean; bytes: number; lines: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new PlayfulError('FS_ERROR', `文件不存在或不可访问：${abs}`, { hint: '先用 list_files 确认路径' });
  }
  if (stat.isDirectory()) {
    throw new PlayfulError('FS_ERROR', `${abs} 是目录而不是文件`, { hint: '目录请用 list_files 查看' });
  }

  const fd = fs.openSync(abs, 'r');
  try {
    const size = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, 0);

    if (buf.includes(0)) {
      throw new PlayfulError('FS_ERROR', `疑似二进制文件，已跳过：${abs}`, { hint: '本工具只审查文本源码' });
    }
    const text = buf.toString('utf8');
    return { text, truncated: stat.size > maxBytes, bytes: stat.size, lines: countLines(text) };
  } finally {
    fs.closeSync(fd);
  }
}

export interface WalkOptions {
  maxFiles?: number;
  maxDepth?: number;
  followSymlinks?: boolean;
}

/** 递归收集目录下的文本源码文件。 */
export function walkSourceFiles(root: string, opts: WalkOptions = {}): string[] {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxDepth = opts.maxDepth ?? 12;
  const results: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];

  while (stack.length > 0 && results.length < maxFiles) {
    const item = stack.pop();
    if (!item) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(item.dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldIgnoreDir(entry.name) || item.depth >= maxDepth) continue;
        stack.push({ dir: full, depth: item.depth + 1 });
      } else if (entry.isFile()) {
        if (shouldIgnoreFile(entry.name)) continue;
        if (!isSourceLike(entry.name)) continue;
        results.push(full);
        if (results.length >= maxFiles) break;
      }
    }
  }
  return results.sort();
}

const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.cs', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.m', '.mm', '.scala', '.lua',
  '.sh', '.bash', '.zsh', '.ps1', '.sql', '.vue', '.svelte', '.dart', '.ex', '.exs',
]);

export function isSourceLike(filename: string): boolean {
  return SOURCE_EXT.has(path.extname(filename).toLowerCase());
}

/** 按语言猜测可执行方式（run_code 用）。 */
export function detectLanguage(filename: string): 'js' | 'ts' | 'py' | 'unknown' {
  const ext = path.extname(filename).toLowerCase();
  if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) return 'js';
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) return 'ts';
  if (['.py', '.pyw'].includes(ext)) return 'py';
  return 'unknown';
}
