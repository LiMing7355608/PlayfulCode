/**
 * Agent 主循环。
 *
 * 核心是一个显式的状态机，而不是「调一次模型拿答案」：
 *
 *   ┌──────────┐  模型给出 tool_calls   ┌──────────┐
 *   │  THINK   │ ─────────────────────► │   ACT    │
 *   │ 调用 LLM │                        │ 执行工具 │
 *   └────┬─────┘ ◄───────────────────── └────┬─────┘
 *        │            结果回灌上下文           │
 *        │ 模型给出最终文本                    │ 步数/错误超限
 *        ▼                                     ▼
 *   ┌──────────┐                          ┌──────────┐
 *   │  ANSWER  │                          │ ABORTED  │
 *   └──────────┘                          └──────────┘
 *
 * 这个循环让模型能够「先看代码 → 再决定看什么 → 最后下结论」，
 * 而不是在没有信息的情况下一次性编造答案。这正是 Agent 与纯 Prompt 的分界线。
 */

import type { AppConfig } from '../core/config';
import { PlayfulError, normalizeError } from '../core/errors';
import { createLogger } from '../core/logger';
import type { AgentEvent, ChatMessage, StopReason, ToolCall } from '../core/types';
import { LlmClient } from '../llm/client';
import { ToolExecutor, renderToolMessage, type ApprovalRequest, type ApprovalDecision } from '../tools/executor';
import type { ToolRegistry } from '../tools/registry';
import { BASE_SYSTEM_PROMPT } from './prompts';
import { ConversationMemory } from './memory';

const log = createLogger('agent');

export interface AgentOptions {
  config: AppConfig;
  registry: ToolRegistry;
  /** 系统提示词；缺省用 Base */
  systemPrompt?: string;
  /** 事件订阅者（CLI / Web 各自实现） */
  onEvent?: (e: AgentEvent) => void;
  /** 审批回调；缺省则危险工具被拒绝 */
  onApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  /** 注入自定义 LLM（测试用） */
  client?: LlmClient;
}

export interface RunOptions {
  /** 覆盖最大步数 */
  maxSteps?: number;
  signal?: AbortSignal;
  /** 是否把本轮任务写入记忆（连续对话时为 true） */
  remember?: boolean;
}

export interface RunResult {
  runId: string;
  answer: string;
  steps: number;
  ms: number;
  stopReason: StopReason;
  /** 本轮实际调用过的工具名（按顺序，含重复） */
  toolsUsed: string[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export class CodeReviewAgent {
  readonly config: AppConfig;
  readonly client: LlmClient;

  private readonly registry: ToolRegistry;
  private readonly memory: ConversationMemory;
  private readonly onEvent?: (e: AgentEvent) => void;
  private readonly executor: ToolExecutor;

  constructor(opts: AgentOptions) {
    this.config = opts.config;
    this.registry = opts.registry;
    this.onEvent = opts.onEvent;

    const systemPrompt = opts.systemPrompt ?? BASE_SYSTEM_PROMPT;
    this.memory = new ConversationMemory({
      systemPrompt,
      windowSize: opts.config.memoryWindow,
      compressToolOutputOverChars: 4000,
    });

    this.client =
      opts.client ??
      new LlmClient({
        config: opts.config,
        emit: (e) => this.onEvent?.(e),
      });

    this.executor = new ToolExecutor({
      registry: this.registry,
      context: {
        runId: 'pending',
        workdir: opts.config.workdir,
        roots: opts.config.workspaceRoots,
        execTimeoutMs: opts.config.execTimeoutMs,
        execMaxOutput: opts.config.execMaxOutput,
        emit: this.onEvent,
      },
      requireApproval: opts.config.requireApproval,
      onApproval: opts.onApproval,
      toolTimeoutMs: Math.max(opts.config.execTimeoutMs + 30_000, 60_000),
      maxResultChars: opts.config.maxToolOutputChars,
      emit: this.onEvent,
    });
  }

  /** 供 Web / 测试读取当前工具清单。 */
  listTools(): string[] {
    return this.registry.names();
  }

  get memorySize(): number {
    return this.memory.length;
  }

  /** 替换系统提示词（模式切换）。 */
  setSystemPrompt(prompt: string): void {
    this.memory.setSystem(prompt);
  }

  /** 清空对话历史（保留系统提示）。 */
  reset(): void {
    this.memory.clear();
  }

  /**
   * 执行一次任务（单轮）。
   * 输入 → 推理 → 工具调用 → … → 输出，全程通过事件流对外可见。
   */
  async run(task: string, opts: RunOptions = {}): Promise<RunResult> {
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const started = Date.now();
    const maxSteps = Math.max(1, opts.maxSteps ?? this.config.maxSteps);
    const toolsUsed: string[] = [];
    let steps = 0;
    let answer = '';
    let stopReason: StopReason = 'final_answer';

    // 每次运行刷新执行器上下文（runId 用于隔离临时目录；workdir/roots 支持运行期切换）
    this.syncExecutorContext(runId);

    this.emit({
      type: 'run_start',
      runId,
      task,
      provider: this.config.provider,
      model: this.client.model,
    });

    if (opts.remember !== false) this.memory.pushUser(task);

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        steps = step;
        if (opts.signal?.aborted) {
          stopReason = 'aborted';
          throw new PlayfulError('ABORTED', '用户中断了本次运行');
        }

        this.emit({
          type: 'thinking',
          step,
          note: step === 1 ? '分析任务并规划步骤' : '根据工具结果继续推理',
        });

        const messages = this.memory.build();
        const before = this.client.usage;

        let response;
        try {
          response = await this.client.chat(messages, this.registry.list(), opts.signal);
        } catch (e) {
          const err = normalizeError(e);
          if (err.code === 'ABORTED') {
            stopReason = 'aborted';
            throw err;
          }
          this.emit({
            type: 'error',
            message: err.toUserMessage(),
            recoverable: err.retryable,
          });
          // 模型层失败无法继续循环，直接结束本次运行
          stopReason = 'error';
          throw err;
        }

        void before;

        // ---- 情况一：模型请求调用工具 ----
        if (response.toolCalls.length > 0) {
          if (response.content.trim()) {
            this.emit({ type: 'assistant_text', step, content: response.content.trim() });
          }

          this.memory.pushAssistant(response.content, response.toolCalls);

          for (const call of response.toolCalls) {
            toolsUsed.push(call.name);
            const result = await this.executor.execute(call, step);
            this.memory.pushTool(call.name, call.id, renderToolMessage(call.name, result));
          }

          if (step === maxSteps) {
            // 步数用尽但模型还想继续 —— 明确降级为「阶段性结论」而不是假装完成
            stopReason = 'max_steps';
            answer = this.buildMaxStepsSummary(toolsUsed);
            this.memory.pushAssistant(answer);
            this.emit({ type: 'assistant_text', step, content: answer });
          }
          continue;
        }

        // ---- 情况二：模型给出最终回答 ----
        answer = response.content.trim();
        if (!answer) {
          // 极少数模型会返回空内容；追问一次，逼它产出结论
          this.emit({ type: 'warning', message: '模型返回了空内容，正在追问一次以获取结论' });
          this.memory.pushUser('请基于已有信息直接给出最终结论，不要再调用工具。');
          if (step === maxSteps) {
            stopReason = 'max_steps';
            answer = '已达到最大步数限制，未能获得最终结论。建议调大 PC_MAX_STEPS 或缩小审查范围。';
          } else {
            continue;
          }
        }

        this.memory.pushAssistant(answer);
        this.emit({ type: 'assistant_text', step, content: answer });
        stopReason = 'final_answer';
        break;
      }
    } catch (e) {
      const err = normalizeError(e);
      if (err.code === 'ABORTED') stopReason = 'aborted';
      else stopReason = 'error';

      if (!answer) {
        answer =
          stopReason === 'aborted'
            ? '（本次运行已被中断）'
            : `运行失败：${err.toUserMessage()}`;
      }
      this.emit({ type: 'error', message: err.toUserMessage(), recoverable: err.retryable });
    }

    const ms = Date.now() - started;
    const usage = this.client.usage;

    log.debug(`运行结束：steps=${steps} reason=${stopReason} ms=${ms} tools=${toolsUsed.length}`);

    this.emit({ type: 'run_end', runId, steps, ms, answer, stopReason });

    return { runId, answer, steps, ms, stopReason, toolsUsed, usage };
  }

  private buildMaxStepsSummary(toolsUsed: string[]): string {
    const counts = new Map<string, number>();
    for (const t of toolsUsed) counts.set(t, (counts.get(t) ?? 0) + 1);
    const detail = [...counts.entries()].map(([k, v]) => `${k}×${v}`).join('、');
    return [
      `已达到最大步数限制（${this.config.maxSteps} 步），以下为阶段性结论。`,
      '',
      `已完成的调查动作：${detail || '无'}。`,
      '尚未获得模型的最终总结。你可以：',
      '1. 调大 PC_MAX_STEPS 后重跑；',
      '2. 缩小审查范围（一次只审一个目录或文件）；',
      '3. 在当前会话中追加追问，让模型基于已有上下文继续。',
    ].join('\n');
  }

  /** 在当前会话上追加一次提问（多轮对话）。 */
  async ask(question: string, opts: RunOptions = {}): Promise<RunResult> {
    return this.run(question, { ...opts, remember: true });
  }

  /** 读取记忆中的完整消息（Web 端渲染历史用）。 */
  history(): ChatMessage[] {
    return this.memory.snapshot();
  }

  /**
   * 注入历史消息并清空当前记忆（用于运行期切换配置/工作目录后继续对话）。
   * 传入的消息会从第 2 条开始保留（第 1 条按约定是 system，由当前系统提示接管）。
   */
  importHistory(messages: ChatMessage[]): void {
    if (messages.length <= 1) return;
    this.memory.replaceWith(messages.slice(1));
  }

  private emit(e: AgentEvent): void {
    try {
      this.onEvent?.(e);
    } catch (err) {
      // 订阅者异常不应影响 Agent 主流程
      log.warn(`事件订阅者抛出异常：${(err as Error).message}`);
    }
  }

  /**
   * 同步执行器上下文。
   * 把 config 中的 workdir / roots / 超时等最新值写回 ToolContext，
   * 这样运行期切换工作目录或配置后，下一次工具调用立即生效。
   */
  syncExecutorContext(runId: string): void {
    const ctx = (this.executor as unknown as { ctx: Record<string, unknown> }).ctx;
    if (!ctx || typeof ctx !== 'object') return;
    ctx.runId = runId;
    ctx.workdir = this.config.workdir;
    ctx.roots = this.config.workspaceRoots;
    ctx.execTimeoutMs = this.config.execTimeoutMs;
    ctx.execMaxOutput = this.config.execMaxOutput;
  }
}

/** 便捷工厂。 */
export function createAgent(opts: AgentOptions): CodeReviewAgent {
  return new CodeReviewAgent(opts);
}

/** 直接执行一个工具调用（供 CLI 的 --tool 调试模式使用）。 */
export async function callToolDirect(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  ctx: { workdir: string; roots: string[]; execTimeoutMs: number; execMaxOutput: number },
): Promise<string> {
  const executor = new ToolExecutor({
    registry,
    context: { runId: `direct_${Date.now()}`, ...ctx },
    requireApproval: false,
    toolTimeoutMs: ctx.execTimeoutMs + 30_000,
    maxResultChars: 1_000_000,
  });
  const call: ToolCall = { id: 'direct', name, args };
  const result = await executor.execute(call, 1);
  return result.content;
}
