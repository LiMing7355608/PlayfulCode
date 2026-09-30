/**
 * 终端渲染器。
 *
 * 把 AgentEvent 流翻译成人能读的终端输出。
 * 关键取舍：工具输出默认只显示前几行摘要（Agent 需要全文，人不需要），
 * 加 --verbose 才展开 —— 否则一次审查会刷屏几千行。
 */

import type { AgentEvent, Finding, ScanReport, Severity } from '../core/types';
import { paint, setColor, setLogLevel, type ColorName } from '../core/logger';
import { rulesCatalog } from '../tools/static-analysis';

export interface RendererOptions {
  verbose?: boolean;
  showThinking?: boolean;
  color?: boolean;
}

const SEVERITY_COLOR: Record<Severity, ColorName> = {
  critical: 'red',
  high: 'magenta',
  medium: 'yellow',
  low: 'cyan',
};

export function severityBadge(s: Severity): string {
  const label = { critical: '严重', high: '高  ', medium: '中  ', low: '低  ' }[s];
  return paint(`[${label}]`, SEVERITY_COLOR[s], true);
}

export class TerminalRenderer {
  private readonly opts: RendererOptions;
  private spinnerTimer: NodeJS.Timeout | null = null;
  private spinnerIndex = 0;
  private spinnerActive = false;
  private lastToolPreview = 0;

  constructor(opts: RendererOptions = {}) {
    this.opts = { verbose: false, showThinking: true, ...opts };
    setColor(opts.color ?? (Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined));
  }

  /* ------------------------- 结构输出 ------------------------- */

  banner(version: string): void {
    const lines = [
      '',
      paint('  ██████╗ ██╗      █████╗ ██╗   ██╗███████╗██╗   ██╗██╗     ', 'cyan'),
      paint('  ██╔══██╗██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██║   ██║██║     ', 'cyan'),
      paint('  ██████╔╝██║     ███████║ ╚████╔╝ █████╗  ██║   ██║██║     ', 'blue'),
      paint('  ██╔═══╝ ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██║   ██║██║     ', 'blue'),
      paint('  ██║     ███████╗██║  ██║   ██║   ███████╗╚██████╔╝███████╗', 'magenta'),
      paint('  ╚═╝     ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝ ╚═════╝ ╚══════╝', 'magenta'),
      '',
      `  ${paint('PlayfulCode', 'cyan', true)} v${version}  ·  ${paint('会读代码、会跑代码、会给你结论的代码助手', 'dim')}`,
      '',
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  section(title: string): void {
    process.stdout.write(`\n${paint(`── ${title} `, 'blue', true)}${paint('─'.repeat(Math.max(0, 60 - title.length)), 'dim')}\n`);
  }

  info(msg: string): void {
    process.stdout.write(`${paint('·', 'dim')} ${msg}\n`);
  }

  success(msg: string): void {
    process.stdout.write(`${paint('✓', 'green', true)} ${msg}\n`);
  }

  warn(msg: string): void {
    process.stdout.write(`${paint('!', 'yellow', true)} ${msg}\n`);
  }

  fail(msg: string): void {
    process.stderr.write(`${paint('✗', 'red', true)} ${msg}\n`);
  }

  dim(msg: string): void {
    process.stdout.write(`${paint(msg, 'dim')}\n`);
  }

  /* ------------------------- 思考动画 ------------------------- */

  startThinking(label = '思考中'): void {
    if (!process.stdout.isTTY || !this.opts.showThinking) return;
    if (this.spinnerActive) return;
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.spinnerActive = true;
    this.spinnerTimer = setInterval(() => {
      const frame = frames[this.spinnerIndex % frames.length] ?? '⠋';
      this.spinnerIndex += 1;
      process.stdout.write(`\r${paint(frame, 'cyan')} ${paint(label, 'dim')}   `);
    }, 90);
  }

  stopThinking(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.spinnerActive) {
      process.stdout.write(`\r${' '.repeat(40)}\r`);
      this.spinnerActive = false;
    }
  }

  /* ------------------------- 事件渲染 ------------------------- */

  handle(e: AgentEvent): void {
    switch (e.type) {
      case 'run_start':
        this.stopThinking();
        this.section('开始任务');
        this.info(`${paint('模型', 'dim')} ${e.provider} / ${e.model}  ${paint('runId', 'dim')} ${e.runId}`);
        break;

      case 'thinking':
        if (this.opts.showThinking) this.startThinking(`第 ${e.step} 步 · ${e.note}`);
        break;

      case 'assistant_text':
        this.stopThinking();
        break;

      case 'tool_call':
        this.stopThinking();
        process.stdout.write(
          `\n${paint('▶', 'cyan', true)} ${paint(`第 ${e.step} 步`, 'dim')} 调用 ${paint(e.name, 'cyan', true)} ${paint(this.summarizeArgs(e.name, e.args), 'dim')}\n`,
        );
        this.startThinking('执行工具中');
        break;

      case 'tool_result': {
        this.stopThinking();
        const mark = e.ok ? paint('✓', 'green', true) : paint('✗', 'red', true);
        process.stdout.write(`${mark} ${paint(e.name, 'dim')} ${paint(`${e.ms}ms`, 'dim')}\n`);
        this.printPreview(e.content);
        break;
      }

      case 'tool_denied':
        this.stopThinking();
        this.warn(`已拒绝 ${e.name}（${e.reason}）`);
        break;

      case 'retry':
        this.stopThinking();
        this.warn(`第 ${e.attempt} 次重试，${(e.delayMs / 1000).toFixed(1)}s 后继续（原因：${e.reason}）`);
        break;

      case 'usage':
        if (this.opts.verbose && e.totalTokens) this.dim(`token 用量：${e.totalTokens}`);
        break;

      case 'warning':
        this.stopThinking();
        this.warn(e.message);
        break;

      case 'error':
        this.stopThinking();
        this.fail(e.message);
        break;

      case 'run_end':
        this.stopThinking();
        break;
    }
  }

  private printPreview(content: string): void {
    const maxLines = this.opts.verbose ? 400 : 6;
    const lines = content.split('\n');
    const shown = lines.slice(0, maxLines);
    for (const line of shown) {
      process.stdout.write(`  ${paint('│', 'dim')} ${line.slice(0, 220)}\n`);
    }
    if (lines.length > maxLines) {
      process.stdout.write(`  ${paint('│', 'dim')} ${paint(`…（共 ${lines.length} 行，--verbose 可展开）`, 'dim')}\n`);
    }
  }

  private summarizeArgs(name: string, args: Record<string, unknown>): string {
    const pick = (k: string): unknown => args[k];
    switch (name) {
      case 'read_file':
      case 'list_files':
        return String(pick('path') ?? '.');
      case 'search_code':
        return `"${String(pick('pattern') ?? '')}"`;
      case 'scan_code':
        return `${String(pick('path') ?? '.')}${pick('rules') ? ` rules=${(pick('rules') as string[]).join(',')}` : ''}`;
      case 'run_code':
        return String(pick('file') ?? (pick('code') ? '代码片段' : ''));
      case 'write_file':
      case 'apply_patch':
        return String(pick('path') ?? (Array.isArray(pick('patches')) ? `${(pick('patches') as unknown[]).length} 个补丁` : ''));
      default: {
        const json = JSON.stringify(args);
        return json.length > 80 ? `${json.slice(0, 80)}…` : json;
      }
    }
  }

  /* ------------------------- 结果渲染 ------------------------- */

  renderAnswer(answer: string): void {
    this.section('审查结论');
    process.stdout.write(`${answer}\n`);
  }

  renderSummary(result: { steps: number; ms: number; toolsUsed: string[]; usage: { totalTokens: number }; stopReason: string }): void {
    const counts = new Map<string, number>();
    for (const t of result.toolsUsed) counts.set(t, (counts.get(t) ?? 0) + 1);
    const tools = counts.size > 0 ? [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(' ') : '未使用工具';
    this.section('运行统计');
    this.dim(
      `步数 ${result.steps}　耗时 ${(result.ms / 1000).toFixed(1)}s　` +
        `token ${result.usage.totalTokens || '—'}　结束原因 ${result.stopReason}`,
    );
    this.dim(`工具调用：${tools}`);
  }

  renderScanReport(report: ScanReport): void {
    this.section('静态扫描结果');
    this.dim(
      `扫描 ${report.stats.files} 个文件 / ${report.stats.lines} 行，耗时 ${report.ms}ms　` +
        `严重 ${report.stats.bySeverity.critical} · 高 ${report.stats.bySeverity.high} · 中 ${report.stats.bySeverity.medium} · 低 ${report.stats.bySeverity.low}`,
    );
    if (report.findings.length === 0) {
      this.success('未发现问题。');
      return;
    }
    process.stdout.write('\n');
    for (const f of report.findings) {
      this.renderFinding(f);
    }
  }

  renderFinding(f: Finding): void {
    process.stdout.write(
      `${severityBadge(f.severity)} ${paint(`${f.file}:${f.line}`, 'cyan')} ${paint(`[${f.ruleId}]`, 'dim')} ${f.title}\n`,
    );
    if (f.snippet) process.stdout.write(`      ${paint(f.snippet.slice(0, 160), 'dim')}\n`);
    process.stdout.write(`      ${paint('→', 'green')} ${f.suggestion}\n\n`);
  }

  renderRuleCatalog(): void {
    this.section('内置规则清单');
    process.stdout.write(`${rulesCatalog()}\n`);
  }

  renderToolList(list: string): void {
    this.section('可用工具');
    process.stdout.write(`${list}\n`);
  }
}

/** 让日志级别与渲染器保持一致。 */
export function setupLogging(level: 'debug' | 'info' | 'warn' | 'error'): void {
  setLogLevel(level);
}
