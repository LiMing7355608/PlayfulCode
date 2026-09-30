/**
 * 离线 Mock Provider。
 *
 * 用途：单元测试与「无 Key 演示模式」。
 * 它按预设脚本依次返回响应，完全不需要网络，让评审者 clone 后即可 `npm test` 通过。
 */

import type { LlmProvider, LlmRequest, LlmResponse, LlmUsage, ToolCall } from '../core/types';

/** 一条脚本化的响应。 */
export type MockScript =
  | { kind: 'text'; content: string }
  | { kind: 'tools'; content?: string; calls: { name: string; args?: Record<string, unknown>; id?: string }[] }
  | { kind: 'error'; message: string; retryable?: boolean };

export interface MockRecord {
  messages: LlmRequest['messages'];
  toolNames: string[];
}

export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model: string;
  supportsNativeTools = true;

  /** 记录每次被调用的请求，供测试断言「上下文记忆是否正确携带」。 */
  readonly history: MockRecord[] = [];

  private cursor = 0;
  private readonly scripts: MockScript[];
  private readonly usage: LlmUsage;

  constructor(scripts: MockScript[], opts: { model?: string; usage?: LlmUsage } = {}) {
    this.scripts = scripts;
    this.model = opts.model ?? 'mock-model';
    this.usage = opts.usage ?? { promptTokens: 10, completionTokens: 20, totalTokens: 30 };
  }

  /** 剩余未消费的脚本数量。 */
  get remaining(): number {
    return Math.max(0, this.scripts.length - this.cursor);
  }

  async chat(req: LlmRequest): Promise<LlmResponse> {
    this.history.push({ messages: req.messages.map((m) => ({ ...m })), toolNames: req.tools.map((t) => t.name) });

    if (this.cursor >= this.scripts.length) {
      // 脚本耗尽后固定返回终结回答，避免测试挂死
      return {
        content: '（mock 脚本已耗尽）分析结束。',
        toolCalls: [],
        model: this.model,
        finishReason: 'stop',
        usage: this.usage,
      };
    }

    const script = this.scripts[this.cursor] as MockScript;
    this.cursor += 1;

    if (script.kind === 'error') {
      const err = new Error(script.message);
      (err as Error & { retryable?: boolean }).retryable = script.retryable ?? false;
      throw err;
    }

    if (script.kind === 'text') {
      return { content: script.content, toolCalls: [], model: this.model, finishReason: 'stop', usage: this.usage };
    }

    const toolCalls: ToolCall[] = script.calls.map((c, i) => ({
      id: c.id ?? `mock_call_${this.cursor}_${i}`,
      name: c.name,
      args: c.args ?? {},
    }));
    return {
      content: script.content ?? '',
      toolCalls,
      model: this.model,
      finishReason: 'tool_calls',
      usage: this.usage,
    };
  }
}
