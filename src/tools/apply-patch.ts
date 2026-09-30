/**
 * apply_patch：基于「精确替换」的原子化改码。
 *
 * 相比整个文件重写，替换式补丁有两个好处：
 * 1. 模型只需给出被改动的那几行，token 消耗低、出错面小；
 * 2. 可以校验 oldText 是否真的存在 —— 不存在就拒绝执行，
 *    避免把错误补丁写到文件里（宁可失败，不可写坏）。
 *
 * 支持一次提交多个补丁，全部校验通过后才落盘，任一失败则整体回滚。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlayfulError } from '../core/errors';
import type { ToolResult, ToolSpec } from '../core/types';
import { displayPath, resolveInside } from './path-guard';
import { validateArgs } from './validate';

interface Patch {
  file: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

interface Args {
  patches: Patch[];
  dryRun?: boolean;
  backup?: boolean;
  fuzzy?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** 宽松匹配：忽略行首缩进差异后定位。返回替换后的文本，或 null。 */
function fuzzyReplace(source: string, oldText: string, newText: string): string | null {
  const srcLines = source.split('\n');
  const oldLines = oldText.split('\n').map((l) => l.trim());
  const newLines = newText.split('\n');

  for (let i = 0; i + oldLines.length <= srcLines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < oldLines.length; k += 1) {
      if ((srcLines[i + k] ?? '').trim() !== oldLines[k]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const indent = ((srcLines[i] ?? '').match(/^\s*/) ?? [''])[0];
    const indented = newLines.map((l) => (l.trim() === '' ? l : indent + l.replace(/^\s+/, '')));
    return [...srcLines.slice(0, i), ...indented, ...srcLines.slice(i + oldLines.length)].join('\n');
  }
  return null;
}

export const applyPatchTool: ToolSpec<Args> = {
  name: 'apply_patch',
  description:
    '对已有文件做精确替换式修改。每个补丁包含 file、oldText（必须与原文逐字符一致）、newText。' +
    '修改前务必先用 read_file 读取原文；一次调用会原子提交所有补丁，任何一处不匹配就整体拒绝，' +
    '从而避免把半截修改写进代码库。',
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      patches: {
        type: 'array',
        description: '补丁列表，按顺序应用',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string', description: '目标文件相对路径' },
            oldText: { type: 'string', description: '被替换的原始文本（需与文件内容完全一致）' },
            newText: { type: 'string', description: '替换后的新文本' },
            replaceAll: { type: 'boolean', description: '是否替换所有出现处，默认 false（要求唯一匹配）', default: false },
          },
          required: ['file', 'oldText', 'newText'],
        },
      },
      dryRun: { type: 'boolean', description: '仅校验并预览，不写盘，默认 false', default: false },
      backup: { type: 'boolean', description: '写盘前是否备份原文件为 .bak，默认 true', default: true },
      fuzzy: { type: 'boolean', description: 'oldText 精确匹配失败时是否尝试忽略缩进的宽松匹配，默认 false', default: false },
    },
    required: ['patches'],
  },
  run(args, ctx): ToolResult {
    const a = validateArgs<Args>('apply_patch', args, applyPatchTool.parameters);
    const patches = a.patches;
    if (!Array.isArray(patches) || patches.length === 0) {
      throw new PlayfulError('TOOL_BAD_ARGS', 'patches 不能为空', {
        hint: '每个补丁形如 {"file":"src/a.ts","oldText":"...","newText":"..."}',
      });
    }
    if (patches.length > 50) {
      throw new PlayfulError('TOOL_BAD_ARGS', `一次最多提交 50 个补丁，当前 ${patches.length} 个`);
    }

    interface Staged {
      abs: string;
      rel: string;
      before: string;
      after: string;
      diffs: string[];
    }

    const staged = new Map<string, Staged>();

    // ---- 阶段一：全部校验与内存内应用（不做任何磁盘写入）----
    for (const [i, raw] of patches.entries()) {
      if (!raw || typeof raw !== 'object') {
        throw new PlayfulError('TOOL_BAD_ARGS', `第 ${i + 1} 个补丁不是对象`);
      }
      const { file, oldText, newText, replaceAll } = raw;
      if (typeof file !== 'string' || !file.trim()) throw new PlayfulError('TOOL_BAD_ARGS', `第 ${i + 1} 个补丁缺少 file`);
      if (typeof oldText !== 'string' || oldText === '') {
        throw new PlayfulError('TOOL_BAD_ARGS', `第 ${i + 1} 个补丁的 oldText 不能为空`, {
          hint: '新增内容请用 write_file，或把 oldText 设为被替换的上下文片段',
        });
      }
      if (typeof newText !== 'string') throw new PlayfulError('TOOL_BAD_ARGS', `第 ${i + 1} 个补丁的 newText 必须是字符串`);

      const abs = resolveInside(file, ctx);
      const rel = displayPath(abs, ctx.workdir);

      let entry = staged.get(abs);
      if (!entry) {
        if (!fs.existsSync(abs)) {
          throw new PlayfulError('FS_ERROR', `补丁目标文件不存在：${rel}`, {
            hint: '新建文件请用 write_file；本工具只修改已存在的文件',
          });
        }
        const before = fs.readFileSync(abs, 'utf8');
        entry = { abs, rel, before, after: before, diffs: [] };
        staged.set(abs, entry);
      }

      const current = entry.after;
      const occurrences = countOccurrences(current, oldText);

      if (occurrences === 0) {
        if (a.fuzzy) {
          const replaced = fuzzyReplace(current, oldText, newText);
          if (replaced) {
            entry.after = replaced;
            entry.diffs.push(`补丁 #${i + 1}：宽松匹配成功（已忽略缩进差异）`);
            continue;
          }
        }
        const preview = current.split('\n').slice(0, 0);
        void preview;
        throw new PlayfulError(
          'TOOL_BAD_ARGS',
          `第 ${i + 1} 个补丁的 oldText 在 ${rel} 中未找到`,
          {
            hint:
              '请先用 read_file 重新读取该文件，确保 oldText 与原文逐字符一致（包含缩进与换行）。' +
              '若仅缩进不同，可设置 fuzzy=true。',
          },
        );
      }

      if (occurrences > 1 && !replaceAll) {
        throw new PlayfulError('TOOL_BAD_ARGS', `第 ${i + 1} 个补丁的 oldText 在 ${rel} 中出现了 ${occurrences} 次，无法确定替换位置`, {
          hint: '请扩大 oldText 上下文使其唯一，或显式设置 replaceAll=true',
        });
      }

      entry.after = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, newText);
      entry.diffs.push(`补丁 #${i + 1}：替换 ${replaceAll ? occurrences : 1} 处`);
    }

    // ---- 阶段二：预览或落盘 ----
    const renders: string[] = [];
    for (const entry of staged.values()) {
      renders.push(`▸ ${entry.rel}\n${entry.diffs.join('；')}\n\`\`\`diff\n${simpleDiff(entry.before, entry.after)}\n\`\`\``);
    }

    if (a.dryRun) {
      return {
        ok: true,
        tool: 'apply_patch',
        content: `【dryRun 校验通过，未写盘】共 ${patches.length} 个补丁、涉及 ${staged.size} 个文件\n\n${renders.join('\n\n')}`,
        meta: { dryRun: true, files: [...staged.values()].map((s) => s.rel) },
      };
    }

    const backups: string[] = [];
    try {
      for (const entry of staged.values()) {
        if (a.backup ?? true) {
          const bak = `${entry.abs}.bak`;
          fs.copyFileSync(entry.abs, bak);
          backups.push(displayPath(bak, ctx.workdir));
        }
        fs.writeFileSync(entry.abs, entry.after, 'utf8');
      }
    } catch (e) {
      // 落盘中途失败：尝试用内存中的 before 内容回滚已写入的文件
      for (const entry of staged.values()) {
        try {
          fs.writeFileSync(entry.abs, entry.before, 'utf8');
        } catch {
          /* 回滚失败只能上报 */
        }
      }
      throw new PlayfulError('FS_ERROR', `写入失败，已尝试回滚：${(e as Error).message}`, { cause: e });
    }

    return {
      ok: true,
      tool: 'apply_patch',
      content:
        `已应用 ${patches.length} 个补丁，涉及 ${staged.size} 个文件` +
        (backups.length > 0 ? `\n备份：${backups.join('，')}` : '') +
        `\n\n${renders.join('\n\n')}`,
      meta: { files: [...staged.values()].map((s) => s.rel), backups },
    };
  },
};

function simpleDiff(before: string, after: string, maxLines = 40): string {
  const b = before.split('\n');
  const a = after.split('\n');
  const out: string[] = [];
  let head = 0;
  while (head < b.length && head < a.length && b[head] === a[head]) head += 1;
  const shown = Math.max(0, head - 1);
  for (let i = shown; i < head; i += 1) out.push(`  ${b[i] ?? ''}`);
  for (const l of b.slice(head, head + maxLines)) out.push(`- ${l}`);
  for (const l of a.slice(head, head + maxLines)) out.push(`+ ${l}`);
  if (a.length - head > maxLines || b.length - head > maxLines) out.push('  …（预览已截断）');
  return out.join('\n');
}

export default applyPatchTool;
