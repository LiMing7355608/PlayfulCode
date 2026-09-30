/**
 * list_files：列目录 / 统计工程结构。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlayfulError } from '../core/errors';
import type { ToolContext, ToolResult, ToolSpec } from '../core/types';
import {
  displayPath,
  isSensitiveFile,
  readTextFileSafe,
  resolveInside,
  shouldIgnoreDir,
  shouldIgnoreFile,
  walkSourceFiles,
} from './path-guard';
import { validateArgs } from './validate';

interface Args {
  path?: string;
  maxDepth?: number;
  maxEntries?: number;
  extensions?: string[];
  includeSizes?: boolean;
}

/** 目录树渲染（限定深度与条目数，避免刷屏）。 */
function tree(root: string, ctx: ToolContext, maxDepth: number, maxEntries: number, wantExt: Set<string>, sizes: boolean): string[] {
  const lines: string[] = [];
  let count = 0;

  const walk = (dir: string, prefix: string, depth: number): void => {
    if (count >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    } catch {
      return;
    }
    const visible = entries.filter((e) => {
      if (e.isDirectory()) return !shouldIgnoreDir(e.name);
      return !shouldIgnoreFile(e.name) && !isSensitiveFile(e.name);
    });

    visible.forEach((entry, idx) => {
      if (count >= maxEntries) return;
      const last = idx === visible.length - 1;
      const branch = last ? '└── ' : '├── ';
      const full = path.join(dir, entry.name);
      const rel = displayPath(full, ctx.workdir);

      if (entry.isDirectory()) {
        lines.push(`${prefix}${branch}${entry.name}/`);
        count += 1;
        if (depth < maxDepth) walk(full, `${prefix}${last ? '    ' : '│   '}`, depth + 1);
        else if (count < maxEntries) lines.push(`${prefix}${last ? '    ' : '│   '}└── …（已达深度上限）`);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (wantExt.size > 0 && !wantExt.has(ext)) return;
        let suffix = '';
        if (sizes) {
          try {
            suffix = `  (${fs.statSync(full).size}B)`;
          } catch {
            suffix = '';
          }
        }
        lines.push(`${prefix}${branch}${entry.name}${suffix}  → ${rel}`);
        count += 1;
      }
    });
  };

  walk(root, '', 0);
  if (count >= maxEntries) lines.push(`…（已截断，最多展示 ${maxEntries} 条）`);
  return lines;
}

export const listFilesTool: ToolSpec<Args> = {
  name: 'list_files',
  description:
    '列出目录结构，用于建立对工程的宏观认识。自动跳过 node_modules/.git/dist 等噪声目录，' +
    '并屏蔽 .env、私钥等敏感文件。修改或读取任何文件之前，建议先用本工具确认路径。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区的目录路径，默认 "."（当前工作区根目录）', default: '.' },
      maxDepth: { type: 'integer', description: '最大递归深度，默认 3', default: 3, minimum: 1, maximum: 10 },
      maxEntries: { type: 'integer', description: '最多返回条目数，默认 200', default: 200, minimum: 1, maximum: 2000 },
      extensions: {
        type: 'array',
        description: '只显示这些后缀名的文件，例如 [".ts", ".js"]；留空表示全部',
        items: { type: 'string' },
      },
      includeSizes: { type: 'boolean', description: '是否显示文件字节数，默认 false', default: false },
    },
  },
  run(args, ctx): ToolResult {
    const a = validateArgs<Args>('list_files', args, listFilesTool.parameters);
    const target = resolveInside(a.path ?? '.', ctx);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new PlayfulError('FS_ERROR', `目录不存在：${displayPath(target, ctx.workdir)}`, {
        hint: '可用 list_files 从工作区根目录开始逐层确认',
      });
    }
    if (!stat.isDirectory()) {
      const info = readTextFileSafe(target);
      return {
        ok: true,
        tool: 'list_files',
        content: `${displayPath(target, ctx.workdir)} 是文件：${info.bytes} 字节，${info.text.split('\n').length} 行。请改用 read_file 读取内容。`,
      };
    }

    const wantExt = new Set((a.extensions ?? []).map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));
    const header = `目录 ${displayPath(target, ctx.workdir)}/`;
    const body = tree(target, ctx, a.maxDepth ?? 3, a.maxEntries ?? 200, wantExt, a.includeSizes ?? false);

    let summary = '';
    try {
      const files = walkSourceFiles(target, { maxFiles: 5000 });
      summary = `\n共发现 ${files.length} 个源码文件（已忽略构建产物与依赖目录）`;
    } catch {
      summary = '';
    }

    return {
      ok: true,
      tool: 'list_files',
      content: [header, ...body].join('\n') + summary,
      meta: { entries: body.length, path: displayPath(target, ctx.workdir) },
    };
  },
};

export default listFilesTool;
