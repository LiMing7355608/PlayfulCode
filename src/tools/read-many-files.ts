/**
 * read_many_files：批量读取多个文件（带总量熔断）。
 *
 * 审查一个模块时，逐个 read_file 会浪费大量往返轮次。
 * 本工具允许一次性把一组相关文件读进上下文，但对总量做硬限制，防止上下文爆炸。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlayfulError } from '../core/errors';
import type { ToolResult, ToolSpec } from '../core/types';
import { displayPath, readTextFileSafe, resolveInside } from './path-guard';
import { validateArgs } from './validate';

interface Args {
  paths: string[];
  maxTotalChars?: number;
  perFileLines?: number;
}

export const readManyFilesTool: ToolSpec<Args> = {
  name: 'read_many_files',
  description:
    '一次性读取多个文件（适合审查一个模块的全部相关文件）。' +
    '有总量上限保护：达到 maxTotalChars 后剩余文件只列出摘要而不展开内容。',
  parameters: {
    type: 'object',
    properties: {
      paths: { type: 'array', description: '文件路径列表（相对工作区）', items: { type: 'string' } },
      maxTotalChars: { type: 'integer', description: '所有文件内容总字符上限，默认 40000', default: 40000, minimum: 1000, maximum: 200000 },
      perFileLines: { type: 'integer', description: '每个文件最多展示的行数，默认 200', default: 200, minimum: 10, maximum: 2000 },
    },
    required: ['paths'],
  },
  run(args, ctx): ToolResult {
    const a = validateArgs<Args>('read_many_files', args, readManyFilesTool.parameters);
    const list = a.paths ?? [];
    if (list.length === 0) throw new PlayfulError('TOOL_BAD_ARGS', 'paths 不能为空');
    if (list.length > 50) throw new PlayfulError('TOOL_BAD_ARGS', `一次最多读取 50 个文件，当前 ${list.length} 个`);

    const maxTotal = a.maxTotalChars ?? 40_000;
    const perFileLines = a.perFileLines ?? 200;

    const blocks: string[] = [];
    const summaries: string[] = [];
    const errors: string[] = [];
    let used = 0;

    for (const p of list) {
      let abs: string;
      try {
        abs = resolveInside(p, ctx);
      } catch (e) {
        errors.push(`✗ ${p}：${(e as Error).message}`);
        continue;
      }
      const rel = displayPath(abs, ctx.workdir);

      let info: { text: string; truncated: boolean; bytes: number };
      try {
        info = readTextFileSafe(abs);
      } catch (e) {
        errors.push(`✗ ${rel}：${(e as PlayfulError).message}`);
        continue;
      }

      const lines = info.text.split(/\r?\n/);
      const remaining = maxTotal - used;

      if (remaining < 400) {
        summaries.push(`· ${rel}（${lines.length} 行 / ${info.bytes} 字节）— 已达总量上限，未展开内容`);
        continue;
      }

      const take = Math.min(lines.length, perFileLines);
      const body = lines.slice(0, take).join('\n');
      const block = `### ${rel}（共 ${lines.length} 行${take < lines.length ? `，仅展示前 ${take} 行` : ''}）\n\`\`\`\n${body}\n\`\`\``;
      used += block.length;
      blocks.push(block);
      if (take < lines.length) summaries.push(`· ${rel} 还有 ${lines.length - take} 行未展示，可用 read_file 指定 startLine 继续读取`);
    }

    const header = `已读取 ${blocks.length}/${list.length} 个文件，累计约 ${used} 字符`;
    const parts = [header];
    if (blocks.length > 0) parts.push(blocks.join('\n\n'));
    if (summaries.length > 0) parts.push(`### 说明\n${summaries.join('\n')}`);
    if (errors.length > 0) parts.push(`### 读取失败\n${errors.join('\n')}`);

    return {
      ok: errors.length < list.length,
      tool: 'read_many_files',
      content: parts.join('\n\n'),
      meta: { requested: list.length, loaded: blocks.length, chars: used },
    };
  },
};

export default readManyFilesTool;
