/**
 * write_file：写入 / 覆盖文件。
 *
 * 危险工具，默认需要人工审批（PC_REQUIRE_APPROVAL）。
 * 支持 dryRun 先看 diff —— 让模型「先展示改动意图，再落地」，
 * 这是把不可逆操作变成可审计操作的最低成本手段。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlayfulError } from '../core/errors';
import type { ToolResult, ToolSpec } from '../core/types';
import { displayPath, resolveInside } from './path-guard';
import { validateArgs } from './validate';

interface Args {
  path: string;
  content: string;
  dryRun?: boolean;
  createDirs?: boolean;
  backup?: boolean;
}

/** 生成极简 unified-diff 风格预览。 */
export function previewDiff(oldText: string, newText: string, file: string, maxLines = 60): string {
  if (oldText === newText) return `（内容无变化）`;
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText.split('\n');
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];

  // 定位公共前缀 / 后缀，中间部分整体展示为替换块
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1;
  }

  out.push(`@@ 第 ${head + 1} 行起 @@`);
  for (let i = Math.max(0, head - 2); i < head; i += 1) out.push(`  ${oldLines[i] ?? ''}`);
  const removed = oldLines.slice(head, oldLines.length - tail);
  const added = newLines.slice(head, newLines.length - tail);
  for (const l of removed.slice(0, maxLines)) out.push(`- ${l}`);
  if (removed.length > maxLines) out.push(`- …（还有 ${removed.length - maxLines} 行被删除）`);
  for (const l of added.slice(0, maxLines)) out.push(`+ ${l}`);
  if (added.length > maxLines) out.push(`+ …（还有 ${added.length - maxLines} 行被新增）`);
  for (let i = oldLines.length - tail; i < Math.min(oldLines.length, oldLines.length - tail + 2); i += 1) {
    out.push(`  ${oldLines[i] ?? ''}`);
  }
  return out.join('\n');
}

export const writeFileTool: ToolSpec<Args> = {
  name: 'write_file',
  description:
    '写入文件内容（覆盖写）。属于危险操作，需要用户审批。' +
    '建议先设置 dryRun=true 查看 diff 预览，确认后再真正写入。默认会为被覆盖的文件生成 .bak 备份。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对工作区的目标文件路径' },
      content: { type: 'string', description: '要写入的完整文件内容' },
      dryRun: { type: 'boolean', description: '仅预览改动，不真正写盘，默认 false', default: false },
      createDirs: { type: 'boolean', description: '目标目录不存在时是否自动创建，默认 true', default: true },
      backup: { type: 'boolean', description: '覆盖已有文件前是否备份为 .bak，默认 true', default: true },
    },
    required: ['path', 'content'],
  },
  run(args, ctx): ToolResult {
    const a = validateArgs<Args>('write_file', args, writeFileTool.parameters);
    const abs = resolveInside(a.path, ctx);
    const rel = displayPath(abs, ctx.workdir);

    const exists = fs.existsSync(abs);
    if (exists && fs.statSync(abs).isDirectory()) {
      throw new PlayfulError('FS_ERROR', `${rel} 是一个目录，无法写入`, { hint: '请指定具体文件路径' });
    }

    const oldText = exists ? fs.readFileSync(abs, 'utf8') : '';
    const diff = previewDiff(oldText, a.content, rel);

    if (a.dryRun) {
      return {
        ok: true,
        tool: 'write_file',
        content: `【dryRun 预览，未写盘】目标：${rel}（${a.content.split('\n').length} 行，${Buffer.byteLength(a.content, 'utf8')} 字节）\n\`\`\`diff\n${diff}\n\`\`\``,
        meta: { path: rel, dryRun: true, existed: exists },
      };
    }

    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      if (a.createDirs === false) {
        throw new PlayfulError('FS_ERROR', `目录不存在：${displayPath(dir, ctx.workdir)}`, {
          hint: '设置 createDirs=true 可自动创建目录',
        });
      }
      fs.mkdirSync(dir, { recursive: true });
    }

    let backupPath: string | undefined;
    if (exists && (a.backup ?? true)) {
      backupPath = `${abs}.bak`;
      fs.copyFileSync(abs, backupPath);
    }

    fs.writeFileSync(abs, a.content, 'utf8');
    const bytes = Buffer.byteLength(a.content, 'utf8');

    return {
      ok: true,
      tool: 'write_file',
      content:
        `已写入 ${rel}（${a.content.split('\n').length} 行，${bytes} 字节）` +
        (backupPath ? `\n原文件已备份到 ${displayPath(backupPath, ctx.workdir)}` : '') +
        `\n\`\`\`diff\n${diff}\n\`\`\``,
      meta: { path: rel, bytes, backup: backupPath ? displayPath(backupPath, ctx.workdir) : undefined },
    };
  },
};

export default writeFileTool;
