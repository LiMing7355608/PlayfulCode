/**
 * search_code：跨文件正则检索。
 *
 * 审查场景里最常用的动作 —— 「这个方法在哪儿被调用」「谁用了 eval」，
 * 有了它模型才不必靠想象猜测代码库的调用关系。
 */

import fs from 'node:fs';
import path from 'node:path';
import { PlayfulError } from '../core/errors';
import type { ToolResult, ToolContext, ToolSpec } from '../core/types';
import { displayPath, readTextFileSafe, resolveInside, walkSourceFiles } from './path-guard';
import { validateArgs } from './validate';

interface Args {
  pattern: string;
  path?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  extensions?: string[];
  maxResults?: number;
  contextLines?: number;
}

function toGlobRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export const searchCodeTool: ToolSpec<Args> = {
  name: 'search_code',
  description:
    '在工程内跨文件搜索代码。默认按「纯文本子串」匹配（更稳），设置 isRegex=true 使用正则。' +
    '用于确认调用关系、查找危险 API 的使用点、评估修改影响面。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '要搜索的文本或正则表达式' },
      path: { type: 'string', description: '搜索根目录，默认 "."；也可以是单个文件路径', default: '.' },
      isRegex: { type: 'boolean', description: '是否把 pattern 当作正则，默认 false', default: false },
      caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false', default: false },
      extensions: {
        type: 'array',
        description: '限定文件后缀，例如 [".ts", ".py"]；或使用通配路径 ["src/**/*.ts"]',
        items: { type: 'string' },
      },
      maxResults: { type: 'integer', description: '最多返回匹配条数，默认 120', default: 120, minimum: 1, maximum: 1000 },
      contextLines: { type: 'integer', description: '每条匹配附加上下文行数（前后各 N 行），默认 0', default: 0, minimum: 0, maximum: 3 },
    },
    required: ['pattern'],
  },
  run(args, ctx: ToolContext): ToolResult {
    const a = validateArgs<Args>('search_code', args, searchCodeTool.parameters);

    let matcher: (line: string) => boolean;
    if (a.isRegex) {
      try {
        const re = new RegExp(a.pattern, a.caseSensitive ? '' : 'i');
        matcher = (line) => {
          re.lastIndex = 0;
          return re.test(line);
        };
      } catch (e) {
        throw new PlayfulError('TOOL_BAD_ARGS', `正则表达式非法：${a.pattern}`, {
          cause: e,
          hint: '检查括号、方括号是否配对；或设置 isRegex=false 改用纯文本搜索',
        });
      }
    } else {
      const needle = a.caseSensitive ? a.pattern : a.pattern.toLowerCase();
      matcher = (line) => (a.caseSensitive ? line : line.toLowerCase()).includes(needle);
    }

    const rootAbs = resolveInside(a.path ?? '.', ctx);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(rootAbs);
    } catch {
      throw new PlayfulError('FS_ERROR', `搜索路径不存在：${displayPath(rootAbs, ctx.workdir)}`);
    }

    let files: string[];
    if (stat.isFile()) files = [rootAbs];
    else files = walkSourceFiles(rootAbs, { maxFiles: 3000 });

    const extFilters = (a.extensions ?? []).map((x) => x.trim()).filter(Boolean);
    if (extFilters.length > 0) {
      const globs = extFilters.filter((x) => x.includes('*') || x.includes('?')).map(toGlobRegex);
      const exts = new Set(
        extFilters.filter((x) => !x.includes('*') && !x.includes('?')).map((x) => (x.startsWith('.') ? x : `.${x}`).toLowerCase()),
      );
      files = files.filter((f) => {
        const rel = displayPath(f, ctx.workdir);
        if (exts.size > 0 && exts.has(path.extname(f).toLowerCase())) return true;
        return globs.some((g) => g.test(rel) || g.test(path.basename(f)));
      });
    }

    const maxResults = a.maxResults ?? 120;
    const ctxLines = a.contextLines ?? 0;
    const hits: string[] = [];
    const hitFiles = new Set<string>();
    let scanned = 0;
    let truncated = false;

    for (const file of files) {
      if (hits.length >= maxResults) {
        truncated = true;
        break;
      }
      let text: string;
      try {
        text = readTextFileSafe(file).text;
      } catch {
        continue;
      }
      scanned += 1;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!matcher(lines[i] ?? '')) continue;
        const rel = displayPath(file, ctx.workdir);
        hitFiles.add(rel);
        const startCtx = Math.max(0, i - ctxLines);
        const endCtx = Math.min(lines.length - 1, i + ctxLines);
        const block: string[] = [];
        for (let k = startCtx; k <= endCtx; k += 1) {
          const mark = k === i ? '>' : ' ';
          block.push(`${mark} ${rel}:${k + 1}: ${(lines[k] ?? '').trim().slice(0, 200)}`);
        }
        hits.push(block.join('\n'));
        if (hits.length >= maxResults) {
          truncated = true;
          break;
        }
      }
    }

    if (hits.length === 0) {
      return {
        ok: true,
        tool: 'search_code',
        content: `在 ${scanned} 个文件中未找到匹配 "${a.pattern}"。`,
        meta: { scanned, matches: 0 },
      };
    }

    const header = `匹配 ${hits.length} 处，涉及 ${hitFiles.size} 个文件（已扫描 ${scanned} 个文件）${truncated ? '，结果已截断' : ''}`;
    return {
      ok: true,
      tool: 'search_code',
      content: `${header}\n\n${hits.join('\n')}`,
      meta: { scanned, matches: hits.length, files: [...hitFiles] },
    };
  },
};

export default searchCodeTool;
