/**
 * 上下文记忆（ConversationMemory）。
 *
 * 一个真实的 Agent 会话会不断累积消息，无脑全量发送有两个问题：
 * token 成本线性上涨；早期无关内容会稀释模型注意力。
 *
 * 这里的策略分三层：
 * 1. **窗口裁剪**：只保留最近 N 条消息；
 * 2. **工具结果压缩**：超长的旧工具输出（比如一次读取 400 行文件）在后续轮次里
 *    压缩成摘要，只保留结论性的一两句 —— 因为它在被消费过一次之后价值骤降；
 * 3. **结构完整性**：裁剪时保证 tool 消息不会与它对应的 assistant.toolCalls 分离，
 *    否则 OpenAI 兼容接口会直接报 400。
 */

import type { ChatMessage } from '../core/types';

export interface MemoryOptions {
  /** 保留的最近消息条数 */
  windowSize: number;
  /** 系统提示词固定保留在首位 */
  systemPrompt: string;
  /** 旧工具输出的压缩阈值 */
  compressToolOutputOverChars?: number;
  /** 压缩后保留的字符数 */
  compressedPreviewChars?: number;
}

export class ConversationMemory {
  private readonly opts: MemoryOptions;
  private messages: ChatMessage[] = [];

  constructor(opts: MemoryOptions) {
    this.opts = opts;
    this.messages.push({ role: 'system', content: opts.systemPrompt, at: Date.now() });
  }

  get length(): number {
    return this.messages.length;
  }

  /** 当前系统提示词。 */
  get system(): string {
    const first = this.messages[0];
    return first && first.role === 'system' ? first.content : '';
  }

  /** 更新系统提示词（例如切换模式）。 */
  setSystem(content: string): void {
    const first = this.messages[0];
    if (first && first.role === 'system') first.content = content;
    else this.messages.unshift({ role: 'system', content, at: Date.now() });
  }

  push(message: ChatMessage): void {
    this.messages.push({ ...message, at: message.at ?? Date.now() });
  }

  pushUser(content: string): void {
    this.push({ role: 'user', content });
  }

  pushAssistant(content: string, toolCalls?: ChatMessage['toolCalls']): void {
    this.push({ role: 'assistant', content, ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}) });
  }

  pushTool(name: string, toolCallId: string, content: string): void {
    this.push({ role: 'tool', content, toolCallId, name });
  }

  /** 原始快照（调试用）。 */
  snapshot(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  /** 导出可持久化的纯数据（用于会话落盘 / 测试断言）。 */
  serialize(): string {
    return JSON.stringify(this.messages);
  }

  /** 从纯数据恢复。 */
  static deserialize(json: string, opts: MemoryOptions): ConversationMemory {
    const mem = new ConversationMemory(opts);
    try {
      const parsed = JSON.parse(json) as ChatMessage[];
      if (Array.isArray(parsed) && parsed.length > 0) mem.messages = parsed;
    } catch {
      /* 损坏的历史直接丢弃，从空会话开始 */
    }
    return mem;
  }

  /**
   * 构造本次请求要发送的消息数组。
   * 这是记忆模块的核心：裁剪 + 压缩 + 结构修复。
   */
  build(extraWindow?: number): ChatMessage[] {
    const system = this.messages[0];
    const rest = this.messages.slice(1);
    const size = this.opts.windowSize + (extraWindow ?? 0);

    let windowed = size >= rest.length ? rest : rest.slice(rest.length - size);
    windowed = this.repairStructure(windowed);
    windowed = this.compressOldToolOutputs(windowed);

    const out: ChatMessage[] = [];
    if (system) out.push({ ...system });
    out.push(...windowed.map((m) => stripInternalFields(m)));
    return out;
  }

  /**
   * 结构修复：确保每条 tool 消息前面存在发起它的 assistant.toolCalls。
   * 同时补齐 OpenAI 要求「assistant 带 tool_calls 后必须紧跟对应 tool 结果」的顺序约束。
   */
  private repairStructure(list: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    // 先找出被保留的 toolCallId 集合
    const keptIds = new Set<string>();
    for (const m of list) if (m.role === 'tool' && m.toolCallId) keptIds.add(m.toolCallId);

    for (let i = 0; i < list.length; i += 1) {
      const m = list[i] as ChatMessage;

      if (m.role === 'tool') {
        // 找不到对应的 assistant 调用就先丢弃（通常是窗口切断了）
        const hasOwner = result.some((r) => r.role === 'assistant' && r.toolCalls?.some((tc) => tc.id === m.toolCallId));
        if (!hasOwner) continue;
        result.push(m);
        continue;
      }

      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        // 后面是否还跟着任何 tool 消息（无论是否属于本次调用）
        const hasToolAfter = list.slice(i + 1).some((n) => n.role === 'tool');
        if (!hasToolAfter) {
          // 该轮的 tool 结果全被裁掉：把 assistant 降级为普通文本，
          // 避免出现「有 tool_calls 却无对应 tool 结果」的非法结构（OpenAI 兼容接口会直接 400）
          result.push({ ...m, toolCalls: undefined });
          continue;
        }
        // 仍有工具结果跟随：补齐缺失的 tool 占位，保证 assistant 与 tool 一一对应
        result.push(m);
        const followingIds = new Set(
          list
            .slice(i + 1)
            .filter((n) => n.role === 'tool')
            .map((n) => n.toolCallId),
        );
        for (const tc of m.toolCalls) {
          if (followingIds.has(tc.id)) continue;
          result.push({
            role: 'tool',
            content: '[该工具结果已因上下文窗口收缩而省略]',
            toolCallId: tc.id,
            name: tc.name,
          });
        }
        continue;
      }

      result.push(m);
    }

    return result;
  }

  /** 把较早的超长工具输出压缩为摘要，仅保留首尾关键片段。 */
  private compressOldToolOutputs(list: ChatMessage[]): ChatMessage[] {
    const threshold = this.opts.compressToolOutputOverChars ?? 4000;
    const preview = this.opts.compressedPreviewChars ?? 600;
    // 只压缩「非最近一轮」的内容：最后 4 条不动
    const cutoff = Math.max(0, list.length - 4);

    return list.map((m, i) => {
      if (m.role !== 'tool' || i >= cutoff) return m;
      if (m.content.length <= threshold) return m;
      const head = m.content.slice(0, preview);
      const tail = m.content.slice(-Math.floor(preview / 3));
      return {
        ...m,
        content: `${head}\n…（较早的工具输出已压缩，省略 ${m.content.length - head.length - tail.length} 字符）\n${tail}`,
      };
    });
  }

  /** 清空除系统提示外的所有消息。 */
  clear(): void {
    this.messages = this.messages.slice(0, 1);
  }

  /** 用给定消息替换系统提示之后的内容（用于运行期重建 Agent 时接管历史）。 */
  replaceWith(messages: ChatMessage[]): void {
    const system = this.messages[0];
    this.messages = system ? [system, ...messages.map((m) => ({ ...m }))] : [...messages.map((m) => ({ ...m }))];
  }

  /** 粗略估算 token 数（中文按 1.5 字/token，英文按 4 字符/token 折中）。 */
  estimateTokens(): number {
    const total = this.messages.reduce((acc, m) => acc + m.content.length, 0);
    return Math.ceil(total / 3);
  }
}

function stripInternalFields(m: ChatMessage): ChatMessage {
  const { at: _at, ...rest } = m;
  return rest;
}
