/**
 * 工具执行器。
 *
 * 它是「模型意图」与「真实副作用」之间唯一的闸门，集中负责四件事：
 * 1. 入参校验（工具内部还会再校验一次默认值，这里做第一道拦截）；
 * 2. 审批（危险工具在此暂停，等待上层决定，实现人在回路 / Human-in-the-Loop）；
 * 3. 超时（任何工具都不能无限期占用 Agent 循环）；
 * 4. 输出截断与异常归一（保证进入上下文的内容永远是可控长度的文本）。
 *
 * 注意一个刻意设计：工具抛出的异常不会向上冒泡中断整个 Agent，
 * 而是被转换成 ok:false 的 ToolResult 回灌给模型 —— 让模型有机会自我纠正。
 */

import { PlayfulError, normalizeError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { AgentEvent, ToolCall, ToolContext, ToolResult, ToolSpec } from '../core/types';
import type { ToolRegistry } from './registry';
import { validateArgs } from './validate';

const log = createLogger('executor');

export interface ApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

export type ApprovalDecision = 'allow' | 'deny' | 'allow_all';

export interface ToolExecutorOptions {
  registry: ToolRegistry;
  context: ToolContext;
  /** 是否需要审批危险工具 */
  requireApproval: boolean;
  /** 审批回调；不提供时，requireApproval 为真则一律拒绝 */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 单次工具调用超时（毫秒） */
  toolTimeoutMs?: number;
  /** 单条工具结果注入上下文的最大字符数 */
  maxResultChars?: number;
  /** 事件回流 */
  emit?: (e: AgentEvent) => void;
}

export class ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly ctx: ToolContext;
  private readonly requireApproval: boolean;
  private readonly onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  private readonly toolTimeoutMs: number;
  private readonly maxResultChars: number;
  private readonly emit?: (e: AgentEvent) => void;

  /** 用户选择「全部允许」后置位，避免每次写文件都打断 */
  private allowAll = false;

  constructor(opts: ToolExecutorOptions) {
    this.registry = opts.registry;
    this.ctx = opts.context;
    this.requireApproval = opts.requireApproval;
    this.onApproval = opts.onApproval;
    this.toolTimeoutMs = opts.toolTimeoutMs ?? 60_000;
    this.maxResultChars = opts.maxResultChars ?? 12_000;
    this.emit = opts.emit ?? opts.context.emit;
  }

  get approvalBypassed(): boolean {
    return this.allowAll;
  }

  /** 执行一次工具调用，永远返回 ToolResult（不抛异常）。 */
  async execute(call: ToolCall, step: number): Promise<ToolResult> {
    const started = Date.now();
    this.emit?.({ type: 'tool_call', step, id: call.id, name: call.name, args: call.args });

    let spec: ToolSpec<never>;
    try {
      spec = this.registry.get(call.name);
    } catch (e) {
      const err = normalizeError(e);
      const result: ToolResult = {
        ok: false,
        tool: call.name,
        content: `工具调用失败：${err.message}\n${err.hint ?? ''}`.trim(),
      };
      this.emitResult(step, call, result, Date.now() - started);
      return result;
    }

    // ---- 审批闸门 ----
    if (spec.dangerous && this.requireApproval && !this.allowAll) {
      if (!this.onApproval) {
        const result: ToolResult = {
          ok: false,
          tool: call.name,
          content:
            `工具 ${call.name} 属于危险操作，当前会话未提供审批通道，已拒绝执行。` +
            `如需授权，请在 CLI 交互模式下运行（会弹出确认提示）。`,
        };
        this.emit?.({ type: 'tool_denied', step, id: call.id, name: call.name, reason: '无审批通道' });
        this.emitResult(step, call, result, Date.now() - started);
        return result;
      }

      let decision: ApprovalDecision;
      try {
        decision = await this.onApproval({ tool: call.name, args: call.args, description: spec.description });
      } catch (e) {
        decision = 'deny';
        log.warn(`审批流程异常，按拒绝处理：${(e as Error).message}`);
      }

      if (decision === 'deny') {
        const result: ToolResult = {
          ok: false,
          tool: call.name,
          content: `用户拒绝执行 ${call.name}。请不要重试同一操作，改为以文字形式说明你的建议改动。`,
        };
        this.emit?.({ type: 'tool_denied', step, id: call.id, name: call.name, reason: '用户拒绝' });
        this.emitResult(step, call, result, Date.now() - started);
        return result;
      }
      if (decision === 'allow_all') this.allowAll = true;
    }

    // ---- 校验 + 执行 + 超时 ----
    let result: ToolResult;
    try {
      const args = validateArgs<Record<string, unknown>>(call.name, call.args ?? {}, spec.parameters);
      result = await this.withTimeout(spec, args);
    } catch (e) {
      const err = normalizeError(e);
      result = {
        ok: false,
        tool: call.name,
        content: `工具执行失败：${err.message}${err.hint ? `\n修复建议：${err.hint}` : ''}`,
      };
    }

    // ---- 截断 ----
    if (result.content.length > this.maxResultChars) {
      const omitted = result.content.length - this.maxResultChars;
      result = {
        ...result,
        content: `${result.content.slice(0, this.maxResultChars)}\n…（结果过长，已省略 ${omitted} 字符。可缩小查询范围后重试）`,
      };
    }

    this.emitResult(step, call, result, Date.now() - started);
    return result;
  }

  private emitResult(step: number, call: ToolCall, result: ToolResult, ms: number): void {
    this.emit?.({
      type: 'tool_result',
      step,
      id: call.id,
      name: call.name,
      ok: result.ok,
      content: result.content,
      ms,
    });
  }

  private async withTimeout(spec: ToolSpec<never>, args: Record<string, unknown>): Promise<ToolResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          tool: spec.name,
          content: `工具 ${spec.name} 超过 ${this.toolTimeoutMs}ms 未返回，已中断。请缩小任务范围或拆分步骤。`,
        });
      }, this.toolTimeoutMs);
    });

    try {
      return await Promise.race([Promise.resolve(spec.run(args as never, this.ctx)), timeout]);
    } catch (e) {
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** 把工具结果渲染成进入上下文的 tool 消息文本。 */
export function renderToolMessage(name: string, result: ToolResult): string {
  const status = result.ok ? '成功' : '失败';
  return `[工具 ${name} 执行${status}]\n${result.content}`;
}

export { PlayfulError };
