/**
 * read_file：读取源码并附带行号 / 区块摘要 / 语言统计。
 *
 * 行号是刚需 —— 模型给出的审查意见必须能落到具体行，
 * 否则报告没有可操作性。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlayfulError } from '../core/errors';
import type { ToolContext, ToolResult, ToolSpec } from '../core/types';
import { detectLanguage, displayPath, readTextFileSafe, resolveInside } from './path-guard';
import { validateArgs } from './validate';

interface Args {
  path: string;
  startLine?: number;
  endLine?: number;
  maxLines?: number;
  withLineNumbers?: boolean;
}

export const readFileTool: ToolSpec<Args> = {
  name: 'read_file',
  description:
    '读取指定文件内容（带行号）。支持用 startLine/endLine 读取局部区域，适合大文件分段查看。' +
    '读取前请确保路径正确；不确定路径时先用 list_files。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区的文件路径，例如 src/index.ts' },
      startLine: { type: 'integer', description: '起始行号（从 1 开始，含），默认 1', default: 1, minimum: 1 },
      endLine: { type: 'integer', description: '结束行号（含），默认到文件末尾', minimum: 1 },
      maxLines: { type: 'integer', description: '单次最多返回行数，默认 400', default: 400, minimum: 1, maximum: 2000 },
      withLineNumbers: { type: 'boolean', description: '是否带行号前缀，默认 true', default: true },
    },
    required: ['path'],
  },
  run(args, ctx): ToolResult {
    const a = validateArgs<Args>('read_file', args, readFileTool.parameters);
    const abs = resolveInside(a.path, ctx);

    let info: { text: string; truncated: boolean; bytes: number; lines: number };
    try {
      info = readTextFileSafe(abs);
    } catch (e) {
      if (e instanceof PlayfulError && e.code === 'FS_ERROR' && e.message.includes('二进制')) {
        return { ok: false, tool: 'read_file', content: `${displayPath(abs, ctx.workdir)} 是二进制文件，已跳过。` };
      }
      throw e;
    }

    const allLines = info.text.split(/\r?\n/);
    const start = Math.max(1, a.startLine ?? 1);
    const hardEnd = Math.min(allLines.length, a.endLine ?? allLines.length);
    const maxLines = a.maxLines ?? 400;
    const end = Math.min(hardEnd, start + maxLines - 1);

    if (start > allLines.length) {
      throw new PlayfulError('TOOL_BAD_ARGS', `起始行 ${start} 超出文件总行数 ${info.lines}`, {
        hint: `该文件共 ${info.lines} 行，请把 startLine 调整到 1..${info.lines} 之间`,
      });
    }

    const wantNumbers = a.withLineNumbers ?? true;
    const pad = String(end).length;
    const slice = allLines.slice(start - 1, end);
    const body = slice
      .map((line, i) => {
        const no = start + i;
        return wantNumbers ? `${String(no).padStart(pad, ' ')} | ${line}` : line;
      })
      .join('\n');

    const rel = displayPath(abs, ctx.workdir);
    const lang = detectLanguage(rel);
    const notes: string[] = [];
    notes.push(
      `${rel}（共 ${info.lines} 行，${info.bytes} 字节，语言：${lang === 'unknown' ? path.extname(rel).slice(1) || '未知' : lang}）`,
    );
    if (start > 1 || end < allLines.length) notes.push(`本次展示第 ${start}-${end} 行`);
    if (info.truncated) notes.push('⚠️ 文件较大，仅读取了前 512KB');

    return {
      ok: true,
      tool: 'read_file',
      content: `${notes.join('；')}\n\`\`\`${path.extname(rel).slice(1)}\n${body}\n\`\`\``,
      meta: { path: rel, totalLines: info.lines, shownFrom: start, shownTo: end },
    };
  },
};

export default readFileTool;
