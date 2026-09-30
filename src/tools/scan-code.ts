/**
 * scan_code：把内置静态分析引擎暴露成一个工具。
 *
 * 它是本 Agent 的「客观证据来源」——规则引擎负责找事实，LLM 负责判断价值。
 * 也正因为它是确定性的，才能被单元测试覆盖。
 */

import { PlayfulError } from '../core/errors';
import type { ToolResult, ToolSpec } from '../core/types';
import { renderReportForPrompt, scanPath, rulesCatalog } from './static-analysis';
import { validateArgs } from './validate';

interface Args {
  path?: string;
  extensions?: string[];
  minSeverity?: 'critical' | 'high' | 'medium' | 'low';
  rules?: string[];
  maxFiles?: number;
  describeRules?: boolean;
}

export const scanCodeTool: ToolSpec<Args> = {
  name: 'scan_code',
  description:
    '运行内置静态分析引擎（26 条规则，覆盖正确性 / 安全 / 可维护性 / 复杂度 / 性能），' +
    '返回带「文件:行号 + 代码片段」的确定性结论。' +
    '审查任何代码时都应当先调用本工具获取客观证据，再结合 read_file 的上下文给出判断。' +
    '传 describeRules=true 可以查看全部规则清单。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要扫描的文件或目录，默认 "."', default: '.' },
      extensions: { type: 'array', description: '限定后缀，例如 [".ts", ".py"]；留空表示所有源码文件', items: { type: 'string' } },
      minSeverity: {
        type: 'string',
        description: '最低严重度（含）过滤，默认 low（全部）',
        enum: ['critical', 'high', 'medium', 'low'],
        default: 'low',
      },
      rules: { type: 'array', description: '只运行这些规则 id，例如 ["SEC-001","CPX-001"]；留空表示全部', items: { type: 'string' } },
      maxFiles: { type: 'integer', description: '最多扫描文件数，默认 400', default: 400, minimum: 1, maximum: 5000 },
      describeRules: { type: 'boolean', description: '为 true 时返回规则清单而不执行扫描', default: false },
    },
  },
  run(args, ctx): ToolResult {
    const a = validateArgs<Args>('scan_code', args, scanCodeTool.parameters);

    if (a.describeRules) {
      return { ok: true, tool: 'scan_code', content: `可用规则清单：\n${rulesCatalog()}` };
    }

    let report;
    try {
      report = scanPath({
        target: a.path ?? '.',
        workdir: ctx.workdir,
        extensions: a.extensions,
        minSeverity: a.minSeverity ?? 'low',
        rules: a.rules,
        maxFiles: a.maxFiles ?? 400,
      });
    } catch (e) {
      throw new PlayfulError('FS_ERROR', (e as Error).message, {
        hint: '请确认路径存在；也可以用 list_files 先确认工程结构',
      });
    }

    if (report.stats.files === 0) {
      return {
        ok: true,
        tool: 'scan_code',
        content: `在 ${a.path ?? '.'} 下没有找到可分析的源码文件（支持 .ts/.js/.py/.java 等常见后缀，已忽略 node_modules、dist 等目录）。`,
      };
    }

    const content = `静态分析结果（确定性规则引擎输出，可作为审查依据）：\n\n${renderReportForPrompt(report)}`;

    return {
      ok: true,
      tool: 'scan_code',
      content,
      meta: {
        files: report.stats.files,
        findings: report.findings.length,
        bySeverity: report.stats.bySeverity,
        ms: report.ms,
      },
    };
  },
};

export default scanCodeTool;
